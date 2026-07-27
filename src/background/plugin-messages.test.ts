/**
 * BranchKit Browser — plugin-forwarding message unit tests.
 *
 * Every handler here exists to stamp sender identity onto a payload the content
 * script couldn't complete itself, so that stamping is what these pin: the
 * frame_id written onto every grammar element, the tab id taken from the
 * sender, and the SPA-navigation URL preference that keeps /watch perf samples
 * attributed correctly.
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

type Mod = typeof import('./plugin-messages');

const forwardDispatchResult = vi.fn();
const forwardDebugLog = vi.fn();
const forwardPerfReport = vi.fn();
const postGrammarBatch = vi.fn();
const transportFailure = vi.fn();
const setRangePick = vi.fn();
const setQueryFieldActive = vi.fn();

async function load(): Promise<Mod> {
  vi.resetModules();
  vi.doMock('../plugin/plugin-api', () => ({
    forwardDispatchResult, forwardDebugLog, forwardPerfReport, postGrammarBatch,
    transportFailure, setRangePick, setQueryFieldActive,
  }));
  return await import('./plugin-messages');
}

const inTab = { tab: { id: 3, url: 'https://youtube.com/' }, frameId: 2, url: 'https://youtube.com/' } as any;
const noTab = { frameId: 2 } as any;

beforeEach(() => {
  vi.clearAllMocks();
  postGrammarBatch.mockResolvedValue({ ok: true });
  transportFailure.mockReturnValue({ ok: false, reason: 'no_transport' });
  setRangePick.mockResolvedValue(undefined);
  setQueryFieldActive.mockResolvedValue(undefined);
});

describe('GRAMMAR_BATCH', () => {
  it('stamps the sender frame id onto every element before posting', async () => {
    const { pluginMessageHandlers: h } = await load();
    const request = { elements: [{ id: 'a' }, { id: 'b' }] };

    await h.GRAMMAR_BATCH({ type: 'GRAMMAR_BATCH', request }, inTab);

    expect(request.elements).toEqual([{ id: 'a', frame_id: 2 }, { id: 'b', frame_id: 2 }]);
    expect(postGrammarBatch).toHaveBeenCalledWith(3, 2, request);
  });

  it('answers a transport failure when there is no tab or frame context', async () => {
    const { pluginMessageHandlers: h } = await load();
    const request = { elements: [] };

    expect(h.GRAMMAR_BATCH({ type: 'x', request }, noTab)).toEqual({ ok: false, reason: 'no_transport' });
    expect(transportFailure).toHaveBeenCalledWith(request);
    expect(postGrammarBatch).not.toHaveBeenCalled();
  });

  it('returns the post promise so the router holds the channel open', async () => {
    const { pluginMessageHandlers: h } = await load();
    const result = h.GRAMMAR_BATCH({ type: 'x', request: { elements: [] } }, inTab);

    expect(typeof (result as { then?: unknown })?.then).toBe('function');
    await expect(result).resolves.toEqual({ ok: true });
  });
});

describe('PERF_REPORT', () => {
  it('prefers the live location over the injected sender URL', async () => {
    const { pluginMessageHandlers: h } = await load();
    // sender.url is where the script was INJECTED; it does not follow SPA nav.
    const sender = { tab: { id: 3 }, url: 'https://youtube.com/' } as any;

    h.PERF_REPORT(
      { type: 'x', snapshot: { a: 1 }, url: 'https://youtube.com/watch?v=1', browser: 'chrome' },
      sender,
    );

    expect(forwardPerfReport).toHaveBeenCalledWith({
      url: 'https://youtube.com/watch?v=1', tab_id: 3, browser: 'chrome', snapshot: { a: 1 },
    });
  });

  it('falls back to the sender URL, then to empty', async () => {
    const { pluginMessageHandlers: h } = await load();

    h.PERF_REPORT({ type: 'x', snapshot: {} }, { tab: { id: 3 }, url: 'https://a.test/' } as any);
    expect(forwardPerfReport).toHaveBeenLastCalledWith(
      expect.objectContaining({ url: 'https://a.test/' }),
    );

    h.PERF_REPORT({ type: 'x', snapshot: {} }, {} as any);
    expect(forwardPerfReport).toHaveBeenLastCalledWith(
      expect.objectContaining({ url: '', tab_id: -1, browser: 'unknown' }),
    );
  });

  it('ignores a report with no snapshot', async () => {
    const { pluginMessageHandlers: h } = await load();

    h.PERF_REPORT({ type: 'x' }, inTab);
    expect(forwardPerfReport).not.toHaveBeenCalled();
  });
});

describe('RANGE_PICK', () => {
  it('arms with the sender tab id', async () => {
    const { pluginMessageHandlers: h } = await load();

    h.RANGE_PICK({ type: 'x', codewords: ['ape'] }, inTab);
    expect(setRangePick).toHaveBeenCalledWith(3, ['ape']);
  });

  it('forwards a release even with no tab id, but not an arm', async () => {
    const { pluginMessageHandlers: h } = await load();

    // Releases are honored from any source; the tab id is only read on arm.
    h.RANGE_PICK({ type: 'x', codewords: [] }, noTab);
    expect(setRangePick).toHaveBeenCalledWith(0, []);

    setRangePick.mockClear();
    h.RANGE_PICK({ type: 'x', codewords: ['ape'] }, noTab);
    expect(setRangePick).not.toHaveBeenCalled();
  });
});

describe('fire-and-forget forwards', () => {
  it('answer nothing so the router closes the channel', async () => {
    const { pluginMessageHandlers: h } = await load();

    expect(h.DISPATCH_RESULT({ type: 'x', payload: { a: 1 } }, inTab)).toBeUndefined();
    expect(forwardDispatchResult).toHaveBeenCalledWith({ a: 1 });

    expect(h.QUERY_FIELD_ACTIVE({ type: 'x', active: true }, inTab)).toBeUndefined();
    expect(setQueryFieldActive).toHaveBeenCalledWith(true);
  });

  it('DEBUG_LOG requires a string tag', async () => {
    const { pluginMessageHandlers: h } = await load();

    h.DEBUG_LOG({ type: 'x', tag: 'a.b', data: { n: 1 } }, inTab);
    expect(forwardDebugLog).toHaveBeenCalledWith('a.b', { n: 1 });

    forwardDebugLog.mockClear();
    for (const tag of [undefined, 42, null, {}]) {
      h.DEBUG_LOG({ type: 'x', tag, data: {} }, inTab);
    }
    expect(forwardDebugLog).not.toHaveBeenCalled();
  });
});
