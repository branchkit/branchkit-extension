/**
 * BranchKit Browser — mutation relevance gate (settle-trigger scoping).
 *
 * notes/DESIGN_SETTLE_TRIGGER_SCOPING.md: the idle-storm diagnosis showed a
 * cosmetic page tick (Gmail's `T-aT4-Mp` widget, style write + child churn
 * every ~505ms) costing full settle pipelines per tick, forever. The
 * observers' job is to notice changes that can affect TRACKED state — a
 * wrapper's visibility/geometry or a parked candidate's reveal. This module
 * decides whether a mutation batch can possibly do that.
 *
 * The relevance rules, per mutated node n (composed-tree containment via
 * occlusion's `composedContains`, so shadow-hosted tracked elements count):
 *
 *   - n IS a tracked element → relevant (its own style/attrs changed).
 *   - n is an ANCESTOR of a tracked element → relevant, EXCEPT a `style`
 *     attribute record whose inline style (new or old value) never touches
 *     a visibility-affecting property: computed visibility flows from self
 *     + ancestors, so a width/transform tick on an ancestor progress bar
 *     cannot hide or reveal a descendant. `attributeOldValue` must be on
 *     for the old-value half (removing `display:none` IS a reveal).
 *   - n strictly INSIDE a tracked element → not relevant: a descendant flip
 *     can't change the tracked element's computed visibility, and the
 *     descendants it might reveal are tracked in their own right (then n is
 *     their ancestor). Size-collapse side effects (descendant hiding
 *     shrinking the tracked box) ride the ResizeObserver paths.
 *   - own badge hosts (`data-branchkit-hint`) are never page mutations.
 *
 * Batches with many distinct nodes pass automatically: real reveals and
 * route swaps mutate broadly, and the gate must stay far cheaper than the
 * settle it gates.
 */

import { composedContains } from './occlusion';

/** Distinct mutated nodes examined before the gate passes automatically.
 * Idle-tick batches carry 1-2 distinct nodes; route swaps carry dozens. */
const DISTINCT_NODE_CAP = 8;

/** Inline-style properties that can hide/reveal a subtree. `clip` also
 * matches clip-path. Deliberately NOT transform (scale(0) hiding is rare,
 * and geometry-based reveals ride the IntersectionObserver/ResizeObserver
 * paths); widening this list is cheap if a real page proves the need. */
const VIS_STYLE_RE = /(?:^|[;\s])(?:display|visibility|opacity|content-visibility|clip)\s*:/i;

function isOwnBadgeNode(n: Element): boolean {
  return n.hasAttribute('data-branchkit-hint');
}

function styleTouchesVisibility(el: Element, oldValue: string | null): boolean {
  const now = el.getAttribute('style') ?? '';
  return VIS_STYLE_RE.test(now) || (oldValue !== null && VIS_STYLE_RE.test(oldValue));
}

type Relation = 'tracked' | 'ancestor' | 'none';

function relateToTracked(n: Element, trackedSets: Array<Iterable<Element>>): Relation {
  let ancestor = false;
  for (const set of trackedSets) {
    for (const el of set) {
      if (el === n) return 'tracked';
      if (!ancestor && composedContains(n, el)) ancestor = true;
      // Strictly inside a tracked element: keep scanning — n could still be
      // the ancestor of (or identical to) another tracked element.
    }
  }
  return ancestor ? 'ancestor' : 'none';
}

/**
 * True when any mutated node in `records` can affect tracked state under
 * the rules above. For childList records the mutated nodes are the
 * added/removed nodes themselves (an untracked sibling's removal under a
 * shared parent reflows layout — positioner territory — but cannot change
 * tracked state); for attribute records the node is the target.
 *
 * `trackedSets` are lazy iterables so callers pass live sets/generators
 * without per-batch array allocation. Returns true (fail open) when the
 * batch is large or heterogeneous — the cap bounds gate cost, and passing
 * through is exactly the pre-gate behavior.
 */
export function mutationTouchesTracked(
  records: MutationRecord[],
  trackedSets: Array<Iterable<Element>>,
): boolean {
  const relCache = new Map<Element, Relation>();
  for (const m of records) {
    const nodes: Node[] = m.type === 'childList'
      ? [...m.addedNodes, ...m.removedNodes]
      : [m.target];
    for (const raw of nodes) {
      if (!(raw instanceof Element) || isOwnBadgeNode(raw)) continue;
      let rel = relCache.get(raw);
      if (rel === undefined) {
        if (relCache.size >= DISTINCT_NODE_CAP) return true;
        rel = relateToTracked(raw, trackedSets);
        relCache.set(raw, rel);
      }
      if (rel === 'none') continue;
      if (rel === 'tracked') return true;
      // Ancestor: a style tick that can't affect visibility is reflow
      // territory (the positioner's job), not settle territory.
      if (m.type === 'attributes' && m.attributeName === 'style'
        && !styleTouchesVisibility(raw, m.oldValue)) continue;
      return true;
    }
  }
  return false;
}
