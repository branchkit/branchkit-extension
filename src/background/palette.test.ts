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
