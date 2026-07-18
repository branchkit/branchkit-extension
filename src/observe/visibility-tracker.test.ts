/**
 * BranchKit Browser — visibility-tracker unit tests.
 *
 * IntersectionObserver / MutationObserver don't deliver entries under
 * happy-dom, so these pin the synchronous bridge the attention observer
 * drives: tracking a candidate connects the class/style MutationObserver,
 * and untracking the last candidate disconnects it (unless a hinted wrapper
 * keeps it alive). The observer callbacks' promotion logic is covered by the
 * integration harness.
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { pageSession } from '../lifecycle/page-session';
import { store } from '../core/store';
import * as idRegistry from '../scan/registry';
import { lifecycleCounters } from '../debug/perf-counters';
import type { IntersectionTracker } from '../observe/intersection-tracker';
import {
  constructVisibilityObservers,
  trackPendingCandidate,
  untrackPendingCandidate,
  teardownVisibilityTracker,
  schedulePointerVisibilitySweep,
  setPointerRecheckScopeEnabled,
  __testing,
} from './visibility-tracker';

// The tracker reads the pageSession singleton directly (Tier 3 — the
// initVisibilityTracker seam is gone); reset the session flags it touches.
const session = pageSession;

beforeEach(() => {
  vi.useFakeTimers();
  session.visibilityMOConnected = false;
  session.badgesVisible = false;
  constructVisibilityObservers();
});

afterEach(() => {
  teardownVisibilityTracker();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('visibility MO lifecycle', () => {
  it('connects the MutationObserver when a candidate starts being tracked', () => {
    expect(session.visibilityMOConnected).toBe(false);
    trackPendingCandidate(document.createElement('div'));
    expect(session.visibilityMOConnected).toBe(true);
  });

  it('disconnects when the last tracked candidate is untracked (nothing hinted)', () => {
    const el = document.createElement('div');
    trackPendingCandidate(el);
    expect(session.visibilityMOConnected).toBe(true);

    untrackPendingCandidate(el);
    expect(session.visibilityMOConnected).toBe(false);
  });

  it('stays connected while other candidates remain tracked', () => {
    const a = document.createElement('div');
    const b = document.createElement('div');
    trackPendingCandidate(a);
    trackPendingCandidate(b);

    untrackPendingCandidate(a);
    expect(session.visibilityMOConnected).toBe(true);

    untrackPendingCandidate(b);
    expect(session.visibilityMOConnected).toBe(false);
  });

  it('holds candidates indefinitely — no time-based abandonment', () => {
    // The old 30s abandon timer wholesale-cleared the pending set; because
    // the attention IO never refires onEnter for a still-intersecting
    // element, abandoned candidates could never re-track and a CSS-revealed
    // control opened >30s after discovery stayed permanently hintless.
    trackPendingCandidate(document.createElement('div'));
    expect(session.visibilityMOConnected).toBe(true);

    vi.advanceTimersByTime(120_000);
    expect(session.visibilityMOConnected).toBe(true);
  });

  it('untracking an element that was never tracked is a no-op', () => {
    const tracked = document.createElement('div');
    const stranger = document.createElement('div');
    trackPendingCandidate(tracked);

    untrackPendingCandidate(stranger);
    // The stranger removal must not collapse the still-live tracking set.
    expect(session.visibilityMOConnected).toBe(true);

    untrackPendingCandidate(tracked);
    expect(session.visibilityMOConnected).toBe(false);
  });
});

describe('teardownVisibilityTracker', () => {
  it('is idempotent', () => {
    trackPendingCandidate(document.createElement('div'));
    expect(() => {
      teardownVisibilityTracker();
      teardownVisibilityTracker();
    }).not.toThrow();
  });
});

describe('layer-3 parked ResizeObserver signal (round 21)', () => {
  it('counts a nonzero-box delivery for a parked candidate; drops zero-box; promotes an attention-lot box gain (round 34c)', () => {
    const parked = document.createElement('a');
    trackPendingCandidate(parked);
    const stranger = document.createElement('a');
    const before = lifecycleCounters.visibilityRoSignals;

    // Zero-box (the RO initial fire on a still-collapsed element) — dropped.
    expect(__testing.parkedResizeSignal(parked, false)).toBe(false);
    // Round 34c: a nonzero box on an attention-lot candidate (RO-observed
    // via observeRevealCandidate but never admitted to pendingVisibility —
    // 0×0 elements can't trip the attention IO) PROMOTES it into the
    // recheck set and counts a signal. This was the client lookup-column gap:
    // ro_signals 8 vs 10,244 parked.
    expect(__testing.parkedResizeSignal(stranger, true)).toBe(true);
    expect(lifecycleCounters.visibilityRoSignals).toBe(before + 1);

    // The reveal: a parked candidate gained a real box.
    expect(__testing.parkedResizeSignal(parked, true)).toBe(true);
    expect(lifecycleCounters.visibilityRoSignals).toBe(before + 2);
  });

  it('promotes a parked candidate to a wrapper once the box gain makes it hintable', () => {
    // The QuickBase lookup-column shape: an anchor with href parked while
    // 0×0 (empty text), later sized by a characterData fill neither page-MO
    // config can see. The RO signal schedules the promote; the recheck
    // applies the real gates and attaches.
    store.clear();
    idRegistry.clear();
    pageSession.tracker = { observe: vi.fn(), unobserve: vi.fn() } as unknown as IntersectionTracker;
    pageSession.resizeObserver = { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() } as unknown as ResizeObserver;

    const anchor = document.createElement('a');
    anchor.setAttribute('href', '/db/rec?rid=23');
    anchor.setAttribute('aria-label', 'Doe, Jane');
    document.body.appendChild(anchor);
    // Parked while collapsed: happy-dom rects are 0×0, so the size gate
    // rejects and the candidate stays pending.
    trackPendingCandidate(anchor);
    __testing.recheckNow();
    expect(store.findWrapperFor(anchor)).toBeUndefined();
    expect(__testing.isPending(anchor)).toBe(true);

    // The text fill lands: the anchor now reports a real box.
    anchor.getBoundingClientRect = () =>
      ({ top: 100, left: 40, bottom: 120, right: 200, width: 160, height: 20, x: 40, y: 100, toJSON: () => ({}) }) as DOMRect;
    expect(__testing.parkedResizeSignal(anchor, true)).toBe(true);
    __testing.recheckNow();

    expect(store.findWrapperFor(anchor)?.discoverySource).toBe('visibility');
    expect(__testing.isPending(anchor)).toBe(false);
    anchor.remove();
  });
});

describe('pointer-recheck subtree scoping (notes/DESIGN_POINTER_RECHECK_SCOPING.md)', () => {
  function hintableAnchor(label: string): HTMLAnchorElement {
    const a = document.createElement('a');
    a.setAttribute('href', '/x');
    a.setAttribute('aria-label', label);
    a.getBoundingClientRect = () =>
      ({ top: 100, left: 40, bottom: 120, right: 200, width: 160, height: 20, x: 40, y: 100, toJSON: () => ({}) }) as DOMRect;
    return a;
  }

  /** Two parked, now-hintable candidates in two separate deep subtrees plus
   * a pointer target next to the first — the scope discriminator fixture. */
  function fixture() {
    store.clear();
    idRegistry.clear();
    pageSession.tracker = { observe: vi.fn(), unobserve: vi.fn() } as unknown as IntersectionTracker;
    pageSession.resizeObserver = { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() } as unknown as ResizeObserver;
    pageSession.deps = {
      ...(pageSession.deps ?? {}),
      showBadges: vi.fn(),
    } as never;
    pageSession.engine = {
      schedulePassSoon: vi.fn(),
    } as never;

    // Deep chains so the 5th-ancestor scope root stays inside each branch.
    const mk = (label: string) => {
      let root = document.createElement('div');
      document.body.appendChild(root);
      const branchTop = root;
      for (let i = 0; i < 7; i++) {
        const next = document.createElement('div');
        root.appendChild(next);
        root = next;
      }
      const cand = hintableAnchor(label);
      root.appendChild(cand);
      const pointerSpot = document.createElement('span');
      root.appendChild(pointerSpot);
      return { branchTop, cand, pointerSpot };
    };
    const near = mk('Near, Control');
    const far = mk('Far, Control');
    trackPendingCandidate(near.cand);
    trackPendingCandidate(far.cand);
    return { near, far };
  }

  it('a scoped recheck promotes only candidates inside the pointer subtree', () => {
    const { near, far } = fixture();
    const skipsBefore = lifecycleCounters.visibilityPromoteScopedSkips;

    __testing.recheckNow(near.pointerSpot);
    expect(store.findWrapperFor(near.cand)).toBeDefined();
    expect(store.findWrapperFor(far.cand)).toBeUndefined();
    expect(__testing.isPending(far.cand)).toBe(true);
    expect(lifecycleCounters.visibilityPromoteScopedSkips).toBe(skipsBefore + 1);

    // The full (backstop) recheck picks up the remote candidate.
    __testing.recheckNow();
    expect(store.findWrapperFor(far.cand)).toBeDefined();
  });

  it('pointer sweep: scoped promote at the throttle, full backstop at pointer idle', () => {
    const { near, far } = fixture();

    schedulePointerVisibilitySweep(near.pointerSpot);
    vi.advanceTimersByTime(100); // promote throttle → scoped
    expect(store.findWrapperFor(near.cand)).toBeDefined();
    expect(store.findWrapperFor(far.cand)).toBeUndefined();

    vi.advanceTimersByTime(300); // pointer idle → full backstop
    expect(store.findWrapperFor(far.cand)).toBeDefined();
  });

  it('kill switch off: the throttled promote is full-set again', () => {
    const { near, far } = fixture();
    try {
      setPointerRecheckScopeEnabled(false);
      schedulePointerVisibilitySweep(near.pointerSpot);
      vi.advanceTimersByTime(100);
      expect(store.findWrapperFor(near.cand)).toBeDefined();
      expect(store.findWrapperFor(far.cand)).toBeDefined();
    } finally {
      setPointerRecheckScopeEnabled(true);
    }
  });
});
