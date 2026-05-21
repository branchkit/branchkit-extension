# Visibility Observer

Addresses the gap where elements match `HINTABLE_SELECTOR` but are invisible
at scan time, then become visible via CSS-only changes that no existing
observer detects.

## Problem

Three visibility patterns exist in the wild:

| Pattern | Example | Detection |
|---------|---------|-----------|
| **Not in DOM** | SPA navigation, lazy load | MutationObserver childList |
| **display:none -> block** | Accordion, tab panel | IntersectionObserver (geometry changes) |
| **visibility:hidden -> visible** | QuickBase form, fade-in transitions | **Nothing** |

The third pattern is invisible to both observers. `visibility:hidden` elements
retain their bounding box (non-zero width/height, in-viewport geometry), so
IntersectionObserver reports `isIntersecting: true` even though the element
isn't painted. MutationObserver doesn't watch `class` or `style` by default
because they're the two noisiest attributes on any page.

Discovered on QuickBase: the form frame renders all field labels and inputs
with `visibility:hidden` on initial paint, then flips them to `visible` via a
class change once data loads. 539 elements hit this path on a single page.

## Current Implementation (v1)

Two layers:

1. **IntersectionObserver** on invisible candidates from `scanElements()`.
   Catches `display:none -> block` transitions where geometry changes from
   0x0 to non-zero. Fires, calls `scanSingle()`, promotes to wrapper.

2. **One-shot `setTimeout(doScan, 1500)`** after initial scan. Catches
   `visibility:hidden -> visible` that IO can't detect. Works because
   QuickBase's transition completes within ~1s of page load.

The timer is pragmatic but fragile: arbitrary delay, fires too early on slow
connections, fires unnecessarily on pages without hidden elements, doesn't
catch late transitions (SPA navigation within the same tab).

## Proposed: Scoped MutationObserver (v2)

Replace the timer with a MutationObserver on `class` and `style` attributes,
scoped to only run when invisible candidates exist.

### Design

```
scanElements()
  -> invisibleCandidates[] (elements matching selector but failing isVisible)
  -> observeInvisibleCandidates()
     -> add to pendingVisibility set
     -> connect visibilityMO if not already connected

visibilityMO callback (attributeFilter: ['class', 'style'])
  -> debounce via requestAnimationFrame (one re-check per frame)
  -> for each el in pendingVisibility:
       if !el.isConnected -> remove from set
       if isHintable(el) -> promote to wrapper, remove from set
  -> if pendingVisibility is empty -> disconnect visibilityMO
```

### Scoping rules

- **Connect** the MO when the first invisible candidate is added to the set.
- **Disconnect** when the set empties (all candidates either promoted or
  disconnected from DOM). Zero ongoing cost on pages without hidden elements.
- **Observe** on `document.documentElement` with `subtree: true` because the
  class/style change may be on an ancestor, not the candidate itself.
- **attributeFilter: ['class', 'style']** limits which mutations fire the
  callback. Only these two can flip computed visibility.
- **Debounce** with `requestAnimationFrame`: coalesces all mutations in a
  frame into a single re-check pass. On a React page that fires 50
  class-change mutations per frame, we still only call `isHintable()` once
  per candidate per frame.

### Cost analysis

The concern with watching `class`/`style` globally is callback frequency.
On a React SPA with 200 components re-rendering:

- Without scoping: MO fires ~200 times/frame, callback runs 200 times
- With RAF debounce: callback runs once/frame, checks N candidates
- With disconnect-when-empty: zero cost after all candidates resolve

Worst case: N invisible candidates * M frames until they resolve. Typical:
N=30 (QuickBase form), M=2-3 frames (transition completes quickly).
`isHintable()` is cheap (selector match + getComputedStyle + rect check).

After all candidates promote or disconnect, the MO disconnects entirely.
Pages that never have invisible candidates never connect it at all.

### Cleanup

Elements removed from the DOM (`!el.isConnected`) are pruned from the set
during each re-check. No WeakRef needed because the set is actively drained.

If the set hasn't emptied after 30 seconds (pathological case: elements
that stay hidden forever), disconnect the MO and abandon the candidates.
They'll be picked up if a future `doScan()` runs (e.g., SPA navigation).

### Edge cases

- **Ancestor visibility**: A class change on a grandparent `<div>` can flip
  visibility for 50 descendants. The RAF-debounced re-check handles this
  naturally: every candidate is re-checked, not just the mutation target.

- **Rapid SPA navigation**: Old candidates from page A may still be in the
  set when page B loads. The `!el.isConnected` prune handles this:
  `dropDisconnectedWrappers` runs on navigation, and the next re-check
  cleans up stale candidates.

- **Multiple frames**: Each frame's content script has its own set and MO.
  A sub-frame with 539 hidden elements (QuickBase) gets its own scoped MO
  that disconnects independently of the main frame's.

## Migration

1. Keep the IntersectionObserver layer (handles display:none -> block).
2. Replace `setTimeout(doScan, 1500)` with the scoped MO.
3. Remove the timer entirely.
