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
 * store. `detachWrapper` and the two observers (`tracker`, `resizeObserver`)
 * still live in content.ts and are injected via `initLimbo` — they become
 * direct imports once the wrapper-lifecycle lift and the observer relocation
 * (Tier 3) land.
 */

import { ElementWrapper, enterLimbo, isLimboExpired } from '../scan/element-wrapper';
import * as idRegistry from '../scan/registry';
import { computeFingerprint, fingerprintsEqual } from '../scan/registry';
import { bumpRebindCounter, findLimboMatch, newRebindCounters, REBIND_DISTANCE_THRESHOLD_PX, type RebindCounters } from '../labels/rebind';
import { peekCachedRect } from '../layout-cache';
import { lifecycleCounters, recordCpu } from '../debug/perf-counters';
import { store } from '../core/store';
import type { IntersectionTracker } from './intersection-tracker';

let detachWrapper!: (element: Element) => void;
let tracker!: IntersectionTracker;
let resizeObserver!: ResizeObserver;

export interface LimboDeps {
  detachWrapper: (element: Element) => void;
  tracker: IntersectionTracker;
  resizeObserver: ResizeObserver;
}

/** Wire the still-in-content.ts dependencies. Call once at boot. */
export function initLimbo(deps: LimboDeps): void {
  detachWrapper = deps.detachWrapper;
  tracker = deps.tracker;
  resizeObserver = deps.resizeObserver;
}

// Per-bucket rebind counters fed by `tryRebindFromLimbo` and the finalize
// sweeper. Read via `window.branchkitRebindStats()` (console) and the debug
// overlay's stats panel. The thresholds and bucket ratios drive the soak-time
// tuning of REBIND_DISTANCE_THRESHOLD_PX.
export const rebindCounters: RebindCounters = newRebindCounters();

export const LIMBO_DEADLINE_MS = 250;

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
export function tryRebindFromLimbo(newEl: Element, pool: ElementWrapper[]): boolean {
  const newFp = computeFingerprint(newEl);
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

  tracker.unobserve(oldEl);
  tracker.observe(newEl);
  resizeObserver.unobserve(oldEl);
  resizeObserver.observe(newEl);

  if (w.hint) w.hint.retarget(newEl);

  w.element = newEl;
  w.disconnectedAt = null;
  w.lastRect = null;
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
      tracker.observe(w.element);
      resizeObserver.observe(w.element);
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
