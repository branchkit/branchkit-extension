import { generateSelector } from './selector-generator';
import { accessibleName } from './accessible-name';

export interface SavedReference {
  selector: string;
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

  entry.references[name] = {
    selector: generateSelector(el),
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

  // 1. Exact selector match
  const direct = document.querySelector(ref.selector);
  if (direct) {
    ref.lastUsedAt = Date.now();
    await saveStore(store);
    return direct;
  }

  // 2. Tag + visible-text match
  if (ref.visibleText) {
    const tag = ref.tag || '*';
    const candidates = document.querySelectorAll(tag);
    for (const el of candidates) {
      if (accessibleName(el) === ref.visibleText) {
        ref.selector = generateSelector(el);
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
