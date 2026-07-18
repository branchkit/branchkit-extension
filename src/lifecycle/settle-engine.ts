/**
 * SettleEngine — the render reaction's home (step 1 of
 * notes/DESIGN_SETTLE_ENGINE_EXTRACTION.md).
 *
 * One constructed object owns the ordered settle pass (gather → plan →
 * apply), the level-triggered build-up reconcile, and their coalescing
 * timers. Browser-touching collaborators are injected (`SettleDeps`), so the
 * whole pipeline runs in vitest + happy-dom against fakes; the pure decision
 * layer (computeReconcilePlanLists, gatherSettleReads) stays imported
 * directly — pure functions need no seam.
 *
 * Scope after step 2: the settle pass + reconcile/build cluster, the band
 * discovery sweep, the reposition/scroll-follow loops, and the two settle
 * front-ends (scroll + deferred debounces). The paint entry (showBadges) and
 * the nav path are still content.ts residents reached through
 * `SettleEngineHooks`. No listener is attached by importing this module —
 * the signal wiring stays in content.ts, delegating to engine methods.
 *
 * The comments on the individual methods are carried over from content.ts
 * verbatim where they record soak-derived behavior — they are the design
 * history of the highest-incident code in the extension; keep them with the
 * code they constrain.
 */

import type { ElementWrapper, DiscoverySource } from '../scan/element-wrapper';
import type { SettleDeps } from './settle-deps';
import { wantsHint } from './desired-state';
import { shouldRunBandSweep } from './band-sweep-gate';
import { gatherSettleReads, type SettleGather } from './gather';
import { computeReconcilePlanLists, type ReconcilePlanLists } from './reconcile';
import { drainStampDisagree } from './strict-viewport';
import { runBuildPass, createSingleFlight, WAVE_BUILD_BUDGET_MS } from './build-queue';
import {
  cacheLayout, cacheConstruction, clearLayoutCache, getCachedRect, isRectOnScreen,
} from '../layout-cache';
import { isVisible } from '../scan/scanner';
import { poolLabelToAssignment } from '../labels/words';
import { firehoseStep } from '../debug/firehose';
import { harnessHooksEnabled } from '../debug/harness-hooks';
import { recordCpu, lifecycleCounters } from '../debug/perf-counters';

/** Shared settle debounce (scroll settle, deferred settle, the engine's
 *  coalesced reconcile and passSoon backstop). 100ms coalesces a churny burst
 *  into one pass after things settle — matches Rango's focus debounce. */
export const DEFERRED_REPOSITION_DEBOUNCE_MS = 100;

/** Mass-reveal fast-arm threshold (DESIGN_FLING_WAVE round 18): a settle whose
 * plan repaired this many stale-FALSE band flags IS the double-buffered
 * reveal (QuickBase measures 106-166 at the flip; incidental repairs run
 * 1-17). Such a sweep skips the idle gate — mid-storm rIC never fires, so
 * the gate is a flat +500ms on exactly the wave the user is watching for. */
export const REVEAL_REPAIR_FAST_ARM = 25;

/**
 * Content.ts residents the settle machinery still drives — each is a nav- or
 * paint-path member that has not (yet) moved into the engine. Injected as
 * callbacks so the extraction stays behavior-preserving without content.ts
 * import cycles.
 */
export interface SettleEngineHooks {
  /** Strict-viewport paint entry — the mass-reveal direct paint and the band
   *  sweep's follow-through end here. */
  showBadges(): Promise<void>;
  /** Eye-level paint-stability sampler arm (content.ts telemetry). */
  notePaintSamplerScroll(): void;
  /** Runs after the scroll settle completes — the nav path drains a
   *  mid-scroll-parked spa_nav rescan here (flushDeferredNavRescan). */
  afterScrollSettle(): void;
}

/** Per-class applied counts (Phase E of notes/DESIGN_UNIFIED_RECONCILER.md,
 *  decision 4): what each pass DID. Surfaced on the debug + perf snapshots. */
interface AppliedCounts {
  release: number; repair: number; claim: number; build: number;
  show: number; hide: number; cssHidden: number; strict: number;
}

const DISCOVERY_SWEEP_IDLE_TIMEOUT_MS = 500;
const DISCOVERY_RETRY_COOLDOWN_MS = 300;
const DISCOVERY_MAX_RETRY_DEPTH = 2;
// Every sweep walks in one slab (fling-wave round 20b) — a per-batch-yielding
// sweep holds the single-flight lock for seconds mid-storm and the reveal's
// fast request queues behind it. This is a circuit breaker, not pacing.
const SWEEP_SLAB_BUDGET_MS = 700;
// Mid-fling band sweep throttle (notes/DESIGN_FLING_WAVE.md Part 1c + drill
// round 2). 10Hz while scroll events arrive; a timestamp, not a timer —
// nothing to tear down, nothing free-running (wedge discipline).
const MID_SCROLL_BAND_SWEEP_MS = 100;

export class SettleEngine {
  private passSoonTimer: ReturnType<typeof setTimeout> | null = null;
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  private scrollSettleTimer: ReturnType<typeof setTimeout> | null = null;
  private deferredSettleTimer: ReturnType<typeof setTimeout> | null = null;
  private massRevealPaintQueued = false;
  private repositionRafPending = false;
  private reconcileScrollRaf: number | null = null;
  private reconcileScrollActive = false;
  private bandSweepLastAt = 0;

  // Harness-only settle-trigger attribution (settle-storm diagnosis): every
  // scheduler that can arm the pipeline notes WHY, the notes accumulate across
  // the debounce window (a Set — coalesced duplicates collapse), and the settle
  // entry ships them as one firehose step. Names the re-arm edge of a settle
  // loop directly instead of inferring it from step ordering.
  private readonly settleTriggerReasons = new Set<string>();

  // Applied-counts telemetry: with the plan authoritative, the shadow-vs-live
  // comparison is meaningless — this reports what each pass DID. The note's
  // "remaining budget" half stays unimplemented per its own open question
  // (trust the bounded sets; measure before adding a budget) — until one
  // exists, `last` spiking against a quiet page is the tripwire.
  readonly applied = {
    passes: 0,
    last: { release: 0, repair: 0, claim: 0, build: 0, show: 0, hide: 0, cssHidden: 0, strict: 0 } as AppliedCounts,
    total: { release: 0, repair: 0, claim: 0, build: 0, show: 0, hide: 0, cssHidden: 0, strict: 0 } as AppliedCounts,
  };

  // Single-flight yield-chained continuation for band construction the budget
  // deferred. Re-enters the BUILD step ONLY (badgeNewlyCodeworded, never
  // reconcile() — so never claims): claims are byte-for-byte unchanged by band
  // painting, which is what keeps the 73cf6e7 → b813e29 codeword-churn loop
  // from re-arming (notes/DESIGN_PAINT_THE_BAND.md risk 2). Resumes ~1-4ms
  // after the prior slice via the yield chain; re-armed only when a pass
  // reports deferred > 0, and every pass builds at least one first-time item,
  // so the backlog strictly shrinks — self-terminating, wedge-safe. The
  // isTornDown guard is load-bearing: the yield path is not cancellable by
  // teardown.
  private readonly scheduleBandBuildContinuation: () => void;

  constructor(
    private readonly deps: SettleDeps,
    private readonly hooks: SettleEngineHooks,
  ) {
    this.scheduleBandBuildContinuation = createSingleFlight(
      (cb) => this.deps.scheduler.yieldTask(cb),
      () => {
        if (this.deps.isTornDown() || !this.deps.isBadgesVisible()) return;
        this.badgeNewlyCodeworded();
      },
    );
  }

  noteSettleTrigger(reason: string): void {
    if (harnessHooksEnabled()) this.settleTriggerReasons.add(reason);
  }

  // Demoted backstop entry (Phase E): between-settle signals — the visibility
  // MO's class/style ticks, pointer-driven reveals — request the unified pass
  // instead of running their own convergence loops (the old 100ms-throttled
  // recheckBadgeVisibility + the strict re-push it triggered). Non-extending
  // single-flight timer, deliberately NOT the deferred-settle debounce: a
  // debounce pushes back under sustained churn, and the demotion contract is
  // "must not get slower than the loops it replaced" — this fires within the
  // same 100ms cadence the old throttle guaranteed. The pass is budget-priced
  // for that cadence (gather+plan ≈ 4-6ms, Phase B/D evidence).
  schedulePassSoon(reason?: string): void {
    this.noteSettleTrigger(`passSoon:${reason ?? 'unknown'}`);
    if (this.passSoonTimer !== null) return;
    this.passSoonTimer = this.deps.scheduler.timeout(() => {
      this.passSoonTimer = null;
      this.settle('store');
    }, DEFERRED_REPOSITION_DEBOUNCE_MS);
  }

  // Coalesced entry for high-frequency edge signals (focus/transition/resize
  // settle): a 100ms debounce collapses a churny burst into one reconcile so we
  // act on real {claim, build} deltas only — the steady state is a cheap
  // O(store) no-op walk; grammar churn happens solely when a genuinely new
  // in-band wrapper needs a codeword. Sites needing synchronous
  // flush→showBadges ordering (nav, alphabet) call reconcile() directly.
  scheduleReconcile(): void {
    if (this.reconcileTimer) return;
    this.reconcileTimer = this.deps.scheduler.timeout(() => {
      this.reconcileTimer = null;
      this.reconcile();
    }, DEFERRED_REPOSITION_DEBOUNCE_MS);
  }

  // Build-up half of the level-triggered lifecycle reconciler (Phases 3+5 of
  // notes/completed/DESIGN_HINT_LIFECYCLE_RECONCILER.md). This is THE single
  // convergence entry for {codeword, hint} — every edge trigger
  // (codewords-changed, nav-settle, alphabet-change, label-sync catchup,
  // focus/transition settle) routes here rather than poking the claim or build
  // step directly. `refreshViewportClaims` and `badgeNewlyCodeworded` are
  // reconcile-owned steps, not independent backstops. Idempotent:
  //   - claim: queue in-band wrappers that lack a codeword. The pool RPC is
  //     async; its completion re-enters here via onCodewordsChanged, so each
  //     pass builds whatever is currently buildable and queues the rest.
  //     Pool-exhausted claims don't re-fire the callback, so this converges
  //     rather than spins.
  //   - build: construct badges for in-band codeworded wrappers that lack one.
  // Tear-down is the settle pass's plan (stale-TRUE release); the IO
  // viewport-exit remains the cheap fast-path. Keep reconcile gBCR-free — it
  // runs on the frequent onCodewordsChanged cadence and the coalesced
  // scheduleReconcile.
  reconcile(): void {
    this.deps.tracker.refreshViewportClaims();
    if (this.deps.isBadgesVisible()) {
      this.badgeNewlyCodeworded();
      this.reattachStrippedHosts();
    }
  }

  // The build step of the reconciler. Called only by reconcile() and the
  // yield continuation — no longer an independent edge-triggered backstop.
  // Builds badges for every wrapper that wants a hint (in-band, codeworded,
  // category-matched) but lacks one. Shown-ness is IO-band scoped
  // (notes/DESIGN_PAINT_THE_BAND.md): off-viewport band wrappers paint too and
  // ride the scroll into view already painted, Rango-style.
  //
  // Two-phase like showBadges: construct/show everything first (DOM writes),
  // THEN one batched placeBadges (probe reads before transform writes) — the
  // per-badge placement of the first cut forced a reflow PER BADGE.
  //
  // `budgetMs` is the off-viewport construction budget for THIS pass — the
  // burst-scale build constant (lifecycle/build-queue.ts) for every caller,
  // reconcile-path and continuation alike: a realistic wave completes in one
  // pass, paying the ancestor warm and the placement reflow once.
  badgeNewlyCodeworded(budgetMs: number = WAVE_BUILD_BUDGET_MS): void {
    const newBadges: ElementWrapper[] = [];
    for (const w of this.deps.store.all) {
      // Delta against desired state: wants a hint but isn't currently
      // visible. With hint reuse (DESIGN_HINT_REUSE.md), a wrapper's `w.hint`
      // persists across viewport exit/re-enter cycles, so the old `!w.hint`
      // filter would skip every dormant hint forever. This catches both
      // first-time hints (w.hint absent) and reused dormant hints (w.hint
      // present but hidden + cleared).
      if (wantsHint(w) && !w.hint?.isVisible) {
        newBadges.push(w);
      }
    }
    if (newBadges.length === 0) return;

    const __start = performance.now();
    try {
      const elements = newBadges.map(w => w.element);
      cacheLayout(elements);
      // Warm the full ancestor chain too — rect + style + dims, deduped across
      // wrappers: first-time construction walks ancestors for container
      // resolution, the viewport-pinned check, and APCA background resolution,
      // and sibling rows share almost their whole chain. Cold, those walks
      // cost ~1.3-1.5ms/badge on deep production DOM (the build-queue
      // saturation in the 2026-07-03 QuickBase fling profiles).
      cacheConstruction(elements);
      const vw = window.innerWidth, vh = window.innerHeight;
      const built: ElementWrapper[] = [];
      const deferred = runBuildPass(newBadges, {
        isOnScreen: (w) => isRectOnScreen(getCachedRect(w.element), vw, vh),
        // First-time construction (shadow DOM, anchorParent walk, APCA
        // colors) is the budgeted class; the dormant-reuse fast path
        // (setLabel + show) is cheap and exempt.
        isFirstTime: (w) => !w.hint,
        build: (w) => {
          if (this.prepareBadge(w)) built.push(w);
        },
        budgetMs,
      });
      // Batched placement for everything this pass constructed/re-showed:
      // one read phase (text probes) over all badges, then the writes.
      if (built.length > 0) this.deps.placement.placeBadges(built);
      if (deferred > 0) {
        firehoseStep('band_build:deferred', deferred, 1);
        this.scheduleBandBuildContinuation();
      }
    } finally {
      clearLayoutCache();
      recordCpu('bandBuild:pass', performance.now() - __start);
    }
  }

  // Construct/show one wrapper from the pass's delta set: label restore, the
  // CSS-visibility gate, first-time construction or dormant reuse, show.
  // Placement is NOT done here — the caller batch-places the returned set
  // (true = needs placement). Requires a warm layout cache.
  private prepareBadge(w: ElementWrapper): boolean {
    const label = poolLabelToAssignment(w.scanned.codeword);
    w.label = label;
    // A CSS-invisible target (visibility:hidden / opacity:0 hover-reveal) must
    // not paint — no visibility transition fires for a never-revealed target,
    // so the recheck never cleans it up. `cssHidden` keeps the voice
    // (strict-viewport) gate in lockstep.
    const cssVisible = isVisible(w.element);
    w.cssHidden = !cssVisible;
    // Restore the label on an existing dormant (scroll-back) hint even when
    // the target is CSS-hidden. A dormant hint was clearLabel()d on band exit;
    // skipping the label here (the 116b321 regression) leaves it null — and
    // the visibility recheck shows it as an empty box when the target is later
    // revealed. The label is just data on a hidden badge.
    if (w.hint) {
      w.hint.setLabel(label);
    }
    if (!cssVisible) {
      w.tBuildGated ??= performance.now();
      return false;
    }
    // Slow path (first-time): construct the badge. The reuse fast path above
    // skips shadow DOM creation, observer wire-up, anchorParent walk, z-index
    // walk, and APCA color recomputation.
    if (!w.hint) {
      w.hint = this.deps.badges.create(w.element, label, w.category, this.deps.displayMode());
    }
    // Direct paint (round 13 — the Rango-parity cut): the badge appears the
    // moment it is built, translucent (bk-pending) until the grammar ACK
    // solidifies it ~80ms later. tFirstShown stamps here and is eye-honest:
    // the paint is immediately visible.
    w.hint.show(this.deps.isPaintReady(w));
    w.tFirstShown ??= performance.now();
    return true;
  }

  // Reattach step of the reconciler: a hint whose host the page stripped out
  // of the DOM while the target element survives. SPA-heavy sites (YouTube on
  // the nesting path) continuously remove our nested badge hosts from inside
  // their managed subtrees — the target lives on but the badge child is
  // yanked. The host object is intact, so the build step skips it (`w.hint`
  // is non-null); this clause re-appends the existing host and re-places it.
  //
  // This replaces the standalone badgeReattachObserver + its per-badge rate
  // limiter + host-level circuit breaker: the reconcile pass is debounced, so
  // a host that strips every frame never lets the mutation storm settle and
  // reconcile simply doesn't fire until it stops — no spin, no rate limiter.
  // Each pass is one bounded O(detached) reattach. Reattach appends a
  // `data-branchkit-hint` host, which isOwnMutation filters out of the main
  // firehose, so it can't self-feed.
  private reattachStrippedHosts(): void {
    let reattached = 0;
    for (const w of this.deps.store.all) {
      if (!w.hint || w.hint.host.isConnected) continue;
      // Target gone — don't reattach an orphan; let teardown tidy up.
      if (!w.element.isConnected) continue;
      w.hint.reattach();
      reattached++;
    }
    if (reattached > 0) firehoseStep('reconcile:reattach', reattached, 1);
  }

  // Lifecycle applier — the codeword/flag half of the settle pass
  // (notes/DESIGN_UNIFIED_RECONCILER.md + nav-wipe retirement step 1). The
  // plan computes WHICH wrappers are desynced; this is the thin applier. The
  // IO entry/exit branches remain the cheap fast-path; this corrects
  // dropped/reordered IO events in either direction and queues the claims the
  // IO missed:
  //
  //   toRelease (stale-TRUE):  flag=in, geometry=out → release codeword; the
  //                            flush tears the hint down to dormant
  //   toRepair  (stale-FALSE): flag=out, geometry=in → flip flag; the
  //                            reconcile below rebuilds
  //   toClaim:                 emit-only telemetry, NOT applied. The first
  //                            attempt to apply it per pass (7fe37a0, nav-wipe
  //                            step 1) fragmented claim/sync into many small
  //                            waves during page load and produced badge
  //                            doubling — it races the scan pipeline's inline
  //                            claims. Reverted 2026-06-12; the
  //                            standing-claim-backstop idea needs its own
  //                            design (see DESIGN_NAV_WIPE_RETIREMENT.md).
  private applyLifecyclePlan(lists: ReconcilePlanLists): void {
    for (const w of lists.toRelease) {
      w.isInViewport = false;
      this.deps.tracker.queueRelease(w);
    }
    for (const w of lists.toRepair) {
      w.isInViewport = true;
      w.tInBand ??= performance.now();
    }
    // If we corrected any stale-FALSE flags, run reconcile so the
    // just-recovered wrappers also go through build (badgeNewlyCodeworded
    // picks up repaired dormant badges whose codeword survived).
    if (lists.toRepair.length > 0) {
      firehoseStep('reconcile:stale_false_repair', lists.toRepair.length, 1);
      this.reconcile();
    }
  }

  // Visibility applier (apply cutover 3/4): the plan decides which badges flip
  // (toShow/toHide via wantsShown over the gather, with dormancy and the
  // post-repair flag simulated) and which targets' cssHidden changed; this
  // writes them. The visibility guards mirror the live recheck's
  // transition-only branches (show only a hidden badge, hide only a showing
  // one) so the apply stays idempotent against the conditional build pass that
  // ran during teardown. No onVisibilityChanged trigger here: the strict step
  // runs next in the pipeline and reads the just-written cssHidden, so the
  // out-of-band re-push would queue the identical delta.
  private applyVisibilityPlan(lists: ReconcilePlanLists): void {
    for (const [w, hidden] of lists.cssHiddenDelta) w.cssHidden = hidden;
    for (const w of lists.toShow) {
      if (w.hint && !w.hint.isVisible) w.hint.show(this.deps.isPaintReady(w));
    }
    for (const w of lists.toHide) {
      if (w.hint?.isVisible) w.hint.hide();
    }
  }

  // Strict-viewport re-push applier (apply cutover 2/4): scroll moves wrappers
  // across the strict/band boundary without changing their codeword; the
  // plugin's `_strict` companion collection (voice matching + Discovery HUD)
  // reflects the last-pushed flag, so the delta needs a re-push to converge.
  // The plan computes WHICH wrappers (computeStrictDeltaPlan, via wantsStrict
  // over the gather geometry); this queues them. Codeword set unchanged — a
  // flag refresh.
  private applyStrictPlan(delta: ElementWrapper[]): void {
    if (delta.length === 0) return;
    firehoseStep('strict-viewport:delta', delta.length, 1);
    for (const w of delta) this.deps.sync.queuePut(w);
    this.deps.sync.scheduleSync('strict-viewport-change');
  }

  // Occlusion applier (apply cutover 4/4 —
  // notes/DESIGN_HINT_OCCLUSION_FILTERING.md for the detection itself). The
  // elementFromPoint hit-tests live in the gather (read batch 3, over the
  // visible in-band badge set, flag-gated); this writes the overlay signal and
  // folds it into the effective occlusion (composes with the clip signal) —
  // hiding the badge and dropping the target from the voice-matchable
  // `_strict` collection via the plan's strict delta. Empty map (flag off) →
  // no-op. A badge built mid-pipeline by the repair path isn't in the map and
  // gets its first hit-test next settle.
  private applyOcclusionPlan(gather: SettleGather): void {
    if (gather.overlayCovered.size === 0) return;
    let changed = 0;
    for (const [w, covered] of gather.overlayCovered) {
      w.overlayCovered = covered;
      if (this.deps.occlusion.applyOcclusion(w)) changed++;
    }
    if (changed > 0) firehoseStep('occlusion:delta', changed, 1);
  }

  private recordApplied(lists: ReconcilePlanLists): void {
    this.applied.passes++;
    const last: AppliedCounts = {
      release: lists.toRelease.length,
      repair: lists.toRepair.length,
      claim: lists.toClaim.length,
      build: lists.toBuild.length,
      show: lists.toShow.length,
      hide: lists.toHide.length,
      cssHidden: lists.cssHiddenDelta.length,
      strict: lists.strictDelta.length,
    };
    this.applied.last = last;
    for (const k of Object.keys(last) as Array<keyof AppliedCounts>) {
      this.applied.total[k] += last[k];
    }
  }

  // Single-flight for the mass-reveal direct paint (round 33d): a ≥fast-arm
  // repair batch is a double-buffered flip revealing already-attached
  // wrappers. The band sweep's follow-through covers them, but its entry
  // queues behind the single-flight walk (~0.7s mid-storm on the client
  // grid). The repaired cohort needs NO walk — only claim flush + paint — so
  // run that follow-through directly on the yield chain. Idempotent with the
  // sweep's own pass; bounded to mass reveals. Multiple settles in one reveal
  // burst coalesce into one claim-flush + paint.
  scheduleMassRevealPaint(repairs: number): void {
    if (this.massRevealPaintQueued) return;
    this.massRevealPaintQueued = true;
    this.deps.scheduler.yieldTask(() => {
      this.massRevealPaintQueued = false;
      if (this.deps.isTornDown()) return;
      void (async () => {
        firehoseStep('mass_reveal:direct_paint', repairs, 0);
        this.reconcile();
        await this.deps.tracker.flushNow();
        if (this.deps.isBadgesVisible()) await this.hooks.showBadges();
      })();
    });
  }

  // THE settle pipeline: one ordered convergence pass shared by every
  // debounced settle signal (scroll settle and the focus/transition/resize/
  // container-mutation settle). Previously duplicated verbatim in the two
  // handlers, where the step ordering lived only in comments (2026-06-11
  // review). Step order is load-bearing — enforced here by structure:
  //   1. clip-membership sync (the one mid-pipeline writer of the plan's
  //      occlusion inputs — before the gather so plan inputs stay stable).
  //   2. GATHER — one batched read over the bounded sets (rects, styles,
  //      occlusion hit-tests, frame ancestor-chain), before any write.
  //   3. PLAN — the one desired-state derivation, simulating the apply order.
  //   4. APPLY — thin appliers: lifecycle → band discovery arm →
  //      mass-reveal → occlusion → scroll-accel → visibility → strict.
  //   5. reposition — settle always ENDS in paint.
  //
  // Steps 1-4 are gated on badgesVisible: the activate command requires the
  // hints tag, so voice can't match while hints are down — stale strict
  // membership doesn't matter, and the next `show` re-scans from scratch.
  settle(discovery: 'band' | 'store'): void {
    if (harnessHooksEnabled()) {
      const src = this.settleTriggerReasons.size > 0
        ? [...this.settleTriggerReasons].sort().join('+')
        : 'unattributed';
      this.settleTriggerReasons.clear();
      firehoseStep(`settle:enter:${discovery}:${src}`, 1);
    }
    // One store pass per signal window (notes/DESIGN_SETTLE_TRIGGER_SCOPING.md):
    // the deferred-settle debounce and the passSoon single-flight are two
    // independent 100ms timers that both request THIS unified pass — letting
    // the sibling fire would re-run an identical pass over unchanged state
    // ~100ms later (the idle-storm doubler: two full settles per page tick).
    // The firing timer nulled itself before calling here, so this cancels only
    // the sibling; a signal landing after this synchronous pass re-arms fresh.
    if (discovery === 'store') {
      if (this.passSoonTimer !== null) {
        this.deps.scheduler.clearTimeout(this.passSoonTimer);
        this.passSoonTimer = null;
      }
      if (this.deferredSettleTimer !== null) {
        this.deps.scheduler.clearTimeout(this.deferredSettleTimer);
        this.deferredSettleTimer = null;
      }
    }
    if (this.deps.isBadgesVisible()) {
      // Clip-membership sync FIRST: its leave-path is the one mid-pipeline
      // writer of the plan's occlusion inputs (clearing `clipped` for targets
      // that left observation) — running it before the gather keeps every
      // plan input stable through the applies. A badge built mid-pipeline by
      // the repair path joins observation next settle (the clip IO drives
      // `clipped` between settles anyway).
      this.deps.clip.reconcileClipObservation(this.deps.store.all);
      // GATHER (notes/DESIGN_UNIFIED_RECONCILER.md): one batched read over
      // the bounded sets. Taken before any write; safe to share because the
      // appliers' writes (badge DOM, flag repairs, queued releases) never
      // move target elements within this synchronous task.
      const gather = gatherSettleReads(this.deps.store.all);
      // PLAN: the one desired-state derivation deciding every action class
      // over the snapshot, simulating the apply order (flag repairs feed
      // shown-ness; occlusion/cssHidden feed strict).
      const planLists = computeReconcilePlanLists(this.deps.store, gather);
      // APPLY: thin appliers in the load-bearing step order.
      this.applyLifecyclePlan(planLists);
      // Every settle kind arms the band discovery sweep (round 14). The old
      // 'band'-only rule assumed non-scroll settles reveal new hintables only
      // among EXISTING wrappers — false on double-buffered grids: QuickBase
      // renders the incoming window hidden and flips it visible via a class
      // change our attributeFilter deliberately ignores, so ~50 elements per
      // swap were discovered only by the NEXT scroll's settle. The mutation
      // burst around the flip lands a 'store' settle within ~100ms; arming
      // the sweep here closes the straggler window to ≤~600ms. The sweep is
      // single-flight, idle-scheduled, and isKnown-skipping — cheap when
      // nothing new exists. The repair count is the mass-reveal tell: a
      // double-buffered flip repairs ~100+ stale band flags in one plan, and
      // that sweep skips the idle gate (round 18 fast-arm).
      this.scheduleBandDiscovery(discovery, planLists.toRepair.length);
      if (planLists.toRepair.length >= REVEAL_REPAIR_FAST_ARM) {
        this.scheduleMassRevealPaint(planLists.toRepair.length);
      }
      if (discovery === 'store') this.scheduleReconcile();
      this.applyOcclusionPlan(gather);
      this.deps.scrollAccel.reconcileScrollAccel();
      this.applyVisibilityPlan(planLists);
      this.applyStrictPlan(planLists.strictDelta);
      this.recordApplied(planLists);
      // Harness-only strict-flip attribution (settle-storm diagnosis): which
      // plan input moved for the delta cohort since the last pass, plus the
      // stamp-vs-plan disagreements accrued from the batch POSTs in between.
      // 'stable' flips (no input moved) + stamp_disagree name the baseline
      // writer (stampStrictViewport / the sync drain) as the loop's other leg.
      if (harnessHooksEnabled()) {
        for (const [k, v] of Object.entries(planLists.strictFlips)) {
          if (v > 0) firehoseStep(`strictflip:${k}`, v);
        }
        const sd = drainStampDisagree();
        if (sd.total > 0) {
          firehoseStep('stamp_disagree:total', sd.total);
          if (sd.geometry > 0) firehoseStep('stamp_disagree:geometry', sd.geometry);
          if (sd.occluded > 0) firehoseStep('stamp_disagree:occluded', sd.occluded);
          if (sd.cssHidden > 0) firehoseStep('stamp_disagree:cssHidden', sd.cssHidden);
          if (sd.ancestor > 0) firehoseStep('stamp_disagree:ancestor', sd.ancestor);
        }
      }
    }
    this.scheduleReposition();
  }

  // --- Reposition (step 2 of the extraction) --------------------------------
  // The JS reconcile positioner owns badge placement: one batched pass reads
  // every registered badge's live target rect and writes composited
  // transforms. This drives that pass on a rAF single-flight so the settle
  // handlers' shared 100ms debounce funnels into one coalescing policy —
  // wedge-safe by construction. There is deliberately NO off-screen hide
  // sweep here (retired by notes/DESIGN_PAINT_THE_BAND.md seam 3): shown-ness
  // is band-scoped, so a sweep would fight applyVisibilityPlan's re-show
  // every settle. The one artifact it existed for (a parked target's badge
  // box overhanging the viewport edge) is solved by the write-time clamp
  // inside reconcileRead (hints.ts).
  scheduleReposition(): void {
    if (!this.deps.isBadgesVisible()) return;
    if (this.repositionRafPending) return;
    this.repositionRafPending = true;
    this.deps.scheduler.raf(() => {
      this.repositionRafPending = false;
      // Reposition breadcrumbs: a `reposition:start` without matching
      // `reposition:end` pins this as the wedge body. Threshold-gated so
      // steady-state scroll doesn't add 60 sendMessages/sec of telemetry.
      firehoseStep('reposition:start', this.deps.positioner.reconcileRegistrySize(), 20);
      // One batched pass: reads all target rects, writes all transforms.
      // reconcileRead() short-circuits hidden badges and disconnected targets
      // before any gBCR (limbo wrappers — badge held for the ~250ms rebind
      // window — never reach placement; see
      // notes/INVESTIGATION_LIMBO_BADGE_FLASH.md).
      const rects = this.deps.positioner.reconcilePass();
      firehoseStep('reposition:end', rects.size, 20);
      // Harness-only (settle-storm diagnosis): transforms that actually
      // changed value this pass. Emits only when nonzero (threshold 1) — a
      // sustained nonzero on an idle page names an oscillating badge.
      if (harnessHooksEnabled()) {
        firehoseStep('reposition:changed', this.deps.positioner.lastReconcileChangedWrites(), 1);
      }
    });
  }

  // Scroll tracking. A viewport-pinned badge host (position:fixed) does not
  // ride the compositor, and an inner-pane scroll moves flow targets without
  // moving their document-anchored hosts — so during a continuous scroll
  // badges must be re-pinned to their targets every frame; the trailing-edge
  // 100ms settle would leave them detached until scroll stops. This runs a
  // per-frame reconcilePass() ONLY while scroll events are arriving and only
  // when badges exist; it self-cancels ~1 frame after the last scroll event,
  // so it is bounded and NOT a free-running rAF (the nav-time wedge
  // discipline).
  noteReconcileScroll(): void {
    if (this.deps.positioner.reconcileRegistrySize() === 0) return;
    this.reconcileScrollActive = true;
    if (this.reconcileScrollRaf === null) {
      this.reconcileScrollRaf = this.deps.scheduler.raf(() => this.reconcileScrollFrame());
    }
  }

  private reconcileScrollFrame(): void {
    this.reconcileScrollRaf = null;
    this.deps.positioner.reconcilePass();
    // Re-arm for one more frame if a scroll event landed since the last pass;
    // a quiet frame (no new event) clears the flag and lets the loop stop.
    if (this.reconcileScrollActive) {
      this.reconcileScrollActive = false;
      this.reconcileScrollRaf = this.deps.scheduler.raf(() => this.reconcileScrollFrame());
    }
  }

  // Mid-fling band repair (throttled, both directions) — badges for rows
  // crossing the band edge paint DURING the fling, funded by same-sweep
  // releases, instead of waiting for the IO to catch up. Gated on
  // badgesVisible: with hints down the IO's own cadence is fine (nothing
  // user-facing waits), and the next show re-converges from scratch.
  private noteBandSweep(): void {
    if (!this.deps.isBadgesVisible()) return;
    const now = performance.now();
    if (now - this.bandSweepLastAt < MID_SCROLL_BAND_SWEEP_MS) return;
    this.bandSweepLastAt = now;
    const { repaired, released } = this.deps.tracker.sweepBand(window.innerWidth, window.innerHeight);
    if (repaired > 0 || released > 0) {
      lifecycleCounters.bandSweepRepairs += repaired;
      lifecycleCounters.bandSweepReleases += released;
      firehoseStep('band_sweep:changed', repaired + released, 20);
      // Synchronous convergence (round 13): refreshViewportClaims picks up
      // the just-flipped flags, the build+paint runs inline — edge-crossing
      // badges appear within the sweep's own 100ms cadence, Rango's
      // scroll-poll shape. Releases matter here too — the freed letters land
      // at the front of the local reservoir synchronously, so a claim that
      // would have returned '' a sweep ago is funded NOW.
      this.reconcile();
    }
  }

  /** True while the trailing-edge scroll settle is armed — the nav path uses
   *  this as its mid-scroll signal (a spa_nav arriving mid-scroll parks until
   *  afterScrollSettle). */
  isScrollSettlePending(): boolean {
    return this.scrollSettleTimer !== null;
  }

  /** Teardown assist: stop the per-frame scroll follow loop (quiesceOrphan
   *  calls this before draining the positioner registry, so a stray frame
   *  can't iterate dead badges). */
  stopScrollLoop(): void {
    if (this.reconcileScrollRaf !== null) {
      this.deps.scheduler.cancelRaf(this.reconcileScrollRaf);
      this.reconcileScrollRaf = null;
    }
    this.reconcileScrollActive = false;
  }

  // The scroll front-end. The full settle pipeline on every rAF during scroll
  // burned ~22% sustained CPU at wrap=99 on YouTube /watch, tripped Firefox's
  // "extension is slowing things down" warning, and starved YouTube's own
  // scroll-driven lazy-loading. The 100ms debounce coalesces the burst (~30
  // events/sec during fast scrolling) into one settle after scroll stops;
  // per-frame target tracking during the scroll itself is the bounded
  // reconcileScrollFrame loop, not the pipeline.
  scheduleScrollReposition(e?: Event): void {
    // Scroll reshuffles fixed/sticky vs content — the occlusion memo can't
    // localize that, so the whole window fails open (targets move anyway, so
    // their rect keys retest them regardless). Idempotent per window.
    this.deps.occlusion.occlusionMemoAllDirty('scroll');
    // Reconcile badges need per-frame re-pinning during the scroll itself
    // (they don't ride the compositor); this fires on every scroll event,
    // before the trailing-edge settle below. No-op when the registry is empty.
    this.noteReconcileScroll();
    // Arm the eye-level paint-stability sampler (self-terminating).
    this.hooks.notePaintSamplerScroll();
    this.noteBandSweep();
    // Gesture-start accelerator re-detection (timer null = first event of
    // this scroll burst). A scroller that only became scrollable on hover
    // (QuickBase classic report grids flip overflow:hidden->auto under
    // :hover) emits no mutation and, under overlay scrollbars, no reflow —
    // so the settle-time reconcileScrollAccel below hasn't armed it yet and
    // the badge would chase (wiggle) this whole first gesture. Re-arm the
    // badges inside the scroller that just scrolled NOW, so they ride the
    // compositor from the first frame. Scoped to e.target's subtree, so
    // window/document scroll and already-ridden scrollers cost only a cheap
    // contains-check per badge.
    if (this.scrollSettleTimer == null && e && e.target instanceof Element) {
      this.deps.scrollAccel.reconcileScrollAccelForScroller(e.target);
    }
    this.noteSettleTrigger('scroll');
    if (this.scrollSettleTimer) this.deps.scheduler.clearTimeout(this.scrollSettleTimer);
    this.scrollSettleTimer = this.deps.scheduler.timeout(() => {
      this.scrollSettleTimer = null;
      // Scroll-settle is the canonical viewport-exit moment (stale-TRUE
      // release) AND where infinite-scroll content lands (band discovery).
      this.settle('band');
      // A spa_nav that arrived mid-scroll (scroll-driven URL tick, e.g. a
      // pagination offset) was parked; run it now that the storm is over.
      this.hooks.afterScrollSettle();
    }, DEFERRED_REPOSITION_DEBOUNCE_MS);
  }

  // Deferred settle for signals that hint "layout is about to settle":
  // focusin/focusout (:focus-within resizes, focus-driven popovers),
  // transitionend/animationend (CSS-driven dropdowns interpolate layout over
  // 200-300ms — the MutationObserver fires at the *start* of the class
  // change; without a settle signal, reposition runs mid-animation and is
  // wrong), container resize, window resize/zoom. The 100ms debounce
  // coalesces the burst (one transition fires many transitionend events; a
  // click fires focusout+focusin <16ms apart) into one pass after things
  // settle. Matches Rango's ElementWrapper.ts focus debounce.
  scheduleDeferredReposition(src?: Event | string): void {
    // Occlusion-memo invalidation taps (notes/DESIGN_OCCLUSION_HITTEST_MEMO.md),
    // riding the signals already routed here. resize (incl. zoom) reshuffles
    // fixed/sticky vs content → fail open; transform-ancestor pans move
    // everything → fail open; focus/transition/animation events queue their
    // target for cell-marking at the next gather (:focus-within and
    // end-of-animation restyles can repaint with no MO record the page
    // observer's attributeFilter would carry). 'mo-batch' and
    // 'target-mutation' are already tapped at their sources;
    // 'container-resize' is deliberately untapped (anchor resizes move the
    // targets themselves — the rect key retests them).
    if (src === 'transform-ancestor') {
      this.deps.occlusion.occlusionMemoAllDirty('transform-ancestor');
    } else if (src instanceof Event) {
      if (src.type === 'resize') this.deps.occlusion.occlusionMemoAllDirty('resize');
      else if (src.target instanceof Element) this.deps.occlusion.occlusionMemoNoteTarget(src.target);
    }
    this.noteSettleTrigger(`deferred:${typeof src === 'string' ? src : src?.type ?? 'direct'}`);
    if (this.deferredSettleTimer) this.deps.scheduler.clearTimeout(this.deferredSettleTimer);
    this.deferredSettleTimer = this.deps.scheduler.timeout(() => {
      this.deferredSettleTimer = null;
      // 'store' discovery: container resize / focus / transition / zoom
      // reveal new in-band hintables among existing wrappers and can push
      // wrappers across the strict boundary without a scroll event.
      this.settle('store');
    }, DEFERRED_REPOSITION_DEBOUNCE_MS);
  }

  // --- Discovery (step 2 of the extraction) ---------------------------------
  // Discover step of the level-triggered reconciler (Phase 3b of
  // notes/completed/DESIGN_HINT_LIFECYCLE_RECONCILER.md). `reconcile()`
  // converges {codeword, hint} over EXISTING wrappers; it cannot close the
  // *discovery gap* — a hintable element that entered the DOM while the
  // MutationObserver dropped/coalesced its insertion record under a mutation
  // storm, so no wrapper was ever created. This backstop re-walks the
  // document via the sliced/batched discovery (yields between batches, skips
  // known elements), idempotently attaching any missed hintable — a
  // steady-state sweep attaches nothing and claims nothing (no grammar
  // churn).
  //
  // Single-flight + idle-scheduled: scroll-settle fires repeatedly on a long
  // scroll, so at most one sweep is in flight and the rest coalesce. A
  // coalesced request can mean a row was re-rendered DURING the in-flight
  // sweep, so the finally conditionally re-arms — but ONLY when the sweep
  // added nothing AND a coalesce happened (strongest signal of a race-missed
  // node). When the sweep added nodes, DO NOT retry: chained reruns produced
  // the codeword-churn loop (73cf6e7 → b813e29). Retries are depth-capped and
  // cooldown-gated so even worst-case the chain terminates quickly.
  // requestIdleCallback waits for a quiet frame so the DOM walk never lands
  // on top of the page's reflow (the wedge guard); the timeout caps the wait.
  //
  // Distinct from `scheduleDiscovery(root)` (the rAF-coalesced drainer for
  // subtree roots the MutationObserver DID see): this is the backstop for the
  // records it DIDN'T.
  scheduleBandDiscovery(settleKind: 'band' | 'store', revealRepairs = 0): void {
    const sweep = this.deps.sweepState;
    const fastReveal = revealRepairs >= REVEAL_REPAIR_FAST_ARM;
    // Dirty gate (notes/DESIGN_BAND_SWEEP_DIRTY_GATE.md): no observed adds
    // since the last walk started + last sweep recent → the re-walk can find
    // nothing the incremental paths haven't. Evaluated BEFORE the
    // single-flight check so a skipped request never sets rerun flags;
    // retries re-enter here with the then-current epoch (a mid-walk add
    // reads dirty — exactly the race the retry exists for). Fast-arm
    // bypasses inside the gate.
    if (!shouldRunBandSweep({
      domAddEpoch: this.deps.discovery.getDomAddEpoch(),
      sweptEpoch: sweep.sweptEpoch,
      sweepEndAt: sweep.sweepEndAt,
      now: performance.now(),
      fastReveal,
    })) {
      recordCpu('bandDiscovery:skipClean', 0);
      firehoseStep('band_discovery:skip_clean', 1);
      return;
    }
    if (sweep.pending) {
      sweep.rerun = true;
      // A mass reveal landing mid-sweep must not be demoted to the
      // noise-retry path — record the urgency; the in-flight sweep's finally
      // re-arms immediately regardless of its added count (round 18b).
      if (fastReveal) {
        sweep.fastRerun = true;
      }
      firehoseStep('band_discovery:coalesced', 1);
      return;
    }
    sweep.pending = true;
    sweep.rerun = false;
    sweep.fastRerun = false;
    // Discovery-source tag by the settle kind that STARTED this sweep (a
    // coalesced request of the other kind folds in — labels are diagnostic):
    // scroll settles → band_sweep, non-scroll (store) settles → settle_sweep.
    const source: DiscoverySource = settleKind === 'band' ? 'band_sweep' : 'settle_sweep';
    const sweepBody = (): void => {
      void (async () => {
        let added = 0;
        // Captured at walk start: adds landing during the walk push the live
        // epoch past this, so the next settle's gate reads dirty.
        const epochAtStart = this.deps.discovery.getDomAddEpoch();
        try {
          if (this.deps.isTornDown() || !document.body) return;
          // Attribution stamp (round 20c): fast_arm→sweep_start is the entry
          // delay (scheduler/idle queueing); sweep_start→added is walk + the
          // claim-flush builds in this task's microtask tail.
          firehoseStep('band_discovery:sweep_start', 0, 0);
          added = await this.deps.discovery.discoverInSubtreeBatched(
            document.body, source, SWEEP_SLAB_BUDGET_MS,
          );
          // Diagnostic: the sweep's added count INCLUDING zero, to correlate
          // a miss against whether the walk actually attached anything.
          firehoseStep('band_discovery:added', added, 0);
          // A reveal-armed sweep must follow through even with ZERO adds
          // (round 33c): on double-buffered grids the reveal cohort is
          // ALREADY-ATTACHED wrappers whose stale-false band flags a
          // reconcile pass just repaired — the walk skips them all
          // (known-wrapper skip), added===0, and an early return here
          // stranded their claim flush + paint for seconds.
          if (added === 0 && !fastReveal) return;
          // New wrappers landed (or a mass reveal armed this sweep): claim
          // codewords for the in-band ones and build their badges
          // (reconcile), flush the claims, then paint.
          this.reconcile();
          await this.deps.tracker.flushNow();
          if (this.deps.isBadgesVisible()) await this.hooks.showBadges();
        } finally {
          sweep.sweptEpoch = epochAtStart;
          sweep.sweepEndAt = performance.now();
          sweep.pending = false;
          // Mass-reveal rerun (round 18b): a >=fast-arm repair settle landed
          // while this sweep was in flight, and its fast-arm was swallowed by
          // the single-flight coalesce. Re-arm immediately on the fast path —
          // added>0 here is EXPECTED (this walk caught part of the wave), so
          // the added===0 gate below deliberately does not apply. This is not
          // the 73cf6e7 churn loop: that retried on a raceless heuristic per
          // scroll settle; this consumes an explicit reveal signal, and it
          // only recurs if ANOTHER mass reveal lands during the next
          // (isKnown-skipping, ~100-400ms) walk — sustained real content.
          const fastRerun = sweep.fastRerun;
          sweep.fastRerun = false;
          if (fastRerun && !this.deps.isTornDown()) {
            sweep.retryDepth = 0;
            firehoseStep('band_discovery:fast_rerun', added);
            this.scheduleBandDiscovery(settleKind, REVEAL_REPAIR_FAST_ARM);
          } else {
            // Conditional re-arm: retry only when (a) a coalesce happened
            // during this sweep — without it there's no evidence a race
            // occurred — AND (b) this sweep added zero new wrappers, which
            // means the work we did do is NOT the source of any churn the
            // retry might amplify. Retries when added>0 chained the
            // codeword-churn loop in 73cf6e7 → b813e29. Cap depth + cooldown
            // so even a pathological scroll settle pattern terminates.
            const shouldRetry =
              sweep.rerun &&
              added === 0 &&
              !this.deps.isTornDown() &&
              sweep.retryDepth < DISCOVERY_MAX_RETRY_DEPTH;
            if (shouldRetry) {
              sweep.retryDepth++;
              firehoseStep('band_discovery:retry', sweep.retryDepth);
              this.deps.scheduler.timeout(
                () => this.scheduleBandDiscovery(settleKind),
                DISCOVERY_RETRY_COOLDOWN_MS,
              );
            } else {
              sweep.retryDepth = 0;
            }
          }
        }
      })();
    };
    if (fastReveal) {
      // The settle plan just proved a mass reveal — content gained geometry
      // en masse. Waiting for idle here IS the residual late wave; the walk
      // runs in one slab (round 20) so front-of-queue entry is safe. Retries
      // (armed above) deliberately keep the idle path — they are race
      // backstops, not reveal-urgent.
      firehoseStep('band_discovery:fast_arm', revealRepairs);
      this.deps.scheduler.yieldTask(sweepBody);
    } else {
      this.deps.scheduler.idle(sweepBody, DISCOVERY_SWEEP_IDLE_TIMEOUT_MS);
    }
  }
}
