/**
 * Per-target MutationObserver for anchor-name self-heal.
 *
 * Single load-bearing job: detect when a re-rendering host (YouTube
 * comments/player rewrite a target's inline `style` ~10x/sec) clobbers the
 * `anchor-name` we injected, and re-assert it synchronously before paint
 * so the badge never visibly unbinds. See the callback in content.ts
 * (`onTargetMutation`) — the relevant signal is exclusively a `style`
 * attribute change on the target itself.
 *
 * Scope intentionally narrow: `{ attributes: true, attributeFilter: ['style'] }`.
 *   - No `subtree: true`: descendant churn on dynamic pages (Google SERPs
 *     have ~95 wrappers wrapping ads/widgets that mutate constantly) blew
 *     this up to 16M fires / 160s CPU on a single tab, tripping Firefox's
 *     slow-extension warning. None of those fires were anchor-name
 *     clobbers, and target-position changes from descendants are already
 *     caught by `container-resize-tracker` (resize) and the doc-level
 *     `visibilityMO` (class/style anywhere in doc).
 *   - No `childList: true`: the callback doesn't use childList records.
 *   - Filter to `style` only: `class` and other attribute churn don't
 *     clobber inline anchor-name. The doc-level moCallback handles
 *     hintability-affecting attributes already.
 *
 * Self-mutation filter: skips records whose touched nodes are all
 * `data-branchkit-hint` hosts. Badges mount in the target's *container*
 * not in the target itself, so this is defensive; cheap to filter and
 * future-proofs against adapters that mount differently.
 *
 * Lifetime: tracked per HintBadge, observe on construct / disconnect on
 * remove. Per-target MO instances (not a shared one) so disconnect is
 * clean — there's no `MutationObserver.unobserve(target)`.
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
    // Callback-rate + cost tripwire. Records every invocation (including
    // self-mutation-filtered ones) so a regression to a wide observation
    // scope re-appears in the perf trail. The 2026-06-01 measurement that
    // surfaced 16M fires / 160s CPU on Google SERPs (when subtree:true was
    // still on) is the canonical "this bucket is hot, look here" signal.
    // Reported via the global recorder content.ts wires up (see
    // __branchkitRecordCpu); no-op in tests / early boot when the recorder
    // isn't present.
    const __t0 = performance.now();
    if (!isAllOwn(records)) callback?.(target);
    const rec = (globalThis as { __branchkitRecordCpu?: (label: string, ms: number) => void }).__branchkitRecordCpu;
    if (rec) rec('targetMutation:callback', performance.now() - __t0);
  });
  observer.observe(target, { attributes: true, attributeFilter: ['style'] });
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
