/**
 * BranchKit Browser — hint occlusion detection (hit-test).
 *
 * Subcase 2 of notes/DESIGN_HINT_OCCLUSION_FILTERING.md ("same-stacking-context
 * invisibility"): a target is present in the DOM with valid geometry — so the
 * CSS `isVisible()` check passes — but another element is painted on top of it
 * (an overlay, a scrolled-in layer, an `overflow:hidden`+`max-height:0` collapse
 * clipping it). Because badges are body-mounted at max z-index, they paint ABOVE
 * the covering layer → "ghost" badges floating on targets the user can't see.
 *
 * Detection is `document.elementFromPoint` hit-tests at several points across the
 * target (center + four interior corners), mirroring Link Hints. The target is
 * occluded when a MAJORITY of the in-viewport sample points are covered by
 * something other than the target (or its own ancestor/descendant — same visible
 * thing). Multi-point beats center-only on PARTIAL occlusion: an overlay that
 * covers most of the box but leaves the center in a visible sliver (the QuickBase
 * sidebar case) is caught by the corner samples. `opacity:0` ancestors still
 * receive hit-tests, so a hover-revealed control (always-mode) stays NOT occluded.
 *
 * Flag-gated (`bkOcclusion`, default ON — content.ts reads storage, only an
 * explicit false disables) and consumed by two layers: the visual pass hides
 * occluded badges, and the strict-viewport computation drops them so voice
 * can't match a hidden target.
 */

import type { ElementWrapper } from '../scan/element-wrapper';
import { effectiveVisualBox } from '../scan/scanner';

let occlusionEnabled = false;

// Phase-0 cost decomposition (notes/DESIGN_OCCLUSION_HITTEST_MEMO.md): true
// elementFromPoint call count. Element count ≠ probe count — off-viewport
// sample points skip the call and the majority vote early-exits — so the
// memoization decision needs the real number. Drained by the settle gather
// around read batch 3.
let efpCalls = 0;
export function drainElementFromPointCalls(): number {
  const n = efpCalls;
  efpCalls = 0;
  return n;
}

export function setOcclusionEnabled(enabled: boolean): void {
  occlusionEnabled = enabled;
}

// (The wrapper-flag fold — applyOcclusion(w) writing w.occluded from
// w.overlayCovered || w.clipped — is gone: DESIGN_OBSERVED_STATE_READ_TIME
// phase 2. The badge owns the applied fold (HintBadge.applyOcclusion, called
// by the settle applier with the fresh gather verdict and by the clip IO with
// the fresh clip signal); fact consumers derive occlusion where they use it —
// the plan from the gather map, the strict stamp and the dispatch gate via
// `isOccludedLive` below.)

export function isOcclusionEnabled(): boolean {
  return occlusionEnabled;
}

/**
 * Live effective-occlusion read for the out-of-settle consumers (the strict
 * stamp's batch-send path, the sealed dispatch gate): the fresh overlay
 * hit-test (flag-gated; ≤5 elementFromPoint calls, ~25µs each on the live
 * trail) OR'd with the wrapper's clip signal — `clipped` is the clip IO's
 * own continuously-maintained state (single writer, cleared on unobserve,
 * membership reconciled per settle), not a stored copy of anything.
 */
export function isOccludedLive(w: ElementWrapper): boolean {
  if (w.clipped) return true;
  if (!occlusionEnabled) return false;
  try { return isOccluded(w.element); } catch { return true; }
}

/**
 * Shadow-including (composed-tree) containment. `Node.contains` stops at
 * shadow boundaries, so for a target inside a shadow root a document-level
 * `elementFromPoint` hit — which returns the shadow HOST, not the shadow
 * content — would read as "unrelated element on top" and every shadow-hosted
 * target would be judged occluded. Climb from `node` through its shadow
 * hosts and ask `contains` at each light-tree level.
 */
export function composedContains(ancestor: Element, node: Element): boolean {
  let cur: Node | null = node;
  while (cur) {
    if (ancestor.contains(cur)) return true;
    const root = cur.getRootNode();
    cur = root instanceof ShadowRoot ? root.host : null;
  }
  return false;
}

/**
 * A fully transparent element is HIT-TESTABLE without being VISIBLE — the
 * stretched opacity:0 file input over a styled dropzone button is the
 * canonical case (also drag-target overlays and custom-upload patterns).
 * Occlusion is a visual judgment — voice activation dispatches synthetic
 * events directly on the target, so click-interception by an invisible
 * layer doesn't make the target unusable — and an invisible cover isn't a
 * cover. Own opacity plus a bounded ancestor climb (an opacity:0 ancestor
 * makes the whole subtree invisible while still hit-testable);
 * visibility:hidden hits never reach here (elementFromPoint skips them).
 *
 * Deliberately NOT extended to transparent BACKGROUNDS (e.g. Bootstrap's
 * stretched-link ::after): the hit element may paint text or children
 * elsewhere in its box, and per-point paint transparency isn't knowable
 * from computed style — those stay occluders.
 */
const TRANSPARENT_CLIMB_BOUND = 5;
function isEffectivelyTransparent(el: Element): boolean {
  let cur: Element | null = el;
  for (let depth = 0; cur && depth < TRANSPARENT_CLIMB_BOUND; depth++, cur = cur.parentElement) {
    try {
      if (getComputedStyle(cur).opacity === '0') return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Pure decision: given a target and whatever `elementFromPoint` returned at the
 * target's center, is the target occluded by something else?
 *
 * - `null` hit → the point is off-viewport or fell in a gap; DEFER (treat as not
 *   occluded) rather than hide a badge we can't reason about.
 * - hit IS the target, or the target's own descendant (its visible text/icon),
 *   or an ancestor that wraps the target (e.g. the target is a `<span>` inside
 *   the `<a>` we hit) → same visible element, NOT occluded. Containment is
 *   composed-tree in both directions: a hit on the target's shadow host (the
 *   only thing document-level elementFromPoint can return for shadow content)
 *   is the target's own ancestor, and a hit inside the target's shadow tree is
 *   its own content.
 * - a fully transparent hit (opacity:0, own or inherited) → invisible, can't
 *   visually cover anything → NOT occluded.
 * - anything else painted on top → occluded.
 */
export function isHitOccluding(target: Element, hit: Element | null): boolean {
  if (!hit) return false;
  if (hit === target) return false;
  if (composedContains(target, hit)) return false;
  if (composedContains(hit, target)) return false;
  if (isEffectivelyTransparent(hit)) return false;
  return true;
}

// Sample points as fractions of the target's box. Center + four interior corners,
// inset to 0.2/0.8 so they probe the box's extent without landing on a border or
// an adjacent element. A point off the viewport hit-tests to null (counts as
// not-covered) — a partially-off-viewport target won't be aggressively hidden.
// Exported for the memoization layer (occlusion-memo): the reuse decision
// checks dirty-cell membership of exactly these probe points.
export const SAMPLE_FRACTIONS: ReadonlyArray<readonly [number, number]> = [
  [0.5, 0.5],
  [0.2, 0.2],
  [0.8, 0.2],
  [0.2, 0.8],
  [0.8, 0.8],
];
const OCCLUDED_MAJORITY = 3; // of SAMPLE_FRACTIONS.length (5)

/**
 * Hit-test several points across a target to decide if it's visually covered.
 * Occluded when a majority of the sample points are covered by another element.
 * Returns false when the flag is off or the target has no area. Up to 5
 * synchronous `elementFromPoint` reads (early-exits once the majority is decided,
 * so typically 3–4); callers must gate to the visible set and debounce (see
 * `reconcileOcclusion`).
 */
export function isOccluded(el: Element): boolean {
  if (!occlusionEnabled) return false;
  // Judge the control's visual box, not the raw element: an autosized
  // combobox <input> is ~2px wide and sits UNDER its own placeholder/value
  // chips — siblings, so the ancestor/descendant exemption can't clear them
  // and the widget would occlude itself. Sampling the box makes the
  // widget's own content exempt (descendants) while a real overlay covering
  // the box still occludes. Same surface isVisible's size carve-out uses.
  el = effectiveVisualBox(el);
  let r: DOMRect;
  try {
    r = el.getBoundingClientRect();
  } catch {
    return false;
  }
  return isOccludedBox(el, r);
}

/**
 * The wrapper's visual-box ELEMENT, cached — it is stable per wrapper
 * (effectiveVisualBox climbs to the same ancestor every time for a tiny
 * control, and is the identity for everything else), so the settle gather
 * resolves it once and folds its rect read into batch 2 instead of paying a
 * fresh gBCR inside every batch-3 hit-test. Entries die with the wrapper; a
 * rebind (same wrapper, new element) or a DOM restructure that orphans the
 * cached box from its control re-resolves via the containment guard.
 */
const visualBoxCache = new WeakMap<ElementWrapper, Element>();

export function visualBoxFor(w: ElementWrapper): Element {
  let box = visualBoxCache.get(w);
  if (box && box !== w.element && !box.contains(w.element)) box = undefined;
  if (!box) {
    box = effectiveVisualBox(w.element);
    visualBoxCache.set(w, box);
  }
  return box;
}

/**
 * The sampling core of `isOccluded`, with the visual box already resolved
 * and its rect already read (the settle gather reads it in batch 2 — the
 * fold that removes the duplicate per-wrapper gBCR batch 3 used to pay).
 */
export function isOccludedBox(el: Element, r: DOMRect): boolean {
  if (!occlusionEnabled) return false;
  if (r.width < 1 || r.height < 1) return false;
  const doc = el.ownerDocument;
  if (!doc) return false;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let covered = 0;
  let checked = 0;
  for (const [fx, fy] of SAMPLE_FRACTIONS) {
    checked++;
    const x = r.left + r.width * fx;
    const y = r.top + r.height * fy;
    // Off-viewport points hit-test to null → not-covered (don't hide a target
    // that's partly scrolled past the viewport edge).
    const inViewport = x >= 0 && y >= 0 && x <= vw && y <= vh;
    if (inViewport) efpCalls++;
    const hit = inViewport ? doc.elementFromPoint(x, y) : null;
    if (isHitOccluding(el, hit)) covered++;
    if (covered >= OCCLUDED_MAJORITY) return true;
    // Once enough points are confirmed NOT covered, a majority is impossible.
    if (checked - covered >= SAMPLE_FRACTIONS.length - OCCLUDED_MAJORITY + 1) return false;
  }
  return covered >= OCCLUDED_MAJORITY;
}
