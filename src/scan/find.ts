/**
 * BranchKit Browser — Find-in-page.
 *
 * Vimium-C-style find: a visible query bar plus persistent highlighting of
 * EVERY match on the page, with the current match emphasized. Highlighting uses
 * the CSS Custom Highlight API (CSS.highlights + ::highlight(...)) — no DOM
 * mutation, no native-selection focus quirks. Matches are located as Ranges by
 * walking the page's text nodes; navigation (n / Enter) scrolls the current
 * Range into view. Highlights persist until find closes.
 *
 * Two UI states share the bottom-right corner: the INPUT BAR (typing, captures
 * keys) and the read-only COMMITTED PILL (query + "3 of 17" + dismiss hint).
 * Enter swaps bar → pill; voice find (findImmediate) lands on the pill
 * directly — it's the only affordance a voice user ever sees, and without it
 * the persistent highlights read as undismissable ghosts (2026-06-29 review).
 * The pill stays until Escape / find_close / a new `/`.
 *
 * Where the API is unavailable (older engines), matching + scroll-to still work;
 * only the visual highlight is absent.
 */

import { bestPageMatch, normalizeFuzzy, fold1to1, lower1to1, flexiblePattern } from './fuzzy-find';
import { modes } from '../core/modes';
import { bkLog } from '../debug/bk-log';
import { openPhraseSession, isDictatedInsert, type PhraseSession } from './phrase-collector';

/**
 * What the box is collecting a phrase FOR.
 *
 * The box started as find-in-page and is now the one place a phrase gets
 * dictated or typed, whatever the caller means to do with it. `find` keeps the
 * results and moves around in them; the phrase-targeting modes hand the phrase
 * to a command and end the session. Live highlighting is shared by all three —
 * seeing what you'd act on is as useful when selecting as when searching.
 *
 * This replaces the dictated-argument cue card: rather than a transient overlay
 * saying "hold the key and say the phrase" against a timer, the box IS the
 * input, visible until answered, editable, and identical for keyboard and voice.
 */
export type FindState = {
  active: boolean;
  /** A phrase-targeting box is open or its session is live (vs a search). */
  phrase: boolean;
  query: string;
  matchIndex: number;
  matchCount: number;
};

/**
 * A phrase-targeting consumer — what `FindMode` was reaching for (Wave 3
 * C5b). The old enum was never polymorphism: `highlight` and `extend` were
 * byte-identical in here and the consumer discarded the distinction. Each
 * caller now brings its own box copy and its own commit meaning; this module
 * keeps one behavior split — search (result set, pill, n/N) vs phrase (hand
 * the query over, paint stays with the consumer).
 */
export interface PhraseTarget {
  glyph: string;
  placeholder: string;
  /** The phrase is finished WITH matches painted — hand it over. The paint
   *  survives; the consumer calls clearFindPaint when it answers. */
  onPhrase(query: string): void;
}

/** The search box's own copy. */
const FIND_UI = { glyph: '/', placeholder: 'Find in page...' };

const HL_ALL = 'branchkit-find';
const HL_CURRENT = 'branchkit-find-current';
// Phrase-targeting modes paint under their own name so the two meanings can be
// coloured separately from one static stylesheet — no restyling on mode change.
const HL_PHRASE = 'branchkit-phrase';
const STYLE_ATTR = 'data-branchkit-find-style';

let state = { active: false, query: '', matchIndex: 0, matchCount: 0 };
/** Non-null while a phrase-targeting session is live; null = search. */
let phraseTarget: PhraseTarget | null = null;
let barElement: HTMLElement | null = null;
let inputElement: HTMLInputElement | null = null;
/** The bar's input semantics — 229 sentinel, dictation wire, commit/cancel —
 *  live in the shared PhraseCollector (Wave 3 C5); this module owns only what
 *  a commit MEANS. One session per open bar. */
let phrase: PhraseSession | null = null;
let matchRanges: Range[] = [];
let currentIndex = -1;

let onActivate: (() => void) | null = null;
let onDeactivate: (() => void) | null = null;
// Fired when a search commits WITH matches (Enter or voice find). Caret mode
// uses it to auto-extend the selection to the match. See caret.ts.
let onCommit: (() => void) | null = null;
// (The onPhrase callback died with FindMode: a phrase-targeting box's commit
// handler arrives WITH the open — openPhraseBox(target) — so the caller that
// asks for a phrase is the one that receives it, with no mode enum relayed
// through a third module.)

export function setFindCallbacks(opts: {
  onActivate?: () => void;
  onDeactivate?: () => void;
  onCommit?: () => void;
}): void {
  onActivate = opts.onActivate ?? null;
  onDeactivate = opts.onDeactivate ?? null;
  onCommit = opts.onCommit ?? null;
}

export function getFindState(): FindState {
  return { ...state, phrase: phraseTarget !== null };
}

export function isFindActive(): boolean {
  return state.active;
}

/** True while the find bar input EXISTS. After Enter commits the search the bar
 * closes but find stays active (highlights persist, n / Shift+n navigate) — see
 * handleFindNavKey.
 *
 * Callers deciding who owns a keystroke want isFindBarFocused, not this: a bar
 * on screen is not the same claim as a bar holding the keyboard. */
export function isFindBarOpen(): boolean {
  return barElement !== null;
}

/** True while the find bar input actually HOLDS the keyboard.
 *
 * The page keydown gate asks this. Asking presence instead meant a bar that had
 * lost focus still swallowed every BranchKit key — click the page with the bar
 * open and hint mode, find navigation, the focus-input cycler, the Ctrl+Alt+A
 * snapshot and Escape itself all died at once, with no visible cause and no key
 * that could recover it. A box with no keyboard has no claim on it.
 *
 * The blur close below makes present-but-unfocused transient; this makes it
 * harmless in the window where it exists anyway — `createFindBar`'s focus()
 * does not land when the document itself is not focused (background tab,
 * another frame), and no blur follows a focus that never happened. */
export function isFindBarFocused(): boolean {
  return inputElement !== null && document.activeElement === inputElement;
}

// --- CSS Custom Highlight API access (guarded; newish API) ---

interface HighlightLike { priority: number }
type HighlightCtor = new (...ranges: Range[]) => HighlightLike;

function highlightApi(): { reg: Map<string, HighlightLike>; Ctor: HighlightCtor } | null {
  const reg = (CSS as unknown as { highlights?: Map<string, HighlightLike> }).highlights;
  const Ctor = (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight;
  return reg && Ctor ? { reg, Ctor } : null;
}

/**
 * Highlighter yellow — the colour a found match wears.
 *
 * Exported because anything that has to READ as "this is a search match" must
 * wear the same colour, and a second copy of the hex is a thing that drifts.
 * Search-match badges tint themselves from this (render/badge-variant.ts), so
 * retheming the highlight retints the badges with it.
 */
export const FIND_HIGHLIGHT = '#ffeb3b';

function ensureHighlightStyle(): void {
  if (document.querySelector(`[${STYLE_ATTR}]`)) return;
  const style = document.createElement('style');
  style.setAttribute(STYLE_ATTR, '');
  // FIND: current match is a solid highlighter-yellow block (opaque, black
  // text); the others are a much fainter wash of the same yellow, so the
  // current one stands out by vividness.
  //
  // PHRASE TARGETING: not yellow. Yellow means "search match" — it's the
  // find convention, and these aren't search results, they're about to become
  // a SELECTION. A restrained wash of the extension's own accent says that
  // without borrowing search's meaning.
  //
  // Deliberately not native ::selection: its colour varies by browser, OS and
  // theme, so it can't be relied on to read as anything in particular — and
  // the real selection colour arrives on its own the moment the phrase
  // resolves, which is the handoff this preview is building toward.
  //
  // The phrase wash sits at a much LOWER alpha than find's, and matching the
  // numbers would be the wrong way to match the look: highlighter yellow is
  // nearly as light as white, so 22% of it barely tints, while #007AFF is a
  // dark hue whose 22% reads as a solid block. Equal weight on the page needs
  // unequal alpha. Both are washes — a phrase has no "current" match to
  // out-vivid, so this is the only level it needs.
  style.textContent =
    `::highlight(${HL_ALL}) { background-color: rgba(255, 235, 59, 0.22); color: inherit; }\n` +
    `::highlight(${HL_CURRENT}) { background-color: ${FIND_HIGHLIGHT}; color: #000; }\n` +
    `::highlight(${HL_PHRASE}) { background-color: rgba(0, 122, 255, 0.12); color: inherit; }`;
  (document.head || document.documentElement).appendChild(style);
}

// --- Match finding (Range-based) ---

/**
 * All Ranges matching `query` (case-insensitive) within single text nodes of
 * `root`, skipping script/style and BranchKit's own UI. Single-node matching
 * (not across element boundaries) covers the overwhelming majority of matches.
 * Pure aside from reading the DOM — unit-tested directly.
 */
function acceptFindTextNode(node: Node): number {
  if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
  const parent = (node as Text).parentElement;
  if (!parent) return NodeFilter.FILTER_REJECT;
  const tag = parent.tagName;
  if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
  if (parent.closest('[data-branchkit-find]') || parent.closest('[data-branchkit-hint]')) {
    return NodeFilter.FILTER_REJECT;
  }
  return NodeFilter.FILTER_ACCEPT;
}

/**
 * A flattened text index of the subtree: one string built by transforming each
 * accepted text node (1:1 length-preserving) and concatenating, plus a mapper
 * from a string offset back to a DOM (node, offset). This is the shared
 * substrate for ALL matching — a match found in the flat string maps to a Range
 * that can span multiple nodes, so phrases crossing element boundaries (bold
 * title, link, parenthetical) match. `boundarySpace` inserts a synthetic space
 * between adjacent nodes (for tolerant matching, so node boundaries read as word
 * boundaries); exact matching omits it so the flat text equals Range.toString().
 */
interface FlatIndex {
  text: string;
  nodeAt: (pos: number) => { node: Text; offset: number } | null;
  /** DOM (node, offset) → flat position. Only exact when the index was built
   *  1:1 (identity transform, no boundary spaces) — buildBlockIndex's case. */
  posOf: (node: Node, offset: number) => number | null;
}
function buildFlatIndex(
  root: Node,
  transform: (s: string) => string,
  boundarySpace: boolean,
): FlatIndex {
  const doc = root.ownerDocument ?? (root as Document);
  let text = '';
  const segs: { node: Text; start: number }[] = [];
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: acceptFindTextNode });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (boundarySpace && text.length && !/\s$/.test(text)) text += ' ';
    segs.push({ node: node as Text, start: text.length });
    text += transform((node as Text).nodeValue!);
  }
  const nodeAt = (pos: number): { node: Text; offset: number } | null => {
    for (let i = segs.length - 1; i >= 0; i--) {
      if (segs[i].start <= pos) {
        const offset = pos - segs[i].start;
        return offset <= segs[i].node.nodeValue!.length ? { node: segs[i].node, offset } : null;
      }
    }
    return null;
  };
  const posOf = (node: Node, offset: number): number | null => {
    for (const s of segs) if (s.node === node) return s.start + offset;
    return null;
  };
  return { text, nodeAt, posOf };
}

/**
 * A caret-selection index over a block subtree: the block's flat (cross-node)
 * text plus bidirectional offset mapping (DOM ⇄ flat) and a flat-span → Range
 * builder. Built 1:1 (exact concat, no synthetic spaces) so flat offsets equal
 * DOM offsets and `Range.toString()` equals the flat text. Powers the "select
 * this word/sentence/paragraph" text objects (caret.ts) with cross-node correct,
 * layout-free spans — no reliance on `Selection.modify`'s flaky sentence/
 * paragraph granularities.
 */
export function buildBlockIndex(root: Node): {
  text: string;
  posOf: (node: Node, offset: number) => number | null;
  rangeFor: (start: number, end: number) => Range | null;
} {
  const doc = root.ownerDocument ?? (root as Document);
  const { text, nodeAt, posOf } = buildFlatIndex(root, (s) => s, false);
  const rangeFor = (start: number, end: number): Range | null => {
    if (end <= start) return null;
    const a = nodeAt(start);
    const b = nodeAt(end - 1);
    if (!a || !b) return null;
    const r = doc.createRange();
    r.setStart(a.node, a.offset);
    r.setEnd(b.node, b.offset + 1);
    return r;
  };
  return { text, posOf, rangeFor };
}

/**
 * Exact (case-insensitive, accent-sensitive) match, CROSS-NODE. Runs indexOf on
 * a direct-concatenation flat index (no synthetic spaces), so the flat text
 * equals the concatenated Range.toString() — a phrase spanning elements matches,
 * and the text a voice search writes back into the box is re-matchable by typing.
 */
export function findMatchRanges(query: string, root: Node): Range[] {
  const ranges: Range[] = [];
  const needle = lower1to1(query);
  if (!needle) return ranges;
  const doc = root.ownerDocument ?? (root as Document);
  const { text, nodeAt } = buildFlatIndex(root, lower1to1, false);
  let idx = text.indexOf(needle);
  while (idx !== -1) {
    const start = nodeAt(idx);
    const end = nodeAt(idx + needle.length - 1);
    if (start && end) {
      const range = doc.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset + 1);
      ranges.push(range);
    }
    idx = text.indexOf(needle, idx + needle.length);
  }
  return ranges;
}

/**
 * Punctuation/accent-tolerant CROSS-NODE match (voice path). Folds accents and
 * allows any non-alphanumeric run between the query's words, over the same flat
 * index (with synthetic node-boundary spaces), so "Lope Martin Marooned 21 July
 * 1566" matches "**Lopo Martín** (marooned 21 July 1566)" across the boundaries.
 */
export function findRangesFlexible(query: string, root: Node): Range[] {
  const ranges: Range[] = [];
  const pattern = flexiblePattern(query);
  if (!pattern) return ranges;
  const doc = root.ownerDocument ?? (root as Document);
  const { text, nodeAt } = buildFlatIndex(root, fold1to1, true);
  const re = new RegExp(pattern, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    const start = nodeAt(m.index);
    const end = nodeAt(m.index + m[0].length - 1);
    if (start && end) {
      const range = doc.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset + 1);
      ranges.push(range);
    }
  }
  return ranges;
}

// --- Find bar UI ---

function createFindBar(): void {
  if (barElement) return;
  ensureHighlightStyle();

  barElement = document.createElement('div');
  barElement.setAttribute('data-branchkit-find', '');
  // Compact floating pill in the bottom-right corner (Vimium-C style) rather
  // than a full-width bar, so it overlaps almost no page content.
  barElement.style.cssText = `
    position: fixed; bottom: 12px; right: 12px;
    width: 360px; max-width: calc(100vw - 24px); height: 34px; box-sizing: border-box;
    background: #1e1e1e; border: 1px solid rgba(255,255,255,0.18); border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.4);
    display: flex; align-items: center; padding: 0 10px; gap: 8px;
    z-index: 2147483647; font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 13px; color: #fff;
  `;

  const ui = phraseTarget ?? FIND_UI;
  const label = document.createElement('span');
  label.textContent = ui.glyph;
  label.style.cssText = 'color: #007AFF; font-weight: 600; font-size: 14px;';
  barElement.appendChild(label);

  inputElement = document.createElement('input');
  inputElement.type = 'text';
  inputElement.placeholder = ui.placeholder;
  // A search query is not prose: capitalising it, correcting it, or offering a
  // completion for it all change what gets matched without being asked. The
  // palette's input opts out of the same four for the same reason. Autocorrect
  // is the one with teeth here — its replacement arrives as an insert the user
  // never typed, which is the shape this box reads as "the phrase is finished".
  inputElement.setAttribute('autocomplete', 'off');
  inputElement.setAttribute('autocorrect', 'off');
  inputElement.setAttribute('autocapitalize', 'off');
  inputElement.setAttribute('spellcheck', 'false');
  inputElement.style.cssText = `
    flex: 1; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15);
    border-radius: 4px; padding: 4px 8px; color: #fff; font-size: 13px; outline: none;
    font-family: inherit;
  `;
  // The input semantics — the 229 sentinel, the dictation wire and its
  // utterance boundary, commit vs cancel, the blur close — are the shared
  // collector's (scan/phrase-collector.ts, which carries every rationale
  // this block used to). This module supplies the element and what a commit
  // MEANS. Re-entrancy needs no listener unhooking: the session closes
  // before its cancel callback fires, so a teardown-induced blur finds it
  // inert.
  const input = inputElement;
  phrase = openPhraseSession(
    {
      read: () => input.value,
      replace: (text) => {
        input.value = text;
        input.setSelectionRange(text.length, text.length);
      },
    },
    {
      onQueryChanged: (query) => performFind(query),
      onCommit: () => commitFind(),
      onCancel: () => closeFindMode(),
    },
  );
  // Diagnostic tap (2026-07-26, Firefox dictated-commit hunt): the box's
  // event shape has now field-failed in a way NO current predicate explains —
  // capture the raw stream, capped per bar so a typed query can't flood the
  // log. A phrase session is seconds long; this is the whole cost.
  let tapBudget = 16;
  const tap = (kind: string, detail: Record<string, unknown>): void => {
    if (tapBudget-- > 0) bkLog('BK_PHRASE_EVENT', { kind, ...detail });
  };
  inputElement.addEventListener('input', (e) => {
    const ie = e as InputEvent;
    tap('input', {
      inputType: ie.inputType, len: ie.data?.length ?? 0,
      isComposing: ie.isComposing, dictated: isDictatedInsert(ie),
    });
    phrase?.handleInput(ie);
  });
  inputElement.addEventListener('keydown', (e) => {
    tap('keydown', { key: e.key, keyCode: e.keyCode, isComposing: e.isComposing });
    const verdict = phrase?.handleKeydown(e) ?? 'pass';
    if (verdict === 'commit' || verdict === 'cancel') {
      e.preventDefault();
      e.stopPropagation();
    }
    // 'sentinel': fully inert — the composition's own default must survive.
    // 'pass': an ordinary key, the input takes it.
  });
  inputElement.addEventListener('blur', () => phrase?.handleBlur());
  barElement.appendChild(inputElement);

  const countSpan = document.createElement('span');
  countSpan.id = 'branchkit-find-count';
  countSpan.style.cssText = 'color: rgba(255,255,255,0.5); font-size: 11px; min-width: 60px;';
  barElement.appendChild(countSpan);

  document.body.appendChild(barElement);
  inputElement.focus();
}

function removeFindBar(): void {
  // Close the phrase session FIRST: a closed session ignores every event, so
  // the blur this removal fires (commitFind removes a FOCUSED input) cannot
  // re-enter closeFindMode, and no pending dictated commit can outlive the
  // bar. The collector's ordering is the whole mechanism.
  phrase?.close();
  phrase = null;
  barElement?.remove();
  barElement = null;
  inputElement = null;
}

// --- Committed pill (post-Enter / voice find) ---

let pillElement: HTMLElement | null = null;

function showCommittedPill(): void {
  removeCommittedPill();
  ensureHighlightStyle();

  pillElement = document.createElement('div');
  // data-branchkit-find also excludes the pill's own text (it contains the
  // query) from findMatchRanges' walker.
  pillElement.setAttribute('data-branchkit-find', '');
  pillElement.style.cssText = `
    position: fixed; bottom: 12px; right: 12px;
    max-width: 360px; height: 34px; box-sizing: border-box;
    background: #1e1e1e; border: 1px solid rgba(255,255,255,0.18); border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.4);
    display: flex; align-items: center; padding: 0 10px; gap: 8px;
    z-index: 2147483647; font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 13px; color: #fff;
  `;

  const label = document.createElement('span');
  label.textContent = '/';
  label.style.cssText = 'color: #007AFF; font-weight: 600; font-size: 14px;';
  pillElement.appendChild(label);

  const query = document.createElement('span');
  query.textContent = state.query;
  query.style.cssText =
    'overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 160px;';
  pillElement.appendChild(query);

  const countSpan = document.createElement('span');
  countSpan.id = 'branchkit-find-count';
  countSpan.style.cssText = 'color: rgba(255,255,255,0.5); font-size: 11px;';
  pillElement.appendChild(countSpan);

  const hint = document.createElement('span');
  hint.textContent = 'n/N · esc';
  hint.style.cssText = 'color: rgba(255,255,255,0.35); font-size: 11px; white-space: nowrap;';
  pillElement.appendChild(hint);

  document.body.appendChild(pillElement);
  updateCountDisplay();
}

function removeCommittedPill(): void {
  pillElement?.remove();
  pillElement = null;
}

function updateCountDisplay(): void {
  const countEl = document.getElementById('branchkit-find-count');
  if (!countEl) return;
  if (state.query === '') {
    countEl.textContent = '';
  } else if (state.matchCount === 0) {
    countEl.textContent = 'No matches';
    countEl.style.color = '#ff453a';
  } else {
    countEl.textContent = `${state.matchIndex} of ${state.matchCount}`;
    countEl.style.color = 'rgba(255,255,255,0.5)';
  }
}

// --- Highlighting ---

function applyHighlights(): void {
  const api = highlightApi();
  if (!api) return;
  api.reg.delete(HL_ALL);
  api.reg.delete(HL_CURRENT);
  api.reg.delete(HL_PHRASE);
  if (matchRanges.length === 0) return;
  // Phrase targeting paints under its own name, and has no "current" match:
  // every candidate is equally pickable until you choose, and emphasising one
  // would claim an ordering that doesn't exist — worse once the pick chips are
  // up, where a brighter match reads as already chosen. `current` is a find
  // concept, owned by n/N navigation.
  if (phraseTarget !== null) {
    api.reg.set(HL_PHRASE, new api.Ctor(...matchRanges));
    return;
  }
  api.reg.set(HL_ALL, new api.Ctor(...matchRanges));
  if (currentIndex >= 0 && currentIndex < matchRanges.length) {
    const cur = new api.Ctor(matchRanges[currentIndex]);
    cur.priority = 1; // paint the current match over the all-matches wash
    api.reg.set(HL_CURRENT, cur);
  }
}

/**
 * Erase find paint left by a PREDECESSOR content script.
 *
 * The badge hosts are DOM nodes, so the boot sweep can find and remove them.
 * Highlights are not: `CSS.highlights` is a document-scoped registry, so
 * entries registered by a script that has since been torn down keep painting
 * with nobody owning them — an extension reload mid-session leaves yellow on
 * the page until the tab is reloaded, and the fresh script has no state that
 * says so. Same for the bar/pill, which are ours but carry a different
 * attribute than the badge sweep looks for.
 *
 * Safe with no session: it only deletes, and the registry entries are
 * name-keyed rather than instance-keyed, so this reaches the previous script's
 * paint precisely because the names are shared.
 */
export function purgeOrphanedFindPaint(): void {
  const api = highlightApi();
  api?.reg.delete(HL_ALL);
  api?.reg.delete(HL_CURRENT);
  api?.reg.delete(HL_PHRASE);
  for (const el of document.querySelectorAll('[data-branchkit-find]')) el.remove();
  document.querySelector(`[${STYLE_ATTR}]`)?.remove();
}

function clearHighlights(): void {
  const api = highlightApi();
  api?.reg.delete(HL_ALL);
  api?.reg.delete(HL_CURRENT);
  api?.reg.delete(HL_PHRASE);
  matchRanges = [];
  currentIndex = -1;
}

// First match at or below the top of the viewport, so an incremental search
// jumps to the nearest forward match rather than always the page top.
function pickInitialIndex(): number {
  for (let i = 0; i < matchRanges.length; i++) {
    if (matchRanges[i].getBoundingClientRect().bottom > 0) return i;
  }
  return 0;
}

// Reserve the floating pill's footprint at the bottom so the current match is
// never scrolled to behind it (pill height + bottom margin, with slack).
const FIND_BAR_RESERVE_PX = 60;
function scrollToCurrent(): void {
  const r = matchRanges[currentIndex];
  if (!r) return;
  const rect = r.getBoundingClientRect();
  if (rect.top < 0 || rect.bottom > window.innerHeight - FIND_BAR_RESERVE_PX) {
    r.startContainer.parentElement?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }
}

// --- Find logic ---

// Match the browser's own find-in-page notion of "visible text": skip matches in
// display:none / visibility:hidden / content-visibility / opacity:0 subtrees, so
// our count agrees with Ctrl+F and we never "navigate" to an invisible match.
// Prefer Element.checkVisibility() (Chrome 105+/FF); fall back to a layout-box +
// computed-style check on older engines.
function isMatchVisible(range: Range): boolean {
  const el = range.startContainer.parentElement;
  if (!el) return false;
  const check = (el as Element & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
  if (typeof check === 'function') {
    return check.call(el, { checkOpacity: true, checkVisibilityCSS: true });
  }
  if (range.getClientRects().length === 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.opacity !== '0';
}

/** Apply a resolved set of visible match ranges: update state, highlight, and
 * scroll to the first. Shared by typed (exact) and voice (tolerant/fuzzy) find. */
function applyFoundRanges(query: string, ranges: Range[]): void {
  state.query = query;
  clearHighlights();
  matchRanges = ranges;
  state.matchCount = matchRanges.length;
  if (matchRanges.length === 0) {
    currentIndex = -1;
    state.matchIndex = 0;
    updateCountDisplay();
    return;
  }
  currentIndex = pickInitialIndex();
  state.matchIndex = currentIndex + 1;
  applyHighlights();
  scrollToCurrent();
  updateCountDisplay();
}

/** Typed/dictated find-bar input: incremental, exact first, then
 * punctuation/accent-tolerant. The bar used to be exact-only, which broke
 * the repeat-query voice flow: after an armed "search" query the box stays
 * focused, and the next dictation types into it WITH WhisperKit's prosody
 * punctuation ("red, green"). Exact-first keeps every previously-matching
 * typed query byte-identical in behavior; the flexible layer engages only
 * at zero exact matches. The phonetic layer stays dictation-only —
 * per-keystroke phonetic correction on partial typed words would misfire.
 * (2026-07-24 decision.) */
function performFind(query: string): void {
  if (query === '') {
    state.query = query;
    clearHighlights();
    state.matchIndex = 0;
    state.matchCount = 0;
    updateCountDisplay();
    return;
  }
  applyFoundRanges(query, locateTolerant(query));
}

/** Shared find locator: exact first, then punctuation/accent-tolerant.
 * Used by the find bar's incremental input, the armed voice find, and
 * findFirstRange. */
function locateTolerant(query: string): Range[] {
  const root = document.body || document.documentElement;
  const exact = findMatchRanges(query, root).filter(isMatchVisible);
  if (exact.length) return exact;
  return findRangesFlexible(query, root).filter(isMatchVisible);
}

/**
 * Locate a phrase on the page and return the first visible match Range (exact,
 * then punctuation/accent-tolerant — the same layering as voice find, without
 * touching the find bar/highlights). The substrate for caret mode's "extend to
 * <phrase>" (notes/DESIGN_VOICE_SELECTION_BOUNDS.md). Null when nothing matches.
 */
export function findFirstRange(query: string): Range | null {
  return findAllRanges(query)[0] ?? null;
}

/**
 * All visible matches for a phrase (exact, then tolerant — same layering as
 * findFirstRange). The substrate for range-match disambiguation: the caller
 * decides whether one match acts immediately or several get pick badges
 * (activate/range-disambiguation.ts).
 */
export function findAllRanges(query: string): Range[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  return locateTolerant(trimmed);
}

function move(delta: number): void {
  if (matchRanges.length === 0) return;
  currentIndex = (currentIndex + delta + matchRanges.length) % matchRanges.length;
  state.matchIndex = currentIndex + 1;
  applyHighlights();
  scrollToCurrent();
  updateCountDisplay();
}

// --- Keyboard handling (find bar input) ---
//
// Gone (Wave 3 C5): the dictated-insert predicate, the 80 ms commit debounce,
// the 229/isComposing sentinel branches and the blur close all live in the
// shared PhraseCollector now (scan/phrase-collector.ts), which carries every
// rationale — including why `insertReplacementText` is not dictation and why
// the utterance boundary is 400 ms. createFindBar wires the session; this
// module keeps only what a commit MEANS (commitFind below).

/** Commit the search (Vimium-style): close the input bar but keep the highlights
 * and the current match. The page regains the keyboard; n / Shift+n then cycle
 * matches via handleFindNavKey. The committed pill stays as the visible
 * affordance (query, live count, dismiss hint). Enter on an empty query just
 * closes find, like Vimium. */
function commitFind(): void {
  if (!state.active || !barElement) return;
  if (state.query === '') {
    removeFindBar();
    closeFindMode();
    return;
  }
  const { query } = state;
  const target = phraseTarget;
  // Breadcrumb for the phrase-commit chain (paired with BK_SELECT_TO_RESOLVE
  // and BK_RANGE_PICK_WINDOW): its absence after a dictation says the commit
  // itself never fired, its presence localizes the failure downstream.
  bkLog('BK_PHRASE_COMMIT', { len: query.length, matches: matchRanges.length, phrase: target !== null });
  if (target !== null) {
    // A phrase-targeting box exists to feed a command that needs something to
    // act on. With no match there is nothing to hand over, so keep the box open
    // and select its text — the next dictation then REPLACES the query instead
    // of appending to it, since dictation types at the cursor.
    if (matchRanges.length === 0) {
      inputElement?.select();
      return;
    }
    // End the session but KEEP the paint: the matches are the candidates, and
    // the consumer (a selection, or codeword chips over those candidates) is
    // what finally answers the question. It calls clearFindPaint when it does.
    // (The target is grabbed above: endSession nulls it.)
    removeFindBar();
    endSession(true);
    target.onPhrase(query);
    return;
  }
  removeFindBar();
  showCommittedPill();
  scrollToCurrent();
  if (matchRanges.length > 0) onCommit?.();
}

// --- Public API ---

/**
 * Open a phrase-targeting box. Always a FRESH session — each ask for a phrase
 * is its own question, so a live search (or a previous phrase box) is closed
 * rather than inherited: its query, pill and meaning of Enter belong to the
 * old intent.
 */
export function openPhraseBox(target: PhraseTarget): void {
  if (state.active) closeFindMode();
  phraseTarget = target;
  state.active = true;
  modes.push('find'); // one session lifetime, search or phrase alike
  state.query = '';
  state.matchIndex = 0;
  state.matchCount = 0;
  createFindBar();
  onActivate?.();
}

export function openFindMode(): void {
  // A live PHRASE session is a different intent — replace it rather than
  // inherit its query and its meaning of Enter. A live SEARCH refines.
  if (state.active && phraseTarget !== null) closeFindMode();
  if (state.active) {
    if (barElement) {
      inputElement?.focus();
      inputElement?.select();
      return;
    }
    // Committed state — `/` reopens the bar seeded with the current query so
    // it can be refined (Vimium behavior). Previously this was a dead key.
    removeCommittedPill();
    createFindBar();
    if (inputElement && state.query) {
      inputElement.value = state.query;
      inputElement.select();
    }
    return;
  }
  state.active = true;
  modes.push('find'); // the stack rides the session's one lifetime (Wave 3 C2)
  state.query = '';
  state.matchIndex = 0;
  state.matchCount = 0;
  createFindBar();
  onActivate?.();
}

export function closeFindMode(): void {
  endSession(false);
}

/**
 * End the find session. `keepPaint` hands the match highlighting to whatever
 * comes next instead of erasing it.
 *
 * A phrase-targeting commit needs that: the matches ARE the candidates, and
 * clearing them at commit meant the pick chips appeared over text with no
 * marking left on it — the chips pointed at nothing, and a single-match
 * selection flashed from highlighted to bare before the selection landed. The
 * paint now lives until the phrase is actually resolved, and whoever answers
 * the question calls clearFindPaint.
 */
function endSession(keepPaint: boolean): void {
  if (!state.active) return;
  state.active = false;
  modes.pop('find');
  // The target belongs to the SESSION, so it dies with it. Leaving it set
  // made module state say "this is a highlight box" with no box on screen,
  // and any entry point that forgot to clear it picked that up (findImmediate
  // did, for every voice find after a highlight).
  phraseTarget = null;
  if (!keepPaint) clearHighlights();
  removeFindBar();
  removeCommittedPill();
  onDeactivate?.();
}

/**
 * Drop match highlighting handed over by a phrase-targeting commit.
 *
 * Called by the consumer when the phrase resolves — a selection made, a pick
 * answered or abandoned. Safe to call at any time; find paint outliving its
 * question is the "undismissable ghost" failure the committed pill was
 * invented to avoid.
 */
export function clearFindPaint(): void {
  clearHighlights();
}

export function findNext(): void {
  if (matchRanges.length) move(1);
}

export function findPrevious(): void {
  if (matchRanges.length) move(-1);
}

// --- Caret/visual-mode find-in-selection (notes/DESIGN_MARKS_AND_CARET.md) ---
// The current match is a Range, separate from the document selection; caret
// mode reads it to extend its selection to the match.

/** True while find is active and has at least one match. */
export function hasActiveMatches(): boolean {
  return state.active && matchRanges.length > 0;
}

/** The current match Range, or null when find is inactive / has no matches. */
export function getCurrentMatchRange(): Range | null {
  return currentIndex >= 0 && currentIndex < matchRanges.length ? matchRanges[currentIndex] : null;
}

/** Every committed match, in document order. The live array is module state
 *  that `move`/`applyHighlights` mutate, so this hands out a copy. */
export function getMatchRanges(): Range[] {
  return matchRanges.slice();
}

/**
 * Jump straight to a specific match — the codeword path's twin of `n`/`N`.
 * Same effect as navigating there: it becomes current, gets the solid
 * highlight, scrolls into view, and the n/N counter follows. Returns false if
 * the range isn't one of the live matches (a stale codeword after a requery).
 */
export function findGoToRange(range: Range): boolean {
  const i = matchRanges.indexOf(range);
  if (i < 0) return false;
  currentIndex = i;
  state.matchIndex = currentIndex + 1;
  applyHighlights();
  scrollToCurrent();
  updateCountDisplay();
  return true;
}

/** Advance the current match by `delta` (also updates the highlight + count),
 *  returning the new current Range — for caret mode to extend its selection to
 *  the next/previous match. Null when there are no matches. */
export function findNavigate(delta: number): Range | null {
  if (matchRanges.length === 0) return null;
  move(delta);
  return getCurrentMatchRange();
}

/**
 * Post-commit navigation: while find is active but the bar is closed, `n` cycles
 * to the next match, `Shift+n` to the previous, and Escape clears + exits.
 * Returns true if it consumed the key. Other keys pass through (highlights stay
 * until Escape), so it must run before the hint key handler — where bare `n`
 * would otherwise be codeword input in always-mode.
 */
export function handleFindNavKey(e: KeyboardEvent): boolean {
  if (!state.active || barElement) return false; // only when committed (bar closed)
  if (e.ctrlKey || e.altKey || e.metaKey) return false;
  // Escape is deliberately NOT here. This runs in content.ts's keydown preamble,
  // AHEAD of the escape cascade — so taking Escape here peeled the find before
  // any layer above it, and a committed find under hint mode closed the FIND on
  // the key while the spoken "over" left HINT MODE. Two inputs, opposite
  // results, in the one place that promises one order. The find layer is in the
  // cascade (rank 6) and the cascade is the only declaration of the order.
  // n / N stay: they are find NAVIGATION, not an escape, and they have to beat
  // the hint filter so a bare `n` isn't codeword input in always-mode.
  if (e.key === 'n' || e.key === 'N') {
    e.preventDefault();
    e.stopPropagation();
    move(e.shiftKey ? -1 : 1);
    return true;
  }
  return false;
}

/** Voice-activated find: skip the input bar, run the query directly, and show
 * the committed pill — highlights persist, n / Shift+n (or voice "next" /
 * "previous") navigate, Escape or voice "close find" dismisses. */
export function findImmediate(query: string): void {
  // Voice find is a find SESSION and has to say so — a stale phrase target
  // left in module state painted the phrase wash with no current match while
  // the pill drew "/" (the bug endSession's clear now prevents). The one
  // exception is the Model B hybrid below — landing in a box that is ALREADY
  // open. That box's TARGET belongs to the command that opened it (say
  // "highlight", then "search <phrase>" to fill it), and repurposing it here
  // would leave its glyph and placeholder lying about what Enter now does.
  const intoOpenBox = barElement !== null && inputElement !== null;
  if (!intoOpenBox) phraseTarget = null;
  state.active = true;
  modes.push('find'); // dedupes: an immediate find into a live session joins it
  ensureHighlightStyle();
  onActivate?.();
  // Voice find is tolerant (typed find stays exact/incremental). Layered:
  //   1. exact substring, then
  //   2. punctuation/accent-tolerant (handles "Martín", "(", odd spacing), then
  //   3. phonetic-fuzzy correction to the closest page term (ASR sound errors
  //      like "shek out" -> "checkout"), re-located tolerantly.
  // Each layer only runs if the previous found nothing, and (3) falls back to
  // the raw (no-match) query if nothing on the page is close — so it never
  // forces a wrong match for text that genuinely isn't there.
  applyFoundRanges(query, locateTolerant(query));
  if (matchRanges.length === 0) {
    const corrected = bestPageMatch(query, document.body?.innerText ?? '');
    if (corrected && normalizeFuzzy(corrected.term) !== normalizeFuzzy(query)) {
      applyFoundRanges(corrected.term, locateTolerant(corrected.term));
    }
  }
  // Write the EXACT page text that was matched into the query (not the dictated,
  // possibly-garbled words). So what's shown is a real page substring — search
  // stays exact whether spoken or typed, and editing it by keyboard behaves the
  // same. On a no-match, keep the spoken query so "No matches" reflects it.
  if (matchRanges.length > 0) {
    const exactText = (matchRanges[currentIndex] ?? matchRanges[0]).toString().trim();
    if (exactText) {
      state.query = exactText;
      updateCountDisplay();
    }
  }
  // Model B (hybrid): voice "search" opened the find box as its cue. If it's
  // open, fill it with the resolved query and keep it open so the user can see +
  // edit it by typing. Otherwise land on the read-only committed pill.
  if (barElement && inputElement) {
    inputElement.value = state.query;
    inputElement.focus();
    inputElement.select();
  } else {
    showCommittedPill();
  }
  // Only a SEARCH has committed here. onCommit means "there is now a result set
  // you move around in", which is what search badges and caret's extend-to-match
  // hang off; a phrase box filled by voice is still collecting an argument, and
  // in that mode a codeword means "select this one" — the range pick's job, not
  // a search badge's. commitFind draws the same line for the typed path.
  if (phraseTarget === null && matchRanges.length > 0) onCommit?.();
}
