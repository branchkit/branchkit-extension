/**
 * BranchKit Browser — plugin-api unit tests.
 *
 * Pins the typed endpoint wrappers' contracts: connection gating (forwarders
 * bail cleanly when the plugin isn't there), postGrammarBatch's transport-
 * failure shape (every element failed with reason "transport" so the content
 * script can unwind), its letter<->spoken translation at the plugin boundary,
 * and the conn_id stamp. Transport itself is faked via actuator-client.
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type PluginApi = typeof import('./plugin-api');

const postToPlugin = vi.fn();
const ensureConnected = vi.fn();
const getPluginPort = vi.fn();
const getPluginToken = vi.fn();
const connectSSE = vi.fn();

async function loadApi(): Promise<PluginApi> {
  vi.resetModules();
  vi.doMock('./actuator-client', () => ({
    postToPlugin, ensureConnected, getPluginPort, getPluginToken,
  }));
  vi.doMock('./sse-transport', () => ({ connectSSE }));
  return await import('./plugin-api');
}

function okResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  ensureConnected.mockResolvedValue(true);
  getPluginPort.mockReturnValue(21551);
  getPluginToken.mockReturnValue('tok');
  postToPlugin.mockResolvedValue(okResponse({}));
});

afterEach(() => {
  vi.doUnmock('./actuator-client');
  vi.doUnmock('./sse-transport');
});

describe('forwarders (connection gating)', () => {
  it('post to their endpoints when connected', async () => {
    const api = await loadApi();
    await api.forwardDebugLog('tag', { a: 1 });
    expect(postToPlugin).toHaveBeenCalledWith('/debug-log', { tag: 'tag', data: { a: 1 } });
    await api.forwardPluginDebugLog('t', {}, 'warn');
    expect(postToPlugin).toHaveBeenCalledWith('/plugin-debug-log', { tag: 't', data: {}, level: 'warn' });
    await api.forwardHintsSessionStart('tab_switch', 7);
    expect(postToPlugin).toHaveBeenCalledWith('/hints/session_start', { reason: 'tab_switch', tab_id: 7 });
  });

  it('bail without posting when the plugin is unreachable', async () => {
    ensureConnected.mockResolvedValue(false);
    const api = await loadApi();
    await api.forwardDebugLog('tag', {});
    await api.forwardDispatchResult({} as never);
    await api.forwardPerfReport({ url: '', tab_id: 1, browser: '', snapshot: {} });
    await api.forwardHintsSessionEnd('tab_closed', 1);
    expect(postToPlugin).not.toHaveBeenCalled();
  });

  it('session_end scopes to one frame only when frameId is present', async () => {
    const api = await loadApi();
    await api.forwardHintsSessionEnd('frame_liveness_disconnect', 3, 5);
    const body = postToPlugin.mock.calls[0][1];
    expect(body.frame_id).toBe(5);
    await api.forwardHintsSessionEnd('tab_closed', 3);
    const tabWide = postToPlugin.mock.calls[1][1];
    expect('frame_id' in tabWide).toBe(false);
    expect(typeof tabWide.conn_id).toBe('string'); // conn-scoped cleanup
  });
});

describe('postGrammarBatch', () => {
  const request = {
    elements: [{ codeword: 'c', selector: 'a' }, { codeword: 'g', selector: 'b' }],
  } as never;

  it('returns the transport-failure shape when the host is down', async () => {
    getPluginPort.mockReturnValue(null);
    ensureConnected.mockResolvedValue(false);
    const api = await loadApi();
    const resp = await api.postGrammarBatch(1, 0, request);
    expect(resp.result).toBe('error');
    expect(resp.succeeded).toEqual([]);
    expect(resp.failed).toEqual([
      { codeword: 'c', reason: 'transport' },
      { codeword: 'g', reason: 'transport' },
    ]);
    expect(connectSSE).not.toHaveBeenCalled();
  });

  it('with fresh creds after a cold start, brings the SSE up too', async () => {
    getPluginPort.mockReturnValue(null); // no creds yet
    ensureConnected.mockResolvedValue(true); // discovery finds the host
    postToPlugin.mockResolvedValue(okResponse({ result: 'ok', succeeded: [], failed: [] }));
    const api = await loadApi();
    await api.postGrammarBatch(1, 0, request);
    expect(connectSSE).toHaveBeenCalledTimes(1);
  });

  it('stamps tab/frame/conn ids and passes letter tokens through with no overlay', async () => {
    postToPlugin.mockResolvedValue(okResponse({ result: 'ok', succeeded: ['c'], failed: [] }));
    const api = await loadApi();
    const resp = await api.postGrammarBatch(9, 2, request);
    const [endpoint, body] = postToPlugin.mock.calls[0];
    expect(endpoint).toBe('/grammar/batch');
    expect(body.tab_id).toBe(9);
    expect(body.frame_id).toBe(2);
    expect(typeof body.conn_id).toBe('string');
    // No alphabet overlay loaded in this realm → identity translation.
    expect(body.elements.map((e: { codeword: string }) => e.codeword)).toEqual(['c', 'g']);
    expect(resp.succeeded).toEqual(['c']);
  });

  it('maps an unparseable response to the transport-failure shape', async () => {
    postToPlugin.mockResolvedValue({ ok: true, json: async () => { throw new Error('bad'); } });
    const api = await loadApi();
    const resp = await api.postGrammarBatch(1, 0, request);
    expect(resp.result).toBe('error');
    expect(resp.failed).toHaveLength(2);
  });
});

describe('focus signals', () => {
  it('postFocus and postActiveTab are bail-on-miss (no ensureConnected)', async () => {
    const api = await loadApi();
    await api.postFocus(true);
    await api.postActiveTab(4);
    expect(ensureConnected).not.toHaveBeenCalled();
    expect(postToPlugin).toHaveBeenCalledWith('/focus', expect.objectContaining({ focused: true }));
    expect(postToPlugin).toHaveBeenCalledWith('/active-tab', expect.objectContaining({ tab_id: 4 }));
  });

  it('postActiveTab drops a null tab id', async () => {
    const api = await loadApi();
    await api.postActiveTab(null);
    expect(postToPlugin).not.toHaveBeenCalled();
  });
});
