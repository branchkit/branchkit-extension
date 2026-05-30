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
| 4 | Flag-gated cutover of `updatePosition` reads | Re-scoped — see "Course correction" |
| 5 | Delete global rAF reposition sweep | Re-scoped — see "Course correction" |
| 5b | Overflow-ancestor scroll listeners | **Hard** — but CSS Anchor Positioning sidesteps it on Chromium (see "Course correction") |
| 6 | Relocate position log to read from store | Ahead |

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

Sequencing decision is deferred to the user. The realistic options are:
(a) build Phase 5b + the combined 4/5 cutover for a correct cross-browser
store path, or (b) land the Chromium CSS-anchor fast-path first (it
removes the inner-pane pain on the majority browser and de-risks 5b by
shrinking its scope to Firefox-only). Either way the standalone,
flag-gated Phase 4 is not worth building.

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
`src/attention-observer.ts` as `AttentionObserver` (not
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

**Phase 5: Cut reads to the store AND delete the global rAF reposition
sweep, together.** Make placement read target rects from
`TargetRectStore` and remove the `scheduleReposition` blanket handler +
its `cacheLayout` warmup. Requires Phase 5b first (the store must be
warm for inner-pane scroll before the sweep that currently covers that
case is removed). Run the Playwright fixture suite (sticky, overflow-
ancestor, transition, plain) and three real sites; require pixel parity
before deleting the sweep.

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
