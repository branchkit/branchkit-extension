/**
 * Is a Range's text still in the document?
 *
 * Extracted from render/range-badge-set.ts on 2026-07-27, when it turned out
 * the badge set was not the only consumer that needed it — and the one that
 * lacked it was walking corpses. See `isRangeDead`.
 */

/**
 * A Range does not rebind: once its nodes are removed it collapses and nothing
 * brings it back. Distinct from a merely COLLAPSED RECT, which a connected
 * range reports transiently (a hidden accordion) and which must NOT drop a
 * badge — that check lives with the band planner, not here.
 *
 * Element-derived the same way `rangeTarget` derives a badge's anchor, so
 * "dead" and "what the badge is pinned to" can't disagree — and because
 * Node.isConnected on a text node is not dependable across engines.
 */
export function isRangeDead(range: Range): boolean {
  const node = range.commonAncestorContainer;
  const el = node instanceof Element ? node : node.parentElement;
  if (el === null || !el.isConnected) return true;
  // Connectivity ALONE cannot see the commonest death on a live app.
  //
  // The DOM spec relocates a range's boundary points when a node is removed:
  // both ends move to (parent of the removed node, its old index). So a React
  // re-render that swaps the matched subtree does not orphan the range — it
  // COLLAPSES it, onto a parent that is still perfectly connected. The old
  // test therefore reported such a range as alive, the reap never ran, and the
  // badge stayed painted over text that no longer existed: a codeword that
  // scrolled you to nothing (measured 2026-07-27 — badge stranded at its old
  // coordinates while its text moved 166px).
  //
  // Every consumer's members span at least one character — a search match, a
  // phrase being picked, a committed find match — so collapsed is unambiguous
  // death for all three.
  return range.collapsed;
}
