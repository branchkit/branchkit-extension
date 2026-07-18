/**
 * BranchKit Browser — wrapper lifecycle (attach / detach).
 *
 * The create/destroy half of the wrapper SCC core: minting a wrapper's registry
 * id, adding it to the store, starting the observers, and the reverse on detach
 * (including delta-sync bookkeeping). Extracted from content.ts module scope
 * (Tier 1 of notes/DESIGN_EXTENSION_RESTRUCTURE.md).
 *
 * The three observers it drives (`tracker`, `resizeObserver`,
 * `attentionObserver`) are owned by the `pageSession` singleton (Tier 3 of the
 * restructure — constructed in `PageSession.start()`), reached by direct
 * import. The discovery walk (`discoverInSubtree`) and `reevaluateAttribute`
 * stay in content.ts for now; they reach into the rules / attention / shadow
 * surfaces and move with the mutation source.
 */

import { DiscoverySource, ElementWrapper } from '../scan/element-wrapper';
import { scanSingle } from '../scan/scanner';
import { ScannedElement } from '../types';
import { domSeenAt } from '../observe/dom-seen';
import * as idRegistry from '../scan/registry';
import { isRecallLoaded, resolvePreferredCodeword } from '../labels/codeword-recall';
import { dropPendingPut, hasSent, queueDelete, queuePut, scheduleSync } from '../labels/label-sync';
import { tryRebindFromLimbo, tryRebindByStrongKey, tryRebindByCoattail, isRecentlyOrphaned } from '../observe/limbo';
import { VIEWPORT_MARGIN_PX } from '../observe/intersection-tracker';
import { geometryInBand, getCachedRect, isRectOnScreen } from '../layout-cache';
import { lifecycleCounters } from '../debug/perf-counters';
import { recordShownDetach } from '../debug/churn-log';
import { store } from './store';
import { pageSession } from '../lifecycle/page-session';

// Regime B phase 3 (DESIGN_CODEWORD_STABILITY): seed a wrapper's
// preferredCodeword from the SW-persisted memory so it reclaims the codeword
// its fingerprint held before a full-document reload. Only when the recall has
// loaded, the wrapper has no within-page preference and no codeword yet, and the
// confidence ladder resolves a remembered codeword. Granting it is phase 4.
export function seedPreferredFromMemory(wrapper: ElementWrapper): void {
  if (!isRecallLoaded()) return;
  if (wrapper.preferredCodeword || wrapper.scanned.codeword) return;
  if (wrapper.scanned.id <= 0) return;
  const fp = idRegistry.get(wrapper.scanned.id)?.fingerprint;
  if (!fp) return;
  const r = wrapper.lastRect;
  const rect = r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
  const cw = resolvePreferredCodeword(fp, rect);
  if (cw) wrapper.preferredCodeword = cw;
}

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
export function attachWrapper(wrapper: ElementWrapper, source: DiscoverySource): void {
  // Paint-latency stage stamps (notes/DESIGN_FLING_WAVE.md round 15): which
  // path discovered this wrapper, and when was the element first sighted.
  // The MO stamp is authoritative when one resolves — for a wrapper a sweep
  // or scan attached, tAttached - tDomSeen is then the MO path's miss
  // window. No stamp on the chain → fall back to tAttached so EVERY wrapper
  // enters the percentiles (the round-15 survivorship fix); domSeenByMo
  // keeps the two cases separable in the per-source snapshot section.
  wrapper.discoverySource = source;
  const moSeen = domSeenAt(wrapper.element);
  wrapper.tDomSeen = moSeen ?? wrapper.tAttached;
  wrapper.domSeenByMo = moSeen !== null;
  // Strict-viewport position at attach (round 21): the rect is warm — the
  // scan walk's visibility check just read it — so this is a cache hit in
  // the common case, one gBCR otherwise.
  wrapper.inViewportAtAttach = isRectOnScreen(getCachedRect(wrapper.element));
  lifecycleCounters.attachedBySource[source] =
    (lifecycleCounters.attachedBySource[source] ?? 0) + 1;
  // Mint the registry id first. A rejected registration (id=0) means the
  // fingerprint validator couldn't disambiguate this element from another
  // already in the registry — voice can't safely address it, so don't add
  // it to the store or start observers. Quill's empty editor div sibling
  // is the canonical case: same role/name/tag as the toolbar div, no
  // distinguisher.
  idRegistry.register(wrapper);
  seedPreferredFromMemory(wrapper);
  store.addWrapper(wrapper);
  pageSession.tracker.observe(wrapper.element);
  pageSession.resizeObserver.observe(wrapper.element);
  // Note: NOT observing via attentionObserver. Wrappers stay attached
  // until DOM disconnect (Rango model); leave-detach is the regression
  // path. The attention observer's only job is bounding pendingVisibility.
}

/**
 * Remove the wrapper for an element. Returns its codeword (if any) to
 * the pool and unobserves both observers.
 */
export function detachWrapper(element: Element): void {
  pageSession.resizeObserver.unobserve(element);
  pageSession.tracker.unobserve(element);
  pageSession.attentionObserver.unobserve(element);
  // Churn log (round 22): preserve a shown wrapper's history before the
  // store forgets it — destroyed wrappers vanish from every percentile, so
  // a pop→wipe→rebuild cycle is otherwise invisible to the snapshot.
  const dying = store.findWrapperFor(element);
  if (dying && dying.tFirstShown !== null) {
    const now = performance.now();
    recordShownDetach({
      tDetached: now,
      shownForMs: now - dying.tFirstShown,
      tag: element.tagName.toLowerCase(),
      source: dying.discoverySource,
      inViewport: dying.lastRect !== null && isRectOnScreen(dying.lastRect),
      hadCodeword: dying.scanned.codeword !== '',
    });
  }
  // Capture the codeword BEFORE removal: removeWrapperByElement calls
  // releaseLabel(), which blanks scanned.codeword. The pre-2026-07 code read
  // it after, always saw '', and never queued the plugin-side Delete — every
  // detach leaked a stale grammar entry (a painted-but-gone codeword the
  // plugin kept matching), which the epoch handshake then kept detecting
  // and repairing with full rotate+republish cycles.
  const cw = dying?.scanned.codeword ?? '';
  const removed = store.removeWrapperByElement(element);
  if (removed) {
    // Delta-sync bookkeeping: if the plugin holds this codeword, queue
    // the Delete; if the wrapper was pending a Put that hasn't fired
    // yet, drop the Put. Either way we don't want stale state on the
    // plugin side post-detach.
    dropPendingPut(removed);
    if (cw && hasSent(cw)) queueDelete(cw);
    if (removed.scanned.id > 0) {
      idRegistry.unregister(removed.scanned.id);
    }
  }
}

// Rebind-or-attach a batch of freshly-scanned hintables. Shared by the
// synchronous `discoverInSubtree` and the sliced
// `discoverInSubtreeBatched` so the limbo-rebind/eager-attach semantics
// stay identical between them. `limboPool` is gathered once by the caller
// and spliced in place as wrappers get consumed, so two new elements can't
// both claim the same limbo wrapper (across batches too). Returns the
// number of wrappers newly attached (rebinds don't count as added).
export function attachDiscovered(
  refs: Element[], elements: ScannedElement[], limboPool: ElementWrapper[],
  keyIndex: Map<string, ElementWrapper[]>, source: DiscoverySource,
): number {
  let added = 0;
  const attached: ElementWrapper[] = [];
  // Row pairs proven by strong-key rides this pass (round 35): a link
  // riding old-element -> new-element pins its old row to its new row, and
  // the row's KEYLESS controls (checkbox/pencil/eye) coattail that pin in
  // pass 2. Two passes because document order puts the checkbox BEFORE the
  // row's first link — the pin doesn't exist yet on a single walk
  // (round 26's ordering lesson).
  const rowPairs = new Map<Element, Element>();
  const deferred: number[] = [];
  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i];
    // Skip a node we just transferred a wrapper *off* of (key-ownership rebind).
    // Re-grabbing it would bounce the wrapper back; the page removes it shortly
    // and the guard window covers the gap. See DESIGN_CODEWORD_KEY_OWNERSHIP.md.
    if (isRecentlyOrphaned(ref)) continue;
    if (store.findWrapperFor(ref)) continue;
    // Key-ownership: a re-mounted node inherits its predecessor's codeword by
    // strong key (href), ahead of the fingerprint/position path. Sidesteps the
    // pool-availability race that churns the QuickBase sidebar.
    const rode = tryRebindByStrongKey(ref, keyIndex, limboPool);
    if (rode) {
      const prevRow = rode.prevElement.closest('tr, [role="row"]');
      const newRow = ref.closest('tr, [role="row"]');
      if (prevRow && newRow && prevRow !== newRow && !rowPairs.has(newRow)) {
        rowPairs.set(newRow, prevRow);
      }
      // Round 34e: the steal orphaned a still-CONNECTED predecessor (no
      // dead holder was available). Re-attach it fresh RIGHT NOW — the
      // orphan guard blocks it from rebind tiers (ping-pong), and waiting
      // for guard expiry + a later sweep left visible links bare (and the
      // eventual re-discovery stole from the next duplicate). scanSingle
      // returns null for hidden elements, so doomed buffer copies don't
      // re-attach — only genuinely visible orphans get a fresh letter.
      if (rode.orphaned) {
        const sc = scanSingle(rode.orphaned);
        if (sc) added += eagerAttach(rode.orphaned, sc, source, attached);
      }
      continue;
    }
    deferred.push(i);
  }
  for (const i of deferred) {
    const ref = refs[i];
    if (store.findWrapperFor(ref)) continue; // orphan re-attach above may have covered it
    // Coattail (round 35): ride the row pair a strong-key ride proved.
    if (rowPairs.size > 0) {
      const coat = tryRebindByCoattail(ref, rowPairs, limboPool);
      if (coat) {
        if (coat.orphaned) {
          const sc = scanSingle(coat.orphaned);
          if (sc) added += eagerAttach(coat.orphaned, sc, source, attached);
        }
        continue;
      }
    }
    if (limboPool.length > 0 && tryRebindFromLimbo(ref, limboPool)) continue;
    // (The slot rebind tier — DESIGN_FLING_WAVE Part 2 — was pruned
    // 2026-07-18 per DESIGN_STABILITY_LADDER_PRUNE.md: 0.4% of successful
    // rebinds in the trail read; its recycled-grid niche is carried by the
    // strong-key and coattail tiers.)
    added += eagerAttach(refs[i], elements[i], source, attached);
  }
  primeInBandClaims(attached);
  return added;
}

// Eager attach (Rango/Vimium model). Wrappers stay alive while their
// element is in the DOM — scroll-out doesn't release them. The attention
// IO is reserved for bounding `pendingVisibility` membership (the
// YouTube-comment-skeleton case), not for wrapper lifecycle. Trades
// unbounded wrapper growth on infinite-scroll pages for correct
// scroll-back behavior (badges reappear on scroll up).
function eagerAttach(
  ref: Element, scanned: ScannedElement, source: DiscoverySource,
  attached: ElementWrapper[],
): number {
  const wrapper = new ElementWrapper(ref, scanned);
  attachWrapper(wrapper, source);
  attached.push(wrapper);
  return 1;
}

// Prime-at-attach (notes/DESIGN_FLING_WAVE.md Part 1): a wrapper that is
// in-band by geometry right now claims in the flush microtask at the end of
// THIS task — which also builds and places its badge via the synchronous
// onCodewordsChanged → reconcile chain — instead of waiting ~305ms p50 for
// the IO to deliver the band-entry callback on saturated mid-fling frames.
// The IO demotes to steady-state maintainer for these wrappers: its initial
// callback finds the codeword present (claim branch no-ops) and keeps
// owning exits, later entries, and flag corrections.
//
// Edge-triggered once per wrapper at creation, inside the path that created
// it — NOT a level-triggered re-derivation. That distinction is what keeps
// this from re-arming the reverted settle-pass toClaim fragmentation
// (7fe37a0; see the design note). Scan-path wrappers never reach this:
// processScanBatch claims inline pre-POST and attaches via attachWrapper
// directly.
function primeInBandClaims(attached: ElementWrapper[]): void {
  if (attached.length === 0) return;
  const vw = window.innerWidth, vh = window.innerHeight;
  const primed: ElementWrapper[] = [];
  for (const w of attached) {
    if (w.scanned.codeword) continue;
    const r = getCachedRect(w.element);
    // Boxless skip (mirrors computeReconcilePlanLists' zero-rect guard):
    // display:none / not-yet-laid-out elements report an all-zeros rect that
    // would false-positive the band test at the viewport origin. Let the IO
    // decide those when they gain a box.
    if (r.width === 0 && r.height === 0 && r.top === 0 && r.left === 0) continue;
    if (!geometryInBand(r, vw, vh, VIEWPORT_MARGIN_PX)) continue;
    w.isInViewport = true;
    w.tInBand ??= performance.now();
    lifecycleCounters.primedClaims++;
    primed.push(w);
  }
  if (primed.length > 0) pageSession.tracker.primeClaims(primed);
}
