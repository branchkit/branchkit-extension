# Observer-Driven Layout and Lifecycle

Replace the imperative "scroll fires → re-measure every visible badge"
positioning loop *and* the open-ended "discover anywhere in the DOM,
hold onto everything until disconnected" wrapper lifecycle with a
single observer-driven model. Both forced-reflow density and
unbounded wrapper/pending-visibility growth are symptoms of the same
architectural mismatch: we attend to the whole document when the
browser has perfect information about what's near the viewport.

## Status

| Phase | What | Status |
|---|---|---|
| 1 | CPU instrumentation bridge | Done (`0b938d3`) |
| 2 | Viewport-scoped wrapper + pendingVisibility lifecycle (AttentionObserver) | Done (`0b938d3`) |
| 2b | AttentionObserver far-threshold eviction | Done (`1f05d76`) |
| 2c | `visibilityMO` targeted recheck | Held — caused render regression in earlier attempt; needs design for CSS-parent transitions before re-attempt |
| 3 | TargetRectStore shadow (cache + drift sampler) | Done (`421c834`) |
| 3b | LayoutSignalRouter (write rects on scroll/resize) | Done (`9e1173b`) — window scroll + RO surfaces; overflow-ancestor scroll still ahead |
| 4 | Flag-gated cutover of `updatePosition` reads | Dropped standalone; folds into combined 4/5 (Firefox path) — see "Course correction" |
| 5 | Delete global rAF reposition sweep | **Superseded** — not via a JS router but by the anchor model deleting the scroll dimension entirely. See "Anchor-first architecture" (2026-05-30). The router (ancestor-geometry caching) is explicitly NOT the investment |
| 5b | Overflow-ancestor scroll listeners | Done (`9edd979`) for the nesting path — but the nesting path is now frozen-for-deletion; no further 5b investment. Chromium uses the CSS-anchor fast-path (`95468e1`) |
| 6 | Relocate position log to read from store | Ahead |
| A1 | Extract `computePlacement` (pure, DOM-free) | Done (`fc78f6d`) — anchor-first step 1; behavior-preserving reusable core |
| A2 | Anchor path off the legacy sweep (explicit drive model) | Done — anchor-first step 2. `computePlacement` returns `geometryDependent`; `HintBadge.needsLayoutReposition()` excludes non-geometry-dependent anchored badges from the 'all' sweep (compositor carries them). Nesting path returns true → unchanged. Verified: 441 tests + live Chromium resize hold |
| A3 | Freeze nesting path; delete when Firefox ships anchor positioning | Ongoing posture |

## Course correction (2026-05-30)

Three findings, surfaced while preparing the Phase 4 cutover, change the
plan for the positioning axis. None invalidates the lifecycle axis
(Phases 1-2b) — that work stands.

**1. The per-scroll-frame reflow this doc set out to kill is already
gone.** The "Problem (positioning axis)" section below describes a model
where `window.scroll` schedules a rAF that re-measures every visible
badge. That model was since replaced: scroll repositioning is debounced
to *settle-only* (`scheduleDeferredReposition`, 100ms) and badges follow
live scroll via CSS anchoring inside their scroll-ancestor (the badge
host is appended into the target's scroll container, so the compositor
carries it). `scheduleReposition` now fires only on resize, container-
resize-settle, focus, transition/animation-end, and target-mutation-
settle — not per scroll frame. The headline win Phase 4 promised was
captured by a different mechanism that landed in the interim.

**2. The flag-gated cutover (Phase 4 as written) is behaviorally inert
in isolation.** The reposition sweep writes a live
`getBoundingClientRect` for every visible target into `TargetRectStore`
*immediately before* `placeBadges` reads (content.ts, inside
`scheduleReposition`'s rAF). So at placement time the store and the
per-batch layout-cache hold the same values from the same frame. Cutting
placement's `getCachedRect(w.element)` reads over to `targetRectStore.read`
under a flag would produce pixel-identical output flag-on vs flag-off —
a parity harness would trivially pass and prove nothing. The cutover only
delivers measurable value once the sweep's blanket `cacheLayout` + live
reads are deleted (Phase 5) and the store is kept warm purely by
observers. That, in turn, needs every layout signal to write the store —
including overflow-ancestor scroll, the "Hard" Phase 5b.

**3. CSS Anchor Positioning solves the "Hard" Phase 5b natively — on
Chromium, but only when the anchor CSS lives on the light-DOM host.**
Prototype fixtures confirm a positioned element with `position-anchor` +
`anchor()` follows its target through an inner overflow-container scroll
with **zero JS scroll listeners** (target moved top:223→123 on
`scrollTop=100`; tracked exactly, delta held at dy:0/dx:-30). This is
precisely the inner-pane case Phase 5b calls "Hard." But CSS Anchor
Positioning is Chromium-only (Chrome 125+); Firefox — the entire freeze
motivation for this work — does not support it yet. So it is a Chromium
*fast-path*, not a cross-browser replacement.

Critical shadow-boundary finding (2026-05-30). `anchor()` does **not**
pierce *up* out of a shadow tree to a light-DOM `anchor-name`. Tested
three structures against Playwright's bundled Chromium:

| Anchor CSS lives on | `anchor-name` lives on | Result |
|---|---|---|
| Badge inside **open** shadow root | light-DOM target | **FAIL** — stuck at (0,0) |
| Badge inside **closed** shadow root | light-DOM target | **FAIL** — stuck at (0,0) |
| **Light-DOM host** element | light-DOM target | **PASS** — tracks through scroll |

This resolves the doc's earlier open sub-question (closed-shadow badges).
Shadow `mode` is irrelevant — both open and closed fail identically,
confirming this is tree-scope behavior, not a JS-access artifact. The
earlier "shadow prototype passes" note was actually measuring the
*plain* light-DOM fixture. Implication for the fast-path: the anchor
properties (`position-anchor`, `top/left: anchor(...)`) must be set on
the **light-DOM `HintBadge.host`**, with the badge visuals remaining in
the closed shadow root for style isolation. Fixtures:
`test-fixtures/anchor-positioning-{plain,shadow,closed-shadow,host-light}.html`,
driven by `scripts/_anchor-plain-test.mjs`, `_test-anchor-shadow.mjs`,
`_test-anchor-closed-shadow.mjs`, `_test-anchor-host-light.mjs`.

### Reconciled two-path plan

The two approaches are complementary, not competing — and the doc's own
Open Question (CSS Anchor "delegate to platform" with the store as the
abstraction) already anticipated this:

- **Cross-browser / Firefox foundation:** `TargetRectStore` +
  observer-driven writes remain the general path. The valuable form of
  the cutover is Phases 4 **and** 5 done together (cut reads to the store
  *and* delete the blanket sweep), which requires Phase 5b
  (overflow-ancestor scroll listeners) for inner-pane correctness on
  Firefox. The standalone flag-gated Phase 4 is dropped as inert.
- **Chromium fast-path:** when `CSS.supports('anchor-name: --x')` is
  true, position badges with CSS Anchor Positioning and skip the JS
  reposition machinery entirely (including Phase 5b's listener walk) for
  those badges. The store becomes the fallback the platform path
  degrades to.

  Implementation shape (grounded in current `hints.ts`). Today
  `HintBadge.host` is a `display:contents` light-DOM div appended *inside*
  the target's scroll-ancestor (`resolveBadgeContext` → `resolveContainer`),
  with `outer` at `position:relative` riding that container's scroll and
  `inner` carrying explicit offsets from `updatePosition`. The fast-path
  replaces the *physical nesting* with anchoring:
  1. Feature-gate once: `supportsAnchor = CSS.supports('anchor-name','--x')
     && CSS.supports('top','anchor(top)')`.
  2. On the **target**, set a unique `anchor-name: --bk-<id>` (cleared on
     `destroy`/`retarget`). One name per live badge.
  3. On the **light-DOM `host`** (not the shadow): drop `display:contents`,
     set `position:absolute; position-anchor:--bk-<id>;
     top:anchor(top); left:calc(anchor(left) - BADGE_OFFSET)`. Mount it at
     `document.body` (or any fixed root) instead of the scroll-ancestor —
     the compositor now tracks the target through *all* its overflow
     ancestors, which is exactly what Phase 5b's listener walk was for.
  4. `outer`/`inner` keep their style-isolation role; their explicit
     offset math (`updatePosition`) is bypassed on this path since the
     host itself is anchored.
  5. `scheduleReposition`/`scheduleDeferredReposition` become no-ops for
     anchored badges; only resize-driven *size* recompute may remain.

  Firefox (no `anchor()`) keeps the current nesting + settle-reposition
  path unchanged. This is the fork: one positioning strategy selected at
  badge construction by feature support.

Sequencing decision (resolved 2026-05-30): option (b) — the Chromium
CSS-anchor fast-path — was built first and **landed** (commit `95468e1`).
`HintBadge` now forks at construction: when `CSS.supports('anchor-name')`
&& `CSS.supports('top','anchor(top)')`, the badge sets `anchor-name` on the
target and positions a body-mounted light-DOM host via `calc(anchor(...))`;
the compositor tracks the target through every overflow ancestor with no JS
scroll listener. Verified live (`scripts/_verify-anchor-tracking.mjs`: pinned
badge held its offset through an inner-pane scroll). Firefox keeps the
`display:contents` nesting + settle-reposition path unchanged.

That leaves exactly one remaining positioning task — the cross-browser /
Firefox foundation, option (a): Phase 5b (overflow-ancestor scroll listeners
writing `TargetRectStore`) + the combined 4/5 cutover (route `placeBadges`
reads through the store, delete the blanket reposition sweep). This is the
original Firefox-freeze motivation; it is genuinely new behavior and the
"Hard" part. The standalone flag-gated Phase 4 remains not worth building.

## Cutover blocker: the store holds target rects, placement needs ancestor geometry (2026-05-30)

Phase 5b landed (`9edd979`): `scroll-ancestor-tracker` registers one passive
listener per inner overflow pane (refcounted by target, rAF-coalesced) and
writes fresh rects to `TargetRectStore`; write-on-paint at
`showHints`/`badgeNewlyCodeworded` covers targets painted mid-scroll. Verified
in real Firefox on the nesting path: the inner pane registers and scoped drift
stays 0 through 30px and 120px inner scrolls. The store is now genuinely warm.

But the combined 4/5 cutover — "route `placeBadges` reads through the store,
delete the blanket sweep" — does **not** follow from a warm store, and we
stopped short of attempting it. Two facts surfaced while scoping it:

1. **The store has zero production readers.** It is written in six places
   (attention-IO band entry, eviction-paired writes, write-on-paint ×2, the
   sweep's brute-force loop, 5b scroll writes) and read by nothing but the
   diagnostic drift sampler. The cutover's whole point is to *make* it the
   read source so the sweep can be deleted.
   *(Update 2026-05-31: no longer strictly zero — the hint-lifecycle reconciler's
   shadow band-divergence check reads warm rects to detect flag-vs-geometry
   staleness; see `notes/DESIGN_HINT_LIFECYCLE_RECONCILER.md`. That is a
   diagnostic-grade reader, not the placement read-cutover this section is about,
   so the cutover argument below stands.)*

2. **Placement reads ancestor geometry, not just the target rect.** The Rango
   strategy's `positionAtTopLeft` (`placement/rango.ts`) reads: clip-ancestor
   rects (`getAvailableSpace`), sticky/fixed ancestor rects + styles
   (`findStickyBound`), and ancestor styles + dims (`isInScrollList`), plus
   `resolveContainer`/`getSpaceInAncestor` in `hints.ts`. `TargetRectStore`
   caches only **target** rects. So routing the target-rect read through the
   store cannot eliminate the layout reads placement actually depends on —
   which is exactly why the standalone Phase 4 was "inert" and why an earlier
   read-cutover attempt (2c) regressed.

Compounding both: on the Firefox nesting path the badge host is physically
nested inside the target's scroll-ancestor, so non-drifted badges already
track inner-pane scroll **via the compositor** — they render correctly with no
store read at all. Phase 5b's drift was about the *store* going stale, never
the badges. And the sweep's `'drifted'` scope (course-correction finding 1)
already trimmed per-scroll re-placement to the genuinely scroll-sensitive
subset.

**Conclusion.** A faithful cutover is not a read-routing swap; it needs a full
`LayoutSignalRouter` that also caches ancestor geometry (clip-ancestor rects,
sticky/fixed bounds, ancestor dims) with its own invalidation on RO/MO/scroll,
then deletes `scheduleReposition` entirely. That is a much larger design than
Phase 5b and the part that regressed as 2c — do not reattempt without it.
Phase 5b stands as the warm-store foundation that a future router would build
on. Decision (2026-05-30): land 5b, defer the cutover.

## Anchor-first architecture (chosen direction, 2026-05-30)

Reframing the two positioning paths makes the router question moot. They are
not "Chromium fast-path + Firefox fallback." They are:

- **Anchor model** — the *future, eventually universal* path. Chromium has CSS
  anchor positioning now; Firefox ships it on a when-not-if basis. The
  compositor tracks the target through every overflow ancestor natively, so
  *tracking is free* and the entire scroll dimension (scroll listeners, drift
  detection, Phase 5b's ancestor walk, the 100ms debounce) does not exist on
  this path.
- **Nesting model** — *sunsetting legacy*. It exists only because Firefox
  stable/ESR hasn't caught up. It is **frozen**: no router, no Phase 5b
  extensions, no new investment. It gets deleted when Firefox ships anchor
  positioning.

The `LayoutSignalRouter` would have been investment in the legacy path —
rebuilding scroll tracking + ancestor-geometry caching in JS for a model the
browser is about to obsolete. The better investment is the model where that
machinery is unnecessary. So we do **not** build the router.

What we *do* build is the structure that makes the anchor model the canonical
one and the eventual Firefox deletion a one-liner:

1. **Extract `computePlacement` as a pure, DOM-free function**
   (`placement/compute.ts`). Today the placement decision (corner, overhang,
   space clamp, sticky clamp, overlap-into-text fallback) is tangled inside
   `RangoStrategy.positionAtTopLeft` and `updatePosition`. Pulled out, it is
   the reusable core both paths consume and is unit-testable without a DOM.
   This is the highest-leverage, lowest-risk step and de-risks everything
   downstream. **Behavior-preserving.**
2. **Take the anchor path off the legacy sweep, explicitly.** The anchor path
   already no-ops scroll repositioning (`needsScrollReposition()` is false for
   anchorMode), so it skipped every 'drifted' sweep incidentally. Step 2 makes
   that independence a declared property instead of an accident, and extends it
   to the 'all' sweep (resize, huge-mutation settle). `computePlacement` now
   returns `geometryDependent` — true only when the resolved offset actually
   rode ancestor geometry (a clip-ancestor available-space clamp bit, or a
   sticky/fixed bound applied). `HintBadge.needsLayoutReposition()` is the
   'all'-sweep gate: the nesting path always returns true (its host position is
   JS-computed), the anchor path returns true only when `geometryDependent`.
   A non-geometry-dependent anchored badge's offset is purely target-relative,
   so the compositor carries it through a resize for free — no JS re-place.
   (We considered giving the anchor path its own `ResizeObserver` on the badge,
   but badge size only changes on a label edit, which already routes through
   `placeOne` — a standing observer would be redundant.) **Behavior-changing on
   the anchor path** (badges leave the 'all' sweep); nesting path unchanged.
3. **Freeze the nesting path; schedule its deletion.** Marked "delete when
   Firefox ships anchor positioning."

Open design question the anchor model must answer (don't hand-wave):
**clipping.** A nested host is clipped by its scroll-pane for free; a
body-mounted anchored host is not, so a badge whose target scrolls toward the
pane edge would float over the pane border. The platform has a mechanism —
`position-visibility: anchors-visible` hides an anchored element when its
anchor is clipped/off-screen — so lean on that rather than reintroducing JS
clip-tracking. Validate it behaves as wanted before relying on it.

## Known limitations (don't reattempt without a new design)

**Gmail mail-list scroll-back loses hints.** When wrappers leave the
attention region, `detachWrapper` releases the codeword and removes
the wrapper. Scrolling back doesn't re-attach because the IO subscription
was also removed. Attempted fix: keep the IO subscription past detach.
Result: Gmail unresponsive — its many simultaneously observed elements
multiplied per-scroll IO entry processing cost. Reverted in `f0782ee`.
Correct approach probably needs scroll-triggered rediscovery (walk
viewport on user scroll, re-observe selector matches we don't currently
track) rather than infinite IO retention.

**Inner-pane scroll jitter (Gmail, Slack-style apps).** Badges anchored
to targets inside an overflow-scroll container don't reposition while
the container scrolls because `scheduleReposition` only listens to
`window.scroll`. Visible as badges falling behind the page and snapping
forward. Wikipedia/normal-window-scroll sites unaffected.

Attempted fix 1: capture-phase scroll listener on `document`. Result
on YouTube (which has many internal scrollables): longtask total
2.8s → 12.5s, four scrollers firing constantly.

Attempted fix 2: same listener with 100ms throttle on inner scrolls,
window-scroll keeping its dedicated path. Result on YouTube: longtask
total still 10.7s. Inner scrollers still cumulatively too expensive.

Correct fix needs **per-wrapper overflow-ancestor walk** (Floating UI's
`getOverflowAncestors` pattern): when a wrapper attaches, walk its
parents identifying ones with `overflow: auto/scroll`, register a
scroll listener on each (refcounted across wrappers), detach on
unwrap. Bounds listener attachment to actually-scrollable ancestors
of actually-wrapped elements, not every scroll on the page. Significant
implementation work — left as Phase 5b.

Phase 2 measured impact (YouTube video page, 45s scroll soak):

| Metric | Before | After | Change |
|---|---|---|---|
| `wrapperCount` final | 4,288 | 602 | −86% |
| `wrapperCount` trajectory | monotonic climb | peaks then decreases | leave-detach working |
| `scanSingle` calls / 45s | 1,103,195 | 105,055 | −90% |
| `pendingVisibility` peak | 8,081 (size:1000+) | 424 (size:100-1000) | structurally bounded |
| `recheckPendingVisibility` max single drain | 112ms | 25ms | −78% |
| Long task max | 1,180ms | 698ms | −41% |
| Long task total | 30.8s / 45s | 19.6s / 45s | −36% |
| Heap final | 353MB | 255MB | −28% |

This eliminated the Firefox unresponsive-script warning on YouTube
comment pages — the 5s+ main-thread-pinning sync drain that triggered
it became structurally impossible once the pending set was bounded
by viewport proximity.

## Phase 2 follow-ups (still gaps)

These surfaced during the Phase 2 run and are not addressed yet:

- **Attention IO subscriptions accumulate.** `discoverInSubtree`
  registers every selector-matching ref with the attention observer.
  Refs far below the fold that never enter the attention region never
  get unobserved. Heap is still climbing (+175MB/min during scroll
  soak), driven by IO subscription bookkeeping the engine maintains
  per observed element. Fix: TTL or distance-based unobserve for
  attention candidates that haven't fired enter in N seconds, or
  scope discovery itself to viewport-extended regions so we never
  observe far-away elements in the first place.
- **`recheckPendingVisibility` is still the dominant CPU bucket** at
  steady state (94s of element-walks across 297 drains, avg 320
  elements per drain). It's bounded now, but YouTube has a lot of
  visibility:hidden skeletons inside the attention region. Reducing
  further means replacing pendingVisibility + visibilityMO entirely
  with attention-IO-driven `scanSingle` on geometry-change — which
  the attention IO already provides if we wire it that way. Part of
  the "purest observer-source" target.
- **Positioning axis (Phases 3-6) untouched.** `placeBadges:reposition`
  is currently fine (16ms avg / 63ms max), but the structural change
  is still worth doing — same observer-trigger principle applied to
  rect reads. Builds on Phase 2's attention region (only positions
  badges whose targets are near the viewport, which already holds).

## Why this is one design, not two

The forced-reflow problem (every visible badge re-measured per scroll
frame) and the wrapper-leak problem (`pendingVisibility` growing to
8,000+ elements on YouTube as comment skeletons accumulate) read as
independent bugs. They aren't. They're the same principle applied to
two axes:

- **Positioning axis:** "measure only what moved" → observers tell us
  which targets had a layout change; we re-read rects only for those.
- **Lifecycle axis:** "attend only to what's near the viewport" →
  observers tell us which targets entered/left a viewport-extended
  region; we attach/detach wrappers and observations to match.

Built together, `pendingVisibility` doesn't exist as a separate concept
— observation begins on viewport-extended entry and ends on viewport-
extended exit. The 8,081-element drain becomes structurally impossible.

## Problem (positioning axis)

Today's positioning model is event-poll:

1. `window.scroll` or `window.resize` fires.
2. We schedule a rAF.
3. Next frame, we iterate every visible badge and re-read its target rect,
   its own outer rect, its container rect, and several computed styles.
4. We write the new position.

On a page with 100 visible badges, that's ~400 forced layout reads per
scroll frame regardless of whether anything actually moved. On a static
page where the user is just scrolling past it, the answer the engine has
to compute for every one of those reads is "same as last frame." The
work is wasted but the layout pass isn't free — `getBoundingClientRect`
mid-scroll forces a synchronous reflow before returning.

The shipped layout cache (`layout-cache.ts`, `cacheLayout`/`cacheVisibility`)
mitigates inside a single batch by sharing reads across siblings and
ancestors, but the *batch itself* still scales with visible-badge count,
not with how-much-actually-changed. The cache is an optimization layered
over an architecture that asks the wrong question on every frame.

This is also Rango's model. Their `containerResizeObserver` triggers a
full `refresh({ hintsPosition: true })` that re-reads everything; their
ResizeObserver is a signal, not a source. We can do better by treating
the observer entries themselves as the layout-changed signal, and
measuring only the union of affected targets.

## Problem (lifecycle axis)

Today's wrapper-lifecycle model is open-loop:

1. `discoverInSubtree` walks any subtree the MO surfaces; every
   hintable element gets an `attachWrapper` call. Elements anywhere in
   the document — including far below the viewport — accumulate.
2. `observeInvisibleCandidates` adds every initially-invisible
   hintable to `pendingVisibility`. They stay there until they either
   become visible or get DOM-disconnected.
3. Nothing else drops wrappers or pending candidates.

On a finite, mostly-static page (the GitHub fixture used to dismiss
"wrapper buildup" earlier) this is fine — the working set stabilizes.
On infinite-scroll pages with lazy-loaded skeletons (YouTube comments,
Twitter feed, Reddit thread) this is unbounded:

| Signal (YouTube video page, 45s soak with scroll) | Value |
|---|---|
| `wrapperCount` growth | 428 → 4,288 (no teardown) |
| `pendingVisibility` peak | 8,081 elements |
| `recheckPendingVisibility` calls | 250 |
| `scanSingle` calls | 1,103,195 (24,000/s) |
| Heap growth | 88 → 353 MB (+265 MB / 45s) |

`recheckPendingVisibility` walks the whole pending set on every
visibility-MO fire. With 8k pending and ~5.5 fires/sec, that's the
24k-scanSingle-per-second steady-state CPU baseline. Firefox flags
this as an unresponsive script because its JIT can't pace the work
fast enough.

The structural defect: we observe and retain elements regardless of
where they sit relative to the viewport. The browser already knows
which elements are near the viewport — we're not asking.

## Reference Architecture: Floating UI

The model proposed here is what Floating UI (`@floating-ui/dom`) ships
as `autoUpdate`. Floating UI is the positioning engine under Radix,
shadcn/ui, Headless UI, Mantine, MUI Joy, and Chakra v3 — the validated
industry pattern for "anchor N floating elements to N targets without
re-measuring on every scroll."

Their `autoUpdate` subscribes to:
- `ResizeObserver` on reference and floating elements
- `IntersectionObserver` on the reference (configurable threshold)
- Scroll on the chain of ancestors that have `overflow: auto/scroll/hidden`
- Optional `requestAnimationFrame` polling for compositor-only changes

Recompute fires only when one of these signals fires, and only for the
affected pair. We are not inventing anything — we are porting a model
that has shipped in production at the scale of every modern React design
system since ~2022.

What we are *not* adopting from Floating UI: their middleware system,
their flip/shift/arrow positioning logic. We already have placement
logic (`placement/`). The observer-trigger model is independent of how
the position math itself is done.

## The Four Layout-Change Signals

Every way a target's on-screen position can change is observable by one
of these four signals:

| Signal | Fires when | Today's coverage |
|---|---|---|
| **MutationObserver** | DOM tree changes: nodes added/removed, attributes changed | Yes — global MO + visibility MO |
| **IntersectionObserver** | Element's intersection with viewport/root crosses threshold | Yes — IntersectionTracker for viewport entry/exit |
| **ResizeObserver** | Observed element's content/border-box changes size | Yes — `onContainerResize` for anchor parents |
| **Ancestor scroll** | Any parent with `overflow: auto/scroll/hidden` scrolls | Partial — we listen to `window.scroll` only |

The structural insight: when one of these fires, the browser has already
done the layout work that caused it. Reading the rect at that point is
cheap — the engine has the new layout warm. Reading the rect on a scroll
frame when nothing fired is a forced reflow — the engine has to redo
layout to answer our question, then throws the answer away because
nothing was going to use it.

## Proposed Architecture

### Viewport-scoped lifecycle (new)

A single IntersectionObserver with a wide `rootMargin` (e.g.,
`'200% 0%'` — two viewport-heights above and below) defines the
*attention region*. Targets inside the region get wrappers, RO
subscriptions, and attribute-MO inclusion. Targets outside the
region get detached.

```
TargetLifecycleObserver
  observe(candidateRoot)           // a subtree to discover within
  // Internal:
  candidatePool: WeakSet<Element>  // hintable elements found by scan
  attentionIO: IntersectionObserver (rootMargin '200% 0%')

  // On candidate discovery (from scan or MO):
  //   if matches selector → add to candidatePool, attentionIO.observe(el)
  //
  // On IO entry:
  //   isIntersecting && !hasWrapper → attachWrapper(el)
  //   !isIntersecting && hasWrapper → detachWrapper(el)
```

This makes `pendingVisibility` obsolete:
- An initially-invisible element scrolled into the attention region
  has its IO entry fire with `isIntersecting: true` once it becomes
  visible (geometry-based check). At that point we run `scanSingle`
  on it once, not on every MO fire.
- An element that's still `visibility: hidden` while in the attention
  region but might become visible later: we observe with an attribute
  MO scoped to the candidate pool, not the global document. When its
  `class`/`style` changes, we re-check just that element.

The 8,081-element steady-state pending set becomes structurally
impossible because we never observe elements outside the attention
region.

### Single rect store

```
TargetRectStore
  rectFor(target) -> DOMRectReadOnly | null
  subscribe(target, cb)
  unsubscribe(target, cb)
```

One canonical cached rect per attached target. Reads return the cache.
Writes happen only when an observer fires for that target. Badge
`updatePosition` reads from the store, never directly from DOM.

### Observer router

```
LayoutSignalRouter
  attach(target) -> begins observing
  detach(target) -> stops observing

  // Internal:
  intersectionObserver         (one global, all targets)
  resizeObserver               (one global, all targets)
  ancestorScrollListeners      (per overflow-ancestor, refcounted by target)
  mutationObserver             (existing global MO, augmented)
```

When any signal fires, the router:
1. Determines the set of affected targets (from the entry's `target`
   for IO/RO, from `event.target` walked back to observed-ancestors for
   scroll, from MO records).
2. For each affected target, re-measures its rect (one
   `getBoundingClientRect` call, hitting the engine's warm layout).
3. Writes the new rect to TargetRectStore.
4. Notifies subscribers.

Badge subscribers respond by calling `updatePosition` with the new rect.
No global "reposition all visible badges" loop.

### Ancestor scroll chain

For each attached target, walk parents at attach time, identify
ancestors whose computed `overflow` (or `overflow-x`/`overflow-y`) is
`auto`, `scroll`, or `hidden` with constrained dimensions. Subscribe a
scroll listener on each, refcounted across targets. On detach,
decrement; when refcount hits zero, remove listener.

`document` and `window` count as the implicit root scroll containers.

This is exactly Floating UI's `getOverflowAncestors` walk.

### Position log relocation

The diagnostic position log (`pushPositionLog` in `hints.ts`) currently
does 4 raw `getBoundingClientRect` reads and 2 raw `getComputedStyle`
reads per badge per reposition — unconditionally, no debug gate. Under
the new model the production read path is structurally incapable of
forcing reflows, so the log has to move:

- Default: log entries record the cached rect at the moment of write
  (no extra reads).
- Debug mode (opt-in via dataset flag): log records a *fresh* live read
  for comparison. This is the only path in the codebase that's allowed
  to force a layout, and it only runs when explicitly enabled.

## What This Buys

Two compounding wins:

**Fewer items measured.** On a static page where the user is scrolling
past content that isn't layout-changing, the affected set per frame is
empty. Zero measurements. Today: full visible-badge sweep.

**Measurements happen on warm layout.** When an observer fires, the
engine already did the layout pass that produced the new geometry.
Reading the rect there costs the engine nothing extra. Today's
scroll-driven reads force the engine to redo work.

Expected impact on the existing perf harness counters:
- `boundingRectCalls`: dominated by observer-trigger measurement;
  proportional to (affected targets/frame), not (visible badges/frame).
- `computedStyleCalls`: same.
- `longtasks` (instrumentation we'd add): scroll frames stop appearing
  in long-task records on static pages.

## Regression Risk Analysis

This is the section that matters. Rango's model is battle-tested for
the link-hint use case; we are stepping off it. Here's what could go
wrong, ranked by likelihood and severity.

### High-risk

**1. `position: sticky` engaging or releasing.** When a sticky header
transitions from normal-flow to stuck (or back), no IO/RO/MO/scroll
event fires *on the sticky element itself*. Its size is unchanged, its
DOM is unchanged, its intersection state with the viewport is
unchanged. Today we re-read on every scroll frame and incidentally
notice. Under the new model we miss the rect change for that frame.

Floating UI's mitigation: when any observed ancestor scrolls, also
re-measure any target whose ancestor chain contains `position: sticky`.
We need the same. The ancestor-scroll chain walk should flag sticky
ancestors and force a re-measure of dependent targets when the chain
scrolls, even if no observer fired for the target itself.

**Detection plan:** add Playwright fixtures with sticky headers
(Slack-style stacked sticky, single sticky, sticky-bottom). Snapshot
badge positions every 100ms during scroll; alert on divergence between
old and new model.

**2. Missing an overflow ancestor.** The `overflow: auto/scroll/hidden`
walk has edge cases. CSS `contain: paint`, `contain: layout`, and
`will-change: transform` create new scroll containers. CSS
`transform: translateZ(0)` creates a containing block that can change
positioning behavior. If we miss one, badges inside that container go
stale when the container scrolls.

**Mitigation:** include the same containing-block heuristics as
Floating UI (checks `transform`, `perspective`, `filter`, `contain` in
addition to `overflow`). If we still suspect drift, add a rAF poll on
ancestors where we detected non-standard containing-block creation —
expensive but bounded to ambiguous cases.

**Detection plan:** the perf harness's `--url` mode plus a Rango-side-
by-side comparison on the top 20 sites we care about. Any persistent
badge drift after scroll-settle is a missed ancestor.

### Medium-risk

**3. CSS transition or animation on a target.** A button that animates
its position via CSS doesn't fire any layout signal. Today we have
`transitionend` / `animationend` listeners that schedule a deferred
reposition. We must preserve these under the new model — they become
inputs to the LayoutSignalRouter alongside the four observers.

**Mitigation:** wire `transitionend`/`animationend`/`scrollend` as
additional signals. Behavior should be at-least-as-good as today.

**4. `offsetParent` chain changes.** If a parent transitions from
`position: static` to `position: relative` via a class change, the
target's offset-parent shifts but the target's *own* size doesn't and
its intersection doesn't, so RO/IO don't fire. The global MO catches
the attribute change but currently only triggers `reevaluateAttribute`
for hintability, not reposition.

**Mitigation:** the MO attribute path needs to enqueue affected targets
into the reposition pipeline, not just the hintability pipeline. Cheap
to add; pre-existing infra.

**5. Compositor-only transforms.** `target.style.transform =
'translateY(...)'` driven by JS without a transition moves the element
without firing anything. Today this is *also* broken — `window.scroll`
doesn't fire either. Not a regression; preserves pre-existing gap.

**Mitigation:** optional rAF poll on a per-target opt-in basis. Default
off. Floating UI offers `animationFrame: true` as an explicit opt-in
for this exact case.

### Low-risk

**6. Subscription overhead.** Adding one RO + one IO subscription per
target costs memory. On pages with 1000+ badges, this is real. Browser
engines are tuned for this scale (TanStack Virtual demonstrates 10K+
observed elements with no issue), but worth measuring.

**Mitigation:** the existing IntersectionTracker already maintains a
per-target IO subscription, so the IO cost is already paid. The new
cost is the RO subscription. Measure on the perf-stress fixture.

**7. Latency increase on rapid scroll.** Observer callbacks dispatch on
a different schedule than scroll events. In rare cases there may be a
single-frame lag between scroll and badge reposition under the new
model. At badge sizes (12-20px), one frame of lag is invisible.

### Non-regressions (worth noting because intuition says otherwise)

- **Initial paint:** first IO observation fires with `entry.boundingClientRect`
  populated. Cache is warm on the very first cycle.
- **Hidden → shown:** RO fires when the element transitions from
  zero-size to non-zero. IO fires when intersection state changes from
  not-intersecting to intersecting. Existing `recheckPendingVisibility`
  path stays as-is.
- **Same-origin iframes:** both old and new model handle these via
  per-iframe content-script injection. No delta.

## Migration Plan

The doc proposes this as the end state, not as a single commit. Phasing
runs lifecycle first because that's where the YouTube smoking gun
lives; positioning second because it builds on the lifecycle work.

**Phase 1: Instrument (DONE).** Long-task observer + per-hot-path
wall-clock on the perf bridge. The CPU buckets in `buildPerfSnapshot`
were what surfaced `recheckPendingVisibility:size:1000+` and made the
lifecycle gap visible.

**Phase 2: Viewport-scoped lifecycle (DONE — `0b938d3`).** Shipped
`src/observe/attention-observer.ts` as `AttentionObserver` (not
`TargetLifecycleObserver` as originally named — same role). Wired
into content.ts:

- `observeInvisibleCandidates` rewritten to route candidates through
  the attention observer; `pendingVisibility` no longer grows with
  document candidate count.
- `discoverInSubtree` no longer eagerly attaches wrappers for
  MO-discovered subtrees — calls `attentionObserver.observe(ref)`.
  The IO's `onEnter` runs `scanSingle` and attaches if hintable.
- `attachWrapper`/`detachWrapper` subscribe/unsubscribe the attention
  observer so leave-detach applies uniformly across all wrappers
  (including initial-scan eager-attached ones — initial scan kept its
  eager path to preserve badge-on-load UX).
- `onLeave` detaches the wrapper and drops pendingVisibility
  membership, with `schedulePushGrammar` for delta-sync.

Two-IO model (kept tracker + attention separate):
- `IntersectionTracker` (existing, `rootMargin: '200px'`) drives
  codeword claim/release — "you-are-interactive."
- `AttentionObserver` (new, `rootMargin: '200%'`) drives wrapper
  attach/detach + pendingVisibility membership — "you-are-a-candidate."

Outcome matched the predicted signals (see Status table above).
Two anticipated wins didn't fully land:
- `recheckPendingVisibility` bucket is *bounded* but not *gone*.
  Eliminating it requires the "purest observer-source" model (IO
  geometry-change replaces visibilityMO).
- `scanSingle calls` dropped 90% (1.1M → 105K) but not to <100/s — the
  bounded-but-present pendingVisibility set still gets walked.

**Phase 3: TargetRectStore + LayoutSignalRouter alongside existing
positioning.** New system writes to a shadow rect store but doesn't
drive positioning yet. Compare cached rect against live
`getBoundingClientRect` on a sample interval; alert on divergence.

**Phase 4 (re-scoped — see "Course correction").** The standalone
flag-gated cutover is dropped: with the sweep writing the store right
before placement, it's behaviorally inert. The cutover only matters
folded into Phase 5.

**Phase 5b: Done (`9edd979`).** `scroll-ancestor-tracker` + write-on-paint;
the store stays warm through inner-pane scroll on the Firefox nesting path.

**Phase 5: Deferred — blocked on ancestor geometry.** See "Cutover blocker"
above. With 5b landed the store is warm, but making placement *read* from it
doesn't delete the sweep: `placeBadges` still needs ancestor rects/styles/dims
that the store doesn't cache. The real cutover requires a full
`LayoutSignalRouter` (ancestor geometry + invalidation), not a read-routing
swap — a separate, larger design. Decision (2026-05-30): land 5b, defer the
cutover. When that router is designed, the original parity bar still applies:
run the Playwright fixture suite (sticky, overflow-ancestor, transition,
plain) and three real sites; require pixel parity before deleting the sweep.

**Phase 6: Relocate position log.** Default path reads from cache;
debug path opts in to live reads.

## Open Questions

- Do we keep `transitionend`/`animationend`/`scrollend` as router
  signals, or replace them with the rAF-poll opt-in? The former is
  cheaper; the latter is more general. Probably both: signals for
  known cases, opt-in poll for unknown ones.
- Does the existing `IntersectionTracker` become the LayoutSignalRouter,
  or do they coexist? The IntersectionTracker has plugin-protocol
  responsibilities (claim/release codewords); the router is purely
  about layout. Probably separate, with the router observing the same
  IO instance the tracker already maintains.
- CSS Anchor Positioning is the long-term trajectory (Chrome 125+).
  Should the store be designed so that "delegate to platform" is a
  drop-in for Chromium when available? Probably yes; the abstraction
  cost is zero. **Update (2026-05-30):** prototyped and validated —
  follows inner-overflow scroll with zero JS (see "Course correction").
  Now a concrete fork in the plan, not a hypothetical. Open sub-question:
  do badges in *closed* shadow roots (our hint hosts) reach a light-DOM
  `anchor-name`? `_test-anchor-shadow.mjs` exists to answer this; result
  not yet recorded here.

## Placement staleness: the anchor binding outlives the target (2026-05-31)

This section is the design for the YouTube "scroll down, scroll back up,
badges hang ~200px above their titles" bug, and it adjusts a load-bearing
assumption in the "Anchor-first architecture" section above.

### What the bug actually is

A real signed-in Firefox snapshot (scroll down five viewports, scroll back,
capture) decomposed every in-viewport badge into inner-vs-host and
host-vs-target offsets, using the new `positioningMethod`/`scrollSensitive`/
`geometryDependent` labels on the debug snapshot:

- **23 of 24 stranded badges are on the `anchor` path**, not the nesting
  path. Only one was nesting (a band-edge case). The earlier working theory
  — "this is the doomed Firefox nesting path failing to JS-reposition" — is
  wrong. These tiles are not under a fixed ancestor and Firefox here supports
  `anchor()`, so they ride the same anchor fast-path Chromium uses.
- In every stranded case `inner − host = 0` (the badge sits exactly on its
  host) and the entire error is `host − target`: e.g. a 0×0 anchored host at
  `y=208` while the target rect is at `y=6`. The host is pinned to where the
  target *used to be* before the scroll-back reflow; the target moved and the
  host did not follow.

A correctly-bound, live anchor cannot be 200px off — per spec the compositor
keeps `top:anchor(top)` glued to the anchor element's current box. So the
anchor relationship is **broken**, not merely lagging.

### Why this contradicts "tracking is free"

The "Anchor-first architecture" section asserts the compositor tracks the
target "through every overflow ancestor natively, so tracking is free." That
is true for **position** changes of a **stable node**. It is not true across a
change of **target identity**. The anchor relationship is carried by a single
inline `anchor-name: --bk-N` written **once** onto the target element at badge
construction (`hints.ts` ~568). YouTube's viewport virtualization destroys and
rebuilds the rows above you on scroll-back; the rebuilt tile is a *new* DOM
node that never received that inline style. The host's `position-anchor:--bk-N`
now references a name that lives on a detached/dead node (or no node), so
`anchor()` falls back to a static-ish position inside `ytd-page-manager` and
the badge strands.

This is a fifth blind spot the "Four Layout-Change Signals" table does not
cover. The four signals all assume the target node *persists* and we are
tracking its geometry. None fires for "the node carrying my anchor binding was
replaced by an equivalent node, in place, with no scroll/resize and without
removing my host." It is the placement-layer twin of the lifecycle gap the
reconciler closed for *existence* — see
[[notes/DESIGN_HINT_LIFECYCLE_RECONCILER.md]].

### Why none of the existing repair paths catch it

Two repair mechanisms exist today and both miss this case structurally:

1. **`badgeReattachObserver`** (`content.ts` ~976) fires when *our badge host*
   is removed from the DOM. On the nesting path the host is physically nested
   in the target's container, so a rebuild removes it and this fires. On the
   anchor path the host is mounted at `document.body`; virtualization rebuilds
   tiles inside `ytd-page-manager`, never touching body, so our host is never
   removed and this observer never fires.
2. **Limbo rebind** (`rebindWrapper`/`retarget`, `content.ts` ~2686) re-applies
   `anchor-name` to a replacement node — but it is triggered by the wrapper's
   `.element` going **disconnected** (limbo on disconnect, rebind when a
   fingerprint match reappears). In this bug the wrapper's `.element` reads as
   connected and correctly placed at `y=6`; the desync is purely between the
   host's frozen anchor and the live target. Whatever swap happened did not
   route through the disconnect→limbo→rebind path, so the anchor-name was never
   re-asserted.

The honest gap: there is **no signal** today for "a present, connected target's
identity or position changed underneath a body-mounted anchored host."

### Open sub-question to nail before coding (one snapshot field away)

I cannot fully distinguish two sub-mechanisms from a single snapshot, and the
remediation primitive differs between them:

- **(A) Dangling binding (node recreation).** The current `w.element` no longer
  carries the `anchor-name` the host references (it was recreated). Fix: re-assert
  `anchor-name` on the live target; `anchor()` re-resolves; cheap.
- **(B) Firefox fails to re-resolve `anchor()` on this reflow even with an intact
  binding.** Then the binding is fine and re-asserting it does nothing — the badge
  needs a forced anchor re-resolution (toggle the property) or a fall-through to
  JS absolute placement for that badge.

Disambiguation is one debug-snapshot field: for each anchor badge, record
whether `w.element`'s computed `anchor-name` still equals the host's
`position-anchor` name (`bindingLive: boolean`). `false` ⇒ (A); `true` ⇒ (B).

**RESOLVED 2026-05-31 — it is (A).** A re-capture with the `bindingLive` field
(`…/snapshots/2026-05-31T19-11-01-213Z/snapshot.json`) shows all 3 genuinely
stranded badges (parked at the document origin, `badge_y ≈ -12246` while their
targets sit at `y=802`/`1158`, deep in the feed at `scrollY≈12246`) are
`positioningMethod:'anchor'` with **`bindingLive:false`** — every one. The
target nodes were recreated by virtualization and never received the
`anchor-name`, so `position-anchor` references a dead name and `anchor()` falls
back to the document origin. (`bindingLive:true` badges in the same capture were
only ~16px off — placement noise, not stranding.) So the remediation is the
cheap one: **re-assert `anchor-name` on the live target** via the existing
`retarget`/`reposition` primitives; no forced re-anchor or JS fallback needed.
The detector below is still required — it is what notices the dangling binding,
since nothing else fires.

### Proposed design: a level-triggered placement reconcile

Mirror the lifecycle reconciler on the placement axis. The lifecycle reconciler
converted edge-triggered existence mutation into one level-triggered pass that
asks "for each wrapper, should a badge exist, and does it?" The placement
reconcile asks the analogous question for *position*: **"for each badge that
should be on screen, is it still glued to its target, and if not, re-glue it."**

- **Scope:** the visible/hinted set only — never the whole store. Per-wrapper
  `getBoundingClientRect` over the full store is the wedge cliff
  ([[wedge-fix-load-bearing]]); honoring it is non-negotiable. The attention
  region already bounds the candidate set; the reconcile reads only badges whose
  targets are in (or near) the viewport.
- **The check (read phase, batched):** for each in-band anchored badge, compare
  the live target rect to where the badge actually sits (host rect, or the
  target's `anchor-name` liveness per the disambiguation field). Read all first,
  then act — no interleaved read/write that re-triggers layout per badge.
- **The repair (write phase):** for a stale badge, re-assert `anchor-name` on the
  live target and re-bake the offset (`updatePosition`), i.e. reuse the existing
  `retarget`/`reposition` primitives without requiring a disconnect. If sub-cause
  (B) is confirmed, add the forced-reanchor or JS-fallback primitive then.
- **Trigger — the genuinely new part.** The check needs a clock, because the
  defining property of this bug is that *no DOM signal fires*. Options, in order
  of preference:
  1. **Fold into the existing reconcile pass** ([[notes/DESIGN_HINT_LIFECYCLE_RECONCILER.md]]),
     which already runs level-triggered on the signals we do catch (scroll-settle,
     mutation-settle, claim changes). Add a bounded placement check to the same
     pass. Cheapest; no new standing cost; but it only re-checks when *something*
     triggered a reconcile, so a pure silent virtualization with no follow-on
     signal could still lag until the next scroll-settle. Likely good enough
     because scroll-back is itself a scroll, which already schedules a settle
     reconcile.
  2. **Floating-UI-style `autoUpdate` opt-in:** a bounded `requestAnimationFrame`
     poll over the visible anchored set while the page is actively scrolling,
     stopping on scroll-idle. This is exactly the "compositor-only / unobserved
     change" escape hatch Floating UI ships as `animationFrame: true`, and the
     "Reference Architecture" section already anticipates it. More robust, but a
     standing per-frame cost — must be gated to scroll-active windows and the
     visible set, or it reintroduces the very per-frame reflow this whole doc set
     out to kill.

  Recommendation: implement (1) first (a scroll-settle reconcile already exists
  and scroll-back always produces a scroll), measure against the deterministic
  repro, and only add (2) if a class of silent swaps still slips through.
- **Where it lives:** the reconcile module (`lifecycle/reconcile.ts` decision +
  `content.ts` execution), not `hints.ts`. `HintBadge` keeps its
  `retarget`/`reposition`/`reattach` primitives; the reconcile decides *which*
  badges need them. This keeps placement decisions in one level-triggered place
  rather than scattering another edge-triggered observer.

### What this does to the anchor-first plan

It does **not** revive the nesting path or the `LayoutSignalRouter`. "Delete the
nesting path and unify on `anchor()`" stays the trajectory — but with a correction:
unifying on `anchor()` is necessary but **not sufficient**. The anchor model needs
one companion guarantee the doc previously assumed the platform gave us for free —
*the binding must survive target re-creation* — and the only portable way to
guarantee that is a level-triggered placement reconcile over the visible set. So
the placement reconcile is not legacy-path investment; it is the missing piece that
makes the anchor model actually correct on virtualizing pages, on both engines.

### Scope and non-goals

- In scope: re-gluing present, in-viewport anchored badges whose target identity
  or position changed without a caught signal.
- Not in scope here: occlusion/overlap avoidance (a separate placement gap), the
  clipping open question (`position-visibility`), and off-screen badges (lifecycle
  reconciler territory).
- Guardrails: the deterministic repro should become a scripted Playwright check
  (extend `scripts/_test-scroll-back-drift.mjs` to assert zero stranded anchored
  badges after scroll-back on a signed-in-equivalent fixture); the wedge test
  (`_test-videos-tab-wedge.mjs`) and leak sweep must stay green; re-verify the
  wedge does not return.
