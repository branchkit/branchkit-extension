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
  __testing,
} from './visibility-tracker';

// The tracker reads the pageSession singleton directly (Tier 3 — the
// initVisibilityTracker seam is gone); reset the session flags it touches.
const session = pageSession;

beforeEach(() => {
  vi.useFakeTimers();
  session.visibilityMOConnected = false;
  session.hintsVisible = false;
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
  it('counts a nonzero-box delivery for a parked candidate; drops zero-box and unparked', () => {
    const parked = document.createElement('a');
    trackPendingCandidate(parked);
    const stranger = document.createElement('a');
    const before = lifecycleCounters.visibilityRoSignals;

    // Zero-box (the RO initial fire on a still-collapsed element) — dropped.
    expect(__testing.parkedResizeSignal(parked, false)).toBe(false);
    // Nonzero box on an element nobody parked — dropped.
    expect(__testing.parkedResizeSignal(stranger, true)).toBe(false);
    expect(lifecycleCounters.visibilityRoSignals).toBe(before);

    // The reveal: a parked candidate gained a real box.
    expect(__testing.parkedResizeSignal(parked, true)).toBe(true);
    expect(lifecycleCounters.visibilityRoSignals).toBe(before + 1);
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
