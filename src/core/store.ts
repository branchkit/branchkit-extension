import { WrapperStore, ElementWrapper } from '../scan/element-wrapper';

/**
 * The single source of truth for this frame's hintable elements.
 *
 * Promoted out of content.ts module scope (Tier 0 of
 * notes/DESIGN_EXTENSION_RESTRUCTURE.md) so sources and reactions import the
 * same instance instead of reaching into the monolith.
 *
 * Tier 2 (the delta cut): the store now emits a delta on every wrapper-set
 * mutation. Reactions (grammar-sync, render) subscribe instead of being poked
 * imperatively from ~50 call sites — turning the lifecycle/grammar/render cycle
 * into a one-way flow (source → store → reaction). The emitter lands here first
 * with no subscribers (deltas are inert); subscribers are wired next, then the
 * imperative calls are deleted.
 */

export type WrapperDelta =
  | { kind: 'attached'; wrapper: ElementWrapper }
  | { kind: 'detached'; wrapper: ElementWrapper }
  | { kind: 'rebound'; wrapper: ElementWrapper; from: Element };

export type WrapperDeltaListener = (delta: WrapperDelta) => void;

/**
 * WrapperStore that emits a delta whenever the wrapper set actually changes.
 * Emission is guarded on real mutations (addWrapper is a no-op for a duplicate
 * element; removeWrapperByElement is a no-op when nothing was tracked), so a
 * subscriber sees one delta per real attach/detach/rebind. Emission is
 * synchronous (inside the mutator) — subscribers debounce their own outputs, so
 * batching at the store would add nothing.
 */
export class ObservableWrapperStore extends WrapperStore {
  private listeners: WrapperDeltaListener[] = [];

  subscribe(fn: WrapperDeltaListener): void {
    this.listeners.push(fn);
  }

  private emit(delta: WrapperDelta): void {
    for (const fn of this.listeners) fn(delta);
  }

  override addWrapper(w: ElementWrapper): void {
    // Only emit if the add actually happened (not a duplicate no-op).
    if (this.findWrapperFor(w.element)) return;
    super.addWrapper(w);
    this.emit({ kind: 'attached', wrapper: w });
  }

  override removeWrapperByElement(el: Element): ElementWrapper | undefined {
    const removed = super.removeWrapperByElement(el);
    if (removed) this.emit({ kind: 'detached', wrapper: removed });
    return removed;
  }

  override rebindElement(oldEl: Element, newEl: Element, wrapper: ElementWrapper): void {
    super.rebindElement(oldEl, newEl, wrapper);
    this.emit({ kind: 'rebound', wrapper, from: oldEl });
  }
}

export const store = new ObservableWrapperStore();
