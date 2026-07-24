/**
 * BranchKit Browser — saved-reference sync (service-worker side).
 *
 * References are user-named page targets stored per-host in
 * chrome.storage.local; the plugin mirrors the name set so voice can match
 * them and the per-host bodies so other machines/sessions can recall them.
 * Lifted out of background.ts (notes/DESIGN_RESTRUCTURE_ROUND3.md); callers
 * own when to fire (connect edge hydrates then pushes; saves push through).
 */

import { ensureConnected, postToPlugin, getPluginPort, getPluginToken } from '../plugin/actuator-client';

export const REFERENCES_STORAGE_KEY = 'branchkit_references';

export async function loadAllReferenceNames(): Promise<string[]> {
  const result = await chrome.storage.local.get(REFERENCES_STORAGE_KEY);
  const store = result[REFERENCES_STORAGE_KEY] || {};
  const names = new Set<string>();
  for (const host of Object.keys(store)) {
    const refs = store[host]?.references;
    if (refs) {
      for (const name of Object.keys(refs)) {
        names.add(name);
      }
    }
  }
  return [...names];
}

export async function saveReferenceToCollection(host: string, name: string, reference: Record<string, unknown>): Promise<void> {
  if (!(await ensureConnected())) return;
  await postToPlugin('/reference/save', { host, name, reference });
}

export async function pushReferenceNames(): Promise<void> {
  if (!(await ensureConnected())) return;
  const names = await loadAllReferenceNames();
  await postToPlugin('/references', { names });
}

export async function hydrateReferencesFromCollection(): Promise<void> {
  if (!(await ensureConnected())) return;
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tab = tabs[0];
    if (!tab?.url) return;
    const host = new URL(tab.url).hostname;
    if (!host) return;

    // GET with query-param token (the references read endpoint's auth style).
    const resp = await fetch(
      `http://127.0.0.1:${getPluginPort()}/references?host=${encodeURIComponent(host)}&token=${getPluginToken()}`,
    );
    if (!resp.ok) return;
    const data = await resp.json();
    const refs = data?.references;
    if (!refs || Object.keys(refs).length === 0) return;

    const result = await chrome.storage.local.get(REFERENCES_STORAGE_KEY);
    const store = result[REFERENCES_STORAGE_KEY] || {};
    if (!store[host]) {
      store[host] = { references: {}, marks: {} };
    }
    for (const [name, ref] of Object.entries(refs)) {
      if (!store[host].references[name]) {
        store[host].references[name] = ref;
      }
    }
    await chrome.storage.local.set({ [REFERENCES_STORAGE_KEY]: store });
  } catch {
    // Plugin may be down or tab URL unavailable
  }
}
