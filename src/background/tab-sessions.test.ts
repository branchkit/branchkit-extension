/**
 * BranchKit Browser — tab-session upkeep unit tests.
 *
 * Pins the SPA-rescan coalescer: the 150ms debounce, the identical-URL dedup
 * window (the YouTube Shorts re-announce case), the breadcrumb on
 * suppression, and cancelSpaRescan's cleanup on tab close. purgeTab's fanout
 * is pinned as a contract (stack + codeword memory).
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type TabSessions = typeof import('./tab-sessions');

const forwardDebugLog = vi.fn();
const clearStack = vi.fn().mockResolvedValue(undefined);
const clearCodewordMemory = vi.fn().mockResolvedValue(undefined);
const sweepDeadStacks = vi.fn().mockResolvedValue([]);
const sentMessages: Array<{ tabId: number; msg: { payload?: { action: string; params?: Record<string, string> } } }> = [];

async function loadTabSessions(): Promise<TabSessions> {
  vi.resetModules();
  vi.doMock('../plugin/plugin-api', () => ({ forwardDebugLog }));
  vi.doMock('../labels/label-pool', () => ({ clearStack, sweepDeadStacks }));
  vi.doMock('../labels/codeword-memory', () => ({ clearCodewordMemory }));
  return await import('./tab-sessions');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  sentMessages.length = 0;
  vi.stubGlobal('chrome', {
    tabs: {
      sendMessage: vi.fn(async (tabId: number, msg: never) => { sentMessages.push({ tabId, msg }); }),
      get: vi.fn(async (id: number) => ({ id, url: 'https://x.com', title: 't' })),
      query: vi.fn(async () => []),
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.doUnmock('../plugin/plugin-api');
  vi.doUnmock('../labels/label-pool');
  vi.doUnmock('../labels/codeword-memory');
});

describe('scheduleSpaRescan', () => {
  it('debounces a burst into one rescan dispatch', async () => {
    const ts = await loadTabSessions();
    ts.scheduleSpaRescan(1, 'https://a.com/x');
    ts.scheduleSpaRescan(1, 'https://a.com/y');
    ts.scheduleSpaRescan(1, 'https://a.com/z');
    await vi.advanceTimersByTimeAsync(200);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].msg.payload).toMatchObject({ action: 'rescan', params: { reason: 'spa_nav' } });
  });

  it('suppresses an identical-URL re-dispatch inside the dedup window, with a breadcrumb', async () => {
    const ts = await loadTabSessions();
    ts.scheduleSpaRescan(1, 'https://a.com/x');
    await vi.advanceTimersByTimeAsync(200);
    ts.scheduleSpaRescan(1, 'https://a.com/x'); // same route re-announced
    await vi.advanceTimersByTimeAsync(200);
    expect(sentMessages).toHaveLength(1);
    expect(forwardDebugLog).toHaveBeenCalledWith('pipeline.bg_rescan_deduped', expect.objectContaining({ tab_id: 1 }));
  });

  it('a different URL inside the window still dispatches', async () => {
    const ts = await loadTabSessions();
    ts.scheduleSpaRescan(1, 'https://a.com/x');
    await vi.advanceTimersByTimeAsync(200);
    ts.scheduleSpaRescan(1, 'https://a.com/other');
    await vi.advanceTimersByTimeAsync(200);
    expect(sentMessages).toHaveLength(2);
  });

  it('the same URL dispatches again after the dedup window expires', async () => {
    const ts = await loadTabSessions();
    ts.scheduleSpaRescan(1, 'https://a.com/x');
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(2100); // past SPA_RESCAN_DEDUP_MS
    ts.scheduleSpaRescan(1, 'https://a.com/x');
    await vi.advanceTimersByTimeAsync(200);
    expect(sentMessages).toHaveLength(2);
  });

  it('cancelSpaRescan drops the pending timer and the dedup memory', async () => {
    const ts = await loadTabSessions();
    ts.scheduleSpaRescan(1, 'https://a.com/x');
    ts.cancelSpaRescan(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(sentMessages).toHaveLength(0);
  });
});

describe('purgeTab', () => {
  it('clears the label stack and the tab-wide codeword memory', async () => {
    const ts = await loadTabSessions();
    ts.purgeTab(7);
    expect(clearStack).toHaveBeenCalledWith(7);
    expect(clearCodewordMemory).toHaveBeenCalledWith(7);
  });
});

describe('logTabSwitch', () => {
  it('breadcrumbs both sides, tolerating a dead tab', async () => {
    const ts = await loadTabSessions();
    (chrome.tabs.get as ReturnType<typeof vi.fn>).mockImplementation(async (id: number) => {
      if (id === 2) throw new Error('gone');
      return { id, url: 'https://x.com', title: 't' };
    });
    await ts.logTabSwitch('tab_activated', 2, 3);
    expect(forwardDebugLog).toHaveBeenCalledWith('tab_switch', expect.objectContaining({
      from: expect.objectContaining({ url: '<gone>' }),
      to: expect.objectContaining({ id: 3 }),
    }));
  });
});
