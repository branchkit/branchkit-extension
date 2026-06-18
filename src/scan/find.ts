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
 * Where the API is unavailable (older engines), matching + scroll-to still work;
 * only the visual highlight is absent.
 */

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

export function setFindCallbacks(opts: { onActivate?: () => void; onDeactivate?: () => void }): void {
  onActivate = opts.onActivate ?? null;
  onDeactivate = opts.onDeactivate ?? null;
}

export function getFindState(): FindState {
  return { ...state };
}

export function isFindActive(): boolean {
  return state.active;
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
  // Current match emphasized (orange) over the all-matches wash (yellow).
  style.textContent =
    `::highlight(${HL_ALL}) { background-color: rgba(255, 213, 79, 0.45); color: inherit; }\n` +
    `::highlight(${HL_CURRENT}) { background-color: #ff9800; color: #000; }`;
  (document.head || document.documentElement).appendChild(style);
}

// --- Match finding (Range-based) ---

/**
 * All Ranges matching `query` (case-insensitive) within single text nodes of
 * `root`, skipping script/style and BranchKit's own UI. Single-node matching
 * (not across element boundaries) covers the overwhelming majority of matches.
 * Pure aside from reading the DOM — unit-tested directly.
 */
export function findMatchRanges(query: string, root: Node): Range[] {
  const ranges: Range[] = [];
  if (!query) return ranges;
  const needle = query.toLowerCase();
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      const parent = (node as Text).parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
      if (parent.closest('[data-branchkit-find]') || parent.closest('[data-branchkit-hint]')) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const hay = node.nodeValue!.toLowerCase();
    let idx = hay.indexOf(needle);
    while (idx !== -1) {
      const range = doc.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + needle.length);
      ranges.push(range);
      idx = hay.indexOf(needle, idx + needle.length);
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
  barElement.style.cssText = `
    position: fixed; bottom: 0; left: 0; right: 0; height: 36px;
    background: #1e1e1e; border-top: 1px solid rgba(255,255,255,0.15);
    display: flex; align-items: center; padding: 0 12px; gap: 8px;
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

function scrollToCurrent(): void {
  const r = matchRanges[currentIndex];
  if (!r) return;
  const rect = r.getBoundingClientRect();
  if (rect.top < 0 || rect.bottom > window.innerHeight) {
    r.startContainer.parentElement?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }
}

// --- Find logic ---

function performFind(query: string): void {
  state.query = query;
  clearHighlights();
  if (query === '') {
    state.matchIndex = 0;
    state.matchCount = 0;
    updateCountDisplay();
    return;
  }
  matchRanges = findMatchRanges(query, document.body || document.documentElement)
    .filter((r) => r.getClientRects().length > 0); // drop hidden/collapsed matches
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
    move(e.shiftKey ? -1 : 1);
  }
}

// --- Public API ---

export function openFindMode(): void {
  if (state.active) {
    inputElement?.focus();
    inputElement?.select();
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
  onDeactivate?.();
}

export function findNext(): void {
  if (matchRanges.length) move(1);
}

export function findPrevious(): void {
  if (matchRanges.length) move(-1);
}

/** Voice-activated find: skip the bar, run the query directly (highlights paint). */
export function findImmediate(query: string): void {
  state.active = true;
  ensureHighlightStyle();
  onActivate?.();
  performFind(query);
}
