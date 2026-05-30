/**
 * Shared ResizeObserver for hint badge anchor containers.
 *
 * Window scroll/resize and the document-level MutationObserver don't see
 * layout shifts that are CSS-only or scoped inside a single container —
 * a sibling row expanding, a :focus-within rule resizing a parent, an
 * animated dropdown reflowing its column. Without this layer, badges
 * stay pinned to stale viewport coords until the next global trigger.
 *
 * Each HintBadge registers its anchor container here; the callback wired
 * by content.ts forwards to scheduleReposition().
 *
 * Refcount: many badges can share a container (every button in a row
 * lands in the same ancestor). observe() is idempotent on the same
 * target, so the refcount only governs unobserve — keep the
 * observation alive until the last badge leaves.
 *
 * Initial-fire skip: ResizeObserver fires once per target the moment
 * it's observed. Forwarding that would reposition-storm on every badge
 * mount. Track first-fire per target and drop it.
 */

type ResizeCallback = () => void;

let callback: ResizeCallback | null = null;
const refCount = new Map<Element, number>();
const seen = new Set<Element>();

const observer = typeof ResizeObserver !== 'undefined'
  ? new ResizeObserver((entries) => {
      let shouldFire = false;
      for (const entry of entries) {
        if (seen.has(entry.target)) {
          shouldFire = true;
        } else {
          seen.add(entry.target);
        }
      }
      if (shouldFire) callback?.();
    })
  : null;

export function onContainerResize(cb: ResizeCallback): void {
  callback = cb;
}

export function trackContainerResize(container: Element): void {
  const prev = refCount.get(container) ?? 0;
  refCount.set(container, prev + 1);
  if (prev === 0) observer?.observe(container);
}

export function untrackContainerResize(container: Element): void {
  const prev = refCount.get(container) ?? 0;
  if (prev <= 1) {
    refCount.delete(container);
    // Clear first-fire memory so a re-register later behaves like a
    // fresh observation (RO re-fires the initial entry on re-observe).
    seen.delete(container);
    observer?.unobserve(container);
  } else {
    refCount.set(container, prev - 1);
  }
}

export const __testing = {
  reset(): void {
    refCount.clear();
    seen.clear();
    callback = null;
  },
  getRefCount(container: Element): number {
    return refCount.get(container) ?? 0;
  },
  simulateResize(targets: Element[]): void {
    let shouldFire = false;
    for (const target of targets) {
      if (seen.has(target)) {
        shouldFire = true;
      } else {
        seen.add(target);
      }
    }
    if (shouldFire) callback?.();
  },
};
