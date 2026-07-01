/**
 * BranchKit Browser — Keymap persistence.
 *
 * One source of truth for the `chrome.storage.sync.keymap` key. The stored
 * value is the FULL effective keymap (defaults + user edits) as a structured
 * array — the editor reads/writes objects, no parsing. When nothing is stored,
 * the shipping DEFAULT_KEYMAP applies. The content script reads this at startup
 * and rebuilds the command registry on storage.onChanged.
 *
 * The stored snapshot is from whatever version the user last saved, so it lacks
 * binds for commands shipped since. On load we BACKFILL any default whose
 * command the snapshot doesn't bind at all AND whose default key is free — so a
 * new command (e.g. the `?` help overlay) works without a manual reset. User
 * rebinds and removals of still-present commands are untouched; a command the
 * user fully unbound whose default key is also free is restored (the accepted
 * edge of snapshot — not diff — storage).
 */

import { DEFAULT_KEYMAP, COMMAND_BY_ID, type KeymapEntry } from './command-catalog';
import { canonicalizeKeys } from './activate/key-combo';

const STORAGE_KEY = 'keymap';

function defaults(): KeymapEntry[] {
  return DEFAULT_KEYMAP.map((e) => ({ ...e }));
}

/**
 * Drop entries that don't map to a known, bindable command or lack a key —
 * defends the registry against malformed or cross-version stored data.
 */
export function sanitizeKeymap(entries: readonly KeymapEntry[]): KeymapEntry[] {
  const out: KeymapEntry[] = [];
  for (const e of entries) {
    if (!e || typeof e.keys !== 'string' || e.keys.length === 0) continue;
    if (typeof e.command !== 'string') continue;
    const meta = COMMAND_BY_ID.get(e.command);
    if (!meta || !meta.mappable) continue;
    const hasParams = e.params && Object.keys(e.params).length > 0;
    out.push({
      // Canonical form (cmd→meta, modifier order) so string comparisons —
      // keymapsEqual's echo skip, mergeNewDefaults' usedKeys — see one shape.
      keys: canonicalizeKeys(e.keys),
      command: e.command,
      ...(hasParams ? { params: { ...e.params } } : {}),
    });
  }
  return out;
}

/**
 * Backfill default binds the stored snapshot lacks: a default whose command is
 * unbound there AND whose key combo is free. Surfaces commands shipped after the
 * user last saved without clobbering rebinds or creating duplicate/conflicting
 * binds. Pure; tested directly.
 */
export function mergeNewDefaults(stored: readonly KeymapEntry[]): KeymapEntry[] {
  const boundCommands = new Set(stored.map((e) => e.command));
  const usedKeys = new Set(stored.map((e) => e.keys));
  const out = stored.map((e) => ({ ...e }));
  for (const d of DEFAULT_KEYMAP) {
    if (boundCommands.has(d.command) || usedKeys.has(d.keys)) continue;
    out.push({ ...d });
  }
  return out;
}

export async function loadKeymap(): Promise<KeymapEntry[]> {
  const result = await chrome.storage.sync.get(STORAGE_KEY);
  const stored = result[STORAGE_KEY] as KeymapEntry[] | undefined;
  if (!Array.isArray(stored)) return defaults();
  return mergeNewDefaults(sanitizeKeymap(stored));
}

export function saveKeymap(entries: readonly KeymapEntry[]): void {
  chrome.storage.sync.set({ [STORAGE_KEY]: sanitizeKeymap(entries) });
}

export function resetKeymap(): void {
  chrome.storage.sync.remove(STORAGE_KEY);
}

/**
 * Subscribe to changes in the `keymap` key. Fires on writes from this context
 * and from other contexts (other tabs / synced browsers). Callers that want to
 * skip self-originated echoes compare via `keymapsEqual` before reacting.
 */
export function onKeymapChanged(cb: (entries: KeymapEntry[]) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>): void => {
    if (!changes[STORAGE_KEY]) return;
    const next = changes[STORAGE_KEY].newValue as KeymapEntry[] | undefined;
    cb(Array.isArray(next) ? mergeNewDefaults(sanitizeKeymap(next)) : defaults());
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/** Structural equality, for skipping self-originated storage echoes. */
export function keymapsEqual(a: readonly KeymapEntry[], b: readonly KeymapEntry[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
