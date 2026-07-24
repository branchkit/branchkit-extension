/**
 * BranchKit Browser — debug-snapshot forwarding unit tests.
 *
 * Pins the snapshot contract: connection gating, the SW pool summary
 * attached to the payload (the 2026-07-24 console-paste replacement), the
 * structured POST + screenshot follow-up pairing, and the capture-error
 * path (exactly one of png_base64 / error).
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type Mod = typeof import('./debug-snapshot');

const postToPlugin = vi.fn();
const ensureConnected = vi.fn();
const getActuatorJson = vi.fn();
const poolSnapshot = vi.fn();

async function load(): Promise<Mod> {
  vi.resetModules();
  vi.doMock('../plugin/actuator-client', () => ({ postToPlugin, ensureConnected, getActuatorJson }));
  vi.doMock('../debug/reconcile', () => ({
    buildReconcileReport: () => ({ verdict: ['ok'], counts: {} }),
  }));
  vi.doMock('../labels/label-pool', () => ({ poolSnapshot }));
  return await import('./debug-snapshot');
}

const sender = { tab: { id: 7, windowId: 3 } } as chrome.runtime.MessageSender;

beforeEach(() => {
  vi.clearAllMocks();
  ensureConnected.mockResolvedValue(true);
  getActuatorJson.mockResolvedValue(null);
  postToPlugin.mockResolvedValue({ ok: true, status: 200 });
  poolSnapshot.mockResolvedValue({ free: 600, assigned_by_doc: { d1: 10 }, reserved_by_doc: {}, stale_reservations: 0 });
  vi.stubGlobal('chrome', {
    tabs: {
      captureVisibleTab: vi.fn(async () => 'data:image/png;base64,QUJD'),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('../plugin/actuator-client');
  vi.doUnmock('../debug/reconcile');
  vi.doUnmock('../labels/label-pool');
});

describe('handleDebugSnapshot', () => {
  it('bails without posting when the plugin is unreachable', async () => {
    ensureConnected.mockResolvedValue(false);
    const m = await load();
    await m.handleDebugSnapshot({ snapshot_id: 's1' }, sender);
    expect(postToPlugin).not.toHaveBeenCalled();
  });

  it('attaches the SW pool summary and posts snapshot + screenshot', async () => {
    const m = await load();
    const payload: Record<string, unknown> = { snapshot_id: 's1', wrappers: [] };
    await m.handleDebugSnapshot(payload, sender);
    expect(poolSnapshot).toHaveBeenCalledWith(7);
    expect(payload.sw_pool).toMatchObject({ free: 600 });
    const endpoints = postToPlugin.mock.calls.map(([e]) => e);
    expect(endpoints).toEqual(['/debug-snapshot', '/debug-snapshot/screenshot']);
    expect(postToPlugin.mock.calls[1][1]).toMatchObject({ snapshot_id: 's1', png_base64: 'QUJD' });
  });

  it('a capture failure sends the error instead of a png', async () => {
    (globalThis as { chrome: { tabs: { captureVisibleTab: unknown } } }).chrome.tabs.captureVisibleTab =
      vi.fn(async () => { throw new Error('no window'); });
    const m = await load();
    await m.handleDebugSnapshot({ snapshot_id: 's1' }, sender);
    const follow = postToPlugin.mock.calls[1][1];
    expect(follow.error).toBe('no window');
    expect('png_base64' in follow).toBe(false);
  });

  it('a pool read failure never blocks the snapshot', async () => {
    poolSnapshot.mockRejectedValue(new Error('boom'));
    const m = await load();
    await m.handleDebugSnapshot({ snapshot_id: 's1' }, sender);
    expect(postToPlugin).toHaveBeenCalledWith('/debug-snapshot', expect.anything());
  });
});
