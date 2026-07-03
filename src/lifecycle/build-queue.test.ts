/**
 * BranchKit Browser — band-build queue unit tests
 * (notes/DESIGN_PAINT_THE_BAND.md seam 2).
 *
 * Pins the budget/ordering contract: on-screen items are never starved by
 * band pre-work, off-screen first-time construction is budgeted, the
 * dormant-reuse fast path is exempt, and the continuation is single-flight.
 *
 * Run: npm test
 */

import { describe, it, expect } from 'vitest';
import { runBuildPass, createSingleFlight } from './build-queue';

interface Item {
  id: string;
  onScreen: boolean;
  firstTime: boolean;
}

function item(id: string, onScreen: boolean, firstTime = true): Item {
  return { id, onScreen, firstTime };
}

/** Fake clock advanced by each build, so per-item cost is deterministic. */
function makeClock(costMs: number) {
  let t = 0;
  return {
    now: () => t,
    tick: () => { t += costMs; },
  };
}

function runPass(items: Item[], budgetMs: number, costMs: number) {
  const built: string[] = [];
  const clock = makeClock(costMs);
  const deferred = runBuildPass(items, {
    isOnScreen: (i) => i.onScreen,
    isFirstTime: (i) => i.firstTime,
    build: (i) => { built.push(i.id); clock.tick(); },
    budgetMs,
    now: clock.now,
  });
  return { built, deferred };
}

describe('runBuildPass', () => {
  it('builds every on-screen item before any off-screen item, regardless of input order', () => {
    const { built } = runPass(
      [item('off1', false), item('on1', true), item('off2', false), item('on2', true)],
      100, 1,
    );
    expect(built).toEqual(['on1', 'on2', 'off1', 'off2']);
  });

  it('never starves on-screen items: they build unbudgeted even when each costs more than the whole budget', () => {
    const { built, deferred } = runPass(
      [item('on1', true), item('on2', true), item('on3', true)],
      4, 50,
    );
    expect(built).toEqual(['on1', 'on2', 'on3']);
    expect(deferred).toBe(0);
  });

  it('defers off-screen first-time items once the budget is exhausted, and counts them', () => {
    // Each build costs 3ms against a 4ms budget: the first off-screen build
    // runs (elapsed 0), the second runs (elapsed 3 < 4), the third is
    // deferred (elapsed 6 >= 4).
    const { built, deferred } = runPass(
      [item('off1', false), item('off2', false), item('off3', false)],
      4, 3,
    );
    expect(built).toEqual(['off1', 'off2']);
    expect(deferred).toBe(1);
  });

  it('on-screen work does not consume the off-screen budget', () => {
    // The clock starts for off-screen items AFTER the on-screen loop, so
    // expensive viewport work cannot eat the band budget.
    const { built, deferred } = runPass(
      [item('on1', true), item('off1', false)],
      4, 100,
    );
    expect(built).toEqual(['on1', 'off1']);
    expect(deferred).toBe(0);
  });

  it('exempts the dormant-reuse fast path (non-first-time) from the budget', () => {
    const { built, deferred } = runPass(
      [
        item('off-first1', false, true),
        item('off-reuse1', false, false),
        item('off-first2', false, true),
        item('off-reuse2', false, false),
      ],
      4, 10,
    );
    // First-time: off-first1 builds (elapsed 0), off-first2 deferred.
    // Reuse: both build regardless of elapsed time.
    expect(built).toEqual(['off-first1', 'off-reuse1', 'off-reuse2']);
    expect(deferred).toBe(1);
  });

  it('always makes forward progress: the first off-screen first-time build runs even if it alone blows the budget', () => {
    const { built, deferred } = runPass(
      [item('off1', false), item('off2', false)],
      4, 50,
    );
    expect(built).toEqual(['off1']);
    expect(deferred).toBe(1);
  });
});

describe('createSingleFlight', () => {
  it('collapses multiple triggers into one scheduled run', () => {
    const scheduled: Array<() => void> = [];
    let runs = 0;
    const trigger = createSingleFlight((cb) => scheduled.push(cb), () => runs++);
    trigger();
    trigger();
    trigger();
    expect(scheduled.length).toBe(1);
    scheduled[0]();
    expect(runs).toBe(1);
  });

  it('re-arms after the scheduled run fires', () => {
    const scheduled: Array<() => void> = [];
    let runs = 0;
    const trigger = createSingleFlight((cb) => scheduled.push(cb), () => runs++);
    trigger();
    scheduled[0]();
    trigger();
    expect(scheduled.length).toBe(2);
    scheduled[1]();
    expect(runs).toBe(2);
  });

  it('a trigger from inside the run schedules a fresh continuation (drain-more pattern)', () => {
    // The band-build continuation may itself defer work and re-trigger; the
    // flag must already be cleared when `run` executes so the re-trigger
    // schedules instead of being swallowed.
    const scheduled: Array<() => void> = [];
    let runs = 0;
    const trigger = createSingleFlight(
      (cb) => scheduled.push(cb),
      () => { runs++; if (runs === 1) trigger(); },
    );
    trigger();
    scheduled[0]();
    expect(scheduled.length).toBe(2);
  });

  it('forwards the scheduler callback arguments to run (the rIC deadline path)', () => {
    // The band-build continuation drains under the IdleDeadline runWhenIdle
    // hands it; the wrapper must pass it through, not swallow it.
    const scheduled: Array<(arg: { timeRemaining(): number }) => void> = [];
    const seen: Array<{ timeRemaining(): number } | undefined> = [];
    const trigger = createSingleFlight<[{ timeRemaining(): number }]>(
      (cb) => scheduled.push(cb),
      (deadline) => seen.push(deadline),
    );
    trigger();
    const fakeDeadline = { timeRemaining: () => 42 };
    scheduled[0](fakeDeadline);
    expect(seen).toEqual([fakeDeadline]);
  });
});
