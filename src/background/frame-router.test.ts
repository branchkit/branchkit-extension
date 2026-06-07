/**
 * BranchKit Browser — frame-router unit tests.
 *
 * Pins active-tab resolution (cache hit short-circuits; cache miss prefers the
 * focused normal window's active injectable tab and caches it; restricted-URL
 * tabs are skipped) and the broadcast URL filter. Frame-by-codeword routing
 * goes through the label pool and is covered there + by the harness.
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { bgState } from './state';
import { resolveActiveContentTab, broadcastToAllTabs, resolveHintFromTab } from './frame-router';

let getAll: ReturnType<typeof vi.fn>;
let query: ReturnType<typeof vi.fn>;
let sendMessage: ReturnType<typeof vi.fn>;

beforeEach(() => {
  bgState.cachedActiveTabId = null;
  getAll = vi.fn();
  query = vi.fn();
  sendMessage = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('chrome', {
    windows: { getAll },
    tabs: { query, sendMessage },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  bgState.cachedActiveTabId = null;
});

describe('resolveActiveContentTab', () => {
  it('returns the cached tab without querying windows', async () => {
    bgState.cachedActiveTabId = 42;
    expect(await resolveActiveContentTab()).toBe(42);
    expect(getAll).not.toHaveBeenCalled();
  });

  it('picks the focused normal window\'s active injectable tab and caches it', async () => {
    getAll.mockResolvedValue([
      { focused: false, tabs: [{ id: 1, active: true, url: 'https://bg.example' }] },
      { focused: true, tabs: [{ id: 7, active: true, url: 'https://focused.example' }] },
    ]);
    expect(await resolveActiveContentTab()).toBe(7);
    expect(bgState.cachedActiveTabId).toBe(7);
  });

  it('skips a restricted-URL active tab (returns null)', async () => {
    getAll.mockResolvedValue([
      { focused: true, tabs: [{ id: 9, active: true, url: 'chrome://settings' }] },
    ]);
    expect(await resolveActiveContentTab()).toBeNull();
    expect(bgState.cachedActiveTabId).toBeNull();
  });
});

describe('broadcastToAllTabs', () => {
  it('sends to web tabs and skips restricted schemes', async () => {
    query.mockResolvedValue([
      { id: 1, url: 'https://a.example' },
      { id: 2, url: 'chrome://extensions' },
      { id: 3, url: 'moz-extension://abc/x' },
      { id: 4, url: 'http://b.example' },
    ]);
    await broadcastToAllTabs({ type: 'PING' } as never);
    const sentTabIds = sendMessage.mock.calls.map(([id]) => id);
    expect(sentTabIds).toEqual([1, 4]);
  });
});

describe('resolveHintFromTab', () => {
  it('rejects an empty codeword without touching the tab', async () => {
    const res = await resolveHintFromTab(1, '   ');
    expect(res).toEqual({ ok: false, reason: 'Codeword is empty.' });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
