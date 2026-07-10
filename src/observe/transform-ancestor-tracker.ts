/**
 * Shared MutationObserver for hint badge transformed ancestors.
 *
 * A pan/zoom canvas (React Flow — the QuickBase pipeline builder) moves its
 * whole viewport by mutating an ancestor's `transform` via pointermove. That
 * fires NO scroll event, so the scroll-driven badge-follow loop
 * (`reconcileScrollFrame` in content.ts) is never triggered and badges freeze /
 * drift mid-pan until an unrelated event pokes the loop, then snap (the wiggle).
 *
 * This layer watches the `style` attribute of each badge's nearest transformed
 * ancestor (via `findTransformedAncestor`). When the page rewrites that
 * transform, the callback wired by content.ts pokes the SAME bounded,
 * self-cancelling reconcile loop the scroll path uses — so the badge follows the
 * transform on the same cadence, with no new free-running rAF.
 *
 * Mirrors container-resize-tracker.ts: refcounted (many badges share one
 * transformed ancestor — every node on the canvas), idempotent observe, and a
 * single wired callback. Unlike ResizeObserver there is no initial-fire to skip;
 * a MutationObserver only fires on real attribute mutations.
 *
 * Flag-gated OFF by default (`bkTransformTrigger`): when disabled, badges never
 * register here and behavior is byte-identical to before. Callers gate
 * registration on `isTransformTriggerEnabled()`.
 */

import { harnessHooksEnabled } from '../debug/harness-hooks';

type MutationCallback = () => void;

// Gate. Pre-read safety value is false — off until content.ts's storage read
// confirms — so a badge built before the read doesn't register prematurely.
let enabled = false;

export function setTransformTriggerEnabled(v: boolean): void {
  enabled = v;
}

export function isTransformTriggerEnabled(): boolean {
  return enabled;
}

let callback: MutationCallback | null = null;
const refCount = new Map<Element, number>();

// SVG uses a `transform` presentation attribute; CSS transforms live in `style`.
// Watch both so a transformed <g>/<svg> ancestor is covered too.
const ATTR_FILTER = ['style', 'transform'];

// Harness-only fire counter: proves the observer fired on a tracked ancestor's
// transform mutation (independent of whether badges also moved via other
// triggers). Mirrored to <html data-bk-transform-fires> for page-side probes.
let fireCount = 0;
const observer = typeof MutationObserver !== 'undefined'
  ? new MutationObserver(() => {
      fireCount++;
      // Page-visible diagnostic (harness builds only, same class as data-bk-accel).
      if (harnessHooksEnabled()) {
        try { document.documentElement.dataset.bkTransformFires = String(fireCount); } catch { /* no doc */ }
      }
      callback?.();
    })
  : null;

export function onTransformAncestorMutation(cb: MutationCallback): void {
  callback = cb;
}

export function trackTransformAncestor(ancestor: Element): void {
  const prev = refCount.get(ancestor) ?? 0;
  refCount.set(ancestor, prev + 1);
  if (prev === 0) {
    observer?.observe(ancestor, { attributes: true, attributeFilter: ATTR_FILTER });
  }
}

export function untrackTransformAncestor(ancestor: Element): void {
  const prev = refCount.get(ancestor) ?? 0;
  if (prev <= 1) {
    refCount.delete(ancestor);
    // MutationObserver has no per-target unobserve; rebuild the observation set
    // by disconnecting and re-observing everything still refcounted. Cheap: the
    // transformed-ancestor set is tiny (one canvas viewport, not per-badge).
    observer?.disconnect();
    for (const el of refCount.keys()) {
      observer?.observe(el, { attributes: true, attributeFilter: ATTR_FILTER });
    }
  } else {
    refCount.set(ancestor, prev - 1);
  }
}

export const __testing = {
  reset(): void {
    refCount.clear();
    callback = null;
    enabled = false;
    observer?.disconnect();
  },
  getRefCount(ancestor: Element): number {
    return refCount.get(ancestor) ?? 0;
  },
  fire(): void {
    callback?.();
  },
};
