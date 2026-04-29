/**
 * BranchKit Browser — Content script entry point.
 *
 * Injected per frame. Scans DOM, creates badges, handles keyboard input.
 * Voice commands arrive via background → BRANCHKIT_ACTION messages.
 */

import { Category, BadgeDisplayMode, ScannedElement, Message } from './types';
import { LabelAssignment, WORD_TO_LETTER, isAlphabetLoaded, setAlphabet } from './words';
import { scanElements, scanSingle, isHintable } from './scanner';
import { ElementWrapper, WrapperStore } from './element-wrapper';
import { IntersectionTracker } from './intersection-tracker';
import { HintBadge } from './hints';
import { ActionDispatcher, CommandRegistry } from './dispatcher';
import { KeyHandler } from './keyboard';
import { getActiveAdapter, scanWithAdapter } from './adapters/index';

// --- State ---

const store = new WrapperStore();
const dispatcher = new ActionDispatcher();
const registry = new CommandRegistry();
const keyHandler = new KeyHandler(registry, dispatcher);
const tracker = new IntersectionTracker(store, {
  onCodewordsChanged: () => schedulePushGrammar(),
});

let hintsVisible = false;
let activeCategory: Category | null = null;
let displayMode: BadgeDisplayMode = 'word';
let lastGrammarHash = '';
let pendingMutation = false;
const MAX_BADGE_COUNT = 676; // No artificial cap; word pairs for >26

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
  store.removeWrapperByElement(element);
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
      const parent = document.body || document.documentElement;
      if (!parent) continue;
      parent.appendChild(removed);
      wrapper.hint.reposition();
    }
  }
});

function startBadgeReattachObserver(): void {
  const target = document.body || document.documentElement;
  if (target) badgeReattachObserver.observe(target, { childList: true });
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

  // Hash-based deduplication. Includes codeword so an alphabet regen that
  // produces the same elements but different codewords still re-pushes —
  // otherwise the voice plugin would keep using stale codewords.
  const hash = elements.map(e => `${e.selector}|${e.category}|${e.codeword}`).join('\x1f');
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
    // Refresh scanned metadata (label/category/selector). Codeword stays.
    const refreshed = scanSingle(target);
    if (refreshed) {
      refreshed.codeword = existing.scanned.codeword;
      existing.scanned = refreshed;
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
  // Hints are visible — defer DOM-driven changes so codeword assignments
  // don't shuffle mid-interaction. hideHints() flushes via doScan().
  if (hintsVisible) {
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
  attributeFilter: ['disabled', 'aria-hidden', 'role', 'contenteditable', 'href'],
});

startBadgeReattachObserver();

// --- Initial Scan ---

// Scan on load to push initial grammar
doScan();

// Expose for console debugging
(window as any).branchkitShowHints = () => { doScan(); showHints(); };
(window as any).branchkitHideHints = () => hideHints();
(window as any).branchkitScan = () => { doScan(); return store.all; };

console.log('[BranchKit Browser] Loaded. Press f to show hints, or call branchkitShowHints()');
