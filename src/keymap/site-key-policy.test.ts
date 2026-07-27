/**
 * Site-key policy application.
 *
 * This behaviour ran at `core/singletons.ts` module scope and was therefore
 * untestable — importing the module was the only way to run it, and importing
 * it also constructed the KeyHandler. Now that it is a call, the three things
 * that can go wrong are pinnable: the policy is applied, a failed storage read
 * does not become an unhandled rejection, and an edit re-applies.
 *
 * Real `keyHandler` (a construct-once singleton, no mock), fake chrome storage.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { keyHandler } from '../core/singletons';
import { applySiteKeys, installSiteKeyPolicy } from './site-key-policy';
import type { KeyboardRule } from './keyboard-rules';

/** The change listeners registered against chrome.storage.onChanged. */
let listeners: Array<(c: Record<string, unknown>, area: string) => void>;

function mockChrome(rules: KeyboardRule[] | 'reject'): void {
  listeners = [];
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      sync: {
        get: () => (rules === 'reject'
          ? Promise.reject(new Error('storage unavailable'))
          : Promise.resolve({ keyboardRules: rules })),
        set: () => Promise.resolve(),
        remove: () => Promise.resolve(),
      },
      onChanged: {
        addListener: (l: (c: Record<string, unknown>, area: string) => void) => { listeners.push(l); },
        removeListener: (l: (c: Record<string, unknown>, area: string) => void) => {
          listeners = listeners.filter((x) => x !== l);
        },
      },
    },
  };
}

/**
 * What the handler ended up with. `isExcluded()` is public; `passKeys` has no
 * getter, and adding one purely for this test would widen the handler's API
 * for a field only this policy writes — so read it directly.
 */
function policy(): { excluded: boolean; passKeys: string[] } {
  const h = keyHandler as unknown as { passKeys: Set<string> };
  return {
    excluded: keyHandler.isExcluded(),
    passKeys: Array.from(h.passKeys).sort(),
  };
}

beforeEach(() => {
  // The singleton persists across tests in this file; reset the policy fields
  // so each case asserts against a known floor rather than its predecessor.
  keyHandler.setExcluded(false);
  keyHandler.setPassKeys([]);
  vi.stubGlobal('location', { href: 'https://mail.google.com/inbox' } as Location);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
  keyHandler.setExcluded(false);
  keyHandler.setPassKeys([]);
});

describe('applySiteKeys', () => {
  it('pushes the matching rules union at the key handler', async () => {
    mockChrome([
      { pattern: '*.google.com', passKeys: 'jk' },
      { pattern: 'mail.google.com', passKeys: 'e' },
      { pattern: 'evil.test', off: true },
    ]);
    await applySiteKeys();
    expect(policy()).toEqual({ excluded: false, passKeys: ['e', 'j', 'k'] });
  });

  it('excludes the whole keyboard when a matching rule says off', async () => {
    mockChrome([{ pattern: 'mail.google.com', off: true }]);
    await applySiteKeys();
    expect(policy().excluded).toBe(true);
  });

  it('leaves BranchKit fully bound when no rule matches', async () => {
    mockChrome([{ pattern: 'other.test', off: true, passKeys: 'q' }]);
    await applySiteKeys();
    expect(policy()).toEqual({ excluded: false, passKeys: [] });
  });

  // The defect this module was extracted to fix: the original was
  // `void getSiteKeyState(...).then(...)` with no catch, so a storage read
  // that rejected became an unhandled rejection at content-script boot.
  it('swallows a failed storage read instead of rejecting', async () => {
    mockChrome('reject');
    await expect(applySiteKeys()).resolves.toBeUndefined();
  });

  it('leaves the previous policy in place when the read fails', async () => {
    mockChrome([{ pattern: 'mail.google.com', passKeys: 'jk' }]);
    await applySiteKeys();
    mockChrome('reject');
    await applySiteKeys();
    expect(policy().passKeys).toEqual(['j', 'k']);
  });
});

describe('installSiteKeyPolicy', () => {
  it('applies once on install', async () => {
    mockChrome([{ pattern: 'mail.google.com', passKeys: 'jk' }]);
    installSiteKeyPolicy();
    await vi.waitFor(() => expect(policy().passKeys).toEqual(['j', 'k']));
  });

  it('re-applies when the rules change', async () => {
    mockChrome([{ pattern: 'mail.google.com', passKeys: 'jk' }]);
    installSiteKeyPolicy();
    await vi.waitFor(() => expect(policy().passKeys).toEqual(['j', 'k']));

    // Same fake storage object, new contents — then fire the change the popup
    // would have fired. Re-mocking would drop the registered listener.
    const fired = listeners.slice();
    mockChrome([{ pattern: 'mail.google.com', off: true }]);
    for (const l of fired) l({ keyboardRules: {} }, 'sync');
    await vi.waitFor(() => expect(policy().excluded).toBe(true));
  });

  it('returns an unsubscribe that stops further re-application', async () => {
    mockChrome([{ pattern: 'mail.google.com', passKeys: 'jk' }]);
    const stop = installSiteKeyPolicy();
    await vi.waitFor(() => expect(policy().passKeys).toEqual(['j', 'k']));

    const fired = listeners.slice();
    stop();
    mockChrome([{ pattern: 'mail.google.com', off: true }]);
    for (const l of fired) if (listeners.includes(l)) l({ keyboardRules: {} }, 'sync');
    await new Promise((r) => setTimeout(r, 0));
    expect(policy().excluded).toBe(false);
  });
});
