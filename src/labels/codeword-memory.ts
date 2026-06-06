/**
 * BranchKit Browser — per-(tab, frame) fingerprint→codeword memory.
 *
 * Service-worker-side, persisted in `chrome.storage.session` (alongside the
 * label-pool's LabelStack). Survives content-script teardown: a Regime-B
 * navigation (full document reload) destroys the CS and its fingerprint
 * registry, but the SW persists — so a fresh CS can reclaim the codeword a
 * fingerprint held before the reload. Keyed per frame because reloads are
 * per-frame; LRU-capped per frame to bound growth on long-lived tabs.
 *
 * Phase 1 of Regime B (notes/DESIGN_CODEWORD_STABILITY.md): the store only.
 * The write wiring (CS sends fingerprints when a wrapper takes a codeword) is
 * phase 2; the confidence-ladder match on recall is phase 3 and lives
 * content-script side (where `fingerprintsEqual` + the position tiebreak are),
 * so `recallCodewords` returns the raw remembered entries for the CS to match.
 */

import type { Fingerprint } from '../scan/registry';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CodewordMemoryEntry {
  fp: Fingerprint;
  codeword: string;
  /** Last-known viewport rect, for the position tiebreak when several
   *  remembered entries share a fingerprint. Null when unknown. */
  rect: Rect | null;
}

/** Max remembered fingerprints per frame. Beyond this, the least-recently
 *  remembered entries are evicted. It's data, not pool slots, so this can be
 *  generous; 200 comfortably covers a dense page's distinctive elements. */
export const MEMORY_CAP_PER_FRAME = 200;

const memKey = (tabId: number, frameId: number): string =>
  `codewordMemory:${tabId}:${frameId}`;

/**
 * Canonical key for a fingerprint — used only for upsert dedup (the same
 * element remembered twice replaces, not duplicates). Fields match
 * `scan/registry.ts` `fingerprintsEqual`. The `\x1f` unit separator can't
 * appear in the values: role/tag/inputType are tokens, `text` is
 * whitespace-collapsed by `visibleText`, and a control char never appears in
 * an href or accessible name.
 */
function fpKey(fp: Fingerprint): string {
  return [fp.role, fp.name, fp.tag, fp.text, fp.href ?? '', fp.inputType ?? ''].join('\x1f');
}

async function load(tabId: number, frameId: number): Promise<CodewordMemoryEntry[]> {
  const key = memKey(tabId, frameId);
  const result = await chrome.storage.session.get(key);
  const v = result[key];
  return Array.isArray(v) ? (v as CodewordMemoryEntry[]) : [];
}

/**
 * Remember (or refresh) fingerprint→codeword for a frame. Upserts by
 * fingerprint identity: re-remembering an element moves it to most-recent and
 * updates its codeword/rect rather than duplicating. Entries are ordered
 * oldest→newest; the front (oldest) is evicted beyond `MEMORY_CAP_PER_FRAME`.
 * Empty input is a no-op.
 */
export async function rememberCodewords(
  tabId: number,
  frameId: number,
  entries: CodewordMemoryEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  const existing = await load(tabId, frameId);
  // Ordered map: re-inserting a key must move it to newest, so delete-then-set.
  const ordered = new Map<string, CodewordMemoryEntry>();
  for (const e of existing) ordered.set(fpKey(e.fp), e);
  for (const e of entries) {
    const k = fpKey(e.fp);
    ordered.delete(k);
    ordered.set(k, e);
  }
  let list = [...ordered.values()];
  if (list.length > MEMORY_CAP_PER_FRAME) {
    list = list.slice(list.length - MEMORY_CAP_PER_FRAME); // keep newest CAP
  }
  await chrome.storage.session.set({ [memKey(tabId, frameId)]: list });
}

/**
 * Recall every remembered entry for a frame (oldest first, newest last). The
 * content script runs the confidence ladder (`fingerprintsEqual` + position
 * tiebreak) against this set to resolve each element's preferred codeword.
 */
export async function recallCodewords(
  tabId: number,
  frameId: number,
): Promise<CodewordMemoryEntry[]> {
  return load(tabId, frameId);
}

/**
 * Drop a frame's memory (frame teardown), or — when `frameId` is omitted —
 * every frame's memory for a tab (tab close).
 */
export async function clearCodewordMemory(tabId: number, frameId?: number): Promise<void> {
  if (frameId !== undefined) {
    await chrome.storage.session.remove(memKey(tabId, frameId));
    return;
  }
  const all = await chrome.storage.session.get();
  const prefix = `codewordMemory:${tabId}:`;
  for (const k of Object.keys(all)) {
    if (k.startsWith(prefix)) await chrome.storage.session.remove(k);
  }
}
