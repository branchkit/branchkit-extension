/**
 * BranchKit Browser — Content script entry point.
 *
 * Injected per frame. Scans DOM, creates badges, handles keyboard input.
 * Voice commands arrive via background → BRANCHKIT_ACTION messages.
 */

import { Category, HintVisibility, ScannedElement, Message, DispatchResult, TabAction } from './types';
import { LabelAssignment, isVoiceAlphabetLoaded, setAlphabet } from './labels/words';
import { scanElements, scanSingle, isHintable, isVisible, deepQuerySelectorAll, scanInBatches, DEFAULT_SCAN_BATCH_SIZE, getPerfCounters, resetPerfCounters } from './scan/scanner';
import { noteDisconnectedShadowAttach } from './scan/shadow-attach-signal';
import { ElementWrapper } from './scan/element-wrapper';
import { wantsHint } from './lifecycle/desired-state';
import {
  computeReconcilePlanLists,
  geometryInBand,
  RECONCILE_BAND_MARGIN_PX,
  type ReconcilePlanLists,
} from './lifecycle/reconcile';
import { gatherSettleReads, SettleGather } from './lifecycle/gather';
import { stampStrictViewport } from './lifecycle/strict-viewport';
import * as idRegistry from './scan/registry';
import type { CodewordMemoryEntry } from './labels/codeword-memory';
import { loadRecall, recalledCodewords, rememberLive, resolvePreferredCodeword, isRecallLoaded } from './labels/codeword-recall';
import { type RebindCounters } from './labels/rebind';
import { resolveTarget } from './activate/activate-resolution';
import { schedulePointerVisibilitySweep, connectVisibilityMO, teardownVisibilityTracker } from './observe/visibility-tracker';
import { rebindCounters, LIMBO_DEADLINE_MS, collectLimboWrappers, collectStrongKeyIndex, dropDisconnectedWrappers, finalizeExpiredLimboWrappers } from './observe/limbo';
import { attachWrapper, detachWrapper, seedPreferredFromMemory, attachDiscovered } from './core/wrapper-lifecycle';
import { attachPageMutationObserver, teardownMutationSource } from './observe/mutation-source';
import { firehoseStep } from './debug/firehose';
import { bkLog } from './debug/bk-log';
import { store } from './core/store';
import { HintBadge } from './render/hints';
import { reconcilePass, drain as drainReconcilePositioner, reconcileRegistrySize } from './render/reconcile-positioner';
import { onContainerResize } from './observe/container-resize-tracker';
import { onTargetMutation } from './observe/target-mutation-tracker';
import { setOcclusionEnabled, applyOcclusion } from './observe/occlusion';
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
import { toggleHelpOverlay } from './render/help-overlay';
import {
  CodewordSnapshot,
  takeSnapshot,
  resolveFromSnapshot,
} from './activate/snapshot';
import { dispatcher, registry, keyHandler } from './core/singletons';
import { DEFAULT_KEYMAP, type KeymapEntry } from './command-catalog';
import { loadKeymap, onKeymapChanged } from './keymap-storage';
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
  isFindBarOpen,
  handleFindNavKey,
  setFindCallbacks,
} from './scan/find';
import { focusFirstInput, handleFocusInputKey } from './activate/focus-input';
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
import { setBadgeSizingFromSettings } from './render/hints';
import { setScrollAccelEnabled, setScrollAccelNestedEnabled, reconcileScrollAccel, reconcileScrollAccelForScroller } from './render/scroll-accel-glue';
import { isScrollTimelineSupported } from './render/scroll-accel';
import { setNudgesFromSettings } from './placement';
import { labelReservoir } from './labels/label-reservoir';
import { filterNewBatchRefs } from './scan/batch-dedup';
import { resolveHintLocally, reportDispatchResult } from './plugin/resolve';
import { openLivenessPort } from './plugin/liveness';
import { pageSession, TeardownReason } from './lifecycle/page-session';
import { ensureSendMessageWrapped, resetMessageCounters, messageCountersSnapshot } from './debug/message-counters';
import { recordCpu, resetCpuCounters, resetLongtask, resetWatchdog, computeCpuShare, cpuBucketsSnapshot, longtaskSnapshot, watchdogSnapshot, startPerfObservers, lifecycleCounters, resetLifecycleCounters } from './debug/perf-counters';
import { loadConfig, getDisplayMode, getHintVisibility, getHintsShown, setHintsShown } from './config';
import {
  grammarEpochStats,
  probeGrammarEpoch,
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
//   2. SW programmatic injection via `chrome.scripting.executeScript`
//      (install/update/reload reinject storm, or the lazy ping-fail path).
//
// The guard lives on a DOM ATTRIBUTE, not a window expando: the document is
// the one surface every injection shares. On Firefox, an executeScript file
// injection runs in its OWN sandbox — a `window.__branchkitContentInjected`
// expando set by the manifest script was invisible there, so when the SW's
// queued injection (executeScript defers to document_idle on a still-loading
// page) landed back-to-back with the manifest script at document_idle, BOTH
// passed the old guard — two live content scripts per frame, each with its
// own grammar session, ping-ponging the plugin's per-frame state
// (deterministic 5/6 repro on a slow page, 2026-06-12; the epoch tripwire's
// catch #1). Attribute check+set is synchronous, so whoever runs first wins
// regardless of sandbox or world; a navigation replaces the document and
// resets it naturally.
//
// The SW's recovery paths clear the attribute (flushOrphanGuard) only after
// a ping-retry proves the holder is an unreachable orphan.
const CS_GUARD_ATTR = 'data-branchkit-cs';
// Per-instance id. Doubles as the guard-attribute VALUE so every diagnostic
// surface (abort markers, flushOrphanGuard's bridge marker) can attribute the
// guard to the instance that set it, and so quiesceOrphan releases only its
// own guard — an orphan tearing down late must not strand a healthy
// successor's guard.
const BK_CS_ID = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
  ? crypto.randomUUID()
  : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const guardOwner = document.documentElement.getAttribute(CS_GUARD_ATTR);
if (guardOwner !== null) {
  // A content script already owns this frame. Leave an aborted-marker on the
  // page-world bridge (diagnostic — lets harnesses count guard trips), then
  // throw to abort the IIFE without re-binding listeners. No-op for the page.
  try {
    const pw = ((window as unknown as { wrappedJSObject?: Window }).wrappedJSObject ?? window) as unknown as {
      __branchkitDebugJSON?: string;
    };
    const arr = JSON.parse(pw.__branchkitDebugJSON ?? '[]');
    arr.push({ aborted_at: performance.now(), ready: document.readyState, owner: guardOwner });
    pw.__branchkitDebugJSON = JSON.stringify(arr);
  } catch { /* diagnostic only */ }
  throw new Error('[BranchKit] content script duplicate injection — bailing');
}
document.documentElement.setAttribute(CS_GUARD_ATTR, BK_CS_ID);

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
  const entry = {
    cs_id: BK_CS_ID,
    loaded_at: performance.now(),
    is_top_frame: isTopFrame,
    initial_url: location.href,
    ready: document.readyState,
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

// Append a diagnostic entry to the page-world bridge (see boot entry above
// for the Xray/string-encoding rationale). Non-fatal by construction.
function pushDebugBridge(entry: Record<string, unknown>): void {
  try {
    const pw = ((window as unknown as { wrappedJSObject?: Window }).wrappedJSObject ?? window) as unknown as {
      __branchkitDebugJSON?: string;
    };
    const arr = JSON.parse(pw.__branchkitDebugJSON ?? '[]');
    arr.push(entry);
    pw.__branchkitDebugJSON = JSON.stringify(arr);
  } catch { /* diagnostic only */ }
}

// --- Guard keeper: level-triggered single-CS-per-frame invariant ---
//
// The boot-time guard above is edge-triggered: it only helps if the guard
// attribute is still intact at the instant a duplicate copy boots. The SW's
// orphan-recovery flush (background/injection.ts flushOrphanGuard) deletes
// the attribute whenever its ping ladder concludes the frame is empty — and
// a ping failure only proves "didn't answer", not "orphan": a healthy CS
// mid-init (slow page, loaded machine) fails pings too. When that happens
// the flush deletes a LIVE guard and the queued injection boots a second CS
// (the dual-CS install race; the status gate in ensureContentScriptInjected
// closes the known loading-tab window, this keeper enforces the invariant
// against every other interleaving, known or future).
//
// Level-triggered repair, checked on a slow cadence:
//   - guard missing  → reclaim it (we are alive; whoever flushed was wrong —
//     a queued sibling injection will then abort on the restored guard)
//   - guard foreign  → a successor copy owns the frame; converge to one CS
//     by self-quiescing (elder yields, exactly one survivor either way)
//   - context dead   → we are a true orphan; never reclaim (that would
//     permanently block the successor) — quiesce instead.
const GUARD_KEEPER_INTERVAL_MS = 2500;
const guardKeeper = setInterval(() => {
  if (pageSession.isTornDown) {
    clearInterval(guardKeeper);
    return;
  }
  try {
    chrome.runtime.getURL('');
  } catch {
    clearInterval(guardKeeper);
    pushDebugBridge({ keeper_orphaned_at: performance.now(), orphan_of: BK_CS_ID });
    pageSession.teardown('orphan');
    return;
  }
  let owner: string | null = null;
  try {
    owner = document.documentElement.getAttribute(CS_GUARD_ATTR);
  } catch {
    return; // document in teardown; unload path owns cleanup
  }
  if (owner === BK_CS_ID) return;
  if (owner === null) {
    try {
      document.documentElement.setAttribute(CS_GUARD_ATTR, BK_CS_ID);
      pushDebugBridge({ reclaimed_at: performance.now(), by: BK_CS_ID });
      bkLog('BK_GUARD_RECLAIMED', { cs_id: BK_CS_ID });
    } catch { /* document gone */ }
    return;
  }
  clearInterval(guardKeeper);
  pushDebugBridge({ superseded_at: performance.now(), elder: BK_CS_ID, successor: owner });
  bkLog('BK_GUARD_SUPERSEDED', { elder: BK_CS_ID, successor: owner });
  pageSession.teardown('superseded');
}, GUARD_KEEPER_INTERVAL_MS);

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
// Lever 3 (hidden-tab suspend): true while an enabled frame is backgrounded
// and its page MutationObserver has been disconnected. Reversible — wrappers/
// codewords/badges are preserved; resume re-attaches the MO and reconciles.
let suspended = false;

// --- State ---
//
// The stable runtime singletons (store, dispatcher, registry, keyHandler)
// are constructed in core/ and imported above — see
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

// The IntersectionTracker's codeword-claim sync. The tracker itself is owned
// by `pageSession` (constructed in start(), Tier 3); this callback stays here
// because it drives the delta-sync Put/Delete bookkeeping, the claim-path
// counters, and the build-up reconcile — grammar/render orchestration, not
// store mutation. Passed to `pageSession.start()` below.
function onTrackerCodewordsChanged(claimed: ElementWrapper[], released: string[]): void {
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
}

// (Strict-viewport tracker removed — it was meant to narrow the
// scheduleReposition set on heavy pages, but on YouTube /watch the
// added per-wrapper observation (a second IO per element, on top of
// the IntersectionTracker's wide-margin IO) appeared to saturate
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
  // Phase 2b (DESIGN_GRAMMAR_EPOCH_HANDSHAKE.md): a quiescent epoch mismatch
  // fires the same full-republish recovery the enumerated triggers use.
  // republishAllGrammar is a hoisted declaration below.
  republishAll: (reason) => republishAllGrammar(reason),
});

// Confirm-rejection handler (epoch-handshake Phase 4, review bug #5): the SW
// pool arbitrated these codewords AWAY from this frame — another frame won
// the release-vs-confirm race, or the pool no longer knows the string (stale
// alphabet). The holding wrapper must drop the codeword WITHOUT releaseLabel:
// a RELEASE_LABELS here would free the WINNER's assignment out from under it.
// Retract our grammar entry, strip the wrapper back to unhinted, and let the
// level-triggered reconcile claim it a fresh codeword.
labelReservoir.onConfirmRejected((codewords) => {
  let dropped = 0;
  for (const cw of codewords) {
    const w = store.byCodeword(cw);
    if (!w) continue;
    if (hasSent(cw)) queueDelete(cw);
    w.scanned.codeword = '';
    w.label = null;
    w.grammarReady = false;
    if (w.hint) {
      w.hint.remove();
      w.hint = null;
    }
    dropped++;
  }
  bkLog('BK_CONFIRM_REJECTED', { codewords: codewords.length, dropped });
  if (dropped > 0) {
    reconcile();
    scheduleSync('confirm_rejected');
  }
});

// Reservoir leak sweep (2026-06-29 review): an outstanding codeword no live
// wrapper holds (past the claim→attach grace) was leaked by a
// release-skipping teardown path; the reservoir releases it back to the
// pool, and we clear the plugin-side grammar entry it may still occupy.
labelReservoir.installLeakSweep(
  (cw) => store.byCodeword(cw) !== undefined,
  (leaked) => {
    let deletesQueued = 0;
    for (const cw of leaked) {
      if (hasSent(cw)) {
        queueDelete(cw);
        deletesQueued++;
      }
    }
    bkLog('BK_RESERVOIR_SWEEP', { leaked: leaked.length, deletesQueued });
    if (deletesQueued > 0) scheduleSync('reservoir_sweep');
  },
);

// A claim that ran while the reservoir was dry left its wrappers unhinted
// ('' slots); the reconciler re-queues them, but its triggers are all
// user-activity-driven (scroll settle, mutation, focus) — on a static, dense
// first paint the overflow wrappers would stay bare indefinitely. When a
// refill actually lands codewords, run the coalesced reconcile directly so
// the starved wrappers claim + paint without waiting for the user to move.
labelReservoir.onRefillLanded(() => scheduleReconcile());

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
//
// HARD-CAPPED: a page that never goes mutation-quiet (ad churn, animated
// thumbnails — YouTube results) must still fire. Uncapped, this was the
// no-badges-on-refresh boot race (2026-06-12): when the hintsShown config
// load beat the alphabet load, the boot showHints() early-returned on the
// missing alphabet WITHOUT setting hintsVisible, and the alphabet-callback
// recovery sat behind this settle wait forever — codewords claimed, zero
// badges painted, settle pass never armed. Hydration is comfortably done
// within the cap; trading a rare React #418 console error on a
// pathologically slow hydration for guaranteed badges is the right side.
const SETTLE_MS = 200;
const SETTLE_MAX_WAIT_MS = 1000;

function whenDOMSettles(callback: () => void): void {
  let fired = false;
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(fire, SETTLE_MS);
  const deadline = setTimeout(fire, SETTLE_MAX_WAIT_MS);
  const mo = new MutationObserver(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fire, SETTLE_MS);
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
  function fire() {
    if (fired) return;
    fired = true;
    mo.disconnect();
    if (timer) clearTimeout(timer);
    clearTimeout(deadline);
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
// session state). BranchKit pushed (or changed) its voice alphabet. Under the
// inverted model the pool builds from fixed letters, so hint IDENTITIES are
// unchanged — only the spoken overlay moved. We therefore do NOT wipe codewords
// or re-claim: we just re-render (so word/both-mode badges show the new spoken
// words) and re-push every wrapper's grammar to the plugin with the new
// translation. rotateSession makes the plugin drop any stale per-prefix entries
// from a prior alphabet. This also covers the first BranchKit connect: wrappers
// that attached standalone (never pushed) now get pushed so voice goes live.
if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.alphabet?.newValue) {
      setAlphabet(changes.alphabet.newValue);
      rotateSession();
      for (const w of store.all) {
        if (!w.scanned.codeword) continue;
        // Voice goes pending until the re-push ACKs the (re)translated codeword.
        w.grammarReady = false;
        w.label = poolLabelToAssignment(w.scanned.codeword);
        w.hint?.updateLabel(w.label, getDisplayMode());
        queuePut(w);
      }
      void syncNow('alphabet_change');
    }
  });
}

// Adopt the BranchKit voice alphabet (overlay) from chrome.storage.local on
// script load, if BranchKit was already connected. Local (not sync) because the
// alphabet is per-machine: it tracks whatever voice plugin happens to be running
// locally, not user preferences.
//
// The initial scan + auto-show below is NO LONGER gated on the alphabet — hints
// are standalone now, so they run whether or not BranchKit is present. (Before
// the inversion, doScanBatched no-opped without an alphabet, so this block was
// the only thing that kicked the first scan once voice connected.)
// The one-time initial discovery scan + auto-show. Shared by the eligible-at-
// load path (the storage callback below) and the visibility-deferred path
// (deferActivationUntilVisible). Guarded so it runs at most once even if a tab
// becomes visible before the storage read resolves.
//
// Deferred by a macrotask: running doScan synchronously here blocks the main
// thread before the snapshot publisher's setInterval registers its first tick —
// on heavy pages (YouTube /watch with shadow DOM and 1000+ candidates) this
// reads as a freeze and Firefox flags the extension as unresponsive. setTimeout(0)
// (not requestIdleCallback) because rIC never finds a true idle window on
// hyperactive pages and its 2s fallback starves the scan-batch loop's own
// setTimeout(0) yields. One tick is enough to let the page paint + the publisher
// fire its first sample; from there doScanBatched's chunked walk yields between
// batches.
let initialScanKicked = false;
function kickInitialScan(): void {
  if (initialScanKicked) return;
  initialScanKicked = true;
  setTimeout(() => {
    // Coalesced — any domain-rules-change or badge-settings-change event that
    // arrived in the same tick folds into this scan instead of triggering a
    // second back-to-back doScanBatched.
    scheduleDoScan();
    if (shouldAutoShowHints()) {
      whenDOMSettles(() => {
        pageSession.tracker.flushNow().then(() => {
          if (shouldAutoShowHints() && !pageSession.hintsVisible) showHints();
        });
      });
    }
  }, 0);
}

if (typeof chrome !== 'undefined' && chrome.storage?.local) {
  chrome.storage.local.get('alphabet', (result) => {
    if (Array.isArray(result.alphabet)) setAlphabet(result.alphabet);
    // No initial scan yet when the machinery is off: either an ineligible frame
    // (tiny/about:blank subframe — woken via wake-on-resize) or a backgrounded
    // tab whose activation was deferred (Lever 2 — woken on first show).
    if (!hintMachineryEnabled) return;
    kickInitialScan();
  });
}

// Feature-flag registry (chrome.storage.local; read once at load, reload to
// apply; per-machine, not synced). Pre-launch dogfood posture: everything
// defaults ON, so a fresh reload is a known "all on" state and you isolate a
// problem by flipping ONE flag to `false`. Stored values override these defaults
// — run `chrome.storage.local.remove([...keys])` to reset to a clean baseline.
//
// bkScrollAccel / bkScrollAccelNested - default ON, GRADUATED (real-Chrome
//   confirmed). The off-path (JS chase) is also the Firefox fallback, gated
//   independently by isScrollTimelineSupported(). EXIT: delete these flags after
//   a clean soak (~2026-06-17), keeping the feature-detect.
// bkOcclusion - default ON, validated helpful but still watching for FALSE
//   POSITIVES (a real badge wrongly hidden = voice silently can't match it).
//   EXIT: keep on if the soak stays clean, else investigate; reconfirm at launch.
// bkClipObserver - default ON, composes with bkOcclusion (IO-clip vs
//   elementFromPoint hit-test). Same exit as bkOcclusion.
if (typeof chrome !== 'undefined' && chrome.storage?.local) {
  chrome.storage.local.get('bkOcclusion', (result) => {
    // Occlusion filtering (notes/DESIGN_HINT_OCCLUSION_FILTERING.md). Default ON
    // for the dogfood phase; only an explicit `false` disables. Watch for false
    // positives (a real badge hidden) — `chrome.storage.local.set({ bkOcclusion: false })`
    // to rule it out.
    setOcclusionEnabled(result.bkOcclusion !== false);
    document.documentElement.setAttribute('data-bk-occlusion', result.bkOcclusion !== false ? 'on' : 'off');
  });
  chrome.storage.local.get('bkClipObserver', (result) => {
    // Scroll-container clip detection (IO-root=scroller, Rango's idea). Default ON;
    // only an explicit `false` disables. Composes with bkOcclusion — the IO-clip
    // path and the elementFromPoint overlay path both feed the effective occlusion.
    setClipObserverEnabled(result.bkClipObserver !== false);
    document.documentElement.setAttribute('data-bk-clip-observer', result.bkClipObserver !== false ? 'on' : 'off');
  });
  // Both accelerator flags in ONE get so they're set atomically — otherwise a
  // badge can arm between the two callbacks with the base flag on but the nested
  // flag not-yet-set, caching a single-layer accelerator. Both default ON (only an
  // explicit `false` disables): real app shells (QuickBase, Gmail) nest an inner
  // pane inside an outer page scroller, so a badge in the inner pane needs the
  // WHOLE chain ridden or the outer scroll chases it. Landed + real-Chrome
  // confirmed via the nested-wrapper model (see the flag registry above).
  chrome.storage.local.get(['bkScrollAccel', 'bkScrollAccelNested'], (result) => {
    const enabled = result.bkScrollAccel !== false;
    const nested = result.bkScrollAccelNested !== false;
    setScrollAccelEnabled(enabled);
    setScrollAccelNestedEnabled(nested);
    // Page-visible diagnostic markers on <html>: 'on' = flag set + ScrollTimeline
    // supported; 'unsupported' = no ScrollTimeline (Firefox stable); 'off' = not
    // set. Pair with `document.querySelectorAll('[data-bk-accel]').length`.
    document.documentElement.setAttribute(
      'data-bk-scroll-accel',
      enabled ? (isScrollTimelineSupported() ? 'on' : 'unsupported') : 'off',
    );
    document.documentElement.setAttribute('data-bk-scroll-accel-nested', nested ? 'on' : 'off');
  });
}

// --- Register Commands (built from the keymap) ---
//
// The registry is the matcher; the keymap (command-catalog.ts DEFAULT_KEYMAP,
// overridable per-user via keymap-storage) is the source of truth for what's
// bound to what. Building the registry from data (rather than hardcoded
// registry.add calls) is what lets the options-page editor rebuild bindings
// live via registry.replaceAll — see notes/DESIGN_KEYMAP_CONFIG.md.
//
// The default set, for reference: one binding per command, preferring the
// always-mode form (Shift/modifier chords route to commands even with hints
// painted; bare letters are codeword input then, so they'd be eaten).
// Shift+J/K/D/U/T/G scroll; Shift+H/L cycle tabs; Ctrl+S toggles hints
// (show_hints_newtab is still bindable, just not a default — Ctrl+S + the "aA"
// new-tab affordance cover it). A few inherently-bare, hidden-only binds (h/l
// horizontal scroll, `cs`, `/`, `n`). Users add extra binds (e.g. plain j) via
// the options editor.
// The effective keymap, kept in sync with the registry so the help overlay can
// render the user's actual binds (not just the defaults).
let currentKeymap: readonly KeymapEntry[] = DEFAULT_KEYMAP;
function buildRegistryFromKeymap(entries: readonly KeymapEntry[]): void {
  currentKeymap = entries;
  registry.replaceAll(
    entries.map((e) => ({ keys: e.keys, action: e.command, params: e.params })),
  );
}
// Defaults synchronously so keybinds work before the async storage read
// returns; then apply the stored keymap (if any) and rebuild live on edits.
buildRegistryFromKeymap(DEFAULT_KEYMAP);
if (typeof chrome !== 'undefined' && chrome.storage?.sync) {
  void loadKeymap().then(buildRegistryFromKeymap);
  onKeymapChanged(buildRegistryFromKeymap);
}

// --- Register Action Handlers ---

// The modal `hint` mode (where Escape dismisses all hints) only makes sense
// when the user explicitly summoned hints — i.e. manual visibility mode. In
// always-visible mode hints are persistent and there's a dedicated hide chord,
// so the handler stays in normal mode: Escape keeps its native behavior (close
// a dropdown mid-utterance, etc.) instead of nuking every badge. Typing still
// works in always mode via the hints-visible predicate, independent of mode.
function enterHintModeIfManual(): void {
  if (getHintVisibility() !== 'always') keyHandler.enterHintMode();
}

dispatcher.register('show_hints', () => {
  doScan();
  showHints();
  enterHintModeIfManual();
});

let activateInNewTab = false;

dispatcher.register('show_hints_newtab', () => {
  activateInNewTab = true;
  doScan();
  showHints();
  enterHintModeIfManual();
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
  // Branch on what's actually on screen, not just the visibility flag. If the
  // flag desyncs (badges painted while it reads hidden), keying off it alone
  // makes the toggle "show" a second set on top instead of hiding — the
  // double-badge / "Ctrl+S won't hide" report. Treat any actually-visible
  // badge as "showing" so the toggle always dismisses what the user sees.
  const showing = pageSession.hintsVisible || store.all.some((w) => w.hint?.isVisible);
  if (showing) {
    hideHints();
    keyHandler.exitHintMode();
    setHintsShown(false);  // sticky: stay hidden across navigation
  } else {
    doScan();
    showHints();
    enterHintModeIfManual();
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

dispatcher.register('scroll_down', (params) => {
  const count = parseInt(params.count || '1', 10) || 1;
  const ct = getCycleTarget();
  if (ct) scrollElement(ct, 'down', 'step', count);
  else scroll('down', 'step', count);
});

dispatcher.register('scroll_up', (params) => {
  const count = parseInt(params.count || '1', 10) || 1;
  const ct = getCycleTarget();
  if (ct) scrollElement(ct, 'up', 'step', count);
  else scroll('up', 'step', count);
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

dispatcher.register('scroll_full_down', () => {
  const ct = getCycleTarget();
  if (ct) scrollElement(ct, 'down', 'full');
  else scroll('down', 'full');
});

dispatcher.register('scroll_full_up', () => {
  const ct = getCycleTarget();
  if (ct) scrollElement(ct, 'up', 'full');
  else scroll('up', 'full');
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

// Keyboard help overlay (default ?). Reads the live keymap so it shows the
// user's actual binds. Extension-owned — works without BranchKit connected.
dispatcher.register('toggle_help', () => {
  toggleHelpOverlay(currentKeymap);
});

// Tab verbs — forward to the background SW's handleTabAction (content scripts
// can't touch chrome.tabs). These registrations serve the keyboard path only;
// voice never reaches them (the background intercepts tab actions off the SSE
// stream so they work on pages without a content script).
const TAB_COMMANDS: ReadonlyArray<readonly [string, TabAction]> = [
  ['next_tab', 'next'], ['previous_tab', 'previous'],
  ['first_tab', 'first'], ['last_tab', 'last'], ['goto_tab', 'goto'],
  ['last_active_tab', 'last_active'],
  ['new_tab', 'new'], ['close_tab', 'close'], ['restore_tab', 'restore'],
  ['duplicate_tab', 'duplicate'], ['pin_tab', 'pin'], ['mute_tab', 'mute'],
  ['move_tab_left', 'move_left'], ['move_tab_right', 'move_right'],
];
for (const [command, action] of TAB_COMMANDS) {
  dispatcher.register(command, (params) => {
    const n = parseInt(params.index ?? '', 10);
    const msg: Message = Number.isFinite(n)
      ? { type: 'TAB_ACTION', action, index: n }
      : { type: 'TAB_ACTION', action };
    chrome.runtime.sendMessage(msg).catch(() => {});
  });
}

// Page navigation — also handled inline in the BRANCHKIT_ACTION listener for the
// voice path; registering here makes them keyboard-bindable (extension-owned).
// history.back/forward step the full stack so voice-navigated SPA entries
// (synthetic clicks, isTrusted=false) aren't skipped like the UI buttons do.
dispatcher.register('history_back', () => {
  history.back();
});
dispatcher.register('history_forward', () => {
  history.forward();
});
dispatcher.register('focus_input', () => {
  focusFirstInput();
});
dispatcher.register('refresh', () => {
  location.reload();
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

// Keyboard hint-typing is gated on whether hints are actually painted, not on
// the `f`-entered hint mode — so always-visible hints accept typed codewords
// immediately, no `f` first.
keyHandler.setHintsVisible(() => pageSession.hintsVisible);

// Reject a codeword keystroke that no painted badge starts with, so a stray
// key doesn't filter every hint off the screen. Only consults codeword
// prefixes (not the `/` text filter, which accepts anything).
keyHandler.setMatchPredicate((prefix) => store.matchingLetterPrefix(prefix).length > 0);

keyHandler.setFilterCallback((prefix: string) => {
  if (!pageSession.hintsVisible) return;

  if (prefix === '') {
    for (const w of store.all) {
      w.hint?.setFiltered(false);
      w.hint?.setMatchedChars(0);
    }
    return;
  }

  const matchSet = new Set(store.matchingLetterPrefix(prefix));
  for (const w of store.all) {
    const isMatch = matchSet.has(w);
    w.hint?.setFiltered(!isMatch);
    if (isMatch) {
      w.hint?.setMatchedChars(prefix.length);
    }
  }

  if (matchSet.size === 1) {
    const first = matchSet.values().next().value!;
    // "aA" affordance: a capital typed mid-codeword opens this pick in a new
    // tab. `activateWrapper` reads `activateInNewTab` and `clearHintFilter`
    // resets it, same as the `F` arm.
    if (keyHandler.isNewTabArmed()) activateInNewTab = true;
    activateWrapper(first);
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
    .filter(w => isRectOnScreen(w.element.getBoundingClientRect(), vw, vh))
    .sort((a, b) => {
      const ra = a.element.getBoundingClientRect();
      const rb = b.element.getBoundingClientRect();
      return (ra.top - rb.top) || (ra.left - rb.left);
    });
}

/**
 * Convert a pool token ("a" or "a s") to the LabelAssignment shape the
 * HintBadge renderer expects. The token IS the letter form (extension-owned,
 * BranchKit-independent), so the letter is the tokens joined.
 */
function poolLabelToAssignment(token: string): LabelAssignment {
  const words = token.split(/\s+/).filter(w => w.length > 0);
  return { words, letter: words.join(''), isSingle: words.length === 1 };
}

/**
 * A hint is paint-ready (full opacity) once its voice command is live OR when
 * voice isn't in play at all. The `grammarReady` flag tracks the plugin's
 * grammar ACK, which only arrives when BranchKit is connected; standalone a
 * badge is functional (type / click) the moment it paints, so don't gate it.
 */
function isPaintReady(w: ElementWrapper): boolean {
  return w.grammarReady || !isVoiceAlphabetLoaded();
}

// (The ResizeObserver hintability safety net and the viewport-scoped
// AttentionObserver are owned by `pageSession` — constructed in
// `PageSession.start()` with the other observers, Tier 3 of
// notes/DESIGN_EXTENSION_RESTRUCTURE.md.)

function observeInvisibleCandidates(candidates: Element[]): void {
  // Under the viewport-scoped lifecycle, invisible candidates are routed
  // through the attention observer. They only join `pendingVisibility`
  // when they actually enter the attention region (handled by the
  // session's attentionObserver.onEnter). This bounds the recheck set by
  // viewport proximity instead of total document candidate count —
  // YouTube comment skeletons that scroll past stay registered with
  // attention IO but are no longer rechecked on every MO fire.
  for (const el of candidates) {
    if (store.findWrapperFor(el) || !el.isConnected) continue;
    if (isExcludedByRule(el, getExcludes())) continue;
    pageSession.attentionObserver.observe(el);
  }
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
  // Lever 2 (visibility-defer): hintMachineryEnabled is the single gate for ALL
  // scan work, not just the boot path. It's false for an ineligible frame
  // (Lever 1 frame-skip) or a backgrounded tab whose activation is deferred —
  // neither should run a full-document discovery walk. So a rescan/reactivate/
  // show_hints message that arrives while deferred no-ops here; the scan runs
  // from kickInitialScan when the tab is first shown (activateHintMachinery sets
  // this flag before kickInitialScan, so the normal activation scan still runs).
  // Also no-op while suspended (Lever 3): a rescan/reactivate for a hidden tab
  // waits; resume() runs the catch-up scan after re-attaching the observer.
  if (!hintMachineryEnabled || suspended) return scanChain;
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
  doScanCoalesceTimer = pageSession.resources.timeout(() => {
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
  // Wait one frame so any pending IntersectionObserver entries (queued
  // synchronously by observe(), delivered async) have a chance to fire,
  // then drain pending claims/releases. Without this, a `f` keypress
  // immediately after page load can race the tracker — wrappers exist
  // but their codewords haven't been claimed yet and badges would
  // render with no labels.
  await new Promise(r => requestAnimationFrame(() => r(null)));
  await pageSession.tracker.flushNow();

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

      // Don't paint a badge on a CSS-invisible target (visibility:hidden /
      // opacity:0 — a hover-reveal action bar). These never fire a mutation
      // (they're hidden from the start, never hovered), so the throttled
      // visibility recheck never gets a transition to clean them up — the badge
      // would stay painted (and flicker on scroll) on something the user can't
      // see. Gate at the paint source instead. `cssHidden` (same flag the recheck
      // writes) keeps voice in lockstep via the strict-viewport pass; the cache is
      // warm from cacheLayout above, so isVisible is cheap here.
      const cssVisible = isVisible(wrapper.element);
      wrapper.cssHidden = !cssVisible;
      if (cssVisible) wrapper.hint.show(isPaintReady(wrapper));
      else wrapper.hint.hide();
    }
    firehoseStep('showHints:mount_end', renderable.length, 20);

    // Ensure visibilityMO is running so class/style-driven visibility
    // transitions (YouTube controls fading out, etc.) request the settle
    // pass (schedulePassSoon — the demoted backstop). Idempotent — no-op if
    // already connected, just refreshes the abandon timer.
    if (renderable.length > 0) connectVisibilityMO();

    const __pbStart = performance.now();
    try { placeBadges(renderable); } finally {
      recordCpu('placeBadges:show', performance.now() - __pbStart);
      firehoseStep('showHints:place_end', renderable.length, 20);
    }
  } finally {
    clearLayoutCache();
  }
  pageSession.hintsVisible = true;
  // showHints painted only the strict-viewport `renderable` slice. Converge
  // the rest of the desired set: build badges for in-band (IO-margin)
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
    pageSession.resources.timeout(() => doScan(), 100);
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
  pageSession.resources.timeout(() => {
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

  try {
    cacheLayout(newBadges.map(w => w.element));
    const vw = window.innerWidth, vh = window.innerHeight;
    for (let i = 0; i < newBadges.length; i++) {
      const w = newBadges[i];
      const label = poolLabelToAssignment(w.scanned.codeword);
      w.label = label;
      const onScreen = isRectOnScreen(getCachedRect(w.element), vw, vh);
      // A CSS-invisible target (visibility:hidden / opacity:0 hover-reveal) must
      // not paint — same reason as showHints: no visibility transition fires for
      // a never-revealed target, so the recheck never cleans it up. `cssHidden`
      // keeps the voice (strict-viewport) gate in lockstep.
      const cssVisible = isVisible(w.element);
      w.cssHidden = !cssVisible;
      // Restore the label on an existing dormant (scroll-back) hint even when
      // the element is off the actual viewport. A dormant hint was clearLabel()d
      // on viewport exit; if its codeword is re-granted while it sits in the
      // IO band but below/above the viewport, skipping the label here (the
      // 116b321 regression) leaves it null — and recheckHintedVisibility shows it
      // as an empty box when it later scrolls in. The label is just data on a
      // hidden badge; only show()/placement waits for the actual viewport.
      if (w.hint) {
        w.hint.setLabel(label);
      }
      // Don't construct/paint a badge for an element that's in the IO band
      // but off the actual viewport (e.g. YouTube's collapsed nav drawer at
      // x=-228); placement would clamp it to the edge. It keeps its codeword +
      // (restored) label and paints when it scrolls on-screen. Same skip for a
      // CSS-hidden target.
      if (!onScreen || !cssVisible) continue;
      // Slow path (first-time): construct the badge. The reuse fast path above
      // skips shadow DOM creation, observer wire-up, anchorParent walk, z-index
      // walk, and APCA color recomputation — ~5-10ms per badge on scroll-back.
      if (!w.hint) {
        w.hint = new HintBadge(w.element, label, w.category, getDisplayMode());
      }
      w.hint.show(isPaintReady(w));
      placeOne(w);
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
//     root): they sit in the IO band but outside the strict viewport, so
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
    reattached++;
  }
  if (reattached > 0) firehoseStep('reconcile:reattach', reattached, 1);
}

function reconcile(): void {
  pageSession.tracker.refreshViewportClaims();
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
  pageSession.reconcileTimer = pageSession.resources.timeout(() => {
    pageSession.reconcileTimer = null;
    reconcile();
  }, DEFERRED_REPOSITION_DEBOUNCE_MS);
}

// Lifecycle applier — the codeword/flag half of the settle pass
// (notes/DESIGN_UNIFIED_RECONCILER.md + nav-wipe retirement step 1). The
// plan computes WHICH wrappers are desynced (computeReconcilePlanLists —
// derivation, sets, and the boxless/dormancy nuances live there); this is
// the thin applier. The IO entry/exit branches remain the cheap fast-path;
// this corrects dropped/reordered IO events in either direction and queues
// the claims the IO missed:
//
//   toRelease (stale-TRUE):  flag=in, geometry=out → release codeword; the
//                            flush tears the hint down to dormant
//   toRepair  (stale-FALSE): flag=out, geometry=in → flip flag; the
//                            reconcile below rebuilds
//   toClaim:                 emit-only telemetry, NOT applied. The first
//                            attempt to apply it per pass (7fe37a0, nav-wipe
//                            step 1) fragmented claim/sync into many small
//                            waves during page load (QuickBase trickle,
//                            285 grammar batches / 167 release messages on
//                            one tab) and produced badge doubling on the
//                            coverage fixture — it races the scan pipeline's
//                            inline claims. Reverted 2026-06-12; the
//                            standing-claim-backstop idea needs its own
//                            design with that data (see
//                            DESIGN_NAV_WIPE_RETIREMENT.md status).
function applyLifecyclePlan(lists: ReconcilePlanLists): void {
  for (const w of lists.toRelease) {
    w.isInViewport = false;
    pageSession.tracker.queueRelease(w);
  }
  for (const w of lists.toRepair) {
    w.isInViewport = true;
  }
  // If we corrected any stale-FALSE flags, run reconcile so the just-recovered
  // wrappers also go through build (badgeNewlyCodeworded picks up repaired
  // dormant badges whose codeword survived).
  if (lists.toRepair.length > 0) {
    firehoseStep('reconcile:stale_false_repair', lists.toRepair.length, 1);
    reconcile();
  }
}

// Visibility applier (apply cutover 3/4): the plan decides which badges flip
// (toShow/toHide via wantsShown over the gather, with dormancy and the
// post-repair flag simulated) and which targets' cssHidden changed; this
// writes them. The visibility guards mirror the live recheck's
// transition-only branches (show only a hidden badge, hide only a showing
// one) so the apply stays idempotent against the conditional build pass that
// ran during teardown. No onVisibilityChanged trigger here: the strict step
// runs next in the pipeline and reads the just-written cssHidden, so the
// out-of-band re-push would queue the identical delta. The throttled
// out-of-pipeline recheck (visibility-tracker) keeps its own loop + trigger
// until Phase E.
function applyVisibilityPlan(lists: ReconcilePlanLists): void {
  for (const [w, hidden] of lists.cssHiddenDelta) w.cssHidden = hidden;
  for (const w of lists.toShow) {
    if (w.hint && !w.hint.isVisible) w.hint.show(isPaintReady(w));
  }
  for (const w of lists.toHide) {
    if (w.hint?.isVisible) w.hint.hide();
  }
}

// Strict-viewport re-push applier (apply cutover 2/4): scroll moves wrappers
// across the strict/band boundary without changing their codeword; the
// plugin's `_strict` companion collection (voice matching + Discovery HUD)
// reflects the last-pushed flag, so the delta needs a re-push to converge.
// The plan computes WHICH wrappers (computeStrictDeltaPlan, via wantsStrict
// over the gather geometry); this queues them. Codeword set unchanged — a
// flag refresh.
function applyStrictPlan(delta: ElementWrapper[]): void {
  if (delta.length === 0) return;
  firehoseStep('strict-viewport:delta', delta.length, 1);
  for (const w of delta) queuePut(w);
  scheduleSync('strict-viewport-change');
}

// Demoted backstop entry (Phase E): between-settle signals — the visibility
// MO's class/style ticks, pointer-driven reveals — request the unified pass
// instead of running their own convergence loops (the old 100ms-throttled
// recheckHintedVisibility + the strict re-push it triggered). Non-extending
// single-flight timer, deliberately NOT the scheduleDeferredReposition
// debounce: a debounce pushes back under sustained churn, and the demotion
// contract is "must not get slower than the loops it replaced" — this fires
// within the same 100ms cadence the old throttle guaranteed. The pass is
// budget-priced for that cadence (gather+plan ≈ 4-6ms, Phase B/D evidence).
let passSoonTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePassSoon(): void {
  if (passSoonTimer !== null) return;
  passSoonTimer = pageSession.resources.timeout(() => {
    passSoonTimer = null;
    runSettlePipeline('store');
  }, DEFERRED_REPOSITION_DEBOUNCE_MS);
}

// Occlusion applier (apply cutover 4/4 — notes/DESIGN_HINT_OCCLUSION_FILTERING.md
// for the detection itself). The elementFromPoint hit-tests live in the
// gather (read batch 3, over the visible in-band badge set, flag-gated);
// this writes the overlay signal and folds it into the effective occlusion
// (composes with the clip signal) — hiding the badge and dropping the target
// from the voice-matchable `_strict` collection via the plan's strict delta.
// Empty map (flag off) → no-op. A badge built mid-pipeline by the repair
// path isn't in the map and gets its first hit-test next settle.
function applyOcclusionPlan(gather: SettleGather): void {
  if (gather.overlayCovered.size === 0) return;
  let changed = 0;
  for (const [w, covered] of gather.overlayCovered) {
    w.overlayCovered = covered;
    if (applyOcclusion(w)) changed++;
  }
  if (changed > 0) firehoseStep('occlusion:delta', changed, 1);
}

// Run `cb` on the next idle frame, falling back to a short timeout where
// requestIdleCallback is unavailable (Firefox content scripts historically).
// `timeoutMs` caps the idle wait so a pathologically busy page still runs it.
function runWhenIdle(cb: () => void, timeoutMs: number): void {
  const w = window as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void };
  // Call ON window — extracting the function and invoking it unbound throws
  // TypeError in both engines ("Illegal invocation" / "does not implement
  // interface Window"). The unbound call here meant scheduleBandDiscovery's
  // first invocation threw AFTER setting its single-flight flag, wedging the
  // flag true and silently killing every later band sweep (the persistent
  // discoveryGap in the classify sweeps). Found 2026-06-12 when the nav-hint
  // path called it synchronously.
  if (typeof w.requestIdleCallback === 'function') w.requestIdleCallback(cb, { timeout: timeoutMs });
  else pageSession.resources.timeout(cb, 100);
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
        await pageSession.tracker.flushNow();
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
          pageSession.resources.timeout(() => scheduleBandDiscovery(), DISCOVERY_RETRY_COOLDOWN_MS);
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

pageSession.resources.listen(window, 'focus', (e) => {
  if (e.target === window) windowHasFocus = true;
}, true);
pageSession.resources.listen(window, 'blur', (e) => {
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
pageSession.resources.listen(window, 'pageshow', (e) => {
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
  // Phase 3a trigger-redundancy probe (decision 4): read the plugin's
  // pre-republish epoch so the soak can answer "would the handshake have
  // caught this firing?" per enumerated trigger. epoch_mismatch IS the
  // handshake acting — probing it would be circular, so it's excluded.
  // Fire-and-forget: the heal must not wait a round-trip on telemetry, and
  // the probe snapshots the shadow synchronously before rotateSession
  // clears it.
  if (reason !== 'epoch_mismatch') void probeGrammarEpoch(reason);
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

// Boot this frame's page session (the singleton lives in
// lifecycle/page-session.ts and is imported directly by the source modules).
// start() constructs the six observers — the session is the one owner of
// observer construction/teardown (Tier 3 of DESIGN_EXTENSION_RESTRUCTURE.md)
// — and receives the content.ts orchestration the observers still reach back
// into, replacing the per-module init injection seams with this single call.
pageSession.start({
  teardown: (reason) => quiesceOrphan(reason),
  onUrlChange: (fromCache, reason) => rescanForNav(fromCache, reason),
  restore: () => restoreFromBfcache(),
  onCodewordsChanged: onTrackerCodewordsChanged,
  showHints,
  schedulePassSoon,
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
  onResync: () => {
    // Re-assert pool ownership FIRST: the SW's init ran clearAllStacks(),
    // so the fresh pool has no idea this frame's wrappers hold codewords —
    // until these confirms land, voice routing is broadcast-fallback and a
    // reloading sibling frame could be granted a codeword still painted
    // here (a cross-frame duplicate). The confirm exchange re-acquires
    // them from the fresh pool's free list.
    const held = store.all.map((w) => w.scanned.codeword).filter((cw) => cw !== '');
    if (held.length > 0) labelReservoir.reconfirm(held);
    republishAllGrammar('sw_restart_resync');
  },
});

// --- Orphan-activity gauge (soak instrumentation) ---
//
// Counts how many times a torn-down content script's guard still fired — i.e. a
// surviving listener/event reached a handler after teardown — and mirrors the
// running total to the page as `data-branchkit-orphan-hits`. The soak reads that
// number instead of eyeballing the console: a complete teardown leaves it stable
// after teardown; a climbing value means residual orphan activity. The mirror is
// a plain dataset write (no chrome.*, no throw), so it is safe from a dead
// context. See notes/SOAK_TEARDOWN.md.
let orphanHits = 0;
function recordOrphanHit(): void {
  orphanHits++;
  try {
    document.documentElement.dataset.branchkitOrphanHits = String(orphanHits);
  } catch { /* document gone */ }
}

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
  try { pageSession.tracker.disconnectAll(); } catch { /* same */ }
  try { pageSession.resizeObserver.disconnect(); } catch { /* same */ }
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
  // Stop every session-owned resource (Phase 2a, DESIGN_TEARDOWN_OWNERSHIP.md).
  // No-op for resources not yet migrated to the registry — those still rely on
  // the sendMessage throw as backpressure until they move here.
  try { pageSession.resources.teardownAll(); } catch { /* same */ }
  // Remove badge hosts so the new content script's initial DOM-clear sweep
  // (content.ts ~line 2230) doesn't have to fight visible artifacts.
  try {
    for (const node of document.querySelectorAll('[data-branchkit-hint]')) {
      node.remove();
    }
  } catch { /* document gone */ }
  // Release the idempotency guard so a subsequent injection (e.g. the lazy
  // inject on tab activation after an extension reload) can re-initialize this
  // frame. Without this, the orphan's lingering guard makes every fresh
  // script bail on the "duplicate injection" throw — the tab stays dead until
  // it's closed and reopened. We're tearing down, so we no longer own the
  // frame. Ownership check: if a successor already replaced the guard with its
  // own id, leave it — removing it would let yet another copy boot on top.
  try {
    if (document.documentElement.getAttribute(CS_GUARD_ATTR) === BK_CS_ID) {
      document.documentElement.removeAttribute(CS_GUARD_ATTR);
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

// (preNavDetachAll is gone — notes/DESIGN_NAV_WIPE_RETIREMENT.md step 3. The
// spa_nav hard detach it implemented was freeze-investigation residue; the
// generic limbo/rebind path owns swapped-out content now, and the wedge
// preempt below is the only nav-specific machinery left.)

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
    pageSession.resizeObserver.unobserve(w.element);
    pageSession.tracker.unobserve(w.element);
    pageSession.attentionObserver.unobserve(w.element);
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

      // Both rescan kinds converge on the generic disconnection path
      // (nav-wipe retirement, step 2): swapped-out content parks in limbo,
      // where key-ownership / fingerprint rebind preserve codeword identity
      // onto the new page's matching controls — the same best-effort
      // stability every other regime gets. (The old spa_nav-only hard
      // detach released those codewords instead.) The MutationObserver's
      // removal path usually parked them long before this idle callback;
      // this sweep is the cheap idempotent backstop.
      void navStep('drop_disconnected:start');
      dropDisconnectedWrappers();
      void navStep('drop_disconnected:end');

      void navStep('sync_now:start');
      await syncNow('refocus_from_cache');
      void navStep('sync_now:end');
      const t1 = performance.now();
      chrome.runtime.sendMessage({ type: 'DEBUG_LOG', tag: 'pipeline.cs_scan_completed', data: { elements: store.all.length, duration_ms: Math.round(t1 - t0), path: 'from_cache' } } as Message).catch(() => {});

      // Deferred convergence. Idle-scheduled instead of `setTimeout(300)`:
      // on light pages the idle callback fires in <50ms; on heavy pages the
      // browser holds off until actually idle. The 300ms `timeout` caps the
      // wait. Plan A3 (notes/PLAN_BROWSER_EXTENSION_PERF_OPTIMIZATION.md).
      const scheduleDeferred = () => {
        void navStep('deferred_scan:start');
        // Both rescan kinds run the idempotent doScan. For spa_nav this is
        // NOT about discovery (the MutationObserver huge-path covers that) —
        // doScanBatched is the BULK claim + grammar pipeline: it claims
        // codewords inline per batch and posts grammar in the same sliced
        // walk. Dropping it (nav-wipe retirement step 2, first cut) left
        // post-nav claims to trickle through the IO/settle path in flush
        // waves — on claim-heavy swaps where rebind can't rescue identity
        // (QuickBase report→report: ~230 fresh claims, swap slower than the
        // rebind window) hints+grammar arrived seconds late (soak find,
        // 2026-06-12). doScan skips known elements and consults the limbo
        // pool, so the retirement's stability win is untouched; the settle
        // pass (toClaim) remains the standing backstop for what the scan
        // misses. Routed through doScan() so it can't race a concurrent
        // storage-onChanged scan with the same session_id (duplicate
        // codeword assignments — actuator.log 2026-06-05T17:30:11).
        void doScan().then(async () => {
          reconcile();
          await pageSession.tracker.flushNow();
          if (pageSession.hintsVisible) showHints(activeCategory ?? undefined);
          void navStep('deferred_scan:end');
        });
      };
      if (typeof (window as { requestIdleCallback?: unknown }).requestIdleCallback === 'function') {
        (window as Window & { requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => void })
          .requestIdleCallback(scheduleDeferred, { timeout: 300 });
      } else {
        pageSession.resources.timeout(scheduleDeferred, 100);
      }
    };

    if (typeof (window as { requestIdleCallback?: unknown }).requestIdleCallback === 'function') {
      (window as Window & { requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => void })
        .requestIdleCallback(() => { void runRescan(); }, { timeout: 2000 });
    } else {
      pageSession.resources.timeout(() => { void runRescan(); }, 100);
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
  // Phase 3a trigger-redundancy probe — the reactivate push is the third
  // enumerated trigger (reasons here: sse_connect from the plugin,
  // tab_activated from the background). After the early-out so empty
  // subframes don't probe on every refocus; before rotateSession for the
  // same pre-rotation snapshot reasons as republishAllGrammar.
  void probeGrammarEpoch(reason);
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
      pageSession.resources.timeout(() => { void doScan(); }, 300);
    }
  })();
}

// --- Message Listener (from background / voice) ---

// Voice actions that route straight to the local dispatcher (the same handlers
// the keyboard uses). The discrete scroll/find actions are here so a contributed
// voice phrase (e.g. "scroll down" → scroll_down) runs the identical command as
// its keybind. Parameterized scroll + find_immediate carry params through.
const DISPATCH_PASSTHROUGH_ACTIONS = new Set([
  'scroll', 'scroll_to_element', 'scroll_to_percent',
  'scroll_down', 'scroll_up', 'scroll_half_down', 'scroll_half_up',
  'scroll_full_down', 'scroll_full_up',
  'scroll_top', 'scroll_bottom', 'scroll_left', 'scroll_right',
  'find_open', 'find_close', 'find_next', 'find_previous', 'find_immediate',
  'focus_input',
]);

chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
  // A torn-down orphan (a superseded elder whose chrome.runtime is still live)
  // must not act on broadcasts — it would fire navigations/clicks/grammar into
  // a dead session alongside the successor. See notes/DESIGN_TEARDOWN_OWNERSHIP.md.
  if (pageSession.isTornDown) { recordOrphanHit(); return false; }
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
    } else if (DISPATCH_PASSTHROUGH_ACTIONS.has(action)) {
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
      // The SW translates the inbound spoken prefix word to its letter before
      // forwarding (see frame-router), so `prefix` is already a letter here.
      const letter = params?.prefix;
      if (letter) {
        if (!pageSession.hintsVisible) showHints();
        const matchSet = new Set(store.matchingLetterPrefix(letter));
        for (const w of store.all) {
          const isMatch = matchSet.has(w);
          w.hint?.setFiltered(!isMatch);
          if (isMatch) {
            w.hint?.setMatchedChars(1);
          }
        }
      } else {
        // No prefix — reset all hints to default (cancel pair state)
        for (const w of store.all) {
          w.hint?.setFiltered(false);
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
// The JS reconcile positioner owns badge placement: one batched pass reads
// every registered badge's live target rect and writes composited transforms.
// scheduleReposition drives that pass on a rAF single-flight so the settle
// handlers' shared 100ms debounce funnels into one coalescing policy —
// wedge-safe by construction. The pass's rects also feed the off-screen-hide
// sweep, so no extra layout reads happen here.
let repositionRafPending = false;
function scheduleReposition(): void {
  if (!pageSession.hintsVisible) return;
  if (repositionRafPending) return;
  repositionRafPending = true;
  requestAnimationFrame(() => {
    repositionRafPending = false;
    // Reposition breadcrumbs: a `reposition:start` without matching
    // `reposition:end` pins this as the wedge body. Threshold-gated so
    // steady-state scroll doesn't add 60 sendMessages/sec just for telemetry.
    firehoseStep('reposition:start', reconcileRegistrySize(), 20);
    const __start = performance.now();
    // One batched pass: reads all target rects, writes all transforms, and
    // returns the rects it read. reconcileRead() short-circuits hidden badges
    // and disconnected targets before any gBCR (limbo wrappers — badge held
    // for the ~250ms rebind window — never reach placement; see
    // notes/INVESTIGATION_LIMBO_BADGE_FLASH.md).
    const rects = reconcilePass();
    // Hide badges whose element is fully off-screen — e.g. YouTube's collapsed
    // nav drawer parked at x=-228; the reconciler would otherwise pin them at
    // the live off-screen coords where partial overhang can bleed into the
    // viewport edge. Same predicate every paint path uses (see isRectOnScreen).
    // Reuses the rects the pass above already paid for.
    const vw = window.innerWidth, vh = window.innerHeight;
    for (const w of store.all) {
      if (!w.hint?.isVisible) continue;
      const r = rects.get(w.hint);
      if (r && !isRectOnScreen(r, vw, vh)) w.hint.hide();
    }
    recordCpu('reposition:sweep', performance.now() - __start);
    firehoseStep('reposition:end', rects.size, 20);
  });
}
pageSession.resources.listen(window, 'resize', () => scheduleReposition(), { passive: true });

// Scroll tracking. A viewport-pinned badge host (position:fixed) does not ride
// the compositor, and an inner-pane scroll moves flow targets without moving
// their document-anchored hosts — so during a continuous scroll badges must be
// re-pinned to their targets every frame; the trailing-edge 100ms settle below
// would leave them detached until scroll stops. This runs a per-frame
// reconcilePass() ONLY while scroll events are arriving and only when badges
// exist; it self-cancels ~1 frame after the last scroll event, so it is bounded
// and NOT a free-running rAF (the nav-time wedge discipline).
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

// The scroll settle is debounced. Running the full settle pipeline on every
// rAF during scroll burned ~22% sustained CPU at wrap=99 on YouTube /watch,
// tripped Firefox's "extension is slowing things down" warning, and starved
// YouTube's own scroll-driven lazy-loading so content below the fold failed
// to render. The 100ms debounce coalesces the burst (~30 events/sec during
// fast scrolling) into one settle after scroll stops; per-frame target
// tracking during the scroll itself is the bounded reconcileScrollFrame loop
// above, not the pipeline.

// THE settle pipeline: one ordered convergence pass shared by every debounced
// settle signal (scroll settle and the focus/transition/resize/container-
// mutation settle). Previously duplicated verbatim in the two handlers, where
// the step ordering lived only in comments and the copies were one bug-fix
// away from drifting (2026-06-11 review).
//
// Step order is load-bearing:
//   1. reconcileTeardown — release/repair hints whose IO viewport flag went
//      stale in either direction (the gBCR-bounded backstop).
//   2. discovery — close whichever gap this settle kind can open (see below).
//   3. reconcileClipObservation / reconcileOcclusion — flag covered/clipped
//      targets BEFORE the strict pass so collectStrictViewportDelta reads a
//      fresh `occluded` and drops them from voice with the visual hide.
//      Clip only syncs IO membership (the observers drive `clipped` between
//      settles); occlusion is the settle-debounced elementFromPoint pass.
//      Both no-op when their flags are off.
//   4. reconcileScrollAccel — level-triggered accelerator re-detection: arm
//      badges whose scroller only became scrollable after they were shown,
//      rebuild changed chains. Cheap post-settle; no-op when accel is off.
//   5. recheckHintedVisibility — re-evaluate CSS visibility BEFORE the strict
//      pass so a hover-reveal target that went visibility:hidden gets its
//      badge hidden AND `cssHidden` set, keeping voice in lockstep with the
//      visual hide. Also re-hides any badge a mid-scroll reposition re-showed
//      on a hidden target.
//   6. reconcileStrictViewport — re-push wrappers whose strict-viewport flag
//      changed so the plugin's `_strict` companion collection (voice matching
//      + Discovery HUD) converges to post-settle viewport reality.
//   7. scheduleReposition — drive the batched positioner pass + the
//      off-screen-hide sweep over the rects that pass read.
//
// The `discovery` parameter is the single difference between the two settle
// kinds:
//   'band'  — scroll settle: infinite-scroll content lands here, so sweep the
//             band for hintables the MutationObserver dropped under the
//             mutation storm (the discovery gap). Coalesced + idle-scheduled;
//             a long scroll runs at most one sweep.
//   'store' — focus/transition/resize settle: these signals reveal new
//             in-band hintables among EXISTING wrappers (dropdowns, expanding
//             rows), so converge claim+build over the store. Coalesced so a
//             churny burst collapses to one pass acting on real deltas only.
//
// Steps 1-6 are gated on hintsVisible: the activate command requires the
// hints tag, so voice can't match while hints are down — stale strict
// membership doesn't matter, and the next `show` re-scans from scratch.
// Applied-counts telemetry (Phase E of notes/DESIGN_UNIFIED_RECONCILER.md,
// decision 4): with the plan authoritative, the shadow-vs-live comparison is
// meaningless — the surface now reports what each pass DID. Surfaced on the
// debug snapshot (reconcile_applied) and the perf snapshot. The note's
// "remaining budget" half stays unimplemented per its own open question
// (trust the bounded sets; measure before adding a budget) — until one
// exists, `last` spiking against a quiet page is the tripwire.
const reconcileApplied = {
  passes: 0,
  last: { release: 0, repair: 0, claim: 0, build: 0, show: 0, hide: 0, cssHidden: 0, strict: 0 },
  total: { release: 0, repair: 0, claim: 0, build: 0, show: 0, hide: 0, cssHidden: 0, strict: 0 },
};

/** Diagnostic surfaces owned by this module, merged into every debug
 * snapshot (both the Ctrl+Alt+A path and the test-capture event) BEFORE the
 * send — see captureDebugSnapshot's extras param. */
function snapshotExtras() {
  return {
    grammar_epoch: grammarEpochStats(),
    reconcile_applied: {
      passes: reconcileApplied.passes,
      last: { ...reconcileApplied.last },
      total: { ...reconcileApplied.total },
    },
    // Visibility state — to diagnose a stuck toggle (badges painted but the
    // flag says hidden, so Ctrl+S routes to "show" instead of "hide"). If
    // painted_badges > 0 while hints_visible is false, that's the desync.
    visibility: {
      hints_visible: pageSession.hintsVisible,
      hints_shown: getHintsShown(),
      hint_visibility: getHintVisibility(),
      painted_badges: store.all.filter((w) => w.hint !== null).length,
      claimed_codewords: store.all.filter((w) => w.scanned.codeword.length > 0).length,
      // Actual badge-host DOM nodes. If this exceeds painted_badges, there are
      // untracked/stale badge nodes in the DOM — i.e. visually doubled hints
      // that no wrapper owns (the cleanup-on-hide/scroll gap).
      dom_badge_hosts: document.querySelectorAll('[data-branchkit-hint]').length,
    },
  };
}

function recordApplied(lists: ReconcilePlanLists): void {
  reconcileApplied.passes++;
  const last = {
    release: lists.toRelease.length,
    repair: lists.toRepair.length,
    claim: lists.toClaim.length,
    build: lists.toBuild.length,
    show: lists.toShow.length,
    hide: lists.toHide.length,
    cssHidden: lists.cssHiddenDelta.length,
    strict: lists.strictDelta.length,
  };
  reconcileApplied.last = last;
  for (const k of Object.keys(last) as Array<keyof typeof last>) {
    reconcileApplied.total[k] += last[k];
  }
}

function runSettlePipeline(discovery: 'band' | 'store'): void {
  if (pageSession.hintsVisible) {
    // Clip-membership sync FIRST: its leave-path is the one mid-pipeline
    // writer of the plan's occlusion inputs (clearing `clipped` for targets
    // that left observation) — running it before the gather keeps every
    // plan input stable through the applies. A badge built mid-pipeline by
    // the repair path joins observation next settle (the clip IO drives
    // `clipped` between settles anyway).
    reconcileClipObservation(store.all);
    // GATHER (notes/DESIGN_UNIFIED_RECONCILER.md): one batched read over
    // the bounded sets — rects, styles, occlusion hit-tests, the frame
    // ancestor-chain check. Taken before any write; safe to share because
    // the appliers' writes (badge DOM, flag repairs, queued releases) never
    // move target elements within this synchronous task.
    const gather = gatherSettleReads(store.all);
    // PLAN: the one desired-state derivation deciding every action class
    // over the snapshot, simulating the apply order (flag repairs feed
    // shown-ness; occlusion/cssHidden feed strict).
    const planLists = computeReconcilePlanLists(store, activeCategory, gather);
    // APPLY: thin appliers in the load-bearing step order — enforced here
    // by structure, not comment discipline.
    applyLifecyclePlan(planLists);
    if (discovery === 'band') scheduleBandDiscovery();
    else scheduleReconcile();
    applyOcclusionPlan(gather);
    reconcileScrollAccel();
    applyVisibilityPlan(planLists);
    applyStrictPlan(planLists.strictDelta);
    recordApplied(planLists);
  }
  scheduleReposition();
}

function scheduleScrollReposition(e?: Event): void {
  // Reconcile badges need per-frame re-pinning during the scroll itself (they
  // don't ride the compositor); this fires on every scroll event, before the
  // trailing-edge settle below. No-op when the flag is off (empty registry).
  noteReconcileScroll();
  // Gesture-start accelerator re-detection (timer null = first event of this
  // scroll burst). A scroller that only became scrollable on hover (QuickBase
  // classic report grids flip overflow:hidden->auto under :hover) emits no
  // mutation and, under overlay scrollbars, no reflow — so the settle-time
  // reconcileScrollAccel below hasn't armed it yet and the badge would chase
  // (wiggle) this whole first gesture. Re-arm the badges inside the scroller
  // that just scrolled NOW, so they ride the compositor from the first frame.
  // Scoped to e.target's subtree, so window/document scroll and already-ridden
  // scrollers cost only a cheap contains-check per badge.
  if (pageSession.scrollRepositionTimer == null && e && e.target instanceof Element) {
    reconcileScrollAccelForScroller(e.target);
  }
  if (pageSession.scrollRepositionTimer) clearTimeout(pageSession.scrollRepositionTimer);
  pageSession.scrollRepositionTimer = setTimeout(() => {
    pageSession.scrollRepositionTimer = null;
    // Scroll-settle is the canonical viewport-exit moment (stale-TRUE release)
    // AND where infinite-scroll content lands (band discovery).
    runSettlePipeline('band');
  }, DEFERRED_REPOSITION_DEBOUNCE_MS);
}
pageSession.resources.listen(window, 'scroll', scheduleScrollReposition, { passive: true });
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
pageSession.resources.listen(document, 'scroll', scheduleScrollReposition, { passive: true, capture: true });

// Per-container resize: each HintBadge registers its anchor with the
// shared tracker. Catches CSS-only and container-scoped layout shifts
// (animated dropdowns, sibling row expansion, :focus-within rules)
// that don't surface as a window scroll/resize or a DOM mutation —
// the classic "click → hints look stale" case.
//
// Debounced (not direct scheduleReposition) for the same reason scroll
// is: on churny pages (YouTube /watch, where comment threads + player +
// chapters resize continuously during scroll as content lazy-loads) the
// RO fires ~15/sec. Coalescing to one settle after layout stabilizes
// trades a ~100ms lag on resize-driven repositions — imperceptible
// mid-scroll, same trade already accepted for scroll.
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
    // 'store' discovery: container resize / focus / transition / zoom reveal
    // new in-band hintables among existing wrappers and can push wrappers
    // across the strict boundary without a scroll event.
    runSettlePipeline('store');
  }, DEFERRED_REPOSITION_DEBOUNCE_MS);
}
pageSession.resources.listen(document, 'focusin', scheduleDeferredReposition, { passive: true });
pageSession.resources.listen(document, 'focusout', scheduleDeferredReposition, { passive: true });
pageSession.resources.listen(document, 'transitionend', scheduleDeferredReposition, { passive: true });
pageSession.resources.listen(document, 'animationend', scheduleDeferredReposition, { passive: true });
// Pointer-driven visibility sweep. A CSS `:hover` reveal (QuickBase widget
// action bars, dropdown menus) flips targets from visibility:hidden to visible
// with NO DOM mutation and often no transition — so neither the class/style
// MutationObserver nor transitionend fires. schedulePointerVisibilitySweep does
// BOTH halves the MutationObserver does: it PROMOTES a freshly-revealed candidate
// from pendingVisibility into a hinted wrapper (so a never-scanned-while-visible
// element actually gets a badge — the fix for the temperamental "hover the
// report, no hint") and RE-SHOWS already-hinted badges. pointerover fires on
// entering any element (not per-pixel like mousemove), and the pointer variant
// throttles BOTH halves to 100ms (the promote doesn't need rAF cadence here), so
// movement-driven cost stays bounded.
pageSession.resources.listen(document, 'pointerover', schedulePointerVisibilitySweep, { passive: true, capture: true });
// Pointer left the window entirely: the `:hover` reveal collapses back to
// visibility:hidden, but no further `pointerover` fires to catch it, so the badge
// would linger until the next settle. `pointerout` with a null `relatedTarget`
// means the pointer exited to outside the document — sweep then so the badge
// hides promptly. Mirrors how Rango pairs focusin with focusout. The IN-PAGE
// un-hover case needs no handler: moving onto any other element fires another
// `pointerover`. Gated on the null check so ordinary in-page pointerouts (every
// element boundary crossing) don't double the sweep rate.
pageSession.resources.listen(document, 'pointerout', (e: PointerEvent) => {
  if (e.relatedTarget === null) schedulePointerVisibilitySweep();
}, { passive: true, capture: true });
// Window resize covers genuine viewport changes (drag corner, device
// rotation, DevTools open/close) AND browser zoom (Cmd+= reflows the
// layout and changes innerWidth/innerHeight in CSS pixels). Route through
// the deferred path so the strict-viewport reconciler runs.
pageSession.resources.listen(window, 'resize', scheduleDeferredReposition, { passive: true });

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

pageSession.resources.listen(document, 'keydown', (e: KeyboardEvent) => {
  if (pageSession.isTornDown) return;
  // While the find bar is open it owns the keyboard — its focused input handles
  // typing and its own keydown handles Enter/Escape. Returning here (without
  // preventDefault) lets the keystroke reach that input and keeps the hint key
  // handler from treating letters as codeword filtering.
  if (isFindBarOpen()) return;
  // After Enter commits the search the bar closes but highlights persist; n /
  // Shift+n cycle matches and Escape clears. This runs before the hint key
  // handler so bare n isn't swallowed as codeword input in always-mode.
  if (handleFindNavKey(e)) return;
  // Focus-input mode (Vimium gi): Tab/Shift+Tab cycle text fields. Runs before
  // the hint handler so Tab cycling isn't pre-empted, and in capture phase so it
  // beats the focused input's native Tab.
  if (handleFocusInputKey(e)) return;

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
    captureDebugSnapshot(store, url, snapshotExtras());
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

pageSession.resources.listen(document, 'keyup', (e: KeyboardEvent) => {
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
pageSession.resources.listen(document, '__branchkit__capture_snapshot', () => {
  try {
    const payload = captureDebugSnapshot(store, trimFrameUrl(window.location.href), snapshotExtras());
    document.documentElement.dataset.branchkitSnapshot = JSON.stringify(payload);
  } catch {
    // Snapshot build failed (detached store, serialization); leave the
    // previous mirror in place rather than wedging the page.
  }
}, true);

// Soak hook: a page-world dispatch of this event forces the orphan teardown
// path, so the harness (notes/SOAK_TEARDOWN.md) can induce the torn-down state
// deterministically without a real extension reload, then fire events and read
// the branchkitOrphanHits gauge. `once` so it self-removes after firing.
document.addEventListener('__branchkit__force_teardown', () => {
  pageSession.teardown('orphan');
}, { once: true });

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
  // Resurrection guard: a torn-down orphan must not re-discover into a dead
  // session. Reached via SHADOW_EVENT, this rebuilds observers/wrappers that
  // quiesceOrphan removed. See notes/DESIGN_TEARDOWN_OWNERSHIP.md.
  if (pageSession.isTornDown) { recordOrphanHit(); return 0; }
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
  // Resurrection guard: a torn-down orphan (e.g. a visibilitychange after
  // supersede) must not re-arm the MutationObserver + scan loop that teardown
  // stopped. See notes/DESIGN_TEARDOWN_OWNERSHIP.md.
  if (pageSession.isTornDown) { recordOrphanHit(); return; }
  if (hintMachineryEnabled) return;
  hintMachineryEnabled = true;
  attachPageMutationObserver();
  // Registry-owned (Phase 2a): teardown clears it instead of leaving an orphan
  // limbo sweeper running. Behavior-identical while the session is alive.
  pageSession.resources.interval(finalizeExpiredLimboWrappers, LIMBO_DEADLINE_MS);
  if (trigger === 'resize') {
    // Subframe that just grew past the eligibility threshold. The module-
    // load reservoir warm-up was skipped (frame was too small / blank),
    // so warm it now before the first scan so the IO claim path doesn't
    // pay an IPC round-trip on its first batch.
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      void labelReservoir.ensureReady();
    }
    pageSession.resources.timeout(() => doScan(), 0);
  }
}

// Lever 3 (hidden-tab suspend): stop reacting to the page's DOM churn while the
// tab is backgrounded. Disconnect ONLY the page MutationObserver (the lone
// continuous cost in a hidden tab — the IO/resize observers are dormant without
// scroll/relayout) and cancel the discovery rAF. Preserve wrappers, codewords,
// pool claims, badges, registry: this is reversible, NOT teardown
// (cf. quiesceOrphan). See notes/DESIGN_HIDDEN_TAB_SUSPEND.md.
function suspendHintMachinery(): void {
  if (suspended || !hintMachineryEnabled) return;
  suspended = true;
  teardownMutationSource();
  if (pageSession.discoveryFrame !== null) {
    cancelAnimationFrame(pageSession.discoveryFrame);
    pageSession.discoveryFrame = null;
    pageSession.pendingDiscoveryRoots.clear();
  }
  bkLog('BK_SUSPEND', { url: trimFrameUrl(window.location.href), wrappers: store.all.length });
}

// Re-arm the page MutationObserver and catch up on whatever the page mutated
// while we were suspended: doScan discovers new content + drops detached
// wrappers, reconcile refreshes viewport claims. Mirrors the from_cache
// reactivate path; doScan's scanChain serializes this against the background's
// reactivate so there's no duplicate-codeword race.
function resumeHintMachinery(): void {
  // Resurrection guard (see activateHintMachinery): a torn-down orphan that
  // goes visible must not resume the MutationObserver + scan loop.
  if (pageSession.isTornDown) { recordOrphanHit(); return; }
  if (!suspended) return;
  suspended = false;
  attachPageMutationObserver();
  void doScan().then(() => {
    reconcile();
    void pageSession.tracker.flushNow();
    if (pageSession.hintsVisible) showHints(activeCategory ?? undefined);
  });
  bkLog('BK_RESUME', { url: trimFrameUrl(window.location.href), wrappers: store.all.length });
}

// One persistent visibilitychange handler driving the deferred/active/suspended
// state machine for an eligible frame. A subframe inherits the top document's
// visibility, so the whole tab transitions as a unit.
//   - Lever 2 (lazy discovery): a tab that loaded hidden activates on first show.
//   - Lever 3 (suspend): an active tab suspends when hidden, resumes when shown.
function onVisibilityChange(): void {
  if (!frameMayHoldHints()) return;
  if (document.visibilityState === 'visible') {
    if (!hintMachineryEnabled) {
      // First show of a tab that loaded hidden. 'load' relies on the storage
      // callback for the first scan, but that returned early while hidden —
      // kick it here.
      activateHintMachinery('load');
      kickInitialScan();
    } else if (suspended) {
      resumeHintMachinery();
    }
  } else if (hintMachineryEnabled && !suspended) {
    suspendHintMachinery();
  }
}
pageSession.resources.listen(document, 'visibilitychange', onVisibilityChange);

if (frameMayHoldHints()) {
  // Visible (foreground) tab: activate now (the storage callback kicks the
  // initial scan). Hidden/prerender: stay inert; onVisibilityChange activates
  // on first show (lazy discovery).
  if (document.visibilityState === 'visible') {
    activateHintMachinery('load');
  }
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

pageSession.resources.listen(document, SHADOW_EVENT, (event) => {
  const host = event.target;
  // Disconnected-attach signal: the bootstrap dispatches a bare event on
  // document (an event on a disconnected element can't propagate here, and
  // no host reference crosses the MAIN→ISOLATED boundary — detail objects
  // read as null). Record that one happened; while the signal is live,
  // drainDiscovery deep-checks roots its light-DOM pre-filter would skip,
  // so the host's subtree is walked when it gets inserted.
  if (host === document) {
    noteDisconnectedShadowAttach();
    return;
  }
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
    // (IO band margin), how many actually hold a codeword. < 1.0 ratio = the
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
    // Grammar-epoch tripwire (Phase 2a of DESIGN_GRAMMAR_EPOCH_HANDSHAKE.md):
    // checks should climb with sync traffic; mismatches should stay 0 except
    // around the enumerated republish triggers — those firings are the
    // evidence Phase 3 needs before retiring them.
    grammarEpoch: grammarEpochStats(),
    // What the settle pass DID (Phase E, decision 4 of the unified-reconciler
    // note): per-class applied counts for the last pass + cumulative. The
    // plan is authoritative, so this replaces the old shadow counts/diff.
    reconcileApplied: {
      passes: reconcileApplied.passes,
      last: { ...reconcileApplied.last },
      total: { ...reconcileApplied.total },
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
// Top frame only: the dataset mirror exists for Playwright/in-page inspection,
// which reads the top document's element. A subframe publishing to its own
// (unread) documentElement is pure 4Hz waste across the ad-frame swarm.
if (isTopFrame) {
  pageSession.resources.interval(publishPerfSnapshot, 250);
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
  pageSession.resources.interval(shipPerfReport, PERF_REPORT_INTERVAL_MS);
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

