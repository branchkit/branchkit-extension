/**
 * BranchKit Browser — pool-audit tripwire unit tests.
 *
 * Pins the report-only contract: armed only in dev builds, first audit on
 * the boot timer then a pausable interval, divergence reported with full
 * label lists, clean audits and empty pages silent.
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type PoolAudit = typeof import('./pool-audit');

const bkLog = vi.fn();
const sendMessage = vi.fn();
let hooksEnabled = true;
const timeouts: Array<{ fn: () => void; ms: number }> = [];
const intervals: Array<{ fn: () => void; ms: number }> = [];
const wrappers: Array<{ scanned: { codeword: string } }> = [];
const fakeSession = {
  isTornDown: false,
  resources: {
    timeout: (fn: () => void, ms: number) => { timeouts.push({ fn, ms }); return 1 as never; },
    pausableInterval: (fn: () => void, ms: number) => { intervals.push({ fn, ms }); },
  },
};

async function loadAudit(): Promise<PoolAudit> {
  vi.resetModules();
  vi.doMock('../core/store', () => ({ store: { get all() { return wrappers; } } }));
  vi.doMock('../lifecycle/page-session', () => ({ pageSession: fakeSession }));
  vi.doMock('../labels/document-identity', () => ({ documentInstanceId: 'doc-test' }));
  vi.doMock('./harness-hooks', () => ({ harnessHooksEnabled: () => hooksEnabled }));
  vi.doMock('./bk-log', () => ({ bkLog }));
  return await import('./pool-audit');
}

beforeEach(() => {
  vi.clearAllMocks();
  hooksEnabled = true;
  timeouts.length = 0;
  intervals.length = 0;
  wrappers.length = 0;
  fakeSession.isTornDown = false;
  sendMessage.mockResolvedValue({ unroutable: [], foreign: [] });
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('../core/store');
  vi.doUnmock('../lifecycle/page-session');
  vi.doUnmock('../labels/document-identity');
  vi.doUnmock('./harness-hooks');
  vi.doUnmock('./bk-log');
});

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe('initPoolAudit', () => {
  it('arms a boot timer and a pausable interval in dev builds', async () => {
    const audit = await loadAudit();
    audit.initPoolAudit();
    expect(timeouts).toHaveLength(1);
    expect(intervals).toHaveLength(1);
  });

  it('is a complete no-op in release builds', async () => {
    hooksEnabled = false;
    const audit = await loadAudit();
    audit.initPoolAudit();
    expect(timeouts).toHaveLength(0);
    expect(intervals).toHaveLength(0);
  });

  it('reports divergence with full label lists, stamped with the doc id', async () => {
    const audit = await loadAudit();
    wrappers.push({ scanned: { codeword: 'a w' } }, { scanned: { codeword: 'd d' } });
    sendMessage.mockResolvedValue({ unroutable: ['a w'], foreign: ['d d'] });
    audit.initPoolAudit();
    timeouts[0].fn();
    await flush();
    expect(sendMessage).toHaveBeenCalledWith({
      type: 'POOL_AUDIT', doc_id: 'doc-test', labels: ['a w', 'd d'],
    });
    expect(bkLog).toHaveBeenCalledWith('BK_POOL_AUDIT_DIVERGENCE', expect.objectContaining({
      unroutable: 1, foreign: 1, unroutable_labels: ['a w'], foreign_labels: ['d d'],
    }));
  });

  it('stays silent when the pool agrees, and skips empty pages entirely', async () => {
    const audit = await loadAudit();
    wrappers.push({ scanned: { codeword: 'a w' } });
    audit.initPoolAudit();
    timeouts[0].fn();
    await flush();
    expect(bkLog).not.toHaveBeenCalled();
    // Empty page: no message at all.
    sendMessage.mockClear();
    wrappers.length = 0;
    intervals[0].fn();
    await flush();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does not audit a torn-down session', async () => {
    const audit = await loadAudit();
    wrappers.push({ scanned: { codeword: 'a w' } });
    fakeSession.isTornDown = true;
    audit.initPoolAudit();
    timeouts[0].fn();
    await flush();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
