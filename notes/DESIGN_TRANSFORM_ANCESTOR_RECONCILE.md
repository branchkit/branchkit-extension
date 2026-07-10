# Transform-ancestor reconcile trigger (badge wiggle on pan/zoom canvases)

**Created:** 2026-07-08. Fixes badges that wiggle / detach when their target
moves inside a `transform`-driven container (React Flow pan/zoom canvases — the
QuickBase pipeline builder is the live case).

## The wiggle taxonomy (from investigation)

A body-mounted hint host follows its target. Most pages are free:

- **Document scroll** → host is `position:absolute` in document coords; the
  browser scrolls it with the page on the compositor. Perfect, no work.
- **Inner overflow scroll** → the accelerator (`scroll-accel.ts`) rides the
  scroller via a `ScrollTimeline`, or falls back to the JS chase.

Three residual wiggle modes were found:

1. **Accelerator thrash** — a native scroller whose node is recreated trips the
   strict `===` in `scrollAccelHealthy`, disarming mid-scroll. (Not observed in
   the QuickBase case: `rearms_delta == 0`.)
2. **Transform-scroll** — a container that moves content by `transform` (or is
   `overflow:hidden`) is invisible to `findScrollableAncestor`; badges never arm
   and ride the chase.
3. **Transform-canvas with no scroll event (THIS doc)** — a pan/zoom canvas
   (React Flow) moves its whole viewport by mutating `transform`, driven by
   pointermove, firing **zero scroll events**.

## Root cause (measured on the live QuickBase pipeline page)

The badge-follow loop (`reconcileScrollFrame` in `content.ts`) is armed *only by
scroll events* (`window` scroll + capture-phase document scroll). Console probe
during a canvas pan:

```
viewportFound: true, viewportMoved: true,
viewportTransform: matrix(1,0,0,1,273,184) → matrix(1,0,0,1,467,235)
scrollEvents: 0, wheelEvents: 0, pointerMoveEvents: 215
armed: 0, rearms_delta: 0
scrollerUnderCursor.firstDetectedScroller: null   (react-flow, overflow:hidden)
```

So during a pan the reconcile loop is **never triggered** — the placement math
is correct (`reconcileRead()` reads `getBoundingClientRect()`, which reflects the
ancestor transform) but nothing *runs* it. Badges freeze/drift until an unrelated
event pokes the loop, then snap. This is a **missing trigger**, not a broken
mechanism, and not the fundamentally-unrideable case.

## Fix: a transform-ancestor mutation trigger

Mirror the existing `container-resize-tracker.ts` pattern (a shared observer over
badge anchor containers that pokes reposition). Add:

- `findTransformedAncestors(el)` — ALL shadow-piercing ancestors whose computed
  `transform !== 'none'` (excludes document/body). Parallel to
  `findScrollableAncestors`. Must be ALL, not the nearest: React Flow nests
  transforms — `.react-flow__node` carries a per-node `translate` (STATIC during
  a pan) between the target and `.react-flow__viewport` (which carries the pan
  `translate` that MOVES). Watching only the nearest watches the static node
  wrapper and never fires on a pan — the first cut had this bug (real QuickBase
  still wiggled while a single-transform fixture passed; a nested fixture
  reproduced it: 0 observer fires on pan, fixed to 8/8 after tracking all).
- `transform-ancestor-tracker.ts` — a shared `MutationObserver` with
  `attributeFilter: ['style']` (+ `transform` presentation attr for SVG) over
  registered transformed ancestors, refcounted like the resize tracker. On a
  mutation it fires the wired callback.
- Wiring in `content.ts`: the callback calls `noteReconcileScroll()` (per-frame
  follow — reuses the same bounded, self-cancelling rAF loop the scroll path
  uses) plus the debounced `scheduleDeferredReposition()` settle (so post-pan
  discovery/strict converge, since a pan can reveal new in-band nodes).
- Registration in `HintBadge.refine()` next to `trackContainerResize`, untracked
  on teardown at the same sites.

### Why this is safe-ish

- **Reuses the existing loop.** `noteReconcileScroll` self-cancels ~1 frame after
  the last note, so a transform mutation storm is bounded exactly like a scroll
  burst — no new free-running rAF.
- **Placement math untouched.** Only a new *trigger* is added.
- **Generic.** Any transform-moved/pan/zoom container benefits (React Flow today;
  any JS-translated pane tomorrow). No plugin/site-specific logic.
- **Default ON, GRADUATED** (2026-07-08, user-validated on the QuickBase
  pipeline builder). `bkTransformTrigger` remains a console kill-switch (only an
  explicit `false` disables), matching `bkScrollAccel`/`bkOcclusion`. It shipped
  briefly behind a popup toggle for testing; that toggle was removed on
  graduation (a positioning behavior users shouldn't have to know about — the
  sibling positioning flags have no UI either).

### Known limits (out of scope here)

- **No compositor ride.** This makes the chase *run* during a pan; it does not
  put the pan on the compositor, so a fast pan may still show a slight chase
  shimmer. A full no-shimmer fix (mirror the ancestor transform onto the host)
  is a larger, separate step.
- **Zoom scale.** Under `scale != 1` the badge tracks position but is not scaled
  (badges are fixed-size). Separate minor issue, not this wiggle.
- **Chatty transformed ancestors.** A page that rewrites a transformed ancestor's
  `style` for unrelated reasons will poke reconcile; bounded by the self-
  cancelling loop, but the flag lets us back out if a site misbehaves.

## Kill-switch (default-on)

On by default. To disable in a session (e.g. to isolate a suspected reposition
churn on a chatty inline-transform page): `chrome.storage.local.set({
bkTransformTrigger: false })`. A `storage.onChanged` handler live-applies it —
`reconcileTransformTrigger()` re-arms/disarms every live badge — so it takes
effect in all open tabs with no reload. (A popup toggle carried this during
testing and was removed on graduation.)

## Verification

Structural before/after in the Playwright harness: a React-Flow-style fixture
(viewport moved by `transform` on pointermove, no scroll event). Without the flag
the badge transform is stale after a programmatic viewport-transform change; with
the flag it reconciles to the new position. Perceptual "does the shimmer go away"
stays a real-Chrome soak call.
