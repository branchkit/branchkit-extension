/**
 * BranchKit Browser — mutation relevance gate (settle-trigger scoping).
 *
 * notes/DESIGN_SETTLE_TRIGGER_SCOPING.md: the idle-storm diagnosis showed a
 * cosmetic page tick (Gmail's `T-aT4-Mp` widget, style write + child churn
 * every ~505ms) costing two full settle pipelines per tick, forever. The
 * observers' job is to notice changes that can affect TRACKED state — a
 * wrapper's visibility/geometry or a parked candidate's reveal. A mutation
 * whose nodes neither contain nor sit inside any tracked element can shift
 * layout (the positioner pass handles that) but cannot change what a settle
 * derives, so it should not buy one.
 *
 * Containment is composed-tree in both directions (occlusion's
 * `composedContains`): an ancestor class flip must reach a shadow-hosted
 * wrapper, and a flip on a node inside a wrapper counts too. Own badge
 * hosts are excluded — a `data-branchkit-hint` subtree is never a page
 * reveal. Batches with many distinct nodes pass automatically: real reveals
 * and route swaps mutate broadly, and the gate must stay far cheaper than
 * the settle it gates.
 */

import { composedContains } from './occlusion';

/** Distinct mutated nodes examined before the gate passes automatically.
 * Idle-tick batches carry 1-2 distinct nodes; route swaps carry dozens. */
const DISTINCT_NODE_CAP = 8;

function isOwnBadgeNode(n: Element): boolean {
  return n.hasAttribute('data-branchkit-hint');
}

/**
 * True when any mutated node in `records` is, contains, or is contained by
 * a tracked element. For childList records the mutated nodes are the
 * added/removed nodes themselves (an untracked sibling's removal under a
 * shared parent reflows layout — positioner territory — but cannot change
 * tracked state); for attribute records the node is the target.
 *
 * `trackedSets` are lazy iterables so callers pass live sets/generators
 * without per-batch array allocation. Returns true (fail open) when the
 * batch is large or heterogeneous — the cap bounds gate cost, and passing
 * through is exactly today's behavior.
 */
export function mutationTouchesTracked(
  records: MutationRecord[],
  trackedSets: Array<Iterable<Element>>,
): boolean {
  const nodes: Element[] = [];
  let capped = false;
  const collect = (n: Node): void => {
    if (capped || !(n instanceof Element) || isOwnBadgeNode(n)) return;
    if (!nodes.includes(n)) {
      if (nodes.length >= DISTINCT_NODE_CAP) {
        capped = true;
        return;
      }
      nodes.push(n);
    }
  };
  for (const m of records) {
    if (m.type === 'childList') {
      for (const n of m.addedNodes) collect(n);
      for (const n of m.removedNodes) collect(n);
    } else {
      collect(m.target);
    }
    if (capped) return true;
  }
  if (nodes.length === 0) return false;
  for (const n of nodes) {
    for (const set of trackedSets) {
      for (const el of set) {
        if (composedContains(n, el) || composedContains(el, n)) return true;
      }
    }
  }
  return false;
}
