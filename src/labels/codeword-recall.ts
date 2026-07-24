/**
 * BranchKit Browser — content-script side of the codeword memory (read path).
 *
 * Loads the per-frame fingerprint→codeword memory from the service worker once
 * at startup (the SW-persisted store survives a Regime-B full-document reload),
 * indexes it by fingerprint key, and resolves a preferred codeword for a
 * freshly-discovered element via the confidence ladder. The wrapper's
 * `preferredCodeword` is then carried into the claim so the element can reclaim
 * the codeword it held before the reload.
 *
 * Phase 3 of Regime B (notes/completed/DESIGN_CODEWORD_STABILITY.md). Resolving the
 * preference is all this does; actually granting the remembered codeword (the
 * targeted preferred-refill through the reservoir) is phase 4.
 */

import type { Fingerprint } from '../scan/registry';
import * as idRegistry from '../scan/registry';
import type { ElementWrapper } from '../scan/element-wrapper';
import type { Message } from '../types';
import { fingerprintKey, type CodewordMemoryEntry, type Rect } from './codeword-memory';
import { REBIND_DISTANCE_THRESHOLD_PX } from './rebind';

// null = not loaded yet; a Map (possibly empty) = loaded. Callers gate on
// `isRecallLoaded()` so a not-yet-loaded recall never masquerades as "no
// memory" (which would let a wrapper claim fresh and miss its reclaim).
let byKey: Map<string, CodewordMemoryEntry[]> | null = null;
// Remembered codewords, newest-first and deduped — for the reservoir's initial
// preferred-fill (phase 4). Newest-first because recently-seen elements are the
// likeliest to reappear in the new page's viewport after a reload.
let allCodewords: string[] = [];
// Frozen snapshot of the SW-persisted memory as it was at page load (before any
// in-session `rememberLive` updates overwrote `byKey`). The reclaim metric
// compares each element's assigned codeword against THIS — i.e. "did we give it
// back the letter it had before the reload" — which the live `byKey` can't
// answer because rememberLive rewrites it to match whatever just got claimed.
let loadedPersisted: Map<string, string> = new Map();

/**
 * Fetch this frame's remembered entries from the SW and index them by
 * fingerprint key. Idempotent enough for one startup call; a failed/absent
 * recall resolves to an empty (but loaded) map so callers stop waiting.
 */
export async function loadRecall(): Promise<void> {
  let entries: CodewordMemoryEntry[] = [];
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'RECALL_CODEWORDS' });
    if (Array.isArray(resp?.entries)) entries = resp.entries as CodewordMemoryEntry[];
  } catch {
    // SW unreachable (orphan / asleep) — treat as no memory.
  }
  // Group the persisted entries by key (a shared fingerprint keeps several,
  // for the position tiebreak), then merge into the index rather than
  // overwrite: `rememberLive` may have already seeded a live in-session entry
  // (a claim that beat this boot fetch). A live entry reflects the current
  // page, so a stale persisted group for the same fingerprint must not clobber
  // it.
  const swMap = new Map<string, CodewordMemoryEntry[]>();
  for (const e of entries) {
    const k = fingerprintKey(e.fp);
    const list = swMap.get(k);
    if (list) list.push(e);
    else swMap.set(k, [e]);
  }
  if (!byKey) byKey = new Map();
  for (const [k, list] of swMap) {
    if (!byKey.has(k)) byKey.set(k, list);
  }

  // Freeze the as-loaded persisted memory for the reclaim metric (one codeword
  // per key, last wins — coarse but enough to score "reclaimed vs missed").
  loadedPersisted = new Map();
  for (const e of entries) {
    if (e.codeword) loadedPersisted.set(fingerprintKey(e.fp), e.codeword);
  }

  // Flatten to newest-first, deduped codewords for the reservoir initial fill.
  const seen = new Set<string>();
  allCodewords = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const cw = entries[i].codeword;
    if (cw && !seen.has(cw)) {
      seen.add(cw);
      allCodewords.push(cw);
    }
  }
}

// Cap on the live in-session index. Keyed by distinct fingerprint, so a churny
// page (dup-fingerprint comment buttons) collapses to one entry per key and
// this is rarely approached; the bound just stops a long-lived SPA session from
// growing the index without limit. LRU: re-claiming a fingerprint moves it to
// newest, so eviction drops the least-recently-seen.
const LIVE_RECALL_CAP = 1000;

/**
 * Update the in-session index when codewords are claimed, so a wrapper that
 * re-attaches later in the SAME session (e.g. an SPA sidebar that re-mounts
 * outside the limbo-rebind window) can reclaim its codeword by fingerprint via
 * `seedPreferredFromMemory` — independent of limbo timing. Mirrors the SW
 * upsert: one entry per fingerprint key, latest wins. Complements the SW-
 * persisted store (which only loads at boot, after a full-document reload).
 */
export function rememberLive(entries: CodewordMemoryEntry[]): void {
  if (entries.length === 0) return;
  if (!byKey) byKey = new Map();
  for (const e of entries) {
    if (!e.codeword) continue;
    const k = fingerprintKey(e.fp);
    byKey.delete(k);        // re-insert moves key to newest (LRU ordering)
    byKey.set(k, [e]);
  }
  while (byKey.size > LIVE_RECALL_CAP) {
    const oldest = byKey.keys().next().value;
    if (oldest === undefined) break;
    byKey.delete(oldest);
  }
}

/** Remembered codewords (newest-first, deduped) for the reservoir's initial
 *  preferred-fill. Empty until `loadRecall` has run. */
export function recalledCodewords(): string[] {
  return allCodewords;
}

export function isRecallLoaded(): boolean {
  return byKey !== null;
}

/**
 * The codeword the SW-persisted memory held for this fingerprint at page load
 * (before in-session updates), or null. The reclaim metric uses this to score
 * whether an element got its pre-reload letter back. NOT for the claim path —
 * that's `resolvePreferredCodeword`, which reads the live index.
 */
export function persistedCodeword(fp: Fingerprint): string | null {
  return loadedPersisted.get(fingerprintKey(fp)) ?? null;
}

/**
 * Resolve the remembered codeword for an element via the confidence ladder:
 *   - exactly one fingerprint match → its codeword;
 *   - several (same fingerprint, different elements) → nearest by per-axis
 *     center distance within `REBIND_DISTANCE_THRESHOLD_PX` (needs `rect`);
 *   - none, or ambiguous without a rect → null (claim fresh).
 * Returns null until the recall has loaded.
 */
export function resolvePreferredCodeword(fp: Fingerprint, rect: Rect | null): string | null {
  if (!byKey) return null;
  const matches = byKey.get(fingerprintKey(fp));
  if (!matches || matches.length === 0) return null;
  if (matches.length === 1) return matches[0].codeword;

  if (!rect) return null; // ambiguous and no position to disambiguate → fresh
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  let best: { codeword: string; d: number } | null = null;
  for (const m of matches) {
    if (!m.rect) continue;
    const mx = m.rect.x + m.rect.w / 2;
    const my = m.rect.y + m.rect.h / 2;
    const d = Math.max(Math.abs(mx - cx), Math.abs(my - cy));
    if (!best || d < best.d) best = { codeword: m.codeword, d };
  }
  if (!best || best.d > REBIND_DISTANCE_THRESHOLD_PX) return null;
  return best.codeword;
}

// Regime B (DESIGN_CODEWORD_STABILITY phase 2): persist fingerprint→codeword for
// newly-claimed wrappers so a fresh content script after a full-document (Regime B)
// reload can reclaim the same codeword. The fingerprint is already in the registry
// (no recompute). REMEMBER_CODEWORDS is not a pool-mutating message, so it stays
// clear of the reservoir's single-sender invariant. Fire-and-forget. Shared by
// the tracker claim path (content.ts) and the scan path (scan-orchestrator).
export function rememberClaimedCodewords(claimed: ElementWrapper[]): void {
  const entries: CodewordMemoryEntry[] = [];
  for (const w of claimed) {
    const codeword = w.scanned.codeword;
    if (!codeword || w.scanned.id <= 0) continue;
    const fp = idRegistry.get(w.scanned.id)?.fingerprint;
    if (!fp) continue;
    const r = w.lastRect;
    entries.push({
      fp,
      codeword,
      rect: r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null,
    });
  }
  if (entries.length === 0) return;
  // Live in-session index: lets a wrapper that re-attaches later this session
  // (SPA re-mount outside the limbo-rebind window) reclaim its codeword by
  // fingerprint. Synchronous + in-memory; the SW persist below is the across-
  // reload counterpart.
  rememberLive(entries);
  try {
    chrome.runtime.sendMessage({ type: 'REMEMBER_CODEWORDS', entries } as Message).catch(() => {});
  } catch {
    // Extension context invalidated (orphan post-reload) — best-effort.
  }
}

/** Test-only: reset the loaded state. */
export function _resetForTests(): void {
  byKey = null;
  allCodewords = [];
  loadedPersisted = new Map();
}
