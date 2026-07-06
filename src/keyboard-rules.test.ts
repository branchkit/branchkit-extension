import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  loadKeyboardRules, getSiteKeyState, getRuleForPattern, setRuleOff, setRulePassKeys,
  type KeyboardRule,
} from './keyboard-rules';

function mockChrome(initial: Record<string, unknown> = {}): Record<string, unknown> {
  const store = { ...initial };
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      sync: {
        get: (keys: string | string[]) => {
          const out: Record<string, unknown> = {};
          for (const k of Array.isArray(keys) ? keys : [keys]) out[k] = store[k];
          return Promise.resolve(out);
        },
        set: (obj: Record<string, unknown>) => { Object.assign(store, obj); return Promise.resolve(); },
        remove: (keys: string | string[]) => {
          for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
          return Promise.resolve();
        },
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  };
  return store;
}

describe('keyboard-rules', () => {
  beforeEach(() => { delete (globalThis as unknown as { chrome?: unknown }).chrome; });

  it('unions matching rules for a URL (patterns + exact)', async () => {
    mockChrome({ keyboardRules: [
      { pattern: '*.google.com', passKeys: 'jk' },
      { pattern: 'mail.google.com', passKeys: 'e#' },
      { pattern: 'evil.test', off: true },
    ] satisfies KeyboardRule[] });
    const s = await getSiteKeyState('https://mail.google.com/inbox');
    expect(s.excluded).toBe(false);
    expect(s.passKeys.sort()).toEqual(['#', 'e', 'j', 'k']);
    expect((await getSiteKeyState('https://evil.test/')).excluded).toBe(true);
    expect(await getSiteKeyState('https://unrelated.test/')).toEqual({ excluded: false, passKeys: [] });
  });

  it('popup helpers upsert + clear a pattern rule', async () => {
    const store = mockChrome();
    await setRuleOff('*.wikipedia.org', true);
    expect(store.keyboardRules).toEqual([{ pattern: '*.wikipedia.org', off: true }]);
    await setRulePassKeys('*.wikipedia.org', 'j k e'); // spaces stripped
    expect(await getRuleForPattern('*.wikipedia.org'))
      .toEqual({ pattern: '*.wikipedia.org', off: true, passKeys: 'jke' });
    // Clearing both empties the rule out of storage.
    await setRuleOff('*.wikipedia.org', false);
    await setRulePassKeys('*.wikipedia.org', '');
    expect(store.keyboardRules).toEqual([]);
  });

  it('migrates the old exact-host model on first load, then clears it', async () => {
    const store = mockChrome({
      keyExclusions: ['evil.test'],
      keyPassthrough: { 'mail.google.com': ['j', 'k'] },
    });
    const rules = await loadKeyboardRules();
    expect(rules).toContainEqual({ pattern: 'evil.test', off: true });
    expect(rules).toContainEqual({ pattern: 'mail.google.com', passKeys: 'jk' });
    // Old keys removed, new key written.
    expect(store.keyExclusions).toBeUndefined();
    expect(store.keyPassthrough).toBeUndefined();
    expect(Array.isArray(store.keyboardRules)).toBe(true);
  });

  it('no-ops safely without chrome.storage', async () => {
    expect(await loadKeyboardRules()).toEqual([]);
    expect(await getSiteKeyState('https://x.test/')).toEqual({ excluded: false, passKeys: [] });
  });
});
