/**
 * BranchKit Browser — the settle pass's batched read phase (GATHER).
 *
 * Phase B of notes/DESIGN_UNIFIED_RECONCILER.md: one read pass per settle,
 * shared by the three settle steps that previously each swept their own
 * overlapping slice of the store with fresh layout reads —
 * `reconcileTeardown` (band check over hinted + never-hinted candidates),
 * `collectStrictViewportDelta` (strict check over the codeworded set), and
 * `recheckHintedVisibility` (CSS visibility over the hinted in-viewport set).
 *
 * Discipline (the wedge guard, inherited from reconcileTeardown):
 *   - Bounded sets only — hinted, codeworded, and codeword-less stale-FALSE
 *     candidates. Never a full-store rect sweep over arbitrary wrappers.
 *   - Fresh geometry, gathered once, never cached across settles. The first
 *     gBCR pays the (single) forced reflow; every read after it is a
 *     clean-layout lookup. The global layout cache is used only inside this
 *     call and cleared before returning.
 *   - Read-all-then-act: the snapshot is taken before any settle step writes,
 *     so a layout read never interleaves with a write.
 *
 * Consumers treat the snapshot as a read cache with live fallback: a wrapper
 * missing from a map (e.g. it gained eligibility mid-pipeline via teardown's
 * stale-FALSE repair) falls back to the step's legacy read. The snapshot is
 * also the shape the plan computation consumes in Phase C.
 */

import { ElementWrapper } from '../scan/element-wrapper';
import { isVisible } from '../scan/scanner';
import { cacheVisibility, clearLayoutCache, peekCachedRect } from '../layout-cache';
import { isAncestorChainInVisibleViewport } from './strict-viewport';
import { isOccluded, isOcclusionEnabled } from '../observe/occlusion';
import { recordCpu } from '../debug/perf-counters';

export interface SettleGather {
  /** Viewport dimensions at gather time. */
  vw: number;
  vh: number;
  /** One frame-ancestor-chain visibility check, shared by the strict step
   * (it is per-frame, not per-wrapper). */
  ancestorChainVisible: boolean;
  /** Fresh viewport-relative target rect per wrapper in the union of the
   * three steps' bounded sets. A missing entry means the read threw
   * (detached mid-read) — consumers fall back to their own read. */
  rects: Map<ElementWrapper, DOMRect>;
  /** isVisible() per hinted in-viewport wrapper, resolved against the same
   * batched style read. */
  cssVisible: Map<ElementWrapper, boolean>;
  /** Occlusion hit-test results (apply cutover 4/4) over the visible in-band
   * badge set — the elementFromPoint reads the occlusion step used to take
   * itself. Empty when the bkOcclusion flag is off. Limbo wrappers are
   * excluded (they hold their state by design; the old step could hit-test a
   * connected limbo survivor — a deliberate micro-divergence). */
  overlayCovered: Map<ElementWrapper, boolean>;
}

/**
 * One batched layout read over the settle steps' bounded sets. Set
 * enumeration involves no layout reads; the reads happen in two batches —
 * `cacheVisibility` for the visibility set (seed rects + ancestor-chain
 * styles, deduped) and direct gBCR for the remaining rect-set members.
 */
export function gatherSettleReads(wrappers: readonly ElementWrapper[]): SettleGather {
  const __cpuStart = performance.now();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Enumerate the bounded sets (flags only, no layout):
  //   rect set  = teardown's hinted set (hint, live)
  //             ∪ teardown's never-hinted stale-FALSE candidates
  //               (no hint, flag out, no codeword, connected)
  //             ∪ strict's codeworded set
  //   vis set   = recheck's hinted in-viewport set (⊆ hinted)
  //             ∪ the plan's build candidates (codeworded, badge not
  //               showing) — the answer to the design note's open question:
  //               measured live, the plan otherwise pays ~30 unbatched
  //               cssVisible reads per settle for the claim-gap set
  //               (reconcilePlan:size:lazyReads tripwire). Dormant badges
  //               WITHOUT a codeword stay out — style-reading the whole
  //               scroll-history set every settle is the cost the dormancy
  //               design avoids; the plan lazy-reads those only in the rare
  //               stale-FALSE repair case.
  const rectSet: ElementWrapper[] = [];
  const visSet: ElementWrapper[] = [];
  const occlusionSet: ElementWrapper[] = [];
  const occlusionOn = isOcclusionEnabled();
  for (const w of wrappers) {
    if (w.disconnectedAt !== null) continue;
    const hinted = w.hint !== null;
    const codeworded = w.scanned.codeword.length > 0;
    const unhintedCandidate = !hinted && !w.isInViewport &&
      !codeworded && w.element.isConnected;
    if (hinted || unhintedCandidate || codeworded) {
      rectSet.push(w);
    }
    const recheckMember = hinted && w.isInViewport;
    const buildCandidate = codeworded && !(w.hint?.isVisible ?? false);
    if ((recheckMember || buildCandidate) && w.element.isConnected) visSet.push(w);
    if (occlusionOn && w.hint?.isVisible && w.isInViewport && w.element.isConnected) {
      occlusionSet.push(w);
    }
  }

  const ancestorChainVisible = isAncestorChainInVisibleViewport(window);

  // Read batch 1: seed rects + ancestor styles for the visibility set.
  const counts = cacheVisibility(visSet.map(w => w.element));
  let rectReads = counts.rects;

  // Read batch 2: rects for the rest of the rect set (vis-set members come
  // out of the warm cache).
  const rects = new Map<ElementWrapper, DOMRect>();
  for (const w of rectSet) {
    const cached = peekCachedRect(w.element);
    if (cached) { rects.set(w, cached); continue; }
    try {
      rects.set(w, w.element.getBoundingClientRect());
      rectReads++;
    } catch { /* detached mid-read — consumer falls back */ }
  }

  // Resolve CSS visibility against the warm cache (style reads were batch 1).
  const cssVisible = new Map<ElementWrapper, boolean>();
  for (const w of visSet) cssVisible.set(w, isVisible(w.element));

  // Read batch 3: occlusion hit-tests over the visible badge set. Pure reads
  // (elementFromPoint + the target rect), still against clean layout.
  const overlayCovered = new Map<ElementWrapper, boolean>();
  for (const w of occlusionSet) overlayCovered.set(w, isOccluded(w.element));

  clearLayoutCache();

  // Count-overloaded buckets (the :size: convention): the budget evidence the
  // design note asks for — live layout reads per settle, post-consolidation.
  recordCpu('settleGather:size:gbcr', rectReads);
  recordCpu('settleGather:size:gcs', counts.styles);
  if (occlusionSet.length > 0) recordCpu('settleGather:size:hitTests', occlusionSet.length);
  recordCpu('settleGather', performance.now() - __cpuStart);

  return { vw, vh, ancestorChainVisible, rects, cssVisible, overlayCovered };
}
