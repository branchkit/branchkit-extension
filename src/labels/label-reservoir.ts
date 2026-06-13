/**
 * Per-frame local label reservoir.
 *
 * Pre-fetches a chunk of codewords from the service worker's central pool
 * and caches them in the content script for synchronous claim/release. The
 * SW remains the authoritative owner of cross-frame uniqueness — every
 * codeword in the reservoir is recorded in the SW's per-tab `stack.assigned`
 * map (keyed to this frame), so voice routing via `getFrameForLabel` still
 * dispatches to the correct frame.
 *
 * The hot path (`intersection-tracker.doFlush`) no longer pays the
 * `chrome.runtime.sendMessage('CLAIM_LABELS')` IPC roundtrip — that was
 * ~10-20ms warm, much worse on cold MV3 service worker. Releases stay
 * local + async-notify-SW; the SW's view eventually syncs.
 *
 * Routing under stale reservoir state: when a release happens locally
 * before the SW is notified, the SW still thinks the codeword is assigned
 * to this frame. A voice match in that window dispatches here; the local
 * `store.byCodeword(cw)` returns null (no wrapper holds it now), and the
 * frame ignores the dispatch. Safe; no false activation.
 *
 * Pool-exhaustion handling: `claim()` returns `''` for slots that the
 * reservoir can't fill. The caller leaves the wrapper unhinted; the
 * level-triggered reconcile (`refreshViewportClaims`) re-queues those
 * wrappers on the next `onCodewordsChanged` after a refill arrives.
 *
 * ---
 *
 * SINGLE-SENDER INVARIANT
 *
 * This file is the only sender of `CLAIM_LABELS`, `RELEASE_LABELS`, and
 * `CONFIRM_LABELS` over `chrome.runtime.sendMessage`. Modules that need to
 * mutate label-pool state must call `labelReservoir.claim()` /
 * `labelReservoir.release()` rather than constructing the message
 * themselves. Enforced by `label-ipc-isolation.test.ts`.
 *
 * Why it's load-bearing — two coupled state machines:
 *
 *   - The reservoir owns two local pieces of state: the `free` queue and
 *     the `outstanding` set of codewords currently held by wrappers in
 *     this frame. Refill dedup is computed against `free ∪ outstanding`.
 *
 *   - The SW owns the per-tab `stack.{free, reserved, assigned}` map.
 *     Each label is in exactly one of those at any time. The reservoir's
 *     CLAIM/CONFIRM/RELEASE sequence is what keeps the two views in sync.
 *
 * A bypassing sender breaks the invariant in three distinct ways:
 *
 *   - Direct RELEASE: local `free` never restored, `outstanding` never
 *     cleared. Local-vs-SW state diverges; refill dedup misses.
 *   - Direct CONFIRM: races the local CLAIM/CONFIRM round-trip. If
 *     RELEASE lands before CONFIRM, the codeword sits in `stack.free`
 *     (not `stack.reserved`), CONFIRM's promote-step is a no-op, the SW
 *     keeps the codeword as free, and the next refill re-issues it to a
 *     frame that already holds it.
 *   - Direct CLAIM: SW promotes `free → reserved[frame]` but `outstanding`
 *     never registers. The codeword can sit in `reserved` indefinitely
 *     (no SW-side TTL), and refill-dedup can't see it.
 *
 * The same invariant — "the reservoir is the single in-process owner of
 * the local label state, and only it talks to the SW pool" — closes all
 * three. If you're tempted to add a fourth sender, re-read this comment
 * and decide whether the invariant still holds. The default answer is no.
 */

const INITIAL_RESERVATION = 100;
const REFILL_THRESHOLD = 30;
const REFILL_AMOUNT = 60;
// Upper bound on the initial fill when sized to the recalled set (Regime B
// reclaim, DESIGN_REGIME_B_RECALL.md). Caps a pathological recall from
// requesting an unbounded first fill; comfortably above MEMORY_CAP_PER_FRAME
// (200), so the full remembered set fits.
const MAX_INITIAL_RESERVATION = 300;

class LabelReservoir {
  /** Available codewords for synchronous claim, front-of-array first. */
  private free: string[] = [];
  /** Codewords currently held by wrappers in this frame (granted out but not
   *  yet released). Refill dedup checks `free ∪ outstanding` so the SW
   *  re-issuing a codeword we already handed to a wrapper can't slip past.
   *  Since the Phase 4 confirm exchange, the SW acquires released-then-
   *  reclaimed codewords straight from `stack.free` at confirm time, so the
   *  SW-side hole this originally closed (silent no-op confirm leaving the
   *  codeword free) is gone — but the dedup still covers the IN-FLIGHT
   *  window: a refill response issued before our confirm landed can carry a
   *  codeword we just granted locally. QuickBase 2026-06-05 — 6 wrappers all
   *  attached with "cap each" in 260ms, which then evicted `each` from
   *  `browser_hints_cap_strict` and made the CE hint unreachable. */
  private outstanding: Set<string> = new Set();
  /** Recalled codewords earmarked for a remembered fingerprint (Regime B,
   *  A3 in DESIGN_REGIME_B_RECALL.md). These sit in `free` but a fresh,
   *  no-memory claim must NOT consume them — only their owner (via `preferred`)
   *  or, if generic runs dry, the starvation fallback. Without this, after a
   *  cross-table reload the new table's body content (no memory) grabs the
   *  recalled codewords front-of-pool and steals the sidebar's letters. */
  private reserved: Set<string> = new Set();
  /** In-flight refill, so we don't pile up redundant CLAIM_LABELS while
   *  one is already on the wire. */
  private refillInFlight: Promise<void> | null = null;
  /** Initial-reservation promise so concurrent ensureReady() callers
   *  await the same fetch. */
  private initialReady: Promise<void> | null = null;
  /** Content-layer hook for confirm rejections: codewords the SW pool
   *  arbitrated AWAY from this frame (another frame won them, or the pool
   *  no longer knows them). The handler must make the holding wrappers drop
   *  the codeword WITHOUT a RELEASE (we don't own it — releasing would free
   *  the winner's assignment) and re-claim fresh. */
  private rejectionHandler: ((codewords: string[]) => void) | null = null;

  /** Register the confirm-rejection handler (content.ts, once at boot). */
  onConfirmRejected(handler: (codewords: string[]) => void): void {
    this.rejectionHandler = handler;
  }

  /** Process a CONFIRM_LABELS response: purge rejected codewords from every
   *  local structure, then hand them to the content layer. */
  private handleConfirmResponse(resp: { rejected?: unknown } | undefined): void {
    const rejected = Array.isArray(resp?.rejected)
      ? (resp.rejected as unknown[]).filter((l): l is string => typeof l === 'string' && l.length > 0)
      : [];
    if (rejected.length === 0) return;
    const rejectedSet = new Set(rejected);
    for (const l of rejected) {
      this.outstanding.delete(l);
      this.reserved.delete(l);
    }
    // Defensive — a rejected codeword shouldn't sit in `free` (it was just
    // granted out), but a racing release could have returned it.
    this.free = this.free.filter(l => !rejectedSet.has(l));
    this.rejectionHandler?.(rejected);
  }

  /**
   * Kick off the initial reservation if we don't have one yet. Idempotent;
   * concurrent callers share one fetch. Call early in content-script
   * bootstrap so the reservoir is warm before the first scan-claim batch.
   */
  ensureReady(preferred?: string[]): Promise<void> {
    if (this.free.length > 0) return Promise.resolve();
    if (this.initialReady) return this.initialReady;
    // `preferred` (Regime B startup reclaim): the SW grants these specific
    // codewords into the initial fill if they're still free in the pool, so a
    // fresh content script after a full-document reload reclaims the codewords
    // its fingerprints held before the reload. The SW falls back to front-of-
    // pool for the remaining slots. Only the *initial* fill carries preferred;
    // hot-path refills (maybeRefill) stay generic. See
    // notes/completed/DESIGN_CODEWORD_STABILITY.md +
    // notes/DESIGN_REGIME_B_RECALL.md.
    //
    // Size the fill to cover the FULL recalled set (capped), not just the first
    // INITIAL_RESERVATION — otherwise remembered codewords past slot 100 never
    // reach `free`, so their elements can't reclaim them (the cap leak, fix A2).
    // Fresh pages (no preferred) keep the cheap default fill.
    const want = preferred && preferred.length > INITIAL_RESERVATION
      ? Math.min(preferred.length, MAX_INITIAL_RESERVATION)
      : INITIAL_RESERVATION;
    this.initialReady = this.refill(want, preferred).then(() => {
      // Earmark the recalled codewords that landed in `free` so a fresh claim
      // can't steal them from their remembered owner (A3).
      if (preferred && preferred.length > 0) {
        const pref = new Set(preferred);
        for (const cw of this.free) if (pref.has(cw)) this.reserved.add(cw);
      }
    });
    return this.initialReady;
  }

  /**
   * Synchronously claim `count` codewords. Returns an array index-aligned
   * to the request; `''` in slot i means the reservoir couldn't fill it
   * (caller leaves the wrapper unhinted — see file header).
   *
   * `preferred[i]` is the sticky-reclaim hint for slot i (the codeword
   * the wrapper held before its last viewport exit). Pass 1 re-grants any
   * preferred still in the reservoir so scroll-back keeps the same letter.
   * Pass 2 fills the remaining slots front-of-pool.
   *
   * Triggers an async refill when the reservoir drops below threshold.
   */
  claim(count: number, preferred: string[] = []): string[] {
    const result: string[] = new Array(count).fill('');
    const granted = new Set<string>();

    // Pass 1 — sticky reclaim.
    const need: number[] = [];
    const freeSet = new Set(this.free);
    for (let i = 0; i < count; i++) {
      const pref = preferred[i];
      if (pref && freeSet.has(pref) && !granted.has(pref)) {
        granted.add(pref);
        result[i] = pref;
      } else {
        need.push(i);
      }
    }
    if (granted.size > 0) {
      this.free = this.free.filter(l => !granted.has(l));
    }

    // Pass 2 — fresh, front-of-pool in request order. Prefer a GENERIC
    // (non-reserved) codeword; leave recalled-reserved ones for their
    // remembered owners (A3). Fall back to a reserved one only when generic is
    // exhausted (starvation guard) so the pool can't deadlock. The `granted`
    // check guards against a codeword pass 1 already used OR an in-reservoir
    // duplicate that slipped past prior dedup.
    for (const idx of need) {
      let pick = -1;
      for (let j = 0; j < this.free.length; j++) {
        const cand = this.free[j];
        if (granted.has(cand) || this.reserved.has(cand)) continue;
        pick = j;
        break;
      }
      if (pick === -1) {
        // No generic left — take the first non-granted (reserved) codeword.
        for (let j = 0; j < this.free.length; j++) {
          if (!granted.has(this.free[j])) { pick = j; break; }
        }
      }
      if (pick === -1) break; // reservoir exhausted; rest stay ''
      const next = this.free.splice(pick, 1)[0];
      granted.add(next);
      result[idx] = next;
    }

    // Anything granted (own reclaim or starvation fallback) is no longer
    // reserved-for-an-owner.
    for (const g of granted) this.reserved.delete(g);

    // Confirm to the SW that these codewords are now wrapper-held, not just
    // reservoir-reserved. The promotion from reserved → assigned makes them
    // routable for voice activations; without it, the SW's getFrameForLabel
    // would return null and actions would fall through to the broadcast
    // fallback. The confirm is an ARBITRATED EXCHANGE (review bug #5 /
    // epoch-handshake Phase 4): the SW also acquires released-then-reclaimed
    // codewords straight from its free list, and answers `rejected` for any
    // codeword a different frame won in the release-vs-confirm window — we
    // must drop those (see handleConfirmResponse). Transport failure stays
    // best-effort: the next claim burst's confirm re-arbitrates, and the
    // broadcast fallback handles activations in the interim.
    const claimed = result.filter(l => l !== '');
    if (claimed.length > 0) {
      // Track outstanding grants so refill-dedup can reject SW-side re-issues
      // of a codeword we already have on a wrapper during the in-flight
      // confirm window. See the `outstanding` field comment.
      for (const l of claimed) this.outstanding.add(l);
      try {
        chrome.runtime.sendMessage({ type: 'CONFIRM_LABELS', labels: claimed })
          .then((resp: { rejected?: unknown } | undefined) => this.handleConfirmResponse(resp))
          .catch(() => {
            // SW asleep / extension reload — best-effort.
          });
      } catch {
        // chrome.runtime missing (orphan post-reload) — same fallback.
      }
    }

    this.maybeRefill();
    return result;
  }

  /**
   * Return codewords to the local pool (front, sticky-reclaim semantics)
   * and async-notify the SW so its assigned map can free them for other
   * tabs/frames. Safe to call repeatedly; empty arrays are no-ops.
   */
  release(labels: string[]): void {
    const valid = labels.filter(l => l && l.length > 0);
    if (valid.length === 0) return;
    // The wrapper no longer holds these — drop from outstanding so a
    // subsequent refill can legitimately re-introduce them. Done before
    // the dedup below so a re-released codeword the reservoir already
    // holds in `free` correctly clears its outstanding bit.
    for (const l of valid) this.outstanding.delete(l);
    // A released codeword returns to the generic pool — it's no longer
    // earmarked for a remembered owner (A3).
    for (const l of valid) this.reserved.delete(l);
    // Defensive dedup against the reservoir AND within the release set.
    // Two paths produce a duplicate-prone release: (a) the reservoir
    // already holds the codeword (a pre-fix duplicate or a release racing
    // a refill), (b) two distinct wrappers somehow share the codeword and
    // both pushed it to pendingRelease. Either way, the reservoir should
    // hold each codeword at most once after this call.
    const fresh: string[] = [];
    const seen = new Set(this.free);
    for (const l of valid) {
      if (!seen.has(l)) {
        fresh.push(l);
        seen.add(l);
      }
    }
    if (fresh.length > 0) this.free.unshift(...fresh);
    try {
      chrome.runtime.sendMessage({ type: 'RELEASE_LABELS', labels: valid }).catch(() => {
        // SW asleep / extension reload — codewords still effectively held
        // by this frame's reservation. They re-enter the pool via the
        // frame Port's onDisconnect on real teardown.
      });
    } catch {
      // chrome.runtime missing (orphan post-reload) — same fallback.
    }
  }

  /**
   * Drop all reservation state. Called when the alphabet changes — the
   * SW has wiped its pool server-side; our local cache is now stale
   * strings that no longer route.
   */
  clear(): void {
    this.free.length = 0;
    this.outstanding.clear();
    this.reserved.clear();
    this.initialReady = null;
    this.refillInFlight = null;
  }

  /** Diagnostic: current reservoir depth + refill state for snapshots. */
  stats(): { free: number; refillInFlight: boolean } {
    return { free: this.free.length, refillInFlight: this.refillInFlight !== null };
  }

  /** Test-only: seed the reservoir with a specific set of labels and
   *  reset refill state. Lets unit tests skip the async ensureReady()
   *  fetch and assert against deterministic codewords.
   *
   *  Seeding with `[]` is interpreted as "fresh empty state" — initialReady
   *  is null so a subsequent ensureReady() actually fetches. Seeding with
   *  non-empty labels treats them as already-fetched (initialReady resolved). */
  _seedForTests(labels: string[], reserved: string[] = []): void {
    this.free = [...labels];
    this.outstanding.clear();
    this.reserved = new Set(reserved);
    this.refillInFlight = null;
    this.initialReady = labels.length > 0 ? Promise.resolve() : null;
  }

  private maybeRefill(): void {
    if (this.refillInFlight) return;
    if (this.free.length >= REFILL_THRESHOLD) return;
    this.refillInFlight = this.refill(REFILL_AMOUNT).finally(() => {
      this.refillInFlight = null;
    });
  }

  private async refill(count: number, preferred?: string[]): Promise<void> {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'CLAIM_LABELS', count, preferred });
      if (Array.isArray(resp?.labels)) {
        // Dedup against `free ∪ outstanding`. The SW can re-issue a
        // codeword we already have outstanding on a wrapper while our
        // CONFIRM for it is still in flight (the confirm exchange acquires
        // it from `stack.free` only once it lands — a refill processed in
        // that window can pick it up). Dedup against `free` alone misses
        // this case because the codeword isn't in `free` while a wrapper
        // holds it — it's in `outstanding`. QuickBase 2026-06-05 — 6
        // wrappers all attached with "cap each" in 260ms.
        const seen = new Set(this.free);
        for (const l of this.outstanding) seen.add(l);
        for (const l of resp.labels) {
          if (typeof l === 'string' && l.length > 0 && !seen.has(l)) {
            this.free.push(l);
            seen.add(l);
          }
        }
      }
    } catch {
      // SW unavailable. The reservoir stays at its current depth; the
      // next claim batch with too few codewords returns '' for the
      // overflow, the level-triggered reconciler re-queues them, and a
      // later refill picks up where this one failed.
    }
  }
}

export const labelReservoir = new LabelReservoir();
