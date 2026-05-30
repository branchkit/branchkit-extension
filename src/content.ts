/**
 * BranchKit Browser — Content script entry point.
 *
 * Injected per frame. Scans DOM, creates badges, handles keyboard input.
 * Voice commands arrive via background → BRANCHKIT_ACTION messages.
 */

import { Category, HintVisibility, ScannedElement, Message, DispatchResult } from './types';
import { LabelAssignment, WORD_TO_LETTER, isAlphabetLoaded, setAlphabet } from './labels/words';
import { scanElements, scanSingle, isHintable, deepQuerySelectorAll, scanInBatches, DEFAULT_SCAN_BATCH_SIZE, getPerfCounters, resetPerfCounters, subtreeMaybeHintable } from './scan/scanner';
import { ElementWrapper, WrapperStore, enterLimbo, isLimboExpired } from './scan/element-wrapper';
import * as idRegistry from './scan/registry';
import { computeFingerprint, fingerprintsEqual } from './scan/registry';
import { bumpRebindCounter, findLimboMatch, newRebindCounters, REBIND_DISTANCE_THRESHOLD_PX, type RebindCounters } from './labels/rebind';
import { resolveTarget } from './activate/activate-resolution';
import { IntersectionTracker } from './observe/intersection-tracker';
import { AttentionObserver } from './observe/attention-observer';
import { TargetRectStore } from './observe/target-rect-store';
import { HintBadge, setPositionCaller, clearPositionCaller } from './render/hints';
import { onContainerResize } from './observe/container-resize-tracker';
import { onScrollAncestor, scrollAncestorStats, registeredScrollTargets } from './observe/scroll-ancestor-tracker';
import { onTargetMutation } from './observe/target-mutation-tracker';
import { cacheLayout, cacheVisibility, clearLayoutCache, peekCachedRect, getCachedRect } from './layout-cache';
import { placeBadges, placeOne, clearPlacement } from './placement';
import { invalidateProbe } from './placement/rango';
import { activateElement, type ActivationResult } from './activate/event-sequence';
import {
  emitActivatePath,
  elementSnap,
  type ActivatePathEvent,
} from './activate/activate-path-log';
import { captureDebugSnapshot } from './debug/debug-snapshot';
import { toggleOverlay } from './render/debug-overlay';
import {
  CodewordSnapshot,
  takeSnapshot,
  resolveFromSnapshot,
} from './activate/snapshot';
import { ActionDispatcher, CommandRegistry } from './dispatcher';
import { KeyHandler } from './activate/keyboard';
import { getActiveAdapter, scanWithAdapter } from './adapters';
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
} from './activate/scroller';
import {
  openFindMode,
  closeFindMode,
  findNext,
  findPrevious,
  findImmediate,
  isFindActive,
  handlePostFindKey,
  setFindCallbacks,
} from './scan/find';
import { saveReference, resolveReference, listReferences } from './scan/references';
import {
  matchRule,
  compileRule,
  applyExclusions,
  collectInclusions,
  isExcludedByRule,
  injectRevealStyles,
  type CompiledRule,
  type DomainRule,
  type RuleEntry,
} from './rules/domain-rules';
import { loadDomainRules, onDomainRulesChanged, ruleEqual } from './rules/domain-rules-storage';
import { filterNewBatchRefs } from './scan/batch-dedup';
import { resolveHintLocally, reportDispatchResult } from './plugin/resolve';
import { openLivenessPort } from './plugin/liveness';
import { PageSession, TeardownReason } from './lifecycle/page-session';
import { ensureSendMessageWrapped, resetMessageCounters, messageCountersSnapshot } from './debug/message-counters';
import { recordCpu, resetCpuCounters, resetLongtask, resetWatchdog, computeCpuShare, cpuBucketsSnapshot, longtaskSnapshot, watchdogSnapshot } from './debug/perf-counters';
import { loadConfig, getDisplayMode, getHintVisibility } from './config';
import {
  initLabelSync,
  queuePut,
  dropPendingPut,
  queueDelete,
  markSent,
  hasSent,
  hasPendingDeletes,
  getSessionId,
  rotateSession,
  claimLabels,
  postBatch,
  scheduleSync,
  syncNow,
} from './labels/label-sync';

// --- Idempotency guard ---
//
// Two paths can land us here:
//   1. Manifest content_scripts on page load (fresh JS context, flag unset).
//   2. SW programmatic re-injection via `chrome.scripting.executeScript`
//      after `chrome.runtime.onInstalled` (extension install/update/reload).
//
// Case 2 hits a frame whose isolated world already holds an orphan content
// script with the flag set. The SW clears the flag immediately before
// injecting (see background.ts re-injection handler), so the fresh script
// runs to completion and binds new listeners. The orphan stays in the
// world but its `chrome.runtime` is invalidated; its observers/listeners
// keep firing into dead code until the page navigates or follow-up work
// (step A in the orphan-CS plan) adds a `port.onDisconnect` teardown.
//
// Manual F5 of the page destroys both scripts and the manifest injection
// starts clean — guard catches the rare case of two manifest-driven
// injections (shouldn't happen but is cheap insurance).
if ((window as unknown as { __branchkitContentInjected?: boolean }).__branchkitContentInjected) {
  // Already initialized in this isolated world. Throwing aborts the IIFE
  // without re-binding listeners; the original content script keeps owning
  // the frame. No-op for the page.
  throw new Error('[BranchKit] content script duplicate injection — bailing');
}
(window as unknown as { __branchkitContentInjected: boolean }).__branchkitContentInjected = true;

// --- State ---

const store = new WrapperStore();
const dispatcher = new ActionDispatcher();
const registry = new CommandRegistry();
const keyHandler = new KeyHandler(registry, dispatcher);
const tracker = new IntersectionTracker(store, {
  onCodewordsChanged: (claimed, released) => {
    for (const w of claimed) queuePut(w);
    for (const cw of released) {
      // Only enqueue a real Delete if we'd actually told the plugin
      // about this codeword; if the claim happened and immediately got
      // released inside one debounce window, the plugin never saw it.
      if (hasSent(cw)) queueDelete(cw);
    }
    schedulePushGrammar();
    if (hintsVisible) badgeNewlyCodeworded();
  },
});

// (Strict-viewport tracker removed — it was meant to narrow the
// scheduleReposition set on heavy pages, but on YouTube /watch the
// added per-wrapper observation (a second IO per element, on top of
// the IntersectionTracker's 200px-margin IO) appeared to saturate
// the process when wrap counts climbed past ~250 during scroll-driven
// lazy-load. The scroll-debounce coalesces reposition bursts into one
// call per scroll-end now, which makes per-call cost much less critical
// than total observation overhead.)

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

// Wire the LabelStage's catchup sync to content.ts-owned collaborators.
// detachWrapper/badgeNewlyCodeworded are hoisted function declarations;
// store is defined above; hintsVisible is read lazily via the arrow.
initLabelSync({
  store,
  detachWrapper,
  badgeNewlyCodeworded,
  isHintsVisible: () => hintsVisible,
});

let activeCategory: Category | null = null;
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

// --- Per-domain hint rules ---
//
// Loaded asynchronously from chrome.storage.sync at startup; the initial
// doScan() at the bottom of this file runs BEFORE the storage read
// returns, so the first frame may render without user rules applied —
// the storage callback triggers a second doScan once the rule is known.
// See notes/completed/DESIGN_PER_DOMAIN_HINT_RULES.md "Timing".
let compiledRule: CompiledRule | null = null;

function getExcludes(): readonly RuleEntry[] {
  return compiledRule?.excludes ?? [];
}

function applyMatchedRule(rule: DomainRule | null): void {
  // Sweep any prior reveal stylesheet — covers both our previous match
  // and orphan nodes left by an earlier content-script generation
  // (extension reload re-injects JS but leaves the DOM).
  for (const old of document.querySelectorAll('style[data-branchkit-reveal]')) {
    old.remove();
  }
  if (!rule) {
    compiledRule = null;
    return;
  }
  compiledRule = compileRule(rule);
  const style = injectRevealStyles(compiledRule.reveals);
  if (style && document.head) document.head.appendChild(style);
}

if (typeof chrome !== 'undefined' && chrome.storage?.sync) {
  loadDomainRules().then((rules) => {
    const rule = matchRule(window.location.href, rules);
    applyMatchedRule(rule);
    if (rule) {
      doScan();
      schedulePushGrammar();
    }
  });

  onDomainRulesChanged((rules) => {
    const nextRule = matchRule(window.location.href, rules);
    // Skip if THIS frame's matched rule is unchanged — a user editing
    // *.github.com's rule shouldn't trigger a re-scan stampede on every
    // quickbase.com tab.
    if (ruleEqual(nextRule, compiledRule?.rule ?? null)) return;
    applyMatchedRule(nextRule);
    if (compiledRule) {
      for (const w of [...store.all]) {
        if (isExcludedByRule(w.element, compiledRule.excludes)) detachWrapper(w.element);
      }
    }
    doScan();
    schedulePushGrammar();
  });
}

// --- Hydration-safe deferral ---
//
// Wait for DOM mutations to settle before inserting badge hosts. React
// SSR apps hydrate via a burst of mutations after page load; inserting
// nodes mid-hydration causes error #418. This watches for a quiet
// period (no mutations for SETTLE_MS) before firing the callback.
const SETTLE_MS = 200;

function whenDOMSettles(callback: () => void): void {
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(fire, SETTLE_MS);
  const mo = new MutationObserver(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fire, SETTLE_MS);
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
  function fire() {
    mo.disconnect();
    timer = null;
    callback();
  }
}

// --- User settings from storage (core/config.ts) ---

loadConfig({
  onDisplayModeChange: () => {
    if (hintsVisible) updateBadgeLabels();
  },
  onHintVisibilityChange: () => {
    const v = getHintVisibility();
    if (v === 'always' && !hintsVisible) {
      showHints();
    } else if (v === 'manual' && hintsVisible) {
      hideHints();
    }
  },
  onAggressiveHintsChange: () => {
    // Clear the store so already-hinted elements that no longer qualify
    // get torn down, then re-scan with the new selector breadth.
    store.clear();
    doScan();
  },
});

// Alphabet adoption (not a user setting; stays here, coupled to delta-sync
// session state). BranchKit pushed a new alphabet — adopt it. The pool was
// wiped server-side by regenerateAllStacks; our wrappers' codewords are
// stale strings that no longer route. Drop them locally and let the tracker
// reclaim for every viewport-visible wrapper. (IO won't re-fire on
// already-intersecting elements, so we have to walk the store ourselves.)
if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.alphabet?.newValue) {
      setAlphabet(changes.alphabet.newValue);
      // Problem 3 (notes/DESIGN_OPTION_B_REATTEMPT.md): the previous
      // alphabet's codewords are now invalid, and the plugin still
      // holds them in `browser_hints_<old-prefix>` for this frame.
      // Rotate the session_id so the plugin's ensureFrameSession sees
      // a session change → cleanupFrameSessionLocked clears stale
      // per-prefix entries. This is the ONE place in a content
      // script's lifetime where we want plugin-side cleanup.
      // Plugin clears its per-frame session on session_id change, so the
      // delta-sync mirror state on this side is now stale; rotateSession
      // rotates the id and resets it. Subsequent IT.refreshViewportClaims
      // will re-claim codewords for in-viewport wrappers and
      // onCodewordsChanged will re-queue them as pending Puts.
      rotateSession();
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
//
// Re-triggers doScan after setAlphabet because under Option B's batched
// path (doScanBatched) the initial doScan at module load no-ops if the
// alphabet isn't loaded yet — without this re-trigger the store stays
// empty and badges never paint. Old path's IntersectionTracker async-
// claim hid the race; the batched path's inline claim doesn't.
if (typeof chrome !== 'undefined' && chrome.storage?.local) {
  chrome.storage.local.get('alphabet', (result) => {
    if (Array.isArray(result.alphabet)) {
      setAlphabet(result.alphabet);
      // Defer the initial scan by one macrotask. Running doScan
      // synchronously inside the storage callback blocks the main thread
      // before the snapshot publisher's setInterval has a chance to
      // register its first tick — on heavy pages (YouTube /watch with
      // shadow DOM and 1000+ candidates) this looks like a freeze and
      // Firefox flags the extension as unresponsive.
      //
      // setTimeout(0) (rather than requestIdleCallback) because rIC
      // never finds a true idle window on hyperactive pages, and the 2s
      // timeout fallback still starves the scan-batch loop's own
      // setTimeout(0) yields. A single-tick defer is enough to let the
      // page paint + the publisher fire its first sample; from there
      // scanInBatches' chunked walk + the per-batch await yield the
      // event loop between batches.
      setTimeout(() => {
        doScan();
        if (getHintVisibility() === 'always') {
          whenDOMSettles(() => {
            tracker.flushNow().then(() => {
              if (getHintVisibility() === 'always' && !hintsVisible) showHints();
            });
          });
        }
      }, 0);
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
  const codeword = params.word2 ? `${params.word} ${params.word2}` : params.word;
  if (!codeword) return;
  const w = store.byCodeword(codeword);
  if (w) activateWrapper(w);
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
    const wrapper = store.findWrapperFor(el);
    if (!wrapper) continue;
    // Limbo wrappers: hold codeword + badge until finalize/rebind.
    // Disconnected elements deterministically fail isHintable; we don't
    // want that path stealing the wrapper out from under the limbo
    // lifecycle.
    if (wrapper.disconnectedAt !== null) continue;
    if (!isHintable(el)) {
      detachWrapper(el);
      dirty = true;
      continue;
    }
    // Phase 5 (router-via-RO): the engine just resized this element. The
    // read here follows the layout pass it triggered, so it's warm.
    targetRectStore.write(el, el.getBoundingClientRect());
  }
  if (dirty) schedulePushGrammar();
});

/**
 * Visibility recovery for elements that matched HINTABLE_SELECTOR but
 * failed isVisible() at scan time. Two layers (see
 * notes/completed/DESIGN_VISIBILITY_OBSERVER.md):
 *
 * 1. IntersectionObserver catches display:none -> block (geometry change).
 * 2. Scoped MutationObserver on class/style catches visibility:hidden ->
 *    visible (no geometry change). Connected only while candidates exist;
 *    disconnects when the set empties. RAF-debounced to coalesce React's
 *    per-component class churn into one re-check per frame.
 */
const pendingVisibility = new Set<Element>();
const VISIBILITY_ABANDON_MS = 30_000;
let visibilityAbandonTimer: ReturnType<typeof setTimeout> | null = null;
let visibilityRafPending = false;

const visibilityIO = new IntersectionObserver((entries) => {
  let dirty = false;
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const el = entry.target;
    visibilityIO.unobserve(el);
    if (store.findWrapperFor(el)) { pendingVisibility.delete(el); continue; }
    const scanned = scanSingle(el);
    // Keep in pendingVisibility — visibility:hidden elements have non-zero
    // rects so IO fires immediately, but they need the MO layer to promote
    // them once a class/style change flips visibility.
    if (!scanned) continue;
    attachWrapper(new ElementWrapper(el, scanned));
    pendingVisibility.delete(el);
    dirty = true;
  }
  if (dirty) {
    schedulePushGrammar();
    if (hintsVisible) showHints();
  }
  if (pendingVisibility.size === 0) disconnectVisibilityMO();
}, { root: null, rootMargin: '200px', threshold: 0 });

const visibilityMO = new MutationObserver(() => {
  if (visibilityRafPending) return;
  visibilityRafPending = true;
  requestAnimationFrame(recheckPendingVisibility);
});

let visibilityMOConnected = false;

function connectVisibilityMO(): void {
  if (visibilityAbandonTimer) clearTimeout(visibilityAbandonTimer);
  visibilityAbandonTimer = setTimeout(() => {
    for (const el of pendingVisibility) visibilityIO.unobserve(el);
    pendingVisibility.clear();
    disconnectVisibilityMO();
  }, VISIBILITY_ABANDON_MS);
  if (visibilityMOConnected) return;
  visibilityMO.observe(document.documentElement, {
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style'],
  });
  visibilityMOConnected = true;
}

function disconnectVisibilityMO(): void {
  if (!visibilityMOConnected) return;
  visibilityMO.disconnect();
  visibilityMOConnected = false;
  if (visibilityAbandonTimer) {
    clearTimeout(visibilityAbandonTimer);
    visibilityAbandonTimer = null;
  }
}

function recheckPendingVisibility(): void {
  const __cpuStart = performance.now();
  const __initialSize = pendingVisibility.size;
  visibilityRafPending = false;
  let dirty = false;
  // Pre-cache the union of (target + ancestor chain) so the many
  // isVisible() reads inside scanSingle share the read. Same trick as
  // drainReevaluations — siblings under one parent reuse the ancestor
  // walk's computedStyle reads. Cleared in `finally` so the next frame
  // sees live state.
  cacheVisibility(pendingVisibility);
  try {
    for (const el of pendingVisibility) {
      if (!el.isConnected) {
        pendingVisibility.delete(el);
        visibilityIO.unobserve(el);
        continue;
      }
      if (store.findWrapperFor(el)) {
        pendingVisibility.delete(el);
        visibilityIO.unobserve(el);
        continue;
      }
      const scanned = scanSingle(el);
      if (!scanned) continue;
      pendingVisibility.delete(el);
      visibilityIO.unobserve(el);
      attachWrapper(new ElementWrapper(el, scanned));
      dirty = true;
    }
  } finally {
    clearLayoutCache();
  }
  if (dirty) {
    schedulePushGrammar();
    if (hintsVisible) showHints();
  }
  if (pendingVisibility.size === 0) disconnectVisibilityMO();
  recordCpu('recheckPendingVisibility', performance.now() - __cpuStart);
  if (__initialSize > 0) recordCpu(`recheckPendingVisibility:size:${__initialSize > 1000 ? '1000+' : __initialSize > 100 ? '100-1000' : '<100'}`, __initialSize);
}

function observeInvisibleCandidates(candidates: Element[]): void {
  // Under the viewport-scoped lifecycle, invisible candidates are routed
  // through the attention observer. They only join `pendingVisibility`
  // when they actually enter the attention region (handled by
  // attentionObserver.onEnter below). This bounds the recheck set by
  // viewport proximity instead of total document candidate count —
  // YouTube comment skeletons that scroll past stay registered with
  // attention IO but are no longer rechecked on every MO fire.
  for (const el of candidates) {
    if (store.findWrapperFor(el) || !el.isConnected) continue;
    if (isExcludedByRule(el, getExcludes())) continue;
    attentionObserver.observe(el);
  }
}

// Viewport-scoped attention. Wide-margin IO (2 viewports above/below)
// drives the lifecycle of candidates that aren't yet wrappers, plus
// leave-detach for wrappers that drift far from the viewport. Distinct
// from the IntersectionTracker (narrow-margin IO for codeword claim/
// release) by design — different concerns, different margins. See
// notes/DESIGN_OBSERVER_DRIVEN_LAYOUT.md.

// Phase 3 shadow: rect cache populated by the attention IO's onRect.
// No production read path consumes it yet. The drift sampler in
// buildPerfSnapshot reports `{ size, subscribers, drift }` so we can
// see whether the store would have been correct before any cutover.
const targetRectStore = new TargetRectStore();

const attentionObserver = new AttentionObserver({
  onEnter: (el) => {
    if (!el.isConnected) return;
    if (store.findWrapperFor(el)) return;
    const scanned = scanSingle(el);
    if (scanned) {
      attachWrapper(new ElementWrapper(el, scanned));
      schedulePushGrammar();
      return;
    }
    // Still not hintable (visibility:hidden, opacity:0, etc.). Bounded
    // by attention region — only stays in the recheck loop while near
    // the viewport. visibilityMO watches for class/style flips that
    // make it hintable.
    pendingVisibility.add(el);
    visibilityIO.observe(el);
    connectVisibilityMO();
  },
  onLeave: (el) => {
    // Deliberately NOT detaching wrappers on attention-leave (Rango model).
    // Wrappers stay alive until their element disconnects from the DOM.
    // The attention IO's role here is just to manage pendingVisibility
    // membership — bounding the visibility-recheck set is what fixed the
    // Firefox unresponsive-script case on YouTube. Detaching wrappers as
    // well introduced two real regressions (Gmail scroll-back lost hints;
    // Gmail unresponsiveness when we tried keeping IO subscriptions alive
    // instead). Better trade-off: wrappers grow with discovered hintables,
    // but scroll-back works correctly and per-event cost stays bounded.
    targetRectStore.evict(el);
    if (pendingVisibility.has(el)) {
      pendingVisibility.delete(el);
      visibilityIO.unobserve(el);
      if (pendingVisibility.size === 0) disconnectVisibilityMO();
    }
  },
  onRect: (el, rect) => {
    targetRectStore.write(el, rect);
  },
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
  idRegistry.register(wrapper);
  store.addWrapper(wrapper);
  tracker.observe(wrapper.element);
  resizeObserver.observe(wrapper.element);
  // Note: NOT observing via attentionObserver. Wrappers stay attached
  // until DOM disconnect (Rango model); leave-detach is the regression
  // path. The attention observer's only job is bounding pendingVisibility.
}

/**
 * Remove the wrapper for an element. Returns its codeword (if any) to
 * the pool and unobserves both observers.
 */
function detachWrapper(element: Element): void {
  resizeObserver.unobserve(element);
  tracker.unobserve(element);
  attentionObserver.unobserve(element);
  targetRectStore.evict(element);
  const removed = store.removeWrapperByElement(element);
  if (removed) {
    // Delta-sync bookkeeping: if the plugin holds this codeword, queue
    // the Delete; if the wrapper was pending a Put that hasn't fired
    // yet, drop the Put. Either way we don't want stale state on the
    // plugin side post-detach.
    dropPendingPut(removed);
    const cw = removed.scanned.codeword;
    if (cw && hasSent(cw)) queueDelete(cw);
    if (removed.scanned.id > 0) {
      idRegistry.unregister(removed.scanned.id);
    }
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
  badgeReattachObserver.observe(document.documentElement, { childList: true, subtree: true });
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
  // Fire-and-forget — the batched path is async (per-batch awaits a
  // codeword claim + POST round-trip), but doScan's existing callers
  // are sync. doScanBatched schedules itself onto the microtask queue
  // and runs to completion in the background.
  void doScanBatched();
}

// Apply the current compiled rule's exclusions + inclusions to a scan
// result. Mutates result in place. Used by both doScan (full document)
// and discoverInSubtree (added subtree). Cheap no-op when no rule is
// active — the only added cost is one branch.
function applyUserRuleToScan(
  result: { refs: Element[]; elements: ScannedElement[] },
  root: ParentNode,
): void {
  const cr = compiledRule;
  if (!cr) return;
  if (cr.excludes.length > 0) applyExclusions(result.refs, result.elements, cr.excludes);
  if (!cr.includeSelector) return;

  // Subtree scans only need to dedupe within this scan — added subtrees
  // don't overlap with existing wrappers (those are by definition NOT
  // in the just-added subtree). Skip the O(store.all) walk for them.
  const seen = new Set<Element>(result.refs);
  if (root === document) {
    for (const w of store.all) seen.add(w.element);
  }
  const extra = collectInclusions(seen, cr.includeSelector, root);
  result.refs.push(...extra.refs);
  result.elements.push(...extra.elements);
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

  // hintsVisible is the mode flag — "user wants hints showing." Set it
  // even when the store has nothing to paint right now so subsequent
  // wrappers arriving via the batched scan (or MutationObserver
  // discovery) paint via badgeNewlyCodeworded, which is hintsVisible-
  // gated. Under the old whole-grammar path the store was always
  // populated by the time showHints fired, so an empty return here
  // never mattered; under batched mode the scan is async and showHints
  // can race ahead of the first batch landing.
  if (allTargets.length === 0) {
    hintsVisible = true;
    return;
  }

  // Filter to viewport-visible and sort by position (same as grammar push)
  const targets = viewportSort(allTargets);
  if (targets.length === 0) {
    hintsVisible = true;
    return;
  }

  // Only render hints for elements that received a pool codeword.
  // Elements without one wouldn't be voice-addressable and their badge
  // would say "?" — better to leave them unhinted.
  const renderable = targets
    .slice(0, MAX_BADGE_COUNT)
    .filter(w => w.scanned.codeword.length > 0);

  cacheLayout(renderable.map(w => w.element));
  try {
    for (const wrapper of renderable) {
      const label = poolLabelToAssignment(wrapper.scanned.codeword);
      wrapper.label = label;

      if (!wrapper.hint) {
        wrapper.hint = new HintBadge(
          wrapper.element,
          label,
          wrapper.category,
          getDisplayMode(),
        );
      } else {
        wrapper.hint.updateLabel(label, getDisplayMode());
      }

      wrapper.hint.show();
    }

    setPositionCaller('showHints');
    const __pbStart = performance.now();
    try { placeBadges(renderable); } finally {
      recordCpu('placeBadges:show', performance.now() - __pbStart);
      clearPositionCaller();
    }
    // Write-on-paint: seed the store with each painted target's current rect
    // from the warm cache. The attention IO writes targets at band-entry time
    // (often a stale position by the time they paint); this corrects it on
    // paint so the store is warm without the blanket sweep.
    for (const w of renderable) targetRectStore.write(w.element, getCachedRect(w.element));
  } finally {
    clearLayoutCache();
  }
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
    if (getHintVisibility() !== 'always') return;
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

  setPositionCaller('badgeNewlyCodeworded');
  try {
    cacheLayout(newBadges.map(w => w.element));
    for (let i = 0; i < newBadges.length; i++) {
      const w = newBadges[i];
      const label = poolLabelToAssignment(w.scanned.codeword);
      w.label = label;
      w.hint = new HintBadge(w.element, label, w.category, getDisplayMode());
      w.hint.show();
      placeOne(w, existingCount + i);
      targetRectStore.write(w.element, getCachedRect(w.element)); // write-on-paint
    }
  } finally {
    clearLayoutCache();
    clearPositionCaller();
  }
}

function updateBadgeLabels(): void {
  for (const w of store.all) {
    if (w.hint && w.label) {
      w.hint.updateLabel(w.label, getDisplayMode());
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
  if (getHintVisibility() === 'always') {
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

/**
 * Per-batch replacement for `doScan` + `pushGrammar`. Walks the DOM
 * once via `scanInBatches`, claims codewords per batch, POSTs each
 * batch to the plugin, and paints succeeded badges as soon as their
 * Puts complete — the visual badge and the matcher's per-prefix
 * entry move together. See notes/DESIGN_HINT_PIPELINE_RESYNC.md.
 *
 * Badge-implies-functional contract: wrappers are NOT attached to
 * the store until the plugin acknowledges the batch's POST and the
 * element is still in the DOM. Failed elements get their labels
 * released without entering the store; disconnected elements get
 * their codewords queued for plugin-side delete via the next
 * batch's piggyback. The store therefore never contains a wrapper
 * the matcher can't activate, and `badgeNewlyCodeworded` only
 * paints badges whose voice command is live.
 */
async function doScanBatched(): Promise<void> {
  if (!isAlphabetLoaded()) {
    return;
  }
  const __cpuStart = performance.now();

  // Uses the LabelStage session id — see Problem 1 in the design doc.
  const cr = compiledRule;
  const adapter = getActiveAdapter(window.location.href);

  // Inclusions run ONCE per scan (item 15: per-batch inclusion would
  // be N querySelectorAll for the whole document). Pre-mark these
  // refs so the scanner walk doesn't rediscover them.
  let inclusionRefs: Element[] = [];
  let inclusionElements: ScannedElement[] = [];
  if (cr?.includeSelector) {
    const inc = collectInclusions(new Set(), cr.includeSelector, document);
    inclusionRefs = inc.refs;
    inclusionElements = inc.elements;
  }
  const initialSeen = new Set<Element>(inclusionRefs);

  // Drop wrappers whose elements disconnected since the last scan
  // BEFORE walking — same as the old doScan path's end-of-pass sweep
  // but moved up so the per-batch loop starts from a clean store.
  dropDisconnectedWrappers();

  const sessionMeta = {
    bundle_id: '',
    hint_visibility: getHintVisibility(),
    app_id: '',
    table_id: '',
  };

  let batchIndex = 0;

  // Synthetic first "batch" for inclusion-rule elements, if any. Goes
  // through the same processing path so its codewords get Put and the
  // succeeded ones paint. is_final stays false because the scanner
  // walk will follow with at least its own terminal batch.
  if (inclusionRefs.length > 0) {
    await processScanBatch(
      { refs: inclusionRefs, elements: inclusionElements, isLast: false, invisibleCandidates: [] },
      getSessionId(), batchIndex, sessionMeta, adapter,
    );
    batchIndex++;
  }

  for (const batch of scanInBatches(
    adapter ? document : document, DEFAULT_SCAN_BATCH_SIZE, initialSeen,
  )) {
    await processScanBatch(batch, getSessionId(), batchIndex, sessionMeta, adapter);
    batchIndex++;
    // Yield to the event loop between batches so MutationObserver
    // can fire and any DOM removal mid-scan flags the wrapper's
    // element as disconnected before the next batch (item 5
    // mitigation; the sweep itself runs in processScanBatch).
    await new Promise(r => setTimeout(r, 0));
  }

  // If the terminal batch's sweep queued deletes, flush them now via
  // an empty deletes-only batch — otherwise they'd strand until the
  // next user-driven scan. Reuses the same session_id so plugin-side
  // session tracking stays consistent.
  if (hasPendingDeletes()) {
    await postBatch({
      session_id: getSessionId(),
      batch_index: batchIndex,
      is_final: true,
      kind: 'scan',
      bundle_id: sessionMeta.bundle_id,
      hint_visibility: sessionMeta.hint_visibility,
      app_id: sessionMeta.app_id,
      table_id: sessionMeta.table_id,
      elements: [],
    });
  }
  recordCpu('doScanBatched', performance.now() - __cpuStart);
}

async function processScanBatch(
  batch: { refs: Element[]; elements: ScannedElement[]; isLast: boolean; invisibleCandidates: Element[] },
  sessionId: string, batchIndex: number,
  sessionMeta: { bundle_id: string; hint_visibility: HintVisibility; app_id: string; table_id: string },
  adapter: ReturnType<typeof getActiveAdapter>,
): Promise<void> {
  // Sync slab 1: exclusions + dedup + candidate construction. Measured
  // separately from the surrounding awaits so the recorded ms reflects
  // actual main-thread block time, not wall-clock through claim+POST.
  // Compare with `doScanBatched` (wall-clock across all batches +
  // yields) — that bucket is useful for "how long did this scan feel"
  // but a single high value there doesn't imply a freeze. The sync
  // buckets here are the freeze attribution surface.
  const __syncAStart = performance.now();
  if (compiledRule?.excludes.length) {
    applyExclusions(batch.refs, batch.elements, compiledRule.excludes);
  }

  // Drop refs whose wrappers already exist in the store
  // (notes/DESIGN_OPTION_B_REATTEMPT.md "Problem 2"). Their codewords
  // are already in the plugin's session.Codewords from a prior batch
  // and will be re-pushed by the cumulative buildTabPrefixState.
  // Re-claiming pool labels for them depletes the pool: the duplicate
  // wrapper would be discarded but the just-claimed label stays in
  // the pool's `assigned` map. Empirically this drained the pool
  // after ~10 rescans on QuickBase.
  const { newRefs, newElements } = filterNewBatchRefs(
    batch.refs, batch.elements, (el) => store.findWrapperFor(el) !== undefined,
  );
  recordCpu('processScanBatch:syncA', performance.now() - __syncAStart);

  // No new elements to claim — bail unless this is the terminal batch,
  // in which case the protocol still needs an is_final marker so the
  // plugin closes out the scan window.
  if (newRefs.length === 0 && !batch.isLast) {
    return;
  }

  // Pool-claim codewords for the batch. claimLabels serializes per
  // tab via withTabLock so multi-frame pages don't collide.
  const labels = await claimLabels(newRefs.length);

  // Build candidate wrappers with codewords assigned but DO NOT
  // attach to the store yet. Wrappers in the store with codewords
  // would be visible to showHints() and badgeNewlyCodeworded(),
  // causing badges to paint before the plugin acknowledges the
  // grammar push. The design's badge-implies-functional contract
  // (every painted badge must be voice-activatable) requires that
  // we hold off attachWrapper until AFTER POST succeeds AND the
  // element is still in the DOM. Any wrapper that fails either
  // check gets its label released without ever entering the store.
  const candidates: ElementWrapper[] = [];
  for (let i = 0; i < newRefs.length; i++) {
    const label = i < labels.length ? labels[i] : '';
    if (!label) continue;  // pool exhausted; element stays unaddressable
    newElements[i].codeword = label;
    candidates.push(new ElementWrapper(newRefs[i], newElements[i]));
  }

  // Even an empty batch sends an is_final marker so the plugin
  // knows the scan ended (matters for the C7 cleanup window).
  if (candidates.length === 0 && !batch.isLast) {
    return;
  }

  const adapterName = adapter?.name ?? '';
  void adapterName; // reserved for plugin-side adapter-aware routing

  const resp = await postBatch({
    session_id: sessionId,
    batch_index: batchIndex,
    is_final: batch.isLast,
    kind: 'scan',
    bundle_id: sessionMeta.bundle_id,
    hint_visibility: sessionMeta.hint_visibility,
    app_id: sessionMeta.app_id,
    table_id: sessionMeta.table_id,
    elements: candidates.map(w => w.scanned),
  });

  // Sync slab 2: response partitioning, attach loop, paint, observer
  // surfacing. Everything after the POST-await is synchronous; if any
  // of it takes >50ms it's a real main-thread block.
  const __syncBStart = performance.now();

  // Partition: succeeded + still-connected → attach to store (paint
  // follows). Succeeded + disconnected (item 5 RED) → queue the
  // codeword for delete on the next batch and release the label.
  // Failed or unknown → release the label without ever attaching.
  const succeededSet = new Set(resp.succeeded);
  const attached: ElementWrapper[] = [];
  for (const w of candidates) {
    if (!succeededSet.has(w.scanned.codeword)) {
      // Either explicitly failed or the response didn't acknowledge
      // it. Either way: never entered the store, just release.
      w.releaseLabel();
      continue;
    }
    if (!w.element.isConnected) {
      // Element disconnected during the POST round-trip. Plugin
      // already holds the codeword in its entity_cache — queue the
      // delete on the next batch to clear it.
      queueDelete(w.scanned.codeword);
      w.releaseLabel();
      continue;
    }
    attachWrapper(w);
    // Delta-sync: the plugin acknowledged this codeword inside the
    // scan-path POST above, so it's now live on the plugin side. Mark
    // it so future detaches know to send a Delete and future syncs
    // skip re-Putting it.
    markSent(w.scanned.codeword);
    attached.push(w);
  }

  // Paint the just-attached badges. Each one is now backed by a
  // successful plugin acknowledgement AND a still-connected element,
  // so the badge-implies-functional contract holds. Gated by
  // hintsVisible so manual-mode batches don't paint until "show".
  if (hintsVisible && attached.length > 0) {
    badgeNewlyCodeworded();
  }

  // Surface terminal-batch invisibleCandidates to the
  // ResizeObserver path (same as the old doScan's end-of-pass).
  if (batch.isLast && batch.invisibleCandidates.length > 0) {
    observeInvisibleCandidates(batch.invisibleCandidates);
  }
  recordCpu('processScanBatch:syncB', performance.now() - __syncBStart);
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
  // Finalize any limbo wrappers before the existing re-registration
  // sweep. Per the open question on bfcache in DESIGN_WRAPPER_IDENTITY_
  // STABILITY: lastRect snapshots from pre-bfcache aren't trustworthy
  // for the rebind tiebreaker after restore (layout/scroll may have
  // shifted), and any wrapper still in limbo at restore time has been
  // disconnected for an indeterminate window. Detach now; the rescan
  // rebuilds fresh wrappers for whatever's still in the DOM. Common
  // case: the loop body never fires (limbo is empty at restore).
  for (const w of [...store.all]) {
    if (w.disconnectedAt !== null) detachWrapper(w.element);
  }
  // Registry survives bfcache (V8 context is preserved) but its entries
  // are stale — the plugin's grammar was wiped by purgeTab on navigate-
  // away, and we want fresh ids on the next push. doScan alone won't
  // re-register surviving wrappers because findWrapperFor short-circuits
  // for elements still in the store, so we have to walk the store and
  // re-register each one ourselves. Codewords + pool claims survive
  // bfcache (the pool is in chrome.storage.session), so re-registering
  // in place avoids churning RELEASE_LABELS through the pool.
  idRegistry.clear();
  for (const w of [...store.all]) {
    if (!w.element.isConnected) {
      detachWrapper(w.element);
      continue;
    }
    idRegistry.register(w);
  }
  doScan();
  schedulePushGrammar();
});

// --- Frame liveness Port ---
//
// Our own frameId, as told to us by the SW over the liveness Port on
// connect. Used to detect misrouted activate actions (registry id minted
// in a different frame). null until the Port handshake completes; the
// activate path treats "unknown" as "trust the routing" so dispatches that
// arrive before the handshake aren't dropped. Port mechanics live in
// plugin/liveness.ts; the orphan teardown (quiesceOrphan) stays here
// because it disconnects this file's observers.
let myFrameId: number | null = null;

// This frame's page-session lifecycle object. First transitional cut: it owns
// the teardown transition (and its reason) while the observer/timer state still
// lives in this module and is reached via the injected `teardown` hook. See
// notes/DESIGN_EXTENSION_RESTRUCTURE.md §3.3.1.
const pageSession = new PageSession({
  teardown: (reason) => quiesceOrphan(reason),
});

openLivenessPort({
  onFrameId: (frameId) => { myFrameId = frameId; },
  onOrphan: () => pageSession.teardown('orphan'),
});

// --- Orphan self-quiesce ---
//
// When the extension is reloaded at chrome://extensions/, this content
// script's `chrome.runtime` context is invalidated but the JS execution
// context lives on. Observers and listeners keep firing into dead `chrome.*`
// APIs — wasted CPU plus duplicate dispatch alongside the freshly-injected
// new content script.
//
// We detect this via the liveness port's disconnect handler (above). When
// `chrome.runtime.id` is no longer accessible, we know we're an orphan; this
// function tears down our observers and removes our badge hosts so the new
// content script's freshly-mounted observers run alone.
//
// Idempotent: subsequent calls are no-ops. Each `try` block is independent
// so a failure in one doesn't skip the others.
let orphaned = false;
function quiesceOrphan(reason: TeardownReason = 'orphan'): void {
  if (orphaned) return;
  orphaned = true;
  // Each module-scope observer that fires user-driven callbacks. Missing one
  // means the orphan keeps reacting to DOM changes / viewport shifts and
  // surfacing `Extension context invalidated` errors in the page console.
  try { observer.disconnect(); } catch { /* may not be initialized yet */ }
  try { badgeReattachObserver.disconnect(); } catch { /* same */ }
  try { tracker.disconnectAll(); } catch { /* same */ }
  try { resizeObserver.disconnect(); } catch { /* same */ }
  if (discoveryFrame !== null) {
    try { cancelAnimationFrame(discoveryFrame); } catch { /* same */ }
    discoveryFrame = null;
    pendingDiscoveryRoots.clear();
  }
  try { visibilityIO.disconnect(); } catch { /* same */ }
  try { visibilityMO.disconnect(); } catch { /* same */ }
  // Remove badge hosts so the new content script's initial DOM-clear sweep
  // (content.ts ~line 2230) doesn't have to fight visible artifacts.
  try {
    for (const node of document.querySelectorAll('[data-branchkit-hint]')) {
      node.remove();
    }
  } catch { /* document gone */ }
  console.warn(`[BranchKit] content script torn down (reason: ${reason}). Self-quiesced.`);
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

  if (message.type === 'RESOLVE_HINT') {
    sendResponse(resolveHintLocally(store, message.codeword));
    return false;
  }

  if (message.type === 'BRANCHKIT_ACTION') {
    const { action, params } = message.payload;
    if (action === 'show_hints') {
      phraseSnapshot = takeSnapshot(store.all, performance.now());
      doScan();
      showHints();
    } else if (action === 'hide_hints') {
      hideHints();
    } else if (action === 'rescan') {
      const t0 = performance.now();
      chrome.runtime.sendMessage({ type: 'DEBUG_LOG', tag: 'pipeline.cs_rescan_received', data: { url: window.location.href, from_cache: params?.from_cache === 'true', reason: params?.reason ?? '' } } as Message).catch(() => {});

      if (params?.from_cache === 'true') {
        // Fast path for app-refocus rescans: drop dead wrappers, then
        // republish the current wrapper store (no DOM walk).
        //
        // We DON'T hide/show hints — `syncNow` reuses the
        // existing `sessionId` so the plugin doesn't wipe its per-prefix
        // collections; the matcher's vocab is intact throughout the
        // rescan and codewords stay matchable mid-flight. The previous
        // hide-show cycle was UX signaling, not correctness, and it
        // actively hurt: users saw badges blink and lost confidence,
        // sometimes pausing mid-utterance or saying "show" to bring
        // them back. A deferred doScanBatched() still runs as a
        // reconciliation pass to heal any cache/DOM drift.
        void (async () => {
          dropDisconnectedWrappers();
          await syncNow('refocus_from_cache');
          const t1 = performance.now();
          chrome.runtime.sendMessage({ type: 'DEBUG_LOG', tag: 'pipeline.cs_scan_completed', data: { elements: store.all.length, duration_ms: Math.round(t1 - t0), path: 'from_cache' } } as Message).catch(() => {});

          // Reconciliation: a real DOM walk picks up anything the cache
          // doesn't know about (lazy-loaded elements, post-blur DOM
          // mutations that bypassed MutationObserver, framework-driven
          // element replacement). Idempotent when cache was accurate —
          // filterNewBatchRefs drops everything already wrapped.
          setTimeout(() => { void doScanBatched(); }, 300);
        })();
      } else {
        doScan();
        const t1 = performance.now();
        chrome.runtime.sendMessage({ type: 'DEBUG_LOG', tag: 'pipeline.cs_scan_completed', data: { elements: store.all.length, duration_ms: Math.round(t1 - t0) } } as Message).catch(() => {});
      }
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
      const frameIdParam = params?.frame_id != null ? parseInt(params.frame_id, 10) : -1;

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
          resolveFromStore: (cw) => store.byCodeword(cw),
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
        if (getHintVisibility() === 'always') {
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

// --- Reposition ---
// Badges live in their target's scroll ancestor, so scroll is handled by the
// compositor. Window resize and DOM mutations that shift layout require JS
// repositioning.

// Reposition scope:
//  - 'all'     — re-place every visible badge. Used when layout actually
//                changed (resize, DOM mutation, focus/transition settle,
//                container resize): badge sizes, available space, and sticky
//                bounds can all shift, so the full placement must re-run.
//  - 'drifted' — only re-place badges that didn't track their target on their
//                own (HintBadge.needsScrollReposition). Used for window scroll,
//                where geometry translates uniformly and nested badges ride
//                the compositor for free — re-placing all of them was the
//                dominant scroll-time CPU bucket on heavy pages.
type RepositionScope = 'all' | 'drifted';
let repositionRafPending = false;
let pendingScope: RepositionScope = 'drifted';
function scheduleReposition(scope: RepositionScope = 'all'): void {
  if (!hintsVisible) return;
  // 'all' supersedes a queued 'drifted' — a real layout change needs the full
  // sweep even if a scroll already queued the cheap path.
  if (scope === 'all') pendingScope = 'all';
  if (repositionRafPending) return;
  repositionRafPending = true;
  requestAnimationFrame(() => {
    repositionRafPending = false;
    const scope = pendingScope;
    pendingScope = 'drifted';
    const visible = store.all.filter(w => w.hint?.isVisible);
    if (visible.length === 0) return;
    setPositionCaller(scope === 'drifted' ? 'scrollReposition' : 'scheduleReposition');
    const __pbStart = performance.now();
    try {
      cacheLayout(visible.map(w => w.element));
      // Phase 5 (router-via-scroll-rAF): reads share the cacheLayout
      // warm pass, so each write is essentially free.
      for (const w of visible) {
        targetRectStore.write(w.element, getCachedRect(w.element));
      }
      const toPlace = scope === 'drifted'
        ? visible.filter(w => w.hint!.needsScrollReposition())
        : visible.filter(w => w.hint!.needsLayoutReposition());
      if (toPlace.length > 0) placeBadges(toPlace);
    } finally {
      clearLayoutCache();
      clearPositionCaller();
      recordCpu(scope === 'drifted' ? 'placeBadges:scroll' : 'placeBadges:reposition',
        performance.now() - __pbStart);
    }
  });
}
window.addEventListener('resize', () => scheduleReposition('all'), { passive: true });

// Scroll runs a 'drifted'-scoped reposition: badges already follow scroll via
// CSS positioning in their scroll ancestor, so the compositor tracks them for
// free and only the genuinely scroll-sensitive subset (sticky/fixed clamps,
// scroll-context mismatch — see HintBadge.needsScrollReposition) needs a JS
// re-place. Re-placing ALL visible badges on every scroll settle made
// placeBadges the dominant CPU bucket during scroll on heavy pages (~565ms
// over a 15s soak on YouTube /watch with ~280 badges on the nesting path);
// scoping to drifted badges keeps the per-settle cost to cheap rect reads.
//
// Still debounced. Firing on every rAF during scroll burned ~22% sustained
// CPU at wrap=99 on YouTube /watch, tripped Firefox's "extension is slowing
// things down" warning, and starved YouTube's own scroll-driven lazy-loading
// so content below the fold failed to render. The 100ms debounce coalesces
// the burst (~30 events/sec during fast scrolling) into one reposition;
// scroll-sensitive badges lag by ~100ms but settle correctly when scroll
// stops, which the user can't perceive mid-scroll anyway.
let scrollRepositionTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleScrollReposition(): void {
  if (scrollRepositionTimer) clearTimeout(scrollRepositionTimer);
  scrollRepositionTimer = setTimeout(() => {
    scrollRepositionTimer = null;
    scheduleReposition('drifted');
  }, DEFERRED_REPOSITION_DEBOUNCE_MS);
}
window.addEventListener('scroll', scheduleScrollReposition, { passive: true });

// Per-container resize: each HintBadge registers its anchor with the
// shared tracker. Catches CSS-only and container-scoped layout shifts
// (animated dropdowns, sibling row expansion, :focus-within rules)
// that don't surface as a window scroll/resize or a DOM mutation —
// the classic "click → hints look stale" case.
//
// Debounced (not direct scheduleReposition) for the same reason scroll
// is: on churny pages (YouTube /watch, where comment threads + player +
// chapters resize continuously during scroll as content lazy-loads) the
// RO fires ~15/sec, and each direct call repositions every visible badge
// (400-1100 in always-mode). That made placeBadges:reposition the
// dominant CPU bucket during scroll. Coalescing to one reposition after
// layout settles trades a ~100ms lag on resize-driven repositions —
// imperceptible mid-scroll, same trade already accepted for scroll.
onContainerResize(scheduleDeferredReposition);

// Inner-pane scroll → keep TargetRectStore warm for that pane's targets
// (DESIGN_OBSERVER_DRIVEN_LAYOUT Phase 5b). `scroll` doesn't bubble, so the
// window listener above misses overflow-container scroll; nesting-path badges
// ride the compositor visually but their store rects would otherwise go stale.
// The tracker hands us one rAF-coalesced batch of the scrolled containers'
// targets; this is a read-only pass (store writes, no DOM writes) so the
// getBoundingClientRect reads don't thrash layout. Store is not yet read in
// production — additive warmth ahead of the positioning cutover.
onScrollAncestor((targets) => {
  for (const el of targets) {
    if (el.isConnected) targetRectStore.write(el, el.getBoundingClientRect());
  }
});

// Deferred reposition for signals that hint "layout is about to settle":
// - focusin/focusout: :focus-within can resize parents, focus-driven
//   popovers open, autocomplete suggestions appear. focusin/focusout
//   bubble (focus/blur don't), so a single document-level listener
//   covers the page.
// - transitionend/animationend: CSS-driven dropdowns and panels
//   interpolate layout over 200-300ms after the trigger. The
//   MutationObserver fires at the *start* of the class change; without
//   a settle signal, reposition runs mid-animation and is wrong.
//
// 100ms debounce coalesces the burst (a single transition can fire many
// transitionend events — one per animated property — and a click fires
// focusout+focusin <16ms apart) into one reposition after things
// settle. Matches Rango's ElementWrapper.ts focus debounce.
let deferredRepositionTimer: ReturnType<typeof setTimeout> | null = null;
const DEFERRED_REPOSITION_DEBOUNCE_MS = 100;
function scheduleDeferredReposition(): void {
  if (deferredRepositionTimer) clearTimeout(deferredRepositionTimer);
  deferredRepositionTimer = setTimeout(() => {
    deferredRepositionTimer = null;
    // 'drifted', not 'all'. These signals (container resize, target mutation,
    // focus/transition settle) fire continuously on churny pages — YouTube
    // /watch lazy-loading comments resizes containers ~constantly. Re-placing
    // every visible badge each time made this the dominant extension CPU cost
    // at scale (2404ms over a 60s soak at ~208 badges, vs 765ms for the already
    // -trimmed scroll path). needsScrollReposition() is general drift detection,
    // not scroll-specific: a resize/mutation that genuinely moves a target
    // relative to its badge produces drift and is re-placed; badges that moved
    // in flow with their target (the common case) correctly skip. The window
    // 'resize' handler stays 'all' for genuine global layout/clamping changes.
    scheduleReposition('drifted');
  }, DEFERRED_REPOSITION_DEBOUNCE_MS);
}
document.addEventListener('focusin', scheduleDeferredReposition, { passive: true });
document.addEventListener('focusout', scheduleDeferredReposition, { passive: true });
document.addEventListener('transitionend', scheduleDeferredReposition, { passive: true });
document.addEventListener('animationend', scheduleDeferredReposition, { passive: true });

// Per-target mutation: each HintBadge registers its target with the
// shared tracker. Catches class/style/subtree changes that move a
// target without resizing its container — the long tail the doc-level
// MutationObserver's attributeFilter misses and the container RO can't
// see. Settle-debounced because React renders fire many records in a
// burst.
//
// Per-target invalidation of the cached text probe: the element's
// internal layout may have shifted, so the offset-from-element-rect we
// stored on the wrapper could now point at the wrong place. Drop the
// cache so the next placement re-probes against the fresh layout.
onTargetMutation((target) => {
  const w = store.findWrapperFor(target);
  if (w) invalidateProbe(w);
  scheduleDeferredReposition();
});

// --- Keyboard Listener ---

const scrollKeys = new Set(['j', 'k', 'd', 'u', 'h', 'l']);
const heldKeys = new Set<string>();

document.addEventListener('keydown', (e: KeyboardEvent) => {
  if (orphaned) return;
  if (handlePostFindKey(e)) return;

  // Ctrl+Alt+A — hint-diagnostics snapshot trigger (Phase 2b of
  // docs/completed/DESIGN_HINT_DIAGNOSTICS.md). The design originally
  // specified Ctrl+Alt+D, but Rectangle (popular macOS window manager)
  // claims that as "First Third" and absorbs the keystroke before any
  // browser-level handler fires. A is unbound in Rectangle and in
  // Chrome's defaults.
  //
  // Key check is on `e.code`, not `e.key`. On macOS, Alt+letter
  // produces a dead-key character: Alt+A becomes "å", Alt+D becomes
  // "∂", etc. `e.key` carries the dead-key char, not the letter. But
  // `e.code` is keyboard-layout-independent — always "KeyA" for the
  // A key regardless of modifiers. That's the correct check for an
  // accelerator binding.
  //
  // Q1 of the design doc rejected a voice trigger because debug needs
  // to work *when voice is broken*.
  if (e.ctrlKey && e.altKey && e.code === 'KeyA' && !e.repeat) {
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
    // Phase 3: same press also toggles the in-page debug overlay so the
    // diagnostic categories (yellow/orange/red/blue) become visible
    // without needing to read JSON. Frozen-frame; re-press flips off.
    // The rebind-counters panel rides along — see step 5 of
    // notes/completed/DESIGN_WRAPPER_IDENTITY_STABILITY.md.
    toggleOverlay(store, rebindCounters);
    return;
  }

  if (scrollKeys.has(e.key) && !e.repeat && !heldKeys.has(e.key)) {
    heldKeys.add(e.key);
    setKeyHeld(true);
  }
  keyHandler.handleKeyDown(e);
}, true);

document.addEventListener('keyup', (e: KeyboardEvent) => {
  if (orphaned) return;
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

let hugeMutationTimer: ReturnType<typeof setTimeout> | null = null;

// Dispatched on every grammar-relevant change (MO mutations, IT
// codeword claims, alphabet swap, bfcache restore). Routes to the
// LabelStage's debounced catchup for MO-discovered + IT-claimed wrappers.
function schedulePushGrammar(): void {
  scheduleSync('schedulePushGrammar');
}

function isOwnMutation(n: Node): boolean {
  return n instanceof HTMLElement && n.hasAttribute('data-branchkit-hint');
}

// --- Rebind instrumentation (step 5) ---
//
// Per-bucket counters fed by `tryRebindFromLimbo` and the finalize
// sweeper. Read via `window.branchkitRebindStats()` (console) and the
// debug overlay's stats panel. The thresholds and bucket ratios drive
// the soak-time tuning of REBIND_DISTANCE_THRESHOLD_PX.
const rebindCounters: RebindCounters = newRebindCounters();

/** Walk an added subtree and create wrappers for any hintable descendants. */
function discoverInSubtree(root: Element): number {
  const __cpuStart = performance.now();
  let added = 0;
  const result = scanElements(root, (el) => store.findWrapperFor(el) !== undefined);
  applyUserRuleToScan(result, root);

  // Limbo wrappers seen by every iteration in this pass — gathered once
  // so the rebind matcher doesn't re-walk the store per ref. Locally
  // spliced as wrappers get consumed, so two new elements can't both
  // claim the same limbo wrapper.
  const limboPool = collectLimboWrappers();

  for (let i = 0; i < result.elements.length; i++) {
    const ref = result.refs[i];
    if (store.findWrapperFor(ref)) continue;
    if (limboPool.length > 0 && tryRebindFromLimbo(ref, limboPool)) continue;
    // Eager attach (Rango/Vimium model). Wrappers stay alive while their
    // element is in the DOM — scroll-out doesn't release them. The
    // attention IO is reserved for bounding `pendingVisibility` membership
    // (the YouTube-comment-skeleton case), not for wrapper lifecycle.
    // Trades unbounded wrapper growth on infinite-scroll pages for
    // correct scroll-back behavior (badges reappear on scroll up).
    attachWrapper(new ElementWrapper(ref, result.elements[i]));
    added++;
  }
  observeInvisibleCandidates(result.invisibleCandidates);
  watchUndefinedCustomElements(root);
  recordCpu('discoverInSubtree', performance.now() - __cpuStart);
  return added;
}

function collectLimboWrappers(): ElementWrapper[] {
  const out: ElementWrapper[] = [];
  for (const w of store.all) {
    if (w.disconnectedAt !== null && w.scanned.id > 0) out.push(w);
  }
  return out;
}

/**
 * Probe `pool` for a limbo wrapper whose fingerprint (and, on multi-
 * match, last position) matches `newEl`. On a successful rebind, the
 * wrapper is consumed from `pool` and `rebindWrapper` is run. On
 * `refuse_distance`, the ambiguous candidates are finalized in place
 * (their last positions are too scrambled to safely pick one). Returns
 * true iff the new element was rebound; false means the caller should
 * create a fresh wrapper.
 */
function tryRebindFromLimbo(newEl: Element, pool: ElementWrapper[]): boolean {
  const newFp = computeFingerprint(newEl);
  const matches: ElementWrapper[] = [];
  for (const w of pool) {
    const entry = idRegistry.get(w.scanned.id);
    if (!entry) continue;
    if (fingerprintsEqual(entry.fingerprint, newFp)) matches.push(w);
  }
  if (matches.length === 0) return false;

  // One getBoundingClientRect read per discovery — paid only when there's
  // at least one fingerprint match. Single-match case ignores it.
  const newRect = matches.length === 1 ? null : newEl.getBoundingClientRect();
  const outcome = findLimboMatch(matches, newRect, REBIND_DISTANCE_THRESHOLD_PX);

  bumpRebindCounter(rebindCounters, outcome);
  switch (outcome.kind) {
    case 'rebind_clean':
    case 'rebind_position': {
      rebindWrapper(outcome.wrapper, newEl);
      consume(pool, outcome.wrapper);
      return true;
    }
    case 'refuse_distance': {
      for (const c of outcome.candidates) {
        consume(pool, c);
        detachWrapper(c.element);
      }
      return false;
    }
    case 'no_candidates':
      return false;
  }
}

function consume(pool: ElementWrapper[], w: ElementWrapper): void {
  const idx = pool.indexOf(w);
  if (idx >= 0) pool.splice(idx, 1);
}

/**
 * Re-anchor `w` to `newEl`. The wrapper's codeword, badge, label, and
 * registry id all survive — only the DOM-identity edges swap. Mirrors
 * the algorithm in `notes/completed/DESIGN_WRAPPER_IDENTITY_STABILITY.md`
 * "Rebind operation". Order matters: store + registry first (so the
 * tracker callbacks can find the wrapper by newEl), then observers,
 * then the badge swap, then the mutable `.element` pointer.
 */
function rebindWrapper(w: ElementWrapper, newEl: Element): void {
  const oldEl = w.element;

  store.rebindElement(oldEl, newEl, w);
  if (w.scanned.id > 0) {
    idRegistry.rebindRef(w.scanned.id, newEl);
    idRegistry.refreshFingerprint(w.scanned.id, newEl);
  }

  tracker.unobserve(oldEl);
  tracker.observe(newEl);
  resizeObserver.unobserve(oldEl);
  resizeObserver.observe(newEl);

  if (w.hint) w.hint.retarget(newEl);

  w.element = newEl;
  w.disconnectedAt = null;
  w.lastRect = null;
}

const LIMBO_DEADLINE_MS = 250;

/**
 * Move disconnected wrappers into limbo. Per
 * `notes/completed/DESIGN_WRAPPER_IDENTITY_STABILITY.md` steps 1–2, a disconnect
 * no longer immediately tears down the wrapper — codeword and badge are
 * held so a follow-up React render or DOM move can re-attach the same
 * logical identity (step 3+) without churning the codeword pool. The
 * finalize sweeper (`finalizeExpiredLimboWrappers`) reaps any wrapper
 * still disconnected after `LIMBO_DEADLINE_MS`.
 *
 * Returns the count of wrappers that newly entered limbo. Grammar
 * doesn't change on limbo entry (the codeword stays claimed), so callers
 * should NOT use the return value to schedule a grammar push — the
 * sweeper does that when it actually detaches.
 */
function dropDisconnectedWrappers(): number {
  let entered = 0;
  const now = Date.now();
  for (const w of store.all) {
    if (w.disconnectedAt !== null) continue;
    if (!w.element.isConnected) {
      // lastRect is normally already populated by the IntersectionTracker
      // from a recent IO entry. Only fall back to the layout cache for
      // wrappers that disconnected before IO had a chance to fire (race
      // during heavy first-paint mutation churn). If neither has a rect,
      // multi-match rebinds for this wrapper will refuse on distance.
      if (!w.lastRect) w.lastRect = peekCachedRect(w.element);
      enterLimbo(w, now);
      entered++;
    }
  }
  dropDisconnectedCalls++;
  dropDisconnectedFound += entered;
  return entered;
}

let dropDisconnectedCalls = 0;
let dropDisconnectedFound = 0;
let finalizeSweeps = 0;
let finalizeDetached = 0;
let moCallbackInvocations = 0;
let moForeignRecords = 0;
let moRemoveRecordsSeen = 0;
let moHugePathFired = 0;
let processMutationsCalls = 0;
// Discovery-drain reductions (DiscoveryStage step 4). `Deduped` = roots
// dropped because a queued ancestor already covers them; `Skipped` =
// roots whose light DOM held nothing hintable (cheap pre-filter bail).
let discoveryRootsDeduped = 0;
let discoveryRootsSkipped = 0;

// CPU buckets / cpu-share / longtask / watchdog measurement primitives
// live in telemetry/perf-counters.ts (imported at top). recordCpu is the
// injected sink; buildPerfSnapshot reads via computeCpuShare /
// cpuBucketsSnapshot / longtaskSnapshot.

/**
 * Finalize sweeper. Detaches any wrapper whose limbo deadline has
 * elapsed without a rebind. Runs on a fixed interval — short enough
 * that the codeword pool can't be starved by held-but-dead wrappers
 * (worst case: 676 codewords × 250ms ≈ ¼-second blocking window).
 *
 * Increments `refuse_no_match` per finalization. A high rate on a
 * given site suggests the fingerprint is too tight (rebind never finds
 * a match) — see the open question on fingerprint refresh in the
 * design doc.
 */
function finalizeExpiredLimboWrappers(): number {
  const now = Date.now();
  // Iterate a copy so we can mutate `store` mid-loop.
  let finalized = 0;
  for (const w of [...store.all]) {
    if (!isLimboExpired(w, now, LIMBO_DEADLINE_MS)) continue;
    // Defensive de-limbo: if the same DOM node reconnected during the
    // window (rare — React typically swaps to a new element, but plain
    // DOM moves don't), graduate the wrapper back to connected rather
    // than tearing it down. The fingerprint-based rebind (step 3)
    // handles the new-element case.
    if (w.element.isConnected) {
      w.disconnectedAt = null;
      w.lastRect = null;
      continue;
    }
    detachWrapper(w.element);
    rebindCounters.refuse_no_match++;
    finalized++;
  }
  finalizeSweeps++;
  finalizeDetached += finalized;
  if (finalized > 0) schedulePushGrammar();
  return finalized;
}

setInterval(finalizeExpiredLimboWrappers, LIMBO_DEADLINE_MS);

/**
 * Recompute hintability for an element whose attributes changed. Adds,
 * removes, or refreshes its wrapper as needed. Returns true if the store
 * was modified.
 */
function reevaluateAttribute(target: Element): boolean {
  const existing = store.findWrapperFor(target);
  // Order matters: isHintable is the cheap short-circuit. Only run the
  // user-rule exclusion check on elements that already pass.
  const hintable = isHintable(target) && !isExcludedByRule(target, getExcludes());
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

// --- Per-frame coalesce of attribute reevaluations ---
//
// MO attribute records fire one-by-one, and each reevaluateAttribute call
// runs isHintable → isVisible → at least one getBoundingClientRect + one
// getComputedStyle on the element, plus an opacity walk up the parent
// chain. On busy SPAs that's hundreds of forced layouts per second.
//
// Queue the targets, coalesce on the next animation frame, pre-cache
// the union of (target + ancestor chain) layout reads in one batch, and
// run the reevaluations against the warm cache. Net effect: 1 forced
// layout pass per frame instead of 1 per mutation, with ancestor reads
// shared across same-tree mutations within the batch.
//
// Latency: ~16ms between attribute change and wrapper hintability
// update. Inconsequential — the user can't issue a voice command on
// the new state inside a frame.
const pendingReevaluations: Set<Element> = new Set();
let reevaluationFrame: number | null = null;

function scheduleReevaluation(target: Element): void {
  pendingReevaluations.add(target);
  if (reevaluationFrame === null) {
    reevaluationFrame = requestAnimationFrame(drainReevaluations);
  }
}

function drainReevaluations(): void {
  const __cpuStart = performance.now();
  reevaluationFrame = null;
  if (pendingReevaluations.size === 0) return;
  const targets = [...pendingReevaluations];
  pendingReevaluations.clear();
  const __targetCount = targets.length;

  // One batched layout-read pass over targets + their ancestor chains.
  // isVisible's peekCachedRect / peekCachedStyle fall back to live
  // reads (with counter increments) on miss, so this is purely an
  // optimization — correctness doesn't depend on cache presence.
  cacheVisibility(targets);

  let dirty = false;
  try {
    for (const t of targets) {
      if (!t.isConnected) {
        // Element disconnected before we drained; if it had a wrapper
        // detach it. (dropDisconnectedWrappers usually catches this
        // via the childList path, but mutation order may leave it for
        // us when the disconnect was an attribute-only side-effect.)
        if (store.findWrapperFor(t)) {
          detachWrapper(t);
          dirty = true;
        }
        continue;
      }
      if (reevaluateAttribute(t)) dirty = true;
    }
  } finally {
    clearLayoutCache();
  }
  if (dirty) schedulePushGrammar();
  recordCpu('drainReevaluations', performance.now() - __cpuStart);
  if (__targetCount > 0) recordCpu(`drainReevaluations:size:${__targetCount > 1000 ? '1000+' : __targetCount > 100 ? '100-1000' : '<100'}`, __targetCount);
}

// Discovery is the dominant per-mutation cost (scanElements + isHintable
// + getComputedStyle per descendant). On YouTube's initial load we saw
// 673 discoverInSubtree calls in 419ms (~80 MO callbacks/sec, ~20 added
// subtree roots per batch) consuming 84ms of CPU in that window. Rather
// than running each scan synchronously inside the MO callback — which
// is what trips Firefox's unresponsive-script warning — accumulate
// added subtree roots in a Set and drain them via rAF, mirroring the
// existing `scheduleReevaluation` pattern for attribute changes.
//
// Net effect: 80 sync scans/sec → ≤60 batched drains/sec, with the same
// total discovery work amortized across frames so no single task exceeds
// the unresponsive threshold. Side effect: badges for newly-mounted
// elements appear up to one frame (~16ms) later than they used to,
// which is imperceptible in `always` mode (the user's typical setup).
const pendingDiscoveryRoots: Set<Element> = new Set();
let discoveryFrame: number | null = null;

function scheduleDiscovery(root: Element): void {
  pendingDiscoveryRoots.add(root);
  if (discoveryFrame === null) {
    discoveryFrame = requestAnimationFrame(drainDiscovery);
  }
}

// Time-slice budget for a single drain pass. With many queued roots (or
// one heavy root like a freshly-mounted <ytd-app> on YouTube /watch),
// running every discoverInSubtree synchronously in one rAF can blow
// past 16ms and trip Firefox's unresponsive-script warning. Cap the
// per-drain wall time at half a frame; any remaining roots are deferred
// to the next rAF via the same scheduling path. We always do at least
// one root per pass so a single very-expensive root can't permanently
// starve the queue — we'd rather take one expensive frame than freeze
// indefinitely.
const DRAIN_DISCOVERY_BUDGET_MS = 8;

function drainDiscovery(): void {
  const __cpuStart = performance.now();
  discoveryFrame = null;
  if (pendingDiscoveryRoots.size === 0) return;
  const roots = [...pendingDiscoveryRoots];
  pendingDiscoveryRoots.clear();
  const __rootCount = roots.length;

  // Ancestor-dedup: if a queued root is contained by another queued
  // root, the ancestor's discoverInSubtree already deep-walks it. Drop
  // the descendant so we don't walk the same subtree twice — YouTube
  // /watch enqueues nested roots in bursts. parentElement stops at
  // shadow boundaries, so a root inside another's shadow is
  // conservatively kept (redundant, never wrong).
  const rootSet = new Set(roots);
  const workRoots: Element[] = [];
  for (const root of roots) {
    if (hasQueuedAncestor(root, rootSet)) {
      discoveryRootsDeduped++;
      continue;
    }
    workRoots.push(root);
  }

  let dirty = false;
  let processed = 0;
  for (const root of workRoots) {
    processed++;
    // Skip if the subtree got removed between enqueue and drain. The
    // childList path's dropDisconnectedWrappers will have handled any
    // wrappers that already lived inside it.
    if (!root.isConnected) continue;
    // Cheap light-DOM pre-filter: skip the full discovery walk for roots
    // that can't yield a hint. The deep walk (shadow pierce + limbo
    // rebind + custom-element watch) is the expensive part, and on
    // YouTube /watch almost no mutation root contains a hintable.
    // Shadow-hosted hintables arrive via the SHADOW_EVENT path.
    if (!subtreeMaybeHintable(root)) {
      discoveryRootsSkipped++;
      continue;
    }
    if (discoverInSubtree(root) > 0) dirty = true;
    // Yield to the event loop once we've exceeded the budget — but
    // always do at least one root so we make forward progress even when
    // a single root is heavy enough to blow the budget by itself.
    if (performance.now() - __cpuStart >= DRAIN_DISCOVERY_BUDGET_MS) break;
  }
  // Re-queue anything we didn't process this pass; the rAF below picks
  // it up on the next frame. Re-adding to a Set is idempotent so any
  // new arrivals between drain start and now coalesce naturally.
  for (let i = processed; i < workRoots.length; i++) {
    pendingDiscoveryRoots.add(workRoots[i]);
  }
  if (pendingDiscoveryRoots.size > 0 && discoveryFrame === null) {
    discoveryFrame = requestAnimationFrame(drainDiscovery);
  }
  if (dirty) schedulePushGrammar();
  recordCpu('drainDiscovery', performance.now() - __cpuStart);
  if (__rootCount > 0) {
    recordCpu(
      `drainDiscovery:size:${__rootCount > 1000 ? '1000+' : __rootCount > 100 ? '100-1000' : '<100'}`,
      __rootCount,
    );
  }
}

// True if any light-DOM ancestor of `el` is also a member of `set`.
// parentElement deliberately does not cross shadow boundaries.
function hasQueuedAncestor(el: Element, set: Set<Element>): boolean {
  let p = el.parentElement;
  while (p) {
    if (set.has(p)) return true;
    p = p.parentElement;
  }
  return false;
}

function processMutations(records: MutationRecord[]): void {
  const __cpuStart = performance.now();
  processMutationsCalls++;
  let sawRemoval = false;

  for (const m of records) {
    if (m.type === 'childList') {
      for (const node of m.addedNodes) {
        if (isOwnMutation(node)) continue;
        if (node instanceof Element) {
          scheduleDiscovery(node);
        }
      }
      for (const node of m.removedNodes) {
        if (isOwnMutation(node)) continue;
        if (node instanceof Element) {
          moRemoveRecordsSeen++;
          sawRemoval = true;
        }
      }
    } else if (m.type === 'attributes') {
      const target = m.target;
      if (target instanceof Element && !isOwnMutation(target)) {
        scheduleReevaluation(target);
      }
    }
  }

  // Removals are handled in bulk: the moved/removed subtree's descendants
  // would be tedious to diff one by one, but `.isConnected` answers it
  // for free. With limbo, dropDisconnectedWrappers only marks wrappers —
  // grammar push waits for the finalize sweeper, which calls
  // schedulePushGrammar itself when it actually detaches.
  if (sawRemoval) dropDisconnectedWrappers();

  // Grammar push for added subtrees now happens inside drainDiscovery
  // (deferred). Removals still push via dropDisconnectedWrappers above.
  recordCpu('processMutations', performance.now() - __cpuStart);
}

const observer = new MutationObserver((records) => {
  const __cpuStart = performance.now();
  moCallbackInvocations++;
  // Hints are visible — behavior depends on visibility mode.
  // In "manual" mode, defer mutations so codewords don't shuffle while
  // the user is reading badges. hideHints() flushes via doScan().
  // In "always" mode, process mutations incrementally so SPA navigation
  // and dynamic content get badges without requiring escape+re-show.
  if (hintsVisible && getHintVisibility() === 'manual') {
    pendingMutation = true;
    recordCpu('moCallback', performance.now() - __cpuStart);
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
  moForeignRecords += foreign.length;
  if (foreign.length === 0) { recordCpu('moCallback', performance.now() - __cpuStart); return; }

  if (foreign.length >= HUGE_MUTATIONS_COUNT) {
    moHugePathFired++;
    if (hugeMutationTimer) clearTimeout(hugeMutationTimer);
    hugeMutationTimer = setTimeout(() => {
      hugeMutationTimer = null;
      // Limbo entry doesn't change grammar (codewords are still claimed);
      // the finalize sweeper schedules push on actual detach. We only
      // need to push if discovery added new wrappers.
      dropDisconnectedWrappers();
      const added = discoverInSubtree(document.body || document.documentElement);
      if (added > 0) schedulePushGrammar();
      if (hintsVisible) scheduleReposition();
    }, HUGE_MUTATION_IDLE_MS);
    recordCpu('moCallback', performance.now() - __cpuStart);
    return;
  }

  processMutations(foreign);
  // Debounced, not direct: on churny pages (YouTube /watch) this callback
  // fires many times/sec as comments/player/chapters lazy-load during
  // scroll. Each direct scheduleReposition() coalesces only to the next
  // rAF, so reposition still ran ~once/frame on every visible badge —
  // the dominant scroll-time CPU bucket. A mutation batch means "layout
  // may have shifted"; coalescing to one reposition after mutations
  // settle is the same trade already accepted for scroll/resize.
  if (hintsVisible) scheduleDeferredReposition();
  recordCpu('moCallback', performance.now() - __cpuStart);
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

// Remove orphaned badge hosts from a prior content script (extension reload
// re-injects JS but leaves the old script's DOM nodes behind).
for (const old of document.querySelectorAll('[data-branchkit-hint]')) old.remove();

// Scan on load to push initial grammar
doScan();
watchUndefinedCustomElements(document);

// Expose for console debugging
(window as any).branchkitShowHints = () => { doScan(); showHints(); };
(window as any).branchkitHideHints = () => hideHints();
(window as any).branchkitScan = () => { doScan(); return store.all; };
// Snapshot of the wrapper-rebind counters (step 5 instrumentation).
// Returns a fresh copy on each call so callers can take a baseline,
// soak, and diff.
(window as any).branchkitRebindStats = (): RebindCounters => ({ ...rebindCounters });
// Outbound message-volume counters live in telemetry/message-counters.ts.
// Wrap eagerly here so calls from this point on are counted (idempotent).
ensureSendMessageWrapped();

function resetLifecycleCounters(): void {
  dropDisconnectedCalls = 0;
  dropDisconnectedFound = 0;
  finalizeSweeps = 0;
  finalizeDetached = 0;
  moCallbackInvocations = 0;
  moForeignRecords = 0;
  moRemoveRecordsSeen = 0;
  moHugePathFired = 0;
  processMutationsCalls = 0;
  discoveryRootsDeduped = 0;
  discoveryRootsSkipped = 0;
}

// Scan / hintability perf snapshot. Counters are cumulative since CS load
// (or last reset). Useful diff sequence: reset → interact for N seconds →
// read. Surfaces "are we paying 5000 getComputedStyle calls per scan?".
// `advanceShareBaseline` gates the rolling cpu.share window. Only the
// durable 5s ship (shipPerfReport) should advance it; the 250ms live
// publisher must read without consuming the delta, or it cannibalizes
// the window the trail is meant to measure (pct collapses to ~0 and
// share.buckets goes empty — the YouTube-investigation measurement gap).
function buildPerfSnapshot(advanceShareBaseline = false) {
  // Walk the store once to split connected from limbo. Limbo wrappers
  // have `disconnectedAt !== null` — the design's "wrapper held while
  // we wait for a possible rebind" state. A monotonically-climbing
  // limboCount across the leak samples is the signature of a
  // finalize-sweeper that's falling behind.
  let limbo = 0;
  let sentinelDisconnected = 0;
  for (const w of store.all) {
    if (w.disconnectedAt !== null) limbo++;
    else if (!w.element.isConnected) sentinelDisconnected++;
  }
  return {
    ...getPerfCounters(),
    wrapperCount: store.all.length,
    wrapperLimboCount: limbo,
    // Disconnected wrappers that aren't yet in limbo. Should be ≈ 0 in
    // steady state; nonzero means dropDisconnectedWrappers isn't being
    // called between detach and snapshot.
    wrapperDisconnectedOutOfLimbo: sentinelDisconnected,
    lifecycleCounters: {
      dropDisconnectedCalls,
      dropDisconnectedFound,
      finalizeSweeps,
      finalizeDetached,
      moCallbackInvocations,
      moForeignRecords,
      moRemoveRecordsSeen,
      moHugePathFired,
      processMutationsCalls,
      discoveryRootsDeduped,
      discoveryRootsSkipped,
    },
    rebindCounters: { ...rebindCounters },
    messages: messageCountersSnapshot(),
    cpu: {
      // share: rolling CPU share since the prior snapshot publish — the
      // metric Firefox uses to flag "extension is slowing things down."
      // advanceShareBaseline gates the rolling window so only the durable
      // 5s ship advances it; see computeCpuShare in telemetry/perf-counters.
      share: computeCpuShare(advanceShareBaseline),
      buckets: cpuBucketsSnapshot(),
      longtask: longtaskSnapshot(),
      watchdog: watchdogSnapshot(),
    },
    targetRectStore: {
      size: targetRectStore.size,
      subscribers: targetRectStore.subscriberCount,
      drift: targetRectStore.sampleDrift(10),
      scrollAncestors: scrollAncestorStats(),
      // Drift scoped to inner-pane-registered targets (the placement-relevant
      // set) — confirms Phase 5b keeps the store warm where it matters.
      scrollAncestorDrift: targetRectStore.sampleDriftFor(registeredScrollTargets(), 10),
    },
  };
}
(window as any).branchkitPerfStats = buildPerfSnapshot;
(window as any).branchkitResetPerf = (): void => {
  resetPerfCounters();
  resetMessageCounters();
  resetLifecycleCounters();
  resetCpuCounters();
  resetLongtask();
  resetWatchdog();
};
// Cross-world bridge: content script globals live in the isolated world,
// so Playwright's page.evaluate (main world) can't call them directly.
// Mirror the snapshot to a documentElement dataset attribute every 250ms
// so any world can read it. Cheap; the JSON is small (<500B).
function publishPerfSnapshot(): void {
  try {
    document.documentElement.dataset.branchkitPerf =
      JSON.stringify(buildPerfSnapshot());
  } catch { /* dom not ready */ }
}
setInterval(publishPerfSnapshot, 250);
publishPerfSnapshot();

// Periodic ship to the browser plugin's /perf-report endpoint so we have
// a JSONL trail in `~/Library/Application Support/BranchKitDev/plugins/
// browser/extension-perf.jsonl` for offline analysis. The dataset
// publish above is for live in-page inspection; this is the durable
// record. Every 5s is the sample interval — slow enough to be cheap,
// fast enough to bracket a Firefox unresponsive-script event.
function shipPerfReport(): void {
  try {
    const snapshot = buildPerfSnapshot(true);
    const ua = navigator.userAgent;
    const browser = /Firefox\//i.test(ua) ? 'firefox' : /Chrome\//i.test(ua) ? 'chrome' : 'other';
    chrome.runtime.sendMessage({
      type: 'PERF_REPORT',
      url: location.href,
      browser,
      snapshot,
    }).catch(() => {/* extension context may be invalidated */});
  } catch {
    /* extension orphan or chrome.runtime missing */
  }
}
const PERF_REPORT_INTERVAL_MS = 5000;
setInterval(shipPerfReport, PERF_REPORT_INTERVAL_MS);
// Reset trigger from main world — set the dataset to "1" and we reset.
new MutationObserver(() => {
  if (document.documentElement.dataset.branchkitResetPerf === '1') {
    resetPerfCounters();
    resetMessageCounters();
    resetLifecycleCounters();
    resetCpuCounters();
    resetLongtask();
    delete document.documentElement.dataset.branchkitResetPerf;
    publishPerfSnapshot();
  }
}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-branchkit-reset-perf'] });

