/**
 * BranchKit Browser — tab marker pool (Phase 1 of notes/DESIGN_TAB_MARKERS.md).
 *
 * Assigns a STABLE spoken codeword to each open tab (the marker), drawn from a
 * reserved-letter pool: the first `MARKER_SINGLES` alphabet words are one-word
 * markers, the rest form a DISJOINT pair pool. Because no single word ever
 * begins a pair, the set is prefix-free → chop-safe with no bridge (the same
 * split as palette/codewords.ts, here parameterized for a tab-only membership).
 *
 * Markers are stable for a tab's lifetime (perceptual continuity): assigned on
 * first sight, kept until the tab closes, transferred on discard/replace, never
 * reassigned while alive — Rango's pool model. Pure pool ops are separated from
 * the chrome.* glue for unit testing, mirroring tab-mru.ts / tab-collection.ts.
 *
 * Phase 1 is visible decoration only: markers are shown on the tab strip and
 * kept off the voice grammar (the publisher strips them). The exclusive "tab
 * mode" that makes them speakable is Phase 2.
 */

import { codewordDisplay } from '../palette/codewords';
import { stripTabMarker } from '../tab-marker-format';

/** Reserved single-word markers (alphabet head); the rest form the pair pool.
 *  16 → 16 singles + 10×9 = 90 pairs = 106 tabs. See the capacity table in
 *  the design doc; one-line retune. */
export const MARKER_SINGLES = 16;

/** tabId → assigned spoken codeword ("arch", "quill reef"). */
export type MarkerMap = Record<number, string>;

/**
 * The ordered canonical marker sequence: singles (alphabet head) first, then
 * pairs drawn only from the tail. Assignment always takes the earliest free
 * entry, so singles are handed out before pairs. Empty when the alphabet
 * isn't a valid 26-word list (feature simply stays dormant).
 */
export function buildMarkerSequence(
  alphabet: readonly string[],
  singles = MARKER_SINGLES,
): string[] {
  if (alphabet.length !== 26 || alphabet.some((w) => typeof w !== 'string' || w.length === 0)) {
    return [];
  }
  const out: string[] = alphabet.slice(0, singles);
  const tail = alphabet.slice(singles);
  for (let i = 0; i < tail.length; i++) {
    for (let j = 0; j < tail.length; j++) {
      if (i !== j) out.push(`${tail[i]} ${tail[j]}`);
    }
  }
  return out;
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

/** The compact letter form shown on the strip ("arch"→"a", "quill reef"→"qr").
 *  The spoken codeword is unchanged; this only shapes the visible prefix. */
export function markerLetters(marker: string, alphabet: readonly string[]): string {
  return codewordDisplay(marker, alphabet, 'letter');
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
 * Parse a marker back out of a tab's decorated title (restart reconciliation).
 * Returns the letter token ("a" / "qr") if the title is decorated, else null —
 * the caller maps letters → codeword via the sequence to re-grant the mark.
 */
export function parseMarkerLetters(title: string): string | null {
  if (title === stripTabMarker(title)) return null;
  const bare = stripTabMarker(title);
  // The decoration is `${letters}${DELIM}${bare}`; letters is everything the
  // strip removed minus the delimiter, lowercased a–z.
  const removed = title.slice(0, title.length - bare.length);
  const m = removed.match(/[a-z]{1,2}/i);
  return m ? m[0].toLowerCase() : null;
}

/** The full-word marker whose letter form is `token`, if any (letters→codeword,
 *  for reconciliation preferred re-grant). */
export function markerFromLetters(
  token: string,
  alphabet: readonly string[],
  sequence: readonly string[],
): string | undefined {
  return sequence.find((m) => markerLetters(m, alphabet) === token);
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
// Effective-enabled = the tabMarkersEnabled setting AND a live BranchKit
// connection. The marker is a SPOKEN codeword whose alphabet comes from the
// host, so a mark with no voice is meaningless clutter (and the extension is
// designed to run standalone) — no connection, no marks. background.ts keeps
// both inputs current (setting from storage, connection from the SSE
// connect/disconnect hooks).

let settingEnabled = false;
let connected = false;
let effective = false;

export function isTabMarkersEnabled(): boolean {
  return effective;
}

/** Recompute effective-enabled and reconcile the strip to match. */
async function recompute(): Promise<void> {
  const next = settingEnabled && connected;
  if (next === effective) return;
  effective = next;
  if (effective) await decorateAllTabs();
  else await undecorateAllTabs();
}

/** The tabMarkersEnabled setting changed (toggle / init). */
export async function setTabMarkersSetting(on: boolean): Promise<void> {
  settingEnabled = on;
  await recompute();
}

/** BranchKit connected/disconnected (SSE hooks). Disconnect strips every mark;
 *  connect re-derives (once the alphabet lands, see refreshAllTabMarkers). */
export async function setTabMarkersConnected(isConnected: boolean): Promise<void> {
  connected = isConnected;
  await recompute();
}

/** The voice alphabet just arrived or changed — re-derive marks if active. The
 *  connect hook fires before the alphabet SSE event, so this is what actually
 *  paints marks on a fresh connection. */
export async function refreshAllTabMarkers(): Promise<void> {
  if (effective) await decorateAllTabs();
}

async function getAlphabet(): Promise<string[]> {
  try {
    const got = await chrome.storage.local.get('alphabet');
    return Array.isArray(got.alphabet) ? (got.alphabet as string[]) : [];
  } catch {
    return [];
  }
}

/**
 * Ensure `tabId` has a marker (assigning + persisting on first sight) and
 * return its letter form, or null when the feature is off / no alphabet /
 * pool exhausted. `title`, if decorated, supplies a preferred marker so a
 * reconciled/restored tab re-adopts the mark already baked into its title.
 */
export async function getTabMarkerLetters(tabId: number, title?: string): Promise<string | null> {
  if (!effective) return null;
  const alphabet = await getAlphabet();
  const sequence = buildMarkerSequence(alphabet);
  if (sequence.length === 0) return null; // alphabet not loaded yet
  const map = await loadMarkerMap();
  let preferred: string | undefined;
  if (title) {
    const token = parseMarkerLetters(title);
    if (token) preferred = markerFromLetters(token, alphabet, sequence);
  }
  const marker = assignMarker(map, tabId, sequence, preferred);
  if (marker && map[tabId] !== marker) {
    map[tabId] = marker;
    await saveMarkerMap(map);
  }
  return marker ? markerLetters(marker, alphabet) : null;
}

function sendToTopFrame(tabId: number, message: unknown): void {
  chrome.tabs.sendMessage(tabId, message, { frameId: 0 }).catch(() => {
    /* no content script (chrome://, PDF, unloaded) — mark stays in the pool */
  });
}

/** Compute + push this tab's marker letters (assignment change / toggle-on). */
export async function pushTabMarker(tabId: number, title?: string): Promise<void> {
  sendToTopFrame(tabId, { type: 'TAB_MARKER', letters: await getTabMarkerLetters(tabId, title) });
}

/** Page retitled — tell the tab to re-apply its (unchanged) marker with the
 *  content-side guards. Cheap no-op when disabled. */
export function reapplyTabMarker(tabId: number): void {
  if (!effective) return;
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
