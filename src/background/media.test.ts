/**
 * BranchKit Browser — background-media unit tests.
 *
 * Pins the media-target routing priority (focused-tab video > most recently
 * audible > resume memory), the controllable-union mirror posts, and the two
 * clear paths (nav drops presence + resume but keeps audible; close drops
 * everything). initMedia's listener wiring is exercised through the fake
 * chrome.tabs.onUpdated registration.
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type Media = typeof import('./media');

const postToPlugin = vi.fn();
const ensureConnected = vi.fn();
let audibleListener: ((tabId: number, changeInfo: { audible?: boolean }) => void) | null = null;
const sentMessages: Array<{ tabId: number; msg: unknown }> = [];

async function loadMedia(): Promise<{ media: Media; bgState: { cachedActiveTabId: number | null; branchkitConnected: boolean } }> {
  vi.resetModules();
  vi.doMock('../plugin/actuator-client', () => ({ postToPlugin, ensureConnected }));
  const media: Media = await import('./media');
  const { bgState } = await import('./state');
  bgState.cachedActiveTabId = 1;
  return { media, bgState };
}

beforeEach(() => {
  vi.clearAllMocks();
  ensureConnected.mockResolvedValue(true);
  postToPlugin.mockResolvedValue({ ok: true });
  audibleListener = null;
  sentMessages.length = 0;
  vi.stubGlobal('chrome', {
    tabs: {
      query: vi.fn(async () => []),
      sendMessage: vi.fn(async (tabId: number, msg: unknown) => { sentMessages.push({ tabId, msg }); }),
      onUpdated: { addListener: vi.fn((fn: typeof audibleListener) => { audibleListener = fn; }) },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('../plugin/actuator-client');
});

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe('resolveMediaTargetTab priority', () => {
  it('prefers the focused tab with video when the browser is frontmost', async () => {
    const { media } = await loadMedia();
    media.initMedia();
    media.setVideoPresence(1, 0, true);
    audibleListener?.(2, { audible: true });
    expect(media.resolveMediaTargetTab()).toBe(1);
  });

  it('skips the focused tab when the browser is not frontmost', async () => {
    const { media } = await loadMedia();
    media.initMedia();
    media.setVideoPresence(1, 0, true);
    audibleListener?.(2, { audible: true });
    media.setBrowserWindowFocused(false);
    expect(media.resolveMediaTargetTab()).toBe(2);
  });

  it('picks the most recently audible tab, then falls back to resume memory', async () => {
    const { media } = await loadMedia();
    media.initMedia();
    audibleListener?.(2, { audible: true });
    audibleListener?.(3, { audible: true }); // more recent
    expect(media.resolveMediaTargetTab()).toBe(3);
    audibleListener?.(2, { audible: false });
    audibleListener?.(3, { audible: false });
    expect(media.resolveMediaTargetTab()).toBeNull(); // nothing yet controlled
    media.sendMediaActionToTab(3, { action: 'media_play_pause' }); // resume memory
    expect(media.resolveMediaTargetTab()).toBe(3);
  });
});

describe('controllable-union mirror', () => {
  it('posts active:true while any source holds, active:false when all clear', async () => {
    const { media } = await loadMedia();
    media.setVideoPresence(1, 0, true);
    await flush();
    expect(postToPlugin).toHaveBeenLastCalledWith('/media-active', expect.objectContaining({ active: true }));
    media.clearTabMediaOnClose(1);
    await flush();
    expect(postToPlugin).toHaveBeenLastCalledWith('/media-active', expect.objectContaining({ active: false }));
  });

  it('a frame OR: one live frame keeps the tab video-present', async () => {
    const { media } = await loadMedia();
    media.initMedia();
    media.setVideoPresence(1, 0, false);
    media.setVideoPresence(1, 3, true);
    expect(media.resolveMediaTargetTab()).toBe(1);
  });
});

describe('clear paths', () => {
  it('nav clears presence and resume memory but keeps the audible registry', async () => {
    const { media } = await loadMedia();
    media.initMedia();
    audibleListener?.(1, { audible: true });
    media.setVideoPresence(1, 0, true);
    media.sendMediaActionToTab(1, { action: 'media_play_pause' });
    media.clearTabMediaOnNav(1);
    // Still audible → still routable.
    media.setBrowserWindowFocused(false);
    expect(media.resolveMediaTargetTab()).toBe(1);
  });

  it('nav on a tab with no media state posts nothing', async () => {
    const { media } = await loadMedia();
    media.clearTabMediaOnNav(99);
    await flush();
    expect(postToPlugin).not.toHaveBeenCalled();
  });

  it('close clears everything for the tab', async () => {
    const { media } = await loadMedia();
    media.initMedia();
    audibleListener?.(2, { audible: true });
    media.sendMediaActionToTab(2, { action: 'media_play_pause' });
    media.clearTabMediaOnClose(2);
    expect(media.resolveMediaTargetTab()).toBeNull();
  });
});

describe('handleMediaAllAction', () => {
  it('fans pause out to every audible tab', async () => {
    const { media } = await loadMedia();
    media.initMedia();
    audibleListener?.(2, { audible: true });
    audibleListener?.(3, { audible: true });
    sentMessages.length = 0;
    media.handleMediaAllAction('media_pause_all');
    expect(sentMessages.map((m) => m.tabId).sort()).toEqual([2, 3]);
    for (const { msg } of sentMessages) {
      expect((msg as { payload: { action: string } }).payload.action).toBe('media_play_pause');
    }
  });
});
