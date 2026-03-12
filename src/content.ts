/**
 * BranchKit Extension — Content script entry point.
 *
 * Injected per frame. Scans DOM, creates badges, handles keyboard input.
 * Voice commands arrive via background → BRANCHKIT_ACTION messages.
 */

import { Category, BadgeDisplayMode, ScannedElement, Message } from './types';
import { assignLabels, HINT_WORDS, WORD_TO_LETTER } from './words';
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

dispatcher.register('show_hints_newtab', () => {
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

function doScan(): void {
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

  // Build wrappers
  const wrappers: ElementWrapper[] = [];
  for (let i = 0; i < elements.length; i++) {
    wrappers.push(new ElementWrapper(refs[i], elements[i]));
  }

  store.set(wrappers);

  // Push grammar to background (for BranchKit voice)
  pushGrammar(elements);
}

function showHints(category?: Category): void {
  activeCategory = category || null;

  // Get elements to label (optionally filtered by category)
  const targets = category
    ? store.byCategory(category)
    : store.all;

  if (targets.length === 0) return;

  // Sort by viewport position: top-left first
  targets.sort((a, b) => {
    const ra = a.element.getBoundingClientRect();
    const rb = b.element.getBoundingClientRect();
    return (ra.top - rb.top) || (ra.left - rb.left);
  });

  // Assign labels
  const labels = assignLabels(targets.length);

  for (let i = 0; i < targets.length; i++) {
    const wrapper = targets[i];
    wrapper.label = labels[i];

    // Create badge if not exists
    if (!wrapper.hint) {
      wrapper.hint = new HintBadge(
        wrapper.element,
        labels[i],
        wrapper.category,
        displayMode,
      );
    } else {
      wrapper.hint.updateLabel(labels[i], displayMode);
    }

    wrapper.hint.show();
  }

  hintsVisible = true;

  // Auto-dismiss after 10s
  setTimeout(() => {
    if (hintsVisible) hideHints();
  }, 10000);
}

function hideHints(): void {
  hintsVisible = false;
  activeCategory = null;
  for (const w of store.all) {
    w.hint?.hide();
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

  hideHints();
  keyHandler.exitHintMode();

  if (wrapper.category === 'input') {
    el.focus();
    el.style.outline = '2px solid #007AFF';
    setTimeout(() => { el.style.outline = ''; }, 3000);
  } else {
    el.click();
  }
}

// --- Grammar Push (Slice C) ---

function pushGrammar(elements: ScannedElement[]): void {
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

// --- Message Listener (from background / voice) ---

chrome.runtime.onMessage.addListener((message: Message) => {
  if (message.type === 'BRANCHKIT_ACTION') {
    const { action, params } = message.payload;

    // Map voice actions to dispatcher actions
    if (action === 'show_hints') {
      dispatcher.dispatch('show_hints');
    } else if (action === 'show_hints_go') {
      dispatcher.dispatch('show_hints_category', { category: 'button' });
    } else if (action === 'show_hints_tables') {
      dispatcher.dispatch('show_hints_category', { category: 'tables' });
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

// --- Keyboard Listener ---

document.addEventListener('keydown', (e: KeyboardEvent) => {
  keyHandler.handleKeyDown(e);
}, true); // capture phase

// --- MutationObserver (debounced rescan) ---

let mutationTimer: ReturnType<typeof setTimeout> | null = null;

const observer = new MutationObserver((_mutations) => {
  // Skip our own mutations
  if (_mutations.every(m =>
    m.type === 'childList' && Array.from(m.addedNodes).every(n =>
      n instanceof HTMLElement && n.hasAttribute('data-branchkit-hint')
    )
  )) return;

  if (mutationTimer) clearTimeout(mutationTimer);
  mutationTimer = setTimeout(() => {
    // Rescan if hints are visible (badges may be stale)
    if (hintsVisible) {
      doScan();
      showHints(activeCategory || undefined);
    }
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

console.log('[BranchKit] Hints extension loaded. Press f to show hints, or call branchkitShowHints()');
