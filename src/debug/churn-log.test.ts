/**
 * BranchKit Browser — churn-log unit tests (round 22).
 *
 * The ring preserves shown-then-detached wrapper history so a
 * pop→wipe→rebuild cycle is visible to the snapshot (destroyed wrappers
 * leave store.all and every percentile with it — the third survivorship
 * deception of the fling-wave arc).
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { recordShownDetach, churnStats, resetChurnLog } from './churn-log';

function rec(overrides: Partial<Parameters<typeof recordShownDetach>[0]> = {}) {
  return {
    tDetached: performance.now(),
    shownForMs: 500,
    tag: 'button',
    source: 'mo',
    inViewport: true,
    hadCodeword: true,
    ...overrides,
  };
}

beforeEach(() => resetChurnLog());

describe('churn log', () => {
  it('counts shown detaches and flags the sub-2s wipes', () => {
    recordShownDetach(rec({ shownForMs: 400 }));
    recordShownDetach(rec({ shownForMs: 1999 }));
    recordShownDetach(rec({ shownForMs: 30_000 }));

    const s = churnStats(60_000);
    expect(s.detached_shown_total).toBe(3);
    expect(s.wiped_within_2s_total).toBe(2);
    expect(s.recent).toHaveLength(3);
  });

  it('windows the recent list by detach time', () => {
    recordShownDetach(rec({ tDetached: performance.now() - 120_000 }));
    recordShownDetach(rec({ tDetached: performance.now() }));

    const s = churnStats(90_000);
    expect(s.detached_shown_total).toBe(2); // totals are lifetime
    expect(s.recent).toHaveLength(1); // the old record fell out of the window
  });

  it('bounds the ring', () => {
    for (let i = 0; i < 400; i++) recordShownDetach(rec());
    const s = churnStats(60_000);
    expect(s.recent.length).toBeLessThanOrEqual(300);
    expect(s.detached_shown_total).toBe(400);
  });
});
