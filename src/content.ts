/**
 * BranchKit Browser — Content script entry point.
 *
 * Injected per frame. Scans DOM, creates badges, handles keyboard input.
 * Voice commands arrive via background → BRANCHKIT_ACTION messages.
 */

import { Category, BadgeDisplayMode, HintVisibility, ScannedElement, Message, DispatchResult } from './types';
import { LabelAssignment, WORD_TO_LETTER, isAlphabetLoaded, setAlphabet } from './words';
import { scanElements, scanSingle, isHintable, deepQuerySelectorAll } from './scanner';
import { ElementWrapper, WrapperStore } from './element-wrapper';
import * as idRegistry from './registry';
import { resolveTarget } from './activate-resolution';
import { IntersectionTracker } from './intersection-tracker';
import { HintBadge } from './hints';
import { cacheLayout, clearLayoutCache } from './layout-cache';
import { placeBadges, placeOne, clearPlacement } from './placement';
import { activateElement, type ActivationResult } from './event-sequence';
import { accessibleName } from './accessible-name';
import {
  emitActivatePath,
  elementSnap,
  type ActivatePathEvent,
} from './activate-path-log';
import { captureDebugSnapshot } from './debug-snapshot';
import {
  CodewordSnapshot,
  takeSnapshot,
  resolveFromSnapshot,
} from './snapshot';
import { ActionDispatcher, CommandRegistry } from './dispatcher';
import { KeyHandler } from './keyboard';
import { getActiveAdapter, scanWithAdapter } from './adapters/index';
import {
  scroll,
  scrollRegion,
  scrollAtElement,
  snapToElement,
  cycleScrollTarget,
  getCycleTarget,
  resetCycleTarget,
  scrollElement,
  scrollToPercent,
  setKeyHeld,
  setScrollBoundaryCallback,
  type ScrollDirection,
  type ScrollAmount,
  type ScrollRegion,
} from './scroller';
import {
  openFindMode,
  closeFindMode,
  findNext,
  findPrevious,
  findImmediate,
  isFindActive,
  handlePostFindKey,
  setFindCallbacks,
} from './find';
import { saveReference, resolveReference, listReferences } from './references';

// --- State ---

const store = new WrapperStore();
const dispatcher = new ActionDispatcher();
const registry = new CommandRegistry();
const keyHandler = new KeyHandler(registry, dispatcher);
const tracker = new IntersectionTracker(store, {
  onCodewordsChanged: () => {
    schedulePushGrammar();
    if (hintsVisible) badgeNewlyCodeworded();
  },
});

setFindCallbacks({
  onActivate: () => { hideHints(); },
  onDeactivate: () => { resetCycleTarget(); },
});

setScrollBoundaryCallback((boundary) => {
  try {
    chrome.runtime.sendMessage({
      type: 'SCROLL_BOUNDARY',
      boundary,
    } as Message);
  } catch {
    // Extension context may be invalidated
  }
});

let hintsVisible = false;
let activeCategory: Category | null = null;
let displayMode: BadgeDisplayMode = 'letter';
let hintVisibility: HintVisibility = 'always';
let lastGrammarHash = '';
let pendingMutation = false;
let lastActivatedElement: Element | null = null;
const MAX_BADGE_COUNT = 676; // No artificial cap; word pairs for >26

// Pre-phrase snapshot. Captured when the voice plugin signals a verb
// prefix (show_hints_go / show_hints_set / show_hints_tables) so the
// codeword the user speaks resolves to the wrapper they SAW at speech
// start, even if the page has mutated by the time the action arrives.
// See src/snapshot.ts and DESIGN_BROWSER_HINT_ALLOCATOR.md section 3.C.
let phraseSnapshot: CodewordSnapshot | null = null;

// Input element types — used by the "activate" action to decide click vs focus.
const INPUT_TYPES = new Set(['input', 'textarea', 'select', 'contenteditable']);

// --- Display Mode from storage ---

if (typeof chrome !== 'undefined' && chrome.storage?.sync) {
  chrome.storage.sync.get(['badgeDisplayMode', 'hintVisibility'], (result) => {
    if (result.badgeDisplayMode) {
      displayMode = result.badgeDisplayMode;
    }
    if (result.hintVisibility) {
      hintVisibility = result.hintVisibility;
    }
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.badgeDisplayMode) {
      displayMode = changes.badgeDisplayMode.newValue || 'letter';
      if (hintsVisible) {
        updateBadgeLabels();
      }
    }
    if (changes.hintVisibility) {
      hintVisibility = changes.hintVisibility.newValue || 'always';
      if (hintVisibility === 'always' && !hintsVisible) {
        showHints();
      } else if (hintVisibility === 'manual' && hintsVisible) {
        hideHints();
      }
    }
    // BranchKit pushed a new alphabet — adopt it. The pool was wiped
    // server-side by regenerateAllStacks; our wrappers' codewords are
    // stale strings that no longer route. Drop them locally and let the
    // tracker reclaim for every viewport-visible wrapper. (IO won't
    // re-fire on already-intersecting elements, so we have to walk the
    // store ourselves.)
    if (changes.alphabet?.newValue) {
      setAlphabet(changes.alphabet.newValue);
      for (const w of store.all) {
        w.scanned.codeword = '';
        w.label = null;
        if (w.hint) {
          w.hint.remove();
          w.hint = null;
        }
      }
      tracker.refreshViewportClaims();
      if (hintsVisible) {
        // Re-render once the new codewords land.
        tracker.flushNow().then(() => {
          if (hintsVisible) showHints(activeCategory ?? undefined);
        });
      }
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
      if (hintVisibility === 'always') {
        tracker.flushNow().then(() => {
          if (hintVisibility === 'always' && !hintsVisible) showHints();
        });
      }
    }
  });
}

// --- Register Commands (Slice B) ---

registry.add({ keys: 'f', action: 'show_hints' });
registry.add({ keys: 'F', action: 'show_hints_newtab' });
registry.add({ keys: 'Escape', action: 'hide_hints' });

// Scroll commands (Vimium-compatible)
registry.add({ keys: 'j', action: 'scroll_down' });
registry.add({ keys: 'k', action: 'scroll_up' });
registry.add({ keys: 'd', action: 'scroll_half_down' });
registry.add({ keys: 'u', action: 'scroll_half_up' });
registry.add({ keys: 'gg', action: 'scroll_top' });
registry.add({ keys: 'G', action: 'scroll_bottom' });
registry.add({ keys: 'h', action: 'scroll_left' });
registry.add({ keys: 'l', action: 'scroll_right' });

// Cycle scroll target (Surfingkeys-style)
registry.add({ keys: 'cs', action: 'cycle_scroll_target' });

// Find-in-page
registry.add({ keys: '/', action: 'find_open' });
registry.add({ keys: 'n', action: 'find_next' });
registry.add({ keys: 'N', action: 'find_previous' });

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

// --- Scroll action handlers ---

dispatcher.register('scroll_down', () => {
  const ct = getCycleTarget();
  if (ct) scrollElement(ct, 'down', 'step');
  else scroll('down', 'step');
});

dispatcher.register('scroll_up', () => {
  const ct = getCycleTarget();
  if (ct) scrollElement(ct, 'up', 'step');
  else scroll('up', 'step');
});

dispatcher.register('scroll_half_down', () => {
  const ct = getCycleTarget();
  if (ct) scrollElement(ct, 'down', 'half');
  else scroll('down', 'half');
});

dispatcher.register('scroll_half_up', () => {
  const ct = getCycleTarget();
  if (ct) scrollElement(ct, 'up', 'half');
  else scroll('up', 'half');
});

dispatcher.register('scroll_top', () => {
  const ct = getCycleTarget();
  if (ct) scrollElement(ct, 'up', 'top');
  else scroll('up', 'top');
});

dispatcher.register('scroll_bottom', () => {
  const ct = getCycleTarget();
  if (ct) scrollElement(ct, 'down', 'bottom');
  else scroll('down', 'bottom');
});

dispatcher.register('scroll_left', () => {
  const ct = getCycleTarget();
  if (ct) scrollElement(ct, 'left', 'step');
  else scroll('left', 'step');
});

dispatcher.register('scroll_right', () => {
  const ct = getCycleTarget();
  if (ct) scrollElement(ct, 'right', 'step');
  else scroll('right', 'step');
});

dispatcher.register('cycle_scroll_target', () => {
  cycleScrollTarget();
});

// --- Find action handlers ---

dispatcher.register('find_open', () => {
  openFindMode();
});

dispatcher.register('find_close', () => {
  closeFindMode();
});

dispatcher.register('find_next', () => {
  findNext();
});

dispatcher.register('find_previous', () => {
  findPrevious();
});

dispatcher.register('find_immediate', (params) => {
  const query = params.query || '';
  if (query) findImmediate(query);
});

// Voice scroll handler — receives parameterized scroll commands from the plugin
dispatcher.register('scroll', (params) => {
  const direction = (params.direction || 'down') as ScrollDirection;
  const amount = (params.amount || 'step') as ScrollAmount;
  const count = parseInt(params.count || '1', 10) || 1;
  const region = params.region as ScrollRegion | undefined;

  if (region) {
    scrollRegion(region, direction, amount, count);
  } else {
    scroll(direction, amount, count);
  }
});

dispatcher.register('scroll_to_percent', (params) => {
  const pct = parseInt(params.percent || '50', 10);
  scrollToPercent(pct);
});

dispatcher.register('scroll_to_element', (params) => {
  const position = (params.position || 'top') as 'top' | 'center' | 'bottom';
  const selector = params.selector;
  if (selector) {
    const el = document.querySelector(selector);
    if (el) snapToElement(el, position);
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

keyHandler.setFilterCallback((prefix: string, byText: boolean) => {
  if (!hintsVisible) return;

  if (prefix === '') {
    for (const w of store.all) {
      w.hint?.setFiltered(false);
      w.hint?.setTextMatch(false);
      w.hint?.setMatchedChars(0);
    }
    return;
  }

  if (byText) {
    const textResults = store.matchingText(prefix);
    const textMatches = new Set(textResults.map(r => r.wrapper));

    for (const w of store.all) {
      const isMatch = textMatches.has(w);
      w.hint?.setFiltered(!isMatch);
      w.hint?.setTextMatch(isMatch);
    }

    if (textMatches.size === 1) {
      const winner = textMatches.values().next().value!;
      activateWrapper(winner);
      hideHints();
      keyHandler.exitHintMode();
    }
  } else {
    const matchSet = new Set(store.matchingLetterPrefix(prefix));
    for (const w of store.all) {
      const isMatch = matchSet.has(w);
      w.hint?.setFiltered(!isMatch);
      w.hint?.setTextMatch(false);
      if (isMatch) {
        w.hint?.setMatchedChars(prefix.length);
      }
    }

    if (matchSet.size === 1) {
      const first = matchSet.values().next().value!;
      activateWrapper(first);
      hideHints();
      keyHandler.exitHintMode();
    }
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

/**
 * ResizeObserver acts as a safety net for CSS-driven visibility changes
 * the MutationObserver can't see. The MO's attribute filter watches
 * `disabled`, `aria-hidden`, `role`, `contenteditable`, `href` — a
 * `display:none` toggle (via class change or inline `style`) flies past
 * it. When an element's bounding rect collapses to zero, RO fires; we
 * re-evaluate hintability and detach if it's no longer hintable.
 *
 * One-directional: detects hintable → non-hintable, but can't catch the
 * reverse (an element going from `display:none` to visible) since RO
 * only observes elements we already know about. The forward-direction
 * case is the one that matters for pool hygiene — keeping codewords
 * attached to invisible elements would leak the budget.
 */
const resizeObserver = new ResizeObserver((entries) => {
  let dirty = false;
  for (const entry of entries) {
    const el = entry.target;
    if (!store.findWrapperFor(el)) continue;
    if (!isHintable(el)) {
      detachWrapper(el);
      dirty = true;
    }
  }
  if (dirty) schedulePushGrammar();
});

/**
 * Add a wrapper to the store and start tracking its viewport state. The
 * tracker claims a codeword for it the next time IntersectionObserver
 * fires for the element (or immediately, if the element is already in
 * the viewport when observed). ResizeObserver also begins watching for
 * CSS-driven hintability changes.
 *
 * Idempotent: store.addWrapper is a no-op if a wrapper for the same
 * element already exists; IntersectionObserver.observe is similarly
 * tolerant of duplicate observe calls.
 */
function attachWrapper(wrapper: ElementWrapper): void {
  // Mint the registry id first. A rejected registration (id=0) means the
  // fingerprint validator couldn't disambiguate this element from another
  // already in the registry — voice can't safely address it, so don't add
  // it to the store or start observers. Quill's empty editor div sibling
  // is the canonical case: same role/name/tag as the toolbar div, no
  // distinguisher.
  const id = idRegistry.register(wrapper);
  if (id === 0) return;
  store.addWrapper(wrapper);
  tracker.observe(wrapper.element);
  resizeObserver.observe(wrapper.element);
}

/**
 * Remove the wrapper for an element. Returns its codeword (if any) to
 * the pool and unobserves both observers.
 */
function detachWrapper(element: Element): void {
  resizeObserver.unobserve(element);
  tracker.unobserve(element);
  const removed = store.removeWrapperByElement(element);
  if (removed && removed.scanned.id > 0) {
    idRegistry.unregister(removed.scanned.id);
  }
}

/**
 * Body-level safety net for badges that get yanked by hostile page
 * scripts. Some sites (Baidu, occasional Google products) enumerate
 * body and remove "unknown" nodes; without this rescue, our badges
 * would silently disappear and voice/keyboard activation would still
 * try to operate on them.
 *
 * Distinguishing intentional vs. page-driven removal: by the time this
 * MO fires, intentional removals have already cleared `wrapper.hint`
 * (HintBadge.remove → wrapper.hint = null in the calling code). If
 * `store.all.find` still claims a wrapper that owns the removed host,
 * the removal was page-driven. Re-append.
 *
 * Body-only childList observation is intentionally narrow: every body
 * mutation fires this MO, but each callback's work is bounded by the
 * removedNodes count and a one-pass store walk per matched host.
 */
const badgeReattachObserver = new MutationObserver((records) => {
  for (const r of records) {
    if (r.type !== 'childList' || r.removedNodes.length === 0) continue;
    for (const removed of r.removedNodes) {
      if (!(removed instanceof HTMLElement)) continue;
      if (!removed.hasAttribute('data-branchkit-hint')) continue;
      const wrapper = store.all.find(w => w.hint?.host === removed);
      if (!wrapper?.hint) continue;
      wrapper.hint.reattach();
      wrapper.hint.reposition();
    }
  }
});

function startBadgeReattachObserver(): void {
  const target = document.body || document.documentElement;
  if (target) badgeReattachObserver.observe(target, { childList: true, subtree: true });
}

/**
 * Full re-discovery of hintable elements in the document. Idempotent:
 * already-known elements keep their wrappers (and codewords); newly
 * discovered elements get fresh wrappers; elements no longer in the DOM
 * are dropped.
 *
 * doScan no longer claims codewords directly — that's the tracker's
 * job, gated by viewport intersection. doScan only ensures every
 * hintable element has a wrapper that the tracker is observing.
 */
function doScan(): void {
  const adapter = getActiveAdapter(window.location.href);
  const result = adapter ? scanWithAdapter(adapter) : scanElements();

  for (let i = 0; i < result.elements.length; i++) {
    if (store.findWrapperFor(result.refs[i])) continue;
    attachWrapper(new ElementWrapper(result.refs[i], result.elements[i]));
  }
  dropDisconnectedWrappers();
}

async function showHints(filter?: Category | Category[]): Promise<void> {
  if (!isAlphabetLoaded()) {
    console.warn('[BranchKit Browser] Hints unavailable: alphabet not loaded. Is BranchKit running?');
    return;
  }

  // Wait one frame so any pending IntersectionObserver entries (queued
  // synchronously by observe(), delivered async) have a chance to fire,
  // then drain pending claims/releases. Without this, a `f` keypress
  // immediately after page load can race the tracker — wrappers exist
  // but their codewords haven't been claimed yet and badges would
  // render with no labels.
  await new Promise(r => requestAnimationFrame(() => r(null)));
  await tracker.flushNow();

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

  cacheLayout(renderable.map(w => w.element));

  for (const wrapper of renderable) {
    const label = poolLabelToAssignment(wrapper.scanned.codeword);
    wrapper.label = label;

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

  placeBadges(renderable);

  clearLayoutCache();
  hintsVisible = true;
}

// Reset narrowing/interaction state on existing hint badges without
// removing them from the DOM. Used after an action completes when we want
// to keep badges visible (always-mode activate) but clear visual highlights
// from prefix narrowing or keyboard filter typing, and exit interaction
// modes (keyboard hint mode, new-tab flag) so the next utterance starts
// fresh. Safe to call when no badges are showing — the per-wrapper calls
// are no-ops on hidden hints.
//
// Does NOT reset matched-chars on badges. That state represents "user
// matched the prefix X" — we want it preserved during the activation
// flash so the user sees the narrowed text (e.g., "a check") while the
// badge flashes yellow, not the displayMode default ("arch c"). The
// scheduled hint refresh (after the flash completes) re-renders all
// badges via updateLabel, which resets the text naturally.
function clearHintFilter(): void {
  activateInNewTab = false;
  keyHandler.exitHintMode();
  for (const w of store.all) {
    w.hint?.setFiltered(false);
    w.hint?.setTextMatch(false);
  }
}

function hideHints(): void {
  clearHintFilter();
  hintsVisible = false;
  activeCategory = null;
  clearPlacement();
  for (const w of store.all) {
    w.hint?.hideLeader();
    w.hint?.hide();
  }

  // Catch up on DOM changes that occurred while hints were visible
  if (pendingMutation) {
    pendingMutation = false;
    setTimeout(() => doScan(), 100);
  }
}

// Re-scan and re-render hint badges after a short delay. Used after
// always-mode activation so post-activate DOM mutations (modal open, form
// expansion, autocomplete) are reflected. Idempotent re-call is coalesced:
// if a refresh is already scheduled, drop the new request — the existing
// one will pick up whatever changed by the time it fires.
//
// Delay must exceed the activation flash duration (400ms in hints.ts) so
// the refresh's updateLabel — which resets badge text to the displayMode
// default — runs AFTER the yellow flash completes. Otherwise the
// activated badge's narrowed text ("a check") would visibly snap back to
// "arch c" mid-flash.
let hintRefreshScheduled = false;
const HINT_REFRESH_DELAY_MS = 450;

function scheduleHintRefresh(): void {
  if (hintRefreshScheduled) return;
  hintRefreshScheduled = true;
  setTimeout(() => {
    hintRefreshScheduled = false;
    if (hintVisibility !== 'always') return;
    doScan();
    showHints();
  }, HINT_REFRESH_DELAY_MS);
}

function badgeNewlyCodeworded(): void {
  const newBadges: ElementWrapper[] = [];
  for (const w of store.all) {
    if (w.scanned.codeword && !w.hint && w.isInViewport) {
      if (activeCategory && w.category !== activeCategory) continue;
      newBadges.push(w);
    }
  }
  if (newBadges.length === 0) return;

  const existingCount = store.all.filter(w => w.hint?.isVisible).length;

  cacheLayout(newBadges.map(w => w.element));
  for (let i = 0; i < newBadges.length; i++) {
    const w = newBadges[i];
    const label = poolLabelToAssignment(w.scanned.codeword);
    w.label = label;
    w.hint = new HintBadge(w.element, label, w.category, displayMode);
    w.hint.show();
    placeOne(w, existingCount + i);
  }
  clearLayoutCache();
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
  lastActivatedElement = el;

  // Visibility handoff: same rules as the SSE activate path above. In
  // always-mode we clear narrowing/keyboard state and schedule a refresh;
  // in manual-mode we fully hide so the user can re-summon explicitly.
  if (hintVisibility === 'always') {
    clearHintFilter();
    scheduleHintRefresh();
  } else {
    hideHints();
  }

  wrapper.hint?.flash();
  if (wrapper.category === 'input') {
    el.focus();
  } else {
    activateElement(el, { newTab: openNewTab });
  }
}

// --- Grammar Push (Slice C) ---

/**
 * Push grammar to background for BranchKit voice commands.
 *
 * All elements are pushed in viewport order — the Go plugin builds one
 * unified collection covering all element types.
 */
function pushGrammar(): void {
  const elements: ScannedElement[] = viewportSort(store.all).map(w => w.scanned);

  // Hash-based deduplication. Includes codeword so an alphabet regen that
  // produces the same elements but different codewords still re-pushes —
  // otherwise the voice plugin would keep using stale codewords.
  const hash = elements.map(e => `${e.id}|${e.category}|${e.codeword}`).join('\x1f');
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

// --- bfcache restore ---
//
// When the user navigates back/forward and Chrome restores the page from
// its back-forward cache, the content script is NOT re-injected — the
// existing V8 context is reactivated. Meanwhile, navigation away triggered
// the background's purgeTab on status=loading, wiping tabGrammars; and any
// last-gasp empty SCAN_RESULT from the outgoing page caused the plugin's
// empty-elements handler to clear commands. After restore, the plugin
// holds empty grammar and voice can't match anything.
//
// `pageshow` with persisted=true is the canonical bfcache-restore signal.
// On restore, clear the dedup hash and push the current store's grammar so
// the plugin re-registers commands for this page's elements. Fresh page
// loads also fire pageshow but with persisted=false — those are handled by
// the normal init flow; we skip them here to avoid double-scanning.
window.addEventListener('pageshow', (e) => {
  if (!e.persisted) return;
  // Registry survives bfcache (V8 context is preserved) but its entries
  // are stale — the plugin's grammar was wiped by purgeTab on navigate-
  // away, and we want fresh ids on the next push. doScan alone won't
  // re-register surviving wrappers because findWrapperFor short-circuits
  // for elements still in the store, so we have to walk the store and
  // re-register each one ourselves. Codewords + pool claims survive
  // bfcache (the pool is in chrome.storage.session), so re-registering
  // in place avoids churning RELEASE_LABELS through the pool.
  idRegistry.clear();
  lastGrammarHash = '';
  for (const w of [...store.all]) {
    if (!w.element.isConnected) {
      detachWrapper(w.element);
      continue;
    }
    const id = idRegistry.register(w);
    if (id === 0) {
      // Element no longer voice-addressable (collision with a sibling
      // we couldn't disambiguate). Drop it; its codeword goes back to
      // the pool via detachWrapper's release path.
      detachWrapper(w.element);
    }
  }
  doScan();
  pushGrammar();
});

// --- Frame liveness Port ---
//
// One long-lived Port per content-script V8 context. We send no messages —
// the Port's *lifetime* is the signal. When this context dies (iframe
// removed, navigation, tab closed) Chrome closes the Port and the
// background's onDisconnect handler releases this frame's labels and
// clears its tabGrammars entry. See
// docs/completed/DESIGN_BROWSER_FRAME_POOL_EXHAUSTION.md.
//
// The content-side onDisconnect handler below fires only when the SW
// restarts (idle-terminated), not when this frame dies. On SW restart we
// reopen a Port so the background can re-track us; we don't re-claim
// labels because our existing claims survive in chrome.storage.session.

const LIVENESS_PORT_NAME = 'frame-liveness';
let livenessPort: chrome.runtime.Port | null = null;
// Our own frameId, as told to us by the SW on connect. Used to detect
// misrouted activate actions (registry id minted in a different frame).
// null until the Port handshake completes; the activate path treats
// "unknown" as "trust the routing" so dispatches that arrive before the
// handshake aren't dropped.
let myFrameId: number | null = null;

function openLivenessPort(): void {
  try {
    const port = chrome.runtime.connect({ name: LIVENESS_PORT_NAME });
    livenessPort = port;
    port.onMessage.addListener((msg: unknown) => {
      if (typeof msg !== 'object' || msg === null) return;
      const m = msg as { type?: unknown; frameId?: unknown };
      if (m.type === 'FRAME_ID' && typeof m.frameId === 'number') {
        myFrameId = m.frameId;
      }
    });
    port.onDisconnect.addListener(() => {
      livenessPort = null;
      // Brief delay so the SW finishes its init pass before we
      // re-announce ourselves.
      setTimeout(openLivenessPort, 500);
    });
  } catch {
    // Extension context invalidated (e.g., extension reloaded mid-page).
    // Page reload required to recover; nothing useful to do here.
    livenessPort = null;
  }
}

openLivenessPort();

// --- Dispatch result reporting ---
//
// After every BRANCHKIT_ACTION the content script attempted, send the
// outcome to the background script, which forwards it to the plugin's
// POST /dispatch-result endpoint. The plugin logs it so the actuator.log
// carries end-to-end visibility from voice transcript through element
// activation. Failures are swallowed — observability shouldn't break the
// user-facing flow.

function reportDispatchResult(result: DispatchResult): void {
  try {
    chrome.runtime.sendMessage({
      type: 'DISPATCH_RESULT',
      payload: result,
    } as Message);
  } catch {
    // Extension context invalidated; nothing useful to do.
  }
}

// --- BK_ACTIVATE_PATH diagnostic ---
//
// Every browser.activate dispatch emits one PLUGIN_DEBUG_LOG line tagged
// BK_ACTIVATE_PATH so wrong-element-clicked bugs can be diagnosed from
// the per-plugin log file (plugin-logs/browser.log) alone. Buffer + types
// + emit machinery live in activate-path-log.ts so the Phase 2 debug
// snapshot can read the buffer too (Q7). See
// docs/completed/DESIGN_HINT_DIAGNOSTICS.md §1 + Q7 and
// docs/completed/DESIGN_PLUGIN_LOGGING.md §4.

/**
 * Ask the background to POST /commands/invalidate on the plugin. Fires
 * when the activate path receives an id we don't know — the plugin's
 * cached "I already pushed commands" memory is lying after SW restart,
 * page reload mid-debounce, or content-script remount. Without this,
 * the plugin keeps dispatching dead ids until the user reloads the tab.
 */
function requestCommandsInvalidate(reason: string): void {
  try {
    chrome.runtime.sendMessage({
      type: 'INVALIDATE_COMMANDS',
      reason,
    } as Message);
  } catch {
    // Extension context invalidated; recovery happens on next reload.
  }
}

// Truncate the frame URL for log readability. Includes path but not query
// strings (which often carry session data). Capped to 200 chars.
function trimFrameUrl(href: string): string {
  try {
    const u = new URL(href);
    const out = `${u.origin}${u.pathname}`;
    return out.length > 200 ? out.slice(0, 200) + '…' : out;
  } catch {
    return href.slice(0, 200);
  }
}

// --- Message Listener (from background / voice) ---

chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
  if (message.type === 'GET_FOCUS_STATUS') {
    sendResponse({ focused: windowHasFocus });
    return false;
  }

  if (message.type === 'BRANCHKIT_ACTION') {
    const { action, params } = message.payload;
    console.log('[BranchKit Content] action received:', action, params);

    if (action === 'show_hints') {
      phraseSnapshot = takeSnapshot(store.all, performance.now());
      doScan();
      showHints();
    } else if (action === 'hide_hints') {
      hideHints();
    } else if (action === 'rescan') {
      lastGrammarHash = '';
      doScan();
    } else if (action === 'set_badge_mode' && params?.mode) {
      chrome.storage.sync.set({ badgeDisplayMode: params.mode });
    } else if (action === 'scroll' || action === 'scroll_to_element' || action === 'scroll_to_percent') {
      dispatcher.dispatch(action, params);
    } else if (action === 'find_open' || action === 'find_close' || action === 'find_next' || action === 'find_previous' || action === 'find_immediate') {
      dispatcher.dispatch(action, params);
    } else if (action === 'activate') {
      // Three-tier resolution (see docs/completed/DESIGN_ELEMENT_IDENTITY_REGISTRY.md §6).
      // Algorithm lives in activate-resolution.ts so it's unit-testable.
      const codeword = params?.codeword ?? '';
      const idParam = parseInt(params?.id ?? '0', 10);
      const frameIdParam = parseInt(params?.frame_id ?? '0', 10);

      const resolved = resolveTarget(
        idParam, frameIdParam, codeword,
        {
          myFrameId,
          registry: {
            get: idRegistry.get,
            rebindRef: idRegistry.rebindRef,
            unregister: idRegistry.unregister,
            fingerprintFallback: idRegistry.fingerprintFallback,
            fingerprintToString: idRegistry.fingerprintToString,
          },
          candidates: () => deepQuerySelectorAll(document, '*'),
          resolveFromSnapshot: (cw) => resolveFromSnapshot(phraseSnapshot, cw, performance.now()),
          resolveFromStore: (cw) => {
            const words = cw.split(/\s+/).filter(w => w.length > 0);
            return words.length === 2
              ? store.byLabelPair(words[0], words[1])
              : (words.length === 1 ? store.byLabel(words[0]) : undefined);
          },
          onStaleId: requestCommandsInvalidate,
        },
      );
      const { target, resolution, fp } = resolved;
      let detail = resolved.detail;

      let taken: DispatchResult['taken'] = 'skipped';
      let elemTag = '';

      if (target instanceof HTMLElement) {
        elemTag = target.tagName.toLowerCase();
        lastActivatedElement = target;
        // Visibility handoff after activation:
        //  - Always-mode: keep badges visible so the user can immediately
        //    voice-trigger the next action. Just clear narrowing/keyboard
        //    state, then schedule a doScan + showHints after a short delay
        //    so post-activate DOM changes (modal open, form expansion,
        //    autocomplete dropdown) get reflected in the next badge set.
        //  - Manual-mode: full hide. Activate is the "I'm done" gesture;
        //    user re-summons via "show" or the f keybind.
        if (hintVisibility === 'always') {
          clearHintFilter();
          scheduleHintRefresh();
        } else {
          hideHints();
        }
        // Branch on the live element's tag, not the voice plugin's elem_type
        // hint. elem_type was captured at grammar-push time and can become
        // stale (DOM mutation between scan and action arrival); the live tag
        // is what's actually there now. Same pattern as resolve_reference
        // below. Borrowed from Rango — element type decisions always come
        // from the live DOM reference, never from the action payload.
        store.findWrapperFor(target)?.hint?.flash();
        let clickedEl: Element = target;
        let delegation: ActivatePathEvent['delegation'] = 'noop';
        if (INPUT_TYPES.has(elemTag)) {
          target.focus();
          taken = 'focus';
          delegation = 'focus-input';
        } else {
          const result = activateElement(target);
          clickedEl = result.target;
          delegation = result.delegation;
          taken = 'click';
        }
        emitActivatePath({
          ts: performance.now(),
          url: trimFrameUrl(window.location.href),
          wrapperId: idParam,
          codeword,
          resolution,
          fingerprint: idParam > 0 ? idRegistry.get(idParam)?.fingerprint ?? null : null,
          resolved: elementSnap(target),
          clicked: elementSnap(clickedEl),
          delegation,
        });
      } else if (target) {
        elemTag = (target as Element).tagName.toLowerCase();
        detail = 'target is not HTMLElement';
        emitActivatePath({
          ts: performance.now(),
          url: trimFrameUrl(window.location.href),
          wrapperId: idParam,
          codeword,
          resolution,
          fingerprint: idParam > 0 ? idRegistry.get(idParam)?.fingerprint ?? null : null,
          resolved: elementSnap(target),
          clicked: null,
          delegation: 'noop',
        });
      } else {
        emitActivatePath({
          ts: performance.now(),
          url: trimFrameUrl(window.location.href),
          wrapperId: idParam,
          codeword,
          resolution,
          fingerprint: idParam > 0 ? idRegistry.get(idParam)?.fingerprint ?? null : null,
          resolved: null,
          clicked: null,
          delegation: 'noop',
        });
      }

      reportDispatchResult({
        action, codeword, resolution, elem_tag: elemTag, taken,
        ok: taken === 'focus' || taken === 'click',
        frame: trimFrameUrl(window.location.href),
        detail,
        fp,
      });
    } else if (action === 'noop') {
      const prefix = params?.prefix;
      if (prefix) {
        const letter = WORD_TO_LETTER[prefix];
        if (letter) {
          if (!hintsVisible) showHints();
          const matchSet = new Set(store.matchingLetterPrefix(letter));
          for (const w of store.all) {
            const isMatch = matchSet.has(w);
            w.hint?.setFiltered(!isMatch);
            w.hint?.setTextMatch(false);
            if (isMatch) {
              w.hint?.setMatchedChars(1);
            }
          }
        }
      } else {
        // No prefix — reset all hints to default (cancel pair state)
        for (const w of store.all) {
          w.hint?.setFiltered(false);
          w.hint?.setTextMatch(false);
          w.hint?.setMatchedChars(0);
        }
      }
    } else if (action === 'name_reference') {
      const refName = params?.name?.toLowerCase().trim();
      if (!refName) return;
      if (!lastActivatedElement || !lastActivatedElement.isConnected) {
        console.warn('[BranchKit Content] name_reference: no last-activated element');
        return;
      }
      saveReference(refName, lastActivatedElement).then(async () => {
        console.log('[BranchKit Content] reference saved:', refName);
        const refs = await listReferences();
        const ref = refs[refName];
        try {
          chrome.runtime.sendMessage({
            type: 'REFERENCE_SAVED',
            host: window.location.hostname,
            name: refName,
            reference: ref as unknown as Record<string, unknown>,
          } as Message);
          chrome.runtime.sendMessage({ type: 'REFERENCE_NAMES_CHANGED' } as Message);
        } catch { /* context invalidated */ }
      });
    } else if (action === 'resolve_reference') {
      const refName = params?.name?.toLowerCase().trim();
      if (!refName) return;
      resolveReference(refName).then(el => {
        if (!el) {
          console.warn('[BranchKit Content] resolve_reference: not found:', refName);
          return;
        }
        lastActivatedElement = el;
        if (el instanceof HTMLElement) {
          store.findWrapperFor(el)?.hint?.flash();
          if (INPUT_TYPES.has(el.tagName.toLowerCase())) {
            el.focus();
          } else {
            activateElement(el);
          }
        }
      });
    }
  } else if (message.type === 'SHOW_HINTS') {
    doScan();
    showHints(message.category);
  } else if (message.type === 'HIDE_HINTS') {
    hideHints();
  }
});

// --- Resize Listener ---
// Badges live in their target's scroll ancestor, so scroll is handled by the
// compositor. Only window resize requires JS repositioning.

let resizeRafPending = false;
function onResize(): void {
  if (!hintsVisible || resizeRafPending) return;
  resizeRafPending = true;
  requestAnimationFrame(() => {
    resizeRafPending = false;
    const visible = store.all.filter(w => w.hint?.isVisible);
    if (visible.length > 0) {
      cacheLayout(visible.map(w => w.element));
      placeBadges(visible);
      clearLayoutCache();
    }
  });
}
window.addEventListener('resize', onResize, { passive: true });

// --- Keyboard Listener ---

const scrollKeys = new Set(['j', 'k', 'd', 'u', 'h', 'l']);
const heldKeys = new Set<string>();

document.addEventListener('keydown', (e: KeyboardEvent) => {
  if (handlePostFindKey(e)) return;

  // Ctrl+Alt+D — hint-diagnostics snapshot trigger (Phase 2b of
  // docs/completed/DESIGN_HINT_DIAGNOSTICS.md). Q1 of that doc rejected
  // a voice trigger because debug needs to work *when voice is broken*;
  // Ctrl+Alt+D is the documented default.
  if (e.ctrlKey && e.altKey && (e.key === 'd' || e.key === 'D') && !e.repeat) {
    e.preventDefault();
    e.stopPropagation();
    // Pre-press breadcrumb. Lands in plugin-logs/browser.log via the
    // standard per-plugin debug channel before any of the snapshot SW
    // work begins, so users grepping for "I pressed it" see the press
    // even when the snapshot chain fails downstream (no captureVisibleTab
    // permission, plugin endpoint unreachable, etc.).
    const url = trimFrameUrl(window.location.href);
    chrome.runtime.sendMessage({
      type: 'PLUGIN_DEBUG_LOG',
      tag: 'BK_SNAPSHOT_REQUESTED',
      data: { url, ts: performance.now() },
      level: 'info',
    });
    captureDebugSnapshot(store, url);
    return;
  }

  if (scrollKeys.has(e.key) && !e.repeat && !heldKeys.has(e.key)) {
    heldKeys.add(e.key);
    setKeyHeld(true);
  }
  keyHandler.handleKeyDown(e);
}, true);

document.addEventListener('keyup', (e: KeyboardEvent) => {
  if (heldKeys.has(e.key)) {
    heldKeys.delete(e.key);
    setKeyHeld(false);
  }
}, true);

// --- MutationObserver (discovery-only) ---
//
// The observer surgically reflects DOM changes into the wrapper store:
// new subtrees gain wrappers (the IntersectionTracker claims pool
// codewords on viewport entry), removed subtrees lose theirs, attribute
// changes flip elements in and out of hintability. Grammar push is
// debounced after a batch settles so voice sees a consistent snapshot.
//
// Beyond the HUGE_MUTATIONS_COUNT threshold (DarkReader's pattern), we
// stop processing nodes individually and just queue a coarse refresh.
// Slack and Linear regularly trip 1000+ mutations per scroll event.

const HUGE_MUTATIONS_COUNT = 1000;
const HUGE_MUTATION_IDLE_MS = 50;
const GRAMMAR_PUSH_DEBOUNCE_MS = 120;

let pushTimer: ReturnType<typeof setTimeout> | null = null;
let hugeMutationTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePushGrammar(): void {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    pushGrammar();
  }, GRAMMAR_PUSH_DEBOUNCE_MS);
}

function isOwnMutation(n: Node): boolean {
  return n instanceof HTMLElement && n.hasAttribute('data-branchkit-hint');
}

/** Walk an added subtree and create wrappers for any hintable descendants. */
function discoverInSubtree(root: Element): number {
  let added = 0;
  const { elements, refs } = scanElements(root);
  for (let i = 0; i < elements.length; i++) {
    if (store.findWrapperFor(refs[i])) continue;
    attachWrapper(new ElementWrapper(refs[i], elements[i]));
    added++;
  }
  // New custom-element instances inside this subtree may not be
  // upgraded yet. Watch their tags so when whenDefined resolves we
  // re-discover the (now-shadow-bearing) instances.
  watchUndefinedCustomElements(root);
  return added;
}

/**
 * Drop wrappers whose element has been disconnected from the DOM.
 * Cheaper than diffing removedNodes subtrees individually — we just
 * sweep the (small) store and check `.isConnected`.
 */
function dropDisconnectedWrappers(): number {
  let removed = 0;
  // Iterate a copy so we can mutate `store` mid-loop.
  for (const w of [...store.all]) {
    if (!w.element.isConnected) {
      detachWrapper(w.element);
      removed++;
    }
  }
  return removed;
}

/**
 * Recompute hintability for an element whose attributes changed. Adds,
 * removes, or refreshes its wrapper as needed. Returns true if the store
 * was modified.
 */
function reevaluateAttribute(target: Element): boolean {
  const existing = store.findWrapperFor(target);
  const hintable = isHintable(target);
  if (existing && !hintable) {
    detachWrapper(target);
    return true;
  }
  if (!existing && hintable) {
    const scanned = scanSingle(target);
    if (!scanned) return false;
    attachWrapper(new ElementWrapper(target, scanned));
    return true;
  }
  if (existing && hintable) {
    // Refresh scanned metadata (label/category). Preserve registry id
    // and codeword; recompute the fingerprint so a renamed aria-label
    // doesn't leave the dead-ref fallback unable to find this element.
    const refreshed = scanSingle(target);
    if (refreshed) {
      refreshed.codeword = existing.scanned.codeword;
      refreshed.id = existing.scanned.id;
      existing.scanned = refreshed;
    }
    if (existing.scanned.id > 0) {
      idRegistry.refreshFingerprint(existing.scanned.id, target);
    }
    return true;
  }
  return false;
}

function processMutations(records: MutationRecord[]): void {
  let dirty = false;
  let sawRemoval = false;

  for (const m of records) {
    if (m.type === 'childList') {
      for (const node of m.addedNodes) {
        if (isOwnMutation(node)) continue;
        if (node instanceof Element) {
          if (discoverInSubtree(node) > 0) dirty = true;
        }
      }
      for (const node of m.removedNodes) {
        if (isOwnMutation(node)) continue;
        if (node instanceof Element) {
          sawRemoval = true;
        }
      }
    } else if (m.type === 'attributes') {
      const target = m.target;
      if (target instanceof Element && !isOwnMutation(target)) {
        if (reevaluateAttribute(target)) dirty = true;
      }
    }
  }

  // Removals are handled in bulk: the moved/removed subtree's descendants
  // would be tedious to diff one by one, but `.isConnected` answers it
  // for free.
  if (sawRemoval && dropDisconnectedWrappers() > 0) dirty = true;

  if (dirty) schedulePushGrammar();
}

const observer = new MutationObserver((records) => {
  // Hints are visible — behavior depends on visibility mode.
  // In "manual" mode, defer mutations so codewords don't shuffle while
  // the user is reading badges. hideHints() flushes via doScan().
  // In "always" mode, process mutations incrementally so SPA navigation
  // and dynamic content get badges without requiring escape+re-show.
  if (hintsVisible && hintVisibility === 'manual') {
    pendingMutation = true;
    return;
  }

  // Filter our own mutations early so the threshold isn't tripped by
  // badge mount/unmount churn.
  const foreign = records.filter(m => {
    if (m.type === 'childList') {
      const allOwnAdded = Array.from(m.addedNodes).every(isOwnMutation);
      const allOwnRemoved = Array.from(m.removedNodes).every(isOwnMutation);
      return !(allOwnAdded && allOwnRemoved);
    }
    return !isOwnMutation(m.target);
  });
  if (foreign.length === 0) return;

  if (foreign.length >= HUGE_MUTATIONS_COUNT) {
    // Mutation storm (Slack message virtualization, Linear list churn).
    // Skip per-record work; coalesce into a coarse sweep once the storm
    // subsides. We still pick up adds/removes via dropDisconnectedWrappers
    // and a fresh document scan, but without iterating every record.
    if (hugeMutationTimer) clearTimeout(hugeMutationTimer);
    hugeMutationTimer = setTimeout(() => {
      hugeMutationTimer = null;
      const removed = dropDisconnectedWrappers();
      const added = discoverInSubtree(document.body || document.documentElement);
      if (removed > 0 || added > 0) schedulePushGrammar();
    }, HUGE_MUTATION_IDLE_MS);
    return;
  }

  processMutations(foreign);
});

observer.observe(document.body || document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  // Watch attributes that flip hintability AND those that feed the
  // fingerprint. Without aria-label/title/type in the filter, a button
  // renamed from "Save" to "Save changes" would still register against
  // its stale fingerprint and the WeakRef-dead-fingerprint-fallback
  // path could never recover it.
  attributeFilter: [
    'disabled', 'aria-hidden', 'role', 'contenteditable', 'href',
    'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-roledescription',
    'title', 'type',
  ],
});

startBadgeReattachObserver();

// --- Dynamic shadow detection ---
//
// Static deepQuerySelectorAll only sees shadow roots that exist at scan
// time. Sites that lazy-mount custom elements (GitHub PR review threads,
// modern Slack, ChatGPT message list) attach shadow roots after first
// paint — without observing those events, their interactive surfaces
// stay invisible to the hint system.
//
// Two layers, per `notes/DESIGN_BROWSER_FRAMES_AND_OBSERVERS.md` section 3:
//
//   1. attachShadow MAIN-world wrapper (in `bootstrap.ts`) dispatches a
//      bubbling, composed CustomEvent before the native call. The
//      listener below queues a microtask so we read `.shadowRoot` after
//      the native attach has completed, then discoverInSubtree walks
//      the new shadow content.
//
//   2. customElements.whenDefined for tags we've seen in :not(:defined)
//      state. When a tag is upgraded, every instance with that tag may
//      gain a shadow root; re-discover them. We track tags (not
//      elements) to avoid duplicate watchers.
//
// Layer 3 (HUGE_MUTATIONS_COUNT short-circuit) is already wired into
// the global MutationObserver above.

// Must match the string in `src/bootstrap.ts`. The two scripts live in
// different worlds (MAIN vs ISOLATED) and bundle independently, so the
// constant can't be shared via import.
const SHADOW_EVENT = '__branchkit__shadow_attached';

document.addEventListener(SHADOW_EVENT, (event) => {
  const host = event.target;
  if (!(host instanceof Element)) return;
  // The bootstrap fires the event *before* the native attach — the
  // shadow root isn't there yet. Defer one microtask so .shadowRoot
  // reflects post-attach state.
  queueMicrotask(() => {
    if (host.shadowRoot) {
      const added = discoverInSubtree(host);
      if (added > 0) schedulePushGrammar();
    }
  });
}, true);

const watchedUndefinedTags = new Set<string>();

function watchUndefinedCustomElements(root: Element | Document): void {
  if (!customElements) return;
  // :not(:defined) only matches custom elements (hyphenated tags) that
  // haven't been registered yet. Plain HTML tags are always "defined."
  let undefinedEls: NodeListOf<Element>;
  try {
    undefinedEls = root.querySelectorAll(':not(:defined)');
  } catch {
    return;
  }
  for (const el of undefinedEls) {
    const tag = el.tagName.toLowerCase();
    if (!tag.includes('-')) continue;
    if (watchedUndefinedTags.has(tag)) continue;
    watchedUndefinedTags.add(tag);
    customElements.whenDefined(tag).then(() => {
      let dirty = false;
      for (const instance of document.querySelectorAll(tag)) {
        if (discoverInSubtree(instance) > 0) dirty = true;
      }
      if (dirty) schedulePushGrammar();
    }).catch(() => {/* whenDefined rejects on invalid tag names */});
  }
}

// --- Initial Scan ---

// Scan on load to push initial grammar
doScan();
watchUndefinedCustomElements(document);

// Expose for console debugging
(window as any).branchkitShowHints = () => { doScan(); showHints(); };
(window as any).branchkitHideHints = () => hideHints();
(window as any).branchkitScan = () => { doScan(); return store.all; };

console.log('[BranchKit Browser] Loaded. Press f to show hints, or call branchkitShowHints()');
