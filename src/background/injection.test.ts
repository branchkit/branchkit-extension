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
import { isInjectableURL, withInjectLock, injectContentScriptFiles } from './injection';

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
