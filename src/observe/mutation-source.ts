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
 * shadow surfaces — and are injected here via `initMutationSource`, alongside the
 * reposition schedulers and the PageSession instance. They become direct
 * imports / store-delta subscriptions in later tiers.
 */

import { store } from '../core/store';
import { detachWrapper } from '../core/wrapper-lifecycle';
import { dropDisconnectedWrappers } from './limbo';
import { subtreeMaybeHintable } from '../scan/scanner';
import { cacheVisibility, clearLayoutCache } from '../layout-cache';
import { scheduleSync } from '../labels/label-sync';
import { getHintVisibility } from '../config';
import { recordCpu, lifecycleCounters } from '../debug/perf-counters';
import { firehoseStep } from '../debug/firehose';
import { Message } from '../types';
import type { PageSession } from '../lifecycle/page-session';

let pageSession!: PageSession;
let discoverInSubtree!: (root: Element) => number;
let discoverInSubtreeBatched!: (root: Element) => Promise<number>;
let reevaluateAttribute!: (target: Element) => boolean;
let scheduleReposition!: () => void;
let scheduleDeferredReposition!: () => void;

export interface MutationSourceDeps {
  pageSession: PageSession;
  discoverInSubtree: (root: Element) => number;
  discoverInSubtreeBatched: (root: Element) => Promise<number>;
  reevaluateAttribute: (target: Element) => boolean;
  scheduleReposition: () => void;
  scheduleDeferredReposition: () => void;
}

/** Wire the still-in-content.ts collaborators. Call once at boot. */
export function initMutationSource(deps: MutationSourceDeps): void {
  pageSession = deps.pageSession;
  discoverInSubtree = deps.discoverInSubtree;
  discoverInSubtreeBatched = deps.discoverInSubtreeBatched;
  reevaluateAttribute = deps.reevaluateAttribute;
  scheduleReposition = deps.scheduleReposition;
  scheduleDeferredReposition = deps.scheduleDeferredReposition;
}

// Beyond the HUGE_MUTATIONS_COUNT threshold (DarkReader's pattern), we
// stop processing nodes individually and just queue a coarse refresh.
// Slack and Linear regularly trip 1000+ mutations per scroll event.
const HUGE_MUTATIONS_COUNT = 1000;
const HUGE_MUTATION_IDLE_MS = 50;

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
  if (dirty) scheduleSync('mutation-source');
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
  firehoseStep('drainDiscovery:start', __rootCount);

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
      lifecycleCounters.discoveryRootsSkipped++;
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
    pageSession.pendingDiscoveryRoots.add(workRoots[i]);
  }
  if (pageSession.pendingDiscoveryRoots.size > 0 && pageSession.discoveryFrame === null) {
    pageSession.discoveryFrame = requestAnimationFrame(drainDiscovery);
  }
  if (dirty) scheduleSync('mutation-source');
  recordCpu('drainDiscovery', performance.now() - __cpuStart);
  if (__rootCount > 0) {
    recordCpu(
      `drainDiscovery:size:${__rootCount > 1000 ? '1000+' : __rootCount > 100 ? '100-1000' : '<100'}`,
      __rootCount,
    );
  }
  firehoseStep('drainDiscovery:end', __rootCount);
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
  firehoseStep('processMutations:start', records.length);
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
  firehoseStep('processMutations:end', records.length);
}

const observer = new MutationObserver((records) => {
  const __cpuStart = performance.now();
  lifecycleCounters.moCallbackInvocations++;
  firehoseStep('moCallback:start', records.length);
  // Diagnostic: sample the first record's type and target to find the source
  // of the high-rate end_all_own loop on YouTube /featured. The 28-records-
  // every-2ms pattern means something is mutating 28 of our badges in a tight
  // microtask loop — discriminating childList vs attributes vs the attribute
  // name pins which of our DOM operations is the trigger.
  if (records.length > 0 && Math.random() < 0.05) {
    const r0 = records[0];
    const target0 = r0.target instanceof Element ? r0.target : null;
    const tag = target0?.tagName?.toLowerCase() ?? '?';
    const attrName = r0.type === 'attributes' ? r0.attributeName : null;
    const added = r0.type === 'childList' ? r0.addedNodes.length : 0;
    const removed = r0.type === 'childList' ? r0.removedNodes.length : 0;
    chrome.runtime.sendMessage({
      type: 'DEBUG_LOG',
      tag: 'pipeline.cs_firehose_step',
      data: {
        step: 'moCallback:sample',
        size: records.length,
        rec_type: r0.type,
        tag,
        attr: attrName,
        added,
        removed,
        has_own_attr: target0?.hasAttribute('data-branchkit-hint') ?? false,
      },
    } as Message).catch(() => {});
  }
  // Hints are visible — behavior depends on visibility mode.
  // In "manual" mode, defer mutations so codewords don't shuffle while
  // the user is reading badges. hideHints() flushes via doScan().
  // In "always" mode, process mutations incrementally so SPA navigation
  // and dynamic content get badges without requiring escape+re-show.
  if (pageSession.hintsVisible && getHintVisibility() === 'manual') {
    pageSession.pendingMutation = true;
    recordCpu('moCallback', performance.now() - __cpuStart);
    firehoseStep('moCallback:end_manual_deferred', records.length);
    return;
  }

  // Filter our own mutations early so the threshold isn't tripped by
  // badge mount/unmount churn.
  firehoseStep('moCallback:filter_start', records.length);
  const foreign = records.filter(m => {
    if (m.type === 'childList') {
      const allOwnAdded = Array.from(m.addedNodes).every(isOwnMutation);
      const allOwnRemoved = Array.from(m.removedNodes).every(isOwnMutation);
      return !(allOwnAdded && allOwnRemoved);
    }
    return !isOwnMutation(m.target);
  });
  firehoseStep('moCallback:filter_end', foreign.length);
  lifecycleCounters.moForeignRecords += foreign.length;
  if (foreign.length === 0) {
    recordCpu('moCallback', performance.now() - __cpuStart);
    firehoseStep('moCallback:end_all_own', records.length);
    return;
  }

  if (foreign.length >= HUGE_MUTATIONS_COUNT) {
    lifecycleCounters.moHugePathFired++;
    if (pageSession.hugeMutationTimer) clearTimeout(pageSession.hugeMutationTimer);
    pageSession.hugeMutationTimer = setTimeout(() => {
      pageSession.hugeMutationTimer = null;
      firehoseStep('huge_path:timer_fired', foreign.length);
      // Limbo entry doesn't change grammar (codewords are still claimed);
      // the finalize sweeper schedules push on actual detach. We only
      // need to push if discovery added new wrappers.
      dropDisconnectedWrappers();
      // Full-page rediscovery is sliced — a synchronous discoverInSubtree
      // over the whole fresh body froze Firefox ~1.1s on YouTube /watch
      // SPA nav (notes/DESIGN_NAV_TIME_RESCAN.md).
      firehoseStep('huge_path:batched_start', foreign.length);
      void discoverInSubtreeBatched(document.body || document.documentElement)
        .then((added) => {
          firehoseStep('huge_path:batched_end', added);
          if (added > 0) scheduleSync('mutation-source');
          if (pageSession.hintsVisible) {
            scheduleReposition();
          }
        });
    }, HUGE_MUTATION_IDLE_MS);
    recordCpu('moCallback', performance.now() - __cpuStart);
    firehoseStep('moCallback:end_huge_scheduled', foreign.length);
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
  if (pageSession.hintsVisible) scheduleDeferredReposition();
  recordCpu('moCallback', performance.now() - __cpuStart);
  firehoseStep('moCallback:end_normal', foreign.length);
});

export function attachPageMutationObserver(): void {
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
}

/** Disconnect the page observer and cancel the pending reevaluation frame.
 * Idempotent; called from teardown. (The discovery rAF + huge-mutation timer
 * live on PageSession and are cancelled by the session teardown.) */
export function teardownMutationSource(): void {
  try { observer.disconnect(); } catch { /* may not be initialized yet */ }
  if (reevaluationFrame !== null) {
    cancelAnimationFrame(reevaluationFrame);
    reevaluationFrame = null;
  }
}
