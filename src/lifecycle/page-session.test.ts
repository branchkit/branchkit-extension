/**
 * BranchKit Browser — page-session module tests.
 *
 * Currently covers `scheduleYieldTask`, the shared continuation scheduler
 * for the discovery drain and the band-build continuation
 * (notes/DESIGN_FLING_WAVE.md step 2). The PageSession class itself is
 * exercised through the observer/lifecycle integration tests.
 *
 * Run: npm test
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { scheduleYieldTask } from './page-session';

type SchedulerGlobal = { scheduler?: { yield?: () => Promise<void> } };

afterEach(() => {
  delete (globalThis as SchedulerGlobal).scheduler;
  vi.useRealTimers();
});

describe('scheduleYieldTask', () => {
  it('chains through scheduler.yield when available', async () => {
    const yieldMock = vi.fn(() => Promise.resolve());
    (globalThis as SchedulerGlobal).scheduler = { yield: yieldMock };

    const cb = vi.fn();
    scheduleYieldTask(cb);

    expect(yieldMock).toHaveBeenCalledTimes(1);
    expect(cb).not.toHaveBeenCalled(); // continuation, not synchronous
    await Promise.resolve(); // let the .then(cb) microtask run
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('falls back to a session-owned 0-timeout without scheduler.yield', () => {
    vi.useFakeTimers();

    const cb = vi.fn();
    scheduleYieldTask(cb);

    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
