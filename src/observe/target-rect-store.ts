// Observer-driven layout: rect cache + subscriber registry.
//
// Per DESIGN_OBSERVER_DRIVEN_LAYOUT.md Phase 3. The store holds the
// engine's latest known rect for each tracked target, written when an
// observer (IntersectionObserver or ResizeObserver) fires for that
// target — never on demand from event handlers. Subscribers receive a
// notify when the rect changes; `read()` returns the cached rect.
//
// Shadow phase: in this commit the store is *written* by the attention
// IO's onRect (the engine-warm rect from each entry), but no production
// read path consumes it yet. The drift sampler in `buildPerfSnapshot`
// compares cached vs live rects on a small sample so we can see whether
// the store would have been correct, without driving any rendering.

export type RectSubscriber = (rect: DOMRectReadOnly) => void;

export class TargetRectStore {
  private rects: Map<Element, DOMRectReadOnly> = new Map();
  private subs: Map<Element, Set<RectSubscriber>> = new Map();

  read(el: Element): DOMRectReadOnly | undefined {
    return this.rects.get(el);
  }

  write(el: Element, rect: DOMRectReadOnly): void {
    this.rects.set(el, rect);
    const set = this.subs.get(el);
    if (set) for (const cb of set) cb(rect);
  }

  evict(el: Element): void {
    this.rects.delete(el);
    this.subs.delete(el);
  }

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

  /** Sample-based drift detector. Compares up to `limit` cached rects to
   *  fresh `getBoundingClientRect` reads. Each comparison forces a
   *  layout — call sparingly (once per snapshot at most). */
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

  /** Like sampleDrift but scoped to a caller-supplied target set — the
   *  population placement actually reads (painted badges). Used to verify the
   *  store stays warm for the targets the positioning cutover depends on,
   *  without the noise of in-band-but-unpainted entries the attention IO also
   *  writes. Forces a layout per sampled target — call sparingly. */
  sampleDriftFor(targets: Iterable<Element>, limit: number): { sampled: number; drifted: number; maxDriftPx: number } {
    let sampled = 0;
    let drifted = 0;
    let maxDriftPx = 0;
    for (const el of targets) {
      if (sampled >= limit) break;
      const cached = this.rects.get(el);
      if (!cached || !el.isConnected) continue;
      sampled++;
      const live = el.getBoundingClientRect();
      const max = Math.max(Math.abs(live.left - cached.left), Math.abs(live.top - cached.top));
      if (max > 1) {
        drifted++;
        if (max > maxDriftPx) maxDriftPx = max;
      }
    }
    return { sampled, drifted, maxDriftPx };
  }
}
