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

interface PausableRecord {
  fn: () => void;
  ms: number;
  /** Live interval id while armed; null while paused (or registered-while-paused). */
  id: ReturnType<typeof setInterval> | null;
}

export class SessionResources {
  private listeners: ListenerRecord[] = [];
  private intervals = new Set<ReturnType<typeof setInterval>>();
  private timeouts = new Set<ReturnType<typeof setTimeout>>();
  private rafs = new Set<number>();
  private observers = new Set<Disconnectable>();
  private pausables = new Set<PausableRecord>();
  private isPaused = false;

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

  /**
   * `setInterval` that additionally stops across `pause()`/`resume()` — for
   * the continuous per-frame costs that should quiesce while the tab is
   * hidden (limbo finalize sweep, watchdog tick, perf publishers). Registered
   * while paused, it stays unarmed until `resume()`. Covered by
   * `teardownAll()` like everything else, and teardown is final: a torn-down
   * registry has nothing left for `resume()` to re-arm.
   *
   * This is the registry-level replacement for per-callback
   * `document.visibilityState` gates: the gate ran the wakeup and then
   * discarded the work, so N accumulated hidden tabs still paid N timer
   * wakeups/interval; pausing stops the wakeups themselves
   * (notes/INVESTIGATION_LONG_SESSION_PERF.md, review backlog).
   */
  pausableInterval(fn: () => void, ms: number): void {
    const rec: PausableRecord = { fn, ms, id: null };
    if (!this.isPaused) rec.id = setInterval(fn, ms);
    this.pausables.add(rec);
  }

  /** Stop every pausable interval (tab hidden). Idempotent. */
  pause(): void {
    if (this.isPaused) return;
    this.isPaused = true;
    for (const rec of this.pausables) {
      if (rec.id !== null) {
        clearInterval(rec.id);
        rec.id = null;
      }
    }
  }

  /** Re-arm every pausable interval (tab visible again). Idempotent; a no-op
   *  after `teardownAll()` since teardown empties the registry. */
  resume(): void {
    if (!this.isPaused) return;
    this.isPaused = false;
    for (const rec of this.pausables) {
      rec.id = setInterval(rec.fn, rec.ms);
    }
  }

  /** Whether `pause()` is in effect — for tests and the debug snapshot. */
  get paused(): boolean {
    return this.isPaused;
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
    for (const rec of this.pausables) {
      if (rec.id !== null) { try { clearInterval(rec.id); } catch { /* idempotent */ } }
      rec.id = null;
    }
    this.pausables.clear();
  }

  /** Live counts of registered resources — for tests and the debug snapshot. */
  get counts(): {
    listeners: number;
    intervals: number;
    timeouts: number;
    rafs: number;
    observers: number;
    pausables: number;
  } {
    return {
      listeners: this.listeners.length,
      intervals: this.intervals.size,
      timeouts: this.timeouts.size,
      rafs: this.rafs.size,
      observers: this.observers.size,
      pausables: this.pausables.size,
    };
  }
}
