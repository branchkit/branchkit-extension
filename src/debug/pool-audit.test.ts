/**
 * BranchKit Browser — pool-audit tripwire unit tests.
 *
 * Pins the report-only contract: armed only in dev builds, first audit on
 * the boot timer then a pausable interval, divergence reported with full
 * label lists, clean audits and empty pages silent.
 *
 * Run: npm test
 */

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type PoolAudit = typeof import('./pool-audit');

const bkLog = vi.fn();
const sendMessage = vi.fn();
let hooksEnabled = true;
const timeouts: Array<{ fn: () => void; ms: number }> = [];
const intervals: Array<{ fn: () => void; ms: number }> = [];
const wrappers: Array<{ scanned: { codeword: string } }> = [];
const listeners: Array<{ ev: string; fn: () => void }> = [];
const fakeSession = {
  isTornDown: false,
  resources: {
    timeout: (fn: () => void, ms: number) => { timeouts.push({ fn, ms }); return 1 as never; },
    pausableInterval: (fn: () => void, ms: number) => { intervals.push({ fn, ms }); },
    listen: (_t: unknown, ev: string, fn: () => void) => { listeners.push({ ev, fn }); },
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

function addHost(doc: string | null, hint = 'true'): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('data-branchkit-hint', hint);
  if (doc !== null) el.setAttribute('data-branchkit-doc', doc);
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  vi.clearAllMocks();
  hooksEnabled = true;
  timeouts.length = 0;
  intervals.length = 0;
  listeners.length = 0;
  delete document.documentElement.dataset.branchkitPoolAudit;
  for (const n of document.querySelectorAll('[data-branchkit-hint]')) n.remove();
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
  it('on-demand audit mirrors the FULL result (clean or not) to the dataset attribute', async () => {
    const audit = await loadAudit();
    wrappers.push({ scanned: { codeword: 'a w' } });
    audit.initPoolAudit();
    const hook = listeners.find((l) => l.ev === '__branchkit__pool_audit');
    expect(hook).toBeDefined();
    // Clean result still mirrors (the harness needs a positive signal).
    hook!.fn();
    await flush();
    const clean = JSON.parse(document.documentElement.dataset.branchkitPoolAudit!);
    expect(clean).toMatchObject({ seq: 1, held: 1, unroutable: [], foreign: [] });
    // Divergent result mirrors AND breadcrumbs.
    sendMessage.mockResolvedValue({ unroutable: ['a w'], foreign: [] });
    hook!.fn();
    await flush();
    const dirty = JSON.parse(document.documentElement.dataset.branchkitPoolAudit!);
    expect(dirty).toMatchObject({ seq: 2, unroutable: ['a w'] });
    await flush();
    expect(bkLog).toHaveBeenCalledWith('BK_POOL_AUDIT_DIVERGENCE', expect.objectContaining({ trigger: 'on_demand' }));
  });
});

describe('orphan-paint tripwire (stale badge hosts)', () => {
  it('counts hosts stamped by another context; own and auxiliary hosts are clean', async () => {
    const audit = await loadAudit();
    addHost('doc-test'); // ours
    addHost('doc-elder'); // stale paint
    addHost('doc-elder'); // same elder, second host
    addHost(null, ''); // auxiliary UI (toast/chip) — out of scope
    const paint = audit.countForeignBadgeHosts();
    expect(paint.count).toBe(2);
    expect(paint.docs).toEqual(['doc-elder']);
  });

  it('an unstamped badge host reads as stale (pre-stamp painter)', async () => {
    const audit = await loadAudit();
    addHost(null);
    expect(audit.countForeignBadgeHosts()).toEqual({ count: 1, docs: ['unstamped'] });
  });

  it('reports stale paint on the periodic sweep even with an empty store (no SW roundtrip)', async () => {
    const audit = await loadAudit();
    addHost('doc-elder');
    audit.initPoolAudit();
    intervals[0].fn();
    await flush();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(bkLog).toHaveBeenCalledWith('BK_STALE_PAINT', expect.objectContaining({
      trigger: 'interval', stale_hosts: 1, stale_docs: ['doc-elder'], live_doc: 'doc-test',
    }), 'warn');
  });

  it('on-demand payload carries the stale fields; harness assertClean sees them', async () => {
    const audit = await loadAudit();
    addHost('doc-elder');
    audit.initPoolAudit();
    listeners.find((l) => l.ev === '__branchkit__pool_audit')!.fn();
    await flush();
    const payload = JSON.parse(document.documentElement.dataset.branchkitPoolAudit!);
    expect(payload).toMatchObject({ held: 0, stale_hosts: 1, stale_docs: ['doc-elder'] });
  });

  it('still carries a real stale count when the SW is unreachable (held -1)', async () => {
    const audit = await loadAudit();
    wrappers.push({ scanned: { codeword: 'a w' } });
    sendMessage.mockRejectedValue(new Error('SW asleep'));
    addHost('doc-elder');
    audit.initPoolAudit();
    listeners.find((l) => l.ev === '__branchkit__pool_audit')!.fn();
    await flush();
    const payload = JSON.parse(document.documentElement.dataset.branchkitPoolAudit!);
    expect(payload).toMatchObject({ held: -1, stale_hosts: 1 });
  });

  it('clean paint stays silent', async () => {
    const audit = await loadAudit();
    addHost('doc-test');
    audit.initPoolAudit();
    intervals[0].fn();
    await flush();
    expect(bkLog).not.toHaveBeenCalled();
  });
});
