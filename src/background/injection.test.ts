/**
 * BranchKit Browser — injection-manager unit tests.
 *
 * Pins the orphan-recovery safety primitives: isInjectableURL's restricted-URL
 * filter, the per-tab inject lock that prevents the double-inject race (the
 * load-bearing guard behind extension-reload survival), and injectContentScriptFiles'
 * URL/discarded-tab guards. The full ping→flush→inject choreography is exercised
 * by the real-browser reload soak.
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isInjectableURL, withInjectLock, injectContentScriptFiles, ensureContentScriptInjected } from './injection';

describe('isInjectableURL', () => {
  it('accepts ordinary web URLs', () => {
    expect(isInjectableURL('https://example.com')).toBe(true);
    expect(isInjectableURL('http://localhost:3000/x')).toBe(true);
  });

  it('rejects restricted schemes and empty URLs', () => {
    for (const u of ['', 'chrome://extensions', 'chrome-extension://abc/x',
      'moz-extension://abc/x', 'edge://settings', 'about:blank',
      'devtools://devtools', 'view-source:https://x']) {
      expect(isInjectableURL(u)).toBe(false);
    }
  });
});

describe('withInjectLock', () => {
  it('runs the fn and returns its result', async () => {
    expect(await withInjectLock(1, async () => 'ok')).toBe('ok');
  });

  it('skips (returns undefined) a re-entrant call while the tab is locked', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const p1 = withInjectLock(1, () => held.then(() => 'first'));

    // Same tab, while p1 still holds the slot → must skip.
    expect(await withInjectLock(1, async () => 'second')).toBeUndefined();

    release();
    expect(await p1).toBe('first');
  });

  it('releases the slot after completion (and is per-tab)', async () => {
    await withInjectLock(1, async () => 'a');
    expect(await withInjectLock(1, async () => 'b')).toBe('b'); // slot freed
    // A different tab is never blocked by tab 1's lock.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const pa = withInjectLock(1, () => held.then(() => 'x'));
    expect(await withInjectLock(2, async () => 'y')).toBe('y');
    release();
    await pa;
  });
});

describe('injectContentScriptFiles', () => {
  let executeScript: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    executeScript = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('chrome', {
      tabs: { get: vi.fn() },
      scripting: { executeScript },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('returns false without injecting for a restricted-scheme tab', async () => {
    (chrome.tabs.get as ReturnType<typeof vi.fn>).mockResolvedValue({ url: 'chrome://extensions', discarded: false });
    expect(await injectContentScriptFiles(7)).toBe(false);
    expect(executeScript).not.toHaveBeenCalled();
  });

  it('returns false without injecting for a discarded tab', async () => {
    (chrome.tabs.get as ReturnType<typeof vi.fn>).mockResolvedValue({ url: 'https://x.com', discarded: true });
    expect(await injectContentScriptFiles(7)).toBe(false);
    expect(executeScript).not.toHaveBeenCalled();
  });

  it('injects bootstrap + content for an ordinary tab', async () => {
    (chrome.tabs.get as ReturnType<typeof vi.fn>).mockResolvedValue({ url: 'https://x.com', discarded: false });
    expect(await injectContentScriptFiles(7)).toBe(true);
    expect(executeScript).toHaveBeenCalledTimes(2); // bootstrap.js + content.js (allFrames)
  });
});

describe('ensureContentScriptInjected — loading-tab status gate', () => {
  // The dual-CS install race (epoch tripwire catch #1): on a slow-loading
  // page the ping ladder fails before the manifest CS has run, and the
  // flush+inject sequence gets deferred into the same document_idle window
  // the manifest script boots in — scheduler order then decides between a
  // wasted inject+abort cycle and TWO live content scripts. The gate: a tab
  // whose status is still 'loading' must never be flushed or injected (its
  // manifest CS is guaranteed to arrive; onUpdated{'complete'} re-enters).
  // Real-browser end-to-end: scripts/_test-dual-cs-race.mjs.
  let executeScript: ReturnType<typeof vi.fn>;
  let sendMessage: ReturnType<typeof vi.fn>;
  let tabsGet: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    executeScript = vi.fn().mockResolvedValue(undefined);
    sendMessage = vi.fn().mockRejectedValue(new Error('Receiving end does not exist'));
    tabsGet = vi.fn();
    vi.stubGlobal('chrome', {
      tabs: { get: tabsGet, sendMessage },
      scripting: { executeScript },
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function runEnsure(tabId: number): Promise<void> {
    const p = ensureContentScriptInjected(tabId);
    await vi.runAllTimersAsync(); // drive the ping-retry delay
    await p;
  }

  it('skips flush + inject while the tab is still loading', async () => {
    tabsGet.mockResolvedValue({ url: 'https://x.com', status: 'loading', discarded: false });
    await runEnsure(7);
    expect(executeScript).not.toHaveBeenCalled();
  });

  it('proceeds to flush + inject for a complete tab that fails pings', async () => {
    tabsGet.mockResolvedValue({ url: 'https://x.com', status: 'complete', discarded: false });
    await runEnsure(7);
    // flushOrphanGuard (func) + bootstrap.js + content.js (allFrames path)
    expect(executeScript).toHaveBeenCalledTimes(3);
  });

  it('does nothing when the first ping answers', async () => {
    sendMessage.mockResolvedValue({ ok: true });
    await runEnsure(7);
    expect(tabsGet).not.toHaveBeenCalled();
    expect(executeScript).not.toHaveBeenCalled();
  });
});
