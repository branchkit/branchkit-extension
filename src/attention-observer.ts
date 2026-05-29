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
        this.events.onEnter(el);
      } else if (!is && was) {
        this.intersecting.delete(el);
        this.events.onLeave(el);
      } else if (!is && !was) {
        // First entry for a not-intersecting element. Use the IO's own
        // boundingClientRect (engine-warm, free to read) to evict
        // candidates that sit way outside any plausible attention
        // region — prevents `discoverInSubtree` from leaking an IO
        // subscription per selector-matching ref below the fold.
        // Threshold sits well past the 2-viewport attention margin so
        // we don't evict elements the user might soon scroll to.
        const rect = entry.boundingClientRect;
        const vh = window.innerHeight || 1;
        const farBelow = rect.top > vh * FAR_THRESHOLD_VH;
        const farAbove = rect.bottom < -vh * FAR_THRESHOLD_VH;
        if (farBelow || farAbove) this.io.unobserve(el);
      }
    }
  };
}

const FAR_THRESHOLD_VH = 5;
