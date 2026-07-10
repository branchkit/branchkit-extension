/**
 * Session-owned resource registry — the ownership half of teardown
 * (notes/DESIGN_TEARDOWN_OWNERSHIP.md, Phase 2a).
 *
 * Every event listener, interval, timeout, rAF, and observer created through
 * these helpers is recorded, so `teardownAll()` stops the whole set with no
 * hand-maintained list. This couples "created" to "stopped" at one call site,
 * removing the silent-drift hazard that left onMessage, the intervals, and the
 * resurrection handlers firing into a dead session: the creation site IS the
 * registration, so the two cannot diverge.
 *
 * Deliberately does NOT touch the synchronous `sendMessage` throw. That
 * backpressure stays as defense-in-depth while the migration is partial (it
 * still catches anything not yet registered here), and only retires once every
 * resource flows through this registry — a separate, later decision (Phase 2b),
 * not this one.
 */

export interface Disconnectable {
  disconnect(): void;
}

interface ListenerRecord {
  target: EventTarget;
  type: string;
  handler: EventListenerOrEventListenerObject;
  options?: boolean | AddEventListenerOptions;
}

export class SessionResources {
  private listeners: ListenerRecord[] = [];
  private intervals = new Set<ReturnType<typeof setInterval>>();
  private timeouts = new Set<ReturnType<typeof setTimeout>>();
  private rafs = new Set<number>();
  private observers = new Set<Disconnectable>();

  /**
   * `addEventListener` that teardown removes. Pass the same handler reference
   * you would hand `removeEventListener` — an inline arrow is fine, since the
   * reference is captured here for the matching removal. Overloaded like
   * `addEventListener` so per-event typing is preserved (e.g. `pageshow` ->
   * `PageTransitionEvent`, `keydown` -> `KeyboardEvent`).
   */
  listen<K extends keyof WindowEventMap>(
    target: Window, type: K, handler: (ev: WindowEventMap[K]) => void, options?: boolean | AddEventListenerOptions,
  ): void;
  listen<K extends keyof DocumentEventMap>(
    target: Document, type: K, handler: (ev: DocumentEventMap[K]) => void, options?: boolean | AddEventListenerOptions,
  ): void;
  listen(
    target: EventTarget, type: string, handler: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions,
  ): void;
  listen(
    target: EventTarget,
    type: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: any,
    options?: boolean | AddEventListenerOptions,
  ): void {
    target.addEventListener(type, handler, options);
    this.listeners.push({ target, type, handler, options });
  }

  /** `setInterval` that teardown clears. */
  interval(fn: () => void, ms: number): ReturnType<typeof setInterval> {
    const id = setInterval(fn, ms);
    this.intervals.add(id);
    return id;
  }

  /** Stop a single interval created via `interval()` and forget it — for a
   *  sweeper that should pause before teardown (e.g. the limbo finalize sweep
   *  paused on hidden-tab suspend, restarted on resume). No-op if the id isn't
   *  registered; `teardownAll()` still covers everything else. */
  stopInterval(id: ReturnType<typeof setInterval>): void {
    if (this.intervals.delete(id)) clearInterval(id);
  }

  /** `setTimeout` that teardown clears; self-removes from the set when it fires
   *  so a long-lived session doesn't accumulate dead ids. */
  timeout(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const id = setTimeout(() => {
      this.timeouts.delete(id);
      fn();
    }, ms);
    this.timeouts.add(id);
    return id;
  }

  /** `requestAnimationFrame` that teardown cancels; self-removes when it fires. */
  raf(cb: FrameRequestCallback): number {
    const id = requestAnimationFrame((t) => {
      this.rafs.delete(id);
      cb(t);
    });
    this.rafs.add(id);
    return id;
  }

  /** Register an already-constructed observer (or anything disconnectable) so
   *  teardown disconnects it. Returns it for chaining at the construction site. */
  track<T extends Disconnectable>(observer: T): T {
    this.observers.add(observer);
    return observer;
  }

  /**
   * Stop every registered resource. Idempotent and never throws — each removal
   * is isolated so one failure can't skip the rest (the teardown constraint
   * from the retrospective).
   */
  teardownAll(): void {
    for (const l of this.listeners) {
      try { l.target.removeEventListener(l.type, l.handler, l.options); } catch { /* idempotent */ }
    }
    this.listeners = [];
    for (const id of this.intervals) { try { clearInterval(id); } catch { /* idempotent */ } }
    this.intervals.clear();
    for (const id of this.timeouts) { try { clearTimeout(id); } catch { /* idempotent */ } }
    this.timeouts.clear();
    for (const id of this.rafs) { try { cancelAnimationFrame(id); } catch { /* idempotent */ } }
    this.rafs.clear();
    for (const o of this.observers) { try { o.disconnect(); } catch { /* idempotent */ } }
    this.observers.clear();
  }

  /** Live counts of registered resources — for tests and the debug snapshot. */
  get counts(): {
    listeners: number;
    intervals: number;
    timeouts: number;
    rafs: number;
    observers: number;
  } {
    return {
      listeners: this.listeners.length,
      intervals: this.intervals.size,
      timeouts: this.timeouts.size,
      rafs: this.rafs.size,
      observers: this.observers.size,
    };
  }
}
