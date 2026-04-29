/**
 * BranchKit Browser — Content script entry point.
 *
 * Injected per frame. Scans DOM, creates badges, handles keyboard input.
 * Voice commands arrive via background → BRANCHKIT_ACTION messages.
 */

import { Category, BadgeDisplayMode, ScannedElement, Message } from './types';
import { LabelAssignment, WORD_TO_LETTER, isAlphabetLoaded, setAlphabet } from './words';
import { scanElements, classifyCategory, buildSelector } from './scanner';
import { ElementWrapper, WrapperStore } from './element-wrapper';
import { HintBadge } from './hints';
import { ActionDispatcher, CommandRegistry } from './dispatcher';
import { KeyHandler } from './keyboard';
import { getActiveAdapter, scanWithAdapter } from './adapters/index';

// --- State ---

const store = new WrapperStore();
const dispatcher = new ActionDispatcher();
const registry = new CommandRegistry();
const keyHandler = new KeyHandler(registry, dispatcher);

let hintsVisible = false;
let activeCategory: Category | null = null;
let displayMode: BadgeDisplayMode = 'word';
let lastGrammarHash = '';
let pendingMutation = false;
const MAX_BADGE_COUNT = 676; // No artificial cap; word pairs for >26

// Codewords currently held from the per-tab pool. Released and re-claimed
// on each scan so DOM mutations don't leak labels across renders. Kept
// across hide/show cycles so the voice plugin's grammar (which is built
// from pool codewords) stays valid even when badges aren't visible.
let currentClaimedLabels: string[] = [];

// Latest scan completion. showHints() awaits this so it can render badges
// using codewords claimed during the in-flight scan, rather than racing
// against a half-done assignment.
let pendingScan: Promise<void> = Promise.resolve();

// Voice category groups — maps voice trigger prefixes to element categories.
// "set ape" targets the first input, "go ape" targets the first clickable, etc.
const VOICE_GROUP_SET: Category[] = ['input'];
const VOICE_GROUP_GO: Category[] = ['link', 'button', 'tab', 'edit', 'view'];
const VOICE_GROUP_TABLES: Category[] = ['tables'];

// --- Display Mode from storage ---

if (typeof chrome !== 'undefined' && chrome.storage?.sync) {
  chrome.storage.sync.get('badgeDisplayMode', (result) => {
    if (result.badgeDisplayMode) {
      displayMode = result.badgeDisplayMode;
    }
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.badgeDisplayMode) {
      displayMode = changes.badgeDisplayMode.newValue || 'word';
      // Re-render visible badges with new display mode
      if (hintsVisible) {
        updateBadgeLabels();
      }
    }
    // BranchKit pushed a new alphabet — adopt it. Stays as the built-in
    // fallback if the new value is malformed. Background regenerates the
    // per-tab pool with the new alphabet; our prior codeword claims are
    // stale (the assigned map has been wiped). Re-scan to claim afresh.
    if (changes.alphabet?.newValue) {
      setAlphabet(changes.alphabet.newValue);
      currentClaimedLabels = []; // pool wiped server-side; don't double-release
      doScan().then(() => {
        if (hintsVisible) updateBadgeLabels();
      });
    }
  });
}

// Adopt the BranchKit alphabet from chrome.storage.local on script load.
// Local (not sync) because the alphabet is per-machine: it tracks whatever
// voice plugin happens to be running locally, not user preferences.
if (typeof chrome !== 'undefined' && chrome.storage?.local) {
  chrome.storage.local.get('alphabet', (result) => {
    if (Array.isArray(result.alphabet)) {
      setAlphabet(result.alphabet);
    }
  });
}

// --- Register Commands (Slice B) ---

registry.add({ keys: 'f', action: 'show_hints' });
registry.add({ keys: 'F', action: 'show_hints_newtab' });
registry.add({ keys: 'Escape', action: 'hide_hints' });

// --- Register Action Handlers ---

dispatcher.register('show_hints', () => {
  doScan();
  showHints();
  keyHandler.enterHintMode();
});

let activateInNewTab = false;

dispatcher.register('show_hints_newtab', () => {
  activateInNewTab = true;
  doScan();
  showHints();
  keyHandler.enterHintMode();
});

dispatcher.register('hide_hints', () => {
  hideHints();
  keyHandler.exitHintMode();
});

dispatcher.register('activate_first_visible', () => {
  const visible = store.all.filter(w => w.hint?.isVisible && w.label);
  if (visible.length > 0) {
    activateWrapper(visible[0]);
  }
});

dispatcher.register('activate_hint', (params) => {
  const word = params.word;
  const word2 = params.word2;
  if (word2) {
    const w = store.byLabelPair(word, word2);
    if (w) activateWrapper(w);
  } else if (word) {
    const w = store.byLabel(word);
    if (w) activateWrapper(w);
  }
});

// Category-specific hint display (for voice: "go", "set", "tables", etc.)
dispatcher.register('show_hints_category', (params) => {
  const cat = params.category as Category;
  if (!cat) return;
  doScan();
  showHints(cat);
});

// --- Keyboard Filter Callback ---

keyHandler.setFilterCallback((prefix: string) => {
  if (!hintsVisible) return;

  if (prefix === '') {
    // Show all badges
    for (const w of store.all) {
      w.hint?.setFiltered(false);
    }
    return;
  }

  // Filter: match word prefix using first letter (keyboard types letter, matches word)
  const matches = store.matchingLetterPrefix(prefix);
  for (const w of store.all) {
    const isMatch = matches.includes(w);
    w.hint?.setFiltered(!isMatch);
  }

  // Auto-activate if single match
  if (matches.length === 1) {
    activateWrapper(matches[0]);
    hideHints();
    keyHandler.exitHintMode();
  }
});

// --- Core Functions ---

/** Filter to viewport-visible elements and sort by position (top-left first). */
function viewportSort(wrappers: ElementWrapper[]): ElementWrapper[] {
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  return wrappers
    .filter(w => {
      const r = w.element.getBoundingClientRect();
      return r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
    })
    .sort((a, b) => {
      const ra = a.element.getBoundingClientRect();
      const rb = b.element.getBoundingClientRect();
      return (ra.top - rb.top) || (ra.left - rb.left);
    });
}

/**
 * Claim N codewords from the per-tab pool. Returns up to N strings — fewer
 * if the pool is partially exhausted, empty if the alphabet hasn't loaded.
 * Pool is per-tab, shared across all frames; the background's assigned-map
 * doubles as the routing table for voice actions.
 */
async function claimLabelsFromPool(count: number): Promise<string[]> {
  if (count <= 0) return [];
  try {
    const response = await chrome.runtime.sendMessage({ type: 'CLAIM_LABELS', count });
    return Array.isArray(response?.labels) ? response.labels : [];
  } catch {
    return [];
  }
}

function releaseClaimedLabels(): void {
  if (currentClaimedLabels.length === 0) return;
  const toRelease = currentClaimedLabels;
  currentClaimedLabels = [];
  chrome.runtime.sendMessage({ type: 'RELEASE_LABELS', labels: toRelease })
    .catch(() => {/* extension context may be invalidated */});
}

/**
 * Convert a pool codeword string ("arch" or "rain bake") to the
 * LabelAssignment shape the HintBadge renderer expects. Letter mapping
 * comes from the words.ts WORD_TO_LETTER table populated when the
 * alphabet was set; "?" only appears if the alphabet is mismatched.
 */
function poolLabelToAssignment(codeword: string): LabelAssignment {
  const words = codeword.split(/\s+/).filter(w => w.length > 0);
  const letter = words.map(w => WORD_TO_LETTER[w] ?? '?').join('');
  return { words, letter, isSingle: words.length === 1 };
}

function doScan(): Promise<void> {
  pendingScan = scanAndClaim();
  return pendingScan;
}

async function scanAndClaim(): Promise<void> {
  // Check for site adapter
  const adapter = getActiveAdapter(window.location.href);

  let elements: ScannedElement[];
  let refs: Element[];

  if (adapter) {
    const result = scanWithAdapter(adapter);
    elements = result.elements;
    refs = result.refs;
  } else {
    const result = scanElements();
    elements = result.elements;
    refs = result.refs;
  }

  // Release any prior pool claims before claiming fresh ones — keeps the
  // tab-wide pool from leaking codewords across rescans.
  releaseClaimedLabels();

  // Claim codewords from the per-tab pool. Pool returns up to N strings;
  // any tail beyond the returned count gets no codeword and is excluded
  // from the voice grammar (still hintable for keyboard, just not voice).
  const claimed = await claimLabelsFromPool(elements.length);
  currentClaimedLabels = [...claimed];
  for (let i = 0; i < elements.length; i++) {
    elements[i].codeword = i < claimed.length ? claimed[i] : '';
  }

  // Build wrappers (after codewords are stamped on the scanned elements)
  const wrappers: ElementWrapper[] = [];
  for (let i = 0; i < elements.length; i++) {
    wrappers.push(new ElementWrapper(refs[i], elements[i]));
  }

  store.set(wrappers);

  // Push grammar to background (for BranchKit voice). Codewords are now
  // present on every voice-addressable element; voice plugin consumes
  // them verbatim.
  pushGrammar();
}

async function showHints(filter?: Category | Category[]): Promise<void> {
  if (!isAlphabetLoaded()) {
    console.warn('[BranchKit Browser] Hints unavailable: alphabet not loaded. Is BranchKit running?');
    return;
  }

  // Wait for the most recent scan to finish so wrapper.scanned.codeword
  // is populated before we try to render badges.
  await pendingScan;

  // Determine which categories to show
  const categories: Category[] | null = filter
    ? (Array.isArray(filter) ? filter : [filter])
    : null;
  activeCategory = typeof filter === 'string' ? filter : null;

  // Get elements, optionally filtered by category
  const allTargets = categories
    ? store.all.filter(w => categories.includes(w.category))
    : [...store.all];

  if (allTargets.length === 0) return;

  // Filter to viewport-visible and sort by position (same as grammar push)
  const targets = viewportSort(allTargets);
  if (targets.length === 0) return;

  // Only render hints for elements that received a pool codeword.
  // Elements without one wouldn't be voice-addressable and their badge
  // would say "?" — better to leave them unhinted.
  const renderable = targets
    .slice(0, MAX_BADGE_COUNT)
    .filter(w => w.scanned.codeword.length > 0);

  for (const wrapper of renderable) {
    const label = poolLabelToAssignment(wrapper.scanned.codeword);
    wrapper.label = label;

    // Create badge if not exists
    if (!wrapper.hint) {
      wrapper.hint = new HintBadge(
        wrapper.element,
        label,
        wrapper.category,
        displayMode,
      );
    } else {
      wrapper.hint.updateLabel(label, displayMode);
    }

    wrapper.hint.show();
  }

  hintsVisible = true;
}

function hideHints(): void {
  hintsVisible = false;
  activeCategory = null;
  activateInNewTab = false;
  keyHandler.exitHintMode();
  for (const w of store.all) {
    w.hint?.hide();
  }

  // Catch up on DOM changes that occurred while hints were visible
  if (pendingMutation) {
    pendingMutation = false;
    setTimeout(() => doScan(), 100);
  }
}

function updateBadgeLabels(): void {
  for (const w of store.all) {
    if (w.hint && w.label) {
      w.hint.updateLabel(w.label, displayMode);
    }
  }
}

function activateWrapper(wrapper: ElementWrapper): void {
  const el = wrapper.element as HTMLElement;
  const openNewTab = activateInNewTab;

  hideHints();
  keyHandler.exitHintMode();
  activateInNewTab = false;

  if (wrapper.category === 'input') {
    el.focus();
    el.style.outline = '2px solid #007AFF';
    setTimeout(() => { el.style.outline = ''; }, 3000);
  } else if (openNewTab && wrapper.category === 'link') {
    // Open link in new tab
    const href = (el as HTMLAnchorElement).href;
    if (href) {
      window.open(href, '_blank');
    } else {
      el.click();
    }
  } else {
    el.click();
  }
}

// --- Grammar Push (Slice C) ---

/**
 * Push grammar to background for BranchKit voice commands.
 *
 * Elements are sorted per voice-category group (set/go/tables) by viewport
 * position. This ensures the Go plugin's index-based codeword assignment
 * matches the display order when showHints() renders badges — both use
 * viewportSort() with the same category grouping.
 */
function pushGrammar(): void {
  const elements: ScannedElement[] = [];

  for (const cats of [VOICE_GROUP_SET, VOICE_GROUP_GO, VOICE_GROUP_TABLES]) {
    const group = store.all.filter(w => (cats as readonly Category[]).includes(w.category));
    for (const w of viewportSort(group)) {
      elements.push(w.scanned);
    }
  }

  // Hash-based deduplication
  const hash = elements.map(e => e.selector + e.category).join('|');
  if (hash === lastGrammarHash) return;
  lastGrammarHash = hash;

  try {
    chrome.runtime.sendMessage({
      type: 'SCAN_RESULT',
      elements,
      adapter: getActiveAdapter(window.location.href)?.name || null,
    } as Message);
  } catch {
    // Extension context may be invalidated
  }
}

// --- Active-frame tracking ---
//
// Each frame's content script knows whether `window` currently has focus.
// The background uses this (via GET_FOCUS_STATUS) to route actions to
// whichever frame the user is interacting with, when that's relevant.
// Trusted focus/blur events on `window` are the canonical signal.

let windowHasFocus = document.hasFocus();

window.addEventListener('focus', (e) => {
  if (e.target === window) windowHasFocus = true;
}, true);
window.addEventListener('blur', (e) => {
  if (e.target === window) windowHasFocus = false;
}, true);

// --- Message Listener (from background / voice) ---

chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
  if (message.type === 'GET_FOCUS_STATUS') {
    sendResponse({ focused: windowHasFocus });
    return false;
  }

  if (message.type === 'BRANCHKIT_ACTION') {
    const { action, params } = message.payload;
    console.log('[BranchKit Content] action received:', action, params);

    // Voice actions show category-specific hints (not all elements).
    // Each voice group gets its own label pool matching the grammar's
    // per-category codeword assignment.
    if (action === 'show_hints' || action === 'show_hints_set') {
      doScan();
      showHints(VOICE_GROUP_SET);
    } else if (action === 'show_hints_go') {
      doScan();
      showHints(VOICE_GROUP_GO);
    } else if (action === 'show_hints_tables') {
      doScan();
      showHints(VOICE_GROUP_TABLES);
    } else if (action === 'rescan') {
      // Browser plugin reconnected (actuator restart) — rescan DOM to re-push grammar
      lastGrammarHash = '';
      doScan();
    } else if (action === 'set_badge_mode' && params?.mode) {
      chrome.storage.sync.set({ badgeDisplayMode: params.mode });
    } else if (action === 'click' || action === 'navigate' || action === 'set_value') {
      // Voice command with selector — find and activate
      const selector = params?.selector;
      if (selector) {
        const el = document.querySelector(selector) as HTMLElement;
        if (el) {
          hideHints();
          if (action === 'set_value') {
            el.focus();
            el.style.outline = '2px solid #007AFF';
            setTimeout(() => { el.style.outline = ''; }, 3000);
          } else {
            el.click();
          }
        }
      }
    }
  } else if (message.type === 'SHOW_HINTS') {
    doScan();
    showHints(message.category);
  } else if (message.type === 'HIDE_HINTS') {
    hideHints();
  }
});

// --- Scroll/Resize Listener (reposition fixed badges) ---

let scrollRafPending = false;
function onScrollOrResize(): void {
  if (!hintsVisible || scrollRafPending) return;
  scrollRafPending = true;
  requestAnimationFrame(() => {
    scrollRafPending = false;
    for (const w of store.all) {
      w.hint?.reposition();
    }
  });
}
window.addEventListener('scroll', onScrollOrResize, { passive: true, capture: true });
window.addEventListener('resize', onScrollOrResize, { passive: true });

// --- Keyboard Listener ---

document.addEventListener('keydown', (e: KeyboardEvent) => {
  keyHandler.handleKeyDown(e);
}, true); // capture phase

// --- MutationObserver (debounced rescan) ---

let mutationTimer: ReturnType<typeof setTimeout> | null = null;

const observer = new MutationObserver((_mutations) => {
  // Skip our own mutations (badge add/remove)
  const isOwnMutation = (n: Node) =>
    n instanceof HTMLElement && n.hasAttribute('data-branchkit-hint');
  if (_mutations.every(m =>
    m.type === 'childList' &&
    Array.from(m.addedNodes).every(isOwnMutation) &&
    Array.from(m.removedNodes).every(isOwnMutation)
  )) return;

  // Don't rescan while hints are visible — grammar replacement mid-interaction
  // would change codeword assignments while the user is speaking commands.
  // hideHints() will trigger a catch-up rescan if mutations occurred.
  if (hintsVisible) {
    pendingMutation = true;
    return;
  }

  if (mutationTimer) clearTimeout(mutationTimer);
  mutationTimer = setTimeout(() => {
    doScan();
  }, 300);
});

observer.observe(document.body || document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['disabled', 'aria-hidden', 'role', 'contenteditable', 'href'],
});

// --- Initial Scan ---

// Scan on load to push initial grammar
doScan();

// Expose for console debugging
(window as any).branchkitShowHints = () => { doScan(); showHints(); };
(window as any).branchkitHideHints = () => hideHints();
(window as any).branchkitScan = () => { doScan(); return store.all; };

console.log('[BranchKit Browser] Loaded. Press f to show hints, or call branchkitShowHints()');
