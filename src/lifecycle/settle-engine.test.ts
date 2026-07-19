/**
 * SettleEngine unit tests — the settle pass driven end-to-end over fakes
 * (step 1 of notes/DESIGN_SETTLE_ENGINE_EXTRACTION.md, section 7).
 *
 * These convert the hard-won Playwright repros into deterministic units:
 * stale-flag repair/release, the idle-storm doubler (sibling-timer cancel),
 * passSoon single-flight, dormant-hint reuse (no rebuild churn), the strict
 * re-push delta, stripped-host reattach, the mass-reveal direct paint, the
 * scroll/deferred front-end debounces, the band-discovery single-flight +
 * dirty gate + no-retry-on-added churn guard, and the badgesVisible gate. Geometry is scripted by stubbing each element's
 * getBoundingClientRect — the gather stays the real pure read over it.
 *
 * Occlusion apply is not driven here: gather's overlayCovered is empty with
 * the bkOcclusion flag off, and enabling the flag drags elementFromPoint into
 * happy-dom. The plan/apply seams for it are typed; coverage stays with the
 * occlusion module's own tests until the step-2 cut.
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ElementWrapper } from '../scan/element-wrapper';
import { ObservableWrapperStore } from '../core/store';
import { ScannedElement, BadgeDisplayMode, Category } from '../types';
import type { BadgeHandle, BadgeDiagnostics } from '../render/badge-handle';
import type { LabelAssignment } from '../labels/words';
import type { SettleDeps } from './settle-deps';
import { SettleEngine, REVEAL_REPAIR_FAST_ARM, type SettleEngineHooks } from './settle-engine';

// --- Geometry scripting -----------------------------------------------------

const VW = 1000;
const VH = 800;
const ON_SCREEN = { top: 100, left: 100, width: 50, height: 20 };
// RECONCILE_BAND_MARGIN_PX is 1000 — beyond-band needs top > VH + 1000.
const OFF_BAND = { top: VH + 3000, left: 100, width: 50, height: 20 };

function rect(r: { top: number; left: number; width: number; height: number }): DOMRect {
  return {
    top: r.top, left: r.left,
    bottom: r.top + r.height, right: r.left + r.width,
    width: r.width, height: r.height, x: r.left, y: r.top,
    toJSON() { return this; },
  } as DOMRect;
}

// --- Fakes ------------------------------------------------------------------

class FakeBadge implements BadgeHandle {
  host = document.createElement('div');
  isVisible = false;
  badgeSize = { w: 10, h: 10 };
  diagnostics = {} as BadgeDiagnostics;
  calls: string[] = [];
  label: LabelAssignment | null = null;

  show(grammarReady?: boolean): void { this.calls.push(`show:${grammarReady}`); this.isVisible = true; }
  hide(): void { this.calls.push('hide'); this.isVisible = false; }
  remove(): void { this.calls.push('remove'); }
  reattach(): void { this.calls.push('reattach'); document.body.appendChild(this.host); }
  retarget(): void { this.calls.push('retarget'); }
  setLabel(label: LabelAssignment): void { this.calls.push('setLabel'); this.label = label; }
  clearLabel(): void { this.calls.push('clearLabel'); this.label = null; }
  updateLabel(): void { this.calls.push('updateLabel'); }
  setFiltered(): void { this.calls.push('setFiltered'); }
  setMatchedChars(): void { this.calls.push('setMatchedChars'); }
  private overlayOccluded = false;
  private occludedApplied = false;
  applyOcclusion(overlay: boolean | null, clipped: boolean): boolean {
    this.calls.push('applyOcclusion');
    if (overlay !== null) this.overlayOccluded = overlay;
    const eff = this.overlayOccluded || clipped;
    if (eff === this.occludedApplied) return false;
    this.occludedApplied = eff;
    return true;
  }
  flash(): void { this.calls.push('flash'); }
  clearPending(): void { this.calls.push('clearPending'); }
  updatePosition(): void { this.calls.push('updatePosition'); }
  hideLeader(): void { this.calls.push('hideLeader'); }
  eyeState(): { solid: boolean; inViewport: boolean } | null { return null; }
}

interface PendingTimeout { id: number; cb: () => void; ms: number }

class FakeScheduler {
  pending: PendingTimeout[] = [];
  cleared: number[] = [];
  yieldQueue: Array<() => void> = [];
  private nextId = 1;

  timeout = (cb: () => void, ms: number): ReturnType<typeof setTimeout> => {
    const id = this.nextId++;
    this.pending.push({ id, cb, ms });
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  clearTimeout = (h: ReturnType<typeof setTimeout>): void => {
    this.cleared.push(h as unknown as number);
    this.pending = this.pending.filter(p => p.id !== (h as unknown as number));
  };
  raf = (cb: FrameRequestCallback): number => { cb(0); return 0; };
  cancelRaf = (): void => {};
  idle = (cb: (deadline?: IdleDeadline) => void): void => { cb(); };
  yieldTask = (cb: () => void): void => { this.yieldQueue.push(cb); };

  /** Fire every pending timeout once (new arms during the flush run too). */
  flushTimers(): void {
    while (this.pending.length > 0) {
      const p = this.pending.shift()!;
      p.cb();
    }
  }
  drainYield(): void {
    while (this.yieldQueue.length > 0) this.yieldQueue.shift()!();
  }
}

function makeHarness(opts?: { badgesVisible?: boolean }) {
  const store = new ObservableWrapperStore();
  const scheduler = new FakeScheduler();
  const created: FakeBadge[] = [];
  const strikes = new Map<unknown, number>();
  const tracker = {
    flushNow: vi.fn(() => Promise.resolve()),
    queueClaims: vi.fn(),
    queueRelease: vi.fn(),
    // Real two-strike semantics over a fake ledger so release tests can
    // assert the hysteresis without a real IntersectionTracker.
    strikeOut: vi.fn((w: unknown, now: number) => {
      const first = strikes.get(w);
      if (first === undefined) { strikes.set(w, now); return false; }
      if (now - first < 50) return false;
      strikes.delete(w);
      return true;
    }),
    clearExitStrike: vi.fn((w: unknown) => { strikes.delete(w); }),
  };
  const sync = {
    queuePut: vi.fn(),
    queueDelete: vi.fn(),
    hasSent: vi.fn(() => true),
    scheduleSync: vi.fn(),
    syncNow: vi.fn(() => Promise.resolve()),
  };
  const placement = { placeBadges: vi.fn() };
  const state = { badgesVisible: opts?.badgesVisible ?? true, tornDown: false };
  const clip = { reconcileClipObservation: vi.fn() };
  const scrollAccel = { reconcileScrollAccel: vi.fn(), reconcileScrollAccelForScroller: vi.fn() };
  const occlusion = {
    occlusionMemoAllDirty: vi.fn(),
    occlusionMemoNoteTarget: vi.fn(),
  };
  const positioner = {
    reconcilePass: vi.fn(() => ({ size: 0 })),
    reconcileRegistrySize: vi.fn(() => 0),
    lastReconcileChangedWrites: () => 0,
  };
  const discovery = {
    discoverInSubtreeBatched: vi.fn(() => Promise.resolve(0)),
    getDomAddEpoch: vi.fn(() => 1), // nonzero vs sweptEpoch 0 → gate reads dirty
  };
  const sweepState = {
    pending: false, rerun: false, fastRerun: false,
    retryDepth: 0, sweptEpoch: 0, sweepEndAt: 0,
  };
  const deps: SettleDeps = {
    store,
    tracker,
    sync,
    badges: {
      create: () => { const b = new FakeBadge(); created.push(b); return b; },
    },
    positioner,
    occlusion,
    clip,
    scrollAccel,
    placement,
    discovery,
    sweepState,
    scheduler,
    isBadgesVisible: () => state.badgesVisible,
    isTornDown: () => state.tornDown,
    displayMode: () => 'letter' as BadgeDisplayMode,
    isPaintReady: () => true,
  };
  const hooks: SettleEngineHooks & { showBadgesCalls: number; scrollSettleFlushes: number } = {
    showBadgesCalls: 0,
    scrollSettleFlushes: 0,
    showBadges() { this.showBadgesCalls++; return Promise.resolve(); },
    notePaintSamplerScroll() {},
    afterScrollSettle() { this.scrollSettleFlushes++; },
  };
  const engine = new SettleEngine(deps, hooks);
  return {
    engine, store, scheduler, tracker, sync, placement, created, hooks, state,
    clip, occlusion, positioner, discovery, sweepState,
  };
}

let nextId = 1;
function addWrapper(
  store: ObservableWrapperStore,
  opts: {
    codeword?: string;
    rect?: { top: number; left: number; width: number; height: number };
    hint?: FakeBadge | null;
    hintVisible?: boolean;
    lastSentStrict?: boolean;
    detachedHost?: boolean;
  },
): ElementWrapper {
  const el = document.createElement('a');
  el.textContent = 'x';
  document.body.appendChild(el);
  const r = rect(opts.rect ?? ON_SCREEN);
  el.getBoundingClientRect = () => r;
  const scanned: ScannedElement = {
    label: 'x', id: nextId++, category: 'link' as Category, type: 'link',
    adapter: null, codeword: opts.codeword ?? '',
  } as ScannedElement;
  const w = new ElementWrapper(el, scanned);
  if (opts.hint) {
    w.hint = opts.hint;
    opts.hint.isVisible = opts.hintVisible ?? true;
    if (!opts.detachedHost) document.body.appendChild(opts.hint.host);
  }
  if (opts.lastSentStrict !== undefined) w.lastSentStrictViewport = opts.lastSentStrict;
  store.addWrapper(w);
  return w;
}

// --- Tests ------------------------------------------------------------------

beforeEach(() => {
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(() => Promise.resolve()) } });
  window.innerWidth = VW;
  window.innerHeight = VH;
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('settle: derived lifecycle (build revival and release)', () => {
  it('revives a dormant codeworded badge whose geometry is in-band (scroll-back missing badge)', () => {
    // The scroll-back repro, flag-free: a dormant badge with a surviving
    // codeword sits in-band by fresh geometry. The plan's toBuild owes it;
    // the lifecycle applier runs the build half and the reuse fast path
    // relabels + re-shows (no reconstruction).
    const h = makeHarness();
    const dormant = new FakeBadge();
    const w = addWrapper(h.store, {
      codeword: 'a', rect: ON_SCREEN,
      hint: dormant, hintVisible: false, lastSentStrict: true,
    });

    h.engine.settle('store');

    expect(h.engine.applied.last.build).toBe(1);
    expect(h.created.length).toBe(0);
    expect(dormant.calls).toContain('setLabel');
    expect(dormant.isVisible).toBe(true);
    expect(h.placement.placeBadges).toHaveBeenCalledWith([w]);
  });

  it('releases an off-band codeword holder through the two-strike ledger', () => {
    const h = makeHarness();
    const badge = new FakeBadge();
    const w = addWrapper(h.store, {
      codeword: 'a', rect: OFF_BAND, hint: badge, hintVisible: true,
      lastSentStrict: false,
    });

    // First settle: strike one — no destructive action yet (a transient
    // virtualizer park must not release a live badge).
    h.engine.settle('store');
    expect(h.tracker.queueRelease).not.toHaveBeenCalled();
    expect(h.engine.applied.last.release).toBe(1); // planned, gated by strikes

    // Second settle >=50ms later (fake ledger honors the real spacing):
    // confirmed — release queued.
    vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 100);
    h.engine.settle('store');
    expect(h.tracker.queueRelease).toHaveBeenCalledWith(w);
    vi.restoreAllMocks();
  });
});

describe('settle: timer discipline', () => {
  it('a store settle cancels the armed passSoon sibling (idle-storm doubler)', () => {
    const h = makeHarness();
    h.engine.schedulePassSoon('visibility-tick');
    expect(h.scheduler.pending.length).toBe(1);

    h.engine.settle('store');

    // The passSoon sibling is cancelled; the one remaining pending timer is
    // the store-settle's own coalesced reconcile debounce, not a settle.
    expect(h.scheduler.cleared.length).toBe(1);
    expect(h.scheduler.pending.length).toBe(1);
    // The cancelled sibling never fires a second settle (clip sync runs
    // exactly once per visible settle pass).
    const settles = h.clip.reconcileClipObservation.mock.calls.length;
    h.scheduler.flushTimers();
    expect(h.clip.reconcileClipObservation.mock.calls.length).toBe(settles);
  });

  it('schedulePassSoon is single-flight and re-arms after firing', () => {
    const h = makeHarness();
    h.engine.schedulePassSoon('a');
    h.engine.schedulePassSoon('b');
    expect(h.scheduler.pending.length).toBe(1);

    h.scheduler.flushTimers();
    expect(h.clip.reconcileClipObservation).toHaveBeenCalledTimes(1); // one settle ran

    h.engine.schedulePassSoon('c');
    expect(h.scheduler.pending.length).toBe(1); // re-armed after firing
  });

  it('band settles do not cancel the deferred sibling', () => {
    const h = makeHarness();
    h.engine.scheduleDeferredReposition('container-resize');
    expect(h.scheduler.pending.length).toBe(1);

    h.engine.settle('band');

    expect(h.scheduler.cleared.length).toBe(0);
    expect(h.scheduler.pending.length).toBe(1); // deferred sibling survives
  });

  it('scroll front-end: memo fail-open, sweep throttle, trailing band settle + nav flush', () => {
    const h = makeHarness();
    h.engine.scheduleScrollReposition();
    expect(h.occlusion.occlusionMemoAllDirty).toHaveBeenCalledWith('scroll');
    // The mid-fling converge ran once (reconcile → clip sync untouched, but
    // the store walk claims — assert via the claim queue on a claimable
    // store; here the store is empty so the tell is the throttle below).
    const convergesAfterFirst = h.tracker.queueClaims.mock.calls.length;

    // Second event inside the 100ms throttle window: no second converge,
    // and the trailing settle timer re-arms (debounce).
    h.engine.scheduleScrollReposition();
    expect(h.tracker.queueClaims.mock.calls.length).toBe(convergesAfterFirst);
    expect(h.engine.isScrollSettlePending()).toBe(true);

    h.scheduler.flushTimers();
    expect(h.engine.isScrollSettlePending()).toBe(false);
    expect(h.clip.reconcileClipObservation).toHaveBeenCalledTimes(1); // one band settle
    expect(h.hooks.scrollSettleFlushes).toBe(1); // parked spa_nav drains here
  });

  it('deferred front-end: debounce coalesces a burst into one store settle', () => {
    const h = makeHarness();
    h.engine.scheduleDeferredReposition('container-resize');
    h.engine.scheduleDeferredReposition('container-resize');
    expect(h.scheduler.pending.length).toBe(1);

    h.scheduler.flushTimers();
    expect(h.clip.reconcileClipObservation).toHaveBeenCalledTimes(1);
  });
});

describe('reconcile: build-up convergence', () => {
  it('builds first-time badges, reuses dormant hints, skips uncodeworded', () => {
    const h = makeHarness();
    const fresh = addWrapper(h.store, { codeword: 'a', lastSentStrict: true });
    const dormantBadge = new FakeBadge();
    const dormant = addWrapper(h.store, {
      codeword: 's', hint: dormantBadge, hintVisible: false, lastSentStrict: true,
    });
    const bare = addWrapper(h.store, { codeword: '' });

    h.engine.reconcile();

    // The bare in-band wrapper was queued for claim by the converge half.
    expect(h.tracker.queueClaims).toHaveBeenCalledWith([bare]);
    // fresh: constructed + shown.
    expect(h.created.length).toBe(1);
    expect(fresh.hint).toBe(h.created[0]);
    // dormant: label restored + re-shown, NOT reconstructed.
    expect(dormantBadge.calls).toContain('setLabel');
    expect(dormantBadge.isVisible).toBe(true);
    // bare: untouched.
    expect(bare.hint).toBeNull();
  });

  it('is idempotent — a second pass over steady state builds nothing (churn guard)', () => {
    const h = makeHarness();
    addWrapper(h.store, { codeword: 'a', lastSentStrict: true });

    h.engine.reconcile();
    const createdOnce = h.created.length;
    const placedOnce = h.placement.placeBadges.mock.calls.length;

    h.engine.reconcile();
    expect(h.created.length).toBe(createdOnce);
    expect(h.placement.placeBadges.mock.calls.length).toBe(placedOnce);
  });

  it('reattaches a stripped host whose target survived', () => {
    const h = makeHarness();
    const badge = new FakeBadge();
    addWrapper(h.store, {
      codeword: 'a', hint: badge, hintVisible: true, detachedHost: true,
    });
    expect(badge.host.isConnected).toBe(false);

    h.engine.reconcile();

    expect(badge.calls).toContain('reattach');
    expect(badge.host.isConnected).toBe(true);
  });
});

describe('settle: strict re-push and sync discipline', () => {
  it('queues strict-delta re-pushes with one scheduleSync', () => {
    const h = makeHarness();
    const badge = new FakeBadge();
    const w = addWrapper(h.store, {
      codeword: 'a', rect: ON_SCREEN, hint: badge, hintVisible: true,
      lastSentStrict: false, // pushed as out-of-strict; now on-screen → delta
    });

    h.engine.settle('store');

    expect(h.sync.queuePut).toHaveBeenCalledWith(w);
    expect(h.sync.scheduleSync).toHaveBeenCalledWith('strict-viewport-change');
    expect(h.engine.applied.last.strict).toBe(1);
  });

  it('repeated settles over converged state emit zero grammar traffic (over-sync guard)', () => {
    const h = makeHarness();
    const badge = new FakeBadge();
    addWrapper(h.store, {
      codeword: 'a', rect: ON_SCREEN, hint: badge, hintVisible: true,
      lastSentStrict: true,
    });

    h.engine.settle('store');
    h.engine.settle('store');

    expect(h.sync.queuePut).not.toHaveBeenCalled();
    expect(h.sync.scheduleSync).not.toHaveBeenCalled();
  });
});

describe('settle: mass reveal', () => {
  it('a >=fast-arm claim batch arms discovery with the count and direct-paints', async () => {
    const h = makeHarness();
    // A double-buffered flip: 25 dormant badges revealed in-band at once
    // with no codewords (the QuickBase grid-swap shape) — the plan's claim
    // burst is the reveal tell.
    for (let i = 0; i < REVEAL_REPAIR_FAST_ARM; i++) {
      addWrapper(h.store, {
        codeword: '', rect: ON_SCREEN,
        hint: new FakeBadge(), hintVisible: false, lastSentStrict: true,
      });
    }

    h.engine.settle('store');

    // Fast-arm: the sweep enters on the yield chain (not idle), alongside the
    // mass-reveal direct paint — two queued yield tasks.
    expect(h.scheduler.yieldQueue.length).toBe(2);

    h.scheduler.drainYield();
    await new Promise(r => setTimeout(r, 0));
    expect(h.discovery.discoverInSubtreeBatched).toHaveBeenCalledTimes(1);
    // Both the reveal-armed sweep's follow-through and the direct paint end
    // in showBadges — idempotent by design.
    expect(h.hooks.showBadgesCalls).toBe(2);
  });

  it('multiple reveal settles coalesce into one direct paint', () => {
    const h = makeHarness();
    h.engine.scheduleMassRevealPaint(30);
    h.engine.scheduleMassRevealPaint(40);
    expect(h.scheduler.yieldQueue.length).toBe(1);
  });
});

describe('idle-convergence backstop', () => {
  it('claims for the in-band codeword-less cohort each tick (heals without activity)', () => {
    // The manageusers class, flag-free: geometry in-band, no codeword. The
    // tick's band-convergence derives membership from fresh rects and
    // queues the claim — no event needed, nothing to have dropped.
    const h = makeHarness();
    const w = addWrapper(h.store, { codeword: '', rect: ON_SCREEN });
    h.engine.noteIdleTick();
    expect(h.tracker.queueClaims).toHaveBeenCalledWith([w]);
    // Owed work found → the full pass is armed once for strict/occlusion
    // catch-up; the passSoon single-flight holds across repeat ticks.
    expect(h.scheduler.pending.length).toBe(1);
    h.engine.noteIdleTick();
    expect(h.scheduler.pending.length).toBe(1);
  });

  it('no-ops at steady state (codeworded + visible badge)', () => {
    const h = makeHarness();
    const badge = new FakeBadge();
    addWrapper(h.store, { codeword: 'a', rect: ON_SCREEN, hint: badge, hintVisible: true, lastSentStrict: true });
    h.engine.noteIdleTick();
    expect(h.tracker.queueClaims).not.toHaveBeenCalled();
    expect(h.scheduler.pending.length).toBe(0);
  });

  it('stays silent with badges hidden', () => {
    const h = makeHarness({ badgesVisible: false });
    addWrapper(h.store, { codeword: '', rect: ON_SCREEN });
    h.engine.noteIdleTick();
    expect(h.scheduler.pending.length).toBe(0);
  });
});

describe('settle: gates', () => {
  it('with badges hidden, settle skips the pass (and reposition no-ops)', () => {
    const h = makeHarness({ badgesVisible: false });
    addWrapper(h.store, { codeword: 'a', rect: ON_SCREEN });

    h.engine.settle('store');

    expect(h.engine.applied.passes).toBe(0);
    expect(h.positioner.reconcilePass).not.toHaveBeenCalled();
    expect(h.discovery.discoverInSubtreeBatched).not.toHaveBeenCalled();
  });

  it('band discovery is single-flight: a mid-sweep request coalesces, no double walk', async () => {
    const h = makeHarness();
    let resolveWalk!: (n: number) => void;
    h.discovery.discoverInSubtreeBatched.mockReturnValue(new Promise<number>(r => { resolveWalk = r; }));

    h.engine.scheduleBandDiscovery('band', 0);
    expect(h.sweepState.pending).toBe(true);
    h.engine.scheduleBandDiscovery('band', 0);
    expect(h.sweepState.rerun).toBe(true);
    expect(h.discovery.discoverInSubtreeBatched).toHaveBeenCalledTimes(1);

    // Walk lands wrappers: follow-through paints; added>0 → NO retry even
    // with a coalesce recorded (the 73cf6e7 churn-loop guard).
    resolveWalk(3);
    await new Promise(r => setTimeout(r, 0));
    expect(h.sweepState.pending).toBe(false);
    expect(h.sweepState.retryDepth).toBe(0);
    expect(h.scheduler.pending.length).toBe(0); // no retry timer armed
    expect(h.hooks.showBadgesCalls).toBe(1);
  });

  it('band discovery dirty gate: clean epoch + recent sweep skips the walk', () => {
    const h = makeHarness();
    h.discovery.getDomAddEpoch.mockReturnValue(5);
    h.sweepState.sweptEpoch = 5;
    h.sweepState.sweepEndAt = performance.now();

    h.engine.scheduleBandDiscovery('band', 0);

    expect(h.sweepState.pending).toBe(false);
    expect(h.discovery.discoverInSubtreeBatched).not.toHaveBeenCalled();
  });

  it('the band-build yield continuation respects the teardown gate', () => {
    const h = makeHarness();
    // Force a continuation arm is build-queue territory; here we only pin the
    // gate: a torn-down session's queued yield task must not touch the store.
    h.state.tornDown = true;
    h.engine.scheduleMassRevealPaint(30);
    h.scheduler.drainYield();
    expect(h.tracker.queueClaims).not.toHaveBeenCalled();
  });
});
