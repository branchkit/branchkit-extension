/**
 * BranchKit Browser — command-phrase override/alias message unit tests.
 *
 * Pins what the keymap editor depends on: the camelCase→snake_case body
 * mapping (a silent wire break if it drifts), the status→message translation
 * that keeps raw "404 page not found" off the editor, and the rule that a
 * disconnected host answers an empty list rather than rejecting.
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

type Mod = typeof import('./command-overrides');

const ensureConnected = vi.fn();
const postToPlugin = vi.fn();
const getFromPlugin = vi.fn();

async function load(): Promise<Mod> {
  vi.resetModules();
  vi.doMock('../plugin/actuator-client', () => ({ ensureConnected, postToPlugin, getFromPlugin }));
  return await import('./command-overrides');
}

const resp = (status: number, body = '') => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => body,
}) as unknown as Response;

beforeEach(() => {
  vi.clearAllMocks();
  ensureConnected.mockResolvedValue(true);
});

describe('reads', () => {
  it('returns the plugin list when connected', async () => {
    const { commandOverrideMessageHandlers: h } = await load();
    getFromPlugin.mockResolvedValue({ overrides: [{ action: 'scroll_down' }] });

    await expect(h.GET_COMMAND_OVERRIDES({ type: 'GET_COMMAND_OVERRIDES' }, {} as any))
      .resolves.toEqual({ overrides: [{ action: 'scroll_down' }] });
    expect(getFromPlugin).toHaveBeenCalledWith('/commands/overrides');
  });

  it('answers an empty list when the host is not running', async () => {
    const { commandOverrideMessageHandlers: h } = await load();
    ensureConnected.mockRejectedValue(new Error('no host'));

    // Resolving (not rejecting) matters: the router would otherwise treat this
    // as an escaped handler error and close the channel with undefined.
    await expect(h.GET_COMMAND_ALIASES({ type: 'GET_COMMAND_ALIASES' }, {} as any))
      .resolves.toEqual({ aliases: [] });
  });

  it('tolerates a malformed body without throwing', async () => {
    const { commandOverrideMessageHandlers: h } = await load();

    for (const body of [null, undefined, {}, { overrides: 'nope' }, 'text']) {
      getFromPlugin.mockResolvedValue(body);
      await expect(h.GET_COMMAND_OVERRIDES({ type: 'x' }, {} as any))
        .resolves.toEqual({ overrides: [] });
    }
  });
});

describe('writes map camelCase message fields onto the snake_case wire', () => {
  it('SET_COMMAND_OVERRIDE', async () => {
    const { commandOverrideMessageHandlers: h } = await load();
    postToPlugin.mockResolvedValue(resp(200));

    await h.SET_COMMAND_OVERRIDE(
      { type: 'SET_COMMAND_OVERRIDE', action: 'find_next', defaultPattern: 'next', newPattern: 'onward' },
      {} as any,
    );
    expect(postToPlugin).toHaveBeenCalledWith('/commands/override', {
      action: 'find_next', default_pattern: 'next', new_pattern: 'onward',
    });
  });

  it('RESET_COMMAND_OVERRIDE sends no new_pattern', async () => {
    const { commandOverrideMessageHandlers: h } = await load();
    postToPlugin.mockResolvedValue(resp(200));

    await h.RESET_COMMAND_OVERRIDE(
      { type: 'RESET_COMMAND_OVERRIDE', action: 'find_next', defaultPattern: 'next' },
      {} as any,
    );
    expect(postToPlugin).toHaveBeenCalledWith('/commands/override/reset', {
      action: 'find_next', default_pattern: 'next',
    });
  });

  it('alias add and remove hit their own routes', async () => {
    const { commandOverrideMessageHandlers: h } = await load();
    postToPlugin.mockResolvedValue(resp(200));
    const msg = { type: 'x', action: 'a', defaultPattern: 'd', newPattern: 'n' };

    await h.ADD_COMMAND_ALIAS(msg, {} as any);
    expect(postToPlugin).toHaveBeenLastCalledWith('/commands/alias', {
      action: 'a', default_pattern: 'd', new_pattern: 'n',
    });

    await h.REMOVE_COMMAND_ALIAS(msg, {} as any);
    expect(postToPlugin).toHaveBeenLastCalledWith('/commands/alias/remove', {
      action: 'a', default_pattern: 'd', new_pattern: 'n',
    });
  });
});

describe('write failures become editor-facing text', () => {
  const cases: Array<[string, Response | null, string]> = [
    ['400 relays the actuator validation detail', resp(400, 'reserved word'), 'reserved word'],
    ['400 with an empty body falls back', resp(400, '   '), 'That phrase isn’t allowed.'],
    ['404 means the host build is too old', resp(404), 'Update BranchKit — this build can’t edit voice phrases yet.'],
    ['500 is a transport problem', resp(500), 'Couldn’t save — is BranchKit up to date and running?'],
    ['a null response means not running', null, 'BranchKit isn’t running.'],
  ];

  for (const [name, r, expected] of cases) {
    it(name, async () => {
      const { commandOverrideMessageHandlers: h } = await load();
      postToPlugin.mockResolvedValue(r);

      await expect(h.SET_COMMAND_OVERRIDE({ type: 'x' }, {} as any))
        .resolves.toEqual({ ok: false, error: expected });
    });
  }

  it('a rejected write reports not-connected rather than rejecting', async () => {
    const { commandOverrideMessageHandlers: h } = await load();
    postToPlugin.mockRejectedValue(new Error('socket'));

    await expect(h.ADD_COMMAND_ALIAS({ type: 'x' }, {} as any))
      .resolves.toEqual({ ok: false, error: 'Not connected to BranchKit.' });
  });

  it('the ok-only writes report a bare boolean, with no error text', async () => {
    const { commandOverrideMessageHandlers: h } = await load();

    postToPlugin.mockResolvedValue(resp(200));
    await expect(h.REMOVE_COMMAND_ALIAS({ type: 'x' }, {} as any)).resolves.toEqual({ ok: true });

    postToPlugin.mockResolvedValue(resp(500));
    await expect(h.RESET_COMMAND_OVERRIDE({ type: 'x' }, {} as any)).resolves.toEqual({ ok: false });

    postToPlugin.mockRejectedValue(new Error('socket'));
    await expect(h.RESET_COMMAND_OVERRIDE({ type: 'x' }, {} as any)).resolves.toEqual({ ok: false });
  });
});
