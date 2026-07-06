/**
 * BranchKit Browser — tab marker pool (notes/DESIGN_TAB_MARKERS.md).
 *
 * Assigns a STABLE marker to each open tab, drawn from a reserved-letter pool:
 * the first `MARKER_SINGLES` letters are one-letter markers, the rest form a
 * DISJOINT pair pool. Because no single letter ever begins a pair, the set is
 * prefix-free → chop-safe with no bridge, AND a single keystroke can activate a
 * single-letter mark in the palette (nothing longer starts with it).
 *
 * LETTER-FIRST (2026-07-05): the marker IS a letter token ("a", "iz") — the
 * extension-owned identity, exactly like hint letters (labels/words.ts). It's
 * assigned, displayed on the strip, and typed in the palette with NO dependency
 * on the voice alphabet, so it works for the keyboard standalone. The spoken
 * codeword is an OVERLAY: `markToSpokenWords` maps the letters to alphabet words
 * ("iz" → "iris zone") only when voice is connected, for the palette's voice
 * half. This is the hint model: letters primary, voice derived.
 *
 * Markers are stable for a tab's lifetime (perceptual continuity): assigned on
 * first sight, kept until the tab closes, transferred on discard/replace, never
 * reassigned while alive — Rango's pool model. Pure pool ops are separated from
 * the chrome.* glue for unit testing, mirroring tab-mru.ts / tab-collection.ts.
 */

import { LETTERS_26 } from '../labels/words';

/** Reserved single-letter markers (from the typing-ergonomic head); the rest
 *  form the pair pool. 16 → 16 singles + 10×9 = 90 pairs = 106 tabs. See the
 *  capacity table in the design doc; one-line retune. */
export const MARKER_SINGLES = 16;

/** tabId → assigned letter-token marker ("a", "iz"). */
export type MarkerMap = Record<number, string>;

/**
 * The ordered canonical marker sequence: single letters (ergonomic head)
 * first, then pairs drawn only from the tail. Assignment takes the earliest
 * free entry, so the most-reachable single letters go to the earliest tabs.
 * No voice dependency — the markers are letters.
 */
export function buildMarkerSequence(singles = MARKER_SINGLES): string[] {
  const out: string[] = LETTERS_26.slice(0, singles);
  const tail = LETTERS_26.slice(singles);
  for (let i = 0; i < tail.length; i++) {
    for (let j = 0; j < tail.length; j++) {
      if (i !== j) out.push(`${tail[i]}${tail[j]}`);
    }
  }
  return out;
}

/**
 * The spoken form of a letter-token marker, for the palette's voice half:
 * each letter → its alphabet word by alphabetical position ("iz" → "iris
 * zone"). Empty when the alphabet isn't a valid 26-word list (voice absent —
 * the letter mark still works for keyboard).
 */
export function markToSpokenWords(marker: string, alphabet: readonly string[]): string {
  if (alphabet.length !== 26 || alphabet.some((w) => typeof w !== 'string' || w.length === 0)) {
    return '';
  }
  const words: string[] = [];
  for (const ch of marker) {
    const idx = ch.charCodeAt(0) - 97; // 'a' → 0
    if (idx < 0 || idx > 25) return '';
    words.push(alphabet[idx]);
  }
  return words.join(' ');
}

/**
 * The marker to assign `tabId`, without mutating `assigned`:
 *  - if the tab already holds one, keep it (stability);
 *  - else if `preferred` is a real, currently-free marker, re-grant it
 *    (restart reconciliation re-adopts a tab's prior mark);
 *  - else the earliest free marker in the sequence (singles first);
 *  - else null (pool exhausted — the tab renders unmarked, still reachable
 *    by title word / palette).
 */
export function assignMarker(
  assigned: MarkerMap,
  tabId: number,
  sequence: readonly string[],
  preferred?: string,
): string | null {
  const existing = assigned[tabId];
  if (existing) return existing;
  const used = new Set(Object.values(assigned));
  if (preferred && sequence.includes(preferred) && !used.has(preferred)) {
    return preferred;
  }
  for (const marker of sequence) {
    if (!used.has(marker)) return marker;
  }
  return null;
}

/** A copy of `assigned` without `tabId` (marker returns to the free pool). */
export function releaseMarker(assigned: MarkerMap, tabId: number): MarkerMap {
  if (!(tabId in assigned)) return assigned;
  const next = { ...assigned };
  delete next[tabId];
  return next;
}

// --- Service-worker glue ---

const MARKERS_KEY = 'tabMarkers';

export async function loadMarkerMap(): Promise<MarkerMap> {
  try {
    const got = await chrome.storage.session.get(MARKERS_KEY);
    const v = got[MARKERS_KEY];
    return v && typeof v === 'object' ? (v as MarkerMap) : {};
  } catch {
    return {};
  }
}

export async function saveMarkerMap(map: MarkerMap): Promise<void> {
  try {
    await chrome.storage.session.set({ [MARKERS_KEY]: map });
  } catch {
    /* session storage unavailable — markers degrade to per-SW-lifetime */
  }
}

/**
 * Parse the marker back out of a tab's decorated title (restart
 * reconciliation) — the letter token ("a" / "iz"), or null.
 *
 * Only the compact LETTER form re-grants: it's the stable machine identity, and
 * "[iz] " reads back to "iz" directly. A word/expand-mode title ("[iris zone] ")
 * returns null — reversing displayed words to a letter needs the voice alphabet,
 * which may be absent at restart, so those tabs are reassigned from the free
 * pool instead. Marks live in chrome.storage.session and survive most SW
 * restarts, so this title parse is only the cold-start fallback; the cost of a
 * miss is a possibly-different mark on a marked-in-word-mode tab after a cold
 * restart, not a correctness bug.
 */
export function parseMarker(title: string): string | null {
  const m = title.match(/^\[([a-z]{1,2})\] /);
  return m ? m[1] : null;
}

// --- Orchestration (chrome.tabs + messaging) ---
//
// Message model (content side is render/tab-title.ts):
//   GET_TAB_MARKER   content → bg on load; response { letters } bootstraps the
//                    initial decoration (assignment is lazy, done here).
//   TAB_MARKER       bg → content push on assignment change / toggle;
//                    setTabMarker (force write, or null to clear).
//   TAB_MARKER_REAPPLY  bg → content on page retitle; reapplyTabMarker runs the
//                    echo + incremental-edit guards against the page's new title.
//
// Gating is the toggle ALONE now (letter-first): the marker is a letter, useful
// for the keyboard (palette letter-jump) with no voice, so marks are NOT gated
// on the BranchKit connection. The spoken overlay is only consulted at voice
// publish time, where an absent alphabet just means no spoken form.

let enabled = false;

export function isTabMarkersEnabled(): boolean {
  return enabled;
}

/** The tabMarkersEnabled setting changed (toggle / init). Decorate or strip
 *  every tab to match — no connection dependency. */
export async function setTabMarkersEnabled(on: boolean): Promise<void> {
  if (on === enabled) return;
  enabled = on;
  if (enabled) await decorateAllTabs();
  else await undecorateAllTabs();
}

/**
 * Ensure `tabId` has a marker (assigning + persisting on first sight) and
 * return its letter token, or null when the feature is off / pool exhausted.
 * `title`, if decorated, supplies a preferred marker so a reconciled/restored
 * tab re-adopts the mark already baked into its title. No voice dependency.
 */
export async function getTabMarker(tabId: number, title?: string): Promise<string | null> {
  if (!enabled) return null;
  const sequence = buildMarkerSequence();
  const map = await loadMarkerMap();
  const preferred = title ? parseMarker(title) ?? undefined : undefined;
  const marker = assignMarker(map, tabId, sequence, preferred);
  if (marker && map[tabId] !== marker) {
    map[tabId] = marker;
    await saveMarkerMap(map);
  }
  return marker;
}

function sendToTopFrame(tabId: number, message: unknown): void {
  chrome.tabs.sendMessage(tabId, message, { frameId: 0 }).catch(() => {
    /* no content script (chrome://, PDF, unloaded) — mark stays in the pool */
  });
}

/** Compute + push this tab's marker letters (assignment change / toggle-on). */
export async function pushTabMarker(tabId: number, title?: string): Promise<void> {
  sendToTopFrame(tabId, { type: 'TAB_MARKER', letters: await getTabMarker(tabId, title) });
}

/** Page retitled — tell the tab to re-apply its (unchanged) marker with the
 *  content-side guards. Cheap no-op when disabled. */
export function reapplyTabMarker(tabId: number): void {
  if (!enabled) return;
  sendToTopFrame(tabId, { type: 'TAB_MARKER_REAPPLY' });
}

/** Tab closed — return its marker to the free pool. */
export async function releaseTabMarker(tabId: number): Promise<void> {
  const map = await loadMarkerMap();
  const next = releaseMarker(map, tabId);
  if (next !== map) await saveMarkerMap(next);
}

/** Chrome discarded/replaced a tab — carry the marker to the new id so the
 *  visible mark doesn't jump. */
export async function transferTabMarker(oldId: number, newId: number): Promise<void> {
  const map = await loadMarkerMap();
  const marker = map[oldId];
  if (!marker) return;
  const next = releaseMarker(map, oldId);
  next[newId] = marker;
  await saveMarkerMap(next);
}

/** Push marks to every tab (toggle-on / init). Passes each tab's current title
 *  so a decorated one re-adopts its baked-in mark (restart reconciliation). */
async function decorateAllTabs(): Promise<void> {
  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }
  for (const t of tabs) {
    if (typeof t.id === 'number') await pushTabMarker(t.id, t.title ?? undefined);
  }
}

/** Clear marks from every tab (toggle-off). Leaves the pool intact — a
 *  re-enable re-derives, and stale marks in restored titles strip on adopt. */
async function undecorateAllTabs(): Promise<void> {
  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }
  for (const t of tabs) {
    if (typeof t.id === 'number') sendToTopFrame(t.id, { type: 'TAB_MARKER', letters: null });
  }
}
