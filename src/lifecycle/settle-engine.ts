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
 * Step-1 scope: the settle pass + reconcile/build cluster. Discovery
 * (scheduleBandDiscovery), reposition (scheduleReposition), and the paint
 * entries (showBadges) are still content.ts residents reached through
 * `SettleEngineHooks`; they move into the engine in step 2, at which point
 * the hooks shrink. No listener is attached by importing this module — the
 * signal wiring stays in content.ts (step 3 moves it to a wire function).
 *
 * The comments on the individual methods are carried over from content.ts
 * verbatim where they record soak-derived behavior — they are the design
 * history of the highest-incident code in the extension; keep them with the
 * code they constrain.
 */

import type { ElementWrapper } from '../scan/element-wrapper';
import type { SettleDeps } from './settle-deps';
import { wantsHint } from './desired-state';
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
import { recordCpu } from '../debug/perf-counters';

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
 * Content.ts residents the settle pass still drives — the step-2 cut moves
 * them into the engine and retires this interface. Injected as callbacks so
 * step 1 stays behavior-preserving without content.ts import cycles.
 */
export interface SettleEngineHooks {
  /** Discover step of the reconciler (single-flight band sweep). */
  scheduleBandDiscovery(settleKind: 'band' | 'store', revealRepairs: number): void;
  /** The batched positioner pass entry (rAF single-flight). */
  scheduleReposition(): void;
  /** Cancel the deferred-settle sibling timer (idle-storm doubler guard —
   *  see settle()). The passSoon sibling is engine-owned and cancelled
   *  directly. */
  cancelDeferredSettle(): void;
  /** Strict-viewport paint entry — the mass-reveal direct paint ends here. */
  showBadges(): Promise<void>;
}

/** Per-class applied counts (Phase E of notes/DESIGN_UNIFIED_RECONCILER.md,
 *  decision 4): what each pass DID. Surfaced on the debug + perf snapshots. */
interface AppliedCounts {
  release: number; repair: number; claim: number; build: number;
  show: number; hide: number; cssHidden: number; strict: number;
}

export class SettleEngine {
  private passSoonTimer: ReturnType<typeof setTimeout> | null = null;
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  private massRevealPaintQueued = false;

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
      this.hooks.cancelDeferredSettle();
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
      this.hooks.scheduleBandDiscovery(discovery, planLists.toRepair.length);
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
    this.hooks.scheduleReposition();
  }
}
