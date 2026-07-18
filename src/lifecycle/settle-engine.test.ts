/**
 * SettleEngine unit tests — the settle pass driven end-to-end over fakes
 * (step 1 of notes/DESIGN_SETTLE_ENGINE_EXTRACTION.md, section 7).
 *
 * These convert the hard-won Playwright repros into deterministic units:
 * stale-flag repair/release, the idle-storm doubler (sibling-timer cancel),
 * passSoon single-flight, dormant-hint reuse (no rebuild churn), the strict
 * re-push delta, stripped-host reattach, the mass-reveal direct paint, and
 * the badgesVisible gate. Geometry is scripted by stubbing each element's
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
  setOccluded(): void { this.calls.push('setOccluded'); }
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
  const tracker = {
    flushNow: vi.fn(() => Promise.resolve()),
    refreshViewportClaims: vi.fn(),
    queueRelease: vi.fn(),
    sweepBand: vi.fn(() => ({ repaired: 0, released: 0 })),
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
  const occlusion = { applyOcclusion: vi.fn(() => false), occlusionMemoAllDirty: vi.fn() };
  const deps: SettleDeps = {
    store,
    tracker,
    sync,
    badges: {
      create: () => { const b = new FakeBadge(); created.push(b); return b; },
    },
    positioner: {
      reconcilePass: () => ({ size: 0 }),
      reconcileRegistrySize: () => 0,
      lastReconcileChangedWrites: () => 0,
    },
    occlusion,
    clip,
    scrollAccel,
    placement,
    discovery: { discoverInSubtreeBatched: vi.fn(() => Promise.resolve(0)) },
    scheduler,
    isBadgesVisible: () => state.badgesVisible,
    isTornDown: () => state.tornDown,
    displayMode: () => 'letter' as BadgeDisplayMode,
    isPaintReady: () => true,
  };
  const hooks: SettleEngineHooks & {
    bandDiscoveryCalls: Array<['band' | 'store', number]>;
    repositionCalls: number;
    deferredCancels: number;
    showBadgesCalls: number;
  } = {
    bandDiscoveryCalls: [],
    repositionCalls: 0,
    deferredCancels: 0,
    showBadgesCalls: 0,
    scheduleBandDiscovery(kind, repairs) { this.bandDiscoveryCalls.push([kind, repairs]); },
    scheduleReposition() { this.repositionCalls++; },
    cancelDeferredSettle() { this.deferredCancels++; },
    showBadges() { this.showBadgesCalls++; return Promise.resolve(); },
  };
  const engine = new SettleEngine(deps, hooks);
  return { engine, store, scheduler, tracker, sync, placement, created, hooks, state };
}

let nextId = 1;
function addWrapper(
  store: ObservableWrapperStore,
  opts: {
    codeword?: string;
    inViewport?: boolean;
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
  w.isInViewport = opts.inViewport ?? false;
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

describe('settle: stale-flag repair and release', () => {
  it('repairs a stale-FALSE band flag and revives its dormant badge (scroll-back missing badge)', () => {
    // The scroll-back repro: a dormant badge (band exit cleared it) whose
    // re-entry IO event was dropped — flag says out, geometry says in. The
    // plan repairs only HINTED wrappers (or codeword-less never-hinted
    // candidates); codeworded hintless wrappers are the build class.
    const h = makeHarness();
    const dormant = new FakeBadge();
    const w = addWrapper(h.store, {
      codeword: 'a', inViewport: false, rect: ON_SCREEN,
      hint: dormant, hintVisible: false, lastSentStrict: true,
    });

    h.engine.settle('store');

    expect(w.isInViewport).toBe(true);
    expect(h.engine.applied.last.repair).toBe(1);
    // The repair re-entered reconcile → the dormant badge was relabeled and
    // re-shown via the reuse fast path (no reconstruction).
    expect(h.created.length).toBe(0);
    expect(dormant.calls).toContain('setLabel');
    expect(dormant.isVisible).toBe(true);
    expect(h.placement.placeBadges).toHaveBeenCalledWith([w]);
  });

  it('releases a stale-TRUE flag through the tracker (stranded badge)', () => {
    const h = makeHarness();
    const badge = new FakeBadge();
    const w = addWrapper(h.store, {
      codeword: 'a', inViewport: true, rect: OFF_BAND, hint: badge, hintVisible: true,
      lastSentStrict: false,
    });

    h.engine.settle('store');

    expect(w.isInViewport).toBe(false);
    expect(h.tracker.queueRelease).toHaveBeenCalledWith(w);
    expect(h.engine.applied.last.release).toBe(1);
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
    expect(h.hooks.deferredCancels).toBe(1);
    // The cancelled sibling never fires a second settle.
    const runs = h.hooks.repositionCalls;
    h.scheduler.flushTimers();
    expect(h.hooks.repositionCalls).toBe(runs);
  });

  it('schedulePassSoon is single-flight and re-arms after firing', () => {
    const h = makeHarness();
    h.engine.schedulePassSoon('a');
    h.engine.schedulePassSoon('b');
    expect(h.scheduler.pending.length).toBe(1);

    h.scheduler.flushTimers();
    expect(h.hooks.repositionCalls).toBe(1); // one settle ran

    h.engine.schedulePassSoon('c');
    expect(h.scheduler.pending.length).toBe(1); // re-armed after firing
  });

  it('band settles do not cancel the deferred sibling', () => {
    const h = makeHarness();
    h.engine.settle('band');
    expect(h.hooks.deferredCancels).toBe(0);
  });
});

describe('reconcile: build-up convergence', () => {
  it('builds first-time badges, reuses dormant hints, skips uncodeworded', () => {
    const h = makeHarness();
    const fresh = addWrapper(h.store, { codeword: 'a', inViewport: true, lastSentStrict: true });
    const dormantBadge = new FakeBadge();
    const dormant = addWrapper(h.store, {
      codeword: 's', inViewport: true, hint: dormantBadge, hintVisible: false, lastSentStrict: true,
    });
    const bare = addWrapper(h.store, { codeword: '', inViewport: true });

    h.engine.reconcile();

    expect(h.tracker.refreshViewportClaims).toHaveBeenCalled();
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
    addWrapper(h.store, { codeword: 'a', inViewport: true, lastSentStrict: true });

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
      codeword: 'a', inViewport: true, hint: badge, hintVisible: true, detachedHost: true,
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
      codeword: 'a', inViewport: true, rect: ON_SCREEN, hint: badge, hintVisible: true,
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
      codeword: 'a', inViewport: true, rect: ON_SCREEN, hint: badge, hintVisible: true,
      lastSentStrict: true,
    });

    h.engine.settle('store');
    h.engine.settle('store');

    expect(h.sync.queuePut).not.toHaveBeenCalled();
    expect(h.sync.scheduleSync).not.toHaveBeenCalled();
  });
});

describe('settle: mass reveal', () => {
  it('a >=fast-arm repair batch arms discovery with the count and direct-paints', async () => {
    const h = makeHarness();
    // A double-buffered flip: 25 dormant badges whose band flags all went
    // stale-FALSE at once (the QuickBase grid-swap shape).
    for (let i = 0; i < REVEAL_REPAIR_FAST_ARM; i++) {
      addWrapper(h.store, {
        codeword: `w${i}`, inViewport: false, rect: ON_SCREEN,
        hint: new FakeBadge(), hintVisible: false, lastSentStrict: true,
      });
    }

    h.engine.settle('store');

    expect(h.hooks.bandDiscoveryCalls).toEqual([['store', REVEAL_REPAIR_FAST_ARM]]);
    expect(h.scheduler.yieldQueue.length).toBe(1); // direct paint queued

    h.scheduler.drainYield();
    await new Promise(r => setTimeout(r, 0));
    expect(h.hooks.showBadgesCalls).toBe(1);
    // Reveal-burst settles coalesce: a second settle while queued adds nothing.
  });

  it('multiple reveal settles coalesce into one direct paint', () => {
    const h = makeHarness();
    h.engine.scheduleMassRevealPaint(30);
    h.engine.scheduleMassRevealPaint(40);
    expect(h.scheduler.yieldQueue.length).toBe(1);
  });
});

describe('settle: gates', () => {
  it('with badges hidden, settle skips the pass but still ends in reposition', () => {
    const h = makeHarness({ badgesVisible: false });
    addWrapper(h.store, { codeword: 'a', inViewport: false, rect: ON_SCREEN });

    h.engine.settle('store');

    expect(h.engine.applied.passes).toBe(0);
    expect(h.hooks.repositionCalls).toBe(1);
    expect(h.hooks.bandDiscoveryCalls.length).toBe(0);
  });

  it('the band-build yield continuation respects the teardown gate', () => {
    const h = makeHarness();
    // Force a continuation arm is build-queue territory; here we only pin the
    // gate: a torn-down session's queued yield task must not touch the store.
    h.state.tornDown = true;
    h.engine.scheduleMassRevealPaint(30);
    h.scheduler.drainYield();
    expect(h.tracker.refreshViewportClaims).not.toHaveBeenCalled();
  });
});
