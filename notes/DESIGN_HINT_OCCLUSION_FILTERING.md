# Hint Occlusion Filtering

**Status:** Proposed, deferred. Z-index stacking-context fix landed 2026-06-02
(`src/placement/stacking.ts`, ported from Rango). This document covers the
remaining case the z-index fix doesn't address: badges painting on top of
targets that are physically present in the DOM but visually hidden within
the same stacking context.

## Problem

Hint badges remain visible on targets that the user can't see. We have two
distinct subcases — the first is solved, the second is not:

1. **Cross-stacking-context occlusion (solved 2026-06-02).** A modal opens
   with `z-index: 9999+`; before the fix, page badges floated on top of the
   modal because they used `BASE_Z = 2147483000`. The stacking-context port
   gives each badge its target's natural z-index, so modals naturally cover
   them.

2. **Same-stacking-context invisibility (this doc).** The target is in the
   DOM with valid dimensions, but visually absent because:
   - An ancestor is `opacity: 0` (Gmail flyouts, dropdown menus, popovers).
   - An ancestor uses `overflow: hidden` + `max-height: 0` for a collapse
     animation; the target keeps its layout height but its clip box is zero.
   - A sibling is absolute-positioned over it with the same z-index (rare).
   - The target is moved off-screen via `transform: translate(-9999px)`
     (common pre-2020 hide pattern, still used in some sprite-replacement
     accessibility tricks).

   The first time this surfaced concretely: Gmail compose window had ~30
   badges scattered in apparently-empty body area, on hidden contextual
   tiles (schedule-send picker, smart-compose suggestions, etc.).

The risk if we don't fix it: badges become voice-matchable for targets the
user can't see, which is confusing ("I said 'fly cap' and nothing happened
— that hint was on a hidden button").

## Prior art

### Rango

Does not filter for occlusion. Its `isVisible` (`src/content/dom/isVisible.ts`)
checks:
- `visibility: hidden`
- `width < 5 || height < 5`
- `opacity === '0'` on the element, plus a 4-ancestor walk for `opacity: 0`

That's it. No hit-testing, no `overflow: hidden + max-height: 0` detection,
no transform-off-screen check. Rango ships with the same bug.

### Link Hints (lydell/LinkHints)

Author Simon Lydell — also wrote VimFx's link hinting, then ported it to
Link Hints as a standalone extension in 2017–2019.

Uses `document.elementFromPoint(x, y)` to detect covered elements. Combined
with `MutationObserver` for DOM changes and `requestIdleCallback` for
background re-scanning, the extension maintains a live set of "actually
visible" clickable elements. From the README: hit-testing is "one of
several techniques the extension employs for identifying clickable
elements."

This is the closest prior art to what we'd want. The downside Lydell ran
into: hit-testing every visible candidate is expensive on dense pages, so
he layered it with idle-callback scheduling and observer-driven
invalidation rather than polling.

### Vimium / Vimium-C

Uses a battery of DOM checks (visibility, opacity, dimensions, ancestor
opacity) but does not appear to do `elementFromPoint` hit-testing in the
default path. Known issue thread (philc/vimium#60) documents the same
"style overlay extension hides target but Vimium still shows hint" problem
without a fix.

## Approach options

### Option A: Hit-test pass after placement (recommended)

After `placeAll`, iterate every visible badge and call
`document.elementFromPoint(targetCenter.x, targetCenter.y)`. If the hit is
not the target or a descendant of the target, hide the badge by adding a
CSS class. Re-run on a debounce when:
- `MutationObserver` sees DOM changes likely to affect occlusion
  (`class`/`style` attribute changes on near ancestors, child list changes
  to known overlay roots).
- A scroll-coalesced re-place fires (already a thing).
- A periodic `requestIdleCallback` fallback (Link Hints' pattern).

**Cost:** N hit-tests per pass. `elementFromPoint` is a synchronous layout
read, but it's fast individually (~10–50µs). For 200 badges, ~5ms per pass,
debounced to ~1Hz max. Acceptable.

**Catches:**
- `visibility: hidden` (already filtered, but doesn't hurt to backstop).
- `overflow: hidden + max-height: 0` (the Gmail flyout case — the target's
  visual box is 0×0 even though its layout box is full; hit-test at its
  layout center hits whatever is *behind* the clipping ancestor).
- `transform: translate(-9999px)` (elementFromPoint at the target's
  *original* layout-time position returns whatever now occupies that spot).
- Sibling absolute-positioned over target (the sibling wins the hit-test).

**Does not catch (correctly):**
- `opacity: 0` — the transparent element still receives hit-tests, so
  elementFromPoint returns the target itself, and we keep the badge.
  This is the **right** behavior for hover-revealed UI, which the user
  has memory entries about preserving (see
  `project_browser_always_hints_mode`).

### Option B: Ancestor-walk visibility filter

Walk the target's parent chain looking for:
- `opacity: 0` (extend Rango's 4-ancestor walk to unlimited, or until a
  scroll/positioning ancestor)
- `transform: translate(<offscreen>)` on any ancestor
- `overflow: hidden` + `max-height: 0` (or `height: 0`) on any ancestor

Cheaper than hit-testing (no synchronous layout) but mechanically narrow:
each new hide-pattern needs explicit support.

**Cost:** O(depth) per element at scan time. Cheap.

**Catches:** Whatever we explicitly enumerate.

**Misses:** Anything not enumerated — and the next site is sure to invent a
new pattern. (See the user's memory note on
`project_observation_layer_leaks` — "4 phenomena, 3 share 1 root" — these
mechanical filters keep accumulating.)

### Option C: IntersectionObserver-based filtering

`IntersectionObserver` reports visibility against the viewport, not
against other elements. It tells us "is the target in-screen," not "is the
target covered." Useful as a perf gate (skip occlusion checks for
out-of-viewport targets) but not a primary mechanism.

### Option D: Composite — Option A primary, Option C as the perf gate

Run Option A only on in-viewport targets, gated by IntersectionObserver.
Out-of-viewport targets remain hinted (scroll will surface them) but
unchecked. This is approximately what Link Hints does.

## Recommendation

Implement **Option D** when we revisit. Layered structure:

1. `IntersectionObserver` to track in-viewport status per wrapper (already
   exists in BranchKit via the IO machinery in `src/observe/`).
2. After `placeAll`, hit-test only the in-viewport wrappers. Cache the
   result per wrapper.
3. `MutationObserver` invalidates the cache when the target's ancestor
   chain mutates in a relevant way (class/style/childList).
4. CSS class `bk-occluded` hides the badge (sets `display: none` or
   `visibility: hidden` — TBD; `visibility` keeps layout for re-tests).

Skip if any of these conditions apply:
- Target is itself the result of `elementFromPoint` → not occluded.
- Target is the ancestor of the result → not occluded (the target's own
  visible child is what we hit).
- Result is `null` → likely out of viewport; defer.

## Open questions

- **Should occluded badges still be voice-matchable?** Probably not — the
  current behavior is a footgun ("I said the word and it didn't work").
  Hidden badges should drop out of the live vocabulary, not just visually.
  This is a separate plumbing change.

- **What's the right re-test cadence?** Every placement pass is too noisy
  for animations (e.g., a hover-reveal that fades over 200ms would
  flicker). Debounce by 100–200ms after the last placement, and a hard
  cap of 1Hz minimum.

- **Hover-reveal interaction.** The user runs `hint_visibility="always"`
  (memory: `project_browser_always_hints_mode`). Hover-reveals should
  stay visible. `opacity: 0` survives Option A naturally. But what about
  hover-reveals that hide via `display: none` on a parent? Those have
  zero layout, so the scanner already drops them — no badge to filter.
  Hover-reveals that hide via `visibility: hidden`? Scanner currently
  drops those too. So hover-reveal compatibility appears safe.

- **Do we trigger on initial paint?** Many pages are still settling when
  the first scan completes. A target that's currently `display: none`
  might become visible in 100ms. Implement as a "re-check on next paint
  after first scan" hook.

## When to revisit

Trigger reconsideration when:
- More than one user-reported case of "I see badges on nothing" surfaces.
- A page demonstrably breaks voice matching because a heavily-hidden
  target is competing for a codeword (the visible alternative loses to
  the invisible one in match scoring).
- We have spare implementation cycles after the current settings UI and
  badge appearance tuning work settles.

Until then: known issue, documented mechanism, clear fix path.

## References

- [Link Hints README](https://github.com/lydell/LinkHints/blob/main/README.md) — hit-test + observer architecture for the most thorough open-source implementation.
- [Vimium issue #60](https://github.com/philc/vimium/issues/60) — same problem in the most popular extension; unresolved.
- [Effective JavaScript Techniques for Determining DOM Element Visibility](https://sqlpey.com/javascript/effective-javascript-techniques-for-determining-dom-element-visibility/) — overview of DOM visibility detection patterns.
- Rango's `isVisible`: `/tmp/rango/src/content/dom/isVisible.ts` (vendored reference).
- BranchKit's z-index port: `src/placement/stacking.ts` (the solved sibling problem).
