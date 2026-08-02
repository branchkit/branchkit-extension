/**
 * BranchKit Browser — command palette page (Layer 2 of
 * notes/DESIGN_TAB_NAVIGATION.md).
 *
 * Runs in the extension-served iframe the content script injects
 * (render/palette-host.ts). Extension origin, so (a) the host page cannot
 * observe keystrokes — the Vomnibar isolation rationale — and (b) it reads
 * chrome.tabs / storage directly instead of round-tripping through content.
 *
 * All selection/dispatch leaves through PALETTE_ACTION messages to the
 * background, which closes the overlay in the origin tab and then executes —
 * a tab switch directly, a command via PALETTE_COMMAND into the origin tab's
 * content dispatcher (exact keyboard-bind semantics).
 *
 * The list model (sources, ranking) is pure and lives in palette/model.ts.
 */

import { COMMAND_CATALOG } from './keymap/command-catalog';
import { loadKeymap } from './keymap/keymap-storage';
import {
  derivePaletteNav, navKeyToken, type PaletteNavIntent,
} from './keymap/palette-reserved';
import { applyNavIntent } from './palette/nav';
import { overridesFromList, type OverrideRecord } from './keymap/command-override';
import {
  buildTabItems, buildCommandItems, buildBookmarkItems, filterPalette, resolvePaletteQuery,
  buildSearchSection, buildUrlSection,
  type PaletteItem, type PaletteSection, type PaletteTab, type PaletteBookmark,
} from './palette/model';
import { DEFAULT_SEARCH_TEMPLATE, loadSearchTemplate } from './search-engine-storage';
import {
  assignCodewords, codewordDisplay, classifyMarkInput, codewordToken, splitSpokenBadge,
} from './palette/codewords';
import { micGlyph } from './render/mic-glyph';
import { markToSpokenWords, type MarkerMap } from './background/tab-markers';
import {
  RELAY_HELLO, RELAY_REQ, RELAY_RESP, RELAY_DIAG,
  RELAY_CODEWORDS, RELAY_NARROW, RELAY_ACTIVATE, RELAY_RELABEL,
  type BootstrapWire, type PaletteCodewordWire,
} from './palette/relay';

// Lifecycle breadcrumbs → host → plugin dispatch-result log (actuator.log,
// action=palette_diag). The only way to see inside this frame on browsers no
// harness drives (Firefox). Counts and error names only — never tab data.
declare const __BUILD_ID__: string;
function fdiag(msg: string): void {
  try { window.parent.postMessage({ type: RELAY_DIAG, msg }, '*'); } catch { /* no parent */ }
}
import { stripTabMarker } from './tab-marker-format';
import { openPhraseSession, isSentinelKey } from './scan/phrase-collector';
import type { BadgeDisplayMode } from './types';
import type { Message, PaletteVoiceEntry, PaletteVoiceRow } from './types';

const queryInput = document.getElementById('query') as HTMLInputElement;

/**
 * The box's dictation wire — chunk accumulation, the 400 ms utterance
 * boundary, replace-on-re-dictation — is the shared PhraseCollector's
 * (./scan/phrase-collector.ts, Wave 3 C5), which retired this file's
 * hand-rolled dictatedRun/dictatedAt/UTTERANCE_GAP_MS copy. The palette
 * filters live and the user picks a row, so dictation never auto-commits
 * (`autoCommitOnDictation: false`) and Enter/Escape stay this file's own
 * (Enter dispatches the SELECTED ROW — it is not a text commit). The
 * palette page lives exactly as long as its iframe, so one session spans
 * the module; blur/close teardown is the host's (window blur → close()).
 */
const phrase = openPhraseSession(
  {
    read: () => queryInput.value,
    replace: (text) => {
      queryInput.value = text;
      queryInput.setSelectionRange(text.length, text.length);
    },
  },
  { onCommit: () => {}, onCancel: () => {} },
  { autoCommitOnDictation: false },
);
const listEl = document.getElementById('list') as HTMLDivElement;
const backdrop = document.getElementById('backdrop') as HTMLDivElement;

// The script ran — clear the static "script did not run" probe row so what
// remains in #list is always the truth of how far boot got (see palette.html).
document.getElementById('boot-probe')?.remove();

// Scope from the host URL: 'tabs' shows only the open-tabs source (Ctrl+T /
// voice "palette tabs"), 'commands' only the catalog source (voice "palette
// commands"), 'bookmarks' only the bookmark source (voice "palette
// bookmarks"); anything else is the full command station.
const scopeParam = new URLSearchParams(location.search).get('scope');
const scope = scopeParam === 'tabs' || scopeParam === 'commands' || scopeParam === 'bookmarks'
  ? scopeParam : 'all';
fdiag(`boot build=${typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'unknown'} scope=${scope}`);

let tabItems: PaletteItem[] = [];
let commandItems: PaletteItem[] = [];
let bookmarkItems: PaletteItem[] = [];
let bookmarksError: string | undefined;
/** Engine template for the web-search row (search-engine-storage.ts). */
let searchTemplate = DEFAULT_SEARCH_TEMPLATE;
/** Flat render order of the current sections — the selection index space. */
let flat: PaletteItem[] = [];
let selected = 0;
/** Spoken badge per row id, assigned ONCE at open (publish-once discipline —
 *  refiltering never reassigns, so a row's badge is stable for the palette's
 *  lifetime). Empty when the voice alphabet isn't loaded. */
let codewords: Map<string, string> = new Map();
/** Claim-level token per row id ("o", "o r") — the same assignment as
 *  `codewords`, in the letter form the host's CodewordHolder speaks. Derived
 *  alongside it at the one publish point, so the two cannot drift. */
let tokens: Map<string, string> = new Map();
/** The alphabet the codewords were assigned from (for letter display). */
let voiceAlphabet: string[] = [];
/**
 * WHAT YOU TYPE to pick each row, in letter form ("f", "iz", "qr").
 *
 * The one label surface the keyboard speaks, so the typing path needs no scope
 * branch: tabs scope fills it with stable strip marks, every other scope with the
 * letter form of the row's codeword. Both are prefix-free — marks by the
 * head/tail split, codewords by uniform length within an open — which is the
 * property that lets a complete label activate on its last keystroke.
 */
let typedLabels: Map<string, string> = new Map();
/** tabId → stable strip mark (letter token). In tabs scope the palette rows
 *  use these instead of ephemeral codewords, so the strip and the palette show
 *  the SAME letter. */
let markMap: MarkerMap = {};
/** Shared badge display setting — the same `badgeDisplayMode` the page hints
 *  read, so palette badges show letters/words per the user's one preference.
 *  Same 'letter' fallback as config.ts. */
let displayMode: BadgeDisplayMode = 'letter';

// Input model (notes/DESIGN_PALETTE_KEYBOARD_NAV.md, extending
// DESIGN_TAB_MARKERS.md): EVERY scope opens in LETTER mode — like a page of
// hints, you type a row's label to pick it (prefix-free labels activate on the
// last keystroke) and the reserved nav letters walk the list. `/` switches to
// FUZZY search, mirroring the page's "hints vs / find" model, and Escape steps
// back. One model for all four scopes: the tabs-only asymmetry this replaced was
// invisible enough to mislead the person who built it.
type PaletteMode = 'letter' | 'fuzzy';
// 'fuzzy' is the PRE-BOOTSTRAP value, not the default: init promotes to letter
// mode as soon as labels exist. Starting in letter mode instead would swallow
// anything typed in the window before the bootstrap round-trip resolves, since
// letter mode consumes every single-character press.
let mode: PaletteMode = 'fuzzy';
/** The label letters typed so far in letter mode ("i" waiting for a pair). */
let markPrefix = '';
/**
 * Reserved nav letters + their meanings, derived from the user's keymap at open
 * (keymap/palette-reserved.ts). Empty until init resolves, and empty for a user
 * who navigates with the arrow keys.
 */
let navBindings: ReadonlyMap<string, PaletteNavIntent> = new Map();
/**
 * The letters those bindings occupy, withheld from codeword assignment. Tab marks
 * are filtered background-side (tab-markers.ts) since they outlive one palette
 * open; codewords are assigned here, so they are filtered here.
 */
let reservedLetters: ReadonlySet<string> = new Set();
/** Note shown above the rows when the effective query isn't the box text. */
let queryNote = '';

function send(action: Extract<Message, { type: 'PALETTE_ACTION' }>['action']): void {
  chrome.runtime.sendMessage({ type: 'PALETTE_ACTION', action } as Message).catch(() => {});
}

function close(): void {
  send({ kind: 'close' });
}

function dispatchItem(item: PaletteItem | undefined): void {
  if (item) send(item.dispatch);
}

/**
 * The sections the palette paints with no query — browse order.
 *
 * ONE definition, used by both the renderer and badge assignment. They used to
 * compute order independently (assignment walked
 * `[...tabItems, ...commandItems, ...bookmarkItems]`, the renderer walked
 * filterPalette's regrouped sections), and in the commands scope — the only one
 * where `groupedBrowse` regroups by catalog group — they disagreed, so the
 * palette read `ab`, `ac`, `br`, `bs`… down the list. Harmless while badges were
 * spoken-only; visibly wrong once letter mode paints them as labels you type.
 */
function emptyStateSections(): PaletteSection[] {
  return filterPalette(tabItems, commandItems, '', scope === 'commands', bookmarkItems);
}

/**
 * Every row this palette holds, in the order it is painted — the badge index
 * space, so badge N belongs to the Nth row on screen.
 *
 * With an empty query filterPalette's partition is exhaustive (`groupLabels`
 * enumerates every group present, and each item lands in exactly one), so this
 * is a reordering of all rows, not a filter. The tail append is a guard, not a
 * routine path: if that ever stops holding, a row must lose its PLACE rather
 * than its badge, because an unbadged row is unreachable by both voice and
 * keyboard.
 */
function publishOrder(): PaletteItem[] {
  const ordered = emptyStateSections().flatMap((s) => s.items);
  const every = [...tabItems, ...commandItems, ...bookmarkItems];
  if (ordered.length === every.length) return ordered;
  const seen = new Set(ordered.map((it) => it.id));
  const missing = every.filter((it) => !seen.has(it.id));
  fdiag(`publishOrder: ${missing.length} row(s) missing from browse sections`);
  return [...ordered, ...missing];
}

/**
 * Whether letter mode is reachable — i.e. whether anything carries a typeable
 * label. False when marks are off, the pool is exhausted, or the voice alphabet
 * never loaded; the palette is then search-only, and Escape closes rather than
 * stepping into an inert mode. Replaces the phase-1 per-scope constant: the real
 * condition was never the scope, it was whether labels exist.
 */
function hasLetterMode(): boolean {
  return typedLabels.size > 0;
}

/** The privileged data the palette needs at open, fetched from the
 * background in one round-trip. NOT read directly: on Firefox this iframe
 * runs with content-script privileges (chrome.tabs is undefined,
 * storage.session untrusted) — the 2026-07-25 "Ctrl+K is just empty" field
 * report. Chrome would allow direct reads, but one path serves both. */
interface PaletteBootstrap {
  tabs: PaletteTab[];
  mru: number[];
  marks: MarkerMap;
  bookmarks: PaletteBookmark[];
  bookmarksError?: string;
  activeTabId: number | null;
}

// --- Bootstrap relay (Firefox fallback; protocol doc in palette/relay.ts) ---
// The host content script HELLOs us a secret on frame load (page-invisible);
// a relayed RESP must echo it, so the page — which shares this window's
// message traffic and could forge a RESP via our contentWindow — can only
// forge blind. The secret may arrive after init starts (HELLO rides the
// frame's load event), hence the small promise dance.
let relaySecret: string | null = null;
let relaySecretReady: (() => void) | null = null;
const relaySecretArrived = new Promise<void>((res) => { relaySecretReady = res; });
let relayResolve: ((data: BootstrapWire | null) => void) | null = null;
/** Error string the host's RESP carried, for the overlay diagnosis. */
let relayError: string | null = null;

window.addEventListener('message', (ev) => {
  const d = ev.data as { type?: string; secret?: string; data?: BootstrapWire | null; error?: string } | null;
  if (!d) return;
  if (d.type === RELAY_HELLO && typeof d.secret === 'string') {
    relaySecret = d.secret;
    relaySecretReady?.();
    return;
  }
  if (d.type === RELAY_RESP && relaySecret !== null && d.secret === relaySecret) {
    relayError = d.error ?? null;
    relayResolve?.(d.data ?? null);
    relayResolve = null;
    return;
  }
  // The holder's void legs, driven by the host's registry membership. All
  // secret-checked: the page shares this window, and an activate it could
  // forge would dispatch a row the user never spoke.
  if (relaySecret === null || d.secret !== relaySecret) return;
  const leg = d as unknown as { prefix?: string; rowId?: string };
  if (d.type === RELAY_NARROW && typeof leg.prefix === 'string') {
    narrowRowBadges(leg.prefix);
  } else if (d.type === RELAY_ACTIVATE && typeof leg.rowId === 'string') {
    const item = [...tabItems, ...commandItems, ...bookmarkItems]
      .find((it) => it.id === leg.rowId);
    if (item) dispatchItem(item);
  } else if (d.type === RELAY_RELABEL) {
    renderCurrent();
  }
});

async function bootstrapViaRelay(): Promise<BootstrapWire | null> {
  // Wait for the host's HELLO (frame load) before asking, bounded — no host
  // relay (e.g. an old content script) must not hang the palette forever.
  await Promise.race([relaySecretArrived, new Promise((res) => setTimeout(res, 1500))]);
  if (relaySecret === null) {
    relayError = 'host content script never connected — refresh the tab (stale page script)';
    return null;
  }
  return new Promise((resolve) => {
    relayResolve = resolve;
    // The REQ crosses the page's window — it deliberately carries nothing.
    window.parent.postMessage({ type: RELAY_REQ }, '*');
    setTimeout(() => {
      if (relayResolve) relayError = 'host relay did not answer within 2s';
      relayResolve?.(null); relayResolve = null;
    }, 2000);
  });
}

async function loadBootstrap(): Promise<PaletteBootstrap> {
  // Direct first (Chrome: this frame is fully privileged); relay through the
  // host content script when the background doesn't answer (Firefox gives
  // this frame content-script privileges, and its direct round-trip resolves
  // undefined — 2026-07-25 field diagnosis). Failures propagate to init's
  // catch and render in the overlay; silent degradation to an empty tab list
  // reads as "you have no tabs" and cost a field round-trip.
  let resp = (await chrome.runtime.sendMessage({ type: 'PALETTE_BOOTSTRAP' } as Message)
    .catch(() => undefined)) as BootstrapWire | undefined;
  fdiag(`bootstrap direct=${resp ? `ok tabs=${resp.tabs?.length ?? 0}` : 'no response'}`);
  if (!resp) {
    resp = (await bootstrapViaRelay()) ?? undefined;
    fdiag(`bootstrap relay=${resp ? `ok tabs=${resp.tabs?.length ?? 0}` : (relayError ?? 'no response')}`);
  }
  if (!resp) {
    throw new Error(`PALETTE_BOOTSTRAP: direct=no response; relay=${relayError ?? 'no response'}`);
  }
  return {
    tabs: (resp.tabs ?? []).map((t) => ({
      // Strip the marker decoration from titles — the mark shows as the
      // row's badge, not baked into the title text.
      tabId: t.tabId, title: stripTabMarker(t.title), url: t.url,
    })),
    mru: resp.mru ?? [],
    marks: resp.marks ?? {},
    bookmarks: resp.bookmarks ?? [],
    // A response with NO bookmarks key (vs an empty list) means the answering
    // background predates the feature — the Firefox stale-background class.
    // Name it, or it masquerades as "you have no bookmarks".
    bookmarksError: resp.bookmarksError
      ?? (resp.bookmarks === undefined
        ? 'stale extension background (no bookmarks in response) — reload the extension'
        : undefined),
    activeTabId: resp.activeTabId ?? null,
  };
}

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function render(sections: PaletteSection[]): void {
  flat = sections.flatMap((s) => s.items);
  if (selected >= flat.length) selected = Math.max(0, flat.length - 1);
  listEl.textContent = '';
  if (flat.length === 0) {
    // Scope-aware, and loud on a failed bookmarks fetch (a silent empty list
    // reads as "you have no bookmarks" — the bootstrap rule).
    const msg = scope === 'bookmarks'
      ? (bookmarksError ? `Bookmarks unavailable: ${bookmarksError}` : 'No bookmarks in this browser.')
      : scope === 'tabs' ? 'No matching tabs.'
      : scope === 'commands' ? 'No matching commands.'
      : 'No matching tabs or commands.';
    listEl.appendChild(el('div', 'empty', msg));
    return;
  }
  // The query actually used, when it isn't the text in the box (a misheard
  // dictation corrected against the palette's own words). Never silent — a
  // filtered list the query doesn't explain reads as a broken palette.
  if (queryNote) listEl.appendChild(el('div', 'overflow', queryNote));
  let idx = 0;
  for (const s of sections) {
    listEl.appendChild(el('div', 'sec', s.label));
    for (const item of s.items) {
      const i = idx++;
      const row = el('div', i === selected ? 'row sel' : 'row');
      const cw = codewords.get(item.id);
      if (cw) {
        // LETTER MODE SHOWS WHAT YOU TYPE, overriding badgeDisplayMode: a row
        // labelled "ocean river" that you activate by typing "or" has to say
        // "or". Outside letter mode the badge is purely a voice handle, so the
        // user's shared letter/word/expand preference governs again. This is the
        // tab-marker precedent generalized — letters primary, voice derived.
        const badge = mode === 'letter'
          ? (typedLabels.get(item.id) ?? '')
          : codewordDisplay(cw, voiceAlphabet, displayMode);
        row.appendChild(badgeSpan(badge, tokens.get(item.id) ?? ''));
      }
      // Non-candidates dim; the row stays in place so the list doesn't
      // reflow mid-utterance.
      if (narrowPrefix && !isNarrowCandidate(item.id)) row.classList.add('bk-dimmed');
      row.appendChild(el('span', 'title', item.title));
      if (item.subtitle && item.subtitle !== item.title) {
        row.appendChild(el('span', 'sub', item.subtitle));
      }
      const meta = el('div', 'meta');
      if (item.voice.length) {
        const say = el('span', 'say');
        say.appendChild(micGlyph());
        say.appendChild(document.createTextNode(`“${item.voice[0]}”`));
        meta.appendChild(say);
      }
      for (const k of item.keys) meta.appendChild(el('kbd', undefined, k));
      if (meta.childNodes.length) row.appendChild(meta);
      row.addEventListener('mousedown', (ev) => ev.preventDefault()); // keep input focus
      row.addEventListener('click', () => dispatchItem(item));
      listEl.appendChild(row);
    }
  }
  // Rows past the voice-badge tier (assignCodewords stops at maxVoiceRows)
  // must not fail silently. Counted over the VISIBLE set so the note retires
  // itself as narrowing pulls the badge-less tail out of play. codewords
  // empty = voice off entirely — every row is badge-less by design, no note.
  if (scope !== 'tabs' && codewords.size > 0) {
    const unbadged = flat.filter((it) => !codewords.has(it.id)).length;
    if (unbadged > 0) {
      listEl.appendChild(el(
        'div', 'overflow',
        `${unbadged} row${unbadged === 1 ? '' : 's'} without a voice badge — type to narrow`,
      ));
    }
  }
  listEl.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
}

/** Render for the current mode: letter mode narrows tabs by mark prefix; fuzzy
 *  mode filters by the typed title query. */
/**
 * Mid-codeword narrowing state, owned by the host's CodewordHolder and
 * pushed in over the relay ('' resets). Visual only — it never changes which
 * rows exist, which is the holder contract's `narrow` rule.
 */
let narrowPrefix = '';

/** Can this claim token ("o r") still complete the live prefix? */
function tokenIsCandidate(token: string): boolean {
  const letters = token.replace(/\s+/g, '');
  return letters !== '' && letters.startsWith(narrowPrefix);
}

function isNarrowCandidate(rowId: string): boolean {
  return tokenIsCandidate(tokens.get(rowId) ?? '');
}

/**
 * The badge, with the already-spoken part faded when a prefix is live. One
 * letter of prefix == one consumed word, since a token carries one letter per
 * spoken word; `splitSpokenBadge` maps that onto whichever shape the badge is
 * rendered in (a character in letter form, a word in spaced form).
 */
function badgeSpan(badge: string, token: string): HTMLElement {
  const span = el('span', 'cw');
  const consumed = narrowPrefix && tokenIsCandidate(token) ? narrowPrefix.length : 0;
  const { done, rest } = splitSpokenBadge(badge, consumed);
  if (done) span.appendChild(el('span', 'done', done));
  if (rest) span.appendChild(document.createTextNode(rest));
  return span;
}

/** Host → frame narrowing leg. Re-render is the whole implementation: the
 *  list is a snapshot, so there is no incremental badge state to maintain. */
function narrowRowBadges(prefix: string): void {
  if (prefix === narrowPrefix) return;
  narrowPrefix = prefix;
  renderCurrent();
}

function renderCurrent(): void {
  if (mode === 'letter') {
    // The full sectioned list (empty query = no ranking), narrowed by the typed
    // label prefix. Sections come from filterPalette so letter mode groups
    // bookmarks by folder exactly as search does — one layout, two input modes.
    queryNote = '';
    const sections = emptyStateSections();
    render(markPrefix === '' ? sections : sections
      .map((s) => ({
        ...s,
        items: s.items.filter((it) => (typedLabels.get(it.id) ?? '').startsWith(markPrefix)),
      }))
      .filter((s) => s.items.length > 0));
    return;
  }
  const resolved = resolvePaletteQuery(
    queryInput.value, phrase.lastDictation(), [...tabItems, ...commandItems, ...bookmarkItems],
  );
  if (resolved.reason === 'dictated_retry') {
    // Vestigial under the collector — its replace-on-new-utterance keeps the
    // run-together box ("gmailgithub") from forming at all — kept as the net
    // for a boundary the gap timer missed: own the newest utterance in the
    // box (seed also resets dictation ownership, so the next edit builds on
    // clean state).
    phrase.seed(resolved.query);
  }
  queryNote = resolved.reason === 'phonetic' ? `Showing results for “${resolved.query}”` : '';
  const sections = filterPalette(
    tabItems, commandItems, resolved.query, scope === 'commands', bookmarkItems,
  );
  // Query-derived rows, full + bookmarks scopes only — tabs and commands are
  // closed sets by intent. Both appended after resolvePaletteQuery so
  // neither can enter its corpus (a row matching every query would silently
  // kill both recoveries above — the note's one load-bearing exclusion), and
  // both read the BOX text, not the resolved query: a phonetic snap corrects
  // toward what exists in the palette, but a destination or web search has
  // no such corpus — the user's own words are the right thing.
  // (dictated_retry re-seeds the box to the utterance above, so box text is
  // already the right words there too.)
  // Positions are the design's asymmetry: URL row FIRST (URL-shaped input is
  // unambiguous intent — Enter should honor it), search row LAST (the
  // fallthrough, not the guess).
  if (scope === 'all' || scope === 'bookmarks') {
    const url = buildUrlSection(queryInput.value);
    if (url) sections.unshift(url);
    const search = buildSearchSection(queryInput.value, searchTemplate);
    if (search) sections.push(search);
  }
  render(sections);
}

function moveSelection(delta: number): void {
  if (flat.length === 0) return;
  selected = (selected + delta + flat.length) % flat.length;
  renderCurrent();
}

/**
 * How many rows are on screen right now, counted from the DOM rather than
 * derived from heights. Exact by construction: it absorbs the section headers
 * and overflow notes interleaved with the rows, and any future row that renders
 * taller than its siblings. Only runs on a jump keypress.
 */
function visibleRowCount(): number {
  // Viewport rects, NOT offsetTop: `offsetTop` is measured from the nearest
  // POSITIONED ancestor, and #list isn't positioned — so offsetTop lands in the
  // panel's coordinate space while scrollTop/clientHeight are in the list's, and
  // comparing them undercounts badly (measured: 6 visible rows read as 2, making
  // `d` step one row instead of three). getBoundingClientRect puts both sides in
  // the same space and folds in the scroll offset for free.
  const box = listEl.getBoundingClientRect();
  let n = 0;
  for (const row of listEl.querySelectorAll<HTMLElement>('.row')) {
    const r = row.getBoundingClientRect();
    if (r.top < box.bottom && r.bottom > box.top) n++;
  }
  return n;
}

/** Move the selection per a reserved nav key. */
function navigate(intent: PaletteNavIntent): void {
  if (flat.length === 0) return;
  selected = applyNavIntent(intent, selected, flat.length, visibleRowCount());
  renderCurrent();
}

// A label letter in letter mode. Prefix-freedom makes this crisp: an exact match
// activates immediately (nothing longer starts with a complete label); a prefix
// narrows the list; anything else is a no-op (never blanks the list). Scope-blind
// — `typedLabels` already resolved marks-vs-codewords at publish.
function typeMarkLetter(ch: string): void {
  const next = markPrefix + ch;
  switch (classifyMarkInput([...typedLabels.values()], next)) {
    case 'exact': {
      const item = publishOrder().find((it) => typedLabels.get(it.id) === next);
      if (item) dispatchItem(item);
      return;
    }
    case 'none':
      return; // no mark continues this — ignore the keystroke
    case 'prefix':
      markPrefix = next;
      queryInput.value = markPrefix;
      selected = 0;
      renderCurrent();
  }
}

function backspaceMark(): void {
  if (markPrefix.length === 0) return;
  markPrefix = markPrefix.slice(0, -1);
  queryInput.value = markPrefix;
  selected = 0;
  renderCurrent();
}

function clearMarkPrefix(): void {
  markPrefix = '';
  queryInput.value = '';
  selected = 0;
  renderCurrent();
}

/** Whether voice is live for this palette — set once the spoken entries are
 *  published. Gates the dictation affordances: with no voice half connected,
 *  advertising "speak to search" would promise a channel nothing is listening
 *  on (the extension runs standalone). */
let voiceLive = false;

/** Placeholder for the current mode — the keyboard truth, plus the spoken one
 *  when voice is connected. The exact hold key lives in the footer. */
function placeholderFor(m: PaletteMode): string {
  const what = scope === 'commands' ? 'commands'
    : scope === 'bookmarks' ? 'bookmarks'
    : scope === 'tabs' ? 'tabs' : 'tabs and commands';
  if (m === 'letter') {
    // "a tab's letter" no longer generalizes — commands and bookmarks carry
    // labels too — so name the noun the scope actually holds.
    const noun = scope === 'tabs' ? 'a tab’s letter' : 'a row’s letters';
    return voiceLive
      ? `Type ${noun} — / or speak to search`
      : `Type ${noun} — or / to search`;
  }
  return voiceLive ? `Search ${what} — type or speak…` : `Search ${what}…`;
}

function enterFuzzyMode(seed = ''): void {
  mode = 'fuzzy';
  markPrefix = '';
  queryInput.value = seed;
  queryInput.placeholder = placeholderFor('fuzzy');
  queryInput.classList.remove('letter-mode');
  queryInput.focus();
  selected = 0;
  renderModeChip();
  renderCurrent();
}

function enterLetterMode(): void {
  mode = 'letter';
  markPrefix = '';
  phrase.seed(''); // clears the box and dictation ownership together
  queryInput.placeholder = placeholderFor('letter');
  queryInput.classList.add('letter-mode');
  selected = 0;
  renderModeChip();
  renderCurrent();
}

// Fires for typed characters in fuzzy mode, and — in either mode — for text
// that arrives as an INSERTION rather than a keystroke: a dictation burst or a
// paste. Letter mode consumes every single-key press in the keydown handler, so
// anything reaching the value there came in whole, and a whole phrase is a
// search query, not a mark.
queryInput.addEventListener('input', (ev) => {
  phrase.handleInput(ev as InputEvent);
  if (mode === 'letter') {
    enterFuzzyMode(queryInput.value.slice(markPrefix.length));
    return;
  }
  selected = 0;
  renderCurrent();
});

window.addEventListener('keydown', (e) => {
  // Sentinel events are not keystrokes (the shared predicate carries the
  // 2026-07-25 field report: a 229 keydown's `key` is an artifact, and
  // consuming it as a mark letter jumped tabs). The real text follows as an
  // insertion, which the input handler reads as a search query.
  if (isSentinelKey(e)) return;
  // Gecko announces an OS text injection as one keydown whose `key` is the
  // whole dictated string, then inserts per character (collector header,
  // 2026-07-26). Hand those to the session so it reads the coming per-char
  // inserts as one dictation. The named keys the palette routes itself are
  // excluded; other named keys arm harmlessly (they insert nothing and the
  // next keydown disarms).
  if (
    e.key.length > 1 && !e.ctrlKey && !e.metaKey &&
    !['Enter', 'Escape', 'Tab', 'Backspace', 'ArrowDown', 'ArrowUp'].includes(e.key)
  ) {
    phrase.handleKeydown(e);
    return;
  }
  // Single-character keydowns disarm too. The collector's arm safety rests
  // on "the very next keydown disarms" — which the multi-char-only
  // forwarding above silently broke: an arrow/Home/End arm (no insert ever
  // comes) survived here until the next typed character was misclassified
  // as a dictated chunk, and a stale lastDictation() then let the palette's
  // dictated-retry rewrite the box mid-typing (field 2026-08-02,
  // "localhost:<digit>"). A single-char key can never hit the collector's
  // commit/cancel branches (those match named keys), so this is pure disarm.
  if (e.key.length === 1) phrase.handleKeydown(e);
  // Common navigation (both modes). Ctrl+K closes either palette (the full
  // palette's opener toggles it; a convenience for the tab palette). The tab
  // palette opens with bare `T`, which is a mark letter inside letter mode, so
  // it can't toggle-close — Escape / backdrop close it, like Vimium-C.
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyK') {
    e.preventDefault(); close(); return;
  }
  if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
    e.preventDefault(); moveSelection(1); return;
  }
  if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
    e.preventDefault(); moveSelection(-1); return;
  }
  if (e.key === 'Enter') {
    e.preventDefault(); dispatchItem(flat[selected]); return;
  }

  // The Escape ladder, one rule for every scope
  // (notes/DESIGN_PALETTE_KEYBOARD_NAV.md): clear a pending prefix, else step
  // search → letter, else close. The only scope-dependent input is whether a
  // letter mode exists to step back to, which phase 2 makes unconditional.
  // Dismissal does not regress: a fresh palette has no prefix and is already in
  // its default mode, so one press still closes it.
  if (e.key === 'Escape') {
    e.preventDefault();
    if (markPrefix) { clearMarkPrefix(); return; }
    if (mode === 'fuzzy' && hasLetterMode()) { enterLetterMode(); return; }
    close();
    return;
  }

  // Letter mode: keystroke-capture for label-pick, in every scope.
  if (mode === 'letter') {
    if (e.key === '/') { e.preventDefault(); enterFuzzyMode(); return; }
    if (e.key === 'Backspace') { e.preventDefault(); backspaceMark(); return; }
    // Reserved nav letters (keymap/palette-reserved.ts). They are withheld from
    // the mark pool, so no mark can begin with one — the two letter sets are
    // disjoint by construction and this cannot shadow a jump. Sitting before the
    // mark consume is documentation of intent, not disambiguation.
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const intent = navBindings.get(navKeyToken(e.key, e.shiftKey));
      if (intent) { e.preventDefault(); navigate(intent); return; }
    }
    // Free of the keymap and of any collision, so they are wired unconditionally.
    if (e.key === 'Home') { e.preventDefault(); navigate('first'); return; }
    if (e.key === 'End') { e.preventDefault(); navigate('last'); return; }
    // Consume EVERY single-character press (letters pick a mark, anything else
    // is a no-op) so no keystroke can reach the input's value. What remains —
    // multi-character insertions from the dictation sink or a paste — falls
    // through to the input handler as a search query. The input is
    // deliberately not `readonly`: readonly would drop dictated text silently,
    // which is exactly how the tab palette read as "voice can't search".
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (/^[a-z]$/i.test(e.key)) typeMarkLetter(e.key.toLowerCase());
      return;
    }
    return; // swallow anything else in letter mode
  }
  // Fuzzy mode needs no tail: every key it cares about is handled above, and
  // Escape belongs to the ladder.
});

backdrop.addEventListener('click', (e) => {
  if (e.target === backdrop) close();
});

// OS focus leaving the browser closes the palette. Load-bearing beyond UX:
// the plugin holds an EXCLUSIVE palette tag while our rows are published, and
// an exclusive tag left active while another app is frontmost would suppress
// every other command system-wide. Closing drains the entries → clears the
// tag through the normal path (the plugin's focus-loss drain is the backstop).
window.addEventListener('blur', () => close());

const tabIdOf = (rowId: string): number | null =>
  rowId.startsWith('tab:') ? Number(rowId.slice(4)) : null;

/**
 * Assign each row's codeword and, if voice is connected, publish the spoken
 * entries + row→dispatch map so the exclusive-tag voice half can resolve them.
 *
 * Tabs scope CONVERGES on the stable strip marks: a row's codeword is its
 * tab's mark letter (badge matches the strip), and the spoken form is that
 * mark's alphabet-overlay words. With no alphabet (voice off) the marks still
 * badge the rows — keyboard-usable — but nothing is published, so no exclusive
 * tag is set. Full palette keeps ephemeral word codewords.
 */
function assignAndPublish(alphabet: string[]): void {
  voiceAlphabet = alphabet;
  // Browse order, so badge N belongs to the Nth row painted — what
  // codewords.ts has always documented ("in empty-state row order") and what
  // the concatenation quietly failed to deliver in the commands scope.
  const all = publishOrder();
  if (scope === 'tabs') {
    codewords = new Map();
    for (const item of tabItems) {
      const id = tabIdOf(item.id);
      const mark = id != null ? markMap[id] : undefined;
      if (mark) codewords.set(item.id, mark);
    }
  } else {
    // Reserved letters are withheld: these codewords are TYPED in letter mode,
    // so a letter that walks the list cannot also label a row.
    codewords = assignCodewords(all.map((r) => r.id), alphabet, reservedLetters);
  }
  // The keyboard's view of the same assignment. Marks are already letters; word
  // codewords reduce to their letter form, which is exactly what a user types and
  // what letter mode renders on the badge.
  typedLabels = new Map();
  for (const item of all) {
    const cw = codewords.get(item.id);
    if (!cw) continue;
    const label = scope === 'tabs' ? cw : codewordDisplay(cw, alphabet, 'letter');
    if (label) typedLabels.set(item.id, label);
  }
  if (codewords.size === 0) return;

  const entries: PaletteVoiceEntry[] = [];
  const rows: PaletteVoiceRow[] = [];
  const claim: PaletteCodewordWire[] = [];
  tokens = new Map();
  for (const item of all) {
    const cw = codewords.get(item.id);
    if (!cw) continue;
    // Claim-level token for the host's holder — one letter per spoken word,
    // derived from the alphabet THIS assignment used.
    const token = codewordToken(cw, alphabet);
    if (token) {
      tokens.set(item.id, token);
      claim.push({ token, rowId: item.id });
    }
    // Tabs: cw is a mark letter → spoken is its overlay words (empty when no
    // alphabet). Full palette: cw is already the spoken word.
    const spoken = scope === 'tabs' ? markToSpokenWords(cw, alphabet) : cw;
    // `title` is display-only — it gives the Discovery HUD a human subtitle
    // instead of the opaque row_id it would otherwise derive.
    if (spoken) entries.push({ spoken, title: item.title, row_id: item.id });
    rows.push({ row_id: item.id, dispatch: item.dispatch });
  }
  // No spoken entries (voice off) → don't open a voice session / exclusive tag.
  if (entries.length === 0) return;
  voiceLive = true;
  chrome.runtime.sendMessage({ type: 'PALETTE_PUBLISH', entries, rows } as Message).catch(() => {});
  // Hand the host our assignment so it can register the CodewordHolder that
  // makes mid-utterance narrowing reach these rows. Voice-live only: a
  // keyboard-only palette claims no exclusivity it isn't using.
  //
  // NO SECRET on this leg. It goes to the parent with targetOrigin '*' (the
  // frame cannot know the page's origin), so the page can read it — sending
  // the secret here would hand over the ability to forge a RESP or an
  // ACTIVATE. The host authenticates this direction by event.source, which a
  // page cannot spoof without executing inside the extension frame.
  // notes/DESIGN_CROSS_REALM_CODEWORD_HOLDERS.md.
  window.parent.postMessage({ type: RELAY_CODEWORDS, rows: claim }, '*');
}

/** One footer chip: the mic glyph + a spoken phrase, then what it does. */
function spokenChip(phrase: string, what: string): HTMLElement {
  const wrap = el('span');
  const say = el('span', 'say');
  say.appendChild(micGlyph());
  say.appendChild(document.createTextNode(phrase));
  wrap.appendChild(say);
  wrap.appendChild(document.createTextNode(` ${what}`));
  return wrap;
}

/**
 * Footer line teaching the dictated search: hold the dictation key with the
 * palette open and the transcript lands in the query box — no verb, no mode.
 * Nothing routes it there; the platform's dictation sink types into the focused
 * field, and that's this box. Voice-gated (the extension runs standalone), and
 * key-agnostic: the extension can't read the platform's keybinds, and the
 * hold is rebindable — same wording the catalog's dictated-argument commands
 * use ("hold the dictation key").
 */
function showVoiceSearchHint(): void {
  const footer = document.getElementById('footer');
  if (!footer) return;
  footer.appendChild(spokenChip('hold the dictation key', 'and speak to search'));
  footer.hidden = false;
}

/**
 * Sticky footer for the bookmarks palette: teaches the spoken open
 * dispositions — the bare badge opens a new focused tab (Enter's voice twin),
 * "stash" opens it behind instead. Voice-gated: the phrases are spoken
 * commands, so a voiceless palette would advertise phrases nothing hears.
 *
 * "blank" still works as a synonym for the bare badge, but isn't taught: it
 * named the non-default disposition until new-tab BECAME the default, and
 * advertising a verb that does what pressing nothing does is noise.
 */
function showBookmarkFooter(): void {
  const footer = document.getElementById('footer');
  if (!footer) return;
  footer.append(
    spokenChip('“⟨badge⟩”', 'opens in a new tab'),
    spokenChip('“stash ⟨badge⟩”', 'opens behind'),
  );
  footer.hidden = false;
}

/**
 * Mode indicator, shown whenever this scope has two modes to be in.
 *
 * The same reasoning render/mode-chip.ts states for the page: with letters
 * meaning "pick a label" in one mode and "type a query" in the other, nothing on
 * screen otherwise says which one you are in — and the author of the tab palette
 * still expected `/`-to-search in every scope, which is the evidence that the
 * mode has to be visible rather than inferred. Not shared code with mode-chip:
 * that is a content-script component in a page shadow root, this is the frame's
 * own footer.
 *
 * Rebuilt in place on every mode change, and it keeps the footer's other
 * occupants (the dictation chip, the bookmarks verbs) intact by owning one span.
 */
function renderModeChip(): void {
  const footer = document.getElementById('footer');
  if (!footer || !hasLetterMode()) return;
  let chip = footer.querySelector<HTMLElement>('.mode');
  if (!chip) {
    chip = el('span', 'mode');
    footer.prepend(chip);
  }
  chip.textContent = mode === 'letter'
    ? 'LETTER — type a label, / to search'
    : 'SEARCH — Esc for labels';
  footer.hidden = false;
}

async function init(): Promise<void> {
  queryInput.focus();
  const [boot, keymap, stored, sync, overridesResp, aliasesResp, engine] = await Promise.all([
    loadBootstrap(),
    loadKeymap().catch(() => []),
    chrome.storage.local.get('alphabet').catch(() => ({} as Record<string, unknown>)),
    chrome.storage.sync.get('badgeDisplayMode').catch(() => ({} as Record<string, unknown>)),
    chrome.runtime.sendMessage({ type: 'GET_COMMAND_OVERRIDES' }).catch(() => undefined),
    chrome.runtime.sendMessage({ type: 'GET_COMMAND_ALIASES' }).catch(() => undefined),
    loadSearchTemplate().catch(() => DEFAULT_SEARCH_TEMPLATE),
  ]);
  searchTemplate = engine;
  const overrides = overridesFromList(
    ((overridesResp as { overrides?: OverrideRecord[] } | undefined)?.overrides) ?? [],
  );
  const aliases = ((aliasesResp as { aliases?: OverrideRecord[] } | undefined)?.aliases) ?? [];
  if (typeof sync.badgeDisplayMode === 'string') {
    displayMode = sync.badgeDisplayMode as BadgeDisplayMode;
  }
  const paletteNav = derivePaletteNav(keymap);
  navBindings = paletteNav.bindings;
  reservedLetters = paletteNav.reserved;
  markMap = boot.marks;
  // A scoped open drops the other sources entirely — same overlay, one
  // source (the Vomnibar "scoped by trigger key" pattern). Bookmarks are
  // scope-only: they'd bloat the full launcher, and "palette bookmarks" /
  // Shift+B is the deliberate way in.
  tabItems = scope === 'commands' || scope === 'bookmarks'
    ? [] : buildTabItems(boot.tabs, boot.mru, boot.activeTabId);
  commandItems = scope === 'tabs' || scope === 'bookmarks'
    ? [] : buildCommandItems(COMMAND_CATALOG, keymap, undefined, overrides, aliases);
  bookmarkItems = scope === 'bookmarks' ? buildBookmarkItems(boot.bookmarks) : [];
  bookmarksError = boot.bookmarksError;
  const alphabet = Array.isArray(stored.alphabet) ? (stored.alphabet as string[]) : [];
  assignAndPublish(alphabet);
  if (scope === 'bookmarks' && codewords.size > 0) showBookmarkFooter();
  // Dictated search works in every scope, so the hint is unconditional on
  // scope — only on voice being live.
  if (voiceLive) showVoiceSearchHint();
  // Every scope opens in letter mode when there are labels to type; with none
  // (marks off / pool empty / voice alphabet absent) fall back to search so the
  // palette is still usable rather than an inert list.
  //
  // UNLESS the user already typed: mode starts fuzzy precisely so the
  // bootstrap window doesn't swallow keystrokes, and promoting here would
  // clobber what that window collected (enterLetterMode seeds the box empty)
  // AND leave letter mode eating the keystrokes that follow. Field report
  // 2026-08-02: typed "localhost:" during a slow bootstrap, box wiped as the
  // digits landed. Their text outranks our mode default.
  if (typedLabels.size > 0 && queryInput.value === '') enterLetterMode();
  else enterFuzzyMode(queryInput.value);
  renderModeChip();
  renderCurrent();
  fdiag(`init ok tabs=${tabItems.length} commands=${commandItems.length} bookmarks=${bookmarkItems.length}${bookmarksError ? ` bookmarks_error=${bookmarksError}` : ''} marks=${codewords.size}`);
}

init().catch((err: unknown) => {
  // An empty palette means init died before its first render — surface the
  // failure IN the overlay so a field report can name it instead of "it's
  // just empty" (Firefox, 2026-07-25). The static panel renders without JS,
  // so without this the failure mode is indistinguishable from no data.
  listEl.textContent = '';
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  listEl.appendChild(el('div', 'empty', `Palette failed to load — ${msg}`));
  fdiag(`init FAILED: ${msg}`);
  console.error('[BranchKit palette] init failed:', err);
});
