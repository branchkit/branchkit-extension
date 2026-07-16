/**
 * Module-level coordination for the inner-scroll accelerator
 * (notes/DESIGN_INNER_SCROLL_ACCELERATOR.md): the enable flags, the live-badge
 * registry, and the level-triggered re-detection entry points the settle/scroll
 * handlers call. The per-badge mechanics (arm/disarm/chain-sync) live on
 * HintBadge; the ScrollTimeline plumbing lives in scroll-accel.ts.
 */

import { isScrollTimelineSupported } from './scroll-accel';

/** The slice of HintBadge the glue drives. Kept as a structural interface so
 *  this module doesn't import the badge class. */
export interface ScrollAccelReconcilable {
  syncScrollAccel(): void;
  syncScrollAccelInside(scroller: Element): void;
  // Re-evaluate transform-ancestor tracking against the current bkTransformTrigger
  // flag (arm if newly on, disarm if newly off). Lets a live flag flip take
  // effect without a page reload. Unrelated to the accelerator, but reuses this
  // module's live-badge registry.
  syncTransformTracker(): void;
}

// Inner-scroll accelerator gate. Production default is ON, set at
// content-script init from the `bkScrollAccel` flag (only an explicit `false`
// disables it). This module ref initializes false as a pre-read safety value —
// off until that init read confirms — so a badge built before the storage read
// doesn't arm prematurely; it re-arms on its next show()/updatePosition once
// the flag resolves. A mutable ref so the flag propagates without re-wiring
// callers.
let scrollAccelEnabled = false;

export function setScrollAccelEnabled(enabled: boolean): void {
  // Feature-detect folded into the setter (long-session review backlog): the
  // Firefox re-arm loop happened because a caller could enable the flag on an
  // engine with no ScrollTimeline ctor. content.ts ANDs at the call site too,
  // but the setter is the altitude where a future caller can't bypass it.
  scrollAccelEnabled = enabled && isScrollTimelineSupported();
}

export function isScrollAccelEnabled(): boolean {
  return scrollAccelEnabled;
}

// Nested-scroller support for the accelerator: ride the WHOLE chain of scroller
// ancestors (composed additive ScrollTimelines), not just the nearest. Fixes the
// wiggle when an OUTER overflow ancestor scrolls a target that lives in an inner
// pane (the QuickBase report-in-#mainBodyDiv case). Default ON, set from the
// `bkScrollAccelNested` flag in content.ts (only an explicit `false` disables).
// The multi-scroller path relies on `composite: 'add'`, verified by the nested
// integration test. This module ref initializes false as a pre-read safety value.
let scrollAccelNestedEnabled = false;

export function setScrollAccelNestedEnabled(enabled: boolean): void {
  if (scrollAccelNestedEnabled === enabled) return;
  scrollAccelNestedEnabled = enabled;
  // Re-detect every live badge's chain so a flag flip (or a late flag read)
  // takes effect without waiting for each badge to be re-shown.
  for (const b of liveBadges) b.syncScrollAccel();
}

export function isScrollAccelNestedEnabled(): boolean {
  return scrollAccelNestedEnabled;
}

// Registry of live badges, so the accelerator can be re-detected
// level-triggered (a scroller that became scrollable after a badge first armed,
// a chain that grew/shrank, or a flag flip) instead of only edge-triggered at
// show time. Added in the HintBadge constructor, removed in remove().
const liveBadges = new Set<ScrollAccelReconcilable>();

export function registerScrollAccelBadge(b: ScrollAccelReconcilable): void {
  liveBadges.add(b);
}

export function unregisterScrollAccelBadge(b: ScrollAccelReconcilable): void {
  liveBadges.delete(b);
}

/** Re-detect the accelerator chain for every visible live badge. Called from the
 *  settle handlers so arming is level-triggered: a badge whose scroller wasn't
 *  scrollable yet at show time (content still loading) gets accelerated once it
 *  is, and a chain that changed is rebuilt. No-op when the flag is off. */
export function reconcileScrollAccel(): void {
  if (!scrollAccelEnabled) return;
  for (const b of liveBadges) b.syncScrollAccel();
}

/** Scoped variant of `reconcileScrollAccel`: re-detect only badges whose target
 *  lives inside `scroller`. Called from the scroll handler at gesture START with
 *  the element that just scrolled. A scroller that only becomes scrollable on
 *  pointer hover (QuickBase classic report grids flip overflow:hidden->auto under
 *  :hover) emits no mutation and — with overlay scrollbars — no reflow, so the
 *  settle-time `reconcileScrollAccel` hasn't armed it when the gesture begins.
 *  Re-detecting the moment that scroller first scrolls rides it from the first
 *  frame instead of after the ~100ms settle, killing the first-gesture chase.
 *  Scoped to the scrolled subtree so the common case (window / already-ridden
 *  page scroller) costs one cheap `contains` check per badge, no layout reads. */
export function reconcileScrollAccelForScroller(scroller: Element): void {
  if (!scrollAccelEnabled) return;
  for (const b of liveBadges) b.syncScrollAccelInside(scroller);
}

/** Re-evaluate transform-ancestor tracking for every live badge — called on a
 *  live `bkTransformTrigger` flag flip so testing takes effect without a reload.
 *  Each badge arms or disarms per the (already-updated) flag. */
export function reconcileTransformTrigger(): void {
  for (const b of liveBadges) b.syncTransformTracker();
}

export function sameElements(a: readonly Element[], b: readonly Element[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Short `tag#id.class.class` descriptor for a scroller, for the debug snapshot's
 *  per-layer accelerator chain. Diagnostic-only. */
export function describeScroller(el: Element): string {
  const id = el.id ? `#${el.id}` : '';
  const cls = typeof el.className === 'string' && el.className
    ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
    : '';
  return `${el.tagName.toLowerCase()}${id}${cls}`;
}
