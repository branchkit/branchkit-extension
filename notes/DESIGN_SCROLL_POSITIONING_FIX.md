# Scroll Positioning Fix

Badges don't track their elements during scroll. They freeze at their
initial viewport position, causing misalignment, bunching, and premature
disappearance. This is the highest-priority UX bug — the extension is
unusable on scrollable pages.

## Problem

The current badge placement assumes "badges live in their target's scroll
ancestor, so scroll is handled by the compositor" (content.ts:1285). This
assumption is false: all badges are appended to `document.documentElement`
(hints.ts:155), which is the page root — NOT the target's scroll container.

When content scrolls:
- The target element moves with its scroll container
- The badge stays pinned to its initial absolute position on documentElement
- The badge and target drift apart

On QuickBase specifically:
- The form content lives in a scrollable iframe
- The main page has a scrollable table/grid view
- Both contexts produce severe badge misalignment on scroll

### What it looks like

From the debug snapshot viewport capture:
- Badges cluster at the top of the page, overlapping each other
- Many badges are nowhere near their target elements
- Some badges appear to float over unrelated content
- Scrolling makes it progressively worse as targets move away from
  initial positions

### The design doc was wrong

DESIGN_BADGE_PLACEMENT_ENGINE.md Decision 2 states: "No re-layout on scroll.
Badges are positioned absolutely within their scroll container
(anchorParent) and move with their targets via the compositor."

This is correct in principle — if a badge were a child of the same scroll
container as its target, CSS absolute positioning would make them scroll
together. But the implementation mounts every badge on
`document.documentElement`, not on the target's scroll container. The
compositor-based approach requires the badge to be inside the right
container.

## Root Cause Analysis

Two sub-problems:

### 1. Badge mount point is always documentElement

`hints.ts:155` sets `this.anchorParent = document.documentElement`. Every
badge is a child of the page root. If the target is inside a scrollable
`<div>`, the badge won't scroll with it.

The original DESIGN_BADGE_PLACEMENT_ENGINE.md anticipated mounting badges
in the correct scroll ancestor (it mentions "anchorParent" throughout), but
the implementation hardcodes documentElement — likely to avoid the React
hydration issue where inserting elements into React-managed containers
triggers hydration mismatch errors (see commit 6008708).

### 2. No scroll event repositioning

There is no scroll event listener for badge repositioning. The only
reposition trigger is window resize (content.ts:1288-1302). The assumption
was that compositor-based scrolling would handle it, but since badges aren't
in the right container, it doesn't.

## Rango Cross-Reference

From Rango's source (`/private/tmp/rango/src/content/hints/`):

**Rango mounts badges in the correct container, not on the root.**
`getContextForHint()` walks up from the target element through clip ancestors
(overflow, clip-path, contain, fixed/sticky, scrollable) and finds the
nearest "apt container" — a block-level element that can hold the badge
without clipping it. The badge's `shadowHost` is appended to this container
(`hint.container.append(hint.shadowHost)`), not to `document.documentElement`.

**Badges use `position: absolute` with `inset: auto`.** This makes the badge
sit at its static position (where it would be if position were static) but
out of flow. The `inner` element is then offset with `left`/`top` relative
to the `outer` using a delta calculation: `targetX - outerX - nudge`.

**Rango does NOT reposition on scroll.** There is no scroll listener for
badge repositioning. Because badges are children of the correct scroll
container, CSS absolute positioning within that container means they scroll
with their targets via the compositor. This is exactly the approach our
DESIGN_BADGE_PLACEMENT_ENGINE.md described — but our implementation doesn't
do it.

**Rango handles container edge cases carefully:**
- If the offset parent is outside the scroll container, Rango switches to
  `position: relative` to prevent badges for overflowing content from being
  visible (Hint.ts:520-544).
- A `containerResizeObserver` watches each container and triggers a full
  `refresh({ hintsPosition: true })` when the container resizes.
- A `containerMutationObserver` watches for badge removal by the page
  (hostile sites deleting hint nodes) and reattaches them.
- `getAptContainer()` skips table elements, display:contents, and shadow
  roots to find a suitable mount point.

**Rango handles stacking contexts:** `calculateZIndex()` walks ancestors to
find the effective z-index, incrementing by 5 to stay above neighbors.

**Key takeaway:** Rango's scroll correctness comes from mounting badges in
the right container. No runtime scroll tracking needed. The main complexity
is in `getContextForHint()` which finds the right container — about 100
lines of ancestor-walking logic.

## Proposed Fix

Two options, not mutually exclusive:

### Option A: Mount badges in the correct scroll container

Mount each badge in the nearest scroll ancestor of its target element,
rather than always on documentElement. This restores the compositor-based
scrolling that the design doc intended.

**How it works:**
1. When creating a badge, find the target's nearest scrollable ancestor
   (the element with `overflow: auto|scroll|overlay` and actual scroll
   extent). The scroller.ts module already has `findScrollableAncestor()`.
2. Set `anchorParent` to that scroll container instead of documentElement.
3. Position the badge relative to the scroll container's coordinate space.
4. The badge scrolls with its target via the compositor — no JS needed.

**Advantages:**
- Zero runtime cost for scroll tracking — the browser handles it
- Correct by construction: badge and target share a coordinate frame
- Works for nested scroll containers (each badge finds its own ancestor)

**Risks:**
- React hydration: inserting a shadow-DOM host into a React-managed container
  could trigger hydration errors. The previous fix (commit 6008708) moved
  badges TO documentElement specifically to avoid this. Need to verify
  whether shadow DOM hosts trigger the same issue.
- Stacking context: a scroll container with `transform`, `opacity < 1`, or
  `will-change` creates a new stacking context. The badge's z-index
  (2147483647) only applies within that context, so it could render behind
  content in a higher stacking context.
- Container detection accuracy: `findScrollableAncestor` may return the
  wrong container on sites with unusual CSS (e.g., `overflow: hidden` with
  JS-driven scrolling).

### Option B: Reposition badges on scroll events

Keep badges on documentElement but update their positions when the page
scrolls. This is the simpler approach but has runtime cost.

**How it works:**
1. Listen for `scroll` events on the document (capture phase, passive).
2. On scroll, debounce via requestAnimationFrame.
3. In the RAF callback, call `updatePosition()` on every visible badge.
   `updatePosition` already reads `getBoundingClientRect()` which returns
   current viewport coordinates, so the badge snaps to its target's new
   position.

**Advantages:**
- No change to badge mounting (avoids React hydration risk)
- Simple implementation — the position update logic already exists
- Works for all scroll contexts (page scroll, container scroll, iframe)

**Risks:**
- Performance: calling `getBoundingClientRect()` on 100+ elements every
  scroll frame triggers forced layout/reflow. This is the main cost.
- Jank: if the reposition can't complete within the 16ms frame budget,
  badges will visibly lag behind their targets during fast scrolling.
- Nested scroll containers: need to listen on every scrollable ancestor,
  not just the document. A scroll event on a div doesn't bubble to
  document's scroll event.

**Mitigation for performance:**
- Only reposition badges that are currently visible (in viewport).
- Use the IntersectionObserver data to skip off-screen badges.
- Consider `position: fixed` + transform-based positioning to avoid
  layout thrashing (fixed elements don't participate in layout reflow).

### Option C: Hybrid — mount in scroll container, fall back to reposition

Mount badges in their scroll container when safe (no React hydration risk).
Fall back to documentElement + scroll listener for containers that are
React-managed.

**Detection heuristic for React containers:**
- Check for `_reactRootContainer`, `__reactFiber$`, or `__reactInternalInstance$`
  properties on the container or its ancestors.
- If found, mount on documentElement and use scroll listener for that badge.
- If not found, mount in the scroll container directly.

This is the most complex but gives the best of both worlds.

## Recommendation

Rango proves that **Option A** (mount in the correct scroll container) is
the right long-term approach — it has zero runtime cost and is correct by
construction. But the React hydration issue (commit 6008708) was the reason
we moved to documentElement in the first place.

**Recommended path:**

1. **Immediate fix: Option B** (scroll event repositioning). Ship this now
   to make the extension usable on scrollable pages. It's a ~20 line change.

2. **Follow-up: Option A** (correct container mounting). Investigate whether
   shadow DOM hosts actually trigger React hydration errors. If they don't
   (shadow DOM is invisible to React's tree walker), Option A replaces
   Option B entirely and the scroll listener is removed. Port Rango's
   `getContextForHint` logic — we already have a partial version in
   `findClipAncestor`.

3. **If hydration is a problem: Option C** (hybrid). Use container mounting
   where safe, fall back to documentElement + scroll listener for React
   containers.

### Implementation sketch for Option B

```
// content.ts — scroll repositioning

let scrollRafPending = false;

function onScroll(): void {
  if (!hintsVisible || scrollRafPending) return;
  scrollRafPending = true;
  requestAnimationFrame(() => {
    scrollRafPending = false;
    const visible = store.all.filter(w => w.hint?.isVisible);
    if (visible.length > 0) {
      cacheLayout(visible.map(w => w.element));
      for (const w of visible) w.hint!.updatePosition();
      clearLayoutCache();
    }
  });
}

// Capture phase catches scroll events on any container, not just document
document.addEventListener('scroll', onScroll, { capture: true, passive: true });
```

The capture-phase listener fires for scroll events on any descendant
element, not just the document. This handles scrollable divs, iframes'
internal scroll (within the same content script), and the main viewport.

### Scroll containers that need special handling

**Iframes:** Each iframe has its own content script (all_frames: true).
Scroll within an iframe is handled by that iframe's content script. Scroll
of the parent page that moves the iframe itself is not visible to the
iframe's content script — but since the iframe's viewport doesn't change
from its own perspective, badge positions within the iframe remain correct.

**Sticky/fixed headers:** Elements with `position: sticky` or `fixed` don't
move during scroll. Badges on these elements should NOT reposition. Detect
via `getComputedStyle(target).position === 'sticky' || 'fixed'` and skip
the updatePosition call.

**Infinite scroll / virtual lists:** Sites like Twitter render only visible
rows. When the user scrolls, new elements appear and old ones are removed.
The MutationObserver already handles element addition/removal. The scroll
listener handles positioning of surviving badges.

## Performance Budget

Worst case: 200 visible badges, each needing `getBoundingClientRect()`.

- 200 x getBoundingClientRect: ~2-4ms (forced reflow once, then cached)
- 200 x style.left/top writes: ~1ms
- RAF overhead: ~0.1ms
- Total: ~3-5ms per scroll frame

Within the 16ms budget. The layout cache (`cacheLayout`) batches all reads
before writes, avoiding layout thrashing. This is the same pattern used by
the existing resize handler.

If this proves too slow on pages with 500+ badges, add a viewport filter:
only reposition badges whose target's last-known rect was within 200px of
the viewport edges (the ones most likely to have moved into or out of view).

## Edge Cases

**No scroll event on parent page moving an iframe:** If the parent page
scrolls and the iframe moves, the iframe's content script doesn't receive a
scroll event. The badges inside the iframe maintain correct positions
relative to the iframe viewport, so this is fine — the iframe is a
self-contained coordinate system.

**Badges on fixed/sticky elements:** These elements don't move during scroll.
Skip repositioning for badges whose target has `position: fixed` or `sticky`.
Otherwise the badge would jitter (read a viewport-relative rect that hasn't
changed, but the delta math would try to "correct" to the same position).

**Rapid scroll (momentum/trackpad):** The RAF debounce ensures at most one
reposition per frame. During fast momentum scrolling, badges may lag by one
frame (~16ms). This is imperceptible.

**Layout shift during scroll (lazy images, dynamic content):** Layout shifts
move elements without triggering scroll events. The ResizeObserver in
content.ts already handles this for the resize case. Consider adding a
periodic check (every 500ms while hints are visible) or listening for
ResizeObserver entries on badge targets.
