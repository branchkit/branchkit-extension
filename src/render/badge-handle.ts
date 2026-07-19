/**
 * BadgeHandle — the structural badge surface the rest of the extension drives.
 *
 * Step 0 of notes/DESIGN_SETTLE_ENGINE_EXTRACTION.md: `ElementWrapper.hint` is
 * typed as this interface (not the concrete HintBadge class), so the settle
 * engine's unit tests can substitute a FakeBadge that records calls instead of
 * building shadow DOM. HintBadge `implements BadgeHandle`; this file is a leaf
 * (type-only imports) so neither scan/ nor render/ gains an import cycle.
 *
 * The member set is exactly the union of `.hint.<member>` uses across src/ —
 * do not add members speculatively; a member belongs here only when a
 * collaborator outside render/hints.ts calls it. (Same pattern as
 * scroll-accel-glue's AccelBadge slice.)
 */

import type { BadgeDisplayMode } from '../types';
import type { LabelAssignment } from '../labels/words';

/** Forensic snapshot of a badge's positioning state (debug-snapshot only).
 *  Extracted from the HintBadge diagnostics getter's inline literal. */
export interface BadgeDiagnostics {
  innerRect: { x: number; y: number; w: number; h: number };
  outerRect: { x: number; y: number; w: number; h: number };
  anchorParentRect: { x: number; y: number; w: number; h: number };
  anchorParentScroll: { top: number; left: number; width: number; height: number };
  anchorParentOverflow: { x: string; y: string };
  anchorParentTag: string;
  anchorParentClasses: string;
  displayedAs: string;
  targetTag: string;
  // Reconcile-model forensics (the live positioning model). `reconcileOffset`
  // is the baked candidate-minus-target offset the reconciler applies each
  // pass; a scroll-back-stranded badge typically shows a stale offset here
  // (e.g. offset.y ~= the scroll delta instead of the small placement nudge).
  // `hostTransform` is what the reconciler last wrote. `viewportFixed` picks
  // the host's anchoring (fixed vs absolute). The `scrollAccel*` fields show
  // whether the inner-scroll accelerator is armed and its live scroll state —
  // an armed badge's on-screen position is host base + outer's -scrollerTop.
  reconcileOffset: { x: number; y: number } | null;
  hostTransform: string;
  viewportFixed: boolean;
  scrollAccelArmed: boolean;
  scrollAccelMax: number | null;
  scrollAccelScrollerTop: number | null;
  // The ridden scroller chain, innermost first — one entry per layer. Lets a
  // snapshot answer "is the OUTER scroller actually in this badge's chain?"
  // (the aggregate scrollAccelMax/ScrollerTop above can't, being summed). A
  // report badge that should ride [report, outer] but shows only [report] is a
  // nested-composition gap (flag off or an ancestor not detected).
  scrollAccelLayers: { scroller: string; max: number; scrollTop: number }[] | null;
  // Lifetime count of chain-change events (see _scrollAccelRearms). Climbs on a
  // report badge whose hover-gated inner scroller flaps during an outer scroll.
  scrollAccelRearms: number;
  // Lifetime count of ScrollTimeline anims built (see _scrollAccelAnimBuilds).
  // LOW relative to rearms = inner wrappers rebuilt but the outermost layer reused.
  scrollAccelAnimBuilds: number;
  // True when the occlusion fold has hidden this badge (.bk-occluded). With
  // isVisible (the logical show state) this disambiguates "shown" from "shown
  // but visually hidden because covered" — the ghost-badge diagnosis.
  occluded: boolean;
  // The overlay half of the fold as last applied (paint-decision state) —
  // with `occluded` and the wrapper's `clipped`, pins WHICH signal hid the
  // badge without a flag-bisection round-trip.
  overlayOccluded: boolean;
}

export interface BadgeHandle {
  /** The badge's mount node — reattach detection reads `host.isConnected`. */
  readonly host: Element;
  /** Logical show state (intent, not photons — see eyeState). */
  readonly isVisible: boolean;
  readonly badgeSize: { w: number; h: number };
  readonly diagnostics: BadgeDiagnostics;

  show(): void;
  hide(): void;
  remove(): void;
  reattach(): void;
  retarget(newEl: Element): void;

  setLabel(label: LabelAssignment): void;
  clearLabel(): void;
  updateLabel(label: LabelAssignment, displayMode: BadgeDisplayMode): void;
  setFiltered(filtered: boolean): void;
  setMatchedChars(count: number): void;
  /** Two-input occlusion fold — overlay verdict (null = unchanged) OR clip
   *  signal; applies the visual and returns true when it flipped. */
  applyOcclusion(overlay: boolean | null, clipped: boolean): boolean;
  flash(): void;

  updatePosition(candidate?: { x: number; y: number }): void;
  hideLeader(): void;

  /** Rendered ground truth by computed style + geometry; null = not rendering.
   *  Forces layout — callers batch reads at a bounded cadence. */
  eyeState(): { solid: boolean; inViewport: boolean } | null;
}
