/**
 * Option 3 (notes/DESIGN_HINT_POSITIONING_REARCH.md): a batched reconcile that
 * pins each registered badge host to its target by reading the live target rect
 * and writing a composited `transform`. This is the pure-JS positioning model
 * that would replace CSS Anchor Positioning (and the Firefox nesting path) under
 * the `bkJsPosition` flag.
 *
 * Batching is the whole point: read ALL target rects first (one forced reflow
 * per pass when layout is dirty — clean reads are cached), THEN write ALL
 * transforms (composited, no reflow). The C3 measurement (design note) showed
 * this is reflow-dominated and ~independent of N, so a pass over the visible
 * badge set is well within the frame budget.
 *
 * Cadence is owned by the CALLER (content.ts), not this module — there is no
 * self-scheduling rAF here. content.ts drives `reconcilePass()` two ways:
 *   - the settle handlers' shared 100ms-debounce + rAF single-flight, for
 *     mutation/resize/layout changes; and
 *   - a scroll-active rAF loop that runs per-frame only while scroll events are
 *     arriving (reconcile hosts are position:fixed and do NOT ride the
 *     compositor, so they must be re-pinned each frame during scroll).
 *
 * The viewport gate is implicit: `reconcileRead()` short-circuits on a hidden
 * badge BEFORE any getBoundingClientRect, and a wrapper that leaves the viewport
 * goes dormant (its badge is hidden), so off-screen badges cost only a property
 * check per pass — the perf intent of an IntersectionObserver gate without
 * coupling this module to wrapper state.
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

export function register(b: ReconcileBadge): void {
  registry.add(b);
}

export function unregister(b: ReconcileBadge): void {
  registry.delete(b);
}

export function reconcileRegistrySize(): number {
  return registry.size;
}

/**
 * Drop every registered badge in one shot. Orphan/navigate/unload teardown
 * (content.ts `quiesceOrphan`) removes badge hosts via a raw DOM sweep that
 * bypasses `HintBadge.remove()` — the only per-badge `unregister` site — so
 * without this the registry would retain dead badges and a subsequent
 * settle/scroll pass could iterate (and reflow) detached frames.
 */
export function drain(): void {
  registry.clear();
}

/**
 * One batched reconcile pass: read all target rects (Phase 1), then write all
 * composited transforms (Phase 2). Pure and synchronous — the caller decides
 * when it runs. A no-op when nothing is registered (flag off), and cheap for
 * hidden/off-screen badges (`reconcileRead` short-circuits before gBCR).
 */
export function reconcilePass(): void {
  if (registry.size === 0) return;
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
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
  if (rec && t0) rec('reconcilePositioner:tick', performance.now() - t0);
}
