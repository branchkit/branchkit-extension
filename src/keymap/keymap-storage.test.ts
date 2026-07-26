/**
 * BranchKit Browser — keymap-storage unit tests.
 *
 * In-memory chrome.storage.sync mock (get/set/remove + onChanged dispatch);
 * exercises the per-command delta model — effective-map derivation, the
 * delta↔effective round trip, per-command reset, the changed-vs-default check,
 * and legacy-snapshot migration fidelity.
 * See notes/DESIGN_CUSTOMIZATION_LAYERS.md.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  loadKeymap,
  loadKeymapDelta,
  saveKeymap,
  saveKeymapDelta,
  resetKeymap,
  resetCommandIn,
  onKeymapChanged,
  sanitizeDelta,
  effectiveKeymap,
  deltaFromEffective,
  defaultBindingsFor,
  bindingsForCommand,
  isCommandCustomized,
  migrateSnapshot,
  keymapsEqual,
  type KeymapDelta,
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

/** The pre-delta storage format: a flat snapshot of the full effective map. */
function storeLegacySnapshot(entries: readonly KeymapEntry[]): void {
  chrome.storage.sync.set({ keymap: entries.map((e) => ({ ...e })) });
}

/** The old backfill rule, reimplemented here so the migration test asserts
 *  fidelity against an independent statement of it rather than the production
 *  helper it's meant to retire. */
function legacyEffective(snapshot: readonly KeymapEntry[]): KeymapEntry[] {
  const bound = new Set(snapshot.map((e) => e.command));
  const used = new Set(snapshot.map((e) => e.keys));
  const out = snapshot.map((e) => ({ ...e }));
  for (const d of DEFAULT_KEYMAP) {
    if (bound.has(d.command) || used.has(d.keys)) continue;
    out.push({ ...d });
  }
  return out;
}

/** Same bindings per command, ignoring the flat array's ordering. */
function sameBindingsByCommand(a: readonly KeymapEntry[], b: readonly KeymapEntry[]): boolean {
  const group = (xs: readonly KeymapEntry[]): string => {
    const m = new Map<string, KeymapEntry[]>();
    for (const e of xs) m.set(e.command, [...(m.get(e.command) ?? []), e]);
    return JSON.stringify([...m].sort(([x], [y]) => x.localeCompare(y)));
  };
  return group(a) === group(b);
}

beforeEach(() => {
  installMockChrome();
});

describe('effectiveKeymap', () => {
  it('is the shipping keymap when the delta is empty', () => {
    expect(effectiveKeymap({})).toEqual([...DEFAULT_KEYMAP]);
  });

  it('substitutes a customized command in place, preserving order', () => {
    const km = effectiveKeymap({ next_tab: [{ keys: 'ctrl+KeyK' }] });
    expect(km).toContainEqual({ keys: 'ctrl+KeyK', command: 'next_tab' });
    // Order is load-bearing: the registry matches first-wins with a sequence
    // timeout, so a customized command must keep its default position.
    const idx = (list: readonly KeymapEntry[]): number =>
      list.findIndex((e) => e.command === 'next_tab');
    expect(idx(km)).toBe(idx(DEFAULT_KEYMAP));
    expect(km).toHaveLength(DEFAULT_KEYMAP.length);
  });

  it('supports several keys for one command', () => {
    const km = effectiveKeymap({ scroll_down: [{ keys: 'KeyJ' }, { keys: 'ctrl+KeyN' }] });
    expect(km.filter((e) => e.command === 'scroll_down')).toEqual([
      { keys: 'KeyJ', command: 'scroll_down' },
      { keys: 'ctrl+KeyN', command: 'scroll_down' },
    ]);
  });

  it('treats an empty list as deliberately unbound', () => {
    const km = effectiveKeymap({ refresh: [] });
    expect(km.some((e) => e.command === 'refresh')).toBe(false);
    // ...and every other default is untouched.
    expect(km).toHaveLength(DEFAULT_KEYMAP.length - defaultBindingsFor('refresh').length);
  });

  it('appends a command bound only by the user (ships unbound)', () => {
    const km = effectiveKeymap({ scroll_to_percent: [{ keys: 'ctrl+KeyP', params: { percent: '90' } }] });
    expect(km[km.length - 1]).toEqual({
      keys: 'ctrl+KeyP', command: 'scroll_to_percent', params: { percent: '90' },
    });
  });

  it('drops unknown, unmappable, and keyless data', () => {
    const km = effectiveKeymap({
      no_such_command: [{ keys: 'KeyX' }],
      activate_hint: [{ keys: 'KeyY' }],       // mappable: false
      scroll_up: [{ keys: '' }],                // keyless → unbound, not a bad entry
    } as unknown as KeymapDelta);
    expect(km.some((e) => e.command === 'no_such_command')).toBe(false);
    expect(km.some((e) => e.command === 'activate_hint')).toBe(false);
    expect(km.some((e) => e.keys === '')).toBe(false);
    expect(km.some((e) => e.command === 'scroll_up')).toBe(false);
  });
});

describe('deltaFromEffective', () => {
  it('is empty for an unmodified effective map', () => {
    expect(deltaFromEffective(DEFAULT_KEYMAP)).toEqual({});
  });

  it('records only the changed command', () => {
    const flat = DEFAULT_KEYMAP.map((e) =>
      e.command === 'next_tab' ? { keys: 'ctrl+KeyK', command: 'next_tab' } : { ...e },
    );
    expect(deltaFromEffective(flat)).toEqual({ next_tab: [{ keys: 'ctrl+KeyK' }] });
  });

  it('records a removed command as explicitly unbound', () => {
    const flat = DEFAULT_KEYMAP.filter((e) => e.command !== 'refresh');
    expect(deltaFromEffective(flat)).toEqual({ refresh: [] });
  });

  it('round-trips any delta (the editor hands us a flat draft)', () => {
    const delta: KeymapDelta = {
      next_tab: [{ keys: 'ctrl+KeyK' }],
      refresh: [],
      scroll_to_percent: [{ keys: 'ctrl+KeyP', params: { percent: '90' } }],
    };
    expect(deltaFromEffective(effectiveKeymap(delta))).toEqual(delta);
  });

  it('normalizes a delta that merely restates the defaults', () => {
    const restated: KeymapDelta = { next_tab: defaultBindingsFor('next_tab') };
    expect(deltaFromEffective(effectiveKeymap(restated))).toEqual({});
  });
});

describe('loadKeymap / saveKeymap', () => {
  it('returns the defaults when nothing is stored', async () => {
    expect(await loadKeymap()).toEqual([...DEFAULT_KEYMAP]);
  });

  it('returns a fresh copy, not the frozen export', async () => {
    const km = await loadKeymap();
    expect(km).not.toBe(DEFAULT_KEYMAP);
    km.push({ keys: 'KeyZ', command: 'scroll_down' });
    expect(DEFAULT_KEYMAP).toHaveLength(km.length - 1);
  });

  it('round-trips a full effective keymap', async () => {
    const custom = DEFAULT_KEYMAP.map((e) =>
      e.command === 'next_tab' ? { keys: 'ctrl+KeyK', command: 'next_tab' } : { ...e },
    );
    saveKeymap(custom);
    expect(await loadKeymap()).toEqual(custom);
  });

  it('persists a delta, not a snapshot', async () => {
    saveKeymap(DEFAULT_KEYMAP.map((e) =>
      e.command === 'next_tab' ? { keys: 'ctrl+KeyK', command: 'next_tab' } : { ...e },
    ));
    expect((await chrome.storage.sync.get('keymap')).keymap)
      .toEqual({ next_tab: [{ keys: 'ctrl+KeyK' }] });
  });

  it('a command shipped after the last save appears without a reset', async () => {
    // The user only ever customized next_tab; every other default applies,
    // including commands that did not exist when they saved.
    saveKeymapDelta({ next_tab: [{ keys: 'ctrl+KeyK' }] });
    const km = await loadKeymap();
    expect(km).toContainEqual({ keys: 'ctrl+KeyK', command: 'next_tab' });
    expect(km).toContainEqual({ keys: 'shift+Slash', command: 'toggle_help' });
  });

  it('a deliberately unbound command STAYS unbound across a reload', async () => {
    // The snapshot format could not express this — its free-key backfill
    // restored the default. The delta's [] does.
    saveKeymap(DEFAULT_KEYMAP.filter((e) => e.command !== 'refresh'));
    expect((await loadKeymap()).some((e) => e.command === 'refresh')).toBe(false);
  });

  it('preserves params', async () => {
    saveKeymapDelta({ scroll_to_percent: [{ keys: 'ctrl+KeyP', params: { percent: '90' } }] });
    expect(await loadKeymap()).toContainEqual(
      { keys: 'ctrl+KeyP', command: 'scroll_to_percent', params: { percent: '90' } },
    );
  });

  it('editing back to the default clears the customization', async () => {
    saveKeymapDelta({ next_tab: [{ keys: 'ctrl+KeyK' }] });
    saveKeymapDelta({ next_tab: defaultBindingsFor('next_tab') });
    expect((await chrome.storage.sync.get('keymap')).keymap).toEqual({});
    expect(await loadKeymapDelta()).toEqual({});
  });
});

describe('reset', () => {
  it('resetKeymap restores every default', async () => {
    saveKeymapDelta({ next_tab: [{ keys: 'ctrl+KeyK' }], refresh: [] });
    resetKeymap();
    expect(await loadKeymap()).toEqual([...DEFAULT_KEYMAP]);
  });

  it('resetCommandIn restores one command and leaves the rest alone', () => {
    const draft = effectiveKeymap({ next_tab: [{ keys: 'ctrl+KeyJ' }], refresh: [] });
    const after = resetCommandIn(draft, 'next_tab');
    expect(after).toContainEqual({ keys: 'KeyG KeyT', command: 'next_tab' });
    // The other customization is untouched.
    expect(after.some((e) => e.command === 'refresh')).toBe(false);
    expect(isCommandCustomized(after, 'next_tab')).toBe(false);
    expect(isCommandCustomized(after, 'refresh')).toBe(true);
  });

  it('resetCommandIn restores a command the user fully unbound', () => {
    const draft = effectiveKeymap({ refresh: [] });
    expect(resetCommandIn(draft, 'refresh')).toContainEqual(
      { keys: 'KeyR', command: 'refresh' },
    );
  });

  it('resetCommandIn preserves the order of every other entry', () => {
    // Round-tripping through the delta would renormalize order and mark the
    // editor's draft dirty on nothing but reordering.
    const draft = effectiveKeymap({ next_tab: [{ keys: 'ctrl+KeyJ' }] });
    const after = resetCommandIn(draft, 'next_tab');
    const others = (l: readonly KeymapEntry[]): string[] =>
      l.filter((e) => e.command !== 'next_tab').map((e) => `${e.command}:${e.keys}`);
    expect(others(after)).toEqual(others(draft));
  });

  it('resetCommandIn is pure', () => {
    const draft = effectiveKeymap({ next_tab: [{ keys: 'ctrl+KeyJ' }] });
    const before = JSON.stringify(draft);
    resetCommandIn(draft, 'next_tab');
    expect(JSON.stringify(draft)).toBe(before);
  });
});

describe('isCommandCustomized', () => {
  it('is false across an untouched effective keymap', () => {
    for (const command of new Set(DEFAULT_KEYMAP.map((e) => e.command))) {
      expect(isCommandCustomized(DEFAULT_KEYMAP, command)).toBe(false);
    }
  });

  it('is true for a rebind and for a deliberate unbind', () => {
    expect(isCommandCustomized(effectiveKeymap({ next_tab: [{ keys: 'ctrl+KeyJ' }] }), 'next_tab'))
      .toBe(true);
    expect(isCommandCustomized(effectiveKeymap({ refresh: [] }), 'refresh')).toBe(true);
  });

  it('is true for an ADDED key alongside the default', () => {
    const draft = effectiveKeymap({
      scroll_down: [...defaultBindingsFor('scroll_down'), { keys: 'ctrl+KeyN' }],
    });
    expect(isCommandCustomized(draft, 'scroll_down')).toBe(true);
  });

  it('ignores non-canonical spelling of the same combo', () => {
    // canonicalizeKeys normalizes modifier order, so this is not a change.
    expect(isCommandCustomized(
      effectiveKeymap({ toggle_palette: [{ keys: 'ctrl+KeyK' }] }), 'toggle_palette',
    )).toBe(false);
  });

  it('bindingsForCommand drops the redundant command field', () => {
    expect(bindingsForCommand(DEFAULT_KEYMAP, 'scroll_down')).toEqual([{ keys: 'KeyJ' }]);
  });
});

describe('legacy snapshot migration', () => {
  it('preserves the effective map exactly (the migration contract)', () => {
    const snapshots: KeymapEntry[][] = [
      [{ keys: 'ctrl+KeyK', command: 'next_tab' }],
      DEFAULT_KEYMAP.map((e) => ({ ...e })),
      DEFAULT_KEYMAP.filter((e) => e.command !== 'refresh').map((e) => ({ ...e })),
      [{ keys: 'shift+Slash', command: 'scroll_down' }],  // took toggle_help's key
      [],
    ];
    for (const snap of snapshots) {
      expect(sameBindingsByCommand(effectiveKeymap(migrateSnapshot(snap)), legacyEffective(snap)))
        .toBe(true);
    }
  });

  it('keeps a custom bind and backfills newer defaults', async () => {
    storeLegacySnapshot([{ keys: 'ctrl+KeyK', command: 'next_tab' }]);
    const km = await loadKeymap();
    expect(km).toContainEqual({ keys: 'ctrl+KeyK', command: 'next_tab' });
    expect(km).toContainEqual({ keys: 'shift+Slash', command: 'toggle_help' });
  });

  it('a full default snapshot migrates to an empty delta', async () => {
    storeLegacySnapshot(DEFAULT_KEYMAP);
    expect(await loadKeymapDelta()).toEqual({});
  });

  it('rewrites storage so the legacy shape is read exactly once', async () => {
    storeLegacySnapshot([{ keys: 'ctrl+KeyK', command: 'next_tab' }]);
    await loadKeymapDelta();
    const raw = (await chrome.storage.sync.get('keymap')).keymap;
    expect(Array.isArray(raw)).toBe(false);
    expect(raw).toMatchObject({ next_tab: [{ keys: 'ctrl+KeyK' }] });
  });

  it('stashes the pre-delta array so the conversion is reversible', async () => {
    const legacy = [{ keys: 'ctrl+KeyK', command: 'next_tab' }];
    storeLegacySnapshot(legacy);
    await loadKeymapDelta();
    expect((await chrome.storage.sync.get('keymap_pre_delta_backup')).keymap_pre_delta_backup)
      .toEqual(legacy);
  });

  it('writes nothing when there is no stored keymap at all', async () => {
    await loadKeymapDelta();
    expect(await chrome.storage.sync.get(null)).toEqual({});
  });

  it('drops unknown / unmappable / keyless snapshot entries', async () => {
    storeLegacySnapshot([
      { keys: 'KeyJ', command: 'scroll_down' },
      { keys: 'KeyX', command: 'no_such_command' },
      { keys: 'KeyY', command: 'activate_hint' },
      { keys: '', command: 'scroll_up' },
    ]);
    const km = await loadKeymap();
    expect(km).toContainEqual({ keys: 'KeyJ', command: 'scroll_down' });
    expect(km.some((e) => e.command === 'no_such_command')).toBe(false);
    expect(km.some((e) => e.command === 'activate_hint')).toBe(false);
    expect(km.some((e) => e.keys === '')).toBe(false);
  });
});

describe('onKeymapChanged', () => {
  it('delivers the effective keymap on save', () => {
    const cb = vi.fn();
    onKeymapChanged(cb);
    saveKeymapDelta({ next_tab: [{ keys: 'ctrl+KeyK' }] });
    const delivered = cb.mock.calls[0][0] as KeymapEntry[];
    expect(delivered).toContainEqual({ keys: 'ctrl+KeyK', command: 'next_tab' });
    expect(delivered).toContainEqual({ keys: 'shift+Slash', command: 'toggle_help' });
  });

  it('delivers the defaults on reset (key removed)', () => {
    saveKeymapDelta({ next_tab: [{ keys: 'ctrl+KeyK' }] });
    const cb = vi.fn();
    onKeymapChanged(cb);
    resetKeymap();
    expect(cb).toHaveBeenCalledWith([...DEFAULT_KEYMAP]);
  });

  it('migrates a legacy value written by another context', () => {
    const cb = vi.fn();
    onKeymapChanged(cb);
    storeLegacySnapshot([{ keys: 'ctrl+KeyK', command: 'next_tab' }]);
    const delivered = cb.mock.calls[0][0] as KeymapEntry[];
    expect(delivered).toContainEqual({ keys: 'ctrl+KeyK', command: 'next_tab' });
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
    saveKeymapDelta({ next_tab: [{ keys: 'ctrl+KeyK' }] });
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('sanitizeDelta / keymapsEqual', () => {
  it('sanitize preserves a clean delta and is idempotent', () => {
    const delta: KeymapDelta = { next_tab: [{ keys: 'ctrl+KeyK' }], refresh: [] };
    expect(sanitizeDelta(delta)).toEqual(delta);
    expect(sanitizeDelta(sanitizeDelta(delta))).toEqual(delta);
  });

  it('keymapsEqual is structural', () => {
    expect(keymapsEqual(DEFAULT_KEYMAP, DEFAULT_KEYMAP.map((e) => ({ ...e })))).toBe(true);
    expect(keymapsEqual(DEFAULT_KEYMAP, [{ keys: 'KeyJ', command: 'scroll_down' }])).toBe(false);
  });
});
