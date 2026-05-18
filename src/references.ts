import { generateSelector, generateSelectorPath, resolveSelectorPath } from './selector-generator';
import { accessibleName } from './accessible-name';
import { deepQuerySelectorAll } from './scanner';

export interface SavedReference {
  selector: string;
  selectorPath?: string[];
  tag: string;
  createdAt: number;
  lastUsedAt: number;
  visibleText?: string;
}

export interface BookmarkStore {
  [hostPattern: string]: {
    references: Record<string, SavedReference>;
    marks: Record<string, SavedMark>;
  };
}

export interface SavedMark {
  scrollY: number;
  scrollX: number;
  scrollContainer?: string;
}

const STORAGE_KEY = 'branchkit_references';

async function loadStore(): Promise<BookmarkStore> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return (result[STORAGE_KEY] as BookmarkStore) ?? {};
}

async function saveStore(store: BookmarkStore): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: store });
}

function getHost(): string {
  return window.location.hostname;
}

function ensureHostEntry(store: BookmarkStore, host: string) {
  if (!store[host]) {
    store[host] = { references: {}, marks: {} };
  }
  return store[host];
}

export async function saveReference(name: string, el: Element): Promise<void> {
  const store = await loadStore();
  const host = getHost();
  const entry = ensureHostEntry(store, host);

  const path = generateSelectorPath(el);
  entry.references[name] = {
    selector: path[path.length - 1],
    selectorPath: path.length > 1 ? path : undefined,
    tag: el.tagName.toLowerCase(),
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    visibleText: accessibleName(el) || undefined,
  };

  await saveStore(store);
}

export async function resolveReference(name: string): Promise<Element | null> {
  const store = await loadStore();
  const host = getHost();
  const entry = store[host];
  if (!entry) return null;

  const ref = entry.references[name];
  if (!ref) return null;

  // 1a. Shadow path match (handles elements inside shadow DOM)
  if (ref.selectorPath) {
    const viaPath = resolveSelectorPath(ref.selectorPath);
    if (viaPath) {
      ref.lastUsedAt = Date.now();
      await saveStore(store);
      return viaPath;
    }
  }

  // 1b. Exact selector match (flat DOM)
  const direct = document.querySelector(ref.selector);
  if (direct) {
    ref.lastUsedAt = Date.now();
    await saveStore(store);
    return direct;
  }

  // 2. Tag + visible-text match (pierces shadow DOM)
  if (ref.visibleText) {
    const tag = ref.tag || '*';
    const candidates = deepQuerySelectorAll(document, tag);
    for (const el of candidates) {
      if (accessibleName(el) === ref.visibleText) {
        const path = generateSelectorPath(el);
        ref.selector = path[path.length - 1];
        ref.selectorPath = path.length > 1 ? path : undefined;
        ref.lastUsedAt = Date.now();
        await saveStore(store);
        return el;
      }
    }
  }

  // 3. Not found
  return null;
}

export async function deleteReference(name: string): Promise<boolean> {
  const store = await loadStore();
  const host = getHost();
  const entry = store[host];
  if (!entry || !entry.references[name]) return false;

  delete entry.references[name];
  await saveStore(store);
  return true;
}

export async function listReferences(): Promise<Record<string, SavedReference>> {
  const store = await loadStore();
  const host = getHost();
  return store[host]?.references ?? {};
}

export async function listAllReferenceNames(): Promise<string[]> {
  const store = await loadStore();
  const names = new Set<string>();
  for (const host of Object.keys(store)) {
    for (const name of Object.keys(store[host].references)) {
      names.add(name);
    }
  }
  return [...names];
}
