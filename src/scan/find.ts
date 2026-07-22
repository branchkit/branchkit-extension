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

export type FindState = {
  active: boolean;
  query: string;
  matchIndex: number;
  matchCount: number;
};

const HL_ALL = 'branchkit-find';
const HL_CURRENT = 'branchkit-find-current';
const STYLE_ATTR = 'data-branchkit-find-style';

let state: FindState = { active: false, query: '', matchIndex: 0, matchCount: 0 };
let barElement: HTMLElement | null = null;
let inputElement: HTMLInputElement | null = null;
let matchRanges: Range[] = [];
let currentIndex = -1;

let onActivate: (() => void) | null = null;
let onDeactivate: (() => void) | null = null;
// Fired when a search commits WITH matches (Enter or voice find). Caret mode
// uses it to auto-extend the selection to the match. See caret.ts.
let onCommit: (() => void) | null = null;

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
  return { ...state };
}

export function isFindActive(): boolean {
  return state.active;
}

/** True while the find bar input is open and capturing keystrokes. After Enter
 * commits the search the bar closes but find stays active (highlights persist,
 * n / Shift+n navigate) — see handleFindNavKey. */
export function isFindBarOpen(): boolean {
  return barElement !== null;
}

// --- CSS Custom Highlight API access (guarded; newish API) ---

interface HighlightLike { priority: number }
type HighlightCtor = new (...ranges: Range[]) => HighlightLike;

function highlightApi(): { reg: Map<string, HighlightLike>; Ctor: HighlightCtor } | null {
  const reg = (CSS as unknown as { highlights?: Map<string, HighlightLike> }).highlights;
  const Ctor = (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight;
  return reg && Ctor ? { reg, Ctor } : null;
}

function ensureHighlightStyle(): void {
  if (document.querySelector(`[${STYLE_ATTR}]`)) return;
  const style = document.createElement('style');
  style.setAttribute(STYLE_ATTR, '');
  // Current match is a solid highlighter-yellow block (opaque, black text); the
  // other matches are a much fainter wash of the same yellow, so the current one
  // clearly stands out by vividness.
  style.textContent =
    `::highlight(${HL_ALL}) { background-color: rgba(255, 235, 59, 0.22); color: inherit; }\n` +
    `::highlight(${HL_CURRENT}) { background-color: #ffeb3b; color: #000; }`;
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

  const label = document.createElement('span');
  label.textContent = '/';
  label.style.cssText = 'color: #007AFF; font-weight: 600; font-size: 14px;';
  barElement.appendChild(label);

  inputElement = document.createElement('input');
  inputElement.type = 'text';
  inputElement.placeholder = 'Find in page...';
  inputElement.style.cssText = `
    flex: 1; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15);
    border-radius: 4px; padding: 4px 8px; color: #fff; font-size: 13px; outline: none;
    font-family: inherit;
  `;
  inputElement.addEventListener('input', () => { if (inputElement) performFind(inputElement.value); });
  inputElement.addEventListener('keydown', handleFindBarKey);
  barElement.appendChild(inputElement);

  const countSpan = document.createElement('span');
  countSpan.id = 'branchkit-find-count';
  countSpan.style.cssText = 'color: rgba(255,255,255,0.5); font-size: 11px; min-width: 60px;';
  barElement.appendChild(countSpan);

  document.body.appendChild(barElement);
  inputElement.focus();
}

function removeFindBar(): void {
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
  if (matchRanges.length === 0) return;
  api.reg.set(HL_ALL, new api.Ctor(...matchRanges));
  if (currentIndex >= 0 && currentIndex < matchRanges.length) {
    const cur = new api.Ctor(matchRanges[currentIndex]);
    cur.priority = 1; // paint the current match over the all-matches wash
    api.reg.set(HL_CURRENT, cur);
  }
}

function clearHighlights(): void {
  const api = highlightApi();
  api?.reg.delete(HL_ALL);
  api?.reg.delete(HL_CURRENT);
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

/** Typed find: exact substring, incremental as the user types. */
function performFind(query: string): void {
  if (query === '') {
    state.query = query;
    clearHighlights();
    state.matchIndex = 0;
    state.matchCount = 0;
    updateCountDisplay();
    return;
  }
  applyFoundRanges(
    query,
    findMatchRanges(query, document.body || document.documentElement).filter(isMatchVisible),
  );
}

/** Voice find locator: exact first, then punctuation/accent-tolerant. */
function locateVoice(query: string): Range[] {
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
  const trimmed = query.trim();
  if (!trimmed) return null;
  return locateVoice(trimmed)[0] ?? null;
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

function handleFindBarKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeFindMode();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
    commitFind();
  }
}

/** Commit the search (Vimium-style): close the input bar but keep the highlights
 * and the current match. The page regains the keyboard; n / Shift+n then cycle
 * matches via handleFindNavKey. The committed pill stays as the visible
 * affordance (query, live count, dismiss hint). Enter on an empty query just
 * closes find, like Vimium. */
function commitFind(): void {
  if (!state.active || !barElement) return;
  removeFindBar();
  if (state.query === '') {
    closeFindMode();
    return;
  }
  showCommittedPill();
  scrollToCurrent();
  if (matchRanges.length > 0) onCommit?.();
}

// --- Public API ---

export function openFindMode(): void {
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
  state.query = '';
  state.matchIndex = 0;
  state.matchCount = 0;
  createFindBar();
  onActivate?.();
}

export function closeFindMode(): void {
  if (!state.active) return;
  state.active = false;
  clearHighlights();
  removeFindBar();
  removeCommittedPill();
  onDeactivate?.();
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
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeFindMode();
    return true;
  }
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
  state.active = true;
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
  applyFoundRanges(query, locateVoice(query));
  if (matchRanges.length === 0) {
    const corrected = bestPageMatch(query, document.body?.innerText ?? '');
    if (corrected && normalizeFuzzy(corrected.term) !== normalizeFuzzy(query)) {
      applyFoundRanges(corrected.term, locateVoice(corrected.term));
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
  if (matchRanges.length > 0) onCommit?.();
}
