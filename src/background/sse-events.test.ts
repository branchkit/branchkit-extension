/**
 * BranchKit Browser — SSE fan-out tests.
 *
 * `handleSSEEvent` is 135 lines and about a dozen branches deciding who acts on
 * a voice command, and until it left background.ts on 2026-07-28 it had no
 * tests at all — an entry point cannot be imported by one. That is the whole
 * argument for the move, so these come with it.
 *
 * What is worth asserting here is ORDER, because the routing chain's meaning is
 * positional: a tab verb answered BELOW the forward would be sent to a content
 * script that cannot reach chrome.tabs, and a media verb answered below it
 * would go to the focused page rather than the tab that is actually playing.
 * Every case therefore asserts both that the right thing happened and that the
 * fan-out did NOT — the half a "was it handled" check cannot see.
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type Mod = typeof import('./sse-events');

const isVoicePaused = vi.fn(() => false);
const handleTabAction = vi.fn(async () => {});
const handleZoomAction = vi.fn(async () => {});
const switchToTabById = vi.fn(async () => {});
const handleSurgeryAction = vi.fn(() => {});
const resolveMediaTargetTab = vi.fn<() => number | null>(() => null);
const sendMediaActionToTab = vi.fn(() => {});
const handleMediaAllAction = vi.fn(() => {});
const handlePaletteVoiceSelect = vi.fn(() => {});
const handlePaletteVoiceDismiss = vi.fn(() => {});
const notifyActiveTab = vi.fn(async (_m: { payload: { params?: Record<string, string> } }) => {});
const broadcastToAllTabs = vi.fn(() => {});
const setAlphabet = vi.fn(() => {});
const alphabetsEqual = vi.fn(() => false);

async function load(): Promise<Mod> {
  vi.resetModules();
  vi.doMock('../labels/words', () => ({ setAlphabet }));
  vi.doMock('../labels/label-pool', () => ({ alphabetsEqual }));
  vi.doMock('../plugin/sse-transport', () => ({ isVoicePaused }));
  vi.doMock('./tab-actions', () => ({
    TAB_ACTION_BY_ID: { next_tab: 'next' }, ZOOM_ACTION_BY_ID: { zoom_in: 'in' },
    handleTabAction, handleZoomAction, switchToTabById,
  }));
  vi.doMock('./tab-surgery', () => ({
    SURGERY_ACTIONS: new Set(['tab_to_desk']), handleSurgeryAction,
  }));
  vi.doMock('./media', () => ({
    MEDIA_ACTIONS: new Set(['media_play_pause']),
    resolveMediaTargetTab, sendMediaActionToTab, handleMediaAllAction,
  }));
  vi.doMock('./palette', () => ({ handlePaletteVoiceSelect, handlePaletteVoiceDismiss }));
  vi.doMock('./frame-router', () => ({ notifyActiveTab, broadcastToAllTabs }));
  return import('./sse-events');
}

/** Nothing left this service worker for a tab. */
const notForwarded = () => {
  expect(notifyActiveTab).not.toHaveBeenCalled();
  expect(broadcastToAllTabs).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  isVoicePaused.mockReturnValue(false);
  resolveMediaTargetTab.mockReturnValue(null);
});
afterEach(() => {
  for (const m of ['../labels/words', '../labels/label-pool', '../plugin/sse-transport',
    './tab-actions', './tab-surgery', './media', './palette', './frame-router']) vi.doUnmock(m);
});

describe('handleSSEEvent — answered HERE, never forwarded', () => {
  it('drops everything while voice is paused', async () => {
    const { handleSSEEvent } = await load();
    isVoicePaused.mockReturnValue(true);
    handleSSEEvent({ action: 'next_tab' });
    handleSSEEvent({ action: 'scroll_down' });
    expect(handleTabAction).not.toHaveBeenCalled();
    notForwarded();
  });

  it('tab verbs run on chrome.tabs, with a parsed index', async () => {
    const { handleSSEEvent } = await load();
    handleSSEEvent({ action: 'next_tab', params: { index: '3' } });
    expect(handleTabAction).toHaveBeenCalledWith('next', 3);
    notForwarded();
  });

  it('a tab verb with an unparseable index passes undefined, not NaN', async () => {
    const { handleSSEEvent } = await load();
    handleSSEEvent({ action: 'next_tab', params: { index: 'later' } });
    expect(handleTabAction).toHaveBeenCalledWith('next', undefined);
  });

  it('surgery, zoom and switch_to_tab each stop the chain', async () => {
    const { handleSSEEvent } = await load();
    handleSSEEvent({ action: 'tab_to_desk', params: { window_id: '2' } });
    expect(handleSurgeryAction).toHaveBeenCalledWith('tab_to_desk', { window_id: '2' });
    handleSSEEvent({ action: 'zoom_in' });
    expect(handleZoomAction).toHaveBeenCalledWith('in');
    handleSSEEvent({ action: 'switch_to_tab', params: { tab_id: '7' } });
    expect(switchToTabById).toHaveBeenCalledWith(7);
    notForwarded();
  });

  it('switch_to_tab with a non-numeric id switches nothing and forwards nothing', async () => {
    const { handleSSEEvent } = await load();
    handleSSEEvent({ action: 'switch_to_tab', params: { tab_id: 'abc' } });
    expect(switchToTabById).not.toHaveBeenCalled();
    notForwarded();
  });

  it('the palette verbs carry their landing spot', async () => {
    const { handleSSEEvent } = await load();
    handleSSEEvent({ action: 'palette_select', params: { row_id: 'r1' } });
    handleSSEEvent({ action: 'palette_select_newtab', params: { row_id: 'r2' } });
    handleSSEEvent({ action: 'palette_select_background', params: { row_id: 'r3' } });
    handleSSEEvent({ action: 'palette_dismiss' });
    expect(handlePaletteVoiceSelect.mock.calls).toEqual([['r1'], ['r2', 'blank'], ['r3', 'stash']]);
    expect(handlePaletteVoiceDismiss).toHaveBeenCalledTimes(1);
    notForwarded();
  });
});

describe('handleSSEEvent — media routes by target, not by focus', () => {
  it('the *_all forms fan out here', async () => {
    const { handleSSEEvent } = await load();
    handleSSEEvent({ action: 'media_pause_all' });
    expect(handleMediaAllAction).toHaveBeenCalledWith('media_pause_all');
    notForwarded();
  });

  it('a known target takes the verb, and the active tab does not', async () => {
    const { handleSSEEvent } = await load();
    resolveMediaTargetTab.mockReturnValue(42);
    const data = { action: 'media_play_pause' };
    handleSSEEvent(data);
    expect(sendMediaActionToTab).toHaveBeenCalledWith(42, data);
    // The point of the whole branch: "pause" from an unrelated app must reach
    // the background tab that is playing, not whatever page has focus.
    notForwarded();
  });

  it('NO known target falls through to the active tab rather than dropping', async () => {
    const { handleSSEEvent } = await load();
    resolveMediaTargetTab.mockReturnValue(null);
    handleSSEEvent({ action: 'media_play_pause' });
    expect(sendMediaActionToTab).not.toHaveBeenCalled();
    expect(notifyActiveTab).toHaveBeenCalledTimes(1);
  });
});

describe('handleSSEEvent — the forward at the bottom', () => {
  it('BROADCAST_ACTIONS go to every tab; everything else to the active one', async () => {
    const { handleSSEEvent } = await load();
    handleSSEEvent({ action: 'rescan' });
    handleSSEEvent({ action: 'set_badge_mode', params: { mode: 'word' } });
    expect(broadcastToAllTabs).toHaveBeenCalledTimes(2);
    expect(notifyActiveTab).not.toHaveBeenCalled();
    handleSSEEvent({ action: 'scroll_down' });
    expect(notifyActiveTab).toHaveBeenCalledTimes(1);
    expect(broadcastToAllTabs).toHaveBeenCalledTimes(2);
  });

  it("params.target === 'active' beats the broadcast set", async () => {
    const { handleSSEEvent } = await load();
    handleSSEEvent({ action: 'rescan', params: { target: 'active' } });
    expect(notifyActiveTab).toHaveBeenCalledTimes(1);
    expect(broadcastToAllTabs).not.toHaveBeenCalled();
  });

  it('a multi-target list fans out one action per target, in spoken order', async () => {
    const { handleSSEEvent } = await load();
    handleSSEEvent({
      action: 'activate_hint_background',
      correlation_id: 'tr_x',
      params: { targets: JSON.stringify([{ codeword: 'aa' }, { codeword: 'bs' }]) },
    });
    await vi.waitFor(() => expect(notifyActiveTab).toHaveBeenCalledTimes(2));
    expect(notifyActiveTab.mock.calls.map((c) => c[0].payload.params?.codeword))
      .toEqual(['aa', 'bs']);
    expect(broadcastToAllTabs).not.toHaveBeenCalled();
  });

  it('an unparseable or non-array target list sends nothing at all', async () => {
    const { handleSSEEvent } = await load();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    handleSSEEvent({ action: 'activate_hint_background', params: { targets: '{oops' } });
    handleSSEEvent({ action: 'activate_hint_background', params: { targets: '"notalist"' } });
    notForwarded();
    warn.mockRestore();
  });
});

describe('storeAlphabet', () => {
  const local = { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) };
  beforeEach(() => {
    local.get.mockResolvedValue({});
    local.set.mockClear();
    (globalThis as never as { chrome: unknown }).chrome = { storage: { local } };
  });

  it('installs the overlay and persists 26 words', async () => {
    const { storeAlphabet } = await load();
    const words = Array.from({ length: 26 }, (_, i) => `w${i}`);
    await storeAlphabet(words);
    expect(setAlphabet).toHaveBeenCalledWith(words);
    expect(local.set).toHaveBeenCalledWith({ alphabet: words });
  });

  it('refuses a list that is not 26 non-empty strings', async () => {
    const { storeAlphabet } = await load();
    for (const bad of [
      Array.from({ length: 25 }, (_, i) => `w${i}`),
      Array.from({ length: 26 }, (_, i) => (i === 3 ? '' : `w${i}`)),
      'not-an-array' as never,
    ]) {
      await storeAlphabet(bad as string[]);
    }
    // The overlay too, not just storage — a short list installed there would
    // mistranslate letters at the plugin boundary rather than fail loudly.
    expect(setAlphabet).not.toHaveBeenCalled();
    expect(local.set).not.toHaveBeenCalled();
  });

  it('skips the write when the stored alphabet already matches', async () => {
    const { storeAlphabet } = await load();
    const words = Array.from({ length: 26 }, (_, i) => `w${i}`);
    local.get.mockResolvedValue({ alphabet: words });
    alphabetsEqual.mockReturnValue(true);
    await storeAlphabet(words);
    // Each distinct write wakes EVERY content script into a grammar re-push;
    // voice re-sends the same alphabet on a hot path (688 pushes in one
    // observed session), so the dedup is the difference between idle and churn.
    expect(local.set).not.toHaveBeenCalled();
    // The overlay is still refreshed — it is idempotent, and the SW translation
    // layer has to be current even on the deduped path.
    expect(setAlphabet).toHaveBeenCalledWith(words);
  });
});
