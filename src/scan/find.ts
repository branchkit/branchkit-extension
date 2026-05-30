/**
 * BranchKit Browser — Find-in-page.
 *
 * Hybrid approach from Vimium: window.find() for navigation,
 * native Selection API for highlighting. PostFindMode intercepts
 * keystrokes when a match lands in an input field.
 */

declare global {
  interface Window {
    find(
      string?: string,
      caseSensitive?: boolean,
      backward?: boolean,
      wrapAround?: boolean,
      wholeWord?: boolean,
      searchInFrames?: boolean,
      showDialog?: boolean,
    ): boolean;
  }
}

export type FindState = {
  active: boolean;
  query: string;
  matchIndex: number;
  matchCount: number;
};

let state: FindState = { active: false, query: '', matchIndex: 0, matchCount: 0 };
let barElement: HTMLElement | null = null;
let inputElement: HTMLInputElement | null = null;
let postFindActive = false;

// Callbacks for mode integration
let onActivate: (() => void) | null = null;
let onDeactivate: (() => void) | null = null;

export function setFindCallbacks(opts: {
  onActivate?: () => void;
  onDeactivate?: () => void;
}): void {
  onActivate = opts.onActivate ?? null;
  onDeactivate = opts.onDeactivate ?? null;
}

export function getFindState(): FindState {
  return { ...state };
}

export function isFindActive(): boolean {
  return state.active;
}

export function isPostFindActive(): boolean {
  return postFindActive;
}

// --- Find bar UI ---

function createFindBar(): void {
  if (barElement) return;

  barElement = document.createElement('div');
  barElement.setAttribute('data-branchkit-find', '');
  barElement.style.cssText = `
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    height: 36px;
    background: #1e1e1e;
    border-top: 1px solid rgba(255,255,255,0.15);
    display: flex;
    align-items: center;
    padding: 0 12px;
    gap: 8px;
    z-index: 2147483647;
    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 13px;
    color: #fff;
  `;

  const label = document.createElement('span');
  label.textContent = '/';
  label.style.cssText = 'color: #007AFF; font-weight: 600; font-size: 14px;';
  barElement.appendChild(label);

  inputElement = document.createElement('input');
  inputElement.type = 'text';
  inputElement.placeholder = 'Find in page...';
  inputElement.style.cssText = `
    flex: 1;
    background: rgba(255,255,255,0.08);
    border: 1px solid rgba(255,255,255,0.15);
    border-radius: 4px;
    padding: 4px 8px;
    color: #fff;
    font-size: 13px;
    outline: none;
    font-family: inherit;
  `;
  inputElement.addEventListener('input', () => {
    if (inputElement) {
      performFind(inputElement.value);
    }
  });
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
  if (barElement) {
    barElement.remove();
    barElement = null;
    inputElement = null;
  }
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

// --- Find logic ---

/**
 * Use window.find() for incremental search. It moves the Selection to
 * the next match, which the browser highlights natively.
 */
function performFind(query: string, backward = false): void {
  state.query = query;

  if (query === '') {
    clearSelection();
    state.matchIndex = 0;
    state.matchCount = 0;
    updateCountDisplay();
    return;
  }

  // Count matches via regex scan of text content
  state.matchCount = countMatches(query);

  // window.find(string, caseSensitive, backward, wrapAround, wholeWord, searchInFrames, showDialog)
  const found = window.find(query, false, backward, true, false, true, false);

  if (found) {
    state.matchIndex = Math.min(state.matchIndex + (backward ? -1 : 1), state.matchCount);
    if (state.matchIndex < 1) state.matchIndex = state.matchCount;
    if (state.matchIndex > state.matchCount) state.matchIndex = 1;

    // Check if match landed in an input — activate PostFindMode
    checkPostFindMode();
  } else {
    state.matchIndex = 0;
  }

  updateCountDisplay();
}

function countMatches(query: string): number {
  if (!query) return 0;
  try {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'gi');
    const text = document.body?.innerText || '';
    const matches = text.match(regex);
    return matches ? matches.length : 0;
  } catch {
    return 0;
  }
}

function clearSelection(): void {
  const sel = window.getSelection();
  if (sel) sel.removeAllRanges();
}

// --- PostFindMode ---
// When a match lands inside an input/contenteditable, the next keystroke
// would type into the field. PostFindMode intercepts and treats n/N as
// find commands instead.

function checkPostFindMode(): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) {
    postFindActive = false;
    return;
  }

  const node = sel.anchorNode;
  if (!node) {
    postFindActive = false;
    return;
  }

  const el = node.nodeType === Node.ELEMENT_NODE
    ? node as Element
    : node.parentElement;

  if (!el) {
    postFindActive = false;
    return;
  }

  const isEditable =
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    (el as HTMLElement).isContentEditable ||
    el.closest('[contenteditable="true"]') !== null;

  postFindActive = isEditable;
}

// --- Keyboard handling ---

function handleFindBarKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeFindMode();
    return;
  }

  if (e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
    if (e.shiftKey) {
      findPrevious();
    } else {
      findNext();
    }
    return;
  }
}

/**
 * Handle keystrokes in PostFindMode. Returns true if consumed.
 */
export function handlePostFindKey(e: KeyboardEvent): boolean {
  if (!postFindActive) return false;

  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeFindMode();
    return true;
  }

  if (e.key === 'n' && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    e.stopPropagation();
    if (e.shiftKey) {
      findPrevious();
    } else {
      findNext();
    }
    return true;
  }

  // Any other key exits PostFindMode and passes through
  postFindActive = false;
  return false;
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
  postFindActive = false;

  createFindBar();
  onActivate?.();
}

export function closeFindMode(): void {
  if (!state.active) return;

  state.active = false;
  postFindActive = false;
  clearSelection();
  removeFindBar();
  onDeactivate?.();
}

export function findNext(): void {
  if (state.query) {
    performFind(state.query, false);
  }
}

export function findPrevious(): void {
  if (state.query) {
    performFind(state.query, true);
  }
}

/**
 * Voice-activated find: skip the bar, run the query directly.
 */
export function findImmediate(query: string): void {
  state.active = true;
  onActivate?.();
  performFind(query);
}
