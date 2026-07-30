/**
 * BranchKit Browser — palette voice-session unit tests.
 *
 * Pins the session lifecycle: publish installs the row map, voice select
 * resolves through it (unknown/stale row id → plain close), clear is
 * idempotent and drains the plugin entries exactly once, and the closed-tab
 * backstop only fires for the session's own tab.
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type Palette = typeof import('./palette');

const postToPlugin = vi.fn();
const ensureConnected = vi.fn();
const sentMessages: Array<{ tabId: number; msg: { type: string; action?: string } }> = [];

async function loadPalette(): Promise<Palette> {
  vi.resetModules();
  vi.doMock('../plugin/actuator-client', () => ({ postToPlugin, ensureConnected }));
  return await import('./palette');
}

beforeEach(() => {
  vi.clearAllMocks();
  ensureConnected.mockResolvedValue(true);
  postToPlugin.mockResolvedValue({ ok: true });
  sentMessages.length = 0;
  vi.stubGlobal('chrome', {
    tabs: {
      sendMessage: vi.fn(async (tabId: number, msg: { type: string }) => { sentMessages.push({ tabId, msg }); }),
      get: vi.fn(async (id: number) => ({ id, windowId: 10 })),
      update: vi.fn(async () => ({})),
      create: vi.fn(async () => ({})),
    },
    windows: { update: vi.fn(async () => ({})) },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('../plugin/actuator-client');
});

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

const rows = [
  { row_id: 'r1', dispatch: { kind: 'command', command: 'scroll_down' } },
  { row_id: 'r2', dispatch: { kind: 'switch_tab', tabId: 42 } },
  { row_id: 'bm1', dispatch: { kind: 'open_bookmark', url: 'https://example.com/' } },
] as never[];

describe('voice select', () => {
  it('resolves a known row id and closes the overlay first', async () => {
    const palette = await loadPalette();
    await palette.publishPaletteVoice(5, [], rows);
    palette.handlePaletteVoiceSelect('r1');
    await flush();
    const types = sentMessages.map((m) => m.msg.type);
    expect(types[0]).toBe('PALETTE_CLOSE');
    expect(types).toContain('PALETTE_COMMAND');
  });

  it('an unknown (stale) row id just closes the palette', async () => {
    const palette = await loadPalette();
    await palette.publishPaletteVoice(5, [], rows);
    palette.handlePaletteVoiceSelect('gone');
    await flush();
    expect(sentMessages.map((m) => m.msg.type)).toEqual(['PALETTE_CLOSE']);
  });

  it('select and dismiss are no-ops without a session', async () => {
    const palette = await loadPalette();
    palette.handlePaletteVoiceSelect('r1');
    palette.handlePaletteVoiceDismiss();
    await flush();
    expect(sentMessages).toHaveLength(0);
  });
});

describe('open_bookmark dispositions', () => {
  // Changed 2026-07-29: a bookmark is somewhere you want to go as well as where
  // you already are, so the default no longer discards the origin tab.
  it('default opens a new focused tab, leaving the origin tab alone', async () => {
    const palette = await loadPalette();
    await palette.publishPaletteVoice(5, [], rows);
    palette.handlePaletteVoiceSelect('bm1');
    await flush();
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://example.com/', active: true });
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });

  // The voice path used to carry its OWN copy of the default, so flipping
  // handlePaletteAction's left it behind and the two surfaces disagreed. There is
  // one default now; this pins the two paths together.
  it('voice and keyboard paths share one default', async () => {
    const palette = await loadPalette();
    await palette.publishPaletteVoice(5, [], rows);
    const create = vi.mocked(chrome.tabs.create);
    const lastCall = (): unknown => create.mock.calls[create.mock.calls.length - 1];
    palette.handlePaletteVoiceSelect('bm1');            // voice, no `where`
    await flush();
    const viaVoice = lastCall();
    create.mockClear();
    await palette.handlePaletteAction(                   // keyboard, no `where`
      { kind: 'open_bookmark', url: 'https://example.com/' }, 5,
    );
    expect(lastCall()).toEqual(viaVoice);
  });

  it('explicit "here" still navigates the origin tab', async () => {
    const palette = await loadPalette();
    await palette.publishPaletteVoice(5, [], rows);
    palette.handlePaletteVoiceSelect('bm1', 'here');
    await flush();
    expect(chrome.tabs.update).toHaveBeenCalledWith(5, { url: 'https://example.com/' });
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });

  it('"blank" opens a new focused tab', async () => {
    const palette = await loadPalette();
    await palette.publishPaletteVoice(5, [], rows);
    palette.handlePaletteVoiceSelect('bm1', 'blank');
    await flush();
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://example.com/', active: true });
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });

  it('"stash" opens a background tab', async () => {
    const palette = await loadPalette();
    await palette.publishPaletteVoice(5, [], rows);
    palette.handlePaletteVoiceSelect('bm1', 'stash');
    await flush();
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://example.com/', active: false });
  });

  it('falls back to a new tab when the origin tab is gone', async () => {
    const palette = await loadPalette();
    await palette.handlePaletteAction(
      { kind: 'open_bookmark', url: 'https://example.com/' }, undefined,
    );
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://example.com/', active: true });
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });
});

describe('clearPaletteVoice', () => {
  it('drains the plugin entries once; a second clear is a no-op', async () => {
    const palette = await loadPalette();
    await palette.publishPaletteVoice(5, [], rows);
    postToPlugin.mockClear();
    await palette.clearPaletteVoice('test');
    await palette.clearPaletteVoice('test-again');
    const drains = postToPlugin.mock.calls.filter(([ep]) => ep === '/palette');
    expect(drains).toHaveLength(1);
    expect(drains[0][1]).toMatchObject({ entries: [] });
  });
});

describe('closed-tab backstop', () => {
  it('clears only when the closed tab hosts the session', async () => {
    const palette = await loadPalette();
    await palette.publishPaletteVoice(5, [], rows);
    postToPlugin.mockClear();
    palette.clearPaletteForClosedTab(6); // different tab — keep session
    await flush();
    expect(postToPlugin).not.toHaveBeenCalled();
    palette.clearPaletteForClosedTab(5); // the host tab — drain
    await flush();
    expect(postToPlugin).toHaveBeenCalledWith('/palette', expect.objectContaining({ entries: [] }));
  });
});
