/**
 * BranchKit Browser — Content script entry point.
 *
 * Injected per frame. Scans DOM, creates badges, handles keyboard input.
 * Voice commands arrive via background → BRANCHKIT_ACTION messages.
 */

import { HintVisibility, ScannedElement, Message, DispatchResult, TabAction, ZoomAction } from './types';
import { LabelAssignment, isVoiceAlphabetLoaded, setAlphabet } from './labels/words';
import { initConnectionMirror, isBranchKitConnected } from './plugin/connection-mirror';
import { scanElements, scanSingle, isHintable, isVisible, deepQuerySelectorAll, scanInBatches, DEFAULT_SCAN_BATCH_SIZE, getPerfCounters, resetPerfCounters } from './scan/scanner';
import { noteDisconnectedShadowAttach } from './scan/shadow-attach-signal';
import { DiscoverySource, ElementWrapper } from './scan/element-wrapper';
import { wantsHint } from './lifecycle/desired-state';
import { runBuildPass, createSingleFlight, WAVE_BUILD_BUDGET_MS } from './lifecycle/build-queue';
import {
  computeReconcilePlanLists,
  RECONCILE_BAND_MARGIN_PX,
  type ReconcilePlanLists,
} from './lifecycle/reconcile';
import { gatherSettleReads, SettleGather } from './lifecycle/gather';
import { stampStrictViewport, drainStampDisagree } from './lifecycle/strict-viewport';
import * as idRegistry from './scan/registry';
import type { CodewordMemoryEntry } from './labels/codeword-memory';
import { loadRecall, recalledCodewords, rememberLive, resolvePreferredCodeword, isRecallLoaded } from './labels/codeword-recall';
import { type RebindCounters } from './labels/rebind';
import { resolveTarget } from './activate/activate-resolution';
import { schedulePointerVisibilitySweep, connectVisibilityMO, teardownVisibilityTracker, observeRevealCandidate } from './observe/visibility-tracker';
import { rebindCounters, LIMBO_DEADLINE_MS, collectLimboWrappers, collectStrongKeyIndex, dropDisconnectedWrappers, finalizeExpiredLimboWrappers, slotProbe, limboSlotLiveness } from './observe/limbo';
import { attachWrapper, detachWrapper, seedPreferredFromMemory, attachDiscovered } from './core/wrapper-lifecycle';
import { attachPageMutationObserver, getObserverFirstAttachedAt, teardownMutationSource, getDomAddEpoch } from './observe/mutation-source';
import { shouldRunBandSweep, setSweepGateEnabled } from './lifecycle/band-sweep-gate';
import { firehoseStep } from './debug/firehose';
import { bkLog } from './debug/bk-log';
import { harnessHooksEnabled } from './debug/harness-hooks';
import { store } from './core/store';
import { HintBadge } from './render/hints';
import { reconcilePass, drain as drainReconcilePositioner, reconcileRegistrySize, lastReconcileChangedWrites } from './render/reconcile-positioner';
import { onContainerResize } from './observe/container-resize-tracker';
import { onTransformAncestorMutation, setTransformTriggerEnabled } from './observe/transform-ancestor-tracker';
import { onTargetMutation } from './observe/target-mutation-tracker';
import { setOcclusionEnabled, applyOcclusion } from './observe/occlusion';
import { setOcclusionMemoEnabled, occlusionMemoAllDirty, occlusionMemoNoteTarget, occlusionMemoNotePointer } from './observe/occlusion-memo';
import { reconcileClipObservation, drainClipObservers, setClipObserverEnabled } from './observe/clip-observer';
import { cacheLayout, cacheConstruction, clearLayoutCache, geometryInBand, getCachedRect, isRectOnScreen } from './layout-cache';
import { placeBadges, invalidateProbe } from './placement';
import { activateElement, dispatchHover, resolveNavTarget, type ActivationResult } from './activate/event-sequence';
import {
  emitActivatePath,
  elementSnap,
  type ActivatePathEvent,
} from './activate/activate-path-log';
import { captureDebugSnapshot } from './debug/debug-snapshot';
import { toggleOverlay } from './render/debug-overlay';
import { toggleHelpOverlay, isHelpOverlayActive } from './render/help-overlay';
import { overridesFromList, type OverrideRecord } from './command-override';
import { togglePalette, closePalette } from './render/palette-host';
import { setTabMarker, reapplyTabMarker, refreshTabMarker } from './render/tab-title';
import { setModeChip } from './render/mode-chip';
import { getSiteKeyState, onSiteKeysChanged } from './keyboard-rules';
import { findPageLink, type Rel } from './pagination';
import { urlUp, urlRoot } from './url-nav';
import { copyText } from './clipboard';
import { flashToast } from './render/toast';
import {
  PREV_POSITION_REGISTERS, isPrevPositionRegister, marksToHash, type StoredMark,
} from './marks';
import { CaretController, type CaretVoiceOp } from './activate/caret';
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
import { setScrollAccelEnabled, setScrollAccelNestedEnabled, reconcileScrollAccel, reconcileScrollAccelForScroller, reconcileTransformTrigger } from './render/scroll-accel-glue';
import { isScrollTimelineSupported } from './render/scroll-accel';
import { setNudgesFromSettings } from './placement';
import { labelReservoir } from './labels/label-reservoir';
import { filterNewBatchRefs } from './scan/batch-dedup';
import { resolveHintLocally, reportDispatchResult } from './plugin/resolve';
import { openLivenessPort } from './plugin/liveness';
import { pageSession, scheduleYieldTask, yieldTask, TeardownReason } from './lifecycle/page-session';
import { ensureSendMessageWrapped, resetMessageCounters, messageCountersSnapshot } from './debug/message-counters';
import { recordCpu, resetCpuCounters, resetLongtask, resetWatchdog, computeCpuShare, rearmCpuShareBaseline, rearmWatchdogBaseline, cpuBucketsSnapshot, longtaskSnapshot, watchdogSnapshot, startPerfObservers, lifecycleCounters, resetLifecycleCounters } from './debug/perf-counters';
import { churnStats } from './debug/churn-log';
import { syncTraceStats } from './debug/sync-trace';
import { loadConfig, getDisplayMode, getHintVisibility } from './config';
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
  drainPendingDeletes,
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
  if (harnessHooksEnabled()) {
    try {
      const pw = ((window as unknown as { wrappedJSObject?: Window }).wrappedJSObject ?? window) as unknown as {
        __branchkitDebugJSON?: string;
      };
      const arr = JSON.parse(pw.__branchkitDebugJSON ?? '[]');
      arr.push({ aborted_at: performance.now(), ready: document.readyState, owner: guardOwner });
      pw.__branchkitDebugJSON = JSON.stringify(arr);
    } catch { /* diagnostic only */ }
  }
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
// load-bearing for any feature. Harness builds only (release builds must not
// hand pages a fingerprintable page-world global).
if (harnessHooksEnabled()) {
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
}

// Append a diagnostic entry to the page-world bridge (see boot entry above
// for the Xray/string-encoding rationale). Non-fatal by construction.
function pushDebugBridge(entry: Record<string, unknown>): void {
  if (!harnessHooksEnabled()) return;
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

if (isTopFrame) startPerfObservers(pageSession.resources);

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
  // Build-up reconcile: codewords just landed — build and paint their
  // badges NOW, synchronously, in this task (the claim flush fires in the
  // drain task's microtask tail, so element-appears → badge-painted is one
  // task, Rango's shape). Safe against the round-4 discovery starvation
  // because the walk completes all pending roots before this tail runs.
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
  onActivate: () => { hideBadges(); },
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
// declaration; store is imported; the visibility flag (pageSession.badgesVisible)
// is read lazily via the arrow. Catchup-built badges converge through the single
// reconcile entry.
initLabelSync({
  store,
  detachWrapper,
  reconcile,
  isBadgesVisible: () => pageSession.badgesVisible,
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
// no-badges-on-refresh boot race (2026-06-12): when the visibility config
// load beat the alphabet load, the boot showBadges() early-returned on the
// missing alphabet WITHOUT setting badgesVisible, and the alphabet-callback
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
// "always" mode. "manual" mode never auto-shows (summon with `f`). A Shift+F
// hide in always mode is momentary (this page only): there is no persisted
// hidden state, so the next page paints them again — "Always" always means
// always, and a stray hide can never silently strand the badges off.
function shouldAutoShowBadges(): boolean {
  return getHintVisibility() === 'always';
}

loadConfig({
  onDisplayModeChange: () => {
    if (pageSession.badgesVisible) updateBadgeLabels();
    // The tab-title marker follows the same setting — re-render it in place so
    // the tab prefix and the on-page hints for a letter stay in lockstep.
    refreshTabMarker();
  },
  onHintVisibilityChange: () => {
    const v = getHintVisibility();
    if (v === 'always') {
      if (!pageSession.badgesVisible) showBadges();
    } else if (v === 'manual' && pageSession.badgesVisible) {
      hideBadges();
    }
  },
});

// Tab markers (notes/DESIGN_TAB_MARKERS.md): the top frame bootstraps its
// marker on load. Background assigns lazily and replies with the letter form
// (or null when the feature is off / no alphabet). Retitles arrive later as
// TAB_MARKER_REAPPLY; assignment changes as TAB_MARKER.
if (isTopFrame && typeof chrome !== 'undefined' && chrome.runtime) {
  chrome.runtime.sendMessage({ type: 'GET_TAB_MARKER' } as Message)
    .then((resp) => { if (resp && 'letters' in resp) setTabMarker(resp.letters ?? null); })
    .catch(() => {});
}

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
      // Word/expand-mode tab markers show spoken words, so a new alphabet
      // changes them too (no-op in letter mode / unmarked frames).
      refreshTabMarker();
      void syncNow('alphabet_change');
    }
    // Live-apply the bkTransformTrigger kill-switch so a console flip takes
    // effect in open tabs without a reload: re-arm/disarm every live badge's
    // transform-ancestor tracking against the new value. Default-on semantics —
    // only an explicit `false` disables (a removed key reads as on).
    if (changes.bkTransformTrigger) {
      const on = changes.bkTransformTrigger.newValue !== false;
      setTransformTriggerEnabled(on);
      reconcileTransformTrigger();
      if (harnessHooksEnabled()) {
        document.documentElement.setAttribute('data-bk-transform-trigger', on ? 'on' : 'off');
      }
    }
  });
}

// Host-connection mirror (paint only — never gates grammar transport; see
// plugin/connection-mirror.ts). Disconnected badges paint at full opacity:
// voice isn't coming, so bk-pending ("voice not ready YET") would be a
// permanent lie, and the hint is fully functional by typing regardless. On a
// live disconnect, flip the already-painted pending badges opaque in place.
// No flip back on connect: the plugin's sse_connect reactivate re-Puts every
// live wrapper and the ACKs solidify (or per-codeword-fail detach) within a
// round-trip, so the opaque-but-unacked window self-heals.
initConnectionMirror((nowConnected) => {
  if (nowConnected) return;
  for (const w of store.all) {
    if (!w.grammarReady) w.hint?.clearPending();
  }
});

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
    if (shouldAutoShowBadges()) {
      whenDOMSettles(() => {
        pageSession.tracker.flushNow().then(() => {
          if (shouldAutoShowBadges() && !pageSession.badgesVisible) showBadges();
        });
      });
    }
  }, 0);
}

if (typeof chrome !== 'undefined' && chrome.storage?.local) {
  chrome.storage.local.get('alphabet', (result) => {
    if (Array.isArray(result.alphabet)) {
      setAlphabet(result.alphabet);
      // If the marker bootstrapped (letter mode) before this overlay loaded, a
      // word/expand setting needs a re-render to show spoken words.
      refreshTabMarker();
    }
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
//   confirmed). Both flags are ANDed with isScrollTimelineSupported() at apply
//   time, so Firefox stable (no ScrollTimeline) runs the JS-chase fallback with
//   the accel glue fully off — not just null accelerators. EXIT: delete these
//   flags after a clean soak (~2026-06-17), keeping the feature-detect.
// bkOcclusion - default ON, validated helpful but still watching for FALSE
//   POSITIVES (a real badge wrongly hidden = voice silently can't match it).
//   EXIT: keep on if the soak stays clean, else investigate; reconfirm at launch.
// bkClipObserver - default ON, composes with bkOcclusion (IO-clip vs
//   elementFromPoint hit-test). Same exit as bkOcclusion.
// bkOcclusionMemo - default ON, SHADOW phase (notes/DESIGN_OCCLUSION_HITTEST_
//   MEMO.md): the fresh hit-test still runs; the memo only counts the reuse
//   decisions it would have made + divergences (occlusion_memo:diverged).
//   EXIT: zero divergence at real volume → flip authoritative (skip the fresh
//   test on reuse), keeping this as the kill switch.
// bkSweepGate - default ON. Skips the per-settle band-discovery body re-walk
//   while the DOM-add epoch is clean (no observed childList adds since the
//   last walk) and the last sweep is <30s old; mass-reveal fast-arm bypasses.
//   EXIT: watch bandDiscovery:skipClean vs discoverInSubtreeBatched in the
//   perf trail + no badge-appearance lag reports, then graduate. See
//   notes/DESIGN_BAND_SWEEP_DIRTY_GATE.md.
// bkTransformTrigger - default ON, GRADUATED (user-validated on the QuickBase
//   pipeline builder). Adds a MutationObserver on each badge's transformed
//   ancestors so pan/zoom canvases (React Flow) that move by `transform` with no
//   scroll event still drive the reconcile follow loop — fixes the badge wiggle.
//   Only an explicit `false` disables (console kill-switch if a chatty inline-
//   transform ancestor ever causes reposition churn). See
//   notes/DESIGN_TRANSFORM_ANCESTOR_RECONCILE.md.
if (typeof chrome !== 'undefined' && chrome.storage?.local) {
  chrome.storage.local.get('bkOcclusion', (result) => {
    // Occlusion filtering (notes/DESIGN_HINT_OCCLUSION_FILTERING.md). Default ON
    // for the dogfood phase; only an explicit `false` disables. Watch for false
    // positives (a real badge hidden) — `chrome.storage.local.set({ bkOcclusion: false })`
    // to rule it out.
    setOcclusionEnabled(result.bkOcclusion !== false);
    if (harnessHooksEnabled()) {
      document.documentElement.setAttribute('data-bk-occlusion', result.bkOcclusion !== false ? 'on' : 'off');
    }
  });
  chrome.storage.local.get('bkOcclusionMemo', (result) => {
    // Occlusion hit-test memoization (shadow phase — see the registry above).
    // Only an explicit `false` disables: `chrome.storage.local.set({ bkOcclusionMemo: false })`.
    setOcclusionMemoEnabled(result.bkOcclusionMemo !== false);
    if (harnessHooksEnabled()) {
      document.documentElement.setAttribute('data-bk-occlusion-memo', result.bkOcclusionMemo !== false ? 'on' : 'off');
    }
  });
  chrome.storage.local.get('bkTransformTrigger', (result) => {
    // Default ON (graduated): only an explicit `false` disables. See registry above.
    const on = result.bkTransformTrigger !== false;
    setTransformTriggerEnabled(on);
    if (harnessHooksEnabled()) {
      document.documentElement.setAttribute('data-bk-transform-trigger', on ? 'on' : 'off');
    }
  });
  chrome.storage.local.get('bkSweepGate', (result) => {
    // Band-sweep dirty gate (notes/DESIGN_BAND_SWEEP_DIRTY_GATE.md). Default
    // ON; only an explicit `false` disables — restoring every-settle arming.
    // Watch for content that appears without badges until the 30s long-stop
    // (an MO-blind add class the epoch misses) — that's the gate's tell.
    const on = result.bkSweepGate !== false;
    setSweepGateEnabled(on);
    if (harnessHooksEnabled()) {
      document.documentElement.setAttribute('data-bk-sweep-gate', on ? 'on' : 'off');
    }
  });
  chrome.storage.local.get('bkClipObserver', (result) => {
    // Scroll-container clip detection (IO-root=scroller, Rango's idea). Default ON;
    // only an explicit `false` disables. Composes with bkOcclusion — the IO-clip
    // path and the elementFromPoint overlay path both feed the effective occlusion.
    setClipObserverEnabled(result.bkClipObserver !== false);
    if (harnessHooksEnabled()) {
      document.documentElement.setAttribute('data-bk-clip-observer', result.bkClipObserver !== false ? 'on' : 'off');
    }
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
    // Gate the glue on the feature detect, not just the flag. createScrollAccel
    // already returns null without ScrollTimeline (Firefox stable), but with the
    // glue enabled that null meant the reconcile never converged: every settle
    // re-ran syncScrollAccelChain on every badge in an inner scroller — an
    // ancestor walk of scrollHeight/getComputedStyle reads right after the
    // pipeline's writes — then bumped the re-arm attribute and tried again,
    // forever (data-bk-accel-rearms in the thousands on a day-old Gmail tab).
    // With the glue off, badges ride the shared scroll-active rAF chase instead.
    const supported = isScrollTimelineSupported();
    setScrollAccelEnabled(enabled && supported);
    setScrollAccelNestedEnabled(nested && supported);
    // Page-visible diagnostic markers on <html>: 'on' = flag set + ScrollTimeline
    // supported; 'unsupported' = no ScrollTimeline (Firefox stable); 'off' = not
    // set. Pair with `document.querySelectorAll('[data-bk-accel]').length`.
    // Harness builds only (same fingerprint class as the perf mirror).
    if (harnessHooksEnabled()) {
      document.documentElement.setAttribute(
        'data-bk-scroll-accel',
        enabled ? (isScrollTimelineSupported() ? 'on' : 'unsupported') : 'off',
      );
      document.documentElement.setAttribute('data-bk-scroll-accel-nested', nested ? 'on' : 'off');
    }
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
// Shift+J/K/D/U/T/G scroll; Shift+H/L cycle tabs; Shift+F toggles hints, `f`
// enters hint mode, and a capital letter in hint mode opens in a new tab — the
// trio that replaced the discrete show/hide/show-new-tab commands. A few
// inherently-bare, hidden-only binds (h/l horizontal scroll, `cs`, `/`, `n`).
// Users add extra binds (e.g. plain j) via the options editor.
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

// `f` — the keyboard entry into hint mode (notes/DESIGN_KEYBOARD_MODES.md).
// Hints stay always-visible for voice, but letters only filter them here. So
// `f` ensures hints are painted and puts the keyboard in hint mode; the mode
// chip then signals "type a codeword". Escape / activation returns to Normal.
dispatcher.register('hint_mode', () => {
  if (!pageSession.badgesVisible) { doScan(); showBadges(); }
  keyHandler.enterHintMode();
});

// The keyboard "hint action mode": what the next badge resolved by keyboard
// should DO instead of a plain click. One armed value replaces the old pair of
// booleans (activateInNewTab + yankHintArmed) so new verbs are a one-line add.
// Set by a verb command (or the capital-letter new-tab affordance) before/while
// in hint mode; consumed + reset in activateWrapper. See
// notes/DESIGN_HINT_ACTION_MODES.md.
type HintAction = 'activate' | 'newtab' | 'yank' | 'hover' | 'focus' | 'copytext' | 'caret';
let pendingHintAction: HintAction = 'activate';

// The shared show/hide toggle used by both Shift+F (keyboard) and the voice
// "toggle" command, so the two entry points can't drift. Branches on what's
// actually on screen, not just the visibility flag: if the flag desyncs
// (badges painted while it reads hidden), keying off it alone makes the toggle
// "show" a second set on top instead of hiding — the double-badge / "won't
// hide" report. Treat any actually-visible badge as "showing" so the toggle
// always dismisses what the user sees. Keeps the new-tab modifier untouched so
// a stray toggle doesn't re-arm new-tab activation.
//
// The hide is momentary — NOT persisted. In always mode the next page repaints
// the badges (shouldAutoShowBadges); in manual mode a fresh page is hidden by
// the mode itself. Persistent "stay hidden while I browse" IS manual mode, so
// there's no separate hidden flag to silently override the visible setting.
// Returns true if it ended up showing.
function toggleHints(): boolean {
  const showing = pageSession.badgesVisible || store.all.some((w) => w.hint?.isVisible);
  return setBadgesVisible(!showing);
}

// Drive badges to a definite visibility. The popup's Show/Hide button uses this
// (a definite set, not a blind toggle, so a click can't race the read that
// labeled the button). Momentary — no persistence, exactly like Shift+F: in
// always mode the next page repaints; in manual mode a fresh page is hidden by
// the mode. Returns the resulting shown state. No-op when already there.
function setBadgesVisible(visible: boolean): boolean {
  const showing = pageSession.badgesVisible || store.all.some((w) => w.hint?.isVisible);
  if (visible === showing) return showing;
  if (visible) {
    doScan();
    showBadges();
    enterHintModeIfManual();
  } else {
    hideBadges();
    keyHandler.exitHintMode();
  }
  return visible;
}

dispatcher.register('toggle_hints', () => { toggleHints(); });

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
// On open, fetch phrase overrides so spoken forms match what actually works;
// on close, toggle immediately (no round trip).
dispatcher.register('toggle_help', () => {
  if (isHelpOverlayActive()) { toggleHelpOverlay(currentKeymap); return; }
  void fetchOverridesForDisplay().then((ov) => toggleHelpOverlay(currentKeymap, ov));
});

// Fetch the user's phrase overrides via the SW → plugin. Best effort — an empty
// map (disconnected / no overrides) just shows catalog defaults.
async function fetchOverridesForDisplay(): Promise<Map<string, string>> {
  const r = (await chrome.runtime
    .sendMessage({ type: 'GET_COMMAND_OVERRIDES' })
    .catch(() => undefined)) as { overrides?: OverrideRecord[] } | undefined;
  return overridesFromList(r?.overrides ?? []);
}

// Command palette (notes/DESIGN_TAB_NAVIGATION.md, Layer 2). The overlay
// iframe always lives in the top frame; a bind fired inside a subframe relays
// up through the background (PALETTE_OPEN → PALETTE_COMMAND at frame 0).
// `toggle_tab_palette` is the same overlay scoped to open tabs (Ctrl+T /
// voice "tab").
function openPaletteFromCommand(command: 'toggle_palette' | 'toggle_tab_palette'): void {
  if (window !== window.top) {
    chrome.runtime.sendMessage({ type: 'PALETTE_OPEN', command } as Message).catch(() => {});
    return;
  }
  togglePalette(command === 'toggle_tab_palette' ? 'tabs' : 'all');
}
dispatcher.register('toggle_palette', () => openPaletteFromCommand('toggle_palette'));
dispatcher.register('toggle_tab_palette', () => openPaletteFromCommand('toggle_tab_palette'));

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

// Page zoom — like the tab verbs, forwarded to the background SW (chrome.tabs
// zoom APIs are unavailable in content scripts). Keyboard path only; voice is
// intercepted off the SSE stream in the background.
const ZOOM_COMMANDS: ReadonlyArray<readonly [string, ZoomAction]> = [
  ['zoom_in', 'in'], ['zoom_out', 'out'], ['zoom_reset', 'reset'],
];
for (const [command, action] of ZOOM_COMMANDS) {
  dispatcher.register(command, () => {
    chrome.runtime.sendMessage({ type: 'ZOOM_ACTION', action } as Message).catch(() => {});
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
// Pass-through: hand the keyboard to the page (its own shortcuts work) until
// Escape. See notes/DESIGN_PASS_THROUGH.md.
dispatcher.register('insert_mode', () => {
  keyHandler.enterInsertMode();
});
dispatcher.register('pass_next_key', () => {
  keyHandler.armPassNextKey();
});

// Marks (Vimium m / `). `m`/`` ` `` arm a one-shot; KeyHandler captures the next
// key and calls back here with (op, letter, global). See
// notes/DESIGN_MARKS_AND_CARET.md. Storage lives in the background (never the
// page's localStorage); local jumps restore in place, globals go cross-tab.
dispatcher.register('mark_set', () => keyHandler.armMarkSet());
dispatcher.register('mark_jump', () => keyHandler.armMarkJump());

// Previous-position registers (`` ` `` and `'`): in-memory, per page, holding the
// spot before the last jump so `` `` `` returns you.
const prevPositionRegisters: Record<string, StoredMark> = {};

function currentPosition(): StoredMark {
  return { scrollX: window.scrollX, scrollY: window.scrollY, hash: location.hash };
}
function savePreviousPosition(): void {
  const pos = currentPosition();
  for (const reg of PREV_POSITION_REGISTERS) prevPositionRegisters[reg] = pos;
}
function restorePosition(mark: StoredMark): void {
  if (marksToHash(mark)) location.hash = mark.hash;
  else window.scrollTo(mark.scrollX, mark.scrollY);
}

keyHandler.setMarkCallback((op, letter, global) => {
  if (op === 'set') {
    const pos = currentPosition();
    chrome.runtime
      .sendMessage({
        type: 'MARK_SET',
        scope: global ? 'global' : 'local',
        letter,
        url: location.href,
        scrollX: pos.scrollX,
        scrollY: pos.scrollY,
        hash: pos.hash,
      } as Message)
      .catch(() => {});
    flashToast(`${global ? 'Global' : 'Local'} mark ${letter} set`);
    return;
  }

  // Jump. Previous-position registers restore from in-memory state.
  if (!global && isPrevPositionRegister(letter)) {
    const prev = prevPositionRegisters[letter];
    if (!prev) { flashToast('No previous position'); return; }
    savePreviousPosition(); // so `` toggles back and forth
    restorePosition(prev);
    return;
  }

  if (global) {
    void chrome.runtime
      .sendMessage({ type: 'MARK_JUMP', scope: 'global', letter, url: location.href } as Message)
      .then((resp: { ok?: boolean } | undefined) => {
        flashToast(resp?.ok ? `Jumped to global mark ${letter}` : `Global mark ${letter} not set`);
      })
      .catch(() => {});
    return;
  }

  void chrome.runtime
    .sendMessage({ type: 'MARK_JUMP', scope: 'local', letter, url: location.href } as Message)
    .then((resp: { mark?: StoredMark | null } | undefined) => {
      const mark = resp?.mark;
      if (!mark) { flashToast(`Local mark ${letter} not set`); return; }
      savePreviousPosition();
      restorePosition(mark);
      flashToast(`Jumped to local mark ${letter}`);
    })
    .catch(() => {});
});

// Caret / visual mode (Vimium v / V). The controller owns the Selection-API
// movement + yank; it reports its mode so the KeyHandler capture state and the
// mode chip stay in lockstep. See notes/DESIGN_MARKS_AND_CARET.md (Part 2).
// Tracks the caret-active state last pushed to the background, so caret↔visual
// transitions (both non-null) don't re-POST; only the active/inactive edge does.
let caretActivePushed = false;
const caret = new CaretController({
  onModeChange: (mode) => {
    if (mode) keyHandler.enterCaretMode(mode);
    else keyHandler.exitCaretMode();
    // Reflect caret-active to the plugin (via background) so the exclusive caret
    // tag gates the voice selection commands. Top frame only — the tag is a
    // single per-browser mode, and the mode chip is top-frame too.
    const active = mode !== null;
    if (isTopFrame && active !== caretActivePushed) {
      caretActivePushed = active;
      chrome.runtime.sendMessage({ type: 'CARET_ACTIVE', active } as Message).catch(() => {});
    }
  },
});
keyHandler.setCaretKeyHandler((e) => caret.handleKey(e));
// `v` extends an existing selection (visual) or drops to caret — Vimium parity.
dispatcher.register('caret_mode', () => caret.enterFromNormal());
dispatcher.register('visual_line_mode', () => caret.enter('visual-line'));
// Pagination — follow the page's next/prev link (Vimium goNext/goPrevious).
dispatcher.register('go_next', () => navigatePage('next'));
dispatcher.register('go_previous', () => navigatePage('prev'));
function navigatePage(rel: Rel): void {
  const href = findPageLink(document, rel);
  if (href) location.href = href;
  else flashToast(rel === 'next' ? 'No next page' : 'No previous page');
}
// Copy the current page URL (Vimium yy).
dispatcher.register('copy_url', () => {
  void copyText(location.href).then((ok) => flashToast(ok ? 'Copied URL' : 'Copy failed'));
});
// URL hierarchy — up one level / to the site root (Vimium gu/gU).
dispatcher.register('go_up', () => {
  const up = urlUp(location.href);
  if (up && up !== location.href) location.href = up;
  else flashToast('Already at the top');
});
dispatcher.register('go_root', () => {
  const root = urlRoot(location.href);
  if (root && root !== location.href) location.href = root;
  else flashToast('Already at the root');
});
// Yank a link via hint (Vimium yf): enter hint mode; the resolved codeword
// copies the link's URL instead of following it. Keyboard-only.
dispatcher.register('yank_hint', () => {
  pendingHintAction = 'yank';
  keyHandler.enterHintMode();
});
// Focus a badge's element without activating it (Vimium focus hint). Then type
// via Insert. Distinct from focus_input (first field) — this picks any element.
dispatcher.register('focus_hint', () => {
  pendingHintAction = 'focus';
  keyHandler.enterHintMode();
});
// Copy a badge's visible text (vs yank_hint's URL).
dispatcher.register('copytext_hint', () => {
  pendingHintAction = 'copytext';
  keyHandler.enterHintMode();
});
// Hover a badge's element (reveal menus/controls) — keyboard twin of the voice
// "hover {hint}" (still plugin-contributed; see DESIGN_HINT_ACTION_MODES.md 3b).
dispatcher.register('hover_hint', () => {
  pendingHintAction = 'hover';
  keyHandler.enterHintMode();
});
// Start a caret/visual selection at a badge's element (Vimium hint→caret) —
// then drive it by keyboard or voice ("select word" / "copy that").
dispatcher.register('caret_hint', () => {
  pendingHintAction = 'caret';
  keyHandler.enterHintMode();
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


// --- Keyboard Filter Callback ---

// Show the mode chip when the keyboard enters hint mode (letters now filter
// hints) and hide it back in Normal. See notes/DESIGN_KEYBOARD_MODES.md.
keyHandler.setModeChangeCallback((mode) => setModeChip(mode));

// Per-site keyboard policy — full exclusion (all keys to the page) and/or
// granular passthrough (specific keys to the page, the rest of BranchKit's
// binds still work). Applied on load and kept live as the popup edits it.
// Voice is unaffected. See notes/DESIGN_PASS_THROUGH.md.
function applySiteKeys(): void {
  void getSiteKeyState(location.href).then(({ excluded, passKeys }) => {
    keyHandler.setExcluded(excluded);
    keyHandler.setPassKeys(passKeys);
  });
}
applySiteKeys();
onSiteKeysChanged(applySiteKeys);

// Escape out of hint mode: in ALWAYS-visible mode the badges stay painted
// (they're for voice — Escape just leaves keyboard typing mode); in MANUAL
// mode Escape dismisses the summoned hints, the Vimium behavior. The mode
// exit itself already happened in the KeyHandler.
keyHandler.setHintEscapeCallback(() => {
  pendingHintAction = 'activate'; // an abandoned verb (yf/hover/… then Esc) must not leak to the next hint
  if (getHintVisibility() !== 'always') hideBadges();
});

// Reject a codeword keystroke that no painted badge starts with, so a stray
// key doesn't filter every hint off the screen. Only consults codeword
// prefixes (not the `/` text filter, which accepts anything).
keyHandler.setMatchPredicate((prefix) => store.matchingLetterPrefix(prefix).length > 0);

keyHandler.setFilterCallback((prefix: string) => {
  if (!pageSession.badgesVisible) return;

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
    // tab. `activateWrapper` reads `pendingHintAction` and resets it. Don't
    // override an explicit verb (e.g. yf then a capital keeps yank precedence,
    // matching the old yankHintArmed-checked-first behavior).
    if (keyHandler.isNewTabArmed() && pendingHintAction === 'activate') pendingHintAction = 'newtab';
    activateWrapper(first);
    hideBadges();
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
 *
 * "Voice isn't in play" is two distinct states: no alphabet ever loaded
 * (fresh install, never connected) AND host currently disconnected. The
 * alphabet persists in chrome.storage.local across BranchKit sessions and is
 * never cleared, so without the connection-mirror term a machine that had
 * connected ONCE painted bk-pending translucent forever while the host was
 * closed — "not ready YET" for a voice that wasn't coming.
 */
function isPaintReady(w: ElementWrapper): boolean {
  return w.grammarReady || !isVoiceAlphabetLoaded() || !isBranchKitConnected();
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
    lifecycleCounters.invisibleCandidatesObserved++;
    pageSession.attentionObserver.observe(el);
    // Round 34c: the reveal RO rides along from the moment of parking.
    // The attention IO can't see 0×0 candidates (grid cells born empty,
    // filled by late data), so without this their reveal is only caught
    // at settle-sweep cadence — the 0.5-3s badge trickle on data grids.
    observeRevealCandidate(el);
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
// `source` labels wrappers this scan attaches (wave.discovery_sources):
// 'scan' for the boot/storage/activation walks, 'rescan' when the nav-rescan
// tail drives it. A trigger folded into an already-pending run keeps the
// pending run's label — diagnostic, not load-bearing.
function doScan(source: DiscoverySource = 'scan'): Promise<void> {
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
      await doScanBatched(source);
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

async function showBadges(): Promise<void> {
  // Wait one frame so any pending IntersectionObserver entries (queued
  // synchronously by observe(), delivered async) have a chance to fire,
  // then drain pending claims/releases. Without this, a `f` keypress
  // immediately after page load can race the tracker — wrappers exist
  // but their codewords haven't been claimed yet and badges would
  // render with no labels.
  await new Promise(r => requestAnimationFrame(() => r(null)));
  await pageSession.tracker.flushNow();

  const allTargets = [...store.all];

  // pageSession.badgesVisible is the mode flag — "user wants hints showing." Set it
  // even when the store has nothing to paint right now so subsequent
  // wrappers arriving via the batched scan (or MutationObserver
  // discovery) paint via badgeNewlyCodeworded, which is pageSession.badgesVisible-
  // gated. Under the old whole-grammar path the store was always
  // populated by the time showBadges fired, so an empty return here
  // never mattered; under batched mode the scan is async and showBadges
  // can race ahead of the first batch landing.
  if (allTargets.length === 0) {
    pageSession.badgesVisible = true;
    return;
  }

  // Filter to viewport-visible and sort by position (same as grammar push)
  const targets = viewportSort(allTargets);
  if (targets.length === 0) {
    pageSession.badgesVisible = true;
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
  firehoseStep('showBadges:start', renderable.length, 20);
  cacheLayout(renderable.map(w => w.element));
  // Ancestor warm (rect + style + dims) for the same construction walks the
  // build pass warms for (see badgeNewlyCodeworded) — showBadges constructs
  // the strict-viewport slice and pays them per badge otherwise.
  cacheConstruction(renderable.map(w => w.element));
  firehoseStep('showBadges:cache_end', renderable.length, 20);
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
      if (cssVisible) {
        wrapper.hint.show(isPaintReady(wrapper));
        wrapper.tFirstShown ??= performance.now();
      } else {
        wrapper.hint.hide();
      }
    }
    firehoseStep('showBadges:mount_end', renderable.length, 20);

    // Ensure visibilityMO is running so class/style-driven visibility
    // transitions (YouTube controls fading out, etc.) request the settle
    // pass (schedulePassSoon — the demoted backstop). Idempotent — no-op if
    // already connected, just refreshes the abandon timer.
    if (renderable.length > 0) connectVisibilityMO();

    const __pbStart = performance.now();
    try { placeBadges(renderable); } finally {
      recordCpu('placeBadges:show', performance.now() - __pbStart);
      firehoseStep('showBadges:place_end', renderable.length, 20);
    }
  } finally {
    clearLayoutCache();
  }
  pageSession.badgesVisible = true;
  // showBadges painted only the strict-viewport `renderable` slice. Converge
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
  pendingHintAction = 'activate';
  keyHandler.exitHintMode();
  for (const w of store.all) {
    w.hint?.setFiltered(false);
  }
}

function hideBadges(): void {
  clearHintFilter();
  pageSession.badgesVisible = false;
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
    if (!shouldAutoShowBadges()) return;
    doScan();
    showBadges();
  }, HINT_REFRESH_DELAY_MS);
}

// Single-flight yield-chained continuation for band construction the budget
// deferred. Re-enters the BUILD step ONLY (badgeNewlyCodeworded, never
// reconcile() — so never claims): claims are byte-for-byte unchanged by band
// painting, which is what keeps the 73cf6e7 → b813e29 codeword-churn loop
// from re-arming (notes/DESIGN_PAINT_THE_BAND.md risk 2).
//
// Scheduling: the rIC(100ms-timeout) shape this replaces starved mid-fling —
// rIC never fired during a fling, so the backlog drained one
// timeout-clamped pass per 100ms round (the claimed→shown p90 401ms tail,
// notes/DESIGN_FLING_WAVE.md). scheduleYieldTask resumes ~1-4ms after the
// prior slice, same shape as drainDiscovery's chain. Termination: re-armed
// only when a pass reports deferred > 0, and every pass builds at least one
// first-time item (budget checked before each, elapsed starts at 0), so the
// backlog strictly shrinks — self-terminating, wedge-safe. The isTornDown
// guard is load-bearing: the yield path is not cancellable by teardown.
const scheduleBandBuildContinuation = createSingleFlight(
  scheduleYieldTask,
  () => {
    if (pageSession.isTornDown || !pageSession.badgesVisible) return;
    badgeNewlyCodeworded();
  },
);

// The build step of the reconciler. Called only by reconcile() and the idle
// continuation above — no longer an independent edge-triggered backstop.
// Builds badges for every wrapper that wants a hint (in-band, codeworded,
// category-matched) but lacks one. Shown-ness is IO-band scoped
// (notes/DESIGN_PAINT_THE_BAND.md): off-viewport band wrappers paint too and
// ride the scroll into view already painted, Rango-style.
//
// Two-phase like showBadges: construct/show everything first (DOM writes),
// THEN one batched placeBadges (probe reads before transform writes). The
// first cut placed per badge inside the build loop (append host → Range
// gBCR → append host …), forcing a reflow PER BADGE — which inflated
// per-badge cost far past the note's 5-10ms estimate and made the 4ms
// budget defer nearly everything (the "badges trickle in one at a time"
// symptom). Batched, the whole pass pays ~one reflow.
//
// `budgetMs` is the off-viewport construction budget for THIS pass — the
// burst-scale build constant (lifecycle/build-queue.ts) for every caller,
// reconcile-path and continuation alike: a realistic wave completes in one
// pass, paying the ancestor warm and the placement reflow once.
function badgeNewlyCodeworded(budgetMs: number = WAVE_BUILD_BUDGET_MS): void {
  const newBadges: ElementWrapper[] = [];
  for (const w of store.all) {
    // Delta against desired state: wants a hint but isn't currently
    // visible. With hint reuse (DESIGN_HINT_REUSE.md), a wrapper's
    // `w.hint` persists across viewport exit/re-enter cycles, so the old
    // `!w.hint` filter would skip every dormant hint forever. The new
    // filter catches both first-time hints (w.hint absent) and reused
    // dormant hints (w.hint present but hidden + cleared).
    if (wantsHint(w) && !w.hint?.isVisible) {
      newBadges.push(w);
    }
  }
  if (newBadges.length === 0) return;

  const __start = performance.now();
  try {
    const elements = newBadges.map(w => w.element);
    cacheLayout(elements);
    // Warm the full ancestor chain too — rect + style + dims, deduped across
    // wrappers: first-time construction walks ancestors for container
    // resolution (rects + dims), the viewport-pinned check, and APCA
    // background resolution (styles), and sibling rows share almost their
    // whole chain. Cold, those walks cost ~1.3-1.5ms/badge on deep
    // production DOM (each badge's host append dirties layout, so the next
    // badge's first cold read forces a reflow) — the build-queue saturation
    // in the 2026-07-03 QuickBase fling profiles.
    cacheConstruction(elements);
    const vw = window.innerWidth, vh = window.innerHeight;
    const built: ElementWrapper[] = [];
    const deferred = runBuildPass(newBadges, {
      isOnScreen: (w) => isRectOnScreen(getCachedRect(w.element), vw, vh),
      // First-time construction (shadow DOM, anchorParent walk, APCA
      // colors) is the budgeted class; the dormant-reuse fast path
      // (setLabel + show) is cheap and exempt.
      isFirstTime: (w) => !w.hint,
      build: (w) => {
        if (prepareBadge(w)) built.push(w);
      },
      budgetMs,
    });
    // Batched placement for everything this pass constructed/re-showed:
    // one read phase (text probes) over all badges, then the writes.
    if (built.length > 0) placeBadges(built);
    if (deferred > 0) {
      firehoseStep('band_build:deferred', deferred, 1);
      scheduleBandBuildContinuation();
    }
  } finally {
    clearLayoutCache();
    recordCpu('bandBuild:pass', performance.now() - __start);
  }
}

// Construct/show one wrapper from the pass's delta set: label restore, the
// CSS-visibility gate, first-time construction or dormant reuse, show.
// Placement is NOT done here — the caller batch-places the returned set
// (true = needs placement). Requires a warm layout cache.
function prepareBadge(w: ElementWrapper): boolean {
  const label = poolLabelToAssignment(w.scanned.codeword);
  w.label = label;
  // A CSS-invisible target (visibility:hidden / opacity:0 hover-reveal) must
  // not paint — same reason as showBadges: no visibility transition fires for
  // a never-revealed target, so the recheck never cleans it up. `cssHidden`
  // keeps the voice (strict-viewport) gate in lockstep.
  const cssVisible = isVisible(w.element);
  w.cssHidden = !cssVisible;
  // Restore the label on an existing dormant (scroll-back) hint even when the
  // target is CSS-hidden. A dormant hint was clearLabel()d on band exit;
  // skipping the label here (the 116b321 regression) leaves it null — and
  // recheckBadgeVisibility shows it as an empty box when the target is later
  // revealed. The label is just data on a hidden badge.
  if (w.hint) {
    w.hint.setLabel(label);
  }
  if (!cssVisible) {
    w.tBuildGated ??= performance.now();
    return false;
  }
  // Slow path (first-time): construct the badge. The reuse fast path above
  // skips shadow DOM creation, observer wire-up, anchorParent walk, z-index
  // walk, and APCA color recomputation.
  if (!w.hint) {
    w.hint = new HintBadge(w.element, label, w.category, getDisplayMode());
  }
  // Direct paint (round 13 — the Rango-parity cut): the badge appears the
  // moment it is built, translucent (bk-pending) until the grammar ACK
  // solidifies it ~80ms later. The wave-atomic reveal hold this replaces
  // (stage at opacity 0, flip together at quiesce/deadline) was solving a
  // trickle that stops existing once each wave builds in one task — the
  // task IS the pop, and the hold was pure added latency. tFirstShown
  // stamps here and is eye-honest: the paint is immediately visible.
  w.hint.show(isPaintReady(w));
  w.tFirstShown ??= performance.now();
  return true;
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
//     the set showBadges' strict-viewport slice leaves behind (the noHintObject
//     root): they sit in the IO band but outside the strict viewport, so
//     showBadges never built them and nothing rebuilt until a scroll.
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
  if (pageSession.badgesVisible) {
    badgeNewlyCodeworded();
    reattachStrippedHosts();
  }
}

// (reconcileStorm — the round-4 yield-hop variant — is gone, round 13. It
// existed because inline build per WALK SLICE starved discovery when the
// walk was budget-sliced at 32ms; with the walk completing all pending
// roots per pass, the inline build in reconcile() runs once per completed
// wave and starves nothing. The claim flush lands in the drain task's
// microtask tail, reconcile() builds and paints synchronously — one task
// per wave, the Rango shape the twelve-round arc kept converging toward.)

// Coalesced entry for high-frequency edge signals (focus/transition/resize
// settle): a 100ms debounce collapses a churny burst into one reconcile so we
// act on real {claim, build} deltas only — the steady state is a cheap O(store)
// no-op walk; grammar churn happens solely when a genuinely new in-band wrapper
// needs a codeword. Sites needing synchronous flush→showBadges ordering (nav,
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
    w.tInBand ??= performance.now();
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
// recheckBadgeVisibility + the strict re-push it triggered). Non-extending
// single-flight timer, deliberately NOT the scheduleDeferredReposition
// debounce: a debounce pushes back under sustained churn, and the demotion
// contract is "must not get slower than the loops it replaced" — this fires
// within the same 100ms cadence the old throttle guaranteed. The pass is
// budget-priced for that cadence (gather+plan ≈ 4-6ms, Phase B/D evidence).
let passSoonTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePassSoon(reason?: string): void {
  noteSettleTrigger(`passSoon:${reason ?? 'unknown'}`);
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
// The rIC path forwards the IdleDeadline so budget-aware callers (the band-
// build continuation) can drain up to the real idle window instead of a
// fixed slice; the fallback path passes none.
function runWhenIdle(cb: (deadline?: IdleDeadline) => void, timeoutMs: number): void {
  const w = window as { requestIdleCallback?: (cb: (d: IdleDeadline) => void, opts?: { timeout: number }) => void };
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
// added nodes, we DO NOT retry: reconcile()/showBadges() can ripple into more
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
// Mass-reveal fast-arm threshold (DESIGN_FLING_WAVE round 18): a settle whose
// plan repaired this many stale-FALSE band flags IS the double-buffered
// reveal (QuickBase measures 106-166 at the flip; incidental repairs run
// 1-17). Such a sweep skips the idle gate — mid-storm rIC never fires, so
// the gate is a flat +500ms on exactly the wave the user is watching for.
const REVEAL_REPAIR_FAST_ARM = 25;
function scheduleBandDiscovery(settleKind: 'band' | 'store', revealRepairs = 0): void {
  const fastReveal = revealRepairs >= REVEAL_REPAIR_FAST_ARM;
  // Dirty gate (notes/DESIGN_BAND_SWEEP_DIRTY_GATE.md): no observed adds since
  // the last walk started + last sweep recent → the re-walk can find nothing
  // the incremental paths haven't. Evaluated BEFORE the single-flight check so
  // a skipped request never sets rerun flags; retries re-enter here with the
  // then-current epoch (a mid-walk add reads dirty — exactly the race the
  // retry exists for). Fast-arm bypasses inside the gate.
  if (!shouldRunBandSweep({
    domAddEpoch: getDomAddEpoch(),
    sweptEpoch: pageSession.discoverySweptEpoch,
    sweepEndAt: pageSession.discoverySweepEndAt,
    now: performance.now(),
    fastReveal,
  })) {
    recordCpu('bandDiscovery:skipClean', 0);
    firehoseStep('band_discovery:skip_clean', 1);
    return;
  }
  if (pageSession.discoverySweepPending) {
    pageSession.discoverySweepRerun = true;
    // A mass reveal landing mid-sweep must not be demoted to the noise-retry
    // path — record the urgency; the in-flight sweep's finally re-arms
    // immediately regardless of its added count (round 18b).
    if (fastReveal) {
      pageSession.discoverySweepFastRerun = true;
    }
    firehoseStep('band_discovery:coalesced', 1);
    return;
  }
  pageSession.discoverySweepPending = true;
  pageSession.discoverySweepRerun = false;
  pageSession.discoverySweepFastRerun = false;
  // Discovery-source tag by the settle kind that STARTED this sweep (a
  // coalesced request of the other kind folds in — labels are diagnostic):
  // scroll settles → band_sweep, non-scroll (store) settles → settle_sweep.
  const source: DiscoverySource = settleKind === 'band' ? 'band_sweep' : 'settle_sweep';
  const sweepBody = () => {
    void (async () => {
      let added = 0;
      // Captured at walk start: adds landing during the walk push the live
      // epoch past this, so the next settle's gate reads dirty.
      const epochAtStart = getDomAddEpoch();
      try {
        if (pageSession.isTornDown || !document.body) return;
        // Attribution stamp (round 20c): fast_arm→sweep_start is the entry
        // delay (scheduler/idle queueing); sweep_start→added is walk + the
        // claim-flush builds in this task's microtask tail. Splits the
        // repair→added lump the 20b drill couldn't attribute.
        firehoseStep('band_discovery:sweep_start', 0, 0);
        // Every sweep walks in one slab (round 20b) — a per-batch-yielding
        // sweep holds the single-flight lock for seconds mid-storm and the
        // reveal's fast request queues behind it.
        added = await discoverInSubtreeBatched(
          document.body, source, SWEEP_SLAB_BUDGET_MS,
        );
        // Diagnostic: the sweep's added count INCLUDING zero, to correlate a
        // miss against whether the walk actually attached anything.
        firehoseStep('band_discovery:added', added, 0);
        // A reveal-armed sweep must follow through even with ZERO adds
        // (round 33c, client probe + log): on QuickBase's new-style grid the
        // reveal cohort is ALREADY-ATTACHED wrappers whose stale-false band
        // flags a reconcile pass just repaired — the walk skips them all
        // (known-wrapper skip), added===0, and the early return here
        // stranded their claim flush + paint for seconds until some sweep
        // attached a genuinely new element (log tell: added=1 followed by
        // showBadges 166 — one element unlocking a ~165-badge backlog).
        if (added === 0 && !fastReveal) return;
        // New wrappers landed (or a mass reveal armed this sweep): claim
        // codewords for the in-band ones and build their badges
        // (reconcile), flush the claims, then paint.
        reconcile();
        await pageSession.tracker.flushNow();
        if (pageSession.badgesVisible) await showBadges();
      } finally {
        pageSession.discoverySweptEpoch = epochAtStart;
        pageSession.discoverySweepEndAt = performance.now();
        pageSession.discoverySweepPending = false;
        // Mass-reveal rerun (round 18b): a >=25-repair settle landed while
        // this sweep was in flight, and its fast-arm was swallowed by the
        // single-flight coalesce. Re-arm immediately on the fast path —
        // added>0 here is EXPECTED (this walk caught part of the wave), so
        // the added===0 gate below deliberately does not apply. This is not
        // the 73cf6e7 churn loop: that retried on a raceless heuristic per
        // scroll settle; this consumes an explicit reveal signal, and it
        // only recurs if ANOTHER mass reveal lands during the next
        // (isKnown-skipping, ~100-400ms) walk — sustained real content.
        const fastRerun = pageSession.discoverySweepFastRerun;
        pageSession.discoverySweepFastRerun = false;
        if (fastRerun && !pageSession.isTornDown) {
          pageSession.discoveryRetryDepth = 0;
          firehoseStep('band_discovery:fast_rerun', added);
          scheduleBandDiscovery(settleKind, REVEAL_REPAIR_FAST_ARM);
        } else {
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
            pageSession.resources.timeout(() => scheduleBandDiscovery(settleKind), DISCOVERY_RETRY_COOLDOWN_MS);
          } else {
            pageSession.discoveryRetryDepth = 0;
          }
        }
      }
    })();
  };
  if (fastReveal) {
    // The settle plan just proved a mass reveal — content gained geometry
    // en masse. Waiting for idle here IS the residual late wave; the walk
    // runs in one slab (round 20) so front-of-queue entry is safe.
    // Retries (armed above) deliberately keep the idle path — they are
    // race backstops, not reveal-urgent.
    firehoseStep('band_discovery:fast_arm', revealRepairs);
    scheduleYieldTask(sweepBody);
  } else {
    runWhenIdle(sweepBody, DISCOVERY_SWEEP_IDLE_TIMEOUT_MS);
  }
}

function updateBadgeLabels(): void {
  for (const w of store.all) {
    if (w.hint && w.label) {
      w.hint.updateLabel(w.label, getDisplayMode());
    }
  }
}

// Visibility handoff after a keyboard hint action. In always-mode we clear
// narrowing/keyboard state and schedule a refresh; in manual-mode we fully hide
// so the user can re-summon explicitly. Shared by every activateWrapper verb.
function hintActionHandoff(): void {
  if (shouldAutoShowBadges()) {
    clearHintFilter();
    scheduleHintRefresh();
  } else {
    hideBadges();
  }
}

function activateWrapper(wrapper: ElementWrapper): void {
  const el = wrapper.element as HTMLElement;
  // Consume the keyboard hint action and reset immediately, so no path can leak
  // it to the next activation. See notes/DESIGN_HINT_ACTION_MODES.md.
  const action = pendingHintAction;
  pendingHintAction = 'activate';

  // Verbs that act ON the element without following it (Vimium hint modes).
  if (action === 'yank') {
    // Copy the link's URL (Vimium yf).
    const href = (el.closest('a') as HTMLAnchorElement | null)?.href ?? '';
    wrapper.hint?.flash();
    if (href) void copyText(href).then((ok) => flashToast(ok ? 'Copied link' : 'Copy failed'));
    else flashToast('Not a link');
    hintActionHandoff();
    return;
  }
  if (action === 'copytext') {
    // Copy the element's visible text (Vimium copy-link-text).
    const text = (el.textContent || '').trim();
    wrapper.hint?.flash();
    if (text) void copyText(text).then((ok) => flashToast(ok ? 'Copied text' : 'Copy failed'));
    else flashToast('No text');
    hintActionHandoff();
    return;
  }
  if (action === 'focus') {
    // Focus without activating — a field to type in, or any element (Vimium focus).
    wrapper.hint?.flash();
    el.focus();
    flashToast('Focused');
    hintActionHandoff();
    return;
  }
  if (action === 'hover') {
    // Reveal hover-state UI (menus, player controls) without clicking (Vimium
    // hover). The always-mode handoff re-scans, so badges appear for whatever
    // the hover just exposed. Voice "hover {hint}" is the twin (plugin-side).
    wrapper.hint?.flash();
    dispatchHover(el);
    flashToast('Hovered');
    hintActionHandoff();
    return;
  }
  if (action === 'caret') {
    // Start a caret/visual selection AT this element (Vimium hint→caret). Then
    // drive it by keyboard (hjkl/y) or voice ("select word" / "copy that").
    wrapper.hint?.flash();
    hintActionHandoff();
    caret.enterAt(el);
    return;
  }

  lastActivatedElement = el;
  hintActionHandoff();

  wrapper.hint?.flash();
  if (wrapper.category === 'input') {
    el.focus();
  } else {
    activateElement(el, { newTab: action === 'newtab' });
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
async function doScanBatched(source: DiscoverySource): Promise<void> {
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

  // Round 31: batches PIPELINE. Each processScanBatch attaches + paints
  // synchronously before its POST, so the walk (and therefore paint)
  // proceeds at content speed while the grammar round-trips fly
  // concurrently — the old shape awaited each batch's POST before
  // walking the next, which on a report load serialized paint behind
  // ~25 sequential plugin round-trips (the Rango gap, DESIGN_FLING_WAVE
  // round 31). Claims stay ordered: everything up to each batch's POST
  // runs in call order on the main thread. Rejections are swallowed at
  // push time (parity with doScan's catch) so an unhandled rejection
  // can't fire while the collection awaits later batches.
  const inFlight: Promise<void>[] = [];

  // Synthetic first "batch" for inclusion-rule elements, if any. Goes
  // through the same processing path so its codewords get Put and the
  // succeeded ones paint. is_final stays false because the scanner
  // walk will follow with at least its own terminal batch.
  if (inclusionRefs.length > 0) {
    inFlight.push(processScanBatch(
      { refs: inclusionRefs, elements: inclusionElements, isLast: false, invisibleCandidates: [] },
      getSessionId(), batchIndex, sessionMeta, adapter, source,
    ).catch(() => {}));
    batchIndex++;
  }

  for (const batch of scanInBatches(
    adapter ? document : document, DEFAULT_SCAN_BATCH_SIZE, initialSeen,
  )) {
    if (batch.isLast) {
      // The terminal batch carries is_final, which closes the plugin's
      // scan window — it must be ADMITTED after every middle batch, so
      // hold its POST until the in-flight ones settle (same ordering
      // discipline as syncNow's pipelined chunks, round 29c).
      await Promise.allSettled(inFlight);
      await processScanBatch(batch, getSessionId(), batchIndex, sessionMeta, adapter, source);
    } else {
      inFlight.push(
        processScanBatch(batch, getSessionId(), batchIndex, sessionMeta, adapter, source)
          .catch(() => {}),
      );
    }
    batchIndex++;
    // Yield to the event loop between batches so MutationObserver
    // can fire and any DOM removal mid-scan flags the wrapper's
    // element as disconnected before the next batch (item 5
    // mitigation; the sweep itself runs in processScanBatch).
    // scheduler.yield, not setTimeout(0) — the timer hop costs
    // 50-150ms per batch under load (storm-hop class, instance #5).
    await yieldTask();
  }
  // Belt-and-braces: if the generator yielded no isLast batch (empty
  // document), middle POSTs may still be in flight — settle them before
  // the deletes flush below reads hasPendingDeletes.
  await Promise.allSettled(inFlight);

  // If the batch sweeps queued deletes, flush them now via an empty
  // deletes-only batch — otherwise they'd strand until the next
  // user-driven scan. Deletes no longer hitchhike on the pipelined
  // middle batches (postBatch takes them explicitly and settles the
  // sentCodewords shadow itself), so this ordered flush is the scan
  // path's one delete carrier. Reuses the same session_id so
  // plugin-side session tracking stays consistent.
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
    }, drainPendingDeletes());
  }
  recordCpu('doScanBatched', performance.now() - __cpuStart);
}

async function processScanBatch(
  batch: { refs: Element[]; elements: ScannedElement[]; isLast: boolean; invisibleCandidates: Element[] },
  sessionId: string, batchIndex: number,
  sessionMeta: { conn_id: string; hint_visibility: HintVisibility; app_id: string; table_id: string },
  adapter: ReturnType<typeof getActiveAdapter>,
  source: DiscoverySource,
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

  // Build candidate wrappers with codewords assigned. These attach and
  // paint BEFORE the grammar POST (round 31): the badge appears at walk
  // speed in the translucent bk-pending state and the ACK solidifies it —
  // exactly the tracker/IO path's contract. The old shape held
  // attachWrapper until after the POST "so no badge paints before the
  // plugin acknowledges", but with sequential per-batch round-trips that
  // serialized ALL paint behind ~25 plugin POSTs on a report load:
  // seconds of bare grid rows while Rango painted during its walk. The
  // badge-implies-functional contract is carried by bk-pending, not by
  // withholding paint.
  const candidates: ElementWrapper[] = [];
  for (let i = 0; i < newRefs.length; i++) {
    const label = i < labels.length ? labels[i] : '';
    if (!label) continue;  // pool exhausted; element stays unaddressable
    newElements[i].codeword = label;
    claimCounters.scanPathClaimed++;
    const cw = new ElementWrapper(newRefs[i], newElements[i]);
    cw.tClaimed = performance.now(); // scan-path claim: born codeworded
    candidates.push(cw);
  }

  // Even an empty batch sends an is_final marker so the plugin
  // knows the scan ended (matters for the C7 cleanup window).
  if (candidates.length === 0 && !batch.isLast) {
    return;
  }

  const adapterName = adapter?.name ?? '';
  void adapterName; // reserved for plugin-side adapter-aware routing

  // Sync slab 2: attach loop + paint, now PRE-POST. Everything here is
  // synchronous; if any of it takes >50ms it's a real main-thread block.
  const __syncBStart = performance.now();

  stampStrictViewport(candidates);
  for (const w of candidates) {
    attachWrapper(w, source);
  }

  // Record the scan-path claims in the codeword memory (SW + live index). The
  // tracker path does this via its onCodewordsChanged callback; the scan path
  // claims labels upfront (claimLabels), so without this its codewords would
  // never seed a future reclaim — the SPA-rebuild churn the QuickBase sidebar
  // hit. See rememberClaimedCodewords / codeword-recall.
  if (candidates.length > 0) rememberClaimedCodewords(candidates);

  // Paint immediately, translucent (grammarReady is still false, so the
  // badge carries bk-pending). Gated by pageSession.badgesVisible so
  // manual-mode batches don't paint until "show".
  if (pageSession.badgesVisible && candidates.length > 0) {
    reconcile();
  }

  // Surface terminal-batch invisibleCandidates to the
  // ResizeObserver path (same as the old doScan's end-of-pass).
  if (batch.isLast && batch.invisibleCandidates.length > 0) {
    observeInvisibleCandidates(batch.invisibleCandidates);
  }
  recordCpu('processScanBatch:syncB', performance.now() - __syncBStart);

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

  // Transport failure (result 'error' is synthetic — the SW's
  // transportFailure or a failed sendMessage; the plugin only ever answers
  // ok/stored/calibration_active): the plugin never saw the batch, so this
  // is not a rejection and the rollback below must not run. Detaching here
  // is what made hints FLASH whenever BranchKit was closed with a persisted
  // voice alphabet: paint → failed POST → detach → the reconcile/MO
  // machinery rediscovers the bare elements → repaint → fail again. Keep
  // the wrappers attached and painted (bk-pending carries the voice-not-
  // live signal; typing works regardless — the extension-independence
  // contract) and queue their Puts. Convergence when voice returns needs no
  // retry timer: the sse_connect reactivate and the liveness onResync both
  // rotate + re-queue every live codeworded wrapper.
  if (resp.result === 'error') {
    for (const w of candidates) {
      if (w.scanned.codeword === '' || store.findWrapperFor(w.element) !== w) continue;
      if (!w.element.isConnected) {
        // Disconnected during the round-trip; never sent, so a plain
        // detach (no plugin-side Delete) is correct.
        detachWrapper(w.element);
        continue;
      }
      queuePut(w);
    }
    return;
  }

  // Response partitioning — solidify or roll back. The wrapper may have
  // been detached (MO removal, dedup by a later scan) or its element
  // disconnected during the round-trip, so revalidate store ownership
  // per wrapper (round 30's lesson) before acting on the ACK.
  const succeededSet = new Set(resp.succeeded);
  for (const w of candidates) {
    const cw = w.scanned.codeword;
    const stillMine = cw !== '' && store.findWrapperFor(w.element) === w;
    if (cw !== '' && succeededSet.has(cw)) {
      if (stillMine && w.element.isConnected) {
        // Delta-sync: the plugin acknowledged this codeword, so it's live
        // on the plugin side. Mark it so future detaches know to send a
        // Delete and future syncs skip re-Putting it — THEN flip the badge
        // solid. markGrammarReady clears bk-pending on the visible badge
        // in one shot, mirroring the IO/syncNow ACK site.
        markSent(cw);
        w.markGrammarReady();
      } else if (stillMine) {
        // Element disconnected during the round-trip. Plugin holds the
        // codeword; markSent first so detachWrapper's delta-sync queues
        // the Delete through the normal plumbing.
        markSent(cw);
        detachWrapper(w.element);
      } else {
        // Already detached mid-flight (before markSent, so no Delete was
        // queued then). The plugin holds the codeword — queue the Delete
        // manually, UNLESS the released label was already reclaimed by a
        // live wrapper, in which case the plugin entry now (or soon)
        // belongs to that wrapper and deleting it would orphan a painted
        // badge.
        if (!store.all.some((lw) => lw.scanned.codeword === cw)) {
          queueDelete(cw);
        }
      }
    } else if (stillMine) {
      // Failed or unacknowledged: never live on the plugin side, and
      // never marked sent, so detachWrapper unpaints and releases the
      // label without queueing a Delete.
      detachWrapper(w.element);
    }
  }
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
  showBadges,
  schedulePassSoon,
  discoverInSubtree,
  onMassDiscovery: (added) => scheduleMassRevealPaint(added),
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
  if (!harnessHooksEnabled()) return; // gauge mirror is a harness affordance
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
  // The discovery drain is a yield task now (not cancellable) — clear the
  // queue and reset the flag; drainDiscovery's isTornDown guard makes the
  // already-scheduled continuation inert.
  pageSession.discoveryScheduled = false;
  pageSession.pendingDiscoveryRoots.clear();
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
  // console.log, not warn: chrome://extensions' error collector records warns
  // from unpacked extensions, and one farewell per frame per reload buries
  // genuine exceptions under breadcrumbs (2026-07-02 incident triage). The
  // orphan-hits gauge carries the soak signal; this line is human context only.
  console.log(`[BranchKit] content script torn down (reason: ${reason}). Self-quiesced.`);
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

// Mid-scroll spa_nav deferral (notes/DESIGN_FLING_WAVE.md round 10):
// QuickBase writes a pagination offset (?skip=N) into the grid URL during
// scrolling; webNavigation reports every tick as a history-state update, and
// the drill firehose showed FIVE overlapping full rescans (document-wide
// doScan + syncNow + wholesale showBadges) landing mid-swap-storm — pure
// self-inflicted load at the worst moment. A user cannot click-navigate
// mid-fling: a URL change while scroll events are arriving is in-page
// state, so the rescan defers to scroll settle and coalesces (latest args
// win — the rescan body reads live DOM/URL anyway). Real navigations are
// never mid-scroll and keep today's immediate path; YouTube's query-only
// watch→watch navs (the case the heavy rescan exists for) are unaffected.
let navRescanDeferred: { fromCache: boolean; reason: string } | null = null;

/** Fire a scroll-deferred spa_nav rescan, if one was parked. Called by the
 * scroll-settle timeout right after runSettlePipeline. */
function flushDeferredNavRescan(): void {
  if (!navRescanDeferred) return;
  const d = navRescanDeferred;
  navRescanDeferred = null;
  rescanForNav(d.fromCache, d.reason);
}

// The same-document-nav rescan body, owned by `PageSession.onUrlChange`. The
// background `webNavigation` SPA-nav signal arrives as the `rescan` action and
// is dispatched here; this is the content-side handler, not the detector.
function rescanForNav(fromCache: boolean, reason: string): void {
  const t0 = performance.now();
  if (reason === 'spa_nav' && pageSession.scrollRepositionTimer !== null) {
    navRescanDeferred = { fromCache, reason };
    chrome.runtime.sendMessage({ type: 'DEBUG_LOG', tag: 'pipeline.cs_nav_step', data: { step: 'deferred_mid_scroll', reason, at_ms: 0 } } as Message).catch(() => {});
    return;
  }
  chrome.runtime.sendMessage({ type: 'DEBUG_LOG', tag: 'pipeline.cs_rescan_received', data: { url: window.location.href, from_cache: fromCache, reason } } as Message).catch(() => {});

  // A same-document nav is a new page: in manual mode (or always-mode with an
  // active F-hide) it should start hidden. The SPA nav keeps this content
  // script alive, so F-shown hints from the previous URL would otherwise
  // linger. Refocus (the other from_cache caller) is NOT a new page — only
  // reset on spa_nav.
  if (reason === 'spa_nav' && !shouldAutoShowBadges() && pageSession.badgesVisible) {
    hideBadges();
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
        // Wholesale-swap audit (notes/DESIGN_FLING_WAVE.md round 11): the
        // deferred tail below exists to reestablish a page whose DOM swapped
        // out from under the incremental machinery. Whether that happened is
        // directly measurable at this moment — the disconnected fraction of
        // the store. A real route change (YouTube watch→watch) arrives here
        // with the old wrappers massively disconnected → heavy path,
        // unchanged. A scroll-driven URL tick (QuickBase ?skip=N fires at
        // ITS settle, after our incremental path already rebuilt the store)
        // arrives ~fully connected → the document walk would discover
        // nothing and the wholesale showBadges would re-churn a converged
        // badge population, seconds after every fling (round-11 firehose:
        // 913ms-3.2s deferred scans chasing each drill). Light path: one
        // reconcile + a settle pass. O(store) pointer reads to decide.
        let disconnected = 0;
        for (const w of store.all) {
          if (!w.element.isConnected) disconnected++;
        }
        const total = store.all.length;
        const wholesale = total === 0 || disconnected / total > 0.25;
        if (!wholesale) {
          void navStep('deferred_scan:light');
          reconcile();
          schedulePassSoon('nav-light');
          return;
        }
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
        // 2026-06-12; prime-at-attach has since moved bulk claims inline at
        // attach, which is what makes the light path above safe). doScan
        // skips known elements and consults the limbo pool, so the
        // retirement's stability win is untouched; the settle pass (toClaim)
        // remains the standing backstop for what the scan misses. Routed
        // through doScan() so it can't race a concurrent storage-onChanged
        // scan with the same session_id (duplicate codeword assignments —
        // actuator.log 2026-06-05T17:30:11).
        void doScan('rescan').then(async () => {
          reconcile();
          await pageSession.tracker.flushNow();
          if (pageSession.badgesVisible) showBadges();
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
    doScan('rescan');
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
  'toggle_palette', // voice "palette" — same handler as the Ctrl+K bind
  'toggle_tab_palette', // voice "tab" — opens the tabs-only palette (Ctrl+T twin)
  'toggle_help', // voice "help" — same handler as the ? bind
  'go_next', 'go_previous', // voice "next/previous page"
  'copy_url', // voice "copy url"
  'go_up', 'go_root', // voice "go up" / "site root"
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

  if (message.type === 'GET_PAGE_STATUS') {
    // Only the top frame answers so the popup receives a single response. The
    // count is this frame's hint candidates; subframe hints aren't aggregated.
    if (!isTopFrame) return false;
    const badgesVisible =
      pageSession.badgesVisible || store.all.some((w) => w.hint?.isVisible);
    sendResponse({ hintCount: store.all.length, badgesVisible });
    return false;
  }

  if (message.type === 'SET_BADGES_VISIBLE') {
    // Popup Show/Hide button — the UI twin of Shift+F. Sent to every frame
    // (no frameId) so "this page" means the whole page, not just the top
    // frame; each frame drives its own badges. Only the top frame answers, so
    // the popup gets one response to refresh its readout from.
    const nowShowing = setBadgesVisible(message.visible);
    if (isTopFrame) sendResponse({ badgesVisible: nowShowing, hintCount: store.all.length });
    return false;
  }

  if (message.type === 'TAB_MARKER') {
    if (isTopFrame) setTabMarker(message.letters);
    return false;
  }

  if (message.type === 'MARK_RESTORE') {
    // A global-mark jump landed on (or opened) this tab — restore the saved
    // position. Top frame only; sub-frame scroll is out of scope for MVP.
    if (isTopFrame) restorePosition({ scrollX: message.scrollX, scrollY: message.scrollY, hash: message.hash });
    return false;
  }

  if (message.type === 'TAB_MARKER_REAPPLY') {
    if (isTopFrame) reapplyTabMarker();
    return false;
  }

  if (message.type === 'PALETTE_CLOSE') {
    closePalette();
    sendResponse(true); // background awaits the close before dispatching
    return false;
  }

  if (message.type === 'PALETTE_COMMAND') {
    dispatcher.dispatch(message.action, message.params ?? {});
    return false;
  }

  if (message.type === 'OPEN_HELP') {
    // Popup Help button — top frame owns the overlay. Same path as ? / "help".
    if (isTopFrame) dispatcher.dispatch('toggle_help', {});
    return false;
  }

  if (message.type === 'BRANCHKIT_ACTION') {
    const { action, params, correlation_id: correlationId } = message.payload;
    if (action === 'toggle_hints') {
      // Voice "toggle" — the same handler as Shift+F. Snapshot on the show
      // direction so a codeword spoken in the same phrase resolves against the
      // freshly-painted badges.
      if (toggleHints()) phraseSnapshot = takeSnapshot(store.all, performance.now());
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
    } else if (action === 'activate' || action === 'activate_hint_newtab' || action === 'activate_hint_background') {
      // Tab-targeted variants ("blank <hint>" / "stash <hint>", see
      // notes/DESIGN_MULTI_TARGET_COMMANDS.md phase 1): same resolution as
      // plain activate, different landing. 'new' opens the href in a focused
      // tab (voice twin of the typed capital); 'background' opens it without
      // moving focus so hints stay painted for the next command. Non-anchor
      // targets fall back to plain activation for both.
      const tabTarget =
        action === 'activate_hint_newtab' ? 'new' :
        action === 'activate_hint_background' ? 'background' : 'none';
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
        //    state, then schedule a doScan + showBadges after a short delay
        //    so post-activate DOM changes (modal open, form expansion,
        //    autocomplete dropdown) get reflected in the next badge set.
        //  - Manual-mode: full hide. Activate is the "I'm done" gesture;
        //    user re-summons via "show" or the f keybind.
        //  - Background ("stash"): NOT an "I'm done" gesture — focus stays
        //    here and the plugin keeps the hints tag set, so badges must stay
        //    painted in both modes for the gather to continue. Just clear the
        //    prefix narrowing/keyboard state.
        if (tabTarget === 'background') {
          clearHintFilter();
          if (shouldAutoShowBadges()) scheduleHintRefresh();
        } else if (shouldAutoShowBadges()) {
          clearHintFilter();
          scheduleHintRefresh();
        } else {
          hideBadges();
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
          //
          // Tab-targeted variants with a real http(s) href never click into
          // this page (the tab opens elsewhere; this DOM is untouched), so
          // they skip the teardown — a stash-gather shouldn't churn observers
          // once per breath. Anything else — plain activate, or a tab verb on
          // a non-anchor / non-http target — takes the normal click path.
          const nav = tabTarget !== 'none' ? resolveNavTarget(target) : null;
          const tabHref =
            nav && (nav.protocol === 'http:' || nav.protocol === 'https:') && nav.href
              ? nav.href : null;
          if (tabTarget === 'background' && nav && tabHref) {
            // Content scripts can't reach chrome.tabs — the SW opens it.
            void chrome.runtime.sendMessage({ type: 'OPEN_TAB_BACKGROUND', url: tabHref });
            clickedEl = nav;
            delegation = nav !== target ? 'anchor' : 'none';
            taken = 'click';
          } else if (tabTarget === 'new' && tabHref) {
            // activateElement's newTab branch is guaranteed here (href
            // present): window.open, no in-page click.
            const result = activateElement(target, { newTab: true });
            clickedEl = result.target;
            delegation = result.delegation;
            taken = 'click';
          } else {
            preNavObserverTeardown('activate_click');
            const result = activateElement(target);
            clickedEl = result.target;
            delegation = result.delegation;
            taken = 'click';
          }
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
    } else if (action === 'hover_hint' || action === 'focus_hint' || action === 'copytext_hint' || action === 'caret_hint') {
      // Element-verb voice actions (Vimium hint modes): resolve the codeword to
      // a wrapper and act ON it without following it —
      //   hover        → pointer-in event sequence (pointerover/enter/move +
      //                  mouse equivalents), revealing hover-state UI (player
      //                  controls, dropdown menus) without grabbing the mouse
      //                  (mirrors Rango's hoverElement).
      //   focus_hint   → focus the element (a field to type in, or any element).
      //   copytext_hint→ copy the element's visible text.
      //   caret_hint   → start a caret/visual selection at the element.
      // All share the same three-tier resolution as activate so codewords stay
      // consistent across verbs. None tear down wrappers or hide hints
      // (always-mode keeps badges so the user can follow up on what appeared).
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
        let detail = '';
        if (action === 'hover_hint') {
          dispatchHover(target);
          detail = 'hover dispatched';
        } else if (action === 'focus_hint') {
          target.focus();
          detail = 'focused';
        } else if (action === 'caret_hint') {
          caret.enterAt(target);
          detail = 'caret at element';
        } else {
          const text = (target.textContent || '').trim();
          if (text) void copyText(text).then((ok) => flashToast(ok ? 'Copied text' : 'Copy failed'));
          else flashToast('No text');
          detail = text ? 'text copied' : 'no text';
        }
        reportDispatchResult({
          action, codeword, resolution: resolved.resolution, elem_tag: target.tagName.toLowerCase(),
          taken: 'click', ok: true,
          frame: trimFrameUrl(window.location.href),
          detail,
          fp: resolved.fp,
        });
      } else {
        reportDispatchResult({
          action, codeword, resolution: resolved.resolution, elem_tag: '',
          taken: 'skipped', ok: false,
          frame: trimFrameUrl(window.location.href),
          detail: resolved.detail || `${action} target not resolved`,
          fp: resolved.fp,
        });
      }
    } else if (action === 'caret_voice') {
      // Voice-driven caret/visual selection ("select word", "copy that", …).
      // No-op unless caret mode is active — the CaretController guards it. See
      // notes/DESIGN_HINT_ACTION_MODES.md (voice caret control).
      const op = (params?.op || 'word') as CaretVoiceOp;
      caret.applyVoice(op);
      reportDispatchResult({
        action, codeword: '', resolution: 'none', elem_tag: '',
        taken: caret.isActive() ? 'click' : 'skipped', ok: caret.isActive(),
        frame: trimFrameUrl(window.location.href),
        detail: caret.isActive() ? `caret ${op}` : 'caret mode not active',
        fp: '',
      });
    } else if (action === 'noop') {
      // The SW translates the inbound spoken prefix word to its letter before
      // forwarding (see frame-router), so `prefix` is already a letter here.
      const letter = params?.prefix;
      if (letter) {
        if (!pageSession.badgesVisible) showBadges();
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
  }
});

// --- Reposition ---
// The JS reconcile positioner owns badge placement: one batched pass reads
// every registered badge's live target rect and writes composited transforms.
// scheduleReposition drives that pass on a rAF single-flight so the settle
// handlers' shared 100ms debounce funnels into one coalescing policy —
// wedge-safe by construction.
//
// There is deliberately NO off-screen hide sweep here (retired by
// notes/DESIGN_PAINT_THE_BAND.md seam 3): shown-ness is band-scoped, so a
// sweep would fight the plan's applyVisibilityPlan re-show every settle — a
// flap. The one artifact the sweep existed for (a parked target's badge box
// overhanging the viewport edge) is solved geometrically by the write-time
// clamp inside reconcileRead (hints.ts).
let repositionRafPending = false;
function scheduleReposition(): void {
  if (!pageSession.badgesVisible) return;
  if (repositionRafPending) return;
  repositionRafPending = true;
  requestAnimationFrame(() => {
    repositionRafPending = false;
    // Reposition breadcrumbs: a `reposition:start` without matching
    // `reposition:end` pins this as the wedge body. Threshold-gated so
    // steady-state scroll doesn't add 60 sendMessages/sec just for telemetry.
    firehoseStep('reposition:start', reconcileRegistrySize(), 20);
    // One batched pass: reads all target rects, writes all transforms.
    // reconcileRead() short-circuits hidden badges and disconnected targets
    // before any gBCR (limbo wrappers — badge held for the ~250ms rebind
    // window — never reach placement; see
    // notes/INVESTIGATION_LIMBO_BADGE_FLASH.md).
    const rects = reconcilePass();
    firehoseStep('reposition:end', rects.size, 20);
    // Harness-only (settle-storm diagnosis): transforms that actually changed
    // value this pass. Emits only when nonzero (threshold 1) — a sustained
    // nonzero on an idle page names an oscillating badge position.
    if (harnessHooksEnabled()) {
      firehoseStep('reposition:changed', lastReconcileChangedWrites(), 1);
    }
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
//   5. recheckBadgeVisibility — re-evaluate CSS visibility BEFORE the strict
//      pass so a hover-reveal target that went visibility:hidden gets its
//      badge hidden AND `cssHidden` set, keeping voice in lockstep with the
//      visual hide. Also re-hides any badge a mid-scroll reposition re-showed
//      on a hidden target.
//   6. reconcileStrictViewport — re-push wrappers whose strict-viewport flag
//      changed so the plugin's `_strict` companion collection (voice matching
//      + Discovery HUD) converges to post-settle viewport reality.
//   7. scheduleReposition — drive the batched positioner pass (which also
//      applies the off-screen write-time clamp inside reconcileRead).
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
// Steps 1-6 are gated on badgesVisible: the activate command requires the
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

// --- Paint-stability sampler: the eye-level truth ---
// A 10Hz change-log of visible-state counts, armed by scroll activity and
// self-terminating 5s after the last scroll event (wedge discipline: a
// bounded timer chain, not a rAF). Dumped raw into the debug snapshot
// (paint_stability) alongside the per-wrapper stage stamps.
//
// Exists because the stage stamps CANNOT see what the user sees: tFirstShown
// credits a badge's first paint, but QuickBase's row churn re-hides and
// re-shows badges (repair waves of 80-105 mid-fling), so a badge the stamps
// score at 50ms may visibly stabilize seconds later. This ring records the
// actual on-screen badge count over time — plateau time and flicker dips
// included — which is the number that corresponds to perceived paint speed
// (the stage-percentiles-improve-but-it-feels-the-same disconnect,
// 2026-07-03). Cost per tick: O(store) property reads + one live
// HTMLCollection length; nothing runs while the page is scroll-idle.
const PAINT_SAMPLE_INTERVAL_MS = 100;
const PAINT_SAMPLE_TRAIL_MS = 5000;
const PAINT_SAMPLE_RING_MAX = 900;
// Tuple layout (round 34d appended the four photon columns):
// [t, rows, wrappers, painted, shown, shownStrict, poolFree,
//  eyeVpSolid, eyeVpTransl, eyeSolid, eyeTransl]
// The first seven read wrapper FLAGS (intent); the eye columns read each
// badge's computed style + geometry (HintBadge.eyeState) — what the user's
// retina gets. Flag/eye divergence in one sample IS the historically
// recurring "logs say fast, eye says slow" gap, now measured per drill.
const paintSamples: Array<[
  number, number, number, number, number, number, number,
  number, number, number, number,
]> = [];
let paintSamplerRunning = false;
let paintSamplerLastScroll = 0;
let paintSamplerLastKey = '';

function notePaintSamplerScroll(): void {
  paintSamplerLastScroll = performance.now();
  if (paintSamplerRunning) return;
  paintSamplerRunning = true;
  paintSamplerTick();
}

function paintSamplerTick(): void {
  const now = performance.now();
  if (pageSession.isTornDown || now - paintSamplerLastScroll > PAINT_SAMPLE_TRAIL_MS) {
    paintSamplerRunning = false;
    return;
  }
  let painted = 0, shown = 0, shownStrict = 0;
  // Photon columns (round 34d): computed-style + geometry truth per badge.
  // All reads, batched in one pass — at most one forced layout per tick,
  // bounded to the scroll-armed sampling window. The flag columns above
  // record intent; these record what renders. Their divergence is the
  // recurring "logs say fast, eye says slow" gap, now a number per drill.
  let eyeVpSolid = 0, eyeVpTransl = 0, eyeSolid = 0, eyeTransl = 0;
  for (const w of store.all) {
    if (w.hint) {
      painted++;
      if (w.hint.isVisible) {
        shown++;
        // Viewport slice (round 22): the band-scoped `shown` hid a
        // viewport-only wipe (~40 of ~400 badges) entirely. Flag read,
        // no layout — the strict machinery maintains it.
        if (w.scanned.in_strict_viewport) shownStrict++;
      }
      const eye = w.hint.eyeState();
      if (eye) {
        if (eye.solid) { eyeSolid++; if (eye.inViewport) eyeVpSolid++; }
        else { eyeTransl++; if (eye.inViewport) eyeVpTransl++; }
      }
    }
  }
  // 'tr' count as the content-arrival proxy (live collection; .length is
  // cheap). Page-shape-specific but harmless where rows aren't tables.
  const rows = document.getElementsByTagName('tr').length;
  // Pool depth per sample (round 22): mid-storm reservoir exhaustion is a
  // repop-delay suspect (doomed-but-connected wrappers hold letters while
  // the replacement window claims); the at-rest snapshot can't see it.
  const poolFree = labelReservoir.stats().free;
  const key = `${rows}|${store.all.length}|${painted}|${shown}|${shownStrict}|${poolFree}|${eyeVpSolid}|${eyeVpTransl}|${eyeSolid}|${eyeTransl}`;
  if (key !== paintSamplerLastKey) {
    paintSamplerLastKey = key;
    paintSamples.push([
      Math.round(now), rows, store.all.length, painted, shown, shownStrict, poolFree,
      eyeVpSolid, eyeVpTransl, eyeSolid, eyeTransl,
    ]);
    if (paintSamples.length > PAINT_SAMPLE_RING_MAX) {
      paintSamples.splice(0, paintSamples.length - PAINT_SAMPLE_RING_MAX);
    }
  }
  pageSession.resources.timeout(paintSamplerTick, PAINT_SAMPLE_INTERVAL_MS);
}

// Paint-latency decomposition for the debug snapshot: stage-delta
// percentiles over wrappers first shown in the trailing window. Answers
// "where does the time go between a row appearing and its badge painting"
// (notes/DESIGN_PAINT_THE_BAND.md) — attached→band is discovery+IO,
// band→claimed is the claim debounce/flush, claimed→shown is the build
// queue. Pure reads over already-stamped fields; no layout.
const PAINT_LATENCY_WINDOW_MS = 90_000;

// Percentile helpers shared by paintLatencyStats and discoverySourceStats.
const latencyPct = (arr: number[], p: number) => {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
};
const latencySummary = (arr: number[]) =>
  ({ n: arr.length, p50: latencyPct(arr, 50), p90: latencyPct(arr, 90), max: latencyPct(arr, 100) });

// Per-discovery-source decomposition (DESIGN_FLING_WAVE round 15): kills the
// survivorship bias where only MO-path wrappers carried dom_seen stamps and
// the sweep-found 41% dropped out of every percentile. Per source over the
// trailing window: how many wrappers attached/shown, how many carried a REAL
// MO stamp (mo_stamped), and the stage latencies. Reading it for the miss
// diagnosis: a big band/settle_sweep cohort with mo_stamped high means the MO
// saw those subtrees but the walk didn't yield the elements (hydrated-later /
// pre-filter suspects); mo_stamped low means the MO never got a usable record
// for any ancestor (text-only records, observer-level gap). For non-MO
// sources dom_seen_to_attached (MO-stamped wrappers only) IS the miss window.
function discoverySourceStats() {
  const now = performance.now();
  type SourceAcc = {
    attached: number; shown: number; moStamped: number; inViewportAtAttach: number;
    seenToAttached: number[]; seenToShown: number[]; attachedToShown: number[];
  };
  const bySource: Record<string, SourceAcc> = {};
  for (const w of store.all) {
    if (now - w.tAttached > PAINT_LATENCY_WINDOW_MS) continue;
    const s = (bySource[w.discoverySource] ??= {
      attached: 0, shown: 0, moStamped: 0, inViewportAtAttach: 0,
      seenToAttached: [], seenToShown: [], attachedToShown: [],
    });
    s.attached++;
    if (w.inViewportAtAttach) s.inViewportAtAttach++;
    if (w.domSeenByMo && w.tDomSeen !== null) {
      s.moStamped++;
      s.seenToAttached.push(w.tAttached - w.tDomSeen);
    }
    if (w.tFirstShown !== null) {
      s.shown++;
      if (w.tDomSeen !== null) s.seenToShown.push(w.tFirstShown - w.tDomSeen);
      s.attachedToShown.push(w.tFirstShown - w.tAttached);
    }
  }
  return Object.fromEntries(Object.entries(bySource).map(([source, s]) => [source, {
    attached_in_window: s.attached,
    shown_in_window: s.shown,
    mo_stamped: s.moStamped,
    // Round 21: sweep cohort with this HIGH + big dom_seen→attached = held
    // ineligible in view (chase it); LOW = scroll-ahead accounting (benign).
    in_viewport_at_attach: s.inViewportAtAttach,
    dom_seen_to_attached: latencySummary(s.seenToAttached),
    dom_seen_to_shown: latencySummary(s.seenToShown),
    attached_to_shown: latencySummary(s.attachedToShown),
  }]));
}

function paintLatencyStats() {
  const now = performance.now();
  const deltas: Record<string, number[]> = {
    dom_seen_to_attached: [], attached_to_band: [], band_to_claimed: [],
    claimed_to_shown: [], attached_to_shown: [], dom_seen_to_shown: [],
    shown_minus_ack: [], gated_to_shown: [],
  };
  let count = 0;
  for (const w of store.all) {
    if (w.tFirstShown === null || now - w.tFirstShown > PAINT_LATENCY_WINDOW_MS) continue;
    count++;
    if (w.tDomSeen !== null) {
      deltas.dom_seen_to_attached.push(w.tAttached - w.tDomSeen);
      deltas.dom_seen_to_shown.push(w.tFirstShown - w.tDomSeen);
    }
    // Sequencing: negative = shown before voice ACK (designed order,
    // visible translucent window); positive = show lagged the voice
    // round-trip (zero translucency — the inversion).
    if (w.tGrammarReady !== null) deltas.shown_minus_ack.push(w.tFirstShown - w.tGrammarReady);
    // Built-but-gated on an invisible target: how long the reveal path took.
    if (w.tBuildGated !== null) deltas.gated_to_shown.push(w.tFirstShown - w.tBuildGated);
    if (w.tInBand !== null) deltas.attached_to_band.push(w.tInBand - w.tAttached);
    if (w.tInBand !== null && w.tClaimed !== null) deltas.band_to_claimed.push(w.tClaimed - w.tInBand);
    if (w.tClaimed !== null) deltas.claimed_to_shown.push(w.tFirstShown - w.tClaimed);
    deltas.attached_to_shown.push(w.tFirstShown - w.tAttached);
  }
  return {
    window_ms: PAINT_LATENCY_WINDOW_MS,
    shown_in_window: count,
    dom_seen_to_attached: latencySummary(deltas.dom_seen_to_attached),
    attached_to_band: latencySummary(deltas.attached_to_band),
    band_to_claimed: latencySummary(deltas.band_to_claimed),
    claimed_to_shown: latencySummary(deltas.claimed_to_shown),
    attached_to_shown: latencySummary(deltas.attached_to_shown),
    dom_seen_to_shown: latencySummary(deltas.dom_seen_to_shown),
    shown_minus_ack: latencySummary(deltas.shown_minus_ack),
    gated_to_shown: latencySummary(deltas.gated_to_shown),
  };
}

/** Diagnostic surfaces owned by this module, merged into every debug
 * snapshot (both the Ctrl+Alt+A path and the test-capture event) BEFORE the
 * send — see captureDebugSnapshot's extras param. */
function snapshotExtras() {
  return {
    // Fling-wave pipeline health (notes/DESIGN_FLING_WAVE.md): cohort sizes
    // for the two geometry fast paths and the reservoir state they depend
    // on. reservoir.free pinned at ~0 during a fling = claims starving
    // (the round-2 signature); band_sweep_releases should fund it.
    wave: {
      primed_claims: lifecycleCounters.primedClaims,
      band_sweep_repairs: lifecycleCounters.bandSweepRepairs,
      band_sweep_releases: lifecycleCounters.bandSweepReleases,
      reservoir: labelReservoir.stats(),
      // Why slot rebinds do/don't fire + whether slot ancestors survive at
      // limbo entry (DESIGN_FLING_WAVE round 7 probe).
      slot_probe: { ...slotProbe },
      limbo_slot_liveness: { ...limboSlotLiveness },
      // Round 15+: who discovers wrappers, with per-source latency, over the
      // paint-latency window. The MO should own steady-state discovery; a
      // large sweep/scan share on a churny page is the miss being measured.
      discovery_sources: discoverySourceStats(),
      // Round 21 boot classifier: dom-seen stamps only exist for insertions
      // after this moment. Unstamped wrappers attached near it are
      // pre-observer boot content, NOT a mid-fling no-trace cohort.
      observer_attached_at: (() => {
        const t = getObserverFirstAttachedAt();
        return t === null ? null : Math.round(t);
      })(),
      // Lifetime attach counts per source (not window-scoped) + the
      // suspect-(c) tripwire: add records the Element gate skipped wholesale.
      attached_by_source: { ...lifecycleCounters.attachedBySource },
      mo_text_only_add_records: lifecycleCounters.moTextOnlyAddRecords,
      // Walk-reached-but-invisible registrations (attention handoff). ≈0
      // while sweeps attach hundreds → the walk never saw the missed
      // content; large → promotion-path latency is the thing to chase.
      invisible_candidates_observed: lifecycleCounters.invisibleCandidatesObserved,
      // Layer-3 reveal sensor (round 21): nonzero-box RO deliveries on parked
      // candidates. Climbing while attached_by_source.visibility stays flat =
      // the promote recheck rejects what the sensor reports.
      visibility_ro_signals: lifecycleCounters.visibilityRoSignals,
    },
    paint_latency: paintLatencyStats(),
    // Raw eye-level ring: [t_ms, tr_rows, wrappers, painted, shown,
    // shown_strict_viewport, pool_free] change entries from the
    // scroll-armed sampler above. shown_strict_viewport is the
    // viewport-sliced count (round 22 — a viewport wipe barely dents the
    // band-scoped `shown`); pool_free is the label reservoir depth per
    // sample (mid-storm exhaustion suspect).
    paint_stability: {
      interval_ms: PAINT_SAMPLE_INTERVAL_MS,
      columns: ['t', 'rows', 'wrappers', 'painted', 'shown', 'shown_strict', 'pool_free',
        'eye_vp_solid', 'eye_vp_transl', 'eye_solid', 'eye_transl'],
      samples: [...paintSamples],
    },
    // Round 22: history of shown-then-detached wrappers (the churn the
    // percentiles can't see — dead wrappers leave store.all). A fling with
    // a healthy pipeline shows recent[] ≈ empty; a pop→wipe→rebuild cycle
    // shows a burst of short shown_for_ms, in_viewport, had_codeword
    // records at the swap.
    churn: churnStats(PAINT_LATENCY_WINDOW_MS),
    // Round 22b: every grammar postBatch outcome (result, size, session,
    // elapsed) — a stalled post-swap sync (289 badges translucent ~25s,
    // snapshot 15-55) names its mechanism here: transport errors, slow
    // round-trips, wholesale refusals, or session-rotation races
    // (old-session batches failing after a rotate).
    sync_trace: syncTraceStats(PAINT_LATENCY_WINDOW_MS),
    grammar_epoch: grammarEpochStats(),
    reconcile_applied: {
      passes: reconcileApplied.passes,
      last: { ...reconcileApplied.last },
      total: { ...reconcileApplied.total },
    },
    // Visibility state — to diagnose a stuck toggle (badges painted but the
    // flag says hidden, so Shift+F routes to "show" instead of "hide"). If
    // painted_badges > 0 while hints_visible is false, that's the desync.
    visibility: {
      hints_visible: pageSession.badgesVisible,
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

// Single-flight for the mass-reveal direct paint. Multiple settles in one
// reveal burst coalesce into one claim-flush + paint on the yield chain.
let massRevealPaintQueued = false;
function scheduleMassRevealPaint(repairs: number): void {
  if (massRevealPaintQueued) return;
  massRevealPaintQueued = true;
  scheduleYieldTask(() => {
    massRevealPaintQueued = false;
    if (pageSession.isTornDown) return;
    void (async () => {
      firehoseStep('mass_reveal:direct_paint', repairs, 0);
      reconcile();
      await pageSession.tracker.flushNow();
      if (pageSession.badgesVisible) await showBadges();
    })();
  });
}

// Harness-only settle-trigger attribution (settle-storm diagnosis): every
// scheduler that can arm the pipeline notes WHY, the notes accumulate across
// the debounce window (a Set — coalesced duplicates collapse), and the settle
// entry ships them as one firehose step. Names the re-arm edge of a settle
// loop directly instead of inferring it from step ordering.
const settleTriggerReasons = new Set<string>();
function noteSettleTrigger(reason: string): void {
  if (harnessHooksEnabled()) settleTriggerReasons.add(reason);
}

function runSettlePipeline(discovery: 'band' | 'store'): void {
  if (harnessHooksEnabled()) {
    const src = settleTriggerReasons.size > 0
      ? [...settleTriggerReasons].sort().join('+')
      : 'unattributed';
    settleTriggerReasons.clear();
    firehoseStep(`settle:enter:${discovery}:${src}`, 1);
  }
  // One store pass per signal window (notes/DESIGN_SETTLE_TRIGGER_SCOPING.md):
  // the deferred-reposition debounce and the passSoon single-flight are two
  // independent 100ms timers that both request THIS unified pass — letting
  // the sibling fire would re-run an identical pass over unchanged state
  // ~100ms later (the idle-storm doubler: two full settles per page tick).
  // The firing timer nulled itself before calling here, so this cancels only
  // the sibling; a signal landing after this synchronous pass re-arms fresh.
  if (discovery === 'store') {
    if (passSoonTimer !== null) {
      clearTimeout(passSoonTimer);
      passSoonTimer = null;
    }
    if (pageSession.deferredRepositionTimer) {
      clearTimeout(pageSession.deferredRepositionTimer);
      pageSession.deferredRepositionTimer = null;
    }
  }
  if (pageSession.badgesVisible) {
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
    const planLists = computeReconcilePlanLists(store, gather);
    // APPLY: thin appliers in the load-bearing step order — enforced here
    // by structure, not comment discipline.
    applyLifecyclePlan(planLists);
    // Every settle kind arms the band discovery sweep (round 14). The old
    // 'band'-only rule assumed non-scroll settles reveal new hintables only
    // among EXISTING wrappers — false on double-buffered grids: QuickBase
    // renders the incoming window hidden and flips it visible via a class
    // change our attributeFilter deliberately ignores, so ~50 elements per
    // swap (the dom_seen_to_attached p90 2.5-6s straggler cohort, round-14
    // drill) were discovered only by the NEXT scroll's settle. The mutation
    // burst around the flip lands a 'store' settle within ~100ms; arming the
    // sweep here closes the straggler window to ≤~600ms. The sweep is
    // single-flight, idle-scheduled, and isKnown-skipping — cheap when
    // nothing new exists. The repair count is the mass-reveal tell: a
    // double-buffered flip repairs ~100+ stale band flags in one plan,
    // and that sweep skips the idle gate (round 18 fast-arm).
    scheduleBandDiscovery(discovery, planLists.toRepair.length);
    // Mass-reveal DIRECT paint (round 33d): a ≥fast-arm repair batch is a
    // double-buffered flip revealing already-attached wrappers. The sweep's
    // follow-through (round 33c) covers them, but its entry queues behind
    // the single-flight walk — ~0.7s mid-storm on the client grid, the
    // residual half of the rows→badges gap after 33c (video: +3.1s → +1.5s
    // vs Rango's +0.4s). The repaired cohort needs NO walk — only claim
    // flush + paint — so run that follow-through directly on the yield
    // chain. Idempotent with the sweep's own pass; bounded to mass
    // reveals.
    if (planLists.toRepair.length >= REVEAL_REPAIR_FAST_ARM) {
      scheduleMassRevealPaint(planLists.toRepair.length);
    }
    if (discovery === 'store') scheduleReconcile();
    applyOcclusionPlan(gather);
    reconcileScrollAccel();
    applyVisibilityPlan(planLists);
    applyStrictPlan(planLists.strictDelta);
    recordApplied(planLists);
    // Harness-only strict-flip attribution (settle-storm diagnosis): which
    // plan input moved for the delta cohort since the last pass, plus the
    // stamp-vs-plan disagreements accrued from the batch POSTs in between.
    // 'stable' flips (no input moved) + stamp_disagree name the baseline
    // writer (stampStrictViewport / the sync drain) as the loop's other leg.
    if (harnessHooksEnabled()) {
      for (const [k, v] of Object.entries(planLists.strictFlips)) {
        if (v > 0) firehoseStep(`strictflip:${k}`, v);
      }
      const sd = drainStampDisagree();
      if (sd.total > 0) {
        firehoseStep('stamp_disagree:total', sd.total);
        if (sd.geometry > 0) firehoseStep('stamp_disagree:geometry', sd.geometry);
        if (sd.occluded > 0) firehoseStep('stamp_disagree:occluded', sd.occluded);
        if (sd.cssHidden > 0) firehoseStep('stamp_disagree:cssHidden', sd.cssHidden);
        if (sd.ancestor > 0) firehoseStep('stamp_disagree:ancestor', sd.ancestor);
      }
    }
  }
  scheduleReposition();
}

// Mid-fling band sweep throttle (notes/DESIGN_FLING_WAVE.md Part 1c +
// drill round 2). 10Hz while scroll events arrive; a timestamp, not a
// timer — nothing to tear down, nothing free-running (wedge discipline).
// Gated on badgesVisible: with hints down the IO's own cadence is fine
// (nothing user-facing waits), and the next show re-converges from scratch.
const MID_SCROLL_BAND_SWEEP_MS = 100;
let bandSweepLastAt = 0;
function noteBandSweep(): void {
  if (!pageSession.badgesVisible) return;
  const now = performance.now();
  if (now - bandSweepLastAt < MID_SCROLL_BAND_SWEEP_MS) return;
  bandSweepLastAt = now;
  const { repaired, released } = pageSession.tracker.sweepBand(window.innerWidth, window.innerHeight);
  if (repaired > 0 || released > 0) {
    lifecycleCounters.bandSweepRepairs += repaired;
    lifecycleCounters.bandSweepReleases += released;
    firehoseStep('band_sweep:changed', repaired + released, 20);
    // Synchronous convergence (round 13): refreshViewportClaims picks up
    // the just-flipped flags, the build+paint runs inline — edge-crossing
    // badges appear within the sweep's own 100ms cadence, Rango's
    // scroll-poll shape. Releases matter here too — the freed letters land
    // at the front of the local reservoir synchronously, so a claim that
    // would have returned '' a sweep ago is funded NOW.
    reconcile();
  }
}

function scheduleScrollReposition(e?: Event): void {
  // Scroll reshuffles fixed/sticky vs content — the occlusion memo can't
  // localize that, so the whole window fails open (targets move anyway, so
  // their rect keys retest them regardless). Idempotent per window.
  occlusionMemoAllDirty('scroll');
  // Reconcile badges need per-frame re-pinning during the scroll itself (they
  // don't ride the compositor); this fires on every scroll event, before the
  // trailing-edge settle below. No-op when the flag is off (empty registry).
  noteReconcileScroll();
  // Arm the eye-level paint-stability sampler (self-terminating; see above).
  notePaintSamplerScroll();
  // Mid-fling band repair (throttled, both directions) — badges for rows
  // crossing the band edge paint DURING the fling, funded by same-sweep
  // releases, instead of waiting for the IO to catch up.
  noteBandSweep();
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
  noteSettleTrigger('scroll');
  if (pageSession.scrollRepositionTimer) clearTimeout(pageSession.scrollRepositionTimer);
  pageSession.scrollRepositionTimer = setTimeout(() => {
    pageSession.scrollRepositionTimer = null;
    // Scroll-settle is the canonical viewport-exit moment (stale-TRUE release)
    // AND where infinite-scroll content lands (band discovery).
    runSettlePipeline('band');
    // A spa_nav that arrived mid-scroll (scroll-driven URL tick, e.g. a
    // pagination offset) was parked; run it now that the storm is over.
    flushDeferredNavRescan();
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
onContainerResize(() => scheduleDeferredReposition('container-resize'));

// Transform-ancestor trigger (notes/DESIGN_TRANSFORM_ANCESTOR_RECONCILE.md).
// A pan/zoom canvas (React Flow — QuickBase pipeline builder) moves its viewport
// by mutating an ancestor's `transform` via pointermove, firing NO scroll event,
// so the scroll-driven follow loop never runs and badges freeze mid-pan. When a
// tracked transformed ancestor's style mutates, poke the SAME bounded, self-
// cancelling per-frame follow loop the scroll path uses (noteReconcileScroll),
// and debounce a settle so post-pan discovery/strict converge (a pan can reveal
// new in-band nodes). No-op unless a badge registered a transformed ancestor,
// which only happens when the bkTransformTrigger flag is on.
onTransformAncestorMutation(() => {
  noteReconcileScroll();
  scheduleDeferredReposition('transform-ancestor');
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
const DEFERRED_REPOSITION_DEBOUNCE_MS = 100;
function scheduleDeferredReposition(src?: Event | string): void {
  // Occlusion-memo invalidation taps (notes/DESIGN_OCCLUSION_HITTEST_MEMO.md),
  // riding the signals already routed here. resize (incl. zoom) reshuffles
  // fixed/sticky vs content → fail open; transform-ancestor pans move
  // everything → fail open; focus/transition/animation events queue their
  // target for cell-marking at the next gather (:focus-within and
  // end-of-animation restyles can repaint with no MO record the page
  // observer's attributeFilter would carry). 'mo-batch' and
  // 'target-mutation' are already tapped at their sources; 'container-resize'
  // is deliberately untapped (anchor resizes move the targets themselves —
  // the rect key retests them).
  if (src === 'transform-ancestor') {
    occlusionMemoAllDirty('transform-ancestor');
  } else if (src instanceof Event) {
    if (src.type === 'resize') occlusionMemoAllDirty('resize');
    else if (src.target instanceof Element) occlusionMemoNoteTarget(src.target);
  }
  noteSettleTrigger(`deferred:${typeof src === 'string' ? src : src?.type ?? 'direct'}`);
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
// The pointerover wrapper ALSO feeds the occlusion memo the event
// coordinates (zero layout reads — the memo's only signal for pure-CSS
// :hover paints). The sweep call itself is unchanged: the memo tap must not
// touch recheckPendingVisibility behavior (the temperamental hover-reveal
// promote path).
pageSession.resources.listen(document, 'pointerover', (e: PointerEvent) => {
  occlusionMemoNotePointer(e.clientX, e.clientY);
  schedulePointerVisibilitySweep();
}, { passive: true, capture: true });
// Pointer left the window entirely: the `:hover` reveal collapses back to
// visibility:hidden, but no further `pointerover` fires to catch it, so the badge
// would linger until the next settle. `pointerout` with a null `relatedTarget`
// means the pointer exited to outside the document — sweep then so the badge
// hides promptly. Mirrors how Rango pairs focusin with focusout. The IN-PAGE
// un-hover case needs no handler: moving onto any other element fires another
// `pointerover`. Gated on the null check so ordinary in-page pointerouts (every
// element boundary crossing) don't double the sweep rate.
pageSession.resources.listen(document, 'pointerout', (e: PointerEvent) => {
  // Memo tap on EVERY pointerout (un-hover collapses happen at each boundary
  // crossing, not just window exit); the sweep keeps its null-check gate.
  occlusionMemoNotePointer(e.clientX, e.clientY);
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
  // Class/style/subtree churn on a badge target can restyle paint around it
  // (this tracker sees records the doc-level attributeFilter misses).
  occlusionMemoNoteTarget(target);
  scheduleDeferredReposition('target-mutation');
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
  // EXCEPT in caret/visual mode, which owns n/N/Escape to extend the selection
  // to matches (findExtend) — let those keys fall through to the caret handler.
  const inCaretMode = keyHandler.getMode() === 'caret' || keyHandler.getMode() === 'visual';
  if (!inCaretMode && handleFindNavKey(e)) return;
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
if (harnessHooksEnabled()) {
  pageSession.resources.listen(document, '__branchkit__capture_snapshot', () => {
    try {
      const payload = captureDebugSnapshot(store, trimFrameUrl(window.location.href), snapshotExtras());
      document.documentElement.dataset.branchkitSnapshot = JSON.stringify(payload);
    } catch {
      // Snapshot build failed (detached store, serialization); leave the
      // previous mirror in place rather than wedging the page.
    }
  }, true);
}

// Soak hook: a page-world dispatch of this event forces the orphan teardown
// path, so the harness (notes/SOAK_TEARDOWN.md) can induce the torn-down state
// deterministically without a real extension reload, then fire events and read
// the branchkitOrphanHits gauge. `once` so it self-removes after firing.
// Harness builds only — in a release build any page could quiesce the CS in
// its own tab (SOAK_TEARDOWN.md: gate before shipping).
if (harnessHooksEnabled()) {
  document.addEventListener('__branchkit__force_teardown', () => {
    pageSession.teardown('orphan');
  }, { once: true });
}

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
function discoverInSubtree(root: Element, source: DiscoverySource): number {
  // Resurrection guard: a torn-down orphan must not re-discover into a dead
  // session. Reached via SHADOW_EVENT, this rebuilds observers/wrappers that
  // quiesceOrphan removed. See notes/DESIGN_TEARDOWN_OWNERSHIP.md.
  if (pageSession.isTornDown) { recordOrphanHit(); return 0; }
  const __cpuStart = performance.now();
  const result = scanElements(root, (el) => store.findWrapperFor(el) !== undefined);
  applyUserRuleToScan(result, root);
  const added = attachDiscovered(result.refs, result.elements, collectLimboWrappers(), collectStrongKeyIndex(), source);
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
// Walk batch size for the sliced rediscovery. Distinct from
// DEFAULT_SCAN_BATCH_SIZE (15 — sized for the scan path's per-batch grammar
// POSTs, which this path doesn't do): mid-storm the page mutates during
// every inter-batch yield, so each batch's first geometry read forces a
// full style+layout pass — the batch count IS the reflow count. At 15, a
// 680-candidate grid pays ~45 forced reflows ≈ 1.5-3.4s mid-fling, vs the
// identical walk in 111ms at boot when layout stays warm (round 18c).
// 60 keeps the per-batch sync slab bounded (~60 warm reads + one reflow,
// well under the wedge threshold) while cutting the reflow count ~4x.
const SWEEP_WALK_BATCH_SIZE = 60;

// One-slab budget for EVERY band-discovery sweep (rounds 20/20b): mid-storm
// every inter-batch yield hop costs ~150ms (the page's own swap tasks run
// between our slices), so even 12 hops ≈ 1.8s — while the identical walk
// runs 21-112ms as one slab (one forced reflow, then warm reads; page
// mutations can't interleave inside a task). Rango's synchronous unbudgeted
// walk pays the storm ZERO times; this is the round-13 posture applied to
// the sweep: batches run back-to-back inside one task until this budget,
// yield only past it (circuit breaker, not pacing).
//
// 700, not 250 (the 20 value): the real mid-storm one-slab cost is
// ~300-500ms (reflow + ~1400 warm reads on a double-buffered grid), and a
// budget at the edge is the worst of both — it pays the slab, expires a few
// batches short, and the TAIL yield-hops through the storm anyway (drill:
// fast sweep still 2.2s). And it applies to IDLE sweeps too, not just
// reveal-armed ones: a per-batch-yielding idle sweep holds the single-flight
// lock for seconds mid-storm, so the reveal's fast request queues behind it
// (drill: +1.45s). A ≤~500ms task during frames the page is already
// dropping is the accepted round-13 trade; the huge-mutation path keeps
// per-batch yields (the actual freeze scar).
const SWEEP_SLAB_BUDGET_MS = 700;

async function discoverInSubtreeBatched(
  root: Element, source: DiscoverySource, slabBudgetMs = 0,
): Promise<number> {
  const __cpuStart = performance.now();
  let added = 0;
  // Feed the limbo pool before collecting it (fling-wave round 8; see
  // drainDiscovery) — dead-but-unprocessed content must be rebindable.
  dropDisconnectedWrappers();
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
    added += attachDiscovered(inc.refs, inc.elements, limboPool, keyIndex, source);
    initialSeen = new Set(inc.refs);
  }

  let invisibleCandidates: Element[] = [];
  let lastYieldAt = performance.now();
  for (const batch of scanInBatches(root, SWEEP_WALK_BATCH_SIZE, initialSeen, isKnown)) {
    if (cr?.excludes.length) applyExclusions(batch.refs, batch.elements, cr.excludes);
    added += attachDiscovered(batch.refs, batch.elements, limboPool, keyIndex, source);
    if (batch.isLast) invisibleCandidates = batch.invisibleCandidates;
    // Yield so the main thread frees between batches — this is the whole
    // point of the sliced path. Front-of-queue resume (scheduler.yield),
    // NOT setTimeout(0): mid-storm each timeout hop queued behind the
    // page's pending tasks at 50-150ms, and ~45 hops on a 300-row grid WAS
    // the 3-4s "late wave" (DESIGN_FLING_WAVE round 17). Batching itself —
    // the actual freeze protection — is unchanged.
    //
    // A reveal-armed sweep (slabBudgetMs > 0) skips the yield while inside
    // its slab budget: mid-storm EVERY hop pays ~150ms of the page's own
    // swap tasks, so the hop count IS the wall-clock — the same walk is
    // 111ms at boot and was still ~2.1s mid-storm at 12 hops (round 20).
    // The budget is the round-13 circuit breaker, not pacing.
    if (slabBudgetMs > 0 && performance.now() - lastYieldAt < slabBudgetMs) continue;
    // Attribution stamp (round 20c): fires ONLY when a slab blows its
    // budget — size carries elapsed ms, so the next drill says whether the
    // mid-storm walk genuinely exceeds SWEEP_SLAB_BUDGET_MS (dirty-layout
    // reflow on the double-buffered DOM) or never yields at all.
    if (slabBudgetMs > 0) {
      firehoseStep('band_discovery:slab_yield', Math.round(performance.now() - __cpuStart), 0);
    }
    await yieldTask();
    lastYieldAt = performance.now();
    // The yield continuation is not cancellable; bail if the session died
    // mid-walk (same contract as drainDiscovery's chain).
    if (pageSession.isTornDown) return added;
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
    attachWrapper(new ElementWrapper(target, scanned), 'attr');
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
  // The limbo finalize sweep, registered exactly once per session (this
  // function is guarded by hintMachineryEnabled). A pausable: it stops while
  // the tab is hidden — a 250ms whole-store walk was the second continuous
  // hidden-tab cost after the MO (long-session-perf finding 7) — and
  // teardownAll clears it instead of leaving an orphan sweeper running.
  // onVisibilityChange drives pause/resume at the registry level.
  pageSession.resources.pausableInterval(finalizeExpiredLimboWrappers, LIMBO_DEADLINE_MS);
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
  // The limbo finalize sweep pauses too, but at the registry level: the
  // caller (onVisibilityChange) follows this with resources.pause(), which
  // stops every pausable interval. Pausing it is safe: the mutation source
  // is now down, so no new wrappers enter limbo while hidden; resume re-arms
  // it and doScan reaps anything expired (long-session-perf finding 7).
  // The discovery drain is a yield task (not cancellable): clearing the
  // queue makes an already-scheduled continuation a no-op (empty-set
  // return), and the reset flag lets resume re-schedule cleanly.
  pageSession.discoveryScheduled = false;
  pageSession.pendingDiscoveryRoots.clear();
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
    if (pageSession.badgesVisible) showBadges();
  });
  bkLog('BK_RESUME', { url: trimFrameUrl(window.location.href), wrappers: store.all.length });
}

// One persistent visibilitychange handler driving the deferred/active/suspended
// state machine for an eligible frame, plus the registry-level pause/resume of
// every pausable interval (limbo sweep, top-frame watchdog + perf publishers).
// A subframe inherits the top document's visibility, so the whole tab
// transitions as a unit.
//   - Lever 2 (lazy discovery): a tab that loaded hidden activates on first show.
//   - Lever 3 (suspend): an active tab suspends when hidden, resumes when shown.
function onVisibilityChange(): void {
  if (document.visibilityState === 'visible') {
    // Re-arm pausables BEFORE the eligibility gate and the machinery resume:
    // pausables exist independently of hint machinery (the top-frame watchdog
    // and perf publishers run even before activation), and resumeHintMachinery's
    // doScan should run with a live limbo sweep.
    pageSession.resources.resume();
    if (!frameMayHoldHints()) return;
    if (!hintMachineryEnabled) {
      // First show of a tab that loaded hidden. 'load' relies on the storage
      // callback for the first scan, but that returned early while hidden —
      // kick it here.
      activateHintMachinery('load');
      kickInitialScan();
    } else if (suspended) {
      resumeHintMachinery();
    }
  } else {
    if (frameMayHoldHints() && hintMachineryEnabled && !suspended) {
      suspendHintMachinery();
    }
    pageSession.resources.pause();
  }
}
pageSession.resources.listen(document, 'visibilitychange', onVisibilityChange);
// Initial pausable state must match initial visibility: a tab loaded hidden
// (background open, prerender) pays no pausable wakeups until first shown.
// Module evaluation is synchronous, so intervals armed earlier in this file
// (the top-frame watchdog) cannot tick before this pause lands.
if (document.visibilityState !== 'visible') pageSession.resources.pause();

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
      discoverInSubtree(host, 'shadow');
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
        discoverInSubtree(instance, 'shadow');
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
(window as any).branchkitShowBadges = () => { doScan(); showBadges(); };
(window as any).branchkitHideBadges = () => hideBadges();
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
    // Publish timestamp. The dataset mirror freezes while the tab is hidden
    // (visibility gate below), so consumers need this to tell a fresh snapshot
    // from one stranded at the moment the tab was backgrounded.
    ts: Date.now(),
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
// so any world can read it. The interval is a pausable, so hidden tabs skip
// the work entirely — including the timer wakeup (the dataset goes stale,
// not empty): the snapshot walks the whole wrapper store and the JSON grows
// with CPU-bucket count, and Firefox only throttles hidden-tab timers to
// ~1s (vs Chrome's ~1/min), so unpaused this was a store-walk + stringify
// per second per hidden tab, times days of accumulated tabs. Direct one-shot
// calls (boot marker, reset-handshake confirmation) publish regardless of
// visibility: a tab loaded hidden must still publish once so dataset
// presence works as a liveness probe (scripts/_test-extension-reload-
// firefox.mjs), and a reset delivered to a hidden tab must confirm with
// zeroed counters or drivers diff against pre-reset history
// (scripts/test-perf.mjs).
function publishPerfSnapshot(): void {
  if (!harnessHooksEnabled()) return;
  try {
    document.documentElement.dataset.branchkitPerf =
      JSON.stringify(buildPerfSnapshot());
  } catch { /* dom not ready */ }
}
// Top frame only: the dataset mirror exists for Playwright/in-page inspection,
// which reads the top document's element. A subframe publishing to its own
// (unread) documentElement is pure 4Hz waste across the ad-frame swarm.
// Harness builds only: in release this is a 4Hz store-walk+stringify forever
// AND a page-readable disclosure surface (any site can fingerprint the
// extension and read the full perf payload). The 5s PERF_REPORT ship below
// stays — it goes to the paired plugin, not the page.
if (isTopFrame && harnessHooksEnabled()) {
  pageSession.resources.pausableInterval(publishPerfSnapshot, 250);
  publishPerfSnapshot();
}

// Periodic ship to the browser plugin's /perf-report endpoint so we have
// a JSONL trail in `~/Library/Application Support/BranchKitDev/plugins/
// browser/extension-perf.jsonl` for offline analysis. The dataset
// publish above is for live in-page inspection; this is the durable
// record. Every 5s is the sample interval — slow enough to be cheap,
// fast enough to bracket a Firefox unresponsive-script event.
// Visible tabs only (the interval is a pausable, stopped while hidden): a
// hidden tab has nothing new to report, and every ship is a sendMessage
// that resets the background's idle timer — with N accumulated tabs that's
// N/5 wakeups/sec keeping the Firefox event page (and the plugin's
// /perf-report handler) permanently hot. The trail keeps full coverage of
// the tab the user is actually looking at.
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
  pageSession.resources.pausableInterval(shipPerfReport, PERF_REPORT_INTERVAL_MS);
  // Pause stops ships while hidden, which also stops the only cpu.share
  // baseline advance — without a re-arm, the first ship after refocus would
  // compute its share window over the entire hidden span (hours), diluting
  // pct toward 0 and lumping all hidden-period bucket deltas into one bogus
  // trail sample. Re-arm (without shipping) on the visible transition so the
  // first sample covers a normal window; the watchdog baseline needs the
  // same treatment or its first post-resume tick reads the hidden span as
  // one giant stall.
  pageSession.resources.listen(document, 'visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      rearmCpuShareBaseline();
      rearmWatchdogBaseline();
    }
  });
  // Reset trigger from main world — set the dataset to "1" and we reset.
  // Harness builds only (page-dispatchable, plus a standing attribute MO).
  if (harnessHooksEnabled()) {
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
}

