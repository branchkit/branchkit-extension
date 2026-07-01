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
import {
  constructVisibilityObservers,
  trackPendingCandidate,
  untrackPendingCandidate,
  teardownVisibilityTracker,
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
