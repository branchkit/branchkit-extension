/**
 * Per-site keyboard-shortcut exclusions — hosts where BranchKit hands the
 * keyboard entirely to the page so its own shortcuts work (voice is
 * unaffected). The popup toggles the current host; the content script reads
 * this on load and reacts to changes. Stored in chrome.storage.sync so the
 * list follows the user across browsers. See notes/DESIGN_PASS_THROUGH.md.
 */

const KEY = 'keyExclusions';

function normalize(list: unknown): string[] {
  return Array.isArray(list) ? list.filter((h): h is string => typeof h === 'string') : [];
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

/** Subscribe to exclusion-list changes (e.g. the popup toggling this host).
 * Returns an unsubscribe. */
export function onKeyExclusionsChanged(cb: (list: string[]) => void): () => void {
  if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) return () => {};
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ): void => {
    if (area === 'sync' && changes[KEY]) cb(normalize(changes[KEY].newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
