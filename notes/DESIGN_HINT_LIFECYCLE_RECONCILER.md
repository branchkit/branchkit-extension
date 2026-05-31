# Hint Lifecycle Reconciler

Consolidate the scattered, edge-triggered mutations of wrapper state into a
single level-triggered reconcile pass. This is the architectural fix for the
"missing / wrong badge" family on heavy SPA pages (canonical: YouTube). It
closes three of the four observed phenomena at their shared root and lets the
bolt-on backstops accreted during the freeze-fix series be deleted.

Scope of this note (decided 2026-05-31): the **lifecycle reconciler only**.
The nav-time wipe+rebuild retirement and the badge collision-avoidance
(occlusion) pass are deliberately out of scope here and tracked separately —
see "Out of scope" below.

## The problem: edge-triggered state with no reconciliation

A wrapper's user-visible correctness is a function of four interdependent
sub-states:

```
{ observed?,  inViewport?,  codeword?,  hint? }
```

No component owns that tuple. At least seven independent edge-handlers each
mutate a subset of it, and the correct final state only emerges if every
relevant edge fires, in the right order, with no drops:

| Edge | Mutates | Where |
|---|---|---|
| Initial scan (eager attach) | observed, hint | `content.ts` |
| MutationObserver discovery | observed | `content.ts` `discoverInSubtree` / batched |
| AttentionObserver (rootMargin 200%) | wrapper attach / detach | `observe/attention-observer.ts` |
| IntersectionTracker (rootMargin 200px) | `isInViewport`; claim / release codeword; **tear hint down on exit** | `observe/intersection-tracker.ts:162,175,182,280` |
| `badgeNewlyCodeworded` / `showHints` | **build hint** — only on a codeword *transition* | `content.ts:1274,1158` |
| `preNavDetachAll` (nav signal) | wipes the whole tuple | `content.ts:1741` |
| `refreshViewportClaims` | re-claim codeword for the one missing-codeword combo | `observe/intersection-tracker.ts:114` |

The load-bearing asymmetry: **`handleEntries` tears hints DOWN on viewport
exit, but nothing builds them UP from level state.** Hint construction is wired
only to the codeword *transition* (`onCodewordsChanged → badgeNewlyCodeworded`).
So whenever a wrapper's sub-states fall out of phase — which happens whenever an
IO / mutation event is dropped, delivered late, or reordered under YouTube's
post-nav/scroll mutation storm (the wedge investigation confirmed IO is
"delivered only partially" there) — there is no component whose job is to notice
"this element is in-viewport and codeworded and has no badge, build one."

## The four phenomena are an enumeration of which sub-state desynced

Measured 2026-05-31 via programmatic snapshots (`scripts/_snapshot.mjs`
`classify`, `scripts/_test-leak-measure.mjs`). The catastrophic state does NOT
reproduce on the reloaded build — the claim path is healthy
(`claimGapInViewport = 0` everywhere). What remains:

| Phenom | Desynced sub-state | Snapshot signature |
|---|---|---|
| **discovery gap** | `observed = false` | dom_survey `matchesHintable && !isHinted`, no wrapper |
| **stale isInViewport** | `inViewport = stale-true` | wrapper in-viewport + codeword + hint painted at `y ≈ −scrollY` |
| **noHintObject** | `codeword = true, hint = null` | in-viewport, non-empty codeword, no badge (e.g. title link "The Case of Nick Fuentes") — this is the user's "no box around the video link" report |
| badge-on-badge occlusion | (orthogonal — placement) | two distinct in-viewport hints overlapping; zero collision avoidance |

The first three share one root (the missing build-up path + dropped events).
The fourth is a placement-layer gap unrelated to lifecycle and is out of scope
here.

We have been responding to each newly-discovered desync combo by bolting on a
backstop for that one combo — `refreshViewportClaims` covers `inViewport &&
!codeword`; the others have none. One backstop per combo is the smell. There are
four combos and one of them is covered.

## The fix: a single level-triggered reconcile pass

Define the desired state declaratively as a pure function of ground truth:

> Every hintable element near the viewport should have a wrapper, a codeword,
> and a hint positioned on-band. Everything else should not.

One `reconcile()` converges actual → desired. Edges stop mutating sub-states
directly; they **schedule a (coalesced, idle-scheduled) reconcile**. The pass,
bounded to the viewport band:

1. **Discover** — walk the band for hintable elements not yet observed;
   observe / attach them. (closes *discovery gap*)
2. **Re-derive `inViewport`** from each wrapper's current rect rather than
   trusting a possibly-stale IO flag. (closes *stale isInViewport* — the flag is
   the thing that goes stale, so the reconciler must not trust it)
3. **Claim** a codeword for every in-band wrapper missing one. (this is exactly
   what `refreshViewportClaims` did — now a clause, not a separate backstop)
4. **Build** a hint for every in-band, codeworded wrapper missing one. (closes
   *noHintObject* — the missing build-up path)
5. **Release / tear down** any wrapper whose real rect is off-band (codeword
   released, hint removed). (closes the *stale isInViewport* phantom badge)
6. **Place.**

The edges (IO entries, MO records, scroll-settle, nav-settle, alphabet-change)
become *signals that schedule a reconcile*, not handlers that directly write
`isInViewport` / `codeword` / `hint`. The IO's job narrows to "the band may have
changed, reconcile"; it no longer unilaterally tears hints down or releases
codewords on a single (possibly spurious) exit entry.

### What collapses into the reconciler

- `refreshViewportClaims` (step 3) — delete; it was the one-combo backstop.
- `badgeNewlyCodeworded` (step 4) — delete; build is now level-driven, not
  transition-driven.
- The codeword/hint mutation inside `handleEntries` (intersection-tracker.ts
  162–185) — reduce to "mark band dirty, schedule reconcile."
- The **scroll-settle backstop the nav-rebuild-smell note called for** falls out
  for free: scroll-settle is just another reconcile trigger. No bespoke
  scroll-end re-claim needed.

## Why this aligns with — and does not regress — the nav-time wedge fix

The wedge fix (`ca25199`, `preNavDetachAll`) is load-bearing and must not
regress. It is *compatible with* and *pushed the same direction as* this
refactor:

- The wedge exists to kill the **per-wrapper observer cascade** — ~600 wrappers
  × 3 per-wrapper observers all firing as YouTube disconnects the page during
  reflow. The reconciler runs on **centralized** observers (the single-IO / -RO
  / -MO model `DESIGN_OBSERVER_DRIVEN_LAYOUT.md` already commits to), under which
  that cascade is structurally impossible. Both changes move away from
  per-wrapper observer churn.
- `preNavDetachAll`'s synchronous pre-swap teardown stays as a **perf hint**
  ("a big swap is coming, get ahead of it"). What this note does NOT touch is the
  full-store *wipe + rebuild* that follows it — that retirement is a separate,
  later step (see Out of scope), and is only safe once the incremental
  reconciler exists (no wipe → no mass re-observation → no IO storm to drop
  events from).

**Guardrail on every step:** `scripts/_test-videos-tab-wedge.mjs` must stay
green (wedge does not return), and `scripts/_snapshot.mjs classify` must show all
three lifecycle buckets (discoveryGap, staleInViewport, noHintObject) trending to
zero across a scroll sweep without the catastrophic state reappearing.

## Convergence with the observer-driven layout work

`DESIGN_OBSERVER_DRIVEN_LAYOUT.md` noted that `TargetRectStore` has **zero
production readers** — it is kept warm by observers but nothing consumes it. The
reconciler is that missing reader: step 2 (re-derive `inViewport`) and step 6
(place) read warm rects from the store instead of forcing per-wrapper
`getBoundingClientRect`, which is what keeps the pass cheap. The two design
threads converge here — the lifecycle-correctness axis (this note) and the
positioning-perf axis (that doc) share the same warm-store substrate.

## Risks

- **Grammar / Vosk churn.** Codeword claim/release drives a Vosk vocab refresh.
  A reconciler that re-derives state must act only on real deltas and coalesce,
  or it could thrash the grammar. Mitigation: diff against current state; only
  emit claim/release for genuine transitions; idle-schedule + coalesce the pass.
- **Reconcile cost on dense pages.** The pass is bounded to the band and reads
  the warm store, but band discovery (step 1) still walks DOM. Must reuse the
  existing sliced/batched discovery, not a fresh full-document walk. Measure
  against the wedge repro.
- **Spurious IO exits.** Part of the win is that the reconciler re-tests
  geometry rather than trusting a single IO exit entry — but that means an
  element genuinely leaving must still be released promptly. The off-band test in
  step 5 covers this; verify release latency on a Gmail-style scroll-away (see
  the "Gmail mail-list scroll-back" known limitation in the layout doc).

## Out of scope (tracked separately)

- **Nav wipe+rebuild retirement** — collapsing `preNavDetachAll`'s full-store
  wipe into the incremental reconcile path. Enabled by this work but deferred.
  See `[[nav-rebuild-smell]]` memory and `notes/DESIGN_NAV_TIME_RESCAN.md`.
- **Badge collision avoidance (occlusion)** — placement-layer de-confliction for
  the fourth phenomenon. Independent of lifecycle. See
  `notes/DESIGN_BADGE_PLACEMENT_ENGINE.md` and `placement/rango.ts`
  (z-index = reading order, no collision avoidance anywhere).

## Phased plan

Incremental and behavior-preserving where possible — not a rewrite. Each phase
ends with the two guardrails green before the next begins: the wedge repro
(`scripts/_test-videos-tab-wedge.mjs`) and a `classify` scroll sweep
(`scripts/_test-leak-measure.mjs`). The build-up path is wired *before* the
tear-down path is touched, so we never widen a leak while closing another.

**Phase 0 — Guardrail baseline.** Run the wedge repro and a `classify` sweep on
the current build; record baseline buckets (working / staleInViewport /
discoveryGap / noHintObject / offscreenReleased) at top + each scroll step. This
is the parity bar every later phase is measured against. No code change.

**Phase 0 baseline recorded (2026-05-31, build = committed HEAD incl. circuit
breaker `fbc71d2`, `dist/firefox` rebuilt):**

- Wedge repro (`_test-videos-tab-wedge.mjs`): **PASS** — renderer responsive
  after the channel `/videos` nav click; wedge did not reproduce.
- `classify` sweep (`_test-leak-measure.mjs`, signed-out search results, clean
  profile): `working` 32–44, `staleInViewport` peak **2** (at +4vp), `discoveryGap`
  peak **1** (at +4vp), `noHintObject` **0**, `claimGapInViewport` **0** throughout.
- **Caveat — the deterministic harness under-reproduces the leaks.** The
  signed-out clean-profile search page shows them only weakly; the user's real
  signed-in dense home showed `noHintObject = 8` plus the occlusion stacks. So the
  harness sweep is a *necessary but not sufficient* parity bar: Phase 3/4
  verification must ALSO `classify` a real signed-in home snapshot, not rely on
  this sweep alone. (Harness gap fixed this phase: `_test-leak-measure.mjs` now
  prints `noHint` in its per-step line.)

**Phase 1 — Extract the desired-state predicate.** One source of truth for "is
this element hintable" (today in scan) and "should it have {wrapper, codeword,
hint} right now" (today implicit in the two IO margins). Pull it into a pure
predicate both scan and the future reconcile consume, so the two never diverge.
Behavior-preserving extraction.

**Phase 1 recorded (2026-05-31, behavior-preserving).** New pure module
`src/lifecycle/desired-state.ts` exports `categoryMatches`, `wantsCodeword`,
`wantsHint` — the level-triggered desired state, the counterpart to scan's
`isHintable`. Unit-tested in `desired-state.test.ts` (9 cases, green).

- `refreshViewportClaims` (intersection-tracker.ts) now expresses its predicate
  as `wantsCodeword(w) && !w.scanned.codeword` (delta = wants but lacks).
- `badgeNewlyCodeworded` (content.ts) now expresses its predicate as
  `wantsHint(w, activeCategory) && !w.hint` (delta = wants but lacks). The old
  inline `activeCategory && w.category !== activeCategory` continue is folded
  into `wantsHint` via `categoryMatches`.
- LEFT UNTOUCHED (Phase 3/4 territory): the IO claim site in `handleEntries`
  (still mutates `isInViewport`/`codeword`/`hint` directly) and `showHints`
  (uses the fresh-rect `viewportSort`, a *different* viewport notion than the
  IO band — must not be unified into these predicates).
- Guardrails: wedge repro **PASS**; `classify` sweep within baseline noise
  (`staleInViewport` peak 2, `discoveryGap` peak 1, `claimGap` 0). A transient
  `noHint=4` appeared at the freshly-settled top and self-healed to 0 on the
  next scroll step — settle artifact, not a behavior change (conditions are
  boolean-identical to pre-refactor). Pre-existing `DEBUG_LOG as Message`
  TS2352s remain (other session's; esbuild build unaffected).

**Phase 2 — `reconcile()` in shadow mode.** Add the pass that walks the store +
band and computes the delta set (which wrappers need claim / build / release /
discover), but it only **logs** what it *would* do — it drives nothing. Compare
its decisions against the state the edge-handlers actually produced (mirrors the
shadow-store divergence check in `DESIGN_OBSERVER_DRIVEN_LAYOUT.md` Phase 3).
Confirms reconcile computes correct state before it is authoritative. Reads warm
rects from `TargetRectStore` (becomes the store's first production reader).

**Phase 2 recorded (2026-05-31, shadow — drives nothing).** New module
`src/lifecycle/reconcile.ts`: `computeReconcilePlan(store, activeCategory,
rectStore, viewport, marginPx)` → `ReconcilePlan {needClaim, needBuild,
needRelease, needTeardown, band{rectsKnown, staleTrue, staleFalse}}`. Pure,
O(store), **no forced layout** (reads only warm rects, never
`getBoundingClientRect`). Unit-tested in `reconcile.test.ts` (9 cases, green).
It is the **first production reader of `TargetRectStore`**. Surfaced on two
read surfaces: `DebugSnapshotPayload.reconcile_shadow` (the harness path) and
`buildPerfSnapshot().reconcileShadow` (the 250ms cadence). `_test-leak-measure.mjs`
now prints a `~plan` line under each classify line.

- **The plan tracks the leaks exactly** (the Phase 2 acceptance criterion): on
  the signed-out search sweep, at top `noHint=4 → build=4`; back-to-top
  `claimGap=1 → claim=1`. `needRelease`/`needTeardown` stayed 0 throughout
  (edge-handler release path is healthy). So reconcile *would have* computed
  the correct correction (build the 4 missing hints, claim the 1 missing
  codeword) for precisely the wrappers classify flags — before being made
  authoritative in Phase 3.
- **Band-divergence asymmetry — load-bearing for Phase 4.** `band.staleTrue`
  (flag=in, geometry=out) stayed 0, matching classify's `staleInViewport≈0` —
  trustworthy because in-band rects are kept warm (write-on-paint + scroll
  reposition). But `band.staleFalse` (flag=out, geometry=in) grew with scroll
  depth (5→63) and is **NOT a real missed-enter count**: it is dominated by
  *store staleness* — once a wrapper leaves the band nothing re-writes its
  rect, so the frozen top-of-page rect still tests in-band while the IO flag
  (current) correctly says out. **Implication: Phase 4's "re-derive inViewport
  from geometry" must use FRESH `getBoundingClientRect` for off-band decisions,
  not the warm `TargetRectStore` rect** (or re-warm before testing). Trust the
  warm store only for the in-band/staleTrue direction.
- Guardrails: wedge **PASS**; classify within baseline (`staleInView` peak 1,
  `discoveryGap` 0, transient `noHint` 4→0, transient `claimGap` 1). Behavior
  unchanged — shadow drives nothing.

**Phase 3 — Reconcile owns the build-up path.** Make reconcile authoritative for
the *missing half*: claim codewords for in-band wrappers without one, and build
hints for in-band codeworded wrappers without one. Subsumes
`badgeNewlyCodeworded` + `refreshViewportClaims`. Leave the IO exit-teardown in
place for now. Expected result: `noHintObject → 0` and `discoveryGap → 0` (with
the band-discovery step), claim side covered. Guardrail must confirm.

**Phase 3 recorded (2026-05-31 — reconcile now DRIVES build-up).** Added
`reconcile()` in content.ts (distinct from the shadow `computeReconcilePlan`):
`tracker.refreshViewportClaims()` (claim) + `badgeNewlyCodeworded()` (build),
build gated on `hintsVisible`. Idempotent and convergent: claim is async (pool
RPC), its completion re-enters via `onCodewordsChanged`; pool-exhausted claims
don't re-fire the callback (`doFlush` gates on `dirty`), so it settles instead
of spinning. Triggers routed through it:
- `onCodewordsChanged` → `reconcile()` (was `badgeNewlyCodeworded()`): builds the
  just-codeworded set **and** re-sweeps the claim gap.
- tail of `showHints()` → `reconcile()`: this is the **noHintObject fix**.
  `showHints` paints only the strict-viewport `renderable` slice (`viewportSort`,
  fresh-rect), but the IO band is 200px wider; the band-minus-strict-viewport
  codeworded wrappers were never built and stayed hintless until a scroll
  re-fired `badgeNewlyCodeworded`. Running reconcile at settle builds them now.

Result (signed-out search sweep, 8 measurements): **`noHintObject` 4→0 on every
step** (was reliably 4 at top), **`claimGapInViewport` 1→0 on every step**. The
shadow plan's `build`/`claim`/`release`/`teardown` are **0 throughout** — the
convergence signature: the driving reconcile has already done what the shadow
plan would propose, so there is nothing left to flag. `staleInViewport` peak 2-3
and `band.staleFalse` growth persist (Phase 4 targets). Wedge **PASS**; unit
suite 18 green; only the pre-existing `DEBUG_LOG` TS2352s remain.

**Scope call — band-discovery deferred to Phase 3b.** Phase 3 owns claim + build
only. The band-discovery backstop (sweep `dom_survey` for in-band hintables with
no wrapper → observe them, closing `discoveryGap`) was carved out because: (a) it
is the *only* build-up sub-step requiring a full DOM walk, the exact shape the
wedge fix guards against, so it needs its own bounded/debounced design rather
than a per-trigger `querySelectorAll`; (b) `discoveryGap` does not reliably
reproduce on the deterministic signed-out harness (0-3, content-variance noise),
so it can't be guardrailed here yet. `discoveryGap` remaining 2-3 post-Phase-3 is
EXPECTED — reconcile creates no wrappers so it cannot raise it; that residue is
precisely Phase 3b's target. Verify Phase 3b against a real signed-in dense home
(per the Phase 0 caveat), not this sweep.

**Phase 4 — Reconcile owns tear-down (refined).** The literal plan above — strip
`handleEntries` and re-derive *every* wrapper's `inViewport` from geometry — was
rejected during implementation: it reintroduces a per-wrapper `getBoundingClientRect`
over the whole store on every IO burst, which is exactly the per-wrapper-gBCR cost
the wedge fix (`preNavDetachAll`, ca25199) guards against. Re-deriving the full
store from geometry would re-light the wedge.

Refined approach: **keep the IO as the cheap fast-path** that writes
`isInViewport` and drives the common claim/release path. Add a SEPARATE
authoritative tear-down backstop, `reconcileTeardown()`, that:
- reads fresh `getBoundingClientRect` ONLY over the **bounded hinted set**
  (`store.all.filter(w => w.hint && w.disconnectedAt === null)` — at most a
  viewport+band's worth of elements, never the whole store), batched
  read-all-then-act so it doesn't interleave reads and writes (no layout
  thrash);
- for any hinted wrapper whose fresh rect is off-band, corrects
  `w.isInViewport = false` and routes it through the shared exit-release
  (extracted as `tracker.queueRelease(w)`, mirroring the `handleEntries` exit
  branch), tearing down the stale hint.

Direction is **stale-TRUE only** (IO flag says in, geometry says out → release):
this is the dropped-exit-event case that produces `staleInViewport`. The
stale-FALSE direction (missed *enter*) is NOT handled here — Phase 2 showed warm
rects go stale off-band so `band.staleFalse` is unreliable, and missed-enter is a
*discovery/build* concern that belongs with Phase 3b, not tear-down.

`reconcileTeardown()` is kept distinct from `reconcile()` (which runs frequently
on `onCodewordsChanged` and must stay gBCR-free); the gBCR sweep fires only on
scroll-settle / deferred-reposition, where a bounded fresh-geometry pass is
affordable. Expected result: `staleInViewport → 0`. Verify release latency on a
Gmail-style scroll-away is acceptable (see the layout doc's known limitation),
and the wedge repro stays green (the bounded set is the whole point).

*Phase 4 record (landed, uncommitted).* Implemented as described: extracted the
`handleEntries` exit branch into `IntersectionTracker.queueRelease(w)` (cancels
pending claim, releases codeword, clears label, tears down hint, schedules a
flush — idempotent); the IO exit branch now just calls it. Added
`reconcileTeardown()` in content.ts — reads fresh `getBoundingClientRect` over
the bounded hinted set (`store.all.filter(w => w.hint && !disconnected)`,
read-all-then-act), and routes off-band wrappers through `w.isInViewport = false`
+ `tracker.queueRelease(w)`. Exported `geometryInBand` from reconcile.ts for the
band check. Wired to **scroll-settle** (`scheduleScrollReposition` timer) and
**deferred-reposition** (`scheduleDeferredReposition` timer), both gated on
`pageSession.hintsVisible`, both already 100ms-debounced. Result (signed-out
search sweep, 8 measurements): **`staleInViewport` 0 on 7 of 8 steps** (lone
transient `2` at the fastest scroll step = badge `innerRect`-vs-target reposition
lag at the band edge, not a dropped exit — shadow `band.staleTrue` is **0
throughout**, confirming no flag-vs-geometry desync on the target side). Shadow
plan `teardown`/`release` **0 throughout** (convergence). `band.staleFalse` still
grows with scroll depth (0→59) — the missed-*enter* / off-band warm-rect
staleness direction, explicitly NOT handled here (Phase 3b / Phase 2 finding).
Wedge **PASS** (proactive_detach did not fire; deferred_scan green); unit suite
459 green; only the pre-existing `DEBUG_LOG` TS2352s remain. NOTE: `handleEntries`
still writes `isInViewport` directly (the cheap fast-path is intentionally kept);
the "IO becomes signal-only" framing is therefore softened to "IO is the
fast-path; reconcile is the authoritative backstop" — Phase 5 trigger-wiring
inherits this.

**Phase 5 — Demote backstops to reconcile steps; wire triggers (refined).** The
planned "remove `refreshViewportClaims` / `badgeNewlyCodeworded` (now empty)"
didn't hold: Phase 4 left them holding the real claim/build logic, not empty. The
honest end state is **demotion, not deletion** — they become reconcile's private
claim-step and build-step (single caller each: `reconcile()`), no longer
independent edge-triggered backstops. `reconcile()` is now THE single
convergence entry; every edge routes through it.

*Phase 5 record (landed, uncommitted).* `reconcile()` doc'd as the sole
{claim, build} entry. Re-pointed the four scattered backstop call sites at it:
`onCodewordsChanged` (already), **scan-batch paint**, **label-sync catchup**
(via `LabelSyncDeps.reconcile`, replacing the injected `badgeNewlyCodeworded`),
**alphabet-change** and **nav deferred-scan** (replaced `tracker.refreshViewportClaims()`
— build is a no-op there pre-flush, real build via the following `showHints`).
`refreshViewportClaims` (tracker) and `badgeNewlyCodeworded` (content) now have
exactly one production caller (reconcile) and carry "reconcile-owned step" docs;
their unit tests still drive `refreshViewportClaims` directly as a tracker
primitive. Added `scheduleReconcile()` — a 100ms-debounced coalescer
(`pageSession.reconcileTimer`) — wired into the **deferred-reposition settle**
(focus/transition/container-resize) alongside `reconcileTeardown`, so a churny
burst collapses to one convergence pass that acts on real deltas only (steady
state is a cheap O(store) no-op walk). Sites needing synchronous flush→showHints
ordering (nav, alphabet) call `reconcile()` directly, not the coalescer. Result
(signed-out search sweep, 8 measurements): **all three lifecycle buckets 0 across
the ENTIRE sweep** — `staleInViewport`, `discoveryGap`, `noHintObject`,
`claimGapInViewport` all 0 every step (the lone Phase-4 transient `2` is gone;
`discoveryGap` 2-3 residue also 0 here, though that's content-variance, not a
Phase-3b claim). Shadow plan all-zero throughout (convergence). `band.staleFalse`
still grows 0→69 (off-band warm-rect staleness / missed-enter — deferred). Wedge
**PASS**; unit suite 459 green; 10 pre-existing `DEBUG_LOG` TS2352s only.
**UNVERIFIED gate:** grammar/Vosk `vocabulary.commit` churn under the new
settle-triggered reconcile — the signed-out Playwright harness doesn't exercise
the actuator commit path. Needs a live-app pass (watch commit frequency on a
churny page like YouTube /watch) before this phase is considered closed.

**Phase 6 — Final parity sweep + doc reconciliation.** Wedge repro green; full
`classify` sweep with all three lifecycle buckets ~0 and no catastrophic state;
grammar-churn check; real-site spot check (YouTube home + a channel `/videos`
nav). Update `DESIGN_OBSERVER_DRIVEN_LAYOUT.md` cross-references; relocate this
note to `notes/completed/` if the lifecycle axis is settled.

## Open questions

- Does the reconciler subsume `IntersectionTracker` entirely, or does the
  tracker remain as the *signal source* (one global IO) feeding "band dirty"?
  Leaning toward the latter — keep the IO, strip its direct state mutation.
- Reconcile trigger set and debounce: scroll-settle, mutation-quiescence,
  nav-settle, alphabet-change, focus. What debounce keeps grammar churn bounded
  without visible badge lag?
- ~~Where does the desired-state predicate live so it is the single source of
  truth for both "is this hintable" (scan) and "should this have a hint now"
  (reconcile)?~~ **Resolved (Phase 1):** `src/lifecycle/desired-state.ts`.
  "Is hintable" stays in `scan/scanner.ts:isHintable`; "should have
  {codeword, hint} now" is `wantsCodeword` / `wantsHint`. Edge handlers and the
  future reconcile both consume them.
