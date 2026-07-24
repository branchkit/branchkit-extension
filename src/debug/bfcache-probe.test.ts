/**
 * BranchKit Browser — bfcache liveness-port probe unit tests (layer 2).
 *
 * Pins the report-only contract: two samples per restore (instant + 2s
 * settled), the (ctx, port, sw_tracked) verdict recorded faithfully in the
 * dataset mirror even when the context is dead, no-op in release builds.
 *
 * Run: npm test
 */

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type Probe = typeof import('./bfcache-probe');

const bkLog = vi.fn();
const sendMessage = vi.fn();
let hooksEnabled = true;
let portState: 'absent' | 'post_ok' | 'post_threw' = 'post_ok';
const timeouts: Array<{ fn: () => void; ms: number }> = [];
const fakeSession = {
  resources: {
    timeout: (fn: () => void, ms: number) => { timeouts.push({ fn, ms }); return 1 as never; },
  },
};

async function loadProbe(): Promise<Probe> {
  vi.resetModules();
  vi.doMock('../lifecycle/page-session', () => ({ pageSession: fakeSession }));
  vi.doMock('../labels/document-identity', () => ({ documentInstanceId: 'doc-test' }));
  vi.doMock('../plugin/liveness', () => ({ probeLivenessPortState: () => portState }));
  vi.doMock('./harness-hooks', () => ({ harnessHooksEnabled: () => hooksEnabled }));
  vi.doMock('./bk-log', () => ({ bkLog }));
  return await import('./bfcache-probe');
}

function mirror(): Array<Record<string, unknown>> {
  return JSON.parse(document.documentElement.dataset.branchkitBfcacheProbe!);
}

beforeEach(() => {
  vi.clearAllMocks();
  hooksEnabled = true;
  portState = 'post_ok';
  timeouts.length = 0;
  delete document.documentElement.dataset.branchkitBfcacheProbe;
  sendMessage.mockResolvedValue({ tracked: true });
  vi.stubGlobal('chrome', { runtime: { id: 'ext-id', sendMessage } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('../lifecycle/page-session');
  vi.doUnmock('../labels/document-identity');
  vi.doUnmock('../plugin/liveness');
  vi.doUnmock('./harness-hooks');
  vi.doUnmock('./bk-log');
});

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe('probeBfcacheRestore', () => {
  it('samples at restore and schedules the 2s settled sample via the registry', async () => {
    const probe = await loadProbe();
    probe.probeBfcacheRestore();
    await flush();
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0].ms).toBe(2_000);
    expect(mirror()).toMatchObject([
      { when: 'restore', ctx_valid: true, port: 'post_ok', sw_tracked: true },
    ]);
    timeouts[0].fn();
    await flush();
    expect(mirror()).toHaveLength(2);
    expect(mirror()[1]).toMatchObject({ when: 'settled' });
    expect(sendMessage).toHaveBeenCalledWith({ type: 'LIVENESS_QUERY', doc_id: 'doc-test' });
  });

  it('records the silently-dead verdict: port open CS-side, SW not tracking', async () => {
    const probe = await loadProbe();
    sendMessage.mockResolvedValue({ tracked: false });
    probe.probeBfcacheRestore();
    await flush();
    expect(mirror()[0]).toMatchObject({ port: 'post_ok', sw_tracked: false });
    expect(bkLog).toHaveBeenCalledWith('BK_BFCACHE_PORT_PROBE', expect.objectContaining({
      port: 'post_ok', sw_tracked: false,
    }));
  });

  it('a dead context still lands in the dataset mirror (bkLog transport is gone)', async () => {
    const probe = await loadProbe();
    vi.stubGlobal('chrome', { runtime: {} }); // reloaded-out-from-under: no id
    portState = 'post_threw';
    probe.probeBfcacheRestore();
    await flush();
    expect(mirror()[0]).toMatchObject({ ctx_valid: false, port: 'post_threw', sw_tracked: null });
    expect(sendMessage).not.toHaveBeenCalled(); // no query attempt on a dead context
  });

  it('SW asleep mid-query stays null, not false', async () => {
    const probe = await loadProbe();
    sendMessage.mockRejectedValue(new Error('SW asleep'));
    probe.probeBfcacheRestore();
    await flush();
    expect(mirror()[0]).toMatchObject({ ctx_valid: true, sw_tracked: null });
  });

  it('is a complete no-op in release builds', async () => {
    hooksEnabled = false;
    const probe = await loadProbe();
    probe.probeBfcacheRestore();
    await flush();
    expect(timeouts).toHaveLength(0);
    expect(document.documentElement.dataset.branchkitBfcacheProbe).toBeUndefined();
    expect(bkLog).not.toHaveBeenCalled();
  });

  it('caps the sample history at 10, newest kept', async () => {
    const probe = await loadProbe();
    for (let i = 0; i < 7; i++) {
      probe.probeBfcacheRestore();
      await flush();
    }
    for (const t of timeouts) t.fn();
    await flush();
    const s = mirror();
    expect(s).toHaveLength(10);
    expect(s[s.length - 1]).toMatchObject({ when: 'settled' });
  });
});
