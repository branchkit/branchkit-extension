/**
 * BranchKit Browser — sync-trace unit tests (round 22b).
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { recordSyncPost, syncTraceStats, resetSyncTrace } from './sync-trace';

function rec(overrides: Partial<Parameters<typeof recordSyncPost>[0]> = {}) {
  return {
    t: performance.now(),
    elapsedMs: 42,
    result: 'ok',
    elements: 15,
    deletes: 0,
    failedN: 0,
    session: 'abcd1234',
    kind: 'incremental',
    batchIndex: 0,
    isFinal: true,
    ...overrides,
  };
}

beforeEach(() => resetSyncTrace());

describe('sync trace', () => {
  it('counts posts and transport errors; windows the recent list', () => {
    recordSyncPost(rec());
    recordSyncPost(rec({ result: 'error', failedN: 15 }));
    recordSyncPost(rec({ t: performance.now() - 120_000 }));

    const s = syncTraceStats(90_000);
    expect(s.posts_total).toBe(3);
    expect(s.transport_errors_total).toBe(1);
    expect(s.recent).toHaveLength(2); // the old record fell out of the window
    expect(s.recent[1].result).toBe('error');
    expect(s.recent[1].failed_n).toBe(15);
  });

  it('bounds the ring', () => {
    for (let i = 0; i < 250; i++) recordSyncPost(rec());
    const s = syncTraceStats(90_000);
    expect(s.recent.length).toBeLessThanOrEqual(200);
    expect(s.posts_total).toBe(250);
  });
});
