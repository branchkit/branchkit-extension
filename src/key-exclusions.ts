/**
 * Per-site keyboard policy — two levels, both toggled from the popup, read by
 * the content script (on load + live), synced across browsers. Voice is always
 * unaffected. See notes/DESIGN_PASS_THROUGH.md.
 *
 *  - `keyExclusions` (host list): BranchKit hands the keyboard ENTIRELY to the
 *    page. All-or-nothing.
 *  - `keyPassthrough` (host → chars): pass just these specific keys to the page
 *    while the rest of BranchKit's binds keep working (the Gmail case — pass
 *    `j`/`k`/`e`, keep `f`). Granular.
 */

const KEY = 'keyExclusions';
const PASS_KEY = 'keyPassthrough';

function normalize(list: unknown): string[] {
  return Array.isArray(list) ? list.filter((h): h is string => typeof h === 'string') : [];
}

function normalizeMap(v: unknown): Record<string, string[]> {
  if (!v || typeof v !== 'object') return {};
  const out: Record<string, string[]> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const keys = normalize(val);
    if (keys.length) out[k] = keys;
  }
  return out;
}

export async function loadKeyExclusions(): Promise<string[]> {
  if (typeof chrome === 'undefined' || !chrome.storage?.sync) return [];
  const r = await chrome.storage.sync.get(KEY);
  return normalize(r[KEY]);
}

export async function isHostExcluded(host: string): Promise<boolean> {
  if (!host) return false;
  return (await loadKeyExclusions()).includes(host);
}

export async function setHostExcluded(host: string, excluded: boolean): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.sync || !host) return;
  const list = await loadKeyExclusions();
  const has = list.includes(host);
  if (excluded && !has) {
    await chrome.storage.sync.set({ [KEY]: [...list, host] });
  } else if (!excluded && has) {
    await chrome.storage.sync.set({ [KEY]: list.filter((h) => h !== host) });
  }
}

// --- Granular passthrough (host → chars to pass) ---

export async function loadKeyPassthrough(): Promise<Record<string, string[]>> {
  if (typeof chrome === 'undefined' || !chrome.storage?.sync) return {};
  const r = await chrome.storage.sync.get(PASS_KEY);
  return normalizeMap(r[PASS_KEY]);
}

export async function getHostPassKeys(host: string): Promise<string[]> {
  if (!host) return [];
  return (await loadKeyPassthrough())[host] ?? [];
}

/** Set (or clear, with an empty array) the pass-through keys for a host. */
export async function setHostPassKeys(host: string, keys: readonly string[]): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.sync || !host) return;
  const map = await loadKeyPassthrough();
  const clean = Array.from(new Set(keys)).filter((k) => typeof k === 'string' && k.length > 0);
  if (clean.length) map[host] = clean;
  else delete map[host];
  await chrome.storage.sync.set({ [PASS_KEY]: map });
}

/** The combined keyboard policy for a host. */
export async function getSiteKeyState(host: string): Promise<{ excluded: boolean; passKeys: string[] }> {
  const [excluded, passKeys] = await Promise.all([isHostExcluded(host), getHostPassKeys(host)]);
  return { excluded, passKeys };
}

/** Subscribe to any change in the per-site keyboard policy (exclusions OR
 * passthrough). Returns an unsubscribe. */
export function onSiteKeysChanged(cb: () => void): () => void {
  if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) return () => {};
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ): void => {
    if (area === 'sync' && (changes[KEY] || changes[PASS_KEY])) cb();
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
