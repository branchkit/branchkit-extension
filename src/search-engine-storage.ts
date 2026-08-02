/**
 * BranchKit Browser — search engine template persistence.
 *
 * One source of truth for the `chrome.storage.sync.searchEngine` key: the
 * URL template the palette's web-search row substitutes the query into
 * (DESIGN_PALETTE_URL_SEARCH.md). One user-set template string with `%s`,
 * not a curated engine menu — the closed shape is "one template", the valve
 * is that the string is yours.
 */

export const DEFAULT_SEARCH_TEMPLATE = 'https://www.google.com/search?q=%s';

const STORAGE_KEY = 'searchEngine';

export async function loadSearchTemplate(): Promise<string> {
  const result = await chrome.storage.sync.get(STORAGE_KEY);
  const stored = result[STORAGE_KEY];
  return typeof stored === 'string' && stored.trim() !== '' ? stored : DEFAULT_SEARCH_TEMPLATE;
}

export function saveSearchTemplate(template: string): void {
  const t = template.trim();
  if (t === '' || t === DEFAULT_SEARCH_TEMPLATE) {
    chrome.storage.sync.remove(STORAGE_KEY);
  } else {
    chrome.storage.sync.set({ [STORAGE_KEY]: t });
  }
}
