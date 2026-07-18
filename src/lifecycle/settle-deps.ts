/**
 * SettleDeps — the injection seams for the settle engine.
 *
 * Step 0 of notes/DESIGN_SETTLE_ENGINE_EXTRACTION.md: name every
 * browser-touching collaborator the settle/discovery/reposition driver calls,
 * as interfaces the existing concrete impls already satisfy. Pure typing —
 * no behavior, no runtime imports. The engine (step 1) is constructed over a
 * `SettleDeps`; unit tests construct it over fakes.
 *
 * Conformance is enforced here at compile time via the `*SeamCheck` aliases:
 * each one fails to typecheck if the concrete impl drifts from its seam.
 * DiscoveryOps and Scheduler have no module-level impl to check against
 * (the discovery walk is a content.ts-local function; the scheduler is
 * setTimeout/rAF/idle) — their conformance is checked at the engine's
 * construction site in content.ts.
 *
 * Keep each interface to the members the engine actually drives — these are
 * test seams, not module facades. A member belongs here only when the engine
 * calls it.
 */

import type { ElementWrapper, DiscoverySource } from '../scan/element-wrapper';
import type { BadgeHandle } from '../render/badge-handle';
import type { LabelAssignment } from '../labels/words';
import type { Category, BadgeDisplayMode } from '../types';
import type { ObservableWrapperStore } from '../core/store';

/** Compile-time "A satisfies B" — used by the SeamCheck aliases below. */
type Satisfies<A extends B, B> = A;

/** The IntersectionTracker surface the engine drives: claim/release flushing,
 *  the level-triggered claim refresh, and the mid-fling band sweep. */
export interface TrackerOps {
  flushNow(): Promise<void>;
  refreshViewportClaims(): void;
  queueRelease(w: ElementWrapper): void;
  sweepBand(vw: number, vh: number): { repaired: number; released: number };
}

/** Grammar sync (labels/label-sync.ts): the engine queues Put/Delete deltas
 *  and requests the debounced push; `hasSent` gates Deletes to codewords the
 *  plugin actually saw. These are the GRAMMAR assertions in the fake. */
export interface SyncOps {
  queuePut(w: ElementWrapper): void;
  queueDelete(codeword: string): void;
  hasSent(codeword: string): boolean;
  scheduleSync(reason: string): void;
  syncNow(reason: string): Promise<void>;
}

/** Badge construction — the one place the engine creates render objects.
 *  Everything else goes through the BadgeHandle already on the wrapper. */
export interface BadgeOps {
  create(
    target: Element,
    label: LabelAssignment,
    category: Category,
    displayMode: BadgeDisplayMode,
  ): BadgeHandle;
}

/** The JS reconcile positioner (render/reconcile-positioner.ts): the batched
 *  read-rects/write-transforms pass and its registry gauges. The engine only
 *  reads `.size` off the pass result (telemetry), so the seam narrows the
 *  return to that. */
export interface PositionerOps {
  reconcilePass(): { size: number };
  reconcileRegistrySize(): number;
  lastReconcileChangedWrites(): number;
}

/** Occlusion write-back (observe/occlusion.ts) + the memo's scroll/pan
 *  fail-open and per-target invalidation taps (observe/occlusion-memo.ts).
 *  Detection itself happens in the gather (pure, already tested); the engine
 *  only applies and dirties. */
export interface OcclusionOps {
  applyOcclusion(w: ElementWrapper): boolean;
  occlusionMemoAllDirty(reason: string, keepHistory?: boolean): void;
  occlusionMemoNoteTarget(el: Element): void;
}

/** Clip-observer membership sync (observe/clip-observer.ts) — step 1 of the
 *  ordered settle pass. */
export interface ClipOps {
  reconcileClipObservation(wrappers: Iterable<ElementWrapper>): void;
}

/** Inner-scroll accelerator re-detection (render/scroll-accel-glue.ts):
 *  settle-time chain reconcile + the gesture-start scoped re-arm. */
export interface ScrollAccelOps {
  reconcileScrollAccel(): void;
  reconcileScrollAccelForScroller(scroller: Element): void;
}

/** Batched badge placement (placement/position.ts): one read phase (anchor
 *  probes) over the set, then the writes. */
export interface PlacementOps {
  placeBadges(wrappers: ElementWrapper[]): void;
}

/** The band-discovery walk (content.ts `discoverInSubtreeBatched`): one
 *  isKnown-skipping slab over `root`, returns wrappers added. The dom-add
 *  epoch (observe/mutation-source.ts) feeds the sweep's dirty gate. */
export interface DiscoveryOps {
  discoverInSubtreeBatched(
    root: Element,
    source: DiscoverySource,
    budgetMs: number,
  ): Promise<number>;
  getDomAddEpoch(): number;
}

/** The band-discovery sweep's session-scoped scheduling state. Lives on
 *  PageSession (a session restart must reset it — the engine outlives
 *  sessions); the engine reads/writes it through this adapter. */
export interface SweepStateOps {
  pending: boolean;
  rerun: boolean;
  fastRerun: boolean;
  retryDepth: number;
  sweptEpoch: number;
  sweepEndAt: number;
}

/** Time and task scheduling — the fake-able clock. Deliberately minimal
 *  (design-note open question 3): setTimeout/rAF for the debounces and
 *  single-flights, idle for the discovery sweep's quiet-frame gate,
 *  yieldTask for the build continuation chain. Not a general effect system. */
export interface Scheduler {
  timeout(cb: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
  raf(cb: FrameRequestCallback): number;
  cancelRaf(handle: number): void;
  /** Run `cb` on the next idle frame; `timeoutMs` caps the wait (content.ts
   *  `runWhenIdle` — must be invoked bound to window, see its 2026-06-12 bug
   *  note). */
  idle(cb: (deadline?: IdleDeadline) => void, timeoutMs: number): void;
  /** Yield-chained macrotask (lifecycle/page-session.ts `scheduleYieldTask`). */
  yieldTask(cb: () => void): void;
}

/** The full injection boundary the settle engine is constructed over.
 *  The pure decision layer (computeReconcilePlanLists, gatherSettleReads) is
 *  imported directly by the engine — pure functions need no seam. */
export interface SettleDeps {
  store: ObservableWrapperStore;
  tracker: TrackerOps;
  sync: SyncOps;
  badges: BadgeOps;
  positioner: PositionerOps;
  occlusion: OcclusionOps;
  clip: ClipOps;
  scrollAccel: ScrollAccelOps;
  placement: PlacementOps;
  discovery: DiscoveryOps;
  sweepState: SweepStateOps;
  scheduler: Scheduler;
  /** Master paint gate — pageSession.badgesVisible. */
  isBadgesVisible(): boolean;
  /** Orphan/teardown gate — pageSession.isTornDown. */
  isTornDown(): boolean;
  displayMode(): BadgeDisplayMode;
  /** Paint-readiness policy (grammar ACK vs standalone) — content.ts
   *  `isPaintReady`; decides the badge's pending-vs-solid opacity at show. */
  isPaintReady(w: ElementWrapper): boolean;
}

// --- Compile-time conformance: the real impls satisfy their seams. ---
// Each alias fails to typecheck when a concrete surface drifts. `typeof
// import(...)` stays fully in type space — no runtime import edges.

export type TrackerSeamCheck = Satisfies<
  import('../observe/intersection-tracker').IntersectionTracker,
  TrackerOps
>;

export type SyncSeamCheck = Satisfies<
  Pick<
    typeof import('../labels/label-sync'),
    'queuePut' | 'queueDelete' | 'hasSent' | 'scheduleSync' | 'syncNow'
  >,
  SyncOps
>;

export type BadgeSeamCheck = Satisfies<
  {
    create: (
      ...args: ConstructorParameters<typeof import('../render/hints').HintBadge>
    ) => InstanceType<typeof import('../render/hints').HintBadge>;
  },
  BadgeOps
>;

export type PositionerSeamCheck = Satisfies<
  Pick<
    typeof import('../render/reconcile-positioner'),
    'reconcilePass' | 'reconcileRegistrySize' | 'lastReconcileChangedWrites'
  >,
  PositionerOps
>;

export type OcclusionSeamCheck = Satisfies<
  Pick<typeof import('../observe/occlusion'), 'applyOcclusion'> &
    Pick<
      typeof import('../observe/occlusion-memo'),
      'occlusionMemoAllDirty' | 'occlusionMemoNoteTarget'
    >,
  OcclusionOps
>;

export type ClipSeamCheck = Satisfies<
  Pick<typeof import('../observe/clip-observer'), 'reconcileClipObservation'>,
  ClipOps
>;

export type PlacementSeamCheck = Satisfies<
  Pick<typeof import('../placement'), 'placeBadges'>,
  PlacementOps
>;

export type ScrollAccelSeamCheck = Satisfies<
  Pick<
    typeof import('../render/scroll-accel-glue'),
    'reconcileScrollAccel' | 'reconcileScrollAccelForScroller'
  >,
  ScrollAccelOps
>;
