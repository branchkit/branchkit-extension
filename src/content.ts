/**
 * BranchKit Browser — Content script entry point.
 *
 * Injected per frame. Scans DOM, creates badges, handles keyboard input.
 * Voice commands arrive via background → BRANCHKIT_ACTION messages.
 */

import { Category, HintVisibility, ScannedElement, Message, DispatchResult } from './types';
import { LabelAssignment, WORD_TO_LETTER, isAlphabetLoaded, setAlphabet } from './labels/words';
import { scanElements, scanSingle, isHintable, isVisible, deepQuerySelectorAll, scanInBatches, DEFAULT_SCAN_BATCH_SIZE, getPerfCounters, resetPerfCounters } from './scan/scanner';
import { ElementWrapper } from './scan/element-wrapper';
import { wantsHint } from './lifecycle/desired-state';
import { computeReconcilePlan, geometryInBand, RECONCILE_BAND_MARGIN_PX } from './lifecycle/reconcile';
import { stampStrictViewport, collectStrictViewportDelta } from './lifecycle/strict-viewport';
import * as idRegistry from './scan/registry';
import type { CodewordMemoryEntry } from './labels/codeword-memory';
import { loadRecall, recalledCodewords, rememberLive, resolvePreferredCodeword, isRecallLoaded } from './labels/codeword-recall';
import { type RebindCounters } from './labels/rebind';
import { resolveTarget } from './activate/activate-resolution';
import { IntersectionTracker } from './observe/intersection-tracker';
import { AttentionObserver } from './observe/attention-observer';
import { initVisibilityTracker, trackPendingCandidate, untrackPendingCandidate, connectVisibilityMO, teardownVisibilityTracker } from './observe/visibility-tracker';
import { initLimbo, rebindCounters, LIMBO_DEADLINE_MS, collectLimboWrappers, collectStrongKeyIndex, dropDisconnectedWrappers, finalizeExpiredLimboWrappers } from './observe/limbo';
import { initWrapperLifecycle, attachWrapper, detachWrapper, seedPreferredFromMemory, reconcileEvictedCodewords, attachDiscovered } from './core/wrapper-lifecycle';
import { initMutationSource, attachPageMutationObserver, teardownMutationSource } from './observe/mutation-source';
import { firehoseStep } from './debug/firehose';
import { bkLog } from './debug/bk-log';
import { store } from './core/store';
import { HintBadge } from './render/hints';
import { reconcilePass, drain as drainReconcilePositioner, reconcileRegistrySize } from './render/reconcile-positioner';
import { onContainerResize } from './observe/container-resize-tracker';
import { onTargetMutation } from './observe/target-mutation-tracker';
import { isOccluded, isOcclusionEnabled, setOcclusionEnabled, applyOcclusion } from './observe/occlusion';
import { reconcileClipObservation, drainClipObservers, setClipObserverEnabled } from './observe/clip-observer';
import { cacheLayout, clearLayoutCache, getCachedRect, isRectOnScreen } from './layout-cache';
import { placeBadges, placeOne, invalidateProbe } from './placement';
import { activateElement, dispatchHover, type ActivationResult } from './activate/event-sequence';
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
import { dispatcher, registry, keyHandler, targetRectStore } from './core/singletons';
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
  matchRules,
  compileRules,
  applyExclusions,
  collectInclusions,
  isExcludedByRule,
  injectRevealStyles,
  type CompiledRule,
  type DomainRule,
  type RuleEntry,
} from './rules/domain-rules';
import { loadDomainRules, onDomainRulesChanged, rulesEqual } from './rules/domain-rules-storage';
import { loadBadgeSettings, onBadgeSettingsChanged } from './badge-settings-storage';
import { setBadgeSizingFromSettings, setScrollAccelEnabled } from './render/hints';
import { isScrollTimelineSupported } from './render/scroll-accel';
import { setNudgesFromSettings } from './placement';
import { labelReservoir } from './labels/label-reservoir';
import { filterNewBatchRefs } from './scan/batch-dedup';
import { resolveHintLocally, reportDispatchResult } from './plugin/resolve';
import { openLivenessPort } from './plugin/liveness';
import { PageSession, TeardownReason } from './lifecycle/page-session';
import { ensureSendMessageWrapped, resetMessageCounters, messageCountersSnapshot } from './debug/message-counters';
import { recordCpu, resetCpuCounters, resetLongtask, resetWatchdog, computeCpuShare, cpuBucketsSnapshot, longtaskSnapshot, watchdogSnapshot, startPerfObservers, lifecycleCounters, resetLifecycleCounters } from './debug/perf-counters';
import { loadConfig, getDisplayMode, getHintVisibility, getHintsShown, setHintsShown } from './config';
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

// Reference-identity check (safe cross-origin — reads no properties). The perf
// trail + live dataset + standing watchdog/longtask observers are diagnostic
// surfaces read only from the top frame; running them in every subframe spends
// the per-frame budget that trips Firefox's slow-extension warning on ad-heavy
// pages (1000+ ad/about:blank frames). Hint machinery still runs in every frame.
const isTopFrame = window === window.top;

// Page-world debug bridge. Each CS instance appends an entry to
// `window.__branchkitDebugJSON` (a string-encoded JSON array) at module-load
// time, so an external inspector (e.g. RDP probing via console.evaluate in the
// page main world) can see how many CS instances are alive in this frame —
// directly detecting the dual-CS race where flushOrphanGuard + lazy-inject get
// past the duplicate guard. On Firefox the page world only sees us through
// `wrappedJSObject` (Xray-vision boundary); object properties set from the
// isolated world aren't transparently readable from the page main world without
// `cloneInto`, so we encode as a primitive string — strings cross the Xray
// boundary cleanly. Failures here are non-fatal: this is diagnostic, not
// load-bearing for any feature.
try {
  const pageWindow = ((window as unknown as { wrappedJSObject?: Window }).wrappedJSObject ?? window) as unknown as {
    __branchkitDebugJSON?: string;
  };
  const csId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const entry = {
    cs_id: csId,
    loaded_at: performance.now(),
    is_top_frame: isTopFrame,
    initial_url: location.href,
  };
  let existing: typeof entry[] = [];
  if (typeof pageWindow.__branchkitDebugJSON === 'string') {
    try { existing = JSON.parse(pageWindow.__branchkitDebugJSON); } catch { existing = []; }
  }
  if (!Array.isArray(existing)) existing = [];
  existing.push(entry);
  pageWindow.__branchkitDebugJSON = JSON.stringify(existing);
} catch {
  // ignore — debug surface only, no behavior depends on it
}

if (isTopFrame) startPerfObservers();

// Lever 1 (frame-skip): a subframe that is about:blank or renders below a
// usable badge size (tracking pixels, collapsed/hidden ad slots) cannot show a
// hint, so it skips the page-wide MutationObserver + initial scan + limbo
// sweeper entirely. On ad-heavy pages ~1000 ad/about:blank frames were each
// running that full machinery — the dominant driver of Firefox's slow-extension
// warning. The top frame is always eligible. about:blank is self-healing:
// navigating it to a real URL re-injects this script fresh, re-running the
// check; a frame that grows past the threshold is woken via ResizeObserver.
const MIN_FRAME_AREA_PX = 2500; // ~50x50 — below this no clickable badge fits
function frameMayHoldHints(): boolean {
  if (isTopFrame) return true;
  if (location.href === 'about:blank') return false;
  return window.innerWidth * window.innerHeight >= MIN_FRAME_AREA_PX;
}
let hintMachineryEnabled = false;

// --- State ---
//
// The stable runtime singletons (store, dispatcher, registry, keyHandler,
// targetRectStore) are constructed in core/ and imported above — see
// notes/DESIGN_EXTENSION_RESTRUCTURE.md (Tier 0).

// Claim-path instrumentation (badge-coverage regression diagnosis).
// A wrapper acquires a codeword from exactly one of two paths; this splits
// them so a snapshot can tell whether the scan path went silent while the
// viewport tracker kept a handful alive.
const claimCounters = {
  scanPathClaimed: 0,
  trackerPathClaimed: 0,
};

// Regime B (DESIGN_CODEWORD_STABILITY phase 2): persist fingerprint→codeword for
// newly-claimed wrappers so a fresh content script after a full-document (Regime B)
// reload can reclaim the same codeword. The fingerprint is already in the registry
// (no recompute). REMEMBER_CODEWORDS is not a pool-mutating message, so it stays
// clear of the reservoir's single-sender invariant. Fire-and-forget.
function rememberClaimedCodewords(claimed: ElementWrapper[]): void {
  const entries: CodewordMemoryEntry[] = [];
  for (const w of claimed) {
    const codeword = w.scanned.codeword;
    if (!codeword || w.scanned.id <= 0) continue;
    const fp = idRegistry.get(w.scanned.id)?.fingerprint;
    if (!fp) continue;
    const r = w.lastRect;
    entries.push({
      fp,
      codeword,
      rect: r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null,
    });
  }
  if (entries.length === 0) return;
  // Live in-session index: lets a wrapper that re-attaches later this session
  // (SPA re-mount outside the limbo-rebind window) reclaim its codeword by
  // fingerprint. Synchronous + in-memory; the SW persist below is the across-
  // reload counterpart.
  rememberLive(entries);
  try {
    chrome.runtime.sendMessage({ type: 'REMEMBER_CODEWORDS', entries } as Message).catch(() => {});
  } catch {
    // Extension context invalidated (orphan post-reload) — best-effort.
  }
}

const tracker = new IntersectionTracker(store, {
  onCodewordsChanged: (claimed, released) => {
    claimCounters.trackerPathClaimed += claimed.length;
    for (const w of claimed) queuePut(w);
    rememberClaimedCodewords(claimed);
    for (const cw of released) {
      // Only enqueue a real Delete if we'd actually told the plugin
      // about this codeword; if the claim happened and immediately got
      // released inside one debounce window, the plugin never saw it.
      if (hasSent(cw)) queueDelete(cw);
    }
    schedulePushGrammar();
    // Build-up reconcile: codewords just landed, so build their badges and
    // re-sweep for any in-band wrapper still missing a claim (closes the
    // claim-gap-after-build window). reconcile guards build on hintsVisible.
    reconcile();
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

// Wire the LabelStage's catchup sync to content.ts-owned collaborators.
// detachWrapper is imported from core/wrapper-lifecycle; reconcile is a hoisted
// declaration; store is imported; the visibility flag (pageSession.hintsVisible)
// is read lazily via the arrow. Catchup-built badges converge through the single
// reconcile entry.
initLabelSync({
  store,
  detachWrapper,
  reconcile,
  isHintsVisible: () => pageSession.hintsVisible,
});

let activeCategory: Category | null = null;
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

function applyMatchedRules(matched: DomainRule[]): void {
  // Sweep any prior reveal stylesheet — covers both our previous match
  // and orphan nodes left by an earlier content-script generation
  // (extension reload re-injects JS but leaves the DOM).
  for (const old of document.querySelectorAll('style[data-branchkit-reveal]')) {
    old.remove();
  }
  if (matched.length === 0) {
    compiledRule = null;
    return;
  }
  compiledRule = compileRules(matched);
  const style = injectRevealStyles(compiledRule.reveals);
  if (style && document.head) document.head.appendChild(style);
}

if (typeof chrome !== 'undefined' && chrome.storage?.sync) {
  loadDomainRules().then((rules) => {
    const matched = matchRules(window.location.href, rules);
    applyMatchedRules(matched);
    if (matched.length > 0) {
      scheduleDoScan();
      schedulePushGrammar();
    }
  });

  onDomainRulesChanged((rules) => {
    const nextMatched = matchRules(window.location.href, rules);
    // Skip if THIS frame's matched rule SET is unchanged — a user editing
    // *.github.com's rule shouldn't trigger a re-scan stampede on every
    // quickbase.com tab.
    if (rulesEqual(nextMatched, compiledRule?.rules ?? [])) return;
    applyMatchedRules(nextMatched);
    if (compiledRule) {
      for (const w of [...store.all]) {
        if (isExcludedByRule(w.element, compiledRule.excludes)) detachWrapper(w.element);
      }
    }
    scheduleDoScan();
    schedulePushGrammar();
  });

  // Badge appearance settings — read once at startup, then live-update on
  // change. On change we detach every wrapper so the next doScan() rebuilds
  // badges with the new font size / nudge values (badge dimensions and
  // initial CSS are cached per-instance — wholesale rebuild is the
  // simplest path to a clean re-render).
  loadBadgeSettings().then((s) => {
    setBadgeSizingFromSettings(s);
    setNudgesFromSettings(s);
  });
  onBadgeSettingsChanged((s) => {
    setBadgeSizingFromSettings(s);
    setNudgesFromSettings(s);
    for (const w of [...store.all]) detachWrapper(w.element);
    scheduleDoScan();
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

// Hints appear on their own — on a fresh page or after an action — only in
// "always" mode AND when the user hasn't switched them off with F. "manual"
// mode never auto-shows; an F-hide suppresses always-mode auto-show globally.
function shouldAutoShowHints(): boolean {
  return getHintVisibility() === 'always' && getHintsShown();
}

// Bring this frame's visibility in line with the persisted F state. Run once
// after hintsShown loads at boot (corrects a racing boot-time auto-show when
// the persisted state was an F-hide). Hides on F-off; shows on F-on only in
// always mode (manual reveals are per-page and must not auto-show here).
function applyHintsShownState(): void {
  if (!getHintsShown()) {
    if (pageSession.hintsVisible) hideHints();
  } else if (getHintVisibility() === 'always' && !pageSession.hintsVisible) {
    doScan();
    showHints();
  }
}

loadConfig({
  onDisplayModeChange: () => {
    if (pageSession.hintsVisible) updateBadgeLabels();
  },
  onHintVisibilityChange: () => {
    const v = getHintVisibility();
    if (v === 'always') {
      // Re-picking "Always visible" is an explicit show intent — clear any
      // prior F-hide so hints come back (and stay back on later pages).
      setHintsShown(true);
      if (!pageSession.hintsVisible) showHints();
    } else if (v === 'manual' && pageSession.hintsVisible) {
      hideHints();
    }
  },
  onHintsShownLoaded: () => applyHintsShownState(),
  onAggressiveHintsChange: () => {
    // Clear the store so already-hinted elements that no longer qualify
    // get torn down, then re-scan with the new selector breadth.
    store.clear();
    scheduleDoScan();
  },
});

// Warm the per-frame label reservoir so the first scan's batch claim has
// codewords on hand without waiting for the SW round-trip.
//
// Gated to `frameMayHoldHints()` so the 1000+ ad/about:blank subframes on
// heavy pages don't each fire CLAIM_LABELS for 100 codewords from a 676-
// codeword pool — that storm exhausts the pool, swamps the SW with
// serialized tab-lock IPCs, and contributes to Firefox's "extension is
// slowing your browser" warning. Frames that grow past the eligibility
// threshold later get warmed inside `activateHintMachinery` below.
if (typeof chrome !== 'undefined' && chrome.runtime && frameMayHoldHints()) {
  // Regime B (phases 3-4): load this frame's codeword memory FIRST, then warm
  // the reservoir requesting the remembered codewords as `preferred` so the
  // initial fill reclaims them (the SW grants the ones still free in the pool).
  // Loading recall before the (single) warm-up means wrappers never get an
  // arbitrary codeword they'd later swap — no flicker. Wrappers that claim
  // before the fill lands hit the empty reservoir, return '', and are
  // re-claimed by the level-triggered reconcile once the remembered codewords
  // are in the reservoir. Wrappers attached after recall are seeded inline by
  // attachWrapper; the sweep covers those attached during the in-flight fetch.
  void loadRecall().then(() => {
    void labelReservoir.ensureReady(recalledCodewords());
    for (const w of store.all) seedPreferredFromMemory(w);
  });
}

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
      // Reservoir codewords were built from the old alphabet; SW already
      // wiped the central pool, so even sending the old strings back as
      // RELEASE_LABELS would be a no-op. Clear locally and re-fetch.
      labelReservoir.clear();
      void labelReservoir.ensureReady();
      // Problem 3 (notes/DESIGN_OPTION_B_REATTEMPT.md): the previous
      // alphabet's codewords are now invalid, and the plugin still
      // holds them in `browser_hints_<old-prefix>` for this frame.
      // Rotate the session_id so the plugin's ensureFrameSession sees
      // a session change → cleanupFrameSessionLocked clears stale
      // per-prefix entries. This is the ONE place in a content
      // script's lifetime where we want plugin-side cleanup.
      // Plugin clears its per-frame session on session_id change, so the
      // delta-sync mirror state on this side is now stale; rotateSession
      // rotates the id and resets it. The subsequent reconcile() will
      // re-claim codewords for in-viewport wrappers and onCodewordsChanged
      // will re-queue them as pending Puts.
      rotateSession();
      for (const w of store.all) {
        w.scanned.codeword = '';
        w.label = null;
        // Every wrapper's codeword is invalidated — voice layer goes back
        // to pending until each wrapper's fresh codeword gets a grammar
        // ACK from the plugin.
        w.grammarReady = false;
        if (w.hint) {
          w.hint.remove();
          w.hint = null;
        }
      }
      reconcile();
      if (pageSession.hintsVisible) {
        // Re-render once the new codewords land.
        tracker.flushNow().then(() => {
          if (pageSession.hintsVisible) showHints(activeCategory ?? undefined);
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
      // Ineligible frame (tiny/about:blank subframe): no initial scan. If it
      // later grows past the threshold the wake-on-resize path runs doScan.
      if (!hintMachineryEnabled) return;
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
        // Coalesced — any domain-rules-change or badge-settings-change
        // event that arrived in the same tick will fold into this scan
        // instead of triggering a second back-to-back doScanBatched.
        scheduleDoScan();
        if (shouldAutoShowHints()) {
          whenDOMSettles(() => {
            tracker.flushNow().then(() => {
              if (shouldAutoShowHints() && !pageSession.hintsVisible) showHints();
            });
          });
        }
      }, 0);
    }
  });
}

// Adopt the inner-scroll accelerator flag (notes/DESIGN_INNER_SCROLL_ACCELERATOR.md).
// Default ON: the accelerator is the validated wiggle fix, so only an explicit
// `bkScrollAccel: false` disables it (escape hatch). It still requires
// ScrollTimeline support at arm time, so this never activates on Firefox stable —
// it falls back to the JS chase there with no errors. Read once at load
// (per-machine, like the alphabet); the user reloads to change it.
if (typeof chrome !== 'undefined' && chrome.storage?.local) {
  chrome.storage.local.get('bkOcclusion', (result) => {
    // Occlusion filtering (notes/DESIGN_HINT_OCCLUSION_FILTERING.md). NEW + high
    // blast radius (false positives would hide real badges), so default OFF until
    // soaked — only an explicit `true` enables it. Flip on to test via
    // `chrome.storage.local.set({ bkOcclusion: true })`.
    setOcclusionEnabled(result.bkOcclusion === true);
    document.documentElement.setAttribute('data-bk-occlusion', result.bkOcclusion === true ? 'on' : 'off');
  });
  chrome.storage.local.get('bkClipObserver', (result) => {
    // Scroll-container clip detection (IO-root=scroller, Rango's idea). NEW
    // prototype, default OFF; enable with `chrome.storage.local.set({ bkClipObserver: true })`.
    // Separate flag from bkOcclusion so the IO-clip path can be A/B'd against the
    // elementFromPoint overlay path; they compose when both are on.
    setClipObserverEnabled(result.bkClipObserver === true);
    document.documentElement.setAttribute('data-bk-clip-observer', result.bkClipObserver === true ? 'on' : 'off');
  });
  chrome.storage.local.get('bkScrollAccel', (result) => {
    const enabled = result.bkScrollAccel !== false;
    setScrollAccelEnabled(enabled);
    // Page-visible diagnostic marker on <html>: lets the user confirm from the
    // ordinary page console (no content-script context switch) whether the
    // accelerator can engage. 'on' = flag set + ScrollTimeline supported;
    // 'unsupported' = flag set but no ScrollTimeline (Firefox stable); 'off' =
    // flag not set. Pair with `document.querySelectorAll('[data-bk-accel]').length`
    // to count badges that actually armed.
    document.documentElement.setAttribute(
      'data-bk-scroll-accel',
      enabled ? (isScrollTimelineSupported() ? 'on' : 'unsupported') : 'off',
    );
  });
}

// --- Register Commands (Slice B) ---

// `f` toggles hint visibility. `F` (shift-F) always shows with the new-tab
// activation modifier armed — so pressing F while hints are already up
// switches the activation target into new-tab mode without hiding first.
// Escape used to bind to hide_hints, but Escape has browser-native
// semantics (close modal, blur input, cancel find) that we shouldn't
// shadow. Voice "hide" still works via the BRANCHKIT_ACTION pathway.
registry.add({ keys: 'f', action: 'toggle_hints' });
registry.add({ keys: 'F', action: 'show_hints_newtab' });

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

// `f` toggle: branches on the live visibility state. Hides when shown,
// shows when hidden. Keeps the new-tab modifier untouched so a stray
// toggle doesn't re-arm new-tab activation. Voice "show"/"hide" continue
// to route through the dedicated handlers above; this is the keyboard
// affordance for users in manual visibility mode.
dispatcher.register('toggle_hints', () => {
  if (pageSession.hintsVisible) {
    hideHints();
    keyHandler.exitHintMode();
    setHintsShown(false);  // sticky: stay hidden across navigation
  } else {
    doScan();
    showHints();
    keyHandler.enterHintMode();
    setHintsShown(true);
  }
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
  if (!pageSession.hintsVisible) return;

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
    .filter(w => isRectOnScreen(w.element.getBoundingClientRect(), vw, vh))
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
      // detachWrapper emits a store detach delta → grammar sync (Tier 2).
      detachWrapper(el);
      continue;
    }
    // Phase 5 (router-via-RO): the engine just resized this element. The
    // read here follows the layout pass it triggered, so it's warm.
    targetRectStore.write(el, el.getBoundingClientRect());
  }
});

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

const attentionObserver = new AttentionObserver({
  onEnter: (el) => {
    if (!el.isConnected) return;
    if (store.findWrapperFor(el)) return;
    const scanned = scanSingle(el);
    if (scanned) {
      // attachWrapper emits a store attach delta → grammar sync (Tier 2).
      attachWrapper(new ElementWrapper(el, scanned));
      return;
    }
    // Still not hintable (visibility:hidden, opacity:0, etc.). Bounded
    // by attention region — only stays in the recheck loop while near
    // the viewport. visibilityMO watches for class/style flips that
    // make it hintable.
    trackPendingCandidate(el);
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
    untrackPendingCandidate(el);
  },
  onRect: (el, rect) => {
    targetRectStore.write(el, rect);
  },
});

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
// Promise-chain lock for doScanBatched. Multiple call sites (chrome.storage
// onChanged for alphabet/rules/badge settings; MO settle; focus restore; nav
// recovery; explicit triggers from messages) can fire within the same tick.
// Pre-fix the chained scans overlapped: each got the same getSessionId(),
// each ran its own batch generator, and they posted batches with overlapping
// batch_indices. The plugin processed both, and the same DOM element ended
// up with two distinct wrappers each holding a different "real" codeword —
// either neither could cleanly invalidate the other or, depending on
// attach-order timing, the same codeword landed on two wrappers. QuickBase
// table virtualization reliably reproduced this 2026-06-05T17:00:42.
//
// Pattern: one scan runs at a time; if more triggers arrive while a scan is
// in flight, they collapse into a single pending re-run that fires after
// the current scan completes. Two triggers that arrive during one in-flight
// scan still produce only one re-run — the scheduling is idempotent for the
// pending slot.
let scanChain: Promise<void> = Promise.resolve();
let scanPending = false;
function doScan(): Promise<void> {
  // If a scan is in flight and another is already pending, fold this
  // trigger into the existing pending re-run.
  if (scanPending) return scanChain;
  scanPending = true;
  scanChain = scanChain.then(async () => {
    // Clear the pending flag at the START of the run, so triggers that
    // arrive DURING this scan can schedule the next re-run. Triggers that
    // arrived before we got here have already been folded; the flag's
    // role from here forward is "is the NEXT slot taken."
    scanPending = false;
    try {
      await doScanBatched();
    } catch {
      // Swallow so a failed scan doesn't break the chain. The next
      // trigger still gets a fresh attempt.
    }
  });
  return scanChain;
}

/**
 * Coalesce multiple doScan triggers that fire close together (storage
 * onChanged for alphabet + domain rules + badge settings all delivered
 * within a tick is the common case) into a single rescan. Without this,
 * each storage event runs its own ~500-900 ms doScanBatched and the user
 * sees a back-to-back stall pair right at page load. The 50 ms window is
 * tight enough to feel immediate but wide enough to fold all chrome
 * storage events from one logical change.
 *
 * Callers that need the scan to have completed before continuing should
 * still call doScan() directly. The chrome.storage listeners do not —
 * they kick the scan and let the rest of the page-state recovery (DOM
 * settle, show, etc.) wait on its own timers.
 */
let doScanCoalesceTimer: ReturnType<typeof setTimeout> | null = null;
const DO_SCAN_COALESCE_MS = 50;
function scheduleDoScan(): void {
  if (doScanCoalesceTimer) return;
  doScanCoalesceTimer = setTimeout(() => {
    doScanCoalesceTimer = null;
    doScan();
  }, DO_SCAN_COALESCE_MS);
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

  // pageSession.hintsVisible is the mode flag — "user wants hints showing." Set it
  // even when the store has nothing to paint right now so subsequent
  // wrappers arriving via the batched scan (or MutationObserver
  // discovery) paint via badgeNewlyCodeworded, which is pageSession.hintsVisible-
  // gated. Under the old whole-grammar path the store was always
  // populated by the time showHints fired, so an empty return here
  // never mattered; under batched mode the scan is async and showHints
  // can race ahead of the first batch landing.
  if (allTargets.length === 0) {
    pageSession.hintsVisible = true;
    return;
  }

  // Filter to viewport-visible and sort by position (same as grammar push)
  const targets = viewportSort(allTargets);
  if (targets.length === 0) {
    pageSession.hintsVisible = true;
    return;
  }

  // Only render hints for elements that received a pool codeword.
  // Elements without one wouldn't be voice-addressable and their badge
  // would say "?" — better to leave them unhinted.
  const renderable = targets
    .slice(0, MAX_BADGE_COUNT)
    .filter(w => w.scanned.codeword.length > 0);

  // Breadcrumbs around the heavy per-batch paint: HintBadge construction
  // (shadow root + DOM per badge) + placeBadges layout reads. Suspected wedge
  // on heavy SPA targets (YouTube /@channel/videos with 80+ badges).
  firehoseStep('showHints:start', renderable.length, 20);
  cacheLayout(renderable.map(w => w.element));
  firehoseStep('showHints:cache_end', renderable.length, 20);
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

      wrapper.hint.show(wrapper.grammarReady);
    }
    firehoseStep('showHints:mount_end', renderable.length, 20);

    // Ensure visibilityMO is running so the throttled recheckHintedVisibility
    // catches class/style-driven visibility transitions (YouTube controls
    // fading out, etc.). Idempotent — no-op if already connected, just
    // refreshes the abandon timer. The recheck itself runs at most every
    // 100ms; this just keeps the MO active to feed it.
    if (renderable.length > 0) connectVisibilityMO();

    const __pbStart = performance.now();
    try { placeBadges(renderable); } finally {
      recordCpu('placeBadges:show', performance.now() - __pbStart);
      firehoseStep('showHints:place_end', renderable.length, 20);
    }
    // Write-on-paint: seed the store with each painted target's current rect
    // from the warm cache. The attention IO writes targets at band-entry time
    // (often a stale position by the time they paint); this corrects it on
    // paint so the store is warm without the blanket sweep.
    for (const w of renderable) targetRectStore.write(w.element, getCachedRect(w.element));
  } finally {
    clearLayoutCache();
  }
  pageSession.hintsVisible = true;
  // showHints painted only the strict-viewport `renderable` slice. Converge
  // the rest of the desired set: build badges for in-band (200px IO margin)
  // codeworded wrappers that fell outside the strict viewport — the
  // noHintObject set that otherwise stayed hintless until the next scroll.
  reconcile();
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
  pageSession.hintsVisible = false;
  activeCategory = null;
  for (const w of store.all) {
    w.hint?.hideLeader();
    w.hint?.hide();
  }

  // Catch up on DOM changes that occurred while hints were visible
  if (pageSession.pendingMutation) {
    pageSession.pendingMutation = false;
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
    if (!shouldAutoShowHints()) return;
    doScan();
    showHints();
  }, HINT_REFRESH_DELAY_MS);
}

// The build step of the reconciler. Called only by reconcile() — no longer an
// independent edge-triggered backstop. Builds badges for every wrapper that
// wants a hint (in-band, codeworded, category-matched) but lacks one.
function badgeNewlyCodeworded(): void {
  const newBadges: ElementWrapper[] = [];
  for (const w of store.all) {
    // Delta against desired state: wants a hint but isn't currently
    // visible. With hint reuse (DESIGN_HINT_REUSE.md), a wrapper's
    // `w.hint` persists across viewport exit/re-enter cycles, so the old
    // `!w.hint` filter would skip every dormant hint forever. The new
    // filter catches both first-time hints (w.hint absent) and reused
    // dormant hints (w.hint present but hidden + cleared).
    if (wantsHint(w, activeCategory) && !w.hint?.isVisible) {
      newBadges.push(w);
    }
  }
  if (newBadges.length === 0) return;

  const existingCount = store.all.filter(w => w.hint?.isVisible).length;

  try {
    cacheLayout(newBadges.map(w => w.element));
    const vw = window.innerWidth, vh = window.innerHeight;
    for (let i = 0; i < newBadges.length; i++) {
      const w = newBadges[i];
      const label = poolLabelToAssignment(w.scanned.codeword);
      w.label = label;
      const onScreen = isRectOnScreen(getCachedRect(w.element), vw, vh);
      // Restore the label on an existing dormant (scroll-back) hint even when
      // the element is off the actual viewport. A dormant hint was clearLabel()d
      // on viewport exit; if its codeword is re-granted while it sits in the
      // 200px IO band but below/above the viewport, skipping the label here (the
      // 116b321 regression) leaves it null — and recheckHintedVisibility shows it
      // as an empty box when it later scrolls in. The label is just data on a
      // hidden badge; only show()/placement waits for the actual viewport.
      if (w.hint) {
        w.hint.setLabel(label);
      }
      // Don't construct/paint a badge for an element that's in the 200px IO band
      // but off the actual viewport (e.g. YouTube's collapsed nav drawer at
      // x=-228); placement would clamp it to the edge. It keeps its codeword +
      // (restored) label and paints when it scrolls on-screen.
      if (!onScreen) continue;
      // Slow path (first-time): construct the badge. The reuse fast path above
      // skips shadow DOM creation, observer wire-up, anchorParent walk, z-index
      // walk, and APCA color recomputation — ~5-10ms per badge on scroll-back.
      if (!w.hint) {
        w.hint = new HintBadge(w.element, label, w.category, getDisplayMode());
      }
      w.hint.show(w.grammarReady);
      placeOne(w, existingCount + i);
      targetRectStore.write(w.element, getCachedRect(w.element)); // write-on-paint
    }
  } finally {
    clearLayoutCache();
  }
}

// Build-up half of the level-triggered lifecycle reconciler (Phases 3+5 of
// notes/completed/DESIGN_HINT_LIFECYCLE_RECONCILER.md). This is THE single convergence
// entry for {codeword, hint} — every edge trigger (codewords-changed, nav-
// settle, alphabet-change, label-sync catchup, focus/transition settle) routes
// here rather than poking the claim or build step directly. `refreshViewportClaims`
// and `badgeNewlyCodeworded` are now reconcile-owned steps, not independent
// backstops. Idempotent:
//   - claim: queue in-band wrappers that lack a codeword. The pool RPC is
//     async; its completion re-enters here via onCodewordsChanged, so each pass
//     builds whatever is currently buildable and queues the rest. Pool-
//     exhausted claims don't re-fire the callback (doFlush gates on `dirty`),
//     so this converges rather than spins.
//   - build: construct badges for in-band codeworded wrappers that lack one —
//     the set showHints' strict-viewport slice leaves behind (the noHintObject
//     root): they sit in the 200px IO band but outside the strict viewport, so
//     showHints never built them and nothing rebuilt until a scroll.
// Tear-down is the separate gBCR pass `reconcileTeardown` (Phase 4); the IO
// viewport-exit remains the cheap fast-path. Keep reconcile gBCR-free — it runs
// on the frequent onCodewordsChanged cadence and the coalesced scheduleReconcile.
// Reattach step of the reconciler: a hint whose host the page stripped out of
// the DOM while the target element survives. SPA-heavy sites (YouTube on the
// nesting path) continuously remove our nested badge hosts from inside their
// managed subtrees — the target lives on but the badge child is yanked. The
// host object is intact, so the build step skips it (`w.hint` is non-null);
// this clause re-appends the existing host and re-places it.
//
// This replaces the standalone badgeReattachObserver + its per-badge rate
// limiter + host-level circuit breaker. Those stopgaps existed because the
// observer was edge-triggered and fired DURING the page's strip storm (~560
// reattaches/sec at peak), so it had to throttle itself to avoid wedging the
// renderer. The reconcile pass is debounced instead (scheduleReconcile / the
// scheduleDeferredReposition settle): a host that strips every frame never lets
// the mutation storm settle, so reconcile simply doesn't fire until it stops —
// no spin, no rate limiter, no circuit breaker needed. Each pass is one bounded
// O(detached) reattach. Reattach appends a `data-branchkit-hint` host, which
// isOwnMutation filters out of the main firehose, so it can't self-feed.
function reattachStrippedHosts(): void {
  let reattached = 0;
  for (const w of store.all) {
    if (!w.hint || w.hint.host.isConnected) continue;
    // Target gone — don't reattach an orphan; let teardown tidy up.
    if (!w.element.isConnected) continue;
    w.hint.reattach();
    w.hint.reposition();
    reattached++;
  }
  if (reattached > 0) firehoseStep('reconcile:reattach', reattached, 1);
}

function reconcile(): void {
  tracker.refreshViewportClaims();
  if (pageSession.hintsVisible) {
    badgeNewlyCodeworded();
    reattachStrippedHosts();
  }
}

// Coalesced entry for high-frequency edge signals (focus/transition/resize
// settle): a 100ms debounce collapses a churny burst into one reconcile so we
// act on real {claim, build} deltas only — the steady state is a cheap O(store)
// no-op walk; grammar churn happens solely when a genuinely new in-band wrapper
// needs a codeword. Sites needing synchronous flush→showHints ordering (nav,
// alphabet) call reconcile() directly instead.
function scheduleReconcile(): void {
  if (pageSession.reconcileTimer) return;
  pageSession.reconcileTimer = setTimeout(() => {
    pageSession.reconcileTimer = null;
    reconcile();
  }, DEFERRED_REPOSITION_DEBOUNCE_MS);
}

// Tear-down + missed-enter backstop for the lifecycle reconciler (Phase 4 of
// notes/completed/DESIGN_HINT_LIFECYCLE_RECONCILER.md). The IO entry/exit
// branches are the cheap fast-path; this is the authoritative backstop for
// dropped/reordered IO events that leave `isInViewport` desynced in EITHER
// direction:
//
//   stale-TRUE  (flag=in,  geometry=out) → release codeword + tear down hint
//   stale-FALSE (flag=out, geometry=in)  → flip flag to true; next reconcile
//                                          will re-claim a codeword and rebuild
//                                          the hint
//
// The stale-FALSE case shows up on YouTube post-scroll: a video tile wrapper
// scrolled out (codeword released, hint went dormant via hint reuse), then
// scrolled back in but the IO never re-fired enter (mutation-storm dropped it,
// or YouTube reparented the element through a structure the IO didn't follow).
// Without this correction the wrapper stays stuck — `wantsCodeword` reads the
// stale flag, `refreshViewportClaims` skips it, and the dormant hint never
// gets re-shown.
//
// Cost discipline (the wedge guard): fresh getBoundingClientRect runs over the
// bounded hinted set (visible + dormant — both are scroll-history-bounded by
// the IO-exit-marks-dormant path); we never sweep the full store. Reads are
// batched read-all-then-act so we don't interleave a layout read with a write.
// Phase 2 noted `band.staleFalse` was unreliable from the warm rect store, so
// we read FRESH geometry here — that constraint applies to the warm store, not
// to the gBCR pass.
function reconcileTeardown(): void {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // Include dormant reused hints (DESIGN_HINT_REUSE.md): they were torn down
  // by an IO exit but the badge object survived for scroll-back. If the user
  // scrolled them back in and the IO missed the enter, the wrapper has
  // `isInViewport=false` + no codeword + dormant hint — exactly the stale-FALSE
  // signature. We need them in the set to detect and fix that.
  const hinted = store.all.filter(w => w.hint && w.disconnectedAt === null);
  if (hinted.length === 0) return;

  // Read all geometry first…
  const offBand: ElementWrapper[] = [];
  const missedEnter: ElementWrapper[] = [];
  for (const w of hinted) {
    const r = w.element.getBoundingClientRect();
    const inBand = geometryInBand(r, vw, vh, RECONCILE_BAND_MARGIN_PX);
    if (inBand) {
      // Stale-FALSE candidate: IO flag says out but geometry says in.
      // Only act when the flag actually disagrees with geometry; in-band
      // hints with the flag correctly TRUE are the steady state we skip.
      if (!w.isInViewport) missedEnter.push(w);
    } else {
      // Stale-TRUE candidate (visible hints only — dormant hints have already
      // released their codeword and torn down on the IO exit; releasing again
      // would be a no-op + an unnecessary scheduleFlush).
      if (w.hint?.isVisible) offBand.push(w);
    }
  }
  // …then act.
  for (const w of offBand) {
    w.isInViewport = false;
    tracker.queueRelease(w);
  }
  for (const w of missedEnter) {
    w.isInViewport = true;
  }
  // If we corrected any stale-FALSE flags, run reconcile so the just-recovered
  // wrappers go through claim + build (refreshViewportClaims gates on the
  // flag, so the fix has to land before reconcile reads it).
  if (missedEnter.length > 0) reconcile();
}

// Strict-viewport reconciler: scroll moves wrappers across the strict/band
// boundary without changing their codeword. The plugin's `_strict` companion
// collection (which now drives both voice matching and the Discovery HUD)
// reflects the last-pushed strict-viewport flag, so a wrapper that scrolled
// into strict — or out of strict but still in band — needs a re-push for
// the _strict membership to converge. Walks the store, queues any wrapper
// whose current strict status differs from the last-sent value, and triggers
// a debounced sync. Codeword set is unchanged; this is a flag refresh.
function reconcileStrictViewport(): void {
  const delta = collectStrictViewportDelta(store.all);
  if (delta.length === 0) return;
  firehoseStep('strict-viewport:delta', delta.length, 1);
  for (const w of delta) queuePut(w);
  scheduleSync('strict-viewport-change');
}

// Occlusion pass (notes/DESIGN_HINT_OCCLUSION_FILTERING.md). Hit-test each
// visible in-band badge: if its target is covered by another element, hide the
// badge (visual) and flag the wrapper occluded so the strict-viewport pass that
// follows drops it from the voice-matchable `_strict` collection (voice). Runs
// from the same debounced settle handlers as reconcileStrictViewport, BEFORE it,
// so collectStrictViewportDelta reads a fresh `occluded`. No-op when the
// bkOcclusion flag is off (isOccluded short-circuits → nothing ever flips).
//
// Batched read-then-write: all elementFromPoint reads first (one layout flush),
// then the setOccluded class writes — so a hide doesn't dirty layout between
// hit-tests. IO-gated to the visible set (hidden/off-band badges aren't painted,
// so occlusion is moot) to keep the synchronous reads bounded.
function reconcileOcclusion(): void {
  if (!isOcclusionEnabled()) return;
  // Read pass: hit-test all visible in-band badges, record the overlay signal.
  const candidates: ElementWrapper[] = [];
  for (const w of store.all) {
    if (!w.hint || !w.hint.isVisible || !w.isInViewport || !w.element.isConnected) continue;
    w.overlayCovered = isOccluded(w.element);
    candidates.push(w);
  }
  // Write pass: fold into the effective state (composes with the clip signal).
  let changed = 0;
  for (const w of candidates) if (applyOcclusion(w)) changed++;
  if (changed > 0) firehoseStep('occlusion:delta', changed, 1);
}

// Run `cb` on the next idle frame, falling back to a short timeout where
// requestIdleCallback is unavailable (Firefox content scripts historically).
// `timeoutMs` caps the idle wait so a pathologically busy page still runs it.
function runWhenIdle(cb: () => void, timeoutMs: number): void {
  const ric = (window as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void })
    .requestIdleCallback;
  if (typeof ric === 'function') ric(cb, { timeout: timeoutMs });
  else setTimeout(cb, 100);
}

const DISCOVERY_SWEEP_IDLE_TIMEOUT_MS = 500;

// Discover step of the level-triggered reconciler (Phase 3b of
// notes/completed/DESIGN_HINT_LIFECYCLE_RECONCILER.md). `reconcile()` converges
// {codeword, hint} over EXISTING wrappers; it cannot close the *discovery gap*
// — a hintable element that entered the DOM while the MutationObserver
// dropped/coalesced its insertion record under YouTube's mutation storm, so no
// wrapper was ever created. This backstop re-walks the document via the
// sliced/batched discovery (the same wedge-safe path the nav rescan uses — it
// yields between batches and skips known elements via `isKnown`), idempotently
// attaching any missed hintable. attachDiscovered skips elements that already
// have a wrapper, so a steady-state sweep attaches nothing and claims nothing
// (no grammar churn); only a genuinely-missed element drives a claim + build.
//
// Single-flight + idle-scheduled: scroll-settle fires repeatedly on a long
// scroll, so we keep at most one sweep in flight (`discoverySweepPending`) and
// coalesce the rest. A coalesced request can mean a row was re-rendered DURING
// the in-flight sweep (after the sweep's enumeration pass already passed over
// that region), so we record the coalesce on `discoverySweepRerun` and, in the
// `finally`, conditionally re-arm — but ONLY when the sweep added nothing AND
// a coalesce happened (strongest signal of a race-missed node). When the sweep
// added nodes, we DO NOT retry: reconcile()/showHints() can ripple into more
// scroll-settles and chained reruns produced the codeword-churn loop the
// earlier retry attempt was reverted for. Retries are also depth-capped and
// cooldown-gated so even worst-case the chain terminates quickly.
// requestIdleCallback waits for a quiet frame so the DOM walk never lands on
// top of YouTube's reflow (the wedge guard); the timeout caps the wait.
// Mirrors the nav-rescan deferred-scan tail.
//
// Distinct from `scheduleDiscovery(root)` (the rAF-coalesced drainer for
// subtree roots the MutationObserver DID see): this is the backstop for the
// records it DIDN'T.
const DISCOVERY_RETRY_COOLDOWN_MS = 300;
const DISCOVERY_MAX_RETRY_DEPTH = 2;
function scheduleBandDiscovery(): void {
  if (pageSession.discoverySweepPending) {
    pageSession.discoverySweepRerun = true;
    firehoseStep('band_discovery:coalesced', 1);
    return;
  }
  pageSession.discoverySweepPending = true;
  pageSession.discoverySweepRerun = false;
  runWhenIdle(() => {
    void (async () => {
      let added = 0;
      try {
        if (pageSession.isTornDown || !document.body) return;
        added = await discoverInSubtreeBatched(document.body);
        // Diagnostic: the sweep's added count INCLUDING zero, to correlate a
        // miss against whether the walk actually attached anything.
        firehoseStep('band_discovery:added', added, 0);
        if (added === 0) return;
        // New wrappers landed: claim codewords for the in-band ones and build
        // their badges (reconcile), flush the claims, then paint.
        reconcile();
        await tracker.flushNow();
        if (pageSession.hintsVisible) await showHints(activeCategory ?? undefined);
      } finally {
        pageSession.discoverySweepPending = false;
        // Conditional re-arm: retry only when (a) a coalesce happened during this
        // sweep — without it there's no evidence a race occurred — AND (b) this
        // sweep added zero new wrappers, which means the work we did do is NOT
        // the source of any churn the retry might amplify. Retries when added>0
        // chained the codeword-churn loop in 73cf6e7 → b813e29. Cap depth + add
        // cooldown so even a pathological scroll settle pattern terminates.
        const shouldRetry =
          pageSession.discoverySweepRerun &&
          added === 0 &&
          !pageSession.isTornDown &&
          pageSession.discoveryRetryDepth < DISCOVERY_MAX_RETRY_DEPTH;
        if (shouldRetry) {
          pageSession.discoveryRetryDepth++;
          firehoseStep('band_discovery:retry', pageSession.discoveryRetryDepth);
          setTimeout(() => scheduleBandDiscovery(), DISCOVERY_RETRY_COOLDOWN_MS);
        } else {
          pageSession.discoveryRetryDepth = 0;
        }
      }
    })();
  }, DISCOVERY_SWEEP_IDLE_TIMEOUT_MS);
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
  if (shouldAutoShowHints()) {
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
    conn_id: '', // stamped by the background SW in postGrammarBatch
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
      conn_id: sessionMeta.conn_id,
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
  sessionMeta: { conn_id: string; hint_visibility: HintVisibility; app_id: string; table_id: string },
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
  //
  // Regime B reclaim (DESIGN_REGIME_B_RECALL.md): resolve each element's
  // remembered codeword by fingerprint and request it, so after a reload the
  // RIGHT element gets its own letter back instead of whatever sits front-of-
  // pool. Skipped when nothing is remembered (fresh page) so we don't pay the
  // per-element fingerprint read for no reclaim.
  const scanPreferred = isRecallLoaded()
    ? newRefs.map((el) => resolvePreferredCodeword(idRegistry.computeFingerprint(el), null) ?? '')
    : [];
  const labels = await claimLabels(newRefs.length, scanPreferred);

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
    claimCounters.scanPathClaimed++;
    candidates.push(new ElementWrapper(newRefs[i], newElements[i]));
  }

  // Even an empty batch sends an is_final marker so the plugin
  // knows the scan ended (matters for the C7 cleanup window).
  if (candidates.length === 0 && !batch.isLast) {
    return;
  }

  const adapterName = adapter?.name ?? '';
  void adapterName; // reserved for plugin-side adapter-aware routing

  stampStrictViewport(candidates);
  const resp = await postBatch({
    session_id: sessionId,
    batch_index: batchIndex,
    is_final: batch.isLast,
    kind: 'scan',
    conn_id: sessionMeta.conn_id,
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
    // Voice layer: same ACK as above means this wrapper's codeword is
    // already live in the grammar by the time badgeNewlyCodeworded runs
    // below. ElementWrapper.markGrammarReady sets the flag and clears the
    // bk-pending class on the visible badge in one shot — mirrors the
    // IO/syncNow path so the two ACK sites can't drift.
    w.markGrammarReady();
    attached.push(w);
  }

  // Record the scan-path claims in the codeword memory (SW + live index). The
  // tracker path does this via its onCodewordsChanged callback; the scan path
  // claims labels upfront (claimLabels), so without this its codewords would
  // never seed a future reclaim — the SPA-rebuild churn the QuickBase sidebar
  // hit. See rememberClaimedCodewords / codeword-recall.
  if (attached.length > 0) rememberClaimedCodewords(attached);

  // Detach badges this REPLACE evicted from the grammar (disjoint from the
  // succeeded set above — an evicted codeword is gone from the new state).
  if (resp.evicted?.length) reconcileEvictedCodewords(resp.evicted);

  // Paint the just-attached badges. Each one is now backed by a
  // successful plugin acknowledgement AND a still-connected element,
  // so the badge-implies-functional contract holds. Gated by
  // pageSession.hintsVisible so manual-mode batches don't paint until "show".
  if (pageSession.hintsVisible && attached.length > 0) {
    reconcile();
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
  pageSession.restore();
});

// Full grammar re-push. Used when the plugin's per-frame grammar was wiped
// out from under us while our delta-sync shadow (`sentCodewords`) still
// believes it's all live — so a plain `scheduleSync` computes an empty delta
// and transmits nothing, leaving painted badges un-matchable. Two triggers
// share this exact recovery:
//   - transient SW restart (liveness Port reconnect → frame_liveness_disconnect
//     wiped the grammar before we reconnected), and
//   - bfcache restore (navigate-away ran purgeTab + session_end, then the
//     frozen V8 context — shadow and all — was reactivated on back/forward).
// `rotateSession` drops the stale shadow and hands the plugin a fresh
// session_id so its `ensureFrameSession` clears stale per-prefix entries;
// then re-queue every live, hintable wrapper for the next sync.
function republishAllGrammar(reason: string): void {
  rotateSession();
  let requeued = 0;
  for (const w of store.all) {
    if (w.scanned.codeword && w.disconnectedAt === null) {
      queuePut(w);
      requeued++;
    }
  }
  bkLog('BK_GRAMMAR_REPUBLISH', { reason, requeued, wrappers: store.all.length });
  scheduleSync(reason);
}

// The bfcache-restore body, owned by `PageSession.restore`.
function restoreFromBfcache(): void {
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
  // NOT schedulePushGrammar(): re-registering wrappers in place enqueues no
  // pending Puts, so the delta sync would skip as an empty delta while the
  // plugin holds the grammar it wiped on navigate-away. Force a full re-push.
  republishAllGrammar('bfcache_restore');
}

// --- Frame liveness Port ---
//
// Our own frameId, as told to us by the SW over the liveness Port on
// connect. Used to detect misrouted activate actions (registry id minted
// in a different frame). null until the Port handshake completes; the
// activate path treats "unknown" as "trust the routing" so dispatches that
// arrive before the handshake aren't dropped. Port mechanics live in
// plugin/liveness.ts; the orphan teardown (quiesceOrphan) stays here
// because it disconnects this file's observers. The frame id itself now lives
// on `pageSession.myFrameId`.

// This frame's page-session lifecycle object. Owns the teardown transition
// (and its reason) plus the per-frame lifecycle primitives migrated out of
// module scope (frame id, discovery scheduling, reposition timers, visibility
// wiring flag). The observer singletons and boot logic still live in this
// module and reach the session via the module-level reference. See
// notes/DESIGN_EXTENSION_RESTRUCTURE.md §3.3.1.
const pageSession = new PageSession({
  teardown: (reason) => quiesceOrphan(reason),
  onUrlChange: (fromCache, reason) => rescanForNav(fromCache, reason),
  restore: () => restoreFromBfcache(),
});

// Wire the visibility-recovery source with the dependencies that still live in
// content.ts (the wrapper-lifecycle and render orchestration). Transitional
// injection seam — see notes/DESIGN_EXTENSION_RESTRUCTURE.md (Tier 1).
initVisibilityTracker({ pageSession, attachWrapper, showHints });

// Wire the wrapper-lifecycle ops with the three observers they drive, which
// still live in content.ts (become imports when observer construction relocates
// onto PageSession in Tier 3).
initWrapperLifecycle({ tracker, resizeObserver, attentionObserver });

// Wire limbo/rebind with detachWrapper + the two observers it re-anchors on,
// which still live in content.ts (become imports once those lift in Tier 1/3).
initLimbo({ detachWrapper, tracker, resizeObserver });

// Wire the mutation source with the discovery walk + reevaluation + reposition
// schedulers it drives, which stay in content.ts (rules/attention/shadow-coupled).
initMutationSource({
  pageSession,
  discoverInSubtree,
  discoverInSubtreeBatched,
  reevaluateAttribute,
  scheduleReposition,
  scheduleDeferredReposition,
});

// Grammar reaction (Tier 2 delta cut): a wrapper attach/detach means the
// per-frame vocabulary changed, so debounce a grammar sync. This replaces the
// scattered "if (changed) schedulePushGrammar()" calls the lifecycle/discovery/
// visibility/limbo paths used to fire imperatively — those now just mutate the
// store. A rebind keeps the same codeword, so it needs no sync. Non-lifecycle
// syncs (codeword claim, rule apply, republish, viewport) stay where they are.
store.subscribe((delta) => {
  if (delta.kind === 'attached' || delta.kind === 'detached') schedulePushGrammar();
});

// Content-script boot breadcrumb. Lets browser.log distinguish a fresh
// re-injection (new V8 context, new session) from a same-context SW reconnect.
bkLog('BK_CS_BOOT', { session: getSessionId(), url: trimFrameUrl(window.location.href) });

openLivenessPort({
  onFrameId: (frameId) => { pageSession.myFrameId = frameId; },
  onOrphan: () => { bkLog('BK_LIVENESS_ORPHAN', {}); pageSession.teardown('orphan'); },
  // SW restarted: the plugin wiped this frame's grammar when our prior
  // liveness Port dropped (frame_liveness_disconnect → session_end), but our
  // delta-sync shadow still thinks the codewords are live. Same recovery as
  // the bfcache path — see republishAllGrammar.
  onResync: () => republishAllGrammar('sw_restart_resync'),
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
// Idempotent via the single guarded entry point: this body runs only as
// `PageSession.teardown`'s hook, which flips `toreDown` before invoking it, so
// a second teardown is a no-op upstream. Each `try` block is independent so a
// failure in one doesn't skip the others.
function quiesceOrphan(reason: TeardownReason = 'orphan'): void {
  // Each module-scope observer that fires user-driven callbacks. Missing one
  // means the orphan keeps reacting to DOM changes / viewport shifts and
  // surfacing `Extension context invalidated` errors in the page console.
  teardownMutationSource();
  try { tracker.disconnectAll(); } catch { /* same */ }
  try { resizeObserver.disconnect(); } catch { /* same */ }
  if (pageSession.discoveryFrame !== null) {
    try { cancelAnimationFrame(pageSession.discoveryFrame); } catch { /* same */ }
    pageSession.discoveryFrame = null;
    pageSession.pendingDiscoveryRoots.clear();
  }
  teardownVisibilityTracker();
  // Stop the reconcile scroll loop and drop every reconcile-mode badge from the
  // positioner registry. The host-removal sweep below removes hosts via raw DOM
  // (bypassing HintBadge.remove(), the only per-badge unregister site), so
  // without this the registry would retain dead badges and a stray settle/scroll
  // pass could iterate and reflow detached frames. drain() is a no-op when the
  // flag is off (empty registry).
  try {
    if (reconcileScrollRaf !== null) {
      cancelAnimationFrame(reconcileScrollRaf);
      reconcileScrollRaf = null;
    }
    reconcileScrollActive = false;
    drainReconcilePositioner();
    drainClipObservers();
  } catch { /* same */ }
  // Remove badge hosts so the new content script's initial DOM-clear sweep
  // (content.ts ~line 2230) doesn't have to fight visible artifacts.
  try {
    for (const node of document.querySelectorAll('[data-branchkit-hint]')) {
      node.remove();
    }
  } catch { /* document gone */ }
  // Release the idempotency guard so a subsequent injection (e.g. the lazy
  // inject on tab activation after an extension reload) can re-initialize this
  // isolated world. Without this, the orphan's lingering flag makes every fresh
  // script bail on the "duplicate injection" throw — the tab stays dead until
  // it's closed and reopened. We're tearing down, so we no longer own the frame.
  try {
    delete (window as unknown as { __branchkitContentInjected?: boolean }).__branchkitContentInjected;
  } catch { /* window gone */ }
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

// Synchronous batch teardown of every wrapper's per-target observers
// (IntersectionTracker, ResizeObserver, AttentionObserver). Called from two
// points where a heavy DOM-swap is about to happen:
//   1. The activate-click path (before the click that might trigger SPA nav),
//      so we get ahead of the page's own dispatch+swap window.
//   2. The SPA-nav rescan handler, as a safety net for navigations the
//      activate path didn't initiate (mouse clicks, bookmarks, history nav).
// Posts a breadcrumb so the actuator log shows whether the teardown ran and
// how many wrappers it cleared. See notes/INVESTIGATION_YOUTUBE_WATCH_PERF.md.
//
// `sparePersistent` (the SPA-nav rescan, which runs AFTER the swap): keep
// wrappers whose DOM element is still connected — the persistent page chrome
// (e.g. a sidebar that survives the nav). Such elements never disconnected, so
// they never contributed to the observer cascade this teardown preempts; wiping
// them only churns their codewords (DESIGN_CODEWORD_STABILITY Regime A).
// Wrappers already in limbo are also spared — the generic limbo/rebind path owns
// them — so we only clean up the rare disconnected-but-not-yet-limbo'd wrapper.
// The activate-click path passes false: full teardown BEFORE the swap, when
// nothing has disconnected yet, to preempt the cascade.
function preNavDetachAll(triggerReason: string, sparePersistent = false): number {
  const targets = sparePersistent
    ? store.all.filter(w => !w.element.isConnected && w.disconnectedAt === null)
    : [...store.all];
  const spared = sparePersistent ? store.all.length - targets.length : 0;
  const t0 = performance.now();
  for (const w of targets) detachWrapper(w.element);
  chrome.runtime.sendMessage({
    type: 'DEBUG_LOG',
    tag: 'pipeline.cs_nav_step',
    data: {
      step: 'pre_nav_detach',
      reason: triggerReason,
      detached: targets.length,
      spared,
      took_ms: Math.round(performance.now() - t0),
    },
  } as Message).catch(() => {});
  return targets.length;
}

// Pre-nav observer teardown for the voice activate-click path (Layer 2 of
// DESIGN_CODEWORD_KEY_OWNERSHIP.md). Synchronously unobserves every wrapper's
// per-element observers BEFORE the simulated click triggers the DOM swap, getting
// ahead of the nav-time wedge (the 600+ observer-callback cascade interleaved
// with the page's reflow).
//
// It used to ALSO park every wrapper in limbo to preserve codewords across the
// nav — but that's now redundant and was actively fragile (graduation un-parked
// at 250ms, ahead of slow swaps like QuickBase). Codeword stability is handled
// the same way the mouse path handles it: reactively, via dropDisconnectedWrappers
// on the actual disconnect, then Layer 1 key-ownership / limbo-rebind /
// Regime-B recall. So the voice path now converges on the known-good mouse path
// for stability, and the only voice-specific bit left is this wedge preempt.
function preNavObserverTeardown(triggerReason: string): number {
  const targets = [...store.all];
  for (const w of targets) {
    resizeObserver.unobserve(w.element);
    tracker.unobserve(w.element);
    attentionObserver.unobserve(w.element);
  }
  chrome.runtime.sendMessage({
    type: 'DEBUG_LOG',
    tag: 'pipeline.cs_nav_step',
    data: { step: 'nav_observer_teardown', reason: triggerReason, torn_down: targets.length },
  } as Message).catch(() => {});
  return targets.length;
}

// The same-document-nav rescan body, owned by `PageSession.onUrlChange`. The
// background `webNavigation` SPA-nav signal arrives as the `rescan` action and
// is dispatched here; this is the content-side handler, not the detector.
function rescanForNav(fromCache: boolean, reason: string): void {
  const t0 = performance.now();
  chrome.runtime.sendMessage({ type: 'DEBUG_LOG', tag: 'pipeline.cs_rescan_received', data: { url: window.location.href, from_cache: fromCache, reason } } as Message).catch(() => {});

  // A same-document nav is a new page: in manual mode (or always-mode with an
  // active F-hide) it should start hidden. The SPA nav keeps this content
  // script alive, so F-shown hints from the previous URL would otherwise
  // linger. Refocus (the other from_cache caller) is NOT a new page — only
  // reset on spa_nav.
  if (reason === 'spa_nav' && !shouldAutoShowHints() && pageSession.hintsVisible) {
    hideHints();
  }

  if (fromCache) {
    // From-cache path: drop dead wrappers, republish the current wrapper
    // store, then run a deferred reconciliation walk. Used for both
    // app-refocus AND same-document SPA navs (background.ts hardcodes
    // from_cache:'true' on every spa_nav dispatch — see
    // notes/INVESTIGATION_YOUTUBE_WATCH_PERF.md). The two cases differ
    // in cost: refocus touches an unchanged DOM, SPA nav lands during
    // YouTube's full-page swap.
    //
    // We DON'T hide/show hints — `syncNow` reuses the existing
    // `sessionId` so the plugin doesn't wipe its per-prefix collections;
    // the matcher's vocab is intact throughout the rescan and codewords
    // stay matchable mid-flight.
    //
    // The body is idle-scheduled: a same-document URL change typically
    // arrives in the middle of the page's own DOM swap, so doing any
    // synchronous work right now puts our wrapper walk + grammar batch
    // on the main thread alongside YouTube's reflow. requestIdleCallback
    // waits for a quiet frame before we touch anything, which both
    // (a) lets the page settle so isConnected checks aren't fighting a
    // mid-mutation layout, and (b) lets YouTube's own task drain before
    // we add ours. The 2s timeout caps the wait so we still reconcile
    // even on pathologically busy pages. Cost: badges briefly painted on
    // disconnected DOM during the idle wait (cosmetic; the user just
    // clicked away from them anyway).
    const runRescan = async () => {
      // Step breadcrumbs: posted to the service worker (which never wedges)
      // around each heavy step, so a hard nav-time freeze leaves a trail
      // naming the last step entered AND the last step that completed.
      // A `:start` without matching `:end` pins the body that killed the
      // main thread. The post-completion cs_scan_completed below never
      // ships when the thread wedges. See nav-time wedge investigation.
      const navStep = (step: string) =>
        chrome.runtime.sendMessage({ type: 'DEBUG_LOG', tag: 'pipeline.cs_nav_step', data: { step, reason, at_ms: Math.round(performance.now() - t0) } } as Message).catch(() => {});

      void navStep('idle_fired');

      // Per-wrapper observer teardown for real content swaps. The activate
      // click path runs `preNavDetachAll` BEFORE the click, so for
      // voice-driven navs the store is already empty here. This call is the
      // safety net for navs the activate path didn't initiate (mouse-driven
      // tab clicks, history nav, bookmarks, etc.) — `detached:0` in the log
      // means the pre-click teardown already ran. See preNavDetachAll above.
      //
      // Gated to spa_nav: refocus (the other from_cache caller) doesn't lose
      // its targets, so the cheap reuse path is correct for refocus.
      if (reason === 'spa_nav') {
        void navStep('rescan_detach:start');
        // sparePersistent=true: this rescan runs AFTER the page's swap, so
        // wrappers whose element is still connected are the persistent chrome
        // (sidebar) that survived the nav — keep them and their codewords. The
        // disconnected, swapped-out content is owned by the generic limbo/rebind
        // path. DESIGN_CODEWORD_STABILITY Regime A.
        const detached = preNavDetachAll('rescan', true);
        void navStep('rescan_detach:end');
        chrome.runtime.sendMessage({ type: 'DEBUG_LOG', tag: 'pipeline.cs_nav_step', data: { step: 'rescan_detach:count', reason, at_ms: Math.round(performance.now() - t0), detached } } as Message).catch(() => {});
      } else {
        void navStep('drop_disconnected:start');
        dropDisconnectedWrappers();
        void navStep('drop_disconnected:end');
      }

      void navStep('sync_now:start');
      await syncNow('refocus_from_cache');
      void navStep('sync_now:end');
      const t1 = performance.now();
      chrome.runtime.sendMessage({ type: 'DEBUG_LOG', tag: 'pipeline.cs_scan_completed', data: { elements: store.all.length, duration_ms: Math.round(t1 - t0), path: 'from_cache' } } as Message).catch(() => {});

      // Reconciliation walk rebuilds wrappers for the new page. For spa_nav we
      // detached everything above, so this is the full rebuild path; for
      // refocus it's the idempotent reconciliation we always did.
      //
      // Idle-scheduled instead of `setTimeout(300)`: on light pages the idle
      // callback fires in <50ms so badges appear ~250ms sooner; on heavy
      // pages (YouTube /featured) the browser holds off until it's actually
      // idle, which is exactly what we want — no need for a fixed margin.
      // The 300ms `timeout` caps the wait so we still reconcile even if the
      // page is pathologically busy. Plan A3 (notes/PLAN_BROWSER_EXTENSION_PERF_OPTIMIZATION.md).
      const scheduleDeferred = () => {
        void navStep('deferred_scan:start');
        // Route through doScan() so the SPA-nav rebuild can't race a
        // concurrent storage-onChanged scan with the same session_id.
        // Pre-fix the two ran in parallel, emitting batches with
        // overlapping session+batch_index pairs and producing duplicate
        // codeword assignments. See actuator.log 2026-06-05T17:30:11.
        void doScan().then(async () => {
          // Codeword-claim backstop. The spa_nav teardown wiped every
          // wrapper + codeword (preNavDetachAll); the rebuild above
          // re-creates and re-observes wrappers, but claiming then depends
          // entirely on the IntersectionObserver re-firing its initial
          // entry for each freshly-observed element. Under the post-nav
          // mutation storm those initial callbacks are delivered only
          // partially, leaving in-viewport wrappers observed-but-unclaimed
          // (no badge) with `isInViewport` stuck at its constructor default.
          // reconcile() walks the store and queues a claim for any in-viewport
          // wrapper still missing a codeword, independent of the IO — the same
          // convergence pass the alphabet-changed path uses. Build is a no-op
          // here (codewords not flushed yet); showHints below paints once they
          // land. Cheap no-op for wrappers that already claimed (refocus path).
          reconcile();
          await tracker.flushNow();
          if (pageSession.hintsVisible) showHints(activeCategory ?? undefined);
          void navStep('deferred_scan:end');
        });
      };
      if (typeof (window as { requestIdleCallback?: unknown }).requestIdleCallback === 'function') {
        (window as Window & { requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => void })
          .requestIdleCallback(scheduleDeferred, { timeout: 300 });
      } else {
        setTimeout(scheduleDeferred, 100);
      }
    };

    if (typeof (window as { requestIdleCallback?: unknown }).requestIdleCallback === 'function') {
      (window as Window & { requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => void })
        .requestIdleCallback(() => { void runRescan(); }, { timeout: 2000 });
    } else {
      setTimeout(() => { void runRescan(); }, 100);
    }
  } else {
    doScan();
    const t1 = performance.now();
    chrome.runtime.sendMessage({ type: 'DEBUG_LOG', tag: 'pipeline.cs_scan_completed', data: { elements: store.all.length, duration_ms: Math.round(t1 - t0) } } as Message).catch(() => {});
  }
}

// This tab just became the active tab. The plugin already holds this tab's
// grammar (every tab stores its batches under Option B) and reprojects it on
// focus, so matchability is already restored by the time this fires. The
// re-push here rotates to a fresh session and rebuilds the plugin's per-frame
// view cleanly, then runs a reconciliation scan to pick up anything that
// changed while backgrounded. Mirrors the from-cache rescan path.
//
// A reactivate is broadcast to *every* frame of the active tab (the plugin's
// target=active fan-out carries no codeword, so the relay can't route it to a
// single frame). Most of those frames — ad iframes, about:blank, embeds with
// no hints — have nothing to republish, so they early-out below; only frames
// that actually hold claimed codewords do the session rotation + re-push.
let lastActivationScanAt = 0;
const ACTIVATION_SCAN_COALESCE_MS = 1500;
function republishForActivation(reason: string): void {
  // Nothing claimed in this frame — no grammar to rebuild. Skip the rotate,
  // re-push, and reconciliation scan entirely so a refocus doesn't wake a
  // full DOM scan in every empty subframe of the page.
  if (!store.all.some(w => w.scanned.codeword)) return;
  // Rotate to a fresh session id so the re-push rebuilds the plugin's per-frame
  // view cleanly. rotateSession also resets the delta-sync mirror, so every
  // live codeword needs re-Putting below.
  rotateSession();
  void (async () => {
    dropDisconnectedWrappers();
    for (const w of store.all) {
      if (w.scanned.codeword) queuePut(w);
    }
    await syncNow(reason);
    // Reconciliation walk: pick up anything that changed while backgrounded.
    // The re-push above already restored the known grammar (so matchability is
    // never at risk here), making this scan best-effort — coalesce it across a
    // burst of refocuses so rapid app-switching can't stack full DOM scans on
    // the main thread.
    const now = performance.now();
    if (now - lastActivationScanAt >= ACTIVATION_SCAN_COALESCE_MS) {
      lastActivationScanAt = now;
      // Route through doScan() so this reconciliation walk serializes
      // with any other in-flight scan (storage-onChanged, MO settle).
      setTimeout(() => { void doScan(); }, 300);
    }
  })();
}

// --- Message Listener (from background / voice) ---

chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
  if (message.type === 'GET_FOCUS_STATUS') {
    sendResponse({ focused: windowHasFocus });
    return false;
  }

  if (message.type === 'RESOLVE_HINT') {
    sendResponse(resolveHintLocally(store, message.codeword, getDisplayMode()));
    return false;
  }

  if (message.type === 'BRANCHKIT_ACTION') {
    const { action, params, correlation_id: correlationId } = message.payload;
    if (action === 'show_hints') {
      phraseSnapshot = takeSnapshot(store.all, performance.now());
      doScan();
      showHints();
    } else if (action === 'hide_hints') {
      hideHints();
    } else if (action === 'rescan') {
      pageSession.onUrlChange(params?.from_cache === 'true', params?.reason ?? '');
    } else if (action === 'reactivate') {
      republishForActivation(params?.reason ?? 'tab_activated');
    } else if (action === 'set_badge_mode' && params?.mode) {
      chrome.storage.sync.set({ badgeDisplayMode: params.mode });
    } else if (action === 'scroll' || action === 'scroll_to_element' || action === 'scroll_to_percent') {
      dispatcher.dispatch(action, params);
    } else if (action === 'history_back') {
      // history.back() steps through the full history stack regardless of
      // skippable flags. The browser's UI back button skips entries whose
      // pushState ran without sticky user activation, which is every voice
      // click (synthetic events are isTrusted=false). Routing back through
      // a JS call recovers the entries the UI button walks past.
      history.back();
    } else if (action === 'history_forward') {
      // Same rationale as history_back: the UI forward button skips
      // voice-navigated SPA entries (synthetic clicks are isTrusted=false),
      // so route forward through a JS call to step the full stack.
      history.forward();
    } else if (action === 'refresh') {
      location.reload();
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
          myFrameId: pageSession.myFrameId,
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
        if (shouldAutoShowHints()) {
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
          // Pre-click observer teardown: if the click triggers a SPA nav
          // (Videos tab on a YouTube channel page is the canonical case), the
          // page replaces its DOM and fires our per-wrapper observers
          // (IntersectionTracker, ResizeObserver, AttentionObserver) for every
          // disconnected target as a 600+ callback cascade interleaved with the
          // page's reflow — the observed nav-time wedge. Doing the teardown
          // here (synchronously, BEFORE the click that triggers the swap) gets
          // ahead of the cascade entirely; the disconnect that follows flows
          // through the generic limbo/rebind/recall path (same as a mouse nav).
          // Cost on a non-nav click: tearing down ~100 wrappers takes ~2ms and
          // the post-click `scheduleHintRefresh` (always-mode) rebuilds them.
          preNavObserverTeardown('activate_click');
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
          correlationId,
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
          correlationId,
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
          correlationId,
        });
      }

      reportDispatchResult({
        action, codeword, resolution, elem_tag: elemTag, taken,
        ok: taken === 'focus' || taken === 'click',
        frame: trimFrameUrl(window.location.href),
        detail,
        fp,
      });
    } else if (action === 'hover') {
      // Hover voice action: resolve the codeword to a wrapper and dispatch
      // the pointer-in event sequence (pointerover/enter/move + mouse
      // equivalents) on the target. Reveals hover-state UI (YouTube
      // player controls, dropdown menus, slide-out panels) that the site
      // hides until cursor presence — without forcing the user to grab
      // the mouse. Mirrors Rango's hoverElement. Resolution uses the
      // same three-tier lookup as activate so codewords stay consistent
      // across the two actions. Does NOT teardown wrappers (no pre-nav
      // detach), does NOT hide hints (always-mode keeps badges so user
      // can follow up with activate on whatever the hover just exposed).
      const codeword = params?.codeword ?? '';
      const idParam = parseInt(params?.id ?? '0', 10);
      const frameIdParam = params?.frame_id != null ? parseInt(params.frame_id, 10) : -1;
      const resolved = resolveTarget(
        idParam, frameIdParam, codeword,
        {
          myFrameId: pageSession.myFrameId,
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
      const target = resolved.target;
      if (target instanceof HTMLElement) {
        store.findWrapperFor(target)?.hint?.flash();
        dispatchHover(target);
        reportDispatchResult({
          action, codeword, resolution: resolved.resolution, elem_tag: target.tagName.toLowerCase(),
          taken: 'click', ok: true,
          frame: trimFrameUrl(window.location.href),
          detail: 'hover dispatched',
          fp: resolved.fp,
        });
      } else {
        reportDispatchResult({
          action, codeword, resolution: resolved.resolution, elem_tag: '',
          taken: 'skipped', ok: false,
          frame: trimFrameUrl(window.location.href),
          detail: resolved.detail || 'hover target not resolved',
          fp: resolved.fp,
        });
      }
    } else if (action === 'noop') {
      const prefix = params?.prefix;
      if (prefix) {
        const letter = WORD_TO_LETTER[prefix];
        if (letter) {
          if (!pageSession.hintsVisible) showHints();
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
  if (!pageSession.hintsVisible) return;
  // 'all' supersedes a queued 'drifted' — a real layout change needs the full
  // sweep even if a scroll already queued the cheap path.
  if (scope === 'all') pendingScope = 'all';
  if (repositionRafPending) return;
  repositionRafPending = true;
  requestAnimationFrame(() => {
    repositionRafPending = false;
    const scope = pendingScope;
    pendingScope = 'drifted';
    // Reconcile mode (bkJsPosition): the JS positioner owns badge placement.
    // Drive one batched pass here so it rides the shared 100ms-debounce + rAF
    // single-flight the four settle handlers funnel into — one coalescing
    // policy, wedge-safe by construction. A no-op (and cheap) when the flag is
    // off (registry empty); reconcileRead() short-circuits hidden badges before
    // any gBCR. The anchor/nesting sweep below is per-badge no-op'd in reconcile
    // mode (needsScroll/LayoutReposition return false), so the two never overlap.
    reconcilePass();
    // Skip wrappers whose element has left the DOM (a limbo wrapper, badge held
    // for the ~250ms rebind window) — placement would otherwise put the badge at
    // getBoundingClientRect()=={0,0,0,0}. Off-screen-but-connected elements are
    // handled below. See notes/INVESTIGATION_LIMBO_BADGE_FLASH.md.
    const visible = store.all.filter(w => w.hint?.isVisible && w.element.isConnected);
    if (visible.length === 0) return;
    const __pbStart = performance.now();
    // Reposition breadcrumbs: a `reposition:start` without matching
    // `reposition:end` pins this as the wedge body. Size = visible badge
    // count. Threshold-gated so steady-state scroll doesn't add 60
    // sendMessages/sec just for telemetry.
    firehoseStep(`reposition:${scope}:start`, visible.length, 20);
    try {
      cacheLayout(visible.map(w => w.element));
      firehoseStep(`reposition:${scope}:cache_end`, visible.length, 20);
      // Hide + skip badges whose element is fully off-screen — e.g. YouTube's
      // collapsed nav drawer parked at x=-228. Placement would otherwise clamp
      // them to the viewport edge, producing the flashing left-edge badge
      // column. Same predicate every paint path uses (see isRectOnScreen).
      const vw = window.innerWidth, vh = window.innerHeight;
      const onscreen = visible.filter(w => {
        if (!isRectOnScreen(getCachedRect(w.element), vw, vh)) {
          w.hint!.hide();
          return false;
        }
        return true;
      });
      // Phase 5 (router-via-scroll-rAF): reads share the cacheLayout
      // warm pass, so each write is essentially free.
      for (const w of onscreen) {
        targetRectStore.write(w.element, getCachedRect(w.element));
      }
      const toPlace = scope === 'drifted'
        ? onscreen.filter(w => w.hint!.needsScrollReposition())
        : onscreen.filter(w => w.hint!.needsLayoutReposition());
      firehoseStep(`reposition:${scope}:place_start`, toPlace.length, 1);
      if (toPlace.length > 0) placeBadges(toPlace);
    } finally {
      clearLayoutCache();
      recordCpu(scope === 'drifted' ? 'placeBadges:scroll' : 'placeBadges:reposition',
        performance.now() - __pbStart);
      firehoseStep(`reposition:${scope}:end`, visible.length, 20);
    }
  });
}
window.addEventListener('resize', () => scheduleReposition('all'), { passive: true });

// Reconcile mode (bkJsPosition) scroll tracking. Reconcile hosts are
// position:fixed and do NOT ride the compositor like anchor/nesting badges, so
// during a continuous scroll they must be re-pinned to their targets every
// frame — the trailing-edge 100ms settle below would leave them detached from
// the viewport until scroll stops. This runs a per-frame reconcilePass() ONLY
// while scroll events are arriving and only when reconcile badges exist; it
// self-cancels ~1 frame after the last scroll event, so it is bounded and NOT a
// free-running rAF (the nav-time wedge discipline). When the flag is off the
// registry is empty, so anchor/nesting sessions never arm it — zero overhead.
let reconcileScrollRaf: number | null = null;
let reconcileScrollActive = false;
function noteReconcileScroll(): void {
  if (reconcileRegistrySize() === 0) return;
  reconcileScrollActive = true;
  if (reconcileScrollRaf === null) reconcileScrollRaf = requestAnimationFrame(reconcileScrollFrame);
}
function reconcileScrollFrame(): void {
  reconcileScrollRaf = null;
  reconcilePass();
  // Re-arm for one more frame if a scroll event landed since the last pass;
  // a quiet frame (no new event) clears the flag and lets the loop stop.
  if (reconcileScrollActive) {
    reconcileScrollActive = false;
    reconcileScrollRaf = requestAnimationFrame(reconcileScrollFrame);
  }
}

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
function scheduleScrollReposition(): void {
  // Reconcile badges need per-frame re-pinning during the scroll itself (they
  // don't ride the compositor); this fires on every scroll event, before the
  // trailing-edge settle below. No-op when the flag is off (empty registry).
  noteReconcileScroll();
  if (pageSession.scrollRepositionTimer) clearTimeout(pageSession.scrollRepositionTimer);
  pageSession.scrollRepositionTimer = setTimeout(() => {
    pageSession.scrollRepositionTimer = null;
    // Scroll-settle is the canonical viewport-exit moment: release hints that
    // scrolled out of band but whose IO exit event dropped (stale-TRUE).
    if (pageSession.hintsVisible) {
      reconcileTeardown();
      // Scroll-settle is also where infinite-scroll content lands. Sweep the
      // band for hintables the MutationObserver dropped under the mutation
      // storm (the discovery gap) — coalesced + idle-scheduled, so a long
      // scroll runs at most one sweep and it never thrashes mid-reflow.
      scheduleBandDiscovery();
      // Re-push wrappers whose strict-viewport flag changed across this
      // scroll, so the plugin's _strict companion collection converges to
      // current viewport reality (drives both voice matching and the
      // Discovery HUD post-PR-2). Gated on hintsVisible: the activate
      // command requires the hints tag, so voice can't match when hints
      // are down — strict membership being stale doesn't matter, and the
      // next `show` re-scans from scratch.
      // Occlusion before strict-viewport: flag covered/clipped targets so the
      // strict-viewport delta below drops them from voice (and hides the ghost
      // badge). reconcileClipObservation only syncs IO membership — the observers
      // drive `clipped` continuously between settles (flicker-free); reconcileOcclusion
      // is the settle-debounced elementFromPoint overlay pass. No-ops when their
      // flags are off.
      reconcileClipObservation(store.all);
      reconcileOcclusion();
      reconcileStrictViewport();
    }
    scheduleReposition('drifted');
  }, DEFERRED_REPOSITION_DEBOUNCE_MS);
}
window.addEventListener('scroll', scheduleScrollReposition, { passive: true });
// Capture-phase document listener catches scroll events on nested overflow
// containers (QuickBase's mainBodyDiv table scroll, Gmail's pane scrolls,
// any modern web-app sidebar / data-grid pattern). Scroll events don't
// bubble, but they DO participate in capture, so a document-level capture
// handler sees every scroll target regardless of who scrolled. Without
// this, inner-pane scroll has NO signal — it never reaches
// scheduleScrollReposition, so a row revealed by inner-pane scroll never
// fires the band-discovery sweep. QuickBase 2026-06-05: 15 reposition:drifted
// events from scheduleDeferredReposition but ZERO band_discovery:entered,
// because scroll never reached scheduleScrollReposition. The handler is the same
// debounced scheduleScrollReposition the window listener uses, so the
// 100 ms coalescing keeps cost bounded even on multi-pane scroll bursts.
document.addEventListener('scroll', scheduleScrollReposition, { passive: true, capture: true });

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
const DEFERRED_REPOSITION_DEBOUNCE_MS = 100;
function scheduleDeferredReposition(): void {
  if (pageSession.deferredRepositionTimer) clearTimeout(pageSession.deferredRepositionTimer);
  pageSession.deferredRepositionTimer = setTimeout(() => {
    pageSession.deferredRepositionTimer = null;
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
    if (pageSession.hintsVisible) {
      reconcileTeardown();
      // focus/transition/resize can reveal new in-band hintables (dropdowns,
      // expanding rows). Converge claim+build over the settled layout; coalesced
      // so a churny burst collapses to one pass that acts on real deltas only.
      scheduleReconcile();
      // Layout shifts from container resize / focus / transition / browser
      // zoom can push a wrapper across the strict-viewport boundary without
      // a scroll event. Re-push the strict flag for changed wrappers so the
      // _strict companion collection — and the Discovery HUD that reads it —
      // converges to the post-settle viewport reality.
      // Occlusion before strict-viewport: flag covered/clipped targets so the
      // strict-viewport delta below drops them from voice (and hides the ghost
      // badge). reconcileClipObservation only syncs IO membership — the observers
      // drive `clipped` continuously between settles (flicker-free); reconcileOcclusion
      // is the settle-debounced elementFromPoint overlay pass. No-ops when their
      // flags are off.
      reconcileClipObservation(store.all);
      reconcileOcclusion();
      reconcileStrictViewport();
    }
    scheduleReposition('drifted');
  }, DEFERRED_REPOSITION_DEBOUNCE_MS);
}
document.addEventListener('focusin', scheduleDeferredReposition, { passive: true });
document.addEventListener('focusout', scheduleDeferredReposition, { passive: true });
document.addEventListener('transitionend', scheduleDeferredReposition, { passive: true });
document.addEventListener('animationend', scheduleDeferredReposition, { passive: true });
// Window resize covers genuine viewport changes (drag corner, device
// rotation, DevTools open/close) AND browser zoom (Cmd+= reflows the
// layout and changes innerWidth/innerHeight in CSS pixels). Route through
// the deferred path so the strict-viewport reconciler runs.
window.addEventListener('resize', scheduleDeferredReposition, { passive: true });

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
  if (pageSession.isTornDown) return;
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
  if (pageSession.isTornDown) return;
  if (heldKeys.has(e.key)) {
    heldKeys.delete(e.key);
    setKeyHeld(false);
  }
}, true);

// Programmatic snapshot trigger for test harnesses (Playwright). Content
// scripts run in the ISOLATED world, so a `window.` global isn't reachable
// from page.evaluate (MAIN world). We use the same cross-world idiom as the
// shadow-attach bootstrap: the harness dispatches a CustomEvent on
// `document`, and we mirror the freshly-built payload onto a dataset
// attribute it reads back (the dataset.branchkitPerf channel, on demand).
//
// CustomEvent dispatch is synchronous and cross-world listeners fire during
// the dispatch call, and captureDebugSnapshot builds its payload
// synchronously — so a harness gets the full structured snapshot in a
// single evaluate, with no keyboard focus, no mtime-guessing, and no
// dependency on the plugin endpoint (the PNG half still lands on disk via
// the SW path when reachable):
//   const snap = await page.evaluate(() => {
//     document.dispatchEvent(new CustomEvent('__branchkit__capture_snapshot'));
//     return JSON.parse(document.documentElement.dataset.branchkitSnapshot);
//   });
// Unlike the Ctrl+Alt+A path this deliberately does NOT toggle the debug
// overlay — a test driving captures shouldn't mutate the page's visuals.
document.addEventListener('__branchkit__capture_snapshot', () => {
  try {
    const payload = captureDebugSnapshot(store, trimFrameUrl(window.location.href));
    payload.reconcile_shadow = computeReconcilePlan(
      store,
      activeCategory,
      targetRectStore,
      { width: window.innerWidth, height: window.innerHeight },
      RECONCILE_BAND_MARGIN_PX,
    );
    document.documentElement.dataset.branchkitSnapshot = JSON.stringify(payload);
  } catch {
    // Snapshot build failed (detached store, serialization); leave the
    // previous mirror in place rather than wedging the page.
  }
}, true);

// --- MutationObserver (discovery-only) ---
//
// The observer surgically reflects DOM changes into the wrapper store:
// new subtrees gain wrappers (the IntersectionTracker claims pool
// codewords on viewport entry), removed subtrees lose theirs, attribute
// changes flip elements in and out of hintability. Grammar push is
// debounced after a batch settles so voice sees a consistent snapshot.
// Dispatched on every grammar-relevant change (MO mutations, IT
// codeword claims, alphabet swap, bfcache restore). Routes to the
// LabelStage's debounced catchup for MO-discovered + IT-claimed wrappers.
function schedulePushGrammar(): void {
  scheduleSync('schedulePushGrammar');
}

/** Walk an added subtree and create wrappers for any hintable descendants. */
function discoverInSubtree(root: Element): number {
  const __cpuStart = performance.now();
  const result = scanElements(root, (el) => store.findWrapperFor(el) !== undefined);
  applyUserRuleToScan(result, root);
  const added = attachDiscovered(result.refs, result.elements, collectLimboWrappers(), collectStrongKeyIndex());
  observeInvisibleCandidates(result.invisibleCandidates);
  watchUndefinedCustomElements(root);
  recordCpu('discoverInSubtree', performance.now() - __cpuStart);
  return added;
}

// Sliced variant of `discoverInSubtree` for roots big enough that one
// synchronous walk would freeze the main thread — specifically the
// full-page DOM swap on a YouTube /watch -> /watch SPA nav, which trips
// the HUGE_MUTATIONS short-circuit. The synchronous path walks ~1000+
// fresh elements (isVisible per candidate + attachWrapper per survivor)
// in a single ~1.1s task. `drainDiscovery`'s 8ms budget can't help: it
// only yields BETWEEN roots, and one document.body root runs to
// completion. Here we walk via `scanInBatches` (the same incremental
// walk doScanBatched uses), attaching per batch and awaiting
// setTimeout(0) between batches so the event loop drains. Semantics
// match discoverInSubtree: inclusion-rule elements run once up front
// (a per-batch query would be N querySelectorAll), exclusions apply per
// batch, limbo-rebind is shared via attachDiscovered. See
// notes/DESIGN_NAV_TIME_RESCAN.md.
async function discoverInSubtreeBatched(root: Element): Promise<number> {
  const __cpuStart = performance.now();
  let added = 0;
  const limboPool = collectLimboWrappers();
  // Built once for the whole sliced walk (mirrors limboPool); consumed as
  // strong-key rebinds fire across batches. See DESIGN_CODEWORD_KEY_OWNERSHIP.md.
  const keyIndex = collectStrongKeyIndex();
  const cr = compiledRule;
  const isKnown = (el: Element) => store.findWrapperFor(el) !== undefined;

  // Inclusion-rule elements once, pre-marked so the walk doesn't re-emit
  // them. Mirrors applyUserRuleToScan's include branch + doScanBatched's
  // one-shot inclusion handling.
  let initialSeen: ReadonlySet<Element> | undefined;
  if (cr?.includeSelector) {
    const seen = new Set<Element>();
    if (root === document.body || root === document.documentElement) {
      for (const w of store.all) seen.add(w.element);
    }
    const inc = collectInclusions(seen, cr.includeSelector, root);
    added += attachDiscovered(inc.refs, inc.elements, limboPool, keyIndex);
    initialSeen = new Set(inc.refs);
  }

  let invisibleCandidates: Element[] = [];
  for (const batch of scanInBatches(root, DEFAULT_SCAN_BATCH_SIZE, initialSeen, isKnown)) {
    if (cr?.excludes.length) applyExclusions(batch.refs, batch.elements, cr.excludes);
    added += attachDiscovered(batch.refs, batch.elements, limboPool, keyIndex);
    if (batch.isLast) invisibleCandidates = batch.invisibleCandidates;
    // Yield so the main thread frees between batches — this is the whole
    // point of the sliced path.
    await new Promise(r => setTimeout(r, 0));
  }
  observeInvisibleCandidates(invisibleCandidates);
  watchUndefinedCustomElements(root);
  recordCpu('discoverInSubtreeBatched', performance.now() - __cpuStart);
  return added;
}

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

// Turn on the page-wide hint machinery for an eligible frame: the mutation
// observer + the limbo sweeper. Idempotent. The 'resize' trigger means a
// previously-ineligible frame grew, so it also kicks an initial scan (the
// module-load alphabet callback already scans eligible-at-load frames).
function activateHintMachinery(trigger: 'load' | 'resize'): void {
  if (hintMachineryEnabled) return;
  hintMachineryEnabled = true;
  attachPageMutationObserver();
  setInterval(finalizeExpiredLimboWrappers, LIMBO_DEADLINE_MS);
  if (trigger === 'resize') {
    // Subframe that just grew past the eligibility threshold. The module-
    // load reservoir warm-up was skipped (frame was too small / blank),
    // so warm it now before the first scan so the IO claim path doesn't
    // pay an IPC round-trip on its first batch.
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      void labelReservoir.ensureReady();
    }
    setTimeout(() => doScan(), 0);
  }
}

if (frameMayHoldHints()) {
  activateHintMachinery('load');
} else {
  // Subframe too small / blank to hold a usable hint. Watch for it growing
  // past the threshold (a collapsed slot expanding, a lazily-sized iframe) and
  // activate then. Single ResizeObserver on documentElement; self-disconnects.
  const wakeRO = new ResizeObserver(() => {
    if (window.innerWidth * window.innerHeight >= MIN_FRAME_AREA_PX) {
      wakeRO.disconnect();
      activateHintMachinery('resize');
    }
  });
  try { wakeRO.observe(document.documentElement); } catch { /* document not ready */ }
}

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
      // Newly-attached wrappers emit store deltas → grammar sync (Tier 2).
      discoverInSubtree(host);
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
      // Newly-attached wrappers emit store deltas → grammar sync (Tier 2).
      for (const instance of document.querySelectorAll(tag)) {
        discoverInSubtree(instance);
      }
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
  let inViewport = 0;
  let inViewportWithCodeword = 0;
  for (const w of store.all) {
    if (w.disconnectedAt !== null) limbo++;
    else if (!w.element.isConnected) sentinelDisconnected++;
    if (w.isInViewport) {
      inViewport++;
      if (w.scanned.codeword) inViewportWithCodeword++;
    }
  }
  return {
    ...getPerfCounters(),
    // Subframe count of this (top) frame — preserves the ad-frame-swarm signal
    // now that subframes no longer ship their own trail entries.
    frames: window.length,
    wrapperCount: store.all.length,
    wrapperLimboCount: limbo,
    // claim.* splits codeword acquisition by path so we can see if the scan
    // path went silent while the viewport tracker kept the visible handful
    // alive.
    claim: { ...claimCounters },
    // Direct symptom metric: of wrappers the tracker considers in-viewport
    // (200px margin), how many actually hold a codeword. < 1.0 ratio = the
    // visible-links-without-badges bug.
    inViewportWrappers: inViewport,
    inViewportWithCodeword,
    // Disconnected wrappers that aren't yet in limbo. Should be ≈ 0 in
    // steady state; nonzero means dropDisconnectedWrappers isn't being
    // called between detach and snapshot.
    wrapperDisconnectedOutOfLimbo: sentinelDisconnected,
    lifecycleCounters: { ...lifecycleCounters },
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
    },
    // Diagnostic shadow of the authoritative reconcile (content.ts:reconcile +
    // reconcileTeardown + scheduleBandDiscovery). Drives nothing; surfaces the
    // actual→desired delta as a tripwire — steady-state counts are all zero, a
    // non-zero count flags a {claim, build, release, teardown} the authoritative
    // paths missed. Cheap: O(store), reads warm rects only.
    reconcileShadow: computeReconcilePlan(
      store,
      activeCategory,
      targetRectStore,
      { width: window.innerWidth, height: window.innerHeight },
      RECONCILE_BAND_MARGIN_PX,
    ),
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
// Top frame only: the dataset mirror exists for Playwright/in-page inspection,
// which reads the top document's element. A subframe publishing to its own
// (unread) documentElement is pure 4Hz waste across the ad-frame swarm.
if (isTopFrame) {
  setInterval(publishPerfSnapshot, 250);
  publishPerfSnapshot();
}

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
// Top frame only: each subframe shipping its own snapshot every 5s is what
// flooded the trail with ~700 ad-frame entries per sample on ad-heavy pages.
// The top-frame snapshot carries `frames` (subframe count) so the trail still
// surfaces swarm size without 700 separate sendMessage round-trips.
if (isTopFrame) {
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
}

