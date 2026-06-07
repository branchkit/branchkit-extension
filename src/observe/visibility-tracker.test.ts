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
import { PageSession } from '../lifecycle/page-session';
import {
  initVisibilityTracker,
  trackPendingCandidate,
  untrackPendingCandidate,
  teardownVisibilityTracker,
} from './visibility-tracker';

function makeSession(): PageSession {
  return new PageSession({ teardown: () => {}, onUrlChange: () => {}, restore: () => {} });
}

let session: PageSession;

beforeEach(() => {
  vi.useFakeTimers();
  session = makeSession();
  initVisibilityTracker({ pageSession: session, attachWrapper: vi.fn(), showHints: vi.fn() });
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
