/**
 * BranchKit Browser — Keymap persistence.
 *
 * One source of truth for the `chrome.storage.sync.keymap` key. The stored
 * value is the FULL effective keymap (defaults + user edits) as a structured
 * array — the editor reads/writes objects, no parsing. When nothing is stored,
 * the shipping DEFAULT_KEYMAP applies. The content script reads this at startup
 * and rebuilds the command registry on storage.onChanged.
 *
 * Trade-off: full-replace storage means a user who saved a keymap won't pick up
 * NEW default binds added in a later version. Acceptable pre-launch; revisit
 * with a defaults+overrides model if it bites.
 */

import { DEFAULT_KEYMAP, COMMAND_BY_ID, type KeymapEntry } from './command-catalog';

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
      keys: e.keys,
      command: e.command,
      ...(hasParams ? { params: { ...e.params } } : {}),
    });
  }
  return out;
}

export async function loadKeymap(): Promise<KeymapEntry[]> {
  const result = await chrome.storage.sync.get(STORAGE_KEY);
  const stored = result[STORAGE_KEY] as KeymapEntry[] | undefined;
  if (!Array.isArray(stored)) return defaults();
  return sanitizeKeymap(stored);
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
    cb(Array.isArray(next) ? sanitizeKeymap(next) : defaults());
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/** Structural equality, for skipping self-originated storage echoes. */
export function keymapsEqual(a: readonly KeymapEntry[], b: readonly KeymapEntry[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
