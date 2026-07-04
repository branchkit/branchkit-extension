/**
 * BranchKit Browser — limbo / rebind / finalize.
 *
 * Wrapper identity stability: a disconnected wrapper isn't torn down
 * immediately — its codeword and badge are held in "limbo" so a follow-up
 * React render or DOM move can re-attach the same logical identity (rebind)
 * without churning the codeword pool. A finalize sweeper reaps wrappers that
 * stay disconnected past the deadline. See
 * notes/completed/DESIGN_WRAPPER_IDENTITY_STABILITY.md.
 *
 * Extracted from content.ts module scope (Tier 1 of
 * notes/DESIGN_EXTENSION_RESTRUCTURE.md). The pure rebind decision logic
 * already lives in labels/rebind.ts; this owns the orchestration over the
 * store. The two observers (`tracker`, `resizeObserver`) are owned by the
 * `pageSession` singleton (Tier 3 — constructed in `PageSession.start()`);
 * `detachWrapper` is a direct import from core/wrapper-lifecycle (the import
 * cycle with it is runtime-only function references, which ES modules allow).
 */

import { ElementWrapper, enterLimbo, isLimboExpired } from '../scan/element-wrapper';
import * as idRegistry from '../scan/registry';
import { computeFingerprint, fingerprintsEqual, fingerprintToString, computeStrongKey, type Fingerprint } from '../scan/registry';
import { bumpRebindCounter, findLimboMatch, newRebindCounters, REBIND_DISTANCE_THRESHOLD_PX, type RebindCounters } from '../labels/rebind';
import { peekCachedRect } from '../layout-cache';
import { lifecycleCounters, recordCpu } from '../debug/perf-counters';
import { store } from '../core/store';
import { detachWrapper } from '../core/wrapper-lifecycle';
import { pageSession } from '../lifecycle/page-session';

// Per-bucket rebind counters fed by `tryRebindFromLimbo` and the finalize
// sweeper. Read via `window.branchkitRebindStats()` (console) and the debug
// overlay's stats panel. The thresholds and bucket ratios drive the soak-time
// tuning of REBIND_DISTANCE_THRESHOLD_PX.
export const rebindCounters: RebindCounters = newRebindCounters();

export const LIMBO_DEADLINE_MS = 250;

// Slot recording depth (notes/DESIGN_FLING_WAVE.md Part 2): on the measured
// QuickBase grid, hintables put their td at depth 1 (160), 2 (84), and 5
// (60 — buttons under extra cell layers), so record to 6 or through the
// first row-shaped ancestor, whichever is shallower.
const SLOT_ANCESTOR_DEPTH = 6;

// Ancestors that must never anchor a slot: they span MANY slots (a tbody
// survives every row swap and contains everything), so recording them would
// let a unique element removed in one place steal onto a unique same-kind
// element added anywhere under the shared container — the cross-page
// mis-bind the ambiguity gates can't see (both sides look unique locally).
const SLOT_STOP_TAGS = new Set(['BODY', 'HTML', 'TABLE', 'TBODY', 'THEAD', 'TFOOT', 'MAIN']);
const SLOT_STOP_ROLES = new Set(['grid', 'treegrid', 'rowgroup', 'table', 'main']);

/** Record the wrapper's slot identity: WeakRefs to its first few parents,
 * nearest first, stopping after the first row-shaped ancestor (tr /
 * role=row) and BEFORE any multi-slot structural container (stop-list
 * above). Pointer reads only — no layout. Called at attach and re-called on
 * every rebind (the new element's chain is the live slot now). */
export function recordSlotAncestors(w: ElementWrapper): void {
  const out: WeakRef<Element>[] = [];
  let p = w.element.parentElement;
  while (p && out.length < SLOT_ANCESTOR_DEPTH) {
    if (SLOT_STOP_TAGS.has(p.tagName)) break;
    const role = p.getAttribute('role');
    if (role && SLOT_STOP_ROLES.has(role)) break;
    out.push(new WeakRef(p));
    if (p.tagName === 'TR' || role === 'row') break;
    p = p.parentElement;
  }
  w.slotAncestors = out;
}

/**
 * Slot-rebind tier (third, after strong-key and fingerprint —
 * notes/DESIGN_FLING_WAVE.md Part 2). A virtualized grid swaps a cell's
 * content: the new record's element has a DIFFERENT fingerprint (different
 * text/name) and a DIFFERENT href (no strong key), so both existing tiers
 * miss BY DESIGN and every swap was a full teardown + construction +
 * codeword churn — the pop-then-blink the eye keys on. Here the codeword
 * names the SLOT: if exactly one limbo wrapper's recorded slot ancestor
 * still contains `newEl` (same tag+role), re-anchor it — badge, letter,
 * grammar entry, and grammarReady all survive; activation routes to the new
 * element via the registry ref.
 *
 * Refusal gates (mis-binds must be structurally impossible, per the YouTube
 * duplicate-fingerprint history):
 *   - tag or role differs → not a slot swap, skip.
 *   - two limbo wrappers slot-match the same new element → refuse.
 *   - the surviving slot anchor contains 2+ same-tag/role elements → refuse
 *     (a cell with two links is ambiguous in the other direction).
 * On any refusal the caller falls through to a fresh attach — exactly
 * today's behavior. Grids that replace whole rows never match (no recorded
 * ancestor survives): the tier degrades to a no-op, which also makes its
 * `rebind_slot` counter the live probe for whether shells survive.
 *
 * Returns the rebound wrapper (so the caller can refresh its scanned
 * metadata — the record content changed) or null for fresh-attach.
 */
export function tryRebindBySlot(newEl: Element, pool: ElementWrapper[]): ElementWrapper | null {
  slotProbe.attempts++;
  if (pool.length === 0) {
    // Nothing to rebind against — if this dominates during grid churn, the
    // old content hasn't entered limbo by the time the replacement is
    // discovered (a discovery-vs-removal ordering problem), which is a very
    // different disease than "the shells die with the rows".
    slotProbe.pool_empty++;
    return null;
  }
  const newTag = newEl.tagName;
  const newRole = newEl.getAttribute('role');
  let sawKind = false;
  let match: ElementWrapper | null = null;
  let matchAnchor: Element | null = null;
  for (const w of pool) {
    if (w.element.tagName !== newTag) continue;
    if (w.element.getAttribute('role') !== newRole) continue;
    sawKind = true;
    // Nearest-first recorded chain: the first still-connected ancestor that
    // contains the new element is the deepest surviving slot anchor.
    for (const ref of w.slotAncestors) {
      const anc = ref.deref();
      if (!anc || !anc.isConnected || !anc.contains(newEl)) continue;
      if (match !== null) { slotProbe.multi_wrapper++; return null; }
      match = w;
      matchAnchor = anc;
      break;
    }
  }
  if (!match || !matchAnchor) {
    if (sawKind) slotProbe.no_survivor++;
    else slotProbe.kind_mismatch++;
    return null;
  }
  // Reverse-direction ambiguity: the surviving anchor holds 2+ same-tag/role
  // candidates (a cell with two links) — no safe pick.
  let sameKind = 0;
  for (const el of matchAnchor.querySelectorAll(newTag)) {
    if (el.getAttribute('role') === newRole) sameKind++;
    if (sameKind > 1) { slotProbe.multi_candidate++; return null; }
  }
  rebindCounters.rebind_slot++;
  slotProbe.rebound++;
  rebindWrapper(match, newEl);
  consume(pool, match);
  return match;
}

/** Why slot rebinds do or don't fire (surfaced on the debug snapshot's
 * `wave` section). `pool_empty` dominating during grid churn = the old
 * content isn't in limbo yet when the replacement is discovered (ordering);
 * `no_survivor` dominating = the shells genuinely die with the rows;
 * ambiguity counters dominating = the gates are too strict for this DOM. */
export const slotProbe = {
  attempts: 0,
  pool_empty: 0,
  kind_mismatch: 0,
  no_survivor: 0,
  multi_wrapper: 0,
  multi_candidate: 0,
  rebound: 0,
};

/** Slot-ancestor liveness at limbo entry (the other half of the probe): of
 * wrappers entering limbo, how many still have a connected recorded slot
 * ancestor RIGHT NOW? alive≈0 = shells die in the same mutation as their
 * content (slot rebind can never fire); alive high + pool_empty high =
 * ordering, not structure. */
export const limboSlotLiveness = { alive: 0, dead: 0, unrecorded: 0 };

export function collectLimboWrappers(): ElementWrapper[] {
  const out: ElementWrapper[] = [];
  for (const w of store.all) {
    // Only DISCONNECTED limbo wrappers are rebind-eligible. A soft-detached nav
    // survivor (still connected, parked in limbo for the wedge preempt) must be
    // excluded, or new content with a colliding fingerprint could rebind-steal
    // its codeword + badge off the live element.
    if (w.disconnectedAt !== null && !w.element.isConnected && w.scanned.id > 0) out.push(w);
  }
  return out;
}

/**
 * Probe `pool` for a limbo wrapper whose fingerprint (and, on multi-
 * match, last position) matches `newEl`. On a successful rebind, the
 * wrapper is consumed from `pool` and `rebindWrapper` is run. On
 * `refuse_distance`, the ambiguous candidates are finalized in place
 * (their last positions are too scrambled to safely pick one). Returns
 * true iff the new element was rebound; false means the caller should
 * create a fresh wrapper.
 */
export function tryRebindFromLimbo(newEl: Element, pool: ElementWrapper[], precomputedFp?: Fingerprint): boolean {
  const newFp = precomputedFp ?? computeFingerprint(newEl);
  const matches: ElementWrapper[] = [];
  for (const w of pool) {
    const entry = idRegistry.get(w.scanned.id);
    if (!entry) continue;
    if (fingerprintsEqual(entry.fingerprint, newFp)) matches.push(w);
  }
  if (matches.length === 0) return false;

  // One getBoundingClientRect read per discovery — paid only when there's
  // at least one fingerprint match. Single-match case ignores it.
  const newRect = matches.length === 1 ? null : newEl.getBoundingClientRect();
  const outcome = findLimboMatch(matches, newRect, REBIND_DISTANCE_THRESHOLD_PX);

  bumpRebindCounter(rebindCounters, outcome);
  switch (outcome.kind) {
    case 'rebind_clean':
    case 'rebind_position': {
      rebindWrapper(outcome.wrapper, newEl);
      consume(pool, outcome.wrapper);
      return true;
    }
    case 'refuse_distance': {
      for (const c of outcome.candidates) {
        consume(pool, c);
        detachWrapper(c.element);
      }
      return false;
    }
    case 'no_candidates':
      return false;
  }
}

function consume(pool: ElementWrapper[], w: ElementWrapper): void {
  const idx = pool.indexOf(w);
  if (idx >= 0) pool.splice(idx, 1);
}

/**
 * Re-anchor `w` to `newEl`. The wrapper's codeword, badge, label, and
 * registry id all survive — only the DOM-identity edges swap. Mirrors
 * the algorithm in `notes/completed/DESIGN_WRAPPER_IDENTITY_STABILITY.md`
 * "Rebind operation". Order matters: store + registry first (so the
 * tracker callbacks can find the wrapper by newEl), then observers,
 * then the badge swap, then the mutable `.element` pointer.
 */
function rebindWrapper(w: ElementWrapper, newEl: Element): void {
  const oldEl = w.element;

  store.rebindElement(oldEl, newEl, w);
  if (w.scanned.id > 0) {
    idRegistry.rebindRef(w.scanned.id, newEl);
    idRegistry.refreshFingerprint(w.scanned.id, newEl);
  }

  pageSession.tracker.unobserve(oldEl);
  pageSession.tracker.observe(newEl);
  pageSession.resizeObserver.unobserve(oldEl);
  pageSession.resizeObserver.observe(newEl);

  if (w.hint) w.hint.retarget(newEl);

  w.element = newEl;
  w.disconnectedAt = null;
  w.lastRect = null;
  // The new element's parent chain is the live slot now (Part 2 of
  // notes/DESIGN_FLING_WAVE.md) — re-record so the NEXT recycle of this
  // cell can slot-rebind again.
  recordSlotAncestors(w);
}

// --- Key-ownership rebind (DESIGN_CODEWORD_KEY_OWNERSHIP.md) ---

// Ping-pong guard. When tryRebindByStrongKey transfers a wrapper onto a new node,
// the predecessor node is briefly connected but wrapper-less; without this it
// could be re-discovered the next pass and bounce the wrapper back. Discovery
// skips a node orphaned within this window. WeakMap so entries GC with the node.
const orphanedByKeyRebind = new WeakMap<Element, number>();
const ORPHAN_SKIP_MS = 2000;

export function isRecentlyOrphaned(el: Element): boolean {
  const t = orphanedByKeyRebind.get(el);
  return t !== undefined && Date.now() - t < ORPHAN_SKIP_MS;
}

/**
 * Index: strong key → the single wrapper that holds it, or `null` when 2+
 * wrappers share the key (a genuine duplicate, not a re-mount). Built once per
 * discovery pass from the live store; only single-holder keys are rebind-
 * eligible. Cheap — `computeStrongKey` reads an attribute, no accessible-name.
 */
export function collectStrongKeyIndex(): Map<string, ElementWrapper | null> {
  const index = new Map<string, ElementWrapper | null>();
  for (const w of store.all) {
    if (w.scanned.id <= 0) continue;
    const key = computeStrongKey(w.element);
    if (!key) continue;
    index.set(key, index.has(key) ? null : w);
  }
  return index;
}

/**
 * Transfer an existing wrapper's codeword + identity onto a freshly-discovered
 * node that shares its strong key. The key-ownership fast path: it sidesteps the
 * codeword pool (the predecessor still holds the letter, so a fresh claim can't
 * reclaim it) by re-anchoring the live wrapper instead. Returns true iff rebound;
 * false means fall through to the fingerprint-limbo path / fresh attach.
 *
 * Fires only when exactly one wrapper holds the key (index stored a wrapper, not
 * `null`) and it's a different node. Consumes the entry from both the index and
 * the limbo pool so a second same-key node and the fingerprint path can't also
 * grab it. Marks the orphaned predecessor for the ping-pong guard.
 */
export function tryRebindByStrongKey(
  newEl: Element,
  keyIndex: Map<string, ElementWrapper | null>,
  limboPool: ElementWrapper[],
): boolean {
  const key = computeStrongKey(newEl);
  if (!key) return false;
  const w = keyIndex.get(key);
  if (!w) return false;              // undefined (no holder) or null (ambiguous)
  if (w.element === newEl) return false;
  keyIndex.delete(key);
  consume(limboPool, w);
  if (w.element.isConnected) orphanedByKeyRebind.set(w.element, Date.now());
  rebindCounters.rebind_key++;
  rebindWrapper(w, newEl);
  return true;
}

// --- Connected-predecessor takeover by fingerprint + position (round 23,
// DESIGN_FLING_WAVE.md) ---
//
// The fingerprint/position tier above only consults the limbo pool —
// disconnected wrappers. QuickBase inserts the replacement window BEFORE
// removing the old one (slot_probe.pool_empty 591/1104 on production), so at
// discovery time the doomed predecessor is still connected and the pool is
// empty: identical-content remounts churned fresh wrappers, letters, grammar
// entries, and badges on every fling — the viewport-strict dip the user
// watches (174→121, ~2.7s). This tier is the strong-key takeover's pattern
// applied to everything without an href: badge + letter + grammar RIDE the
// swap, producing zero sync traffic (same fingerprint = same content, no
// re-Put).

// Unique-fingerprint steals take NO position gate (round 24, fixture-found):
// during an insert-before-remove overlap the replacement rows are appended
// BELOW the doomed rows — the new element's real position doesn't exist
// until the old generation leaves, so any position gate structurally
// refuses (the original 300px gate made takeover_fp read 0 forever, with
// no counter to show the refusals). Uniqueness is the identity argument:
// there is exactly one connected element that looks like this, so a new
// lookalike is its replacement wherever either of them currently sits.
// Ambiguous fingerprints (identical per-row controls — checkboxes,
// pencil/eye): the new element must sit ON one predecessor (co-location of
// identical controls is not a legitimate steady state) AND be uniquely
// nearest — grid rows sit ~35-45px apart, so a same-column neighbor-row twin
// fails the margin.
const TAKEOVER_TIGHT_PX = 40;
const TAKEOVER_MARGIN_PX = 40;

/**
 * Index: fingerprint string → CONNECTED, non-limbo wrappers holding it.
 * Built once per discovery pass alongside `collectStrongKeyIndex`.
 * Fingerprints come from the registry (computed at register time), so this
 * is O(store) pointer reads — no DOM access, no layout.
 */
export function collectFingerprintIndex(): Map<string, ElementWrapper[]> {
  const index = new Map<string, ElementWrapper[]>();
  for (const w of store.all) {
    if (w.scanned.id <= 0) continue;
    if (w.disconnectedAt !== null || !w.element.isConnected) continue;
    const entry = idRegistry.get(w.scanned.id);
    if (!entry) continue;
    const key = fingerprintToString(entry.fingerprint);
    const list = index.get(key);
    if (list) list.push(w);
    else index.set(key, [w]);
  }
  return index;
}

const centerDist = (r: DOMRect, rect: DOMRect): number => {
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  return Math.max(
    Math.abs(r.left + r.width / 2 - cx),
    Math.abs(r.top + r.height / 2 - cy),
  );
};

/**
 * Transfer a still-connected doomed predecessor's wrapper onto a
 * freshly-discovered lookalike. Returns true iff taken over; false falls
 * through to the slot tier / fresh attach (today's behavior — fail-safe).
 *
 * Wrong steals self-heal: the robbed element loses its wrapper, the next
 * sweep/MO pass rediscovers it, and it attaches fresh — one letter swap on
 * one control, paid only on a bad bet instead of on every swap. The
 * consumed-from-index rule stops a second new element from stealing the
 * same predecessor; `orphanedByKeyRebind` (the existing ping-pong guard)
 * stops the robbed element from grabbing the wrapper back via
 * `attachDiscovered`'s isRecentlyOrphaned skip.
 */
export function tryTakeoverByFingerprint(
  newEl: Element,
  newFp: Fingerprint,
  fpIndex: Map<string, ElementWrapper[]>,
): boolean {
  const list = fpIndex.get(fingerprintToString(newFp));
  if (!list || list.length === 0) return false;
  // Re-validate at match time — the index snapshot can go stale within a
  // pass (elements disconnect mid-drain). The ambiguous branch additionally
  // needs lastRect to position-verify; the unique branch does not.
  const candidates = list.filter(
    (w) => w.element !== newEl && w.element.isConnected,
  );
  if (candidates.length === 0) return false;

  let winner: ElementWrapper | null = null;
  if (candidates.length === 1) {
    winner = candidates[0];
  } else if (candidates.some((w) => w.lastRect === null)) {
    // Can't fairly position-rank a mixed group; refuse to fresh attach.
    rebindCounters.refuse_fp_ambiguous++;
    return false;
  } else {
    const newRect = peekCachedRect(newEl) ?? newEl.getBoundingClientRect();
    let best: { w: ElementWrapper; d: number } | null = null;
    let second = Infinity;
    for (const w of candidates) {
      const d = centerDist(newRect, w.lastRect!);
      if (!best || d < best.d) {
        second = best?.d ?? Infinity;
        best = { w, d };
      } else if (d < second) {
        second = d;
      }
    }
    if (best && best.d <= TAKEOVER_TIGHT_PX && second - best.d >= TAKEOVER_MARGIN_PX) {
      winner = best.w;
    } else {
      rebindCounters.refuse_fp_ambiguous++;
      return false;
    }
  }
  if (!winner) return false;

  const idx = list.indexOf(winner);
  if (idx >= 0) list.splice(idx, 1);
  orphanedByKeyRebind.set(winner.element, Date.now());
  if (candidates.length === 1) rebindCounters.takeover_fp++;
  else rebindCounters.takeover_fp_position++;
  // Deliberately NOT adopting the fresh scan metadata (unlike the slot
  // tier): same fingerprint = same content — no re-Put, no grammar delta.
  rebindWrapper(winner, newEl);
  return true;
}

/**
 * Move disconnected wrappers into limbo. Per
 * `notes/completed/DESIGN_WRAPPER_IDENTITY_STABILITY.md` steps 1–2, a disconnect
 * no longer immediately tears down the wrapper — codeword and badge are
 * held so a follow-up React render or DOM move can re-attach the same
 * logical identity (step 3+) without churning the codeword pool. The
 * finalize sweeper (`finalizeExpiredLimboWrappers`) reaps any wrapper
 * still disconnected after `LIMBO_DEADLINE_MS`.
 *
 * Returns the count of wrappers that newly entered limbo. Grammar
 * doesn't change on limbo entry (the codeword stays claimed), so callers
 * should NOT use the return value to schedule a grammar push — the
 * sweeper does that when it actually detaches.
 */
export function dropDisconnectedWrappers(): number {
  const __cpuStart = performance.now();
  const __initialSize = store.all.length;
  let entered = 0;
  const now = Date.now();
  for (const w of store.all) {
    if (w.disconnectedAt !== null) continue;
    if (!w.element.isConnected) {
      // lastRect is normally already populated by the IntersectionTracker
      // from a recent IO entry. Only fall back to the layout cache for
      // wrappers that disconnected before IO had a chance to fire (race
      // during heavy first-paint mutation churn). If neither has a rect,
      // multi-match rebinds for this wrapper will refuse on distance.
      if (!w.lastRect) w.lastRect = peekCachedRect(w.element);
      enterLimbo(w, now);
      entered++;
      // Slot-liveness probe (DESIGN_FLING_WAVE round 7): does any recorded
      // slot ancestor survive at the moment the content dies? Pointer reads.
      if (w.slotAncestors.length === 0) {
        limboSlotLiveness.unrecorded++;
      } else if (w.slotAncestors.some(r => r.deref()?.isConnected)) {
        limboSlotLiveness.alive++;
      } else {
        limboSlotLiveness.dead++;
      }
    }
  }
  lifecycleCounters.dropDisconnectedCalls++;
  lifecycleCounters.dropDisconnectedFound += entered;
  // Labeled so a watchdog stall during a full-page DOM swap (where every
  // wrapper disconnects at once) attributes here instead of falling into
  // unattributedMs. This is one of the two synchronous steps the spa_nav
  // from_cache rescan runs before the deferred walk — previously invisible
  // to topLabels, which is why "us vs YouTube" couldn't be pinned on the
  // nav-time wedge. See notes/INVESTIGATION_YOUTUBE_WATCH_PERF.md.
  recordCpu('dropDisconnectedWrappers', performance.now() - __cpuStart);
  if (__initialSize > 0) recordCpu(`dropDisconnectedWrappers:size:${__initialSize > 1000 ? '1000+' : __initialSize > 100 ? '100-1000' : '<100'}`, __initialSize);
  return entered;
}

/**
 * Finalize sweeper. Detaches any wrapper whose limbo deadline has
 * elapsed without a rebind. Runs on a fixed interval — short enough
 * that the codeword pool can't be starved by held-but-dead wrappers
 * (worst case: 676 codewords × 250ms ≈ ¼-second blocking window).
 *
 * Increments `refuse_no_match` per finalization. A high rate on a
 * given site suggests the fingerprint is too tight (rebind never finds
 * a match) — see the open question on fingerprint refresh in the
 * design doc.
 */
export function finalizeExpiredLimboWrappers(): number {
  const now = Date.now();
  // Iterate a copy so we can mutate `store` mid-loop.
  let finalized = 0;
  for (const w of [...store.all]) {
    if (!isLimboExpired(w, now, LIMBO_DEADLINE_MS)) continue;
    // Graduate a still-connected limbo wrapper back to live. Covers both the
    // same-node-reconnect case and soft-detached nav survivors (persistent
    // chrome). Clear disconnectedAt FIRST, then re-attach the observers
    // softDetach/teardown removed — so the IntersectionObserver's mandatory
    // initial callback runs with the wrapper non-limbo and the idempotent claim
    // (claims only when no codeword is held) can't double-claim. Mirror
    // attachWrapper: tracker + resize (attentionObserver is managed elsewhere).
    if (w.element.isConnected) {
      w.disconnectedAt = null;
      w.lastRect = null;
      pageSession.tracker.observe(w.element);
      pageSession.resizeObserver.observe(w.element);
      continue;
    }
    detachWrapper(w.element);
    rebindCounters.refuse_no_match++;
    finalized++;
  }
  lifecycleCounters.finalizeSweeps++;
  lifecycleCounters.finalizeDetached += finalized;
  // The detachWrapper above emits a store detach delta → grammar sync (Tier 2).
  return finalized;
}
