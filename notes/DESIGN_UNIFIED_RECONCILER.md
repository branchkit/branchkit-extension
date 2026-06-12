# Unified Reconciler — the plan becomes the engine

Date: 2026-06-12
Status: proposal (structural arc 1 of `REVIEW_ARCHITECTURE_2026-06-11.md`)
Successor to: `notes/completed/DESIGN_HINT_LIFECYCLE_RECONCILER.md` (the
{claim, build, release, teardown} axis — phases 0-6 landed and verified).
Base: branch `deletion-sprint-2026-06` (the sprint reshaped several inputs;
see "What the sprint changed" below).

## Where this picks up

The lifecycle reconciler note ended with `reconcile()` as the single
convergence entry for {codeword, hint} and `reconcileTeardown()` as the
fresh-geometry backstop. Since then, two more rounds of bug-driven work grew
the settle path sideways: strict-viewport re-push, occlusion hit-testing,
clip-membership sync, CSS-visibility recheck, scroll-accel re-detection, and
band discovery each became their own pass with their own filters, reads,
throttles, and guards. Week 1 extracted `runSettlePipeline()`
(content.ts:2851) so the seven steps at least run once, in one order, from
both settle handlers — the ordering is no longer duplicated prose. But each
step still independently re-derives its own slice of "what should be true",
and the one component that computes the whole desired-vs-actual delta —
`computeReconcilePlan` (lifecycle/reconcile.ts) — still runs only as a
count-only diagnostic shadow that drives nothing.

The review's framing: the codebase has been converging on level-triggered
reconciliation from three directions, and every scroll-back badge bug to date
was a desync between an edge-triggered flag and reality. This note makes the
convergence deliberate: one settle pass whose engine is the plan computation,
with events demoted to "schedule the pass sooner" hints.

## The pass inventory (post-sprint)

| Pass | Concern | Where | Reads | Acts on |
|---|---|---|---|---|
| `reconcile()` | claim + build + reattach | content.ts:1398 | cached rects (cacheLayout in build) | `wantsCodeword`/`wantsHint` deltas |
| `reconcileTeardown()` | stale-TRUE release; stale-FALSE flag repair (hinted + never-hinted) | content.ts:1448 | fresh gBCR, bounded sets | `isInViewport` vs band geometry |
| `scheduleBandDiscovery()` | wrappers that never existed (dropped MO records) | content.ts:1599 | sliced DOM walk, idle-scheduled | document vs store |
| `reconcileClipObservation()` | clip-IO membership sync | observe/clip-observer.ts:86 | scroller walk per new target | `w.clipped` observation set |
| `reconcileOcclusion()` | covered-target hide | content.ts:1540 | elementFromPoint per visible badge | `w.overlayCovered` |
| `recheckHintedVisibility()` | CSS visibility show/hide | observe/visibility-tracker.ts:164 | cacheVisibility (styles + seed rects) | `w.cssHidden`, badge shown |
| `reconcileStrictViewport()` | `_strict` collection re-push | content.ts:1520 | fresh gBCR over codeworded set | `lastSentStrictViewport` delta |
| `reconcileScrollAccel()` | accelerator chain re-detection | render/scroll-accel-glue.ts | scroller-chain walk per badge | accel arm/rebuild |
| `scheduleReposition()` | positioner pass + off-screen hide | content.ts:2738 | reconcilePass rects (returned) | host transforms, badge hide |

Plus the out-of-band actors: the IntersectionTracker enter/exit fast-path
(claims/releases on IO events), the pointerover visibility sweep (hover-reveal
promotion + re-show, 100ms throttle), `scheduleHintVisibilityRecheck` (the
visibilityMO's 100ms coalescer), and the per-frame `reconcileScrollFrame`
loop during scroll.

Each row answers "what should be true right now?" for one sub-state, with its
own notion of which wrappers to look at and its own layout reads. Per settle,
geometry is read up to four separate times (teardown gBCR, strict gBCR,
recheck cacheVisibility, positioner gBCR) over heavily-overlapping sets.

As a picture:

```
┌───────────────────────────────────────────────────────────────────────┐
│ EVENT SOURCES                   each with its own coalescer/throttle  │
│                                                                       │
│  IntersectionTracker IO ──→ ACTS DIRECTLY: writes isInViewport,       │
│                             claims / releases codewords               │
│  visibilityMO ──────────→ 100ms throttle → recheckHintedVisibility    │
│  pointerover ───────────→ 100ms throttle → re-show + promote sweep    │
│  container RO / focus /                                               │
│  transitionend ─────────→ 100ms debounce ──┐                          │
│  scroll (window+capture) → 100ms debounce ─┤                          │
└────────────────────────────────────────────┼──────────────────────────┘
                                             ▼
┌─ runSettlePipeline() — 7 steps, order held by comment discipline ─────┐
│                            reads                 acts on              │
│ 1 reconcileTeardown        own gBCR sweep        flag vs band         │
│ 2 band/store discovery     DOM walk (sliced)     document vs store    │
│ 3 clip sync + occlusion    hit-tests             clipped/overlay      │
│ 4 reconcileScrollAccel     scroller-chain walks  accel chains         │
│ 5 recheckHintedVisibility  own styles + rects    cssHidden/shown      │
│ 6 reconcileStrictViewport  own gBCR sweep        _strict delta        │
│ 7 scheduleReposition       positioner rects      off-screen hide      │
└───────────────────────────────────────────────────────────────────────┘
┌───────────────────────────────────────────────────────────────────────┐
│ computeReconcilePlan — re-derives the {claim,build,release,teardown}  │
│ delta as COUNTS, runs as a diagnostic shadow, DRIVES NOTHING          │
└───────────────────────────────────────────────────────────────────────┘
```

## What the sprint changed (inputs to this design)

- **TargetRectStore is deleted.** The prior note's "warm store substrate"
  convergence section is obsolete, and deliberately so: an IO-fed rect cache
  cannot police dropped IO events (circular), and viewport-relative rects go
  stale on every in-viewport scroll with no re-fire. The replacement pattern
  is already in the tree: `reconcilePass()` returns the rects it reads
  (render/reconcile-positioner.ts), and the off-screen-hide sweep reuses
  them. Geometry for this design comes from fresh bounded reads, shared.
- **`computeReconcilePlan` slimmed to four counts** ({claim, build, release,
  teardown}); its band-divergence counts went with the store. The plan is
  currently pure O(store) over already-resolved sub-states only.
- **`reconcileTeardown` now covers never-hinted wrappers** (the
  missed-initial-enter direction the prior note deferred), with the
  boxless-rect skip and a `reconcile:stale_false_repair` breadcrumb. The
  stale-flag repair surface is complete; what remains is unification, not
  coverage.

## Target model

One settle pass, three phases, the plan in the middle:

```
┌───────────────────────────────────────────────────────────────────────┐
│ EVENT SOURCES — demoted to "write a cheap flag, schedule the pass"    │
│                                                                       │
│  IO enter/exit   KEPT as the latency fast-path (claim on enter,       │
│                  release on exit) — the pass corrects it after        │
│  MO / RO / pointer / transitionend / scroll-settle → schedule(pass)   │
└────────────────────────────────┬──────────────────────────────────────┘
                                 ▼  (100ms settle, single-flight)
┌─ THE SETTLE PASS ──────────────────────────────────────────────────── ┐
│                                                                       │
│  GATHER   one batched read over bounded sets: rects read ONCE         │
│           (reusing reconcilePass returns), styles (cacheVisibility),  │
│           occlusion hit-tests, ancestor-chain check (strict)          │
│                        │ snapshot                                     │
│                        ▼                                              │
│  PLAN     computeReconcilePlan(store, category, snapshot) → LISTS     │
│           one desired-state module decides everything:                │
│           wantsCodeword / wantsHint / wantsShown / wantsStrict / …    │
│                        │ toClaim[] toRelease[] toBuild[] toTeardown[] │
│                        ▼ toShow[] toHide[] strictDelta[] accelSync[]  │
│  APPLY    fixed sub-step order (teardown → discovery → clip/occlusion │
│           → accel → visibility → strict → reposition; enforced by     │
│           structure, not comments), budgeted, one firehose breadcrumb │
│           per action class                                            │
└───────────────────────────────────────────────────────────────────────┘
  deliberately OUTSIDE the pass:
   - per-frame positioner (reconcilePass) — pure target-following
   - band discovery — idle-scheduled single-flight; the pass requests it
   - pointer PROMOTION half — candidate lifecycle, not wrapper reconcile
```

The desired-state module grows to match: today `wantsCodeword`/`wantsHint`
(lifecycle/desired-state.ts) are the only centralized predicates;
strict-eligibility, shown-ness (cssVisible ∧ on-screen ∧ ¬occluded ∧
¬clipped), and accel-eligibility live inline in their passes. They become
pure predicates over (wrapper, gather snapshot) in the same module, so the
plan and any remaining fast-path consult identical definitions.

### Decisions (with rationale)

1. **Fresh geometry, gathered once, never cached across settles.** The
   TargetRectStore lesson is structural, not incidental. The gather phase
   pays one forced reflow per settle (first gBCR), after which every read is
   a clean-layout lookup — the same discipline `reconcileTeardown` proved.
   Bounded sets only: hinted + codeword-less in-band candidates + codeworded
   (strict). Full-store rect sweeps stay forbidden (wedge guard).
2. **The IO fast-paths stay.** Settled in the prior note's Phase 4 and
   re-affirmed: enter-claim latency matters for scroll-ahead UX, and
   re-deriving the whole store from geometry per IO burst re-lights the
   wedge. The IO writes `isInViewport` and may claim/release immediately;
   the pass is the authority that corrects it. "Demoted to scheduling hints"
   applies to the *backstop* actors (the recheck throttle, the strict
   re-push trigger, the pointer re-show half), not the IO fast-path.
3. **The per-frame positioner stays separate.** `reconcilePass()` is pure
   target-following at scroll cadence; it has no lifecycle opinions. The
   settle pass consumes its returned rects when they cover the wrapper in
   question and reads fresh otherwise. Do not merge the cadences.
4. **Plan lists, not plan counts — and the shadow dies.** Once the plan
   drives APPLY, the shadow-vs-authoritative comparison is meaningless; the
   snapshot surface (`reconcile_shadow`, perf `reconcileShadow`) switches to
   reporting what the pass *did* (applied counts + remaining budget), which
   is strictly better telemetry: a non-zero "remaining" is the new tripwire.
5. **Ordering is data, not prose.** The seven-step order in
   `runSettlePipeline` is load-bearing (occlusion before strict, recheck
   before strict, teardown first). In the unified pass it becomes the fixed
   sequence of APPLY sub-steps over plan fields — enforced by structure, so
   a future step can't be inserted in the wrong place by editing a comment.
6. **Grammar churn discipline carries over unchanged.** Act only on real
   deltas; the prior note's Phase 6 live probe showed steady-state settle
   bursts produce zero grammar commits (`grammar_already_owns` absorbs).
   The unified pass must re-verify this gate before it is considered done.
7. **Band discovery keeps its own scheduler.** It is the only sub-step that
   walks the DOM; single-flight + idle-scheduled + sliced is the wedge-safe
   shape it already has. The pass *requests* it (sets the flag) rather than
   running it inline.

### Prerequisite: restructure Tier 3

Restructure step 10 (notes/DESIGN_EXTENSION_RESTRUCTURE.md): move observer
construction (the six observers, with their now-thin callbacks) onto
`PageSession.start()`. This retires the injection seams (`initWrapperLifecycle`,
`initMutationSource`, `initVisibilityTracker` deps) that the unified pass
would otherwise have to thread through, and gives the pass a single owner for
construction/teardown (the `quiesceOrphan` story simplifies to "session
stops"). It is mechanical relative to this design and should land first.

## Phased plan

Each phase ends with: wedge repro green (`scripts/_test-videos-tab-wedge.mjs`),
unit suite green, and — for behavior-affecting phases — a classify sweep
(`scripts/_test-leak-measure.mjs`) within baseline. Manual soaking is batched:
ONE real-browser soak at the end of the arc (Phase F), not per phase. The
per-phase verification load moves to the automated gates, and above all to
Phase C's shadow diff — continuously comparing the plan's decisions against
live behavior is what per-phase soaks were buying, without the wall-clock
cost. The build-up-before-tear-down rule from the prior note applies
throughout.

**Phase A — Tier 3 (mechanical).** Observers onto `PageSession.start()`;
delete the injection seams. No behavior change intended.

**Phase B — single gather.** Extract one read pass feeding
`reconcileTeardown` + `reconcileStrictViewport` + `recheckHintedVisibility`
(today: three separate read passes per settle over overlapping sets). Pure
read-consolidation, behavior-preserving; measure gBCR/getComputedStyle counts
per settle before/after on the YouTube /watch repro. The gather result is a
plain snapshot object — this is where the plan's future input takes shape.

**Phase C — plan-as-lists, shadow mode.** Extend desired-state with the
shown/strict predicates; extend `computeReconcilePlan` to consume the gather
snapshot and emit wrapper lists for every action class. Run it in shadow
alongside the live steps and diff its lists against what the steps actually
did (the Phase 2 pattern from the prior note — it caught the warm-rect
staleness asymmetry last time; expect it to catch an ordering or filter
subtlety this time). Acceptance: the plan's lists match the steps' actions
across the classify sweep and a real signed-in dense page.

**Phase D — apply cutover, one action class at a time.** Teardown/repair
first, then strict, then visibility, then occlusion/clip, each replacing the
corresponding step body with "execute the plan's list", each landing as its
own commit behind the automated gates. One commit per action class keeps the
cutover order doubling as the bisect order if the end-of-arc soak flags a
regression. The step functions become thin appliers; their filters and reads
are gone (the gather + plan own them).

**Phase E — demote the backstop actors.** `scheduleHintVisibilityRecheck`,
the strict re-push on visibility change, and the pointer sweep's re-show half
become `schedulePass(sooner)` calls. The pointer sweep's *promotion* half
(pendingVisibility → wrapper) is candidate lifecycle, not wrapper reconcile —
it stays. Delete the shadow comparison; flip the snapshot surface to applied
counts + remaining budget.

**Phase F — parity + docs.** Full guardrail sweep, live grammar-churn probe
(`scripts/_test-live-churn.mjs`), and the arc's ONE batched real-browser soak
— the settle path has a history of regressions that pass green tests (the
orphan-teardown series), so the single soak stays, placed where it covers
every phase at once. Then doc reconciliation and relocate this note to
completed. Only after this: the deferred dependents that this work unlocks —
nav-wipe retirement (`project_nav_rebuild_smell`) and the grammar epoch
handshake (arc 2, its own note).

## Risks

- **Wedge regression** is the standing risk for anything touching settle
  reads. Mitigations are inherited and structural: bounded sets, batched
  read-all-then-act, idle-scheduled discovery, per-phase wedge runs. The
  gather phase must never grow a full-store rect sweep.
- **Hint-reuse dormancy semantics.** Dormant badges (clearLabel + hide, kept
  for scroll-back) are *desired* state, not drift. The shown-ness predicate
  must encode dormancy explicitly or the pass will "repair" every dormant
  badge on every settle. Same for limbo wrappers (excluded, as today).
- **Hidden coupling in step order.** The occlusion-before-strict and
  recheck-before-strict constraints are documented, but Phase C's shadow diff
  is the real detector for ones that aren't.
- **Latency vs convergence.** Users perceive the IO fast-path (badges during
  scroll); the pass runs at settle cadence. Anything currently faster than
  settle (pointer re-show at 100ms throttle, visibility recheck) must not get
  slower — demotion in Phase E means "schedule the pass sooner", and the pass
  must be cheap enough to run at that cadence. Phase B's read-count
  measurement is the budget evidence.
- **Firefox.** Settle cadence and rIC behavior differ; the existing fallbacks
  (`runWhenIdle` timeout path) carry over, but the soak must include the
  Firefox build per the standing discipline.

## Out of scope

- **Grammar epoch handshake** (arc 2) — per-frame codeword count/hash in
  batch responses, auto-reactivate on mismatch, CONFIRM folded into the claim
  exchange. Separate note after this lands.
- **Nav-wipe retirement** — `preNavDetachAll`'s wipe+rebuild stays as-is;
  retiring it rides the unified pass but is its own change with its own soak.
- **Occlusion same-context gaps** (opacity-0 ancestors, off-screen
  transforms) — `notes/DESIGN_HINT_OCCLUSION_FILTERING.md` territory.
- **Playwright suite promotion** — orthogonal chore from the review's
  dead-weight list.

## Open questions

- Does `reconcileScrollAccel` fold into the plan (an `accelSync[]` list over
  the shown set) or stay a glue-module step the pass merely orders? It has no
  desired-state ambiguity — leaning fold-late (Phase D last), since its reads
  (scroller-chain walks) are the most expensive per wrapper and benefit most
  from the gather's shown-set narrowing.
- Should the gather snapshot carry style reads for *non-hinted* in-band
  candidates (so the plan can gate `toBuild` on cssVisible, as
  `badgeNewlyCodeworded` does today), or keep build-time visibility checks in
  the applier? Affects gather size on dense pages.
- Budget shape: hard per-settle time cap with carry-over lists, or trust the
  bounded sets and skip budgeting until measurement says otherwise? (The
  prior note's history says: measure first.)
