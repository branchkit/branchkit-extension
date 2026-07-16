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
 *   - page MO + visibility MO batches → queue mutated elements (≤K distinct;
 *     bigger, the huge path, or the manual-deferred path → all-dirty)
 *   - childList REMOVALS → all-dirty (the removed occluder's old position is
 *     unknowable once it's out of the DOM — fail open)
 *   - pointerover/pointerout → mark the cell under the event coordinates.
 *     The load-bearing novelty: pure-CSS :hover paints produce NO observer
 *     record of any kind — only the pointer position knows.
 *   - scroll / resize / transform-ancestor → all-dirty (targets move anyway)
 *   - focusin/focusout, transitionend/animationend → queue the event target
 *     (:focus-within can restyle with no record)
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
// all-dirty. Start 16 (design note open question — revisit with the shadow
// counters' retest attribution).
const QUEUED_ELEMENT_CAP = 16;
// Pointer taps are boundary-crossing events; settles run at ~100ms cadence
// while the pointer moves, so this is generous for one window.
const POINTER_POINT_CAP = 32;

// Kill switch (bkOcclusionMemo, denylist posture): default 'on'
// (authoritative), explicit false → 'off', 'shadow' → verify-only.
export type OcclusionMemoMode = 'off' | 'shadow' | 'on';
let memoMode: OcclusionMemoMode = 'on';

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
const pendingElements = new Set<Element>();
const pendingPointer: number[] = []; // flat x,y pairs
// Viewport dims of the last resolve, for sample-point→cell mapping in the
// per-wrapper check (same values batch 3 samples against).
let resolvedVw = 0;
let resolvedVh = 0;

function bumpAllDirtyReason(reason: string): void {
  lifecycleCounters.occlusionMemoAllDirtyBy[reason] =
    (lifecycleCounters.occlusionMemoAllDirtyBy[reason] ?? 0) + 1;
}

/** Fail open: everything retests at the next gather. Idempotent per window. */
export function occlusionMemoAllDirty(reason: string): void {
  if (memoMode === 'off' || allDirty) return;
  allDirty = true;
  pendingElements.clear();
  pendingPointer.length = 0;
  bumpAllDirtyReason(reason);
}

// Own badges are pointer-events:none (invisible to elementFromPoint) so
// their churn can't change any verdict.
function isOwn(el: Element): boolean {
  return el.closest('[data-branchkit-hint]') !== null;
}

/** Queue an element whose mutation/restyle may have moved an occluder. Its
 * rect is resolved at the next gather (clean layout) and its cells marked. */
export function occlusionMemoNoteTarget(el: Element): void {
  if (memoMode === 'off' || allDirty) return;
  if (isOwn(el)) return;
  pendingElements.add(el);
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
      // before) — queue for localized marking. Removals uncover their OLD
      // position, which is unreadable once they're out of the DOM: fail open.
      for (const n of m.removedNodes) {
        if (n instanceof Element && !isOwn(n)) {
          occlusionMemoAllDirty('removal');
          return;
        }
      }
      for (const n of m.addedNodes) {
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
    occlusionMemoAllDirty('pointer-overflow');
    return;
  }
  pendingPointer.push(x, y);
}

function cellIndex(x: number, y: number, vw: number, vh: number): number {
  const col = Math.min(GRID - 1, Math.max(0, Math.floor((x / vw) * GRID)));
  const row = Math.min(GRID - 1, Math.max(0, Math.floor((y / vh) * GRID)));
  return row * GRID + col;
}

function markPoint(x: number, y: number, vw: number, vh: number): void {
  if (x < 0 || y < 0 || x > vw || y > vh) return;
  dirtyCells[cellIndex(x, y, vw, vh)] = 1;
}

// Mark every cell the rect's viewport-clamped extent overlaps. Over-marking
// (boundary-straddling rects) is conservative and fine.
function markRect(r: DOMRect, vw: number, vh: number): void {
  const left = Math.max(0, r.left);
  const top = Math.max(0, r.top);
  const right = Math.min(vw, r.right);
  const bottom = Math.min(vh, r.bottom);
  if (right <= left || bottom <= top) return;
  const c0 = Math.min(GRID - 1, Math.floor((left / vw) * GRID));
  const c1 = Math.min(GRID - 1, Math.floor((right / vw) * GRID));
  const r0 = Math.min(GRID - 1, Math.floor((top / vh) * GRID));
  const r1 = Math.min(GRID - 1, Math.floor((bottom / vh) * GRID));
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) dirtyCells[row * GRID + col] = 1;
  }
}

/**
 * Resolve the window's queued signals into dirty cells. Called from the
 * settle gather AFTER its read batches have forced layout clean, so each
 * queued element costs one clean-layout rect lookup (deduped through the
 * gather's warm layout cache; counted in occlusionMemo:size:resolveReads).
 *
 * Fail-open cases: a queued element that is disconnected, zero-box, or fully
 * off-viewport HID or LEFT since it was queued — its old position (where it
 * may have uncovered a target) is unknowable, so the whole window goes
 * all-dirty. This is what makes display:none / removal / slide-out of
 * occluders sound; the residual gap is an occluder slid to a DIFFERENT
 * in-viewport position by a style write (new cells marked, old cells not) —
 * shadow-mode divergence is the meter for whether that happens in practice.
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
  for (const el of pendingElements) {
    if (!el.isConnected) {
      occlusionMemoAllDirty('resolve-disconnected');
      break;
    }
    let r = peekCachedRect(el);
    if (r === null) {
      try {
        r = el.getBoundingClientRect();
        reads++;
      } catch {
        occlusionMemoAllDirty('resolve-throw');
        break;
      }
    }
    if (r.width < 1 || r.height < 1 ||
        r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) {
      occlusionMemoAllDirty('resolve-vanished');
      break;
    }
    markRect(r, vw, vh);
  }
  pendingElements.clear();
  if (reads > 0) recordCpu('occlusionMemo:size:resolveReads', reads);
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
  resolvedVw = 0;
  resolvedVh = 0;
  memoMode = 'on';
}
