// Viewport-scoped attention observer.
//
// Wraps an IntersectionObserver with a wide rootMargin so candidates
// outside the "attention region" (default: 2 viewport-heights above
// and below the visible area) are never observed beyond a single IO
// subscription. Drives wrapper attach/detach + invisible-candidate
// observation, replacing the open-loop "attach everything in DOM
// and hold forever" lifecycle that grew pendingVisibility to 8,081
// elements on YouTube comment pages.
//
// Per DESIGN_OBSERVER_DRIVEN_LAYOUT.md: this is the lifecycle axis of
// the observer-driven model. Positioning axis (TargetRectStore) is a
// later phase.
//
// Distinct from IntersectionTracker (narrow-margin IO for codeword
// claim/release). Two IOs by deliberate choice — different concerns
// (you-are-a-candidate vs you-are-interactive), different margins,
// different lifecycles. Same element gets observed by both while
// inside the attention region.

export interface AttentionEvents {
  onEnter: (element: Element) => void;
  onLeave: (element: Element) => void;
  // Fired for every IO entry, regardless of intersection-state change.
  // Used by the layout-rect store (Phase 3) to keep cached rects warm
  // without forcing layout reads. The IO entry's boundingClientRect is
  // populated by the engine as part of producing this entry; reading it
  // here is free.
  onRect?: (element: Element, rect: DOMRectReadOnly) => void;
}

const ATTENTION_ROOT_MARGIN = '200%';

export class AttentionObserver {
  private io: IntersectionObserver;
  private events: AttentionEvents;
  // Tracks intersection state per observed element. IO entries arrive
  // for both transitions; we only fire enter/leave on actual change.
  private intersecting: WeakSet<Element> = new WeakSet();

  constructor(events: AttentionEvents) {
    this.events = events;
    this.io = new IntersectionObserver(this.handleEntries, {
      root: null,
      rootMargin: ATTENTION_ROOT_MARGIN,
      threshold: 0,
    });
  }

  observe(element: Element): void {
    this.io.observe(element);
  }

  unobserve(element: Element): void {
    this.io.unobserve(element);
    this.intersecting.delete(element);
  }

  disconnect(): void {
    this.io.disconnect();
    this.intersecting = new WeakSet();
  }

  private handleEntries = (entries: IntersectionObserverEntry[]): void => {
    for (const entry of entries) {
      const el = entry.target;
      const was = this.intersecting.has(el);
      const is = entry.isIntersecting;
      if (is && !was) {
        this.intersecting.add(el);
        // Phase 3 shadow: only cache rects for elements actually in the
        // attention region. Far-below candidates that fire a single
        // not-intersecting entry get unobserved (below) without ever
        // being written to the store — avoids accumulating tens of
        // thousands of stale rects on infinite-scroll pages.
        if (this.events.onRect) this.events.onRect(el, entry.boundingClientRect);
        this.events.onEnter(el);
      } else if (!is && was) {
        this.intersecting.delete(el);
        this.events.onLeave(el);
      } else if (!is && !was) {
        // First entry for a not-intersecting element (or an element
        // that's been not-intersecting and just fired again). Use the
        // IO's own boundingClientRect — the engine computed it as part
        // of producing this entry, so reading it is free — to evict
        // candidates that are way outside any plausible attention
        // region. Without this, every `discoverInSubtree` call leaks
        // an IO subscription for every selector-matching ref below the
        // fold, accumulating over an infinite-scroll session.
        const rect = entry.boundingClientRect;
        const vh = window.innerHeight || 1;
        const farBelow = rect.top > vh * FAR_THRESHOLD_VH;
        const farAbove = rect.bottom < -vh * FAR_THRESHOLD_VH;
        if (farBelow || farAbove) {
          this.io.unobserve(el);
        }
      }
    }
  };
}

// Elements more than this many viewport-heights outside the visible
// area get unobserved. Set well past the 2-viewport attention margin so
// we don't evict candidates the user might soon scroll to. Re-discovery
// happens via the normal MO childList path when YouTube/etc. re-renders
// a scrolled-past region (rare but possible). For static far-away
// content, eviction is permanent — but those elements were never going
// to be hinted anyway.
const FAR_THRESHOLD_VH = 5;
