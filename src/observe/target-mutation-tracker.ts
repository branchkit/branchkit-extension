/**
 * Per-target MutationObserver for hinted elements.
 *
 * The doc-level MutationObserver in content.ts watches `body` with a small
 * attributeFilter (the set of attributes that flip hintability). Changes
 * outside that filter — `class`, `style`, CSS custom properties, data
 * attributes, subtree edits — don't fire it. The container ResizeObserver
 * catches the resulting size changes, but layout shifts that *move* a
 * target without resizing its container slip through.
 *
 * This module fills that gap: each badge's target gets its own
 * MutationObserver with `{attributes, childList, subtree}` (no
 * attributeFilter — the whole point is the long tail). On any foreign
 * mutation, fire the registered callback so content.ts can schedule a
 * deferred reposition. Matches Rango's targetsMutationObserver.
 *
 * Lifetime: tracked per HintBadge, observe on construct / disconnect on
 * remove. Per-target MO instances (not a shared one) so disconnect is
 * clean — there's no `MutationObserver.unobserve(target)`.
 *
 * Self-mutation filter: skips records whose touched nodes are all
 * `data-branchkit-hint` hosts. Badges mount in the target's *container*
 * not in the target itself, so this is defensive; cheap to filter and
 * future-proofs against adapters that mount differently.
 */

type TargetMutationCallback = (target: Element) => void;

let callback: TargetMutationCallback | null = null;
const observers = new Map<Element, MutationObserver>();

function isOwnNode(node: Node): boolean {
  return node instanceof Element && node.hasAttribute('data-branchkit-hint');
}

export function isAllOwn(records: MutationRecord[]): boolean {
  for (const r of records) {
    if (r.type === 'attributes') {
      if (!isOwnNode(r.target)) return false;
    } else {
      for (const n of r.addedNodes) if (!isOwnNode(n)) return false;
      for (const n of r.removedNodes) if (!isOwnNode(n)) return false;
    }
  }
  return true;
}

export function onTargetMutation(cb: TargetMutationCallback): void {
  callback = cb;
}

export function trackTargetMutations(target: Element): void {
  if (typeof MutationObserver === 'undefined') return;
  if (observers.has(target)) return;
  const observer = new MutationObserver((records) => {
    if (isAllOwn(records)) return;
    callback?.(target);
  });
  observer.observe(target, { attributes: true, childList: true, subtree: true });
  observers.set(target, observer);
}

export function untrackTargetMutations(target: Element): void {
  const observer = observers.get(target);
  if (!observer) return;
  observer.disconnect();
  observers.delete(target);
}

export const __testing = {
  reset(): void {
    for (const o of observers.values()) o.disconnect();
    observers.clear();
    callback = null;
  },
  isTracked(target: Element): boolean {
    return observers.has(target);
  },
  trackedCount(): number {
    return observers.size;
  },
};
