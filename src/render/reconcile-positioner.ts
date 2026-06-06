/**
 * Option 3 spike (notes/DESIGN_HINT_POSITIONING_REARCH.md): a single batched
 * rAF reconcile that pins each registered badge host to its target by reading
 * the live target rect and writing a composited `transform`. This is the
 * pure-JS positioning model that would replace CSS Anchor Positioning (and the
 * Firefox nesting path) under the `bkJsPosition` flag.
 *
 * Batching is the whole point: read ALL target rects first (one forced reflow
 * per pass when layout is dirty — clean reads are cached), THEN write ALL
 * transforms (composited, no reflow). The C3 measurement (design note) showed
 * this is reflow-dominated and ~independent of N, so a per-frame pass over the
 * visible badge set is well within the frame budget.
 *
 * Spike scope: runs a continuous rAF while any badge is registered. A
 * production version would gate the cadence to scroll/mutation/settle and an
 * explicit IntersectionObserver viewport set rather than relying on each
 * badge's `isVisible`. Kept simple here to validate the mechanism.
 */

export interface ReconcileWrite {
  host: HTMLElement;
  x: number;
  y: number;
}

export interface ReconcileBadge {
  // Read-only half: read the target rect + baked offset and return the host +
  // desired viewport coords WITHOUT writing, so the reconciler can batch all
  // reads before any writes. Returns null when the badge shouldn't be placed
  // this pass (hidden, disconnected target, no baked offset yet).
  reconcileRead(): ReconcileWrite | null;
}

const registry = new Set<ReconcileBadge>();
let rafId: number | null = null;

export function register(b: ReconcileBadge): void {
  registry.add(b);
  start();
}

export function unregister(b: ReconcileBadge): void {
  registry.delete(b);
  if (registry.size === 0) stop();
}

export function reconcileRegistrySize(): number {
  return registry.size;
}

function start(): void {
  if (rafId !== null || typeof requestAnimationFrame !== 'function') return;
  rafId = requestAnimationFrame(tick);
}

function stop(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function tick(): void {
  rafId = null;
  if (registry.size === 0) return;
  const __t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  // Phase 1 — batched reads (gBCR). One forced reflow per pass if layout is dirty.
  const writes: ReconcileWrite[] = [];
  for (const b of registry) {
    const w = b.reconcileRead();
    if (w) writes.push(w);
  }
  // Phase 2 — batched composited writes. transform does not dirty layout, so
  // this can't re-trigger reflow between entries.
  for (const w of writes) {
    w.host.style.transform = `translate(${w.x}px,${w.y}px)`;
  }
  const rec = (globalThis as { __branchkitRecordCpu?: (label: string, ms: number) => void }).__branchkitRecordCpu;
  if (rec && __t0) rec('reconcilePositioner:tick', performance.now() - __t0);
  // Keep following while anything is registered — the page may scroll/mutate
  // on any frame. (Production: gate to scroll/mutation/settle instead.)
  start();
}
