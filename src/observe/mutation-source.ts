/**
 * BranchKit Browser — mutation source (the discovery firehose).
 *
 * The page MutationObserver and its coalescing schedulers: added subtrees are
 * accumulated and drained via rAF into the discovery walk; attribute changes are
 * coalesced into a per-frame reevaluation pass; a huge-mutation short-circuit
 * keeps full-page DOM swaps from freezing the main thread. Extracted from
 * content.ts module scope (Tier 1 of notes/DESIGN_EXTENSION_RESTRUCTURE.md).
 *
 * The discovery WALK (`discoverInSubtree` / `discoverInSubtreeBatched`) and
 * `reevaluateAttribute` stay in content.ts — they reach the rules / attention /
 * shadow surfaces — and arrive through `pageSession.deps` (set once by
 * `PageSession.start()`), alongside the reposition schedulers. They become
 * direct imports / store-delta subscriptions in later tiers. The page
 * MutationObserver itself is constructed by `constructPageMutationObserver()`,
 * called from `PageSession.start()` — the session owns observer construction
 * (Tier 3 of notes/DESIGN_EXTENSION_RESTRUCTURE.md).
 */

import { store } from '../core/store';
import { detachWrapper } from '../core/wrapper-lifecycle';
import { markDomSeen } from './dom-seen';
import { dropDisconnectedWrappers } from './limbo';
import { subtreeMaybeHintable } from '../scan/scanner';
import { consumeShadowAttachSignal } from '../scan/shadow-attach-signal';
import { cacheVisibility, clearLayoutCache } from '../layout-cache';
import { getHintVisibility } from '../config';
import { recordCpu, lifecycleCounters } from '../debug/perf-counters';
import { firehoseStep } from '../debug/firehose';
import { pageSession } from '../lifecycle/page-session';

// Beyond the HUGE_MUTATIONS_COUNT threshold (DarkReader's pattern), we
// stop processing nodes individually and just queue a coarse refresh.
// Slack and Linear regularly trip 1000+ mutations per scroll event.
const HUGE_MUTATIONS_COUNT = 1000;

// Minimum batch size before a MO-path firehose breadcrumb ships. The MO
// callback fires ~80×/sec on churny pages (YouTube /watch scroll bursts), and
// every breadcrumb is a sendMessage + SW wakeup + localhost HTTP POST — ungated
// (threshold 1, left over from the nav-wedge diagnostic pass) that was up to 6
// messages per mutation batch, hundreds/sec, on every mutation-active page.
// 100 restores the gating INVESTIGATION_YOUTUBE_WATCH_PERF.md records: only
// bursts big enough to plausibly wedge are worth a breadcrumb.
//
// Pairing invariant: every step within one handlePageMutations invocation
// gates on the SAME size (records.length), including the end-family steps
// that conceptually describe the post-filter set. Gating :start on
// records.length but :end on foreign.length would suppress the end for any
// mixed batch (records >= 100, foreign < 100) and fabricate the
// start-without-end wedge signature the soak checklist greps for.
const FIREHOSE_MIN = 100;
const HUGE_MUTATION_IDLE_MS = 50;
// Max-wait deadline for the huge-mutation debounce — the same
// debounce+deadline shape as content.ts whenDOMSettles
// (notes/DESIGN_PAINT_THE_BAND.md seam 4). The trailing 50ms timer alone is
// storm-extendable: QuickBase's virtualized grids CREATE rows during scroll
// in ≥1000-record batches, each batch resetting the timer, so fresh rows
// weren't discovered until the scroll paused. The deadline guarantees one
// coarse refresh per storm window regardless of how long it rages.
const HUGE_MUTATION_MAX_WAIT_MS = 250;

function isOwnMutation(n: Node): boolean {
  return n instanceof HTMLElement && n.hasAttribute('data-branchkit-hint');
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

  try {
    for (const t of targets) {
      if (!t.isConnected) {
        // Element disconnected before we drained; if it had a wrapper
        // detach it. (dropDisconnectedWrappers usually catches this
        // via the childList path, but mutation order may leave it for
        // us when the disconnect was an attribute-only side-effect.)
        // The store detach delta drives the grammar sync (Tier 2 delta cut).
        if (store.findWrapperFor(t)) detachWrapper(t);
        continue;
      }
      // attach/detach inside reevaluateAttribute emits a store delta → sync.
      pageSession.deps.reevaluateAttribute(t);
    }
  } finally {
    clearLayoutCache();
  }
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
function scheduleDiscovery(root: Element): void {
  pageSession.pendingDiscoveryRoots.add(root);
  if (pageSession.discoveryFrame === null) {
    pageSession.discoveryFrame = requestAnimationFrame(drainDiscovery);
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
  pageSession.discoveryFrame = null;
  if (pageSession.pendingDiscoveryRoots.size === 0) return;
  const roots = [...pageSession.pendingDiscoveryRoots];
  pageSession.pendingDiscoveryRoots.clear();
  const __rootCount = roots.length;
  firehoseStep('drainDiscovery:start', __rootCount, FIREHOSE_MIN);

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
      lifecycleCounters.discoveryRootsDeduped++;
      continue;
    }
    workRoots.push(root);
  }

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
    // Shadow-hosted hintables arrive via the SHADOW_EVENT path — except
    // hosts whose attachShadow ran while disconnected (the event can't
    // reach the document listener, and no host reference crosses the
    // world boundary). While such a signal is live, a root the light
    // pre-filter would skip gets the deep shadow-piercing check instead;
    // no live signal → pre-filter cost is unchanged.
    if (!subtreeMaybeHintable(root) && !consumeShadowAttachSignal(root)) {
      lifecycleCounters.discoveryRootsSkipped++;
      continue;
    }
    // Newly-attached wrappers emit store deltas → grammar sync (Tier 2 delta cut).
    pageSession.deps.discoverInSubtree(root);
    // Yield to the event loop once we've exceeded the budget — but
    // always do at least one root so we make forward progress even when
    // a single root is heavy enough to blow the budget by itself.
    if (performance.now() - __cpuStart >= DRAIN_DISCOVERY_BUDGET_MS) break;
  }
  // Re-queue anything we didn't process this pass; the rAF below picks
  // it up on the next frame. Re-adding to a Set is idempotent so any
  // new arrivals between drain start and now coalesce naturally.
  for (let i = processed; i < workRoots.length; i++) {
    pageSession.pendingDiscoveryRoots.add(workRoots[i]);
  }
  if (pageSession.pendingDiscoveryRoots.size > 0 && pageSession.discoveryFrame === null) {
    pageSession.discoveryFrame = requestAnimationFrame(drainDiscovery);
  }
  recordCpu('drainDiscovery', performance.now() - __cpuStart);
  if (__rootCount > 0) {
    recordCpu(
      `drainDiscovery:size:${__rootCount > 1000 ? '1000+' : __rootCount > 100 ? '100-1000' : '<100'}`,
      __rootCount,
    );
  }
  firehoseStep('drainDiscovery:end', __rootCount, FIREHOSE_MIN);
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

export function processMutations(records: MutationRecord[]): void {
  const __cpuStart = performance.now();
  lifecycleCounters.processMutationsCalls++;
  firehoseStep('processMutations:start', records.length, FIREHOSE_MIN);
  let sawRemoval = false;

  for (const m of records) {
    if (m.type === 'childList') {
      for (const node of m.addedNodes) {
        if (isOwnMutation(node)) continue;
        if (node instanceof Element) {
          markDomSeen(node);
          scheduleDiscovery(node);
        }
      }
      for (const node of m.removedNodes) {
        if (isOwnMutation(node)) continue;
        if (node instanceof Element) {
          lifecycleCounters.moRemoveRecordsSeen++;
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
  firehoseStep('processMutations:end', records.length, FIREHOSE_MIN);
}

// Foreign-record count of the latest huge batch, for the fire-time
// breadcrumbs (the fire body is shared by the trailing timer and the
// deadline, so it can't close over one batch's count).
let hugeMutationLastCount = 0;

// Shared fire body for the huge-mutation trailing timer AND its max-wait
// deadline: whichever fires first clears both, so a storm window produces
// exactly one coarse refresh per firing.
function fireHugeMutationRefresh(): void {
  if (pageSession.hugeMutationTimer) {
    clearTimeout(pageSession.hugeMutationTimer);
    pageSession.hugeMutationTimer = null;
  }
  if (pageSession.hugeMutationDeadline) {
    clearTimeout(pageSession.hugeMutationDeadline);
    pageSession.hugeMutationDeadline = null;
  }
  firehoseStep('huge_path:timer_fired', hugeMutationLastCount);
  // Limbo entry doesn't change grammar (codewords are still claimed);
  // the finalize sweeper schedules push on actual detach. We only
  // need to push if discovery added new wrappers.
  dropDisconnectedWrappers();
  // Full-page rediscovery is sliced — a synchronous discoverInSubtree
  // over the whole fresh body froze Firefox ~1.1s on YouTube /watch
  // SPA nav (notes/DESIGN_NAV_TIME_RESCAN.md).
  firehoseStep('huge_path:batched_start', hugeMutationLastCount);
  void pageSession.deps.discoverInSubtreeBatched(document.body || document.documentElement)
    .then((added) => {
      firehoseStep('huge_path:batched_end', added);
      // Newly-attached wrappers emit store deltas → grammar sync.
      if (pageSession.hintsVisible) {
        pageSession.deps.scheduleReposition();
      }
    });
}

function handlePageMutations(records: MutationRecord[]): void {
  const __cpuStart = performance.now();
  lifecycleCounters.moCallbackInvocations++;
  firehoseStep('moCallback:start', records.length, FIREHOSE_MIN);
  // Hints are visible — behavior depends on visibility mode.
  // In "manual" mode, defer mutations so codewords don't shuffle while
  // the user is reading badges. hideHints() flushes via doScan().
  // In "always" mode, process mutations incrementally so SPA navigation
  // and dynamic content get badges without requiring escape+re-show.
  if (pageSession.hintsVisible && getHintVisibility() === 'manual') {
    pageSession.pendingMutation = true;
    recordCpu('moCallback', performance.now() - __cpuStart);
    firehoseStep('moCallback:end_manual_deferred', records.length, FIREHOSE_MIN);
    return;
  }

  // Filter our own mutations early so the threshold isn't tripped by
  // badge mount/unmount churn.
  firehoseStep('moCallback:filter_start', records.length, FIREHOSE_MIN);
  const foreign = records.filter(m => {
    if (m.type === 'childList') {
      const allOwnAdded = Array.from(m.addedNodes).every(isOwnMutation);
      const allOwnRemoved = Array.from(m.removedNodes).every(isOwnMutation);
      return !(allOwnAdded && allOwnRemoved);
    }
    return !isOwnMutation(m.target);
  });
  firehoseStep('moCallback:filter_end', records.length, FIREHOSE_MIN);
  lifecycleCounters.moForeignRecords += foreign.length;
  if (foreign.length === 0) {
    recordCpu('moCallback', performance.now() - __cpuStart);
    firehoseStep('moCallback:end_all_own', records.length, FIREHOSE_MIN);
    return;
  }

  if (foreign.length >= HUGE_MUTATIONS_COUNT) {
    lifecycleCounters.moHugePathFired++;
    hugeMutationLastCount = foreign.length;
    // Stamp added elements for the paint-latency decomposition even on the
    // coarse path — the deferred full-body rediscovery is a prime suspect
    // for pre-attach latency, so its inputs must carry sighting times too.
    for (const m of foreign) {
      if (m.type !== 'childList') continue;
      for (const node of m.addedNodes) {
        if (node instanceof Element && !isOwnMutation(node)) markDomSeen(node);
      }
    }
    if (pageSession.hugeMutationTimer) clearTimeout(pageSession.hugeMutationTimer);
    pageSession.hugeMutationTimer = setTimeout(fireHugeMutationRefresh, HUGE_MUTATION_IDLE_MS);
    // Non-extending deadline: armed by the first batch of a storm, NOT reset
    // by later batches (the whenDOMSettles shape), so a sustained storm can't
    // defer the refresh indefinitely. fireHugeMutationRefresh clears both.
    if (pageSession.hugeMutationDeadline === null) {
      pageSession.hugeMutationDeadline = setTimeout(fireHugeMutationRefresh, HUGE_MUTATION_MAX_WAIT_MS);
    }
    recordCpu('moCallback', performance.now() - __cpuStart);
    firehoseStep('moCallback:end_huge_scheduled', records.length, FIREHOSE_MIN);
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
  if (pageSession.hintsVisible) pageSession.deps.scheduleDeferredReposition();
  recordCpu('moCallback', performance.now() - __cpuStart);
  firehoseStep('moCallback:end_normal', records.length, FIREHOSE_MIN);
}

let observer: MutationObserver | undefined;

/** Construct the page MutationObserver. Called once from `PageSession.start()`
 * — the session owns observer construction (Tier 3). Construction is inert;
 * nothing is observed until `attachPageMutationObserver()`. */
export function constructPageMutationObserver(): void {
  observer = new MutationObserver(handlePageMutations);
}

export function attachPageMutationObserver(): void {
  observer?.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    // Watch attributes that flip hintability AND those that feed the
    // fingerprint. Without aria-label/title/type in the filter, a button
    // renamed from "Save" to "Save changes" would still register against
    // its stale fingerprint and the WeakRef-dead-fingerprint-fallback
    // path could never recover it. tabindex/inert are hintability gates
    // too ([tabindex]:not([tabindex="-1"]) in HINTABLE, [inert] in
    // EXCLUDE) — without them, an element JS-enhanced with tabindex="0"
    // or un-inerted never reevaluates until a full walk happens by.
    attributeFilter: [
      'disabled', 'aria-hidden', 'role', 'contenteditable', 'href',
      'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-roledescription',
      'title', 'type', 'tabindex', 'inert',
    ],
  });
}

/** Disconnect the page observer and cancel the pending reevaluation frame.
 * Idempotent; called from teardown. (The discovery rAF + huge-mutation timer
 * live on PageSession and are cancelled by the session teardown.) */
export function teardownMutationSource(): void {
  try { observer?.disconnect(); } catch { /* may not be initialized yet */ }
  if (reevaluationFrame !== null) {
    cancelAnimationFrame(reevaluationFrame);
    reevaluationFrame = null;
  }
}
