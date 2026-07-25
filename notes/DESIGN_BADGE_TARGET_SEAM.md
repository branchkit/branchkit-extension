# One badge, two anchors — the BadgeTarget seam and badge variants

**Status:** DESIGN + IMPLEMENTED (staged), 2026-07-25. Supersedes the hand-rolled
chip painter in `activate/range-disambiguation.ts`.

## The problem

`select_to` ("highlight <phrase>", "select to <phrase>") paints a codeword chip at
each text match so the user can pick one by voice. `paintChip` is a second badge
implementation: its own shadow host, its own inline pill CSS, its own positioning
(once, in document coordinates), its own mid-pair highlight. It shares nothing with
`HintBadge` but the idea. Two artifacts drifting in parallel is exactly the coupling
we don't allow — the chips get none of the badge settings (size slider, per-site
size override, display mode), none of the placement model, and none of the
reconciler.

The goal: chips ARE badges. One implementation, one stylesheet, one positioning
model. What differs is anchoring (a Range, not an Element) and how the set narrows
mid-codeword.

## Verification of the inherited claims

A prior session produced a hypothesis. Re-derived from the code; four of seven hold,
three are wrong or materially incomplete. The corrections are what shaped the design.

### Claim 1 — "`HintBadge` reads its target's rect in exactly two places" — **WRONG (four, not two)**

Every `this.target` use, classified:

| Site | Concern |
|---|---|
| `reconcileRead` (hints.ts:604) | **rect** — live `getBoundingClientRect()` |
| `updatePosition` (hints.ts:793) | **rect** — `getCachedRect()`, bakes the offset |
| `resolveContainer` (constructor, retarget) | **rect** — `getCachedRect(target)` inside `getSpaceInAncestor` |
| `targetOverVideo` (show) | **rect** — `el.getBoundingClientRect()`, overlap fraction |
| `computeBadgeFontSize`, `computeBadgeColors` | computed style + ancestor walk |
| `hasViewportPinnedAncestor`, `findTransformedAncestors`, `findScrollableAncestor(s)`, `createScrollAccel` | ancestor walk |
| `calculateZIndex` | descendant + ancestor walk |
| `clipRootOf`, `trackTargetMutations`, `isConnected`, `tagName`, `scroller.contains` | element identity |

The claim listed `targetOverVideo` under "ancestor-walk / element-identity
concerns". It is neither — it is a pure rect-overlap test that never looks at an
ancestor. `resolveContainer` was missed entirely.

Consequence: a two-member seam (`{ element, rect() }`) would have left two rect
reads silently answering for the *container* instead of the range — the video gate
measuring a whole paragraph's overlap, and container resolution measuring the
paragraph's left/top space. Both are quiet wrongness, the kind that survives review.

Second correction, and the sharper one: **the two placement-path rect reads are
deliberately different reads.** `reconcileRead` takes a LIVE rect (it runs inside
the batched read pass and must see this frame's layout). `updatePosition` takes the
pass-consistent CACHED rect, because `placement/position.ts` computed the candidate
against that same snapshot — the comment at position.ts:122-151 exists because
mixing a live text rect with a cached element rect once baked a reflow delta into
the offset and stranded badges ~200px off target. A single `rect()` collapsing both
would reintroduce that class of bug. The seam therefore exposes both bases by name.

### Claim 2 — "a Range's containing element is a valid answer for every non-rect concern" — **HOLDS, with one hard exception the claim missed**

The geometric half is sound. For a range inside one text node — the overwhelming
case for a phrase match — `commonAncestorContainer` is that Text node and its
`parentElement` is the inline element actually containing the text. Its scroller,
stacking context, clip root, font, and color are the range's, exactly.

Counterexamples hunted, per the brief:

- **Range spanning multiple blocks.** The container climbs to a common ancestor. Its
  scroller is then an *ancestor* of the range's own — the range's nearest scroller
  could be an element between the text and the container. This only bites the
  scroll accelerator, which is non-load-bearing by contract (scroll-accel.ts's
  safety contract): the reconcile base reads the live *range* rect every pass, so
  position stays correct; worst case the wiggle returns. Degrades, never breaks.
- **Ranges inside transformed inline elements.** Mostly vacuous: `transform` does
  not apply to non-replaced inline boxes. A span that IS transformed has
  `display:inline-block` or similar — and then it is the range's container, so
  container and range agree by construction.
- **Ranges crossing element boundaries** (`<b>foo</b><i>bar</i>` inside a `<p>`):
  container is the `<p>`; scroller/stacking/clip identical. Fine.
- **Font and color from the container** are *more* accurate for a range than for an
  element target: `computeBadgeColors` already walks to the first visible text node's
  parent to find the color the user actually sees (badge-colors.ts:261). A range's
  container IS a text container. The one degradation is a multi-block range, where
  the walk finds the first text node in the whole container rather than in the range.

**The exception the claim missed: shared per-element registries.**
`trackTargetMutations` is keyed 1:1 by Element with an unconditional
`observers.delete(target)` on untrack (target-mutation-tracker.ts:82) — it is NOT
refcounted, unlike `trackContainerResize`. "Highlight <link text>" puts a chip whose
container is a hinted `<a>` that already has its own badge. The chip's teardown would
then disconnect the *link badge's* mutation observer, silently. That is a real
cross-talk bug, and it is decisive for the observer question below (deliverable 2):
chips must not register target-mutation tracking. Not "shouldn't, for cost" —
*must not, for correctness*.

### Claim 3 — the seam shape — **RIGHT SHAPE, WRONG ARITY**

`{ element, rect() }` becomes:

```ts
export interface BadgeTarget {
  /** Ancestry, style, colors, stacking, scrollers, DOM identity. For an element
   *  badge this IS the target; for a range badge it is the range's container. */
  readonly element: Element;
  /** Live viewport rect — the batched reconcile read pass. */
  rect(): DOMRect;
  /** Same basis placement used for the candidate, so the baked offset can't
   *  absorb a reflow delta. Elements read the layout cache; Ranges re-read live
   *  (the cache doesn't extend to Ranges — position.ts:57). */
  placementRect(): DOMRect;
}
```

Plus one refactor that removes a rect read from the seam's scope entirely:
`targetOverVideo(el)` → `rectOverVideo(rect)`. It only ever wanted the rect; taking
an Element was incidental. `resolveContainer` keeps the element rect, documented:
it feeds only the container-resize tracker's choice of anchorParent (hosts are
body-mounted), and chips don't take that tracker.

### Claim 4 — "`ReconcileBadge` is genuinely decoupled" — **HOLDS**

`reconcile-positioner.ts:37` requires `reconcileRead(): {host,x,y,targetRect} | null`
and nothing else. A Range-backed badge joins the registry with no changes.

### Claim 5 — "chips are positioned once and strand on layout shift" — **HOLDS, and the obvious fix does not work**

Confirmed: `paintChip` writes `left/top` once in document coordinates, no reconciler,
no observers, and the pick window is now unbounded. A lazy image loading above the
matches strands every chip.

But joining the reconcile registry is **not sufficient**, and this is the trap:

- `SettleEngine.scheduleReposition()` early-returns on `!isBadgesVisible()`
  (settle-engine.ts:759).
- A pick calls `pickWindowHooks.hideBadges()`, which sets
  `pageSession.badgesVisible = false` (content.ts:1638).

So during a pick the settle-driven reconcile pass is dead — exactly when the chips
are the only visible badges. The scroll path (`noteReconcileScroll`) gates on
registry size, not visibility, so scroll-driven drift *would* be fixed by
registration alone; layout-shift drift would not.

Fix: `scheduleReposition` gates on `reconcileRegistrySize() === 0`, the same
predicate `noteReconcileScroll` already uses. This **retires** a gate rather than
adding one (the sensing freeze cuts the right way). Cost when badges are hidden:
`reconcileRead` short-circuits on `_visible` before any `getBoundingClientRect`, so
the pass is N property checks and zero writes.

### Claim 6 — "three independent dark rounded pill implementations" — **CONFLATES TWO FAMILIES**

There are **two codeword-badge pills** (`BADGE_CSS`, `paintChip`'s inline cssText) —
that is the duplication, and step 3 deletes one of them.

`mode-chip.ts` and `toast.ts` are a *different* family: viewport-fixed chrome, not
page-anchored badges, already sharing one palette with each other
(`#1c2128`/`#3d444d`/6px radius) deliberately — toast.ts:6 says so. They have no
anchor, no label, no target, no reconciler. Folding them into `BADGE_CSS` would
couple two things that share only a border-radius. The prior session's verdict on
mode-chip is right; its reasoning ("it's a status indicator") applies to toast too,
which the claim didn't notice.

### Claim 7 — "mid-pair feedback folds into one variant parameter" — **HOLDS**

Two axes, both real:

| | link hints | range chips |
|---|---|---|
| a badge that can't complete the prefix | `setFiltered(true)` → `display:none` | opacity 0.25 |
| the already-spoken prefix on one that can | `.bk-matched` → opacity 0.35 | first letter gold `#ffd60a` |

The divergence is coherent, not accidental, and the two axes are coupled by one
fact: **hints hide the non-candidates, so what remains on screen IS the answer;
chips keep them, so a positive marker is needed to say which one is live.** With
hundreds of hints, hiding declutters. With ≤9 chips answering "which of these
places?", hiding would delete options from a question already asked — and the chips'
spatial arrangement IS the question. So chips dim and accent; hints hide and fade.

Chips then inherit `setMatchedChars`'s general implementation: arbitrary prefix
lengths and the letter/word/expand display modes, instead of `charAt(0)` hardcoded
for exactly two words.

## Colour: chips take the hint palette (change from the original brief)

The original plan kept the chips' black/white palette as carried meaning ("this is a
text-range question, not a link"). Dropped, at the user's call and for a better
reason than aesthetics: a fixed `rgba(20,20,24,0.92)` chip is invisible on a dark
site, and it is the *only* badge in the extension that doesn't adapt.

`computeBadgeColors` resolves the page background behind the target and tunes the
foreground with APCA (badge-colors.ts) — on a dark page the chip becomes
dark-on-light-text automatically. And for a range it is *more* accurate than for an
element target, because the reference-element walk it already does is exactly "find
the text the user sees".

The meaning the palette was carrying doesn't need carrying: while a pick is pending,
every regular badge is hidden. There is no other badge on screen to be confused with.
The mode carries the meaning; the chips don't have to.

Net: **colour stops being a variant axis at all.** Chips are visually identical to
link badges except during mid-pair narrowing.

## The variant

```ts
export interface BadgeVariant {
  /** A badge that can't complete the current prefix: hidden, or dimmed in place. */
  readonly nonCandidate: 'hide' | 'dim';
  /** The already-spoken prefix on a badge that CAN complete. */
  readonly matchedPrefix: 'fade' | 'accent';
  /** Accent colour for 'accent'. */
  readonly accent?: string;
  /** Register the page-mutation-defence observers? (container resize, target
   *  mutation, host-attribute defender) */
  readonly observePage: boolean;
  /** Suppress paint when the anchor sits mostly over a playing video? */
  readonly suppressOverVideo: boolean;
}
```

Two presets, `HINT_VARIANT` and `RANGE_PICK_VARIANT`. Both visual axes are CSS
classes in the one shared `BADGE_CSS` sheet — no inline style forks, which is what
actually kills the second pill implementation.

**Is `BadgeVariant` the right abstraction?** Yes, and a strategy object would be
worse. Every field is a two-valued choice that resolves to a class name or a
boolean; a strategy object would wrap five booleans in five closures and put badge
rendering behind an indirection with two implementations forever. The one thing that
justifies grouping them in a single object rather than five constructor params is
that they all derive from ONE fact — persistent ambient badge vs transient
authoritative chip — so they must move together. That is the anti-dual-sync
argument, and it's why lifecycle posture (`observePage`, `suppressOverVideo`) lives
in the same object as the visual axes rather than in a parallel options bag.

## What chips inherit, and what they opt out of

**Inherit** (the point of the exercise): shadow-host construction, `BADGE_CSS`,
APCA colours, the badge size slider + per-site size override + display mode, the
placement nudge model, the reconcile registry, the inner-scroll accelerator, `flash()`,
`setMatchedChars` for all display modes.

**Opt out, with reasons:**

- **`refine()`'s observers — out.** Decisive reason is the 1:1 keyring collision in
  claim 2, not cost. Secondary: the sensing freeze forbids adding observers, and a
  seconds-long badge outlives nothing. Note the *z-index* half of `refine()` is NOT
  optional — without it the host has `z-index:auto` and a sticky header covers the
  chips. So `refine()` splits: stacking always, observers behind `observePage`. And
  because deferral exists solely to amortise the observer dance, an observer-less
  variant refines inline — one line, and the chip has its stacking on the first frame.
- **Occlusion filtering — out, for free.** `applyOcclusion` is only ever called by
  the settle applier over store wrappers and by the clip IO. Chips are in neither, so
  they receive nothing; no code required. They *should* be out: hiding a chip because
  a sticky header overlaps its text would silently drop an option from a question
  already asked, and `rangesInViewport` deliberately skips occlusion for the same
  stated reason (range-disambiguation.ts:100-106). Consistent by accident, now on
  purpose.
- **Video gate — out (`suppressOverVideo: false`).** The gate exists for Firefox
  compositor churn under hundreds of badges re-painting per SPA advance. Nine static
  chips for a few seconds is not that. And its failure mode is wrong here: the
  codeword stays live while the paint is suppressed, so the user is asked to pick
  from options they can't see.
- **Inner-scroll accelerator — IN.** It's the same machinery, correct for a range
  (as the pane scrolls, the range rect and the scroller's `scrollTop` move in
  lockstep exactly as an element's do), non-load-bearing when it goes stale, and a
  no-op on Firefox. Turning it off would be a fork with nothing to gain.
- **Per-domain nudge rules — out.** They're authored against element selectors;
  a text range has no selector. The font-size nudge buckets still apply.
- **Keyboard-typed prefix filtering — out.** `setFilterCallback` narrows the store
  only. A pick is voice-driven by construction (it exists because a dictated phrase
  was ambiguous); wiring the keyboard path is a separate question.

## `BadgeHandle` — unchanged

`retarget(newEl: Element)` stays element-typed. Retargeting is a *wrapper identity*
operation (DESIGN_WRAPPER_IDENTITY_STABILITY step 4): a React re-render swaps the
DOM node behind a logical element. Ranges have no such identity — a pick that goes
stale is torn down and re-armed, never rebound. Generalising `retarget` to
`BadgeTarget` would widen an interface for a case that cannot occur. It wraps
internally (`this.target = elementTarget(newEl)`) and the seam stops there.

## Staging

1. **The seam.** `BadgeTarget` + `elementTarget()`; `HintBadge` takes one;
   `targetOverVideo` → `rectOverVideo(rect)`; drop the write-only `category` field
   (dead since construction). Pure refactor, zero behaviour change.
2. **The variant.** `BadgeVariant` + two presets, classes in `BADGE_CSS`,
   `setFiltered`/`setMatchedChars`/`refine`/`show` consult it. Hints unchanged by
   default.
3. **Chips.** `rangeTarget()`, chips construct real badges, `paintChip` and its
   inline CSS deleted, `scheduleReposition` gate retired.

Step 3 is the only one that can regress link hints, so it lands with 1 and 2 green.

## Risks

- **Cost per chip rises** from ~0 to a badge construction (shadow root, APCA walk,
  stacking walk). Bounded at 9, one-shot, off the input path — the pick already
  paid a `publishRecords` round trip.
- **`calculateZIndex` walks `target.querySelectorAll('*')`.** For a multi-block
  range whose container is a large article, that's a wide walk. Bounded by 9 chips
  and cached per anchorParent, so co-located chips pay it once.
- **A multi-block range's container is coarse** for font, colour, and scroller.
  Accepted: it degrades toward "looks like a badge on the surrounding block", never
  toward mispositioning (the rect is always the range's).
- **The `scheduleReposition` gate change** makes the settle path run a reconcile pass
  whenever badges exist, hidden or not. Free by construction (`reconcileRead`
  short-circuits before any layout read), but it is a hot-path edit and worth
  watching in the settle-storm diagnostic (`lastReconcileChangedWrites`).
