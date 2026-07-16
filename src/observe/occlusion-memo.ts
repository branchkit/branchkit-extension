/**
 * BranchKit Browser — occlusion hit-test memoization (dirty-region epoch cache).
 *
 * notes/DESIGN_OCCLUSION_HITTEST_MEMO.md. Batch 3 of the settle gather
 * recomputes overlay occlusion (up to 5 elementFromPoint probes per visible
 * badge) every settle while the answer barely moves — 94.3% of the QuickBase
 * gather (Phase-0 decomposition). A cache keyed on the target's rect alone is
 * UNSOUND (occlusion is a function of the entire paint order above the sample
 * points, not of the target), so invalidation is dirty-region: cheap taps on
 * every signal that can move an occluder mark cells of a coarse viewport
 * grid, and a wrapper's cached verdict is reusable only when its rect key is
 * unchanged AND the cells under its sample points stayed clean AND it was
 * validated at the immediately preceding gather (the epoch — a wrapper that
 * skipped a gather missed that window's dirt, which is gone).
 *
 * Taps (all zero-layout-read at signal time; queued element rects resolve
 * inside the next gather against clean layout):
 *   - page MO + visibility MO batches → queue mutated elements, ADDED and
 *     REMOVED nodes included (≤K distinct; bigger, the huge path, or the
 *     manual-deferred path → all-dirty)
 *   - pointerover/pointerout → mark the cell under the event coordinates.
 *     The load-bearing novelty: pure-CSS :hover paints produce NO observer
 *     record of any kind — only the pointer position knows.
 *   - scroll / resize / transform-ancestor → all-dirty (targets move anyway)
 *   - focusin/focusout, transitionend/animationend → queue the event target
 *     (:focus-within can restyle with no record)
 *
 * History localization (fail-open tuning, 2026-07-16): every resolved
 * element's cells are remembered (WeakMap), so a queued element that turns
 * up disconnected / zero-box / off-viewport at resolve time — a closed
 * dropdown, a removed row, a display:none'd overlay — dirties exactly the
 * cells it LAST painted instead of failing the whole window open; the
 * all-dirty fail-open remains for elements with no recorded history. A
 * re-resolved element marks old ∪ new cells, closing the in-viewport-slide
 * gap for anything seen before. The history is wiped on geometry-shifting
 * all-dirty windows (scroll/resize/transform, unobserved spans,
 * element-overflow — content moved without per-element records) but
 * survives vanish- and pointer-driven fail-opens, which move nothing.
 * Transients — born (first record an add) AND gone within one window —
 * are dropped outright: they existed at neither gather boundary and
 * occlusion is only queried at boundaries.
 *
 * AUTHORITATIVE as of 2026-07-16: a reuse hit returns the cached verdict and
 * the fresh hit-test is skipped. Gated by the Phase-1 shadow soak — zero
 * divergence across 1,856 would-reuse verdicts (QuickBase interaction +
 * YouTube playback), with the cells/rect/epoch retest paths all exercised.
 * Reuse/retest attribution stays in lifecycleCounters (trail-visible via the
 * 5s PERF_REPORT). `bkOcclusionMemo: 'shadow'` re-enters shadow mode (the
 * decision is computed and counted, divergences firehose as
 * `occlusion_memo:diverged`, but the fresh test still runs and wins) — use
 * it to re-verify after changing any tap. `false` kills the memo entirely.
 */

import type { ElementWrapper } from '../scan/element-wrapper';
import { SAMPLE_FRACTIONS } from './occlusion';
import { peekCachedRect } from '../layout-cache';
import { lifecycleCounters, recordCpu } from '../debug/perf-counters';
import { firehoseStep } from '../debug/firehose';

const GRID = 8;
const CELL_COUNT = GRID * GRID;
// K: distinct queued elements per gather window before failing open to
// all-dirty. 16→32→128 (2026-07-16): overflow WIPES the vanish history
// (unresolved elements may have moved), and soak 2b showed overflow is the
// steady state for long inter-settle windows — Gmail's 2Hz tick queues ~4
// elements/sec, so K=32 blew inside any ~8s reading pause and localization
// never fired there. 128 covers ~30s windows; a resolve read is a
// clean-layout rect lookup, so even a full queue is ~sub-ms against the
// ~45-150ms full retest it avoids.
const QUEUED_ELEMENT_CAP = 128;
// Pointer taps are boundary-crossing events; settles run at ~100ms cadence
// while the pointer moves, so this is generous for one window.
const POINTER_POINT_CAP = 32;

// Kill switch (bkOcclusionMemo, denylist posture): default 'on'
// (authoritative), explicit false → 'off', 'shadow' → verify-only.
//
// SOAK BUILD: defaulting to 'shadow' while the transient-skip tap change
// re-verifies — flip back to 'on' on zero divergence. content.ts's flag
// mapping carries the same temporary default.
export type OcclusionMemoMode = 'off' | 'shadow' | 'on';
let memoMode: OcclusionMemoMode = 'shadow';

export function setOcclusionMemoMode(mode: OcclusionMemoMode): void {
  memoMode = mode;
}

export function getOcclusionMemoMode(): OcclusionMemoMode {
  return memoMode;
}

interface MemoEntry {
  result: boolean;
  rectKey: string;
  epoch: number;
}

// Per-wrapper cache. Keyed by the wrapper (not the element) so a fingerprint
// rebind — same wrapper, new element — naturally retests via the rect key,
// and entries die with their wrapper.
let entries = new WeakMap<ElementWrapper, MemoEntry>();

// Bumped once per consumed gather (occlusionMemoEndGather). An entry is
// reusable only if validated at epoch-1: a wrapper absent from a gather (its
// badge was hidden that settle) missed that window's dirty state, which was
// reset — its entry can't vouch for the interval.
let gatherEpoch = 1;

// Dirty state for the CURRENT inter-gather window. Boot starts all-dirty
// (fail open; cold entries always retest anyway, but be explicit).
let allDirty = true;
const dirtyCells = new Uint8Array(CELL_COUNT);
// Value = "queued as an ADDED node this window". An element that was added
// within the window and is gone again (disconnected or boxless) by resolve
// time existed at NEITHER gather boundary — occlusion is only ever queried
// at gathers, so such a transient cannot affect either answer and is
// skipped instead of failing the window open (Gmail's 2Hz tick swaps spans
// entirely between settles; this was its whole residual fail-open class).
const pendingElements = new Map<Element, boolean>();
const pendingPointer: number[] = []; // flat x,y pairs
// The cells each element occupied at its LAST resolve — the localization
// source for elements that have vanished by the time they resolve. Wiped
// when geometry shifts without per-element records (see
// occlusionMemoAllDirty's keepHistory rule).
let lastKnownCells = new WeakMap<Element, readonly number[]>();
// Viewport dims of the last resolve, for sample-point→cell mapping in the
// per-wrapper check (same values batch 3 samples against).
let resolvedVw = 0;
let resolvedVh = 0;

function bumpAllDirtyReason(reason: string): void {
  lifecycleCounters.occlusionMemoAllDirtyBy[reason] =
    (lifecycleCounters.occlusionMemoAllDirtyBy[reason] ?? 0) + 1;
}

/**
 * Fail open: everything retests at the next gather. Idempotent per window.
 *
 * The cell history survives IFF the reason can't have moved recorded
 * elements. Geometry-shifting reasons (scroll/resize/transform, unobserved
 * windows, element-overflow — where a history'd element may have moved
 * without resolving) must wipe: a stale recorded position later UNDER-marks
 * a vanish. A no-history vanish or a pointer-coordinate overflow moves
 * nothing, so keeping history there is what breaks the self-defeating loop
 * the first shadow round exposed (fail-open → wipe → next vanisher has no
 * history → fail-open again; vanishLocalized never fired).
 */
export function occlusionMemoAllDirty(reason: string, keepHistory = false): void {
  if (memoMode === 'off' || allDirty) return;
  allDirty = true;
  pendingElements.clear();
  pendingPointer.length = 0;
  if (!keepHistory) lastKnownCells = new WeakMap();
  bumpAllDirtyReason(reason);
}

// Own badges are pointer-events:none (invisible to elementFromPoint) so
// their churn can't change any verdict.
function isOwn(el: Element): boolean {
  return el.closest('[data-branchkit-hint]') !== null;
}

/** Queue an element whose mutation/restyle may have moved an occluder. Its
 * rect is resolved at the next gather (clean layout) and its cells marked.
 * `isAdd` marks childList-added nodes for the transient-skip rule (an
 * element born and gone within one window affects neither gather).
 * FIRST sighting wins, deliberately not an OR-merge: moving a connected
 * node emits its removal record BEFORE its addition (the DOM removes
 * first), so a reparented pre-existing element — whose old paint region
 * still matters — is first seen as a removal and stays unflagged; only an
 * element whose very first record is an add was born this window. A
 * born-this-window descendant first seen via a later attribute record
 * stays unflagged too — conservative (fails open instead of skipping). */
export function occlusionMemoNoteTarget(el: Element, isAdd = false): void {
  if (memoMode === 'off' || allDirty) return;
  if (isOwn(el)) return;
  if (!pendingElements.has(el)) pendingElements.set(el, isAdd);
  if (pendingElements.size > QUEUED_ELEMENT_CAP) occlusionMemoAllDirty('element-overflow');
}

/** MO batch tap (page MO foreign records + visibility MO records — the
 * visibility MO carries class/style, which the page MO's attributeFilter
 * excludes). Runs BEFORE the settle-relevance gates on purpose: a mutation
 * on an UNtracked overlay is irrelevant to the settle triggers but still
 * moves paint over tracked targets. */
export function occlusionMemoNoteMutations(records: MutationRecord[]): void {
  if (memoMode === 'off' || allDirty) return;
  for (const m of records) {
    if (m.type === 'childList') {
      // Adds occlude only at their CURRENT position (they didn't exist
      // before). Removals uncover their OLD position — queued too: the
      // resolve step localizes them via their last-known cells when we've
      // seen them in this clean-window streak, and fails open otherwise.
      for (const n of m.addedNodes) {
        if (n instanceof Element) occlusionMemoNoteTarget(n, true);
        if (allDirty) return;
      }
      for (const n of m.removedNodes) {
        if (n instanceof Element) occlusionMemoNoteTarget(n);
        if (allDirty) return;
      }
    } else if (m.target instanceof Element) {
      occlusionMemoNoteTarget(m.target);
      if (allDirty) return;
    }
  }
}

/** Pointer tap: event coordinates only, zero layout reads. Covers pure-CSS
 * :hover paints along the pointer path — the only signal for them. */
export function occlusionMemoNotePointer(x: number, y: number): void {
  if (memoMode === 'off' || allDirty) return;
  if (pendingPointer.length >= POINTER_POINT_CAP * 2) {
    occlusionMemoAllDirty('pointer-overflow', true); // coords lost, nothing moved
    return;
  }
  pendingPointer.push(x, y);
}

function cellIndex(x: number, y: number, vw: number, vh: number): number {
  const col = Math.min(GRID - 1, Math.max(0, Math.floor((x / vw) * GRID)));
  const row = Math.min(GRID - 1, Math.max(0, Math.floor((y / vh) * GRID)));
  return row * GRID + col;
}

// Pointer coords mark a 3×3 CELL NEIGHBORHOOD, not just the crossed cell.
// Soak 2b caught the hole live (tldraw, occlusion_memo:diverged
// false->true on a pointer-driven settle): a pure-CSS :hover paint —
// no record of any kind — extended into the cell NEXT to the one the
// pointer crossed. The neighborhood (~1/3 viewport span around the cursor
// on the 8×8 grid) bounds hover paints anchored near their trigger; the
// pointerover target element is queued separately for paints sized to the
// trigger's own box.
function markPoint(x: number, y: number, vw: number, vh: number): void {
  if (x < 0 || y < 0 || x > vw || y > vh) return;
  const col = Math.min(GRID - 1, Math.max(0, Math.floor((x / vw) * GRID)));
  const row = Math.min(GRID - 1, Math.max(0, Math.floor((y / vh) * GRID)));
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const rr = row + dr, cc = col + dc;
      if (rr < 0 || rr >= GRID || cc < 0 || cc >= GRID) continue;
      dirtyCells[rr * GRID + cc] = 1;
    }
  }
}

// Every cell the rect's viewport-clamped extent overlaps (null when the
// rect has no in-viewport area). Over-covering on boundary-straddling rects
// is conservative and fine.
function cellsOfRect(r: DOMRect, vw: number, vh: number): number[] | null {
  const left = Math.max(0, r.left);
  const top = Math.max(0, r.top);
  const right = Math.min(vw, r.right);
  const bottom = Math.min(vh, r.bottom);
  if (right <= left || bottom <= top) return null;
  const c0 = Math.min(GRID - 1, Math.floor((left / vw) * GRID));
  const c1 = Math.min(GRID - 1, Math.floor((right / vw) * GRID));
  const r0 = Math.min(GRID - 1, Math.floor((top / vh) * GRID));
  const r1 = Math.min(GRID - 1, Math.floor((bottom / vh) * GRID));
  const cells: number[] = [];
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) cells.push(row * GRID + col);
  }
  return cells;
}

function markCells(cells: readonly number[]): void {
  for (const c of cells) dirtyCells[c] = 1;
}

/**
 * Resolve the window's queued signals into dirty cells. Called from the
 * settle gather AFTER its read batches have forced layout clean, so each
 * queued element costs one clean-layout rect lookup (deduped through the
 * gather's warm layout cache; counted in occlusionMemo:size:resolveReads).
 *
 * A queued element that is disconnected, zero-box, or fully off-viewport
 * HID or LEFT since it was queued (closed dropdown, removed row,
 * display:none'd overlay). If it resolved during this clean-window streak
 * its last-known cells localize the uncovered region
 * (occlusionMemoVanishLocalized); with no history the whole window fails
 * open — the old position is unknowable. A connected element that MOVED
 * marks old ∪ new cells for the same reason.
 */
export function occlusionMemoResolveDirty(vw: number, vh: number): void {
  if (memoMode === 'off') return;
  resolvedVw = vw;
  resolvedVh = vh;
  if (allDirty) return; // queues were cleared when the window failed open
  for (let i = 0; i < pendingPointer.length; i += 2) {
    markPoint(pendingPointer[i], pendingPointer[i + 1], vw, vh);
  }
  pendingPointer.length = 0;
  let reads = 0;
  let sawNoHistoryVanish = false;
  // Resolve EVERY queued element even once a no-history vanish has doomed
  // the window: the point of continuing is the history writes — they are
  // what let the NEXT window's vanishes localize (warm-cache reads, cheap).
  for (const [el, addedThisWindow] of pendingElements) {
    let r: DOMRect | null = null;
    if (el.isConnected) {
      r = peekCachedRect(el);
      if (r === null) {
        try {
          r = el.getBoundingClientRect();
          reads++;
        } catch { r = null; }
      }
    }
    const cells = r !== null && r.width >= 1 && r.height >= 1
      ? cellsOfRect(r, vw, vh)
      : null;
    const known = lastKnownCells.get(el);
    if (cells !== null) {
      markCells(cells);
      if (known) markCells(known); // moved: its old cells are uncovered
      lastKnownCells.set(el, cells);
    } else if (known) {
      markCells(known);
      lastKnownCells.delete(el);
      lifecycleCounters.occlusionMemoVanishLocalized++;
    } else if (addedThisWindow) {
      // Born after the previous gather, gone (or boxless) before this one:
      // it existed at neither boundary, and occlusion is only queried at
      // boundaries — a pure transient, nothing to invalidate.
      lifecycleCounters.occlusionMemoTransientDrops++;
    } else {
      sawNoHistoryVanish = true;
    }
  }
  pendingElements.clear();
  if (reads > 0) recordCpu('occlusionMemo:size:resolveReads', reads);
  // After the loop (not mid-iteration): fail the window open, but keep the
  // history just written — a vanish moves nothing else.
  if (sawNoHistoryVanish) occlusionMemoAllDirty('resolve-vanished', true);
}

// Reuse requires the cells under the wrapper's SAMPLE POINTS clean — cell
// membership of the 5 probe points, not the whole rect (an off-viewport
// point never probes, so its cell can't matter).
function sampleCellsDirty(r: DOMRect): boolean {
  for (const [fx, fy] of SAMPLE_FRACTIONS) {
    const x = r.left + r.width * fx;
    const y = r.top + r.height * fy;
    if (x < 0 || y < 0 || x > resolvedVw || y > resolvedVh) continue;
    if (dirtyCells[cellIndex(x, y, resolvedVw, resolvedVh)]) return true;
  }
  return false;
}

function ident(el: Element): string {
  const cls = el.classList.length > 0 ? `.${el.classList[0]}` : '';
  return `${el.tagName.toLowerCase()}${cls}`.slice(0, 48);
}

function rectKeyOf(rect: DOMRect): string {
  return `${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)},${Math.round(rect.height)}`;
}

/**
 * The reuse decision for one wrapper in gather batch 3, with retest
 * attribution counted. `rect` is the batch-2 visual-box rect — the exact
 * surface the hit-test samples. Returns the cached verdict on a hit, null
 * when a fresh test is needed (the caller then stores it via
 * `occlusionMemoStore`). A hit revalidates the entry's epoch, so
 * consecutive clean gathers keep reusing.
 *
 * In authoritative mode the caller SKIPS the fresh test on a hit; in shadow
 * mode it runs the fresh test regardless and passes this hit into
 * `occlusionMemoStore`, which counts/firehoses any divergence.
 */
export function occlusionMemoLookup(w: ElementWrapper, rect: DOMRect): { value: boolean } | null {
  if (memoMode === 'off') return null;
  const entry = entries.get(w);
  if (allDirty) {
    lifecycleCounters.occlusionMemoRetestAllDirty++;
  } else if (!entry) {
    lifecycleCounters.occlusionMemoRetestCold++;
  } else if (entry.epoch !== gatherEpoch - 1) {
    lifecycleCounters.occlusionMemoRetestEpoch++;
  } else if (entry.rectKey !== rectKeyOf(rect)) {
    lifecycleCounters.occlusionMemoRetestRect++;
  } else if (sampleCellsDirty(rect)) {
    lifecycleCounters.occlusionMemoRetestCells++;
  } else {
    lifecycleCounters.occlusionMemoReuse++;
    entry.epoch = gatherEpoch;
    return { value: entry.result };
  }
  return null;
}

/**
 * Store a fresh hit-test result. `shadowHit` is non-null only in shadow mode
 * when the lookup said "reusable" — a disagreement there means a signal is
 * missing a tap. Direction names the class: false->true = an occluder
 * appeared with no signal (untapped reveal path?); true->false = one left
 * with no signal (in-viewport slide-away?). Correlate with
 * mo_target/vismo_target steps in the same window to name the writer.
 */
export function occlusionMemoStore(
  w: ElementWrapper, rect: DOMRect, fresh: boolean,
  shadowHit: { value: boolean } | null = null,
): void {
  if (memoMode === 'off') return;
  if (shadowHit !== null && shadowHit.value !== fresh) {
    lifecycleCounters.occlusionMemoDiverged++;
    firehoseStep(`occlusion_memo:diverged:${shadowHit.value}->${fresh}:${ident(w.element)}`, 1);
  }
  const entry = entries.get(w);
  if (entry) {
    entry.result = fresh;
    entry.rectKey = rectKeyOf(rect);
    entry.epoch = gatherEpoch;
  } else {
    entries.set(w, { result: fresh, rectKey: rectKeyOf(rect), epoch: gatherEpoch });
  }
}

/** Consume the window: the gather validated (or retested) everything it
 * cares about against the accumulated dirt, so reset it and open the next
 * epoch. Only called when batch 3 actually ran over a nonempty set. */
export function occlusionMemoEndGather(): void {
  if (memoMode === 'off') return;
  dirtyCells.fill(0);
  allDirty = false;
  gatherEpoch++;
}

/** Test seam: full state reset between cases. */
export function _resetOcclusionMemoForTests(): void {
  entries = new WeakMap();
  gatherEpoch = 1;
  allDirty = true;
  dirtyCells.fill(0);
  pendingElements.clear();
  pendingPointer.length = 0;
  lastKnownCells = new WeakMap();
  resolvedVw = 0;
  resolvedVh = 0;
  memoMode = 'on';
}
