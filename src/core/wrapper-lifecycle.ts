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

import { ElementWrapper } from '../scan/element-wrapper';
import { ScannedElement } from '../types';
import { domSeenAt } from '../observe/dom-seen';
import * as idRegistry from '../scan/registry';
import { isRecallLoaded, resolvePreferredCodeword } from '../labels/codeword-recall';
import { dropPendingPut, hasSent, queueDelete } from '../labels/label-sync';
import { tryRebindFromLimbo, tryRebindByStrongKey, isRecentlyOrphaned } from '../observe/limbo';
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
export function attachWrapper(wrapper: ElementWrapper): void {
  // Paint-latency stage stamp: when did the MO first sight this element's
  // subtree? tAttached - tDomSeen is the discovery layer's contribution.
  wrapper.tDomSeen = domSeenAt(wrapper.element);
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
  // Capture the codeword BEFORE removal: removeWrapperByElement calls
  // releaseLabel(), which blanks scanned.codeword. The pre-2026-07 code read
  // it after, always saw '', and never queued the plugin-side Delete — every
  // detach leaked a stale grammar entry (a painted-but-gone codeword the
  // plugin kept matching), which the epoch handshake then kept detecting
  // and repairing with full rotate+republish cycles.
  const cw = store.findWrapperFor(element)?.scanned.codeword ?? '';
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
  keyIndex: Map<string, ElementWrapper | null>,
): number {
  let added = 0;
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
    if (tryRebindByStrongKey(ref, keyIndex, limboPool)) continue;
    if (limboPool.length > 0 && tryRebindFromLimbo(ref, limboPool)) continue;
    // Eager attach (Rango/Vimium model). Wrappers stay alive while their
    // element is in the DOM — scroll-out doesn't release them. The
    // attention IO is reserved for bounding `pendingVisibility` membership
    // (the YouTube-comment-skeleton case), not for wrapper lifecycle.
    // Trades unbounded wrapper growth on infinite-scroll pages for
    // correct scroll-back behavior (badges reappear on scroll up).
    attachWrapper(new ElementWrapper(ref, elements[i]));
    added++;
  }
  return added;
}
