/**
 * BranchKit Browser — actuator-client unit tests.
 *
 * Pins the connection postures the background.ts forwarders depend on:
 * discover parses the status endpoint, postToPlugin bails (no fetch) when not
 * connected vs. issues an authed POST when connected, and ensureConnected
 * discovers only on miss. Each test gets a fresh module (resetModules) so the
 * connection singleton doesn't leak between cases.
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

let fetchMock: ReturnType<typeof vi.fn>;
let mod: typeof import('./actuator-client');

function statusOk(port = 1234, token = 'tok') {
  return { ok: true, json: async () => ({ enabled: true, listen: { port, token } }) };
}

beforeEach(async () => {
  vi.resetModules();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  mod = await import('./actuator-client');
});

describe('discoverPlugin', () => {
  it('caches port + token from a valid status response', async () => {
    fetchMock.mockResolvedValueOnce(statusOk(4321, 'secret'));
    const ok = await mod.discoverPlugin();
    expect(ok).toBe(true);
    expect(mod.getPluginPort()).toBe(4321);
    expect(mod.getPluginToken()).toBe('secret');
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:21551/v1/plugins/browser/status');
  });

  it('returns false (and stays disconnected) when the plugin is disabled', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ enabled: false }) });
    expect(await mod.discoverPlugin()).toBe(false);
    expect(mod.getPluginPort()).toBeNull();
  });

  it('returns false when the status request throws', async () => {
    fetchMock.mockRejectedValueOnce(new Error('refused'));
    expect(await mod.discoverPlugin()).toBe(false);
  });
});

describe('postToPlugin', () => {
  it('bails without fetching when not connected', async () => {
    const res = await mod.postToPlugin('/dispatch-result', { a: 1 });
    expect(res).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('issues an authed POST once connected', async () => {
    fetchMock.mockResolvedValueOnce(statusOk(1234, 'tok'));
    await mod.discoverPlugin();
    fetchMock.mockResolvedValueOnce({ ok: true });

    await mod.postToPlugin('/debug-log', { tag: 't', data: 1 });

    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://127.0.0.1:1234/debug-log',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer tok' }),
        body: JSON.stringify({ tag: 't', data: 1 }),
      }),
    );
  });

  it('returns null (not throw) when the POST rejects', async () => {
    fetchMock.mockResolvedValueOnce(statusOk());
    await mod.discoverPlugin();
    fetchMock.mockRejectedValueOnce(new Error('down'));
    expect(await mod.postToPlugin('/x', {})).toBeNull();
  });
});

describe('ensureConnected', () => {
  it('discovers on miss', async () => {
    fetchMock.mockResolvedValueOnce(statusOk());
    expect(await mod.ensureConnected()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when already connected', async () => {
    fetchMock.mockResolvedValueOnce(statusOk());
    await mod.ensureConnected(); // 1 status fetch
    expect(await mod.ensureConnected()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no second status fetch
  });
});

describe('voice pause gate', () => {
  it('setVoicePaused(true) makes ensureConnected refuse and drops cached creds', async () => {
    fetchMock.mockResolvedValueOnce(statusOk());
    await mod.ensureConnected();
    expect(mod.getPluginToken()).not.toBeNull();

    mod.setVoicePaused(true);
    expect(mod.getPluginPort()).toBeNull();   // cached creds dropped
    expect(mod.getPluginToken()).toBeNull();

    fetchMock.mockClear();
    expect(await mod.ensureConnected()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled(); // no rediscovery while paused
  });

  it('paused discoverPlugin bails before fetching', async () => {
    mod.setVoicePaused(true);
    expect(await mod.discoverPlugin()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resume (setVoicePaused(false)) restores normal discovery', async () => {
    mod.setVoicePaused(true);
    mod.setVoicePaused(false);
    fetchMock.mockResolvedValueOnce(statusOk(999, 'back'));
    expect(await mod.ensureConnected()).toBe(true);
    expect(mod.getPluginToken()).toBe('back');
  });
});
