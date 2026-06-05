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
 */

const INITIAL_RESERVATION = 100;
const REFILL_THRESHOLD = 30;
const REFILL_AMOUNT = 60;

class LabelReservoir {
  /** Available codewords for synchronous claim, front-of-array first. */
  private free: string[] = [];
  /** Codewords currently held by wrappers in this frame (granted out but not
   *  yet released). Refill dedup checks `free ∪ outstanding` so the SW
   *  re-issuing a codeword we already handed to a wrapper can't slip past:
   *  the SW's CONFIRM_LABELS handler is no-op when the codeword sits in
   *  `stack.free` (because RELEASE landed before CONFIRM), so after a
   *  release-then-local-reclaim cycle the SW thinks the codeword is free
   *  and a later refill would dup-issue it. Tracking grants locally closes
   *  that race without a synchronous SW round-trip. QuickBase 2026-06-05 —
   *  6 wrappers all attached with "cap each" in 260ms, which then evicted
   *  `each` from `browser_hints_cap_strict` and made the CE hint
   *  unreachable. */
  private outstanding: Set<string> = new Set();
  /** In-flight refill, so we don't pile up redundant CLAIM_LABELS while
   *  one is already on the wire. */
  private refillInFlight: Promise<void> | null = null;
  /** Initial-reservation promise so concurrent ensureReady() callers
   *  await the same fetch. */
  private initialReady: Promise<void> | null = null;

  /**
   * Kick off the initial reservation if we don't have one yet. Idempotent;
   * concurrent callers share one fetch. Call early in content-script
   * bootstrap so the reservoir is warm before the first scan-claim batch.
   */
  ensureReady(): Promise<void> {
    if (this.free.length > 0) return Promise.resolve();
    if (this.initialReady) return this.initialReady;
    this.initialReady = this.refill(INITIAL_RESERVATION);
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

    // Pass 2 — fresh, front-of-pool in request order. The `granted` Set
    // check guards against returning a codeword that pass 1 already used
    // OR an in-reservoir duplicate that slipped past prior dedup (refill
    // and release both dedup now, but an existing reservoir from a
    // pre-fix session could still hold dupes — drain them safely instead
    // of handing them to two wrappers).
    for (const idx of need) {
      let next: string | undefined;
      while ((next = this.free.shift()) !== undefined) {
        if (!granted.has(next)) break;
      }
      if (next === undefined) break; // reservoir exhausted; rest stay ''
      granted.add(next);
      result[idx] = next;
    }

    // Confirm to the SW that these codewords are now wrapper-held, not just
    // reservoir-reserved. The promotion from reserved → assigned makes them
    // routable for voice activations; without it, the SW's getFrameForLabel
    // would return null and actions would fall through to the broadcast
    // fallback. Fire-and-forget — if the SW is temporarily unreachable
    // (orphan content script, SW restart mid-session), the next claim
    // burst's confirm catches up, and the worst-case interim is the
    // broadcast fallback handles the action anyway.
    const claimed = result.filter(l => l !== '');
    if (claimed.length > 0) {
      // Track outstanding grants so refill-dedup can reject SW-side re-issues
      // of a codeword we already have on a wrapper. See the `outstanding`
      // field comment for why the SW's CONFIRM is racey.
      for (const l of claimed) this.outstanding.add(l);
      try {
        chrome.runtime.sendMessage({ type: 'CONFIRM_LABELS', labels: claimed }).catch(() => {
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
  _seedForTests(labels: string[]): void {
    this.free = [...labels];
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

  private async refill(count: number): Promise<void> {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'CLAIM_LABELS', count });
      if (Array.isArray(resp?.labels)) {
        // Dedup against `free ∪ outstanding`. The SW can re-issue a
        // codeword we already have outstanding on a wrapper when a
        // release-then-local-reclaim race nukes the CONFIRM_LABELS
        // handler's reserved-match: RELEASE moves SW state to free, the
        // local reservoir hands the codeword to a new wrapper, and the
        // CONFIRM that follows is a no-op (no reserved entry to promote).
        // The SW then keeps the codeword in `stack.free` and a later
        // refill picks it up despite our local wrapper still holding it.
        // Dedup against `free` alone misses this case because the
        // codeword isn't in `free` while a wrapper holds it — it's in
        // `outstanding`. QuickBase 2026-06-05 — 6 wrappers all attached
        // with "cap each" in 260ms.
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
