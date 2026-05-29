// Observer-driven layout: rect cache + subscriber registry.
//
// Per DESIGN_OBSERVER_DRIVEN_LAYOUT.md Phase 3. The store holds the
// engine's latest known rect for each tracked target, written when an
// observer (IntersectionObserver or ResizeObserver) fires for that
// target — never on demand from event handlers. Subscribers receive a
// notify when the rect changes; `read()` returns the cached rect.
//
// Why "rect from observer entry": IntersectionObserverEntry.boundingClientRect
// is populated by the engine at the moment of the layout change that
// triggered the entry. Reading it costs nothing extra (the engine
// already has it warm). The blanket scroll-driven `updatePosition` sweep
// today calls `getBoundingClientRect()` per badge per frame — that's a
// forced layout per call. Replacing it with subscriber notifications
// from this store eliminates the forced reads.
//
// Shadow phase: in this commit the store is *written* by attention IO
// and tracker IO entries (Phase 3 — parallel path), but no production
// read path consumes it yet. The comparator below samples a few stored
// rects vs live `getBoundingClientRect` per interval to detect drift —
// validates the model before Phase 4 cuts `updatePosition` over.

export type RectSubscriber = (rect: DOMRectReadOnly) => void;

export class TargetRectStore {
  private rects: Map<Element, DOMRectReadOnly> = new Map();
  private subs: Map<Element, Set<RectSubscriber>> = new Map();

  /** Returns the engine's last-known rect for `el`, or undefined. */
  read(el: Element): DOMRectReadOnly | undefined {
    return this.rects.get(el);
  }

  /** Records a new rect; notifies any subscribers for this element. */
  write(el: Element, rect: DOMRectReadOnly): void {
    this.rects.set(el, rect);
    const set = this.subs.get(el);
    if (set) for (const cb of set) cb(rect);
  }

  /** Drops cache + subscribers for an element. Call on wrapper detach. */
  evict(el: Element): void {
    this.rects.delete(el);
    this.subs.delete(el);
  }

  /** Returns an unsubscribe function. */
  subscribe(el: Element, cb: RectSubscriber): () => void {
    let set = this.subs.get(el);
    if (!set) { set = new Set(); this.subs.set(el, set); }
    set.add(cb);
    return () => {
      const s = this.subs.get(el);
      if (s) {
        s.delete(cb);
        if (s.size === 0) this.subs.delete(el);
      }
    };
  }

  get size(): number { return this.rects.size; }
  get subscriberCount(): number {
    let n = 0;
    for (const set of this.subs.values()) n += set.size;
    return n;
  }

  /** Sample-based drift detector. Walks up to `limit` elements, compares
   *  the cached rect to a fresh `getBoundingClientRect`. Used by the
   *  shadow-phase validator — must not run in production hot paths
   *  (each comparison forces a layout). Returns drift stats. */
  sampleDrift(limit: number): { sampled: number; drifted: number; maxDriftPx: number } {
    let sampled = 0;
    let drifted = 0;
    let maxDriftPx = 0;
    for (const [el, cached] of this.rects) {
      if (sampled >= limit) break;
      if (!el.isConnected) continue;
      sampled++;
      const live = el.getBoundingClientRect();
      const dx = Math.abs(live.left - cached.left);
      const dy = Math.abs(live.top - cached.top);
      const max = Math.max(dx, dy);
      if (max > 1) {
        drifted++;
        if (max > maxDriftPx) maxDriftPx = max;
      }
    }
    return { sampled, drifted, maxDriftPx };
  }
}
