# Inner-Scroll Accelerator (scroll-timeline, non-load-bearing)

**Status:** Proposal (2026-06-09). Not yet implemented. Flag-gated, Chrome/Safari
first, with a transparent fallback to today's behavior everywhere else.

Fixes the inner-overflow-scroller wiggle (QuickBase data-table grids) by riding
the inner scroller on the **compositor** via a CSS scroll-driven animation,
while keeping the badge body-mounted. See `DESIGN_HINT_POSITIONING_REARCH.md`
("residual case (b)") for the problem and the decision trail.

## The safety contract (the whole point)

The positioning re-architecture exists because the old anchor/nesting model
**depended on page-owned node state that hostile pages strip/recreate**, and
used **edge-triggered bindings assumed to persist** — causing ≥9 reverts. This
feature must NOT re-import either failure. The contract:

1. **Non-load-bearing.** The reconcile base remains the single source of truth
   and is UNCHANGED. A badge's *correctness* never depends on the scroll
   timeline. The timeline only suppresses the wiggle when healthy.
2. **Level-triggered.** Timeline health is re-validated on **every reconcile
   pass** — never set-and-forget. The reconcile model already reads live target
   state each pass; the accelerator joins that discipline, it does not bypass it.
3. **Graceful degradation.** If the timeline is absent (Firefox stable), broken,
   or its scroller is recreated, the badge **falls back to the existing JS-chase**
   on the very next pass. Worst case = today's wiggle returns. Never a dangle,
   never a scroll-off-the-page.
4. **No page-DOM writes.** We write nothing onto the page's elements (no
   `anchor-name`, no nesting). The timeline references the page scroller only as
   a read-only JS `source`. Nothing for a page to strip.

If any of these can't hold, stop — we'd be re-entering the trap.

## Why this satisfies the original constraints

- **C1 (binding robustness):** base stays body-mounted reconcile — untouched.
  The only new coupling is a JS *reference* to the scroller for the timeline
  `source`; it's read-only, the scroller is more stable than the target
  (survives row virtualization), and a stale ref degrades to the chase (contract
  3), not a dangle.
- **C2 (cross-browser):** transient. Firefox stable lacks `ScrollTimeline` →
  feature-detect → fallback to chase (identical to today). Closing gap (Firefox
  has it in Nightly; Safari 26 ships it), converges to one model.
- **C3 (perf):** neutral-to-better. Accelerated badges keep getting the cheap
  invariant base write from the chase (safety net); the compositor handles the
  visible motion. A later optimization can skip the chase reflow for healthy-
  accelerator badges, but v1 keeps the chase running as the always-correct base.

## The decomposition

For a flow target inside an inner scroller, the badge must sit at
`docY0 - S(t)`, where `docY0` = its document position when the scroller is at
scroll 0, and `S(t)` = the scroller's live `scrollTop`.

- **Base** (reconcile, on the body-mounted `host`): `host.transform =
  translate(docX, docY0)`. Recompute each pass as `rect.top + scrollY +
  offset.y + scroller.scrollTop`. This is **scroll-invariant under inner scroll**
  (as the pane scrolls, `rect.top` drops by ΔS while `scrollTop` rises by ΔS —
  the sum is constant), exactly like document coords are invariant under window
  scroll. So the chase writing it every frame is harmless.
- **Delta** (compositor, on the shadow's `outer` element): a `ScrollTimeline`-
  driven animation providing `translateY(-S(t))`. Net = `docY0 - S(t)`. ✓

Two transforms on two elements (`host` base, `outer` delta) — no property
collision.

### Mode selection (per pass, health-gated)

`reconcileRead()` branches on `this._scrollAccel?.healthy()`:

```
if accelerator healthy:
    y = rect.top + scrollY + offset.y + scroller.scrollTop   # scroll-0 base (docY0)
else:
    y = rect.top + scrollY + offset.y                        # current pos (chase owns motion)
```

Healthy → base is `docY0`, animation supplies `-S` → smooth. Broken/absent →
base is the current position, no animation → correct + wiggly (today). The
switch is evaluated every pass, so a timeline that silently dies self-heals to
the correct (wiggly) base immediately.

## Mechanism

```js
const timeline = new ScrollTimeline({ source: scroller, axis: 'block' });
const max = scroller.scrollHeight - scroller.clientHeight;
const anim = outer.animate(
  [{ transform: 'translateY(0px)' }, { transform: `translateY(${-max}px)` }],
  { timeline, fill: 'both', duration: 1 }   // Firefox needs a non-zero duration
);
```

At scroll progress `p = S/max`, the interpolated transform is
`translateY(-p*max) = translateY(-S)`. Composited, no main-thread work.

- **`max` changes** as content loads/reflows → re-create the animation with the
  new keyframe. Detect via the scroller's `ResizeObserver` (already have resize
  observers) or by comparing `max` on the per-pass health check.
- **Axis:** v1 handles `block` (vertical) — the QuickBase grid case. Horizontal
  (`inline`) is a second timeline/animation on `translateX`; **deferred** (note
  it; grids that scroll both axes get vertical smoothing, horizontal stays on
  the chase).

## Scroller detection

`findScrollableAncestor(el): Element | null` — walk ancestors (pierce shadow
boundaries), return the nearest with `overflow-y` in `{auto, scroll}` AND
`scrollHeight > clientHeight`. **Exclude** `documentElement`/`body` (window
scroll, already ridden by the absolute host). Null → no accelerator → chase.
Pure and unit-testable.

## Lifecycle (on `HintBadge`)

New field: `_scrollAccel: { scroller, timeline, anim, max } | null`.

- **Setup** — in `updatePosition` (offset baked) / `show`: if flag on AND
  `ScrollTimeline` supported AND `findScrollableAncestor` returns a scroller →
  create timeline + animation; else leave null (chase). (See the 2026-06-09
  revision below: the original "AND target is NOT viewport-pinned" clause was
  dropped — the inner scroller is the sole gate.)
- **`healthy()`** — `_scrollAccel != null && scroller.isConnected &&
  findScrollableAncestor(target) === scroller`. Called from `reconcileRead`
  each pass. False → fallback base, and flag for re-setup at next settle.
- **Re-setup / recompute** — at settle (not per frame): if `max` changed,
  re-create the animation; if the scroller changed, tear down + re-detect.
- **Teardown** — `hide()` / `remove()` / `retarget()`: `anim.cancel()`, drop
  the timeline, null `_scrollAccel`. `retarget` then re-detects for the new node.

Viewport-pinned (fixed/sticky) targets keep the `position:fixed` host. The host's
window-scroll anchoring (`absolute` vs `fixed`) and the inner-scroll delta (the
`outer` animation) are orthogonal — see the 2026-06-09 revision below for why a
fixed/sticky ancestor does NOT exclude the accelerator.

## Feature detection + flag

- Feature: `typeof ScrollTimeline !== 'undefined'`. Absent (Firefox stable) →
  never enter accelerated mode. No errors, no behavior change.
- Flag: `bkScrollAccel` boolean in `chrome.storage.local`, **default off** (read
  once at init, mirrors the `alphabet` pattern at `content.ts:545`). Off →
  identical to today. The user flips it to test:
  `chrome.storage.local.set({ bkScrollAccel: true })`.

Both gates must pass to arm the accelerator. Either failing = today's behavior.

## Interaction with the existing chase

Keep accelerated badges **in** the per-frame `reconcileScrollFrame` chase. The
chase writes the scroll-invariant `docY0` base (harmless, no visible motion) and
is the always-on safety net: if the timeline breaks, the chase is already
re-pinning correctly. The animation only rides on top to remove the wiggle. (A
future C3 optimization may skip the reflow for healthy-accelerator badges; not
v1.)

## Scope / deferred

- Horizontal (`inline`) axis — deferred.
- Nested scrollers (target inside scroller-in-scroller) — PROTOTYPED 2026-06-09
  behind `bkScrollAccelNested` (default off). Rides the whole scroller chain
  (`findScrollableAncestors`) via composed ScrollTimelines: one additive
  (`composite: 'add'`) `translateY(-scrollTop)` animation per scroller on `outer`
  (the translateYs concatenate → `-Σ scrollTop`), and the reconcile base adds
  `Σ scrollTop`. Default single-scroller path stays `replace` and untouched. The
  unverified bit is whether `composite: 'add'` composes ScrollTimeline-driven
  translateYs in real Chrome — hence flag-gated. If it doesn't, fall back to
  nested transform layers (one per scroller). Fixes the wiggle when an OUTER
  overflow ancestor scrolls a target in an inner pane.
- Skipping the chase reflow for healthy accelerators (perf) — deferred.

## Files

- `src/render/scroll-accel.ts` — `findScrollableAncestor`, `ScrollTimeline`
  lifecycle (create/teardown/recompute/healthy), feature-detected. + tests for
  the pure helper.
- `src/render/hints.ts` — `_scrollAccel` field; setup in `updatePosition`/`show`;
  health-gated base in `reconcileRead`; teardown in `hide`/`remove`/`retarget`.
- flag read at init (`content.ts` or `config.ts`).

## Verification (cannot be done from the harness — needs real browsers)

1. **Chrome, QuickBase data-table grid** (flag on): scroll the inner grid →
   badges ride smoothly, no wiggle. Window-scroll pages unaffected. Soak for
   steady-state regressions per the orphan-teardown discipline.
2. **Chrome, flag off**: byte-for-byte today's behavior.
3. **Firefox** (`ScrollTimeline` undefined): no accelerator, no errors, today's
   wiggle — confirms the fallback.
4. **Break test**: force a scroller recreate (or detach) mid-scroll → badge
   falls back to chase (wiggle), never dangles.

Only merge after 1–4 pass + a soak; the positioning core is the highest-blast-
radius area in the codebase.

## Revision (2026-06-09): viewport-pinned exclusion was too broad

First real-Chrome test on a QuickBase report (app-shell layout) showed the
wiggle everywhere — grid AND sidebar — with only 2 of dozens of badges armed.
Diagnosis (page-console enumeration of scrollers + the new `data-bk-accel`
markers): detection was fine (the grid `tbody.tableBody` and sidebar
`ul.css-7huxaa` both read `overflow-y: auto`, `wouldMatch: true`), but almost
every badge was being excluded by the **"target is NOT viewport-pinned"** gate.

The original exclusion assumed *fixed/sticky ancestor ⇒ the target holds a
constant viewport position, so it needs no accelerator*. That is **false for an
app-shell**: the grid/sidebar panes are nested inside a `position:fixed`/`sticky`
shell, yet their content still scrolls inside an inner overflow scroller. So the
target is "viewport-pinned" by the ancestor test while genuinely inner-scrolling
— precisely the case the accelerator exists for — and was wrongly skipped.

**Resolution:** the inner scroller (`findScrollableAncestor` non-null) is the
SOLE arming gate; `_viewportFixed` no longer excludes. The host's window-scroll
anchoring (`position:absolute` for flow targets, `position:fixed` for pinned)
and the inner-scroll delta (the `outer` `translateY(-scrollTop)` animation) are
orthogonal and compose: with `_viewportFixed` true, `reconcileRead` already drops
the `scrollY` term (`sx/sy = 0`) and the base becomes `rect.top + offset +
scrollTop` — scroll-invariant under inner scroll — while the animation supplies
`-scrollTop`. A truly pinned target with no inner scroller still returns `null`
from `findScrollableAncestor` and arms nothing, so dropping the exclusion only
newly covers fixed/sticky panes that actually inner-scroll. The sticky-transition
case (residual (a) in `DESIGN_HINT_POSITIONING_REARCH.md`) is unchanged — still
on the chase, no worse than before.

Diagnostics added alongside (permanent, parallel to `data-bk-shown`):
`<html data-bk-scroll-accel="on|off|unsupported">` (flag + support resolved at
init) and `data-bk-accel="<max>"` on each armed badge host, both queryable from
the ordinary page console.
