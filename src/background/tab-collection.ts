/**
 * BranchKit Browser — open-tab voice collection (Layer 3 of
 * notes/DESIGN_TAB_NAVIGATION.md).
 *
 * Publishes the open-tab set to the browser plugin as spoken-word entries so
 * "tab <codeword>" resolves through the matcher's collection capture — the
 * same machinery as the apps list ("open <app>"). Each entry is a tab's stable
 * MARK codeword (the one shown on the strip). Voice-only: with no BranchKit
 * host connected nothing publishes and the feature is absent.
 *
 * Tab TITLES and DOMAINS are deliberately not projected. Earlier this module
 * also published distinctive title/site words ("tab github"), but that was
 * removed 2026-07-12: it leaked open-tab/search history onto the on-screen HUD
 * (a privacy hazard when presenting) and churned the recognition grammar every
 * time an SPA retitled. Tabs are now reachable by their mark or via the palette
 * (Layer 2) — the codewords are already shown on the strip, so nothing is lost.
 *
 * Marks are unique per tab (no word contention) and stable, so the debounced
 * unchanged-set publish guard almost always no-ops. Pure entry logic is kept
 * separate from the chrome.* glue for unit testing, mirroring tab-mru.ts.
 */

import { loadMru } from './tab-mru';
import { bgState, connId } from './state';
import { postToPlugin } from '../plugin/actuator-client';
import { stripTabMarker } from '../tab-marker-format';
import { loadMarkerMap, markToSpokenWords } from './tab-markers';

/** Input shape: the fields of chrome.tabs.Tab this module consumes. */
export interface OpenTab {
  tabId: number;
  title: string;
  url: string;
}

/** One published record: `spoken` is the collection key the matcher hears;
 * `tab_id` is the dispatch target (string — action params are strings on the
 * wire); `title` is display context for debugging/HUD surfaces. */
export interface TabWordEntry {
  spoken: string;
  tab_id: string;
  title: string;
}

// Total bound keeps the published grammar small: every spoken key lands in the
// engine's union grammar (and its HWM), so an unbounded tab strip would bloat
// recognition for marginal reach.
const MAX_TOTAL_ENTRIES = 150;

/**
 * Build the published entry set for the current tab strip: each tab's stable
 * MARK codeword (the one shown on the strip), and nothing else.
 *
 * Tab titles and domains are deliberately NOT projected into the voice grammar.
 * That title/site-word matching ("tab github") was removed 2026-07-12 because
 * it leaked open-tab/search history into the on-screen HUD and churned the
 * recognition grammar on every SPA retitle. Switch tabs by the mark
 * ("tab <codeword>") or the palette (Layer 2) instead.
 *
 * `mruStack` (index 0 = most recent) only orders which tabs' marks survive the
 * MAX_TOTAL_ENTRIES cap; marks are unique per tab, so there's no word contention.
 */
export function buildTabEntries(
  tabs: readonly OpenTab[],
  mruStack: readonly number[],
  marks?: ReadonlyMap<number, string>,
): TabWordEntry[] {
  const entries: TabWordEntry[] = [];
  if (!marks || !marks.size) return entries;

  const mruRank = new Map<number, number>();
  mruStack.forEach((id, i) => mruRank.set(id, i));
  const rank = (id: number) => mruRank.get(id) ?? mruStack.length + id;

  const claimed = new Set<string>();
  const byMru = [...tabs].sort((a, b) => rank(a.tabId) - rank(b.tabId));
  for (const tab of byMru) {
    if (entries.length >= MAX_TOTAL_ENTRIES) break;
    const mw = marks.get(tab.tabId);
    if (!mw || claimed.has(mw)) continue;
    claimed.add(mw);
    entries.push({ spoken: mw, tab_id: String(tab.tabId), title: tab.title.slice(0, 80) });
  }

  entries.sort((a, b) => (a.spoken < b.spoken ? -1 : a.spoken > b.spoken ? 1 : 0));
  return entries;
}

// --- Service-worker glue ---

// Debounce absorbs tab-event bursts (window restore, SPA retitle streams)
// into one publish. Longer than the plugin's 50ms vocabulary-commit window on
// purpose: title churn is seconds-scale, and each distinct publish that adds
// words costs an engine grammar update at the next utterance boundary.
const TAB_PUBLISH_DEBOUNCE_MS = 500;

let publishTimer: ReturnType<typeof setTimeout> | null = null;
let lastPublishedJson: string | null = null;

/** Forget the last-published snapshot so the next publish always POSTs.
 * Called on SSE connect: a (re)connected plugin may have restarted and lost
 * its per-connection tab state, so the dedup guard must not suppress the
 * re-seed. */
export function resetTabPublishCache(): void {
  lastPublishedJson = null;
}

/**
 * Each tab's stable mark as its SPOKEN codeword (tabId → "huge"), for the
 * flat "tab <codeword>" path. Empty when the feature is off (no marks) or
 * voice isn't connected (no alphabet to speak the letter) — the marker letter
 * still works for the keyboard, but the spoken form needs the alphabet.
 */
async function buildMarkWords(): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  let alphabet: string[] = [];
  try {
    const got = await chrome.storage.local.get('alphabet');
    if (Array.isArray(got.alphabet)) alphabet = got.alphabet as string[];
  } catch { /* no alphabet */ }
  if (alphabet.length !== 26) return out;
  const markMap = await loadMarkerMap();
  for (const [tabId, mark] of Object.entries(markMap)) {
    const spoken = markToSpokenWords(mark, alphabet);
    if (spoken) out.set(Number(tabId), spoken);
  }
  return out;
}

/** Debounced entry point — call from any tab-strip event. Cheap no-op while
 * BranchKit is disconnected (standalone keyboard/hints use). */
export function scheduleTabPublish(): void {
  if (!bgState.branchkitConnected) return;
  if (publishTimer) clearTimeout(publishTimer);
  publishTimer = setTimeout(() => {
    publishTimer = null;
    void publishTabs();
  }, TAB_PUBLISH_DEBOUNCE_MS);
}

async function publishTabs(): Promise<void> {
  if (!bgState.branchkitConnected) return;
  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }
  const open: OpenTab[] = tabs
    .filter((t): t is chrome.tabs.Tab & { id: number } => typeof t.id === 'number')
    // Strip any tab-marker decoration before words are derived, or the marker
    // letters leak into the spoken word grammar (see DESIGN_TAB_MARKERS.md,
    // "The churn war"). Rango's getBareTitle twin, at the titles→grammar
    // chokepoint. No-op when the feature is off (title has no prefix).
    .map((t) => ({ tabId: t.id, title: stripTabMarker(t.title ?? ''), url: t.url ?? '' }));
  const entries = buildTabEntries(open, await loadMru(), await buildMarkWords());

  // Unchanged-set guard: retitles that don't change the published words (or
  // events that net out to nothing after the debounce) emit no POST, so the
  // plugin never sees a redundant sync and the engine grammar stays still.
  const snapshot = JSON.stringify(entries);
  if (snapshot === lastPublishedJson) return;

  // Bail-on-miss (no discovery): tab entries only matter to an already
  // connected plugin; the SSE connect path re-seeds after reconnects.
  const resp = await postToPlugin('/tabs', { conn_id: connId, entries });
  if (resp?.ok) {
    lastPublishedJson = snapshot;
  }
}
