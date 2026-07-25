/**
 * BranchKit Browser — keymap-storage unit tests.
 *
 * In-memory chrome.storage.sync mock (get/set/remove + onChanged dispatch);
 * exercises load defaulting, sanitize, round-trip, reset, and change events.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  loadKeymap,
  saveKeymap,
  resetKeymap,
  onKeymapChanged,
  sanitizeKeymap,
  mergeNewDefaults,
  keymapsEqual,
} from './keymap-storage';
import { DEFAULT_KEYMAP, type KeymapEntry } from './command-catalog';

type ChangeListener = (
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string,
) => void;

function installMockChrome(): void {
  const sync = new Map<string, unknown>();
  const listeners: ChangeListener[] = [];
  const area = {
    async get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
      if (typeof keys === 'string') {
        return sync.has(keys) ? { [keys]: structuredClone(sync.get(keys)) } : {};
      }
      return Object.fromEntries([...sync].map(([k, v]) => [k, structuredClone(v)]));
    },
    set(items: Record<string, unknown>): void {
      const changes: Record<string, chrome.storage.StorageChange> = {};
      for (const [k, v] of Object.entries(items)) {
        const oldValue = sync.has(k) ? structuredClone(sync.get(k)) : undefined;
        sync.set(k, structuredClone(v));
        changes[k] = { oldValue, newValue: structuredClone(v) };
      }
      for (const l of listeners) l(changes, 'sync');
    },
    remove(key: string): void {
      const oldValue = sync.has(key) ? structuredClone(sync.get(key)) : undefined;
      sync.delete(key);
      for (const l of listeners) l({ [key]: { oldValue, newValue: undefined } }, 'sync');
    },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      sync: area,
      onChanged: {
        addListener: (l: ChangeListener) => listeners.push(l),
        removeListener: (l: ChangeListener) => {
          const i = listeners.indexOf(l);
          if (i >= 0) listeners.splice(i, 1);
        },
      },
    },
  };
}

beforeEach(() => {
  installMockChrome();
});

describe('loadKeymap', () => {
  it('returns the defaults when nothing is stored', async () => {
    const km = await loadKeymap();
    expect(km).toEqual(DEFAULT_KEYMAP);
  });

  it('returns a fresh copy of the defaults (not the frozen export)', async () => {
    const km = await loadKeymap();
    expect(km).not.toBe(DEFAULT_KEYMAP);
    km.push({ keys: 'KeyZ', command: 'scroll_down' });
    expect(DEFAULT_KEYMAP).toHaveLength(km.length - 1); // export untouched
  });

  it('round-trips a saved (full) keymap', async () => {
    // The editor saves the full effective keymap; a full snapshot backfills
    // nothing, so it round-trips exactly.
    const custom: KeymapEntry[] = DEFAULT_KEYMAP.map((e) =>
      e.command === 'next_tab' ? { keys: 'ctrl+KeyK', command: 'next_tab' } : { ...e },
    );
    saveKeymap(custom);
    expect(await loadKeymap()).toEqual(custom);
  });

  it('preserves a custom bind while backfilling new-command defaults', async () => {
    // A snapshot from before `toggle_help` shipped: the custom bind survives and
    // the missing default is backfilled.
    saveKeymap([{ keys: 'ctrl+KeyK', command: 'next_tab' }]);
    const km = await loadKeymap();
    expect(km).toContainEqual({ keys: 'ctrl+KeyK', command: 'next_tab' });
    expect(km).toContainEqual({ keys: 'shift+Slash', command: 'toggle_help' });
  });

  it('sanitizes stored data on load (drops unknown / unmappable / keyless)', async () => {
    chrome.storage.sync.set({
      keymap: [
        { keys: 'KeyJ', command: 'scroll_down' }, // ok
        { keys: 'KeyX', command: 'no_such_command' }, // unknown → drop
        { keys: 'KeyY', command: 'activate_hint' }, // not mappable → drop
        { keys: '', command: 'scroll_up' }, // empty key → drop
      ],
    });
    const km = await loadKeymap();
    expect(km).toContainEqual({ keys: 'KeyJ', command: 'scroll_down' });
    expect(km.some((e) => e.command === 'no_such_command')).toBe(false);
    expect(km.some((e) => e.command === 'activate_hint')).toBe(false);
    expect(km.some((e) => e.keys === '')).toBe(false);
  });
});

describe('saveKeymap / resetKeymap', () => {
  it('saves only sanitized entries', async () => {
    saveKeymap([
      { keys: 'KeyJ', command: 'scroll_down', params: {} },
      { keys: 'KeyZ', command: 'bogus' },
    ]);
    // Assert what's persisted (raw), unaffected by load-time backfill.
    const raw = (await chrome.storage.sync.get('keymap')).keymap;
    expect(raw).toEqual([{ keys: 'KeyJ', command: 'scroll_down' }]);
  });

  it('preserves params on bindable commands', async () => {
    saveKeymap([{ keys: 'ctrl+KeyP', command: 'scroll_to_percent', params: { percent: '90' } }]);
    expect(await loadKeymap()).toContainEqual(
      { keys: 'ctrl+KeyP', command: 'scroll_to_percent', params: { percent: '90' } },
    );
  });

  it('reset restores the defaults', async () => {
    saveKeymap([{ keys: 'ctrl+KeyK', command: 'next_tab' }]);
    resetKeymap();
    expect(await loadKeymap()).toEqual(DEFAULT_KEYMAP);
  });
});

describe('onKeymapChanged', () => {
  it('fires with the new keymap (sanitized + new-default-backfilled) on save', () => {
    const cb = vi.fn();
    onKeymapChanged(cb);
    saveKeymap([{ keys: 'ctrl+KeyK', command: 'next_tab' }]);
    const delivered = cb.mock.calls[0][0] as KeymapEntry[];
    expect(delivered).toContainEqual({ keys: 'ctrl+KeyK', command: 'next_tab' });
    expect(delivered).toContainEqual({ keys: 'shift+Slash', command: 'toggle_help' });
  });

  it('fires with the defaults on reset (key removed)', () => {
    saveKeymap([{ keys: 'ctrl+KeyK', command: 'next_tab' }]);
    const cb = vi.fn();
    onKeymapChanged(cb);
    resetKeymap();
    expect(cb).toHaveBeenCalledWith(DEFAULT_KEYMAP.map((e) => ({ ...e })));
  });

  it('ignores changes to unrelated keys', () => {
    const cb = vi.fn();
    onKeymapChanged(cb);
    chrome.storage.sync.set({ somethingElse: 1 });
    expect(cb).not.toHaveBeenCalled();
  });

  it('unsubscribe stops delivery', () => {
    const cb = vi.fn();
    const off = onKeymapChanged(cb);
    off();
    saveKeymap([{ keys: 'ctrl+KeyK', command: 'next_tab' }]);
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('mergeNewDefaults', () => {
  it('backfills a default whose command is unbound and key is free', () => {
    const merged = mergeNewDefaults([{ keys: 'ctrl+KeyK', command: 'next_tab' }]);
    expect(merged).toContainEqual({ keys: 'ctrl+KeyK', command: 'next_tab' });
    expect(merged).toContainEqual({ keys: 'shift+Slash', command: 'toggle_help' });
  });

  it('does not re-add a command that is already bound (under any key)', () => {
    const merged = mergeNewDefaults([{ keys: 'ctrl+KeyK', command: 'next_tab' }]);
    expect(merged.filter((e) => e.command === 'next_tab')).toEqual([
      { keys: 'ctrl+KeyK', command: 'next_tab' },
    ]);
  });

  it('does not backfill a default whose key the user took for something else', () => {
    // User bound shift+Slash to scroll_down; toggle_help must not duplicate that key.
    const merged = mergeNewDefaults([{ keys: 'shift+Slash', command: 'scroll_down' }]);
    expect(merged.some((e) => e.keys === 'shift+Slash' && e.command === 'toggle_help')).toBe(false);
    expect(merged.filter((e) => e.keys === 'shift+Slash')).toHaveLength(1);
  });

  it('is a no-op on the full default keymap', () => {
    expect(mergeNewDefaults(DEFAULT_KEYMAP)).toEqual([...DEFAULT_KEYMAP]);
  });
});

describe('sanitizeKeymap / keymapsEqual', () => {
  it('sanitize is idempotent on a clean keymap', () => {
    expect(sanitizeKeymap(DEFAULT_KEYMAP)).toEqual([...DEFAULT_KEYMAP]);
  });

  it('keymapsEqual is structural', () => {
    expect(keymapsEqual(DEFAULT_KEYMAP, DEFAULT_KEYMAP.map((e) => ({ ...e })))).toBe(true);
    expect(keymapsEqual(DEFAULT_KEYMAP, [{ keys: 'KeyJ', command: 'scroll_down' }])).toBe(false);
  });
});
