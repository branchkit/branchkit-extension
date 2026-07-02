/**
 * BranchKit Browser — open-tab voice collection (Layer 3 of
 * notes/DESIGN_TAB_NAVIGATION.md).
 *
 * Publishes the open-tab set to the browser plugin as spoken-word entries so
 * "switch to <tab>" resolves through the matcher's collection capture — the
 * same machinery as the apps list ("open <app>"). Voice-only: with no
 * BranchKit host connected nothing publishes and the feature is simply absent.
 *
 * Word selection honors the three design cares:
 *  - Lexicon gap: the recognition model silently drops words missing from its
 *    BPE lexicon, so we publish plain lowercase ASCII words from titles and
 *    domains — never full titles, numbers, or punctuation-bearing tokens.
 *  - Title churn: SPA pages retitle constantly (notification counts,
 *    now-playing). Publishes are debounced AND skipped when the computed
 *    entry set is unchanged — the same guard class that fixed the
 *    mid-utterance recognizer rebuild bug (see project_command_twice_fresh_page).
 *  - Disambiguation: a word claimed by several tabs resolves to the most
 *    recently used claimant (MRU tiebreak); tabs prefer title words unique to
 *    them and fall back to domain words. Tabs that win no word are reachable
 *    only via the palette (Layer 2) — an accepted gap.
 *
 * Pure word/assignment logic is separated from the chrome.* glue for unit
 * testing, mirroring tab-mru.ts.
 */

import { loadMru } from './tab-mru';
import { bgState, connId } from './state';
import { postToPlugin } from '../plugin/actuator-client';

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

// Function words plus web-title boilerplate that appears in most tabs and so
// carries no switching signal. Deliberately modest — over-filtering costs
// reachable tabs more than under-filtering costs grammar noise.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'your', 'you', 'are', 'not', 'this',
  'that', 'has', 'have', 'was', 'can', 'will', 'more', 'one', 'get', 'out',
  'into', 'about', 'when', 'where', 'which', 'while', 'then', 'than', 'their',
  'them', 'they', 'its', 'www', 'com', 'org', 'net', 'html', 'http', 'https',
  'untitled', 'page', 'new', 'tab', 'how', 'what', 'why', 'all',
]);

// Per-tab and total bounds keep the published grammar small: every spoken key
// lands in the engine's union grammar (and its HWM), so an unbounded tab strip
// would bloat recognition for marginal reach.
const MAX_WORDS_PER_TAB = 3;
const MAX_TOTAL_ENTRIES = 150;
// Only this many leading title words are considered — title tails are
// low-signal (site names, taglines) and inflate the shared-word pool.
const TITLE_WORDS_CONSIDERED = 6;

/**
 * Lowercase speakable words from a tab title: pure a-z runs, 3+ chars,
 * stopwords dropped, order preserved, deduped. Digits/punctuation/non-ASCII
 * are token boundaries and never emitted (BPE lexicon safety).
 */
export function titleWords(title: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of title.toLowerCase().split(/[^a-z]+/)) {
    if (raw.length < 3 || raw.length > 20) continue;
    if (STOPWORDS.has(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

/**
 * Speakable words from a tab URL's hostname, registrable label first:
 * "mail.google.com" → ["google", "mail"], "github.com" → ["github"].
 * Non-http(s) URLs (chrome://, about:) yield none. The TLD and "www" (and
 * any other ≤2-char label) are dropped; remaining labels pass the same
 * a-z filter as title words.
 */
export function domainWords(url: string): string[] {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return [];
    host = u.hostname;
  } catch {
    return [];
  }
  const labels = host.toLowerCase().split('.');
  labels.pop(); // TLD carries no signal ("com", "org", "io")
  const out: string[] = [];
  // Reverse so the registrable domain leads: it's the word users say first.
  for (const label of labels.reverse()) {
    if (label === 'www' || label.length < 3 || label.length > 20) continue;
    if (!/^[a-z]+$/.test(label)) continue;
    if (STOPWORDS.has(label)) continue;
    if (!out.includes(label)) out.push(label);
  }
  return out;
}

/**
 * Build the published entry set for the current tab strip.
 *
 * Every candidate word (title + domain) is assigned to exactly one tab — the
 * MRU-most tab that carries it — so a spoken word is never ambiguous at match
 * time. Each tab then keeps up to MAX_WORDS_PER_TAB of the words it won,
 * preferring title words unique to it (df==1), then domain words, then shared
 * title words it happened to win. Output is sorted by spoken word so the
 * unchanged-set publish guard can compare serialized snapshots.
 *
 * `mruStack` is tab-mru's recency stack (index 0 = most recent). Tabs absent
 * from the stack rank last, ties broken by tab id for determinism.
 */
export function buildTabEntries(tabs: readonly OpenTab[], mruStack: readonly number[]): TabWordEntry[] {
  const mruRank = new Map<number, number>();
  mruStack.forEach((id, i) => mruRank.set(id, i));
  const rank = (id: number) => mruRank.get(id) ?? mruStack.length + id;

  interface Candidate {
    tab: OpenTab;
    title: string[];
    domain: string[];
  }
  const candidates: Candidate[] = tabs.map((tab) => ({
    tab,
    title: titleWords(tab.title).slice(0, TITLE_WORDS_CONSIDERED),
    domain: domainWords(tab.url),
  }));

  // Document frequency + winner (MRU-most claimant) per word.
  const claimants = new Map<string, Candidate[]>();
  for (const c of candidates) {
    for (const w of new Set([...c.title, ...c.domain])) {
      const list = claimants.get(w);
      if (list) list.push(c);
      else claimants.set(w, [c]);
    }
  }
  const winner = new Map<string, Candidate>();
  for (const [w, list] of claimants) {
    let best = list[0];
    for (const c of list) {
      if (rank(c.tab.tabId) < rank(best.tab.tabId)) best = c;
    }
    winner.set(w, best);
  }

  // Per-tab selection among won words, MRU-first so the total cap trims the
  // least recently used tabs' vocabulary rather than the current ones'.
  const entries: TabWordEntry[] = [];
  const ordered = [...candidates].sort((a, b) => rank(a.tab.tabId) - rank(b.tab.tabId));
  for (const c of ordered) {
    if (entries.length >= MAX_TOTAL_ENTRIES) break;
    const won = (w: string) => winner.get(w) === c;
    const uniqueTitle = c.title.filter((w) => claimants.get(w)!.length === 1);
    const sharedTitleWon = c.title.filter((w) => claimants.get(w)!.length > 1 && won(w));
    const domainWon = c.domain.filter(won);
    const picked: string[] = [];
    for (const w of [...uniqueTitle, ...domainWon, ...sharedTitleWon]) {
      if (picked.length >= MAX_WORDS_PER_TAB) break;
      if (!picked.includes(w)) picked.push(w);
    }
    for (const w of picked) {
      if (entries.length >= MAX_TOTAL_ENTRIES) break;
      entries.push({
        spoken: w,
        tab_id: String(c.tab.tabId),
        title: c.tab.title.slice(0, 80),
      });
    }
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
    .map((t) => ({ tabId: t.id, title: t.title ?? '', url: t.url ?? '' }));
  const entries = buildTabEntries(open, await loadMru());

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
