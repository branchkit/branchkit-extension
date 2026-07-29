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

/**
 * The change listeners registered against chrome.storage.onChanged.
 *
 * Deliberately NOT reset by `setRules` below. It used to be, and that made the
 * unsubscribe test vacuous: re-mocking to change the stored rules also emptied
 * the array the test then checked its saved listener against, so the loop body
 * never ran and the assertion just read the install's own state.
 */
let listeners: Array<(c: Record<string, unknown>, area: string) => void> = [];

/** Change what storage returns WITHOUT disturbing registered listeners. */
let rules: KeyboardRule[] | 'reject' = [];
const setRules = (r: KeyboardRule[] | 'reject'): void => { rules = r; };

/** Fire a storage-change event at everything currently subscribed. */
function fireStorageChange(): void {
  for (const l of [...listeners]) l({ keyboardRules: {} }, 'sync');
}

/** How many times the policy has read storage since the last mockChrome. */
let reads: number;

function mockChrome(initial: KeyboardRule[] | 'reject'): void {
  listeners = [];
  rules = initial;
  reads = 0;
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      sync: {
        get: () => (reads++, rules === 'reject'
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

  // The regression this module could plausibly ship, and the one the test
  // above CANNOT catch: it asserts the same values beforeEach already set, so
  // an applySiteKeys that bailed early on an empty result would pass it. This
  // drives non-empty -> empty, which is what deleting a rule in the popup does.
  it('clears a policy the previous rules had applied', async () => {
    mockChrome([{ pattern: 'mail.google.com', off: true, passKeys: 'jk' }]);
    await applySiteKeys();
    expect(policy()).toEqual({ excluded: true, passKeys: ['j', 'k'] });

    setRules([]); // the user deleted the rule
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
  it('applies exactly once on install', async () => {
    mockChrome([{ pattern: 'mail.google.com', passKeys: 'jk' }]);
    installSiteKeyPolicy();
    await vi.waitFor(() => expect(policy().passKeys).toEqual(['j', 'k']));
    expect(reads).toBe(1); // "once" is the only thing separating this from the next test
  });

  it('re-applies when the rules change', async () => {
    mockChrome([{ pattern: 'mail.google.com', passKeys: 'jk' }]);
    installSiteKeyPolicy();
    await vi.waitFor(() => expect(policy().passKeys).toEqual(['j', 'k']));

    setRules([{ pattern: 'mail.google.com', off: true }]);
    fireStorageChange(); // what the popup's edit would have fired
    await vi.waitFor(() => expect(policy().excluded).toBe(true));
  });

  // The give-back half. `stop()` must actually deregister — the listener is
  // the one thing installSiteKeyPolicy leaves behind on the page.
  it('returns an unsubscribe that stops further re-application', async () => {
    mockChrome([{ pattern: 'mail.google.com', passKeys: 'jk' }]);
    const stop = installSiteKeyPolicy();
    await vi.waitFor(() => expect(policy().passKeys).toEqual(['j', 'k']));
    expect(listeners).toHaveLength(1); // it really did subscribe

    stop();
    expect(listeners).toHaveLength(0); // ...and really did unsubscribe

    // Fire anyway, at whoever is left. Nothing should move.
    setRules([{ pattern: 'mail.google.com', off: true }]);
    fireStorageChange();
    await new Promise((r) => setTimeout(r, 0));
    expect(policy().excluded).toBe(false);
    expect(policy().passKeys).toEqual(['j', 'k']);
  });
});
