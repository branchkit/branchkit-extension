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
import { computeFingerprint, fingerprintsEqual, computeStrongKey } from '../scan/registry';
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

  pageSession.tracker.unobserve(oldEl);
  pageSession.tracker.observe(newEl);
  pageSession.resizeObserver.unobserve(oldEl);
  pageSession.resizeObserver.observe(newEl);

  if (w.hint) w.hint.retarget(newEl);

  w.element = newEl;
  w.disconnectedAt = null;
  w.lastRect = null;
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
 * Index: strong key → the wrappers that hold it, in attach order (≈ document
 * order for a batch-discovered generation). Built once per discovery pass
 * from the live store. Cheap — `computeStrongKey` reads an attribute, no
 * accessible-name.
 *
 * Round 34: a QUEUE per key, not the old ambiguous-null. Repeated-value grid
 * columns (ten rows all linking the same buyer — identical href AND column)
 * produce N same-key wrappers; on QuickBase's identical insert-before-remove
 * re-render their N replacements arrive in the same order, so popping in
 * order pairs each badge with its own successor. The ambiguous-null instead
 * killed every one of those badges and re-attached fresh — the visible
 * flash-off/flash-on cycle. A mispaired pop is action-equivalent by
 * construction (same href, same activation result — the original safety
 * argument for href keys) and self-heals via rediscovery like any wrong
 * steal.
 */
export function collectStrongKeyIndex(): Map<string, ElementWrapper[]> {
  const index = new Map<string, ElementWrapper[]>();
  for (const w of store.all) {
    if (w.scanned.id <= 0) continue;
    const key = computeStrongKey(w.element);
    if (!key) continue;
    const queue = index.get(key);
    if (queue) queue.push(w);
    else index.set(key, [w]);
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
 * Pops the key's queue head (skipping the new node itself if present).
 * Consumes the entry from both the index and the limbo pool so a second
 * same-key node and the fingerprint path can't also grab it. Marks the
 * orphaned predecessor for the ping-pong guard.
 */
export function tryRebindByStrongKey(
  newEl: Element,
  keyIndex: Map<string, ElementWrapper[]>,
  limboPool: ElementWrapper[],
): { orphaned: Element | null; prevElement: Element } | null {
  const key = computeStrongKey(newEl);
  if (!key) return null;
  const queue = keyIndex.get(key);
  if (!queue || queue.length === 0) return null;
  // Round 34e: pop DISCONNECTED predecessors first — they're free wins
  // (dead element, live badge). A connected predecessor is only stolen
  // when no dead one holds the key, and the steal is reported back so the
  // caller re-attaches the orphaned element FRESH in the same pass. The
  // 34-era queue popped healthy visible rows and left them bare: the
  // orphan guard assumed "the page removes the predecessor shortly"
  // (true for re-mount casualties, false for healthy duplicates), and
  // after the guard expired the bare link's re-discovery STOLE FROM THE
  // NEXT visible duplicate — musical chairs with a rotating badge-less
  // link (16 visible bare links on the client drill, all repeated-value).
  // Never steal from the new node itself.
  // Liveness guard: the key index is a pass-start snapshot and the batched
  // walk yields between slices, so the finalize sweeper can detach a queued
  // wrapper mid-pass — and the disconnected-first pop below preferentially
  // selects exactly that population. Rebinding a detached wrapper corrupts
  // the store (byElement entry with no wrappers-array entry: the element
  // becomes permanently undiscoverable). Skip corpses; a stale entry just
  // means this key falls through to the other tiers or a fresh attach.
  const live = (cand: ElementWrapper) => store.findWrapperFor(cand.element) === cand;
  let idx = queue.findIndex((cand) => cand.element !== newEl && !cand.element.isConnected && live(cand));
  if (idx === -1) idx = queue.findIndex((cand) => cand.element !== newEl && live(cand));
  if (idx === -1) return null;
  const w = queue[idx];
  queue.splice(idx, 1);
  if (queue.length === 0) keyIndex.delete(key);
  consume(limboPool, w);
  // prevElement: where the wrapper lived before this ride — the row-pair
  // pin for the coattail tier (round 35). Captured before rebindWrapper
  // re-anchors; reported whether or not it's still connected.
  const prevElement = w.element;
  const orphaned = prevElement.isConnected ? prevElement : null;
  if (orphaned) orphanedByKeyRebind.set(orphaned, Date.now());
  rebindCounters.rebind_key++;
  rebindWrapper(w, newEl);
  return { orphaned, prevElement };
}


/**
 * Row-coattail tier (round 35 — the round-26 mechanism rebuilt on
 * strong-key pins). A grid re-render replaces whole rows; the row's LINK
 * rides via its strong key (href+column — reliable, 271/fling on the client
 * grid), which proves old-row -> new-row correspondence. The row's KEYLESS
 * controls (checkbox / pencil / eye — the once-per-swap blink cohort, 3 of
 * ~6 badges per row) then ride that pin: same structural child-index path
 * within the paired rows, same tag -> inherit the predecessor's wrapper
 * (badge, letter, grammar entry).
 *
 * Guards (all fall through to fresh attach): no row / no pair for the row /
 * path miss / tag mismatch / predecessor has no live wrapper. A connected
 * predecessor is reported as `orphaned` so the caller re-attaches it fresh
 * (the 34e visual invariant: every visible hintable stays badged).
 */
export function tryRebindByCoattail(
  newEl: Element,
  rowPairs: Map<Element, Element>,
  limboPool: ElementWrapper[],
): { orphaned: Element | null } | null {
  const row = newEl.closest('tr, [role="row"]');
  if (!row) return null;
  const prevRow = rowPairs.get(row);
  if (!prevRow) return null;
  // Structural path of newEl within its row (child indices, root-first).
  const path: number[] = [];
  let n: Element = newEl;
  while (n !== row) {
    const parent: Element | null = n.parentElement;
    if (!parent) return null;
    path.push(Array.prototype.indexOf.call(parent.children, n));
    n = parent;
  }
  path.reverse();
  let old: Element = prevRow;
  for (const seg of path) {
    const child = old.children[seg];
    if (!child) return null;
    old = child;
  }
  if (old.tagName !== newEl.tagName) return null;
  const w = store.findWrapperFor(old);
  if (!w) return null;
  consume(limboPool, w);
  const orphaned = old.isConnected ? old : null;
  if (orphaned) orphanedByKeyRebind.set(orphaned, Date.now());
  rebindCounters.rebind_coattail++;
  rebindWrapper(w, newEl);
  return { orphaned };
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
    // chrome). Clear disconnectedAt FIRST, then re-attach the observers —
    // so the IntersectionObserver's mandatory initial callback runs with the
    // wrapper non-limbo and the idempotent claim (claims only when no codeword
    // is held) can't double-claim.
    //
    // The unobserve/observe CYCLE is load-bearing (the manageusers stale-FALSE
    // cohort, 2026-07-18): limbo entry never unobserves, so for a same-node
    // reconnect the element is STILL in the IO's target list and a bare
    // observe() is a spec no-op — no initial entry. Meanwhile any entry the IO
    // delivered during the limbo window was discarded by handleEntries' limbo
    // guard, so the IO's last-reported state can already match reality (element
    // in-band, reported true, entry thrown away) and no crossing ever fires
    // again — isInViewport stays stale-FALSE until a geometry sweep repairs it.
    // Cycling the observation resets the IO's per-target state and forces a
    // fresh initial entry. rebindWrapper does the same cycle on its path.
    if (w.element.isConnected) {
      w.disconnectedAt = null;
      w.lastRect = null;
      pageSession.tracker.unobserve(w.element);
      pageSession.tracker.observe(w.element);
      pageSession.resizeObserver.unobserve(w.element);
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
