/**
 * Shared scroll listeners for inner overflow-scroll panes holding hint targets.
 *
 * The window `scroll` listener in content.ts only fires for the document
 * scroller — `scroll` does not bubble, so when an *inner* overflow container
 * scrolls (a comment pane, a sidebar, a virtualized list) the window handler
 * never runs and the engine's known rects for targets inside that pane go
 * stale. On the nesting path the badge host rides the container's compositor
 * so it still tracks *visually*, but TargetRectStore — the observer-warmed
 * rect cache the positioning cutover reads from — is left stale.
 *
 * This tracker closes that gap (DESIGN_OBSERVER_DRIVEN_LAYOUT Phase 5b). Each
 * nesting-path badge registers its target under the target's nearest scrollable
 * ancestor. One passive `scroll` listener per unique container fans a scroll
 * out to the wired callback with that container's live target set, coalesced to
 * one batch per animation frame across all containers that scrolled.
 *
 * Refcount by target: many targets share one container (every comment in a
 * thread). The listener is added on the first target and removed with the last.
 */

type ScrollCallback = (targets: Iterable<Element>) => void;

let callback: ScrollCallback | null = null;
const targetsByContainer = new Map<Element, Set<Element>>();
const listeners = new Map<Element, EventListener>();
const dirty = new Set<Element>();
let rafPending = false;
let rafId = 0;
let fires = 0; // scroll events received (debug/telemetry)
let flushes = 0; // rAF-coalesced callback invocations

export function onScrollAncestor(cb: ScrollCallback): void {
  callback = cb;
}

function flush(): void {
  rafPending = false;
  const batch = new Set<Element>();
  for (const container of dirty) {
    const set = targetsByContainer.get(container);
    if (set) for (const el of set) batch.add(el);
  }
  dirty.clear();
  if (batch.size > 0) { flushes++; callback?.(batch); }
}

function schedule(container: Element): void {
  fires++;
  dirty.add(container);
  if (rafPending) return;
  rafPending = true;
  rafId = requestAnimationFrame(flush);
}

export function trackScrollAncestor(container: Element, target: Element): void {
  let set = targetsByContainer.get(container);
  if (!set) {
    set = new Set();
    targetsByContainer.set(container, set);
    const listener: EventListener = () => schedule(container);
    listeners.set(container, listener);
    container.addEventListener('scroll', listener, { passive: true });
  }
  set.add(target);
}

export function untrackScrollAncestor(container: Element, target: Element): void {
  const set = targetsByContainer.get(container);
  if (!set) return;
  set.delete(target);
  if (set.size === 0) {
    targetsByContainer.delete(container);
    const listener = listeners.get(container);
    if (listener) container.removeEventListener('scroll', listener);
    listeners.delete(container);
    dirty.delete(container);
  }
}

/** Live registration stats for the perf snapshot: how many distinct inner
 *  scroll panes we listen on and how many targets they cover. Confirms
 *  findScrollAncestor is actually catching inner panes in the wild. */
export function scrollAncestorStats(): { containers: number; targets: number; fires: number; flushes: number } {
  let targets = 0;
  for (const set of targetsByContainer.values()) targets += set.size;
  return { containers: targetsByContainer.size, targets, fires, flushes };
}

/** All targets currently registered under an inner scroll pane. The drift
 *  sampler scopes to these to confirm the store stays warm for the population
 *  inner-pane scroll is supposed to keep fresh. */
export function* registeredScrollTargets(): Generator<Element> {
  for (const set of targetsByContainer.values()) yield* set;
}

export const __testing = {
  reset(): void {
    for (const [container, listener] of listeners) {
      container.removeEventListener('scroll', listener);
    }
    targetsByContainer.clear();
    listeners.clear();
    dirty.clear();
    if (rafPending) cancelAnimationFrame(rafId);
    rafPending = false;
    callback = null;
  },
  containerCount(): number {
    return targetsByContainer.size;
  },
  targetCount(container: Element): number {
    return targetsByContainer.get(container)?.size ?? 0;
  },
  simulateScroll(container: Element): void {
    listeners.get(container)?.(new Event('scroll'));
  },
  // Run the pending rAF-coalesced batch synchronously (rAF is awkward to drive
  // in unit tests; production uses the real frame callback).
  flushNow(): void {
    if (rafPending) {
      cancelAnimationFrame(rafId);
      flush();
    }
  },
};
