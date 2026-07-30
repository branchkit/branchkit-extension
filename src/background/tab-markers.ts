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

import type { MessageHandler } from '../core/message-router';
import { LETTERS_26 } from '../labels/words';
import { loadKeymap } from '../keymap/keymap-storage';
import { derivePaletteNav } from '../keymap/palette-reserved';

/** Reserved single-letter markers (from the typing-ergonomic head); the rest
 *  LEAD the pairs. 16 → 16 singles + 10 leaders × 25 seconds = 266 tabs (211
 *  once the palette's five nav letters are withheld). Only the leader is drawn
 *  from the tail, so raising this costs pairs linearly, not quadratically. See
 *  the capacity table in the design doc; one-line retune. */
export const MARKER_SINGLES = 16;

/** tabId → assigned letter-token marker ("a", "iz"). */
export type MarkerMap = Record<number, string>;

const NO_RESERVED: ReadonlySet<string> = new Set();

/**
 * The ordered canonical marker sequence: single letters (ergonomic head)
 * first, then pairs drawn only from the tail. Assignment takes the earliest
 * free entry, so the most-reachable single letters go to the earliest tabs.
 * No voice dependency — the markers are letters.
 *
 * `reserved` holds letters the palette needs for list navigation
 * (keymap/palette-reserved.ts): a bare `j` cannot both jump to mark "j" and move
 * the selection down. Marks are READ on the tab strip but TYPED in the palette,
 * which is why a tab-strip label has to respect a palette keybinding. Filtering
 * happens AFTER the head/tail split, not before, so reservation never promotes a
 * tail letter into the singles head — a letter's role stays fixed. With the
 * shipping keymap that costs five of sixteen singles (all of d/g/j/k/u sit in the
 * head): 11 singles + 200 pairs = 211 markers.
 */
export function buildMarkerSequence(
  singles = MARKER_SINGLES,
  reserved: ReadonlySet<string> = NO_RESERVED,
): string[] {
  const usable = (ls: readonly string[]): string[] => ls.filter((l) => !reserved.has(l));
  const out: string[] = usable(LETTERS_26.slice(0, singles));
  // Only the LEADING letter is constrained. Prefix-freedom needs exactly one
  // thing — that no complete mark starts a longer one — so a pair's leader must
  // come from the tail, while its second letter can be ANY eligible letter,
  // including a singles-head letter. "ia" is unambiguous next to single "a":
  // pressing `i` completes nothing, so the palette is already committed to a
  // pair before the second key arrives, and single "a" is only reachable as a
  // FIRST keystroke.
  //
  // Restricting the second letter to the tail as well (what this did until
  // 2026-07-29) cost more than half the pool for nothing: 10x9=90 pairs where
  // 10x20=200 were available. It also made `singles` look far more expensive
  // than it is, since moving a letter head-ward shrank both positions at once.
  const leaders = usable(LETTERS_26.slice(singles));
  const seconds = usable(LETTERS_26);
  for (const lead of leaders) {
    for (const second of seconds) {
      // No repeats: "ii" is prefix-free and typeable, but its spoken overlay is
      // "iris iris", and a decoder that collapses a doubled word would resolve
      // to the wrong mark.
      if (second !== lead) out.push(`${lead}${second}`);
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
 * Serializes marker assignment. Load→assign→save is a read-modify-write across
 * two awaits, so concurrent callers otherwise all read the SAME pre-write map,
 * all pick "the earliest free marker", and all pick the SAME one — lost updates.
 * Measured 2026-07-29: creating 13 tabs in one loop produced `q` four times and
 * `l` three times, which makes every duplicate but one unreachable by mark and
 * starves the pair pool (13 tabs still fit in singles).
 *
 * Chained rather than locked because the operation is short, ordering is a fine
 * outcome (earliest caller gets the earliest marker), and a chain cannot deadlock
 * if a link rejects. Per-SW-lifetime is sufficient: every link persists before
 * the next reads.
 */
let markerWrites: Promise<unknown> = Promise.resolve();

function serializeMarkerWrite<T>(op: () => Promise<T>): Promise<T> {
  const done = markerWrites.then(op, op);
  markerWrites = done.catch(() => undefined);
  return done;
}

/**
 * Ensure `tabId` has a marker (assigning + persisting on first sight) and
 * return its letter token, or null when the feature is off / pool exhausted.
 * `title`, if decorated, supplies a preferred marker so a reconciled/restored
 * tab re-adopts the mark already baked into its title. No voice dependency.
 */
export async function getTabMarker(tabId: number, title?: string): Promise<string | null> {
  if (!enabled) return null;
  return serializeMarkerWrite(async () => {
    // The keymap is read per assignment rather than cached: a stale reserved set
    // would hand out a marker the palette can no longer type, and there is no
    // invalidation hook that wouldn't be a new listener. Reads sit alongside the
    // marker-map read, so this costs a second concurrent storage get on a tab's
    // FIRST sight only — assignMarker returns early for an already-marked tab.
    const [reserved, map] = await Promise.all([
      loadKeymap().then((km) => derivePaletteNav(km).reserved).catch(() => undefined),
      loadMarkerMap(),
    ]);
    const sequence = buildMarkerSequence(MARKER_SINGLES, reserved);
    const preferred = title ? parseMarker(title) ?? undefined : undefined;
    const marker = assignMarker(map, tabId, sequence, preferred);
    if (marker && map[tabId] !== marker) {
      map[tabId] = marker;
      await saveMarkerMap(map);
    }
    return marker;
  });
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

/**
 * Message handler owned by this module (notes/DESIGN_ENTRY_POINT_TOPOLOGY.md).
 * Content bootstrapping its tab marker on load. Assign lazily, reply with the
 * letter form (title supplies a preferred marker for reconciliation).
 */
export const tabMarkerMessageHandlers: Record<string, MessageHandler> = {
  GET_TAB_MARKER: (_message, sender) => {
    const tabId = sender.tab?.id;
    if (typeof tabId !== 'number') return { letters: null };
    return getTabMarker(tabId, sender.tab?.title ?? undefined)
      .then((letters) => ({ letters }))
      .catch(() => ({ letters: null }));
  },
};
