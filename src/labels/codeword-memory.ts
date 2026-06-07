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
 * Phase 1 of Regime B (notes/completed/DESIGN_CODEWORD_STABILITY.md): the store only.
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
 *  generous. Raised 200→1000 (fix C, DESIGN_REGIME_B_RECALL.md): on a large
 *  reload-heavy page (QuickBase, ~655 hintable elements) the old 200 cap evicted
 *  the stable sidebar — remembered early, then pushed out by churny body content
 *  — so it had no memory to reclaim across a reload (measured: ~76% no-memory,
 *  sidebar ~48% stable). 1000 covers such pages whole; the codeword pool
 *  (alphabet²) bounds how many elements can carry a codeword anyway. */
export const MEMORY_CAP_PER_FRAME = 1000;

const memKey = (tabId: number, frameId: number): string =>
  `codewordMemory:${tabId}:${frameId}`;

/**
 * Canonical key for a fingerprint — exact equality on the same fields as
 * `scan/registry.ts` `fingerprintsEqual`, so a key match IS a fingerprint
 * match. Used for upsert dedup here (SW) and for the recall lookup CS-side.
 * The `\x1f` unit separator can't appear in the values: role/tag/inputType
 * are tokens, `text` is whitespace-collapsed by `visibleText`, and a control
 * char never appears in an href or accessible name.
 */
export function fingerprintKey(fp: Fingerprint): string {
  return [fp.role, fp.name, fp.tag, fp.text, fp.href ?? '', fp.inputType ?? ''].join('\x1f');
}

async function load(tabId: number, frameId: number): Promise<CodewordMemoryEntry[]> {
  const key = memKey(tabId, frameId);
  const result = await chrome.storage.session.get(key);
  const v = result[key];
  return Array.isArray(v) ? (v as CodewordMemoryEntry[]) : [];
}

// Per-frame write serialization. `rememberCodewords` is a load-modify-write on
// chrome.storage.session, and the content script fires it per onCodewordsChanged
// flush (frequent during scroll), so two calls for the same frame can interleave
// at the awaits — both load the same base array and the second `set` clobbers the
// first's additions (a silent lost update that lowers the reclaim rate). Chaining
// each frame's writes onto the previous one makes the load-modify-write atomic
// per frame without a cross-frame bottleneck.
const writeChains = new Map<string, Promise<void>>();

/**
 * Remember (or refresh) fingerprint→codeword for a frame. Upserts by
 * fingerprint identity: re-remembering an element moves it to most-recent and
 * updates its codeword/rect rather than duplicating. Entries are ordered
 * oldest→newest; the front (oldest) is evicted beyond `MEMORY_CAP_PER_FRAME`.
 * Empty input is a no-op. Concurrent calls for the same frame are serialized
 * (see `writeChains`) so no write is lost.
 */
export function rememberCodewords(
  tabId: number,
  frameId: number,
  entries: CodewordMemoryEntry[],
): Promise<void> {
  if (entries.length === 0) return Promise.resolve();
  const key = memKey(tabId, frameId);
  // Chain onto the prior write for this frame (error-swallowed so one failure
  // doesn't poison the queue), then run this frame's load-modify-write.
  const run = (writeChains.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(() => applyRemember(tabId, frameId, entries));
  writeChains.set(key, run);
  // Drop the chain entry once this write is the settled tail, bounding the map.
  void run.catch(() => {}).finally(() => {
    if (writeChains.get(key) === run) writeChains.delete(key);
  });
  return run;
}

async function applyRemember(
  tabId: number,
  frameId: number,
  entries: CodewordMemoryEntry[],
): Promise<void> {
  const existing = await load(tabId, frameId);
  // Ordered map: re-inserting a key must move it to newest, so delete-then-set.
  const ordered = new Map<string, CodewordMemoryEntry>();
  for (const e of existing) ordered.set(fingerprintKey(e.fp), e);
  for (const e of entries) {
    const k = fingerprintKey(e.fp);
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
