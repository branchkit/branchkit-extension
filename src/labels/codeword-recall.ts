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
  const map = new Map<string, CodewordMemoryEntry[]>();
  for (const e of entries) {
    const k = fingerprintKey(e.fp);
    const list = map.get(k);
    if (list) list.push(e);
    else map.set(k, [e]);
  }
  byKey = map;

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

/** Remembered codewords (newest-first, deduped) for the reservoir's initial
 *  preferred-fill. Empty until `loadRecall` has run. */
export function recalledCodewords(): string[] {
  return allCodewords;
}

export function isRecallLoaded(): boolean {
  return byKey !== null;
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

/** Test-only: reset the loaded state. */
export function _resetForTests(): void {
  byKey = null;
  allCodewords = [];
}
