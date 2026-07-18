# Settle Engine extraction — make the badge-lifecycle reachable without a browser

**Status:** IMPLEMENTED 2026-07-18 (steps 0-4 of section 8): `22d2d25` (step 0,
seams + BadgeHandle), `2442713` (step 1, settle pass + 14 unit tests),
`a56df22` (step 2, discovery/reposition/front-ends + 4 tests), `a858d3c`
(step 3, wireSettleSignals), `3d51567` (step 4, PageSessionDeps collapse via
pageSession.engine). Engine = src/lifecycle/settle-engine.ts over
settle-deps.ts. Deliberate delta from the proposal: front-end debounces are
SessionResources-backed (cancel at teardown). OPEN: step 5 (convert/prune the
~52 Playwright repro scripts down to a maintained soak suite) and the
consolidated real-Chrome soak before push. Original proposal (2026-06-13)
below.

**One-line motivation:** the render reaction never got a home. Grammar-sync
landed cleanly in `labels/label-sync.ts`; the settle/paint half — the largest
remaining cluster in `content.ts` and the one that causes nearly every recent
incident — is still ~1,200 lines of free functions closed over module state,
reachable only through Playwright. This extracts it into one constructed object
whose browser-touching collaborators are injected, so the whole pipeline runs in
vitest + happy-dom against fakes.

**The real prize is testability, not line count.** Scroll-back stranding,
missing badges, the nav-time wedge, occlusion, codeword churn — every one was
diagnosed and regression-guarded by hand-written Playwright drivers (52 of them
in `scripts/`, mostly rotted). They are slow, flaky, and gate nothing. The cut
below is the move that turns those into deterministic unit tests.

---

## 1. The cluster, measured

The unified-reconciler arc (notes/completed/DESIGN_UNIFIED_RECONCILER.md)
extracted the *plan*: `computeReconcilePlanLists` and `geometryInBand`
(`lifecycle/reconcile.ts`) and `gatherSettleReads` (`lifecycle/gather.ts`) are
pure and already unit-tested. What stayed in `content.ts` is the *driver* — the
thing that schedules the plan, applies it, and paints:

| Function | content.ts | Concern |
|---|---|---|
| `showHints` / `hideHints` / `clearHintFilter` / `scheduleHintRefresh` | 1195–1369 | settle (paint entry) |
| `badgeNewlyCodeworded` / `reattachStrippedHosts` | 1374–1479 | settle (build) |
| `reconcile` / `scheduleReconcile` | 1481–1501 | settle (convergence entry) |
| `applyLifecyclePlan` / `applyVisibilityPlan` / `applyStrictPlan` / `applyOcclusionPlan` | 1526–1612 | settle (the appliers) |
| `schedulePassSoon` | 1588 | settle (demoted backstop) |
| `scheduleBandDiscovery` / `runWhenIdle` | 1617–1710 | discovery |
| `runSettlePipeline` / `recordApplied` / `reconcileApplied` | 2867–2936 | settle (the ordered pass) |
| `scheduleReposition` | 2747–2778 | reposition |
| `noteReconcileScroll` / `reconcileScrollFrame` | 2789–2805 | reposition |
| `scheduleScrollReposition` / `scheduleDeferredReposition` | 2938–3016 | reposition + settle front-ends |
| `onTrackerCodewordsChanged` | 353–368 | settle (codeword reaction) |

Plus the module-scope mutable state these close over: `repositionRafPending`,
`reconcileScrollRaf`, `reconcileScrollActive`, `passSoonTimer`,
`hintRefreshScheduled`, `activeCategory`, and the `reconcileApplied` telemetry —
and the per-frame handles already on `PageSession` (`reconcileTimer`,
`scrollRepositionTimer`, `deferredRepositionTimer`, `discoverySweep*`).

---

## 2. The actual call graph

The cluster is three concerns, but they are **not** three independent stages —
they form a small cycle, and that shape is the whole reason the boundary
decision is interesting.

```
  SIGNALS (event listeners, all wired at content.ts module top level)
  scroll(win+doc capture) ─┐
  resize ──────────────────┤
  focusin/out ─────────────┤
  transition/animationend ─┤      ┌──────────────────────────────────────┐
  onContainerResize(RO) ───┼────► │ 3. REPOSITION / PAINT                 │
  onTargetMutation ────────┘      │   scheduleReposition (rAF 1-flight)   │
  pointerover/out ─────────┐      │   noteReconcileScroll/ScrollFrame     │
  visibilityMO tick ───────┼──┐   │   → reconcilePass() + off-screen hide │
  'f' keypress (show) ─────┼┐ │   └──────────────┬───────────────────────┘
  onCodewordsChanged ──────┼┼─┼─┐                │ scheduleReposition()
  nav / alphabet ──────────┘│ │ │                ▼   (settle ENDS in paint)
                            │ │ │   ┌──────────────────────────────────────┐
                            │ │ └──►│ 2. SETTLE / CONVERGE                  │
                            │ │     │   runSettlePipeline(band|store):      │
                            │ │     │     clip → GATHER → PLAN → APPLY×4    │
                            │ │     │   reconcile / badgeNewlyCodeworded    │
   schedulePassSoon ◄───────┘ │     │   apply{Lifecycle,Visibility,Strict,  │
   (visibility backstop)      │     │         Occlusion}Plan                │
                              │     └───┬───────────────────────▲──────────┘
                              │         │ scheduleBandDiscovery  │ reconcile()
                              │         ▼                        │ +showHints()
                              │     ┌──────────────────────────────────────┐
                              └────►│ 1. DISCOVERY                          │
   scheduleScrollReposition         │   scheduleBandDiscovery (1-flight +   │
   fans into BOTH 3 and 2 ─────────►│     retry/cooldown/depth-cap)         │
   (noteReconcileScroll +           │   → discoverInSubtreeBatched(body)    │
    debounced runSettlePipeline)    └──────────────────────────────────────┘
```

The back-edges that make this a cycle, not a line:

- `runSettlePipeline` (2) ends by calling `scheduleReposition` (3) — settle
  always finishes by painting (content.ts:2935).
- `runSettlePipeline` (2) calls `scheduleBandDiscovery` (1) on `band`, else
  `scheduleReconcile` (content.ts:2927-2928).
- `scheduleBandDiscovery` (1), on a non-empty sweep, calls `reconcile` then
  `showHints` (2) (content.ts:1684-1686).
- `applyLifecyclePlan` (2) re-enters `reconcile` (2) when it repairs a stale
  flag (content.ts:1537-1540).
- `scheduleScrollReposition` (3) drives both `noteReconcileScroll` (3) and a
  debounced `runSettlePipeline('band')` (2) (content.ts:2942-2961).
- `onTrackerCodewordsChanged` (2) ends in `reconcile` (2) (content.ts:367).

Everything reads one master gate, `pageSession.hintsVisible`, and one shared
collaborator, `pageSession.tracker` (the IntersectionTracker:
`flushNow` / `refreshViewportClaims` / `queueRelease`).

---

## 3. Why it is unreachable today

Three concrete blockers — each is a property of *where the code lives*, not what
it computes:

1. **Browser-only collaborators are called directly.** The appliers construct
   and drive `HintBadge` (`render/hints.ts` — `attachShadow`, `createElement`,
   `document.body.appendChild`, APCA color math), `placeBadges`/`placeOne`
   (`placement/` — `getBoundingClientRect`), the live `IntersectionTracker`,
   `applyOcclusion`, `reconcileClipObservation`, and the grammar queue
   (`queuePut`/`queueDelete`/`scheduleSync`). In happy-dom these mostly no-op or
   return zero rects rather than crash, but you cannot *assert* on them.
2. **Importing the code attaches global listeners.** The `addEventListener`
   calls (scroll, resize, focus, transition, pointer, container RO, target MO)
   run at module top level (content.ts:2779–3065). A test that imports the
   module wires the whole live page.
3. **The logic is free functions over module-scope `let`.** `activeCategory`,
   the rAF/timer flags, `reconcileApplied` — there is no object to construct
   with a fake, no seam to inject at.

The pure core (`computeReconcilePlanLists`, `gatherSettleReads`) already dodged
all three and is already tested. The driver is everything that did not.

---

## 4. Boundary Option A — one `SettleEngine`

One constructed object owns all three concerns. Collaborators that touch the
browser are injected at construction; the pure plan/gather stay imported pure
functions. No listeners inside the module — `content.ts` keeps the thin event
wiring and calls engine methods.

```
src/lifecycle/settle-engine.ts        NEW
  class SettleEngine {
    constructor(private c: SettleDeps) {}

    // --- signal API (content.ts listeners call these) ---
    show(filter?: Category | Category[]): Promise<void>
    hide(): void
    onScroll(e?: Event): void           // → scroll-frame loop + debounced settle('band')
    onDeferredSignal(): void            // focus/transition/container/resize → settle('store')
    onVisibilityTick(): void            // visibilityMO/pointer backstop → settle('store')
    onCodewordsChanged(claimed, released): void
    settleNow(reason): void             // nav/alphabet synchronous path

    // --- internals (private; the ordered pipeline stays ONE method) ---
    private settle(discovery: 'band' | 'store'): void   // = runSettlePipeline
    private reconcile(): void                            // build-up convergence
    private reposition(): void                           // = scheduleReposition body
    private bandDiscovery(): void                        // 1-flight + retry
  }

interface SettleDeps {
  store: ObservableWrapperStore;        // real store, fake-able wrappers
  tracker: TrackerOps;                  // flushNow/refreshViewportClaims/queueRelease
  badges: BadgeOps;                     // make/show/hide/label/reattach/remove
  positioner: PositionerOps;            // reconcilePass/registrySize (render/reconcile-positioner)
  sync: SyncOps;                        // queuePut/queueDelete/scheduleSync
  discovery: () => Promise<number>;     // discoverInSubtreeBatched(body)
  occlusion: OcclusionOps; clip: ClipOps;
  scheduler: Scheduler;                 // setTimeout/rAF/idle — fake-able clock
  isHintsVisible(): boolean; displayMode(): DisplayMode; activeCategory(): Category | null;
}
```

The pure decision (`computeReconcilePlanLists`) and the read batch
(`gatherSettleReads`) are imported directly — they need no seam, they are
already pure. The engine is orchestration plus the `apply*` writes, and the
`apply*` writes go through `badges` / `sync` / `tracker`, which are the fakes.

**Why one object fits the graph.** The back-edges in section 2 are real and
short-cyclic. In one object they are private method calls — legible, in one
place, and the load-bearing step order of `settle()` stays exactly where the
2026-06-11 review put it (one ordered method, not comment-coordinated copies).
The injection seams are the `SettleDeps` boundary, and that boundary is the test
surface.

**Risk.** A ~1,000-line object can regrow into a monolith-in-miniature. The
guard is that the *decisions* are forbidden from living here — they stay in
`lifecycle/reconcile.ts` + `gather.ts` (pure, tested); the engine only
sequences and writes. Each `apply*` stays a small private method with its own
test.

---

## 5. Boundary Option B — three modules

Split along the three concerns into peer modules, matching the existing
`observe/ lifecycle/ render/` grouping:

```
src/observe/band-discovery.ts    scheduleBandDiscovery + single-flight/retry/cooldown
src/lifecycle/settle-pass.ts     runSettlePipeline + apply* + reconcile + badgeNewlyCodeworded
src/render/reposition.ts         scheduleReposition + scroll-frame loop + off-screen hide
src/lifecycle/settle-signals.ts  the event-listener wiring (imports the three, routes signals)
```

Each module is small and single-concern, and `settle-pass.ts` becomes the
crown-jewel pure-ish unit (gather → plan → apply over a fake store).

**Where the cut bleeds.** The section-2 back-edges become *cross-module* edges,
and modules cannot import each other cyclically:

- `settle-pass` → `reposition` (every settle ends in paint)
- `settle-pass` → `band-discovery` (the `band` branch)
- `band-discovery` → `settle-pass` (`reconcile` + `show` after a non-empty sweep)
- `reposition` → `settle-pass` (`scheduleScrollReposition`'s debounced `band` settle)

A → B → A is a cycle. Breaking it needs callback indirection (each module takes
the others' entry points as injected functions) — which is exactly the
`PageSessionDeps` 13-callback pattern we are trying to *retire*, relocated from
`content.ts` into a ring of three modules. And splitting `runSettlePipeline`'s
ordered body across `settle-pass` (steps 1,3-6) and `reposition` (step 7) and
`band-discovery` (step 2) re-opens the drift the unified-reconciler arc just
closed by consolidating the two duplicated handlers into one method.

---

## 6. Recommendation: Option A, with injection as the hard requirement

Pick the single `SettleEngine`, and treat the `SettleDeps` injection boundary —
not any file split — as the deliverable.

The principle the call graph forces: **testability comes from dependency
injection, not from file-splitting.** A 1,000-line object whose collaborators
are injected is fully unit-testable; three 300-line modules that call each other
through real DOM are not. Option B pays the cost of the cut (four cross-module
back-edges via callbacks, a re-split pipeline) and does not even buy the prize —
you still cannot drive `settle-pass` without `band-discovery` and `reposition`,
so you still inject, so you have Option A's seams *plus* three files and a
re-drift risk.

Option A keeps the cycle's back-edges as private calls in one place, keeps the
ordered pipeline intact, and puts the entire browser surface behind one
injectable interface. That interface is what kills Playwright-dependence.

The one honest caveat is the monolith-in-miniature risk (section 4). It is
manageable and cheaper than B's structural costs.

---

## 7. The test strategy that retires Playwright

This is the section that justifies the whole change. With `SettleEngine` taking
`SettleDeps`, a vitest + happy-dom test constructs the engine over fakes and
drives the signal API:

```
Fakes (a few hundred shared lines, mirroring the fake-chrome helper background/ needs):
  FakeBadge   implements BadgeOps   — records show/hide/setLabel/reattach/remove; isVisible togglable; host = detached div. No shadow DOM, no APCA.
  FakeTracker implements TrackerOps — records queueRelease; flushNow resolves now; refreshViewportClaims scripted.
  FakeSync    implements SyncOps    — records queuePut/queueDelete/scheduleSync  (the GRAMMAR assertions)
  FakePositioner                    — records reconcilePass calls; returns scripted rects (the OFF-SCREEN-HIDE assertions)
  FakeDiscovery                     — scripted "added N wrappers"
  store = real ObservableWrapperStore over happy-dom ElementWrappers (the existing test pattern in core/*.test.ts)
  time  = vi.useFakeTimers() for setTimeout; injected rAF/idle via scheduler  (deterministic debounce / single-flight / retry)
```

The assertions are end-to-end over the source→store→reaction contract with no
browser:

| Hard-won fix (today: a Playwright repro) | Becomes a unit test of |
|---|---|
| scroll-back missing / stranded badges | `settle('store')`: stale-FALSE repair → rebuild; stale-TRUE → release. Assert FakeBadge + FakeSync deltas. |
| nav-time wedge | no unbounded rAF — assert the scroll-frame loop self-cancels one frame after the last `onScroll`. |
| band-discovery race | single-flight: `onScroll` storm under a fake clock yields exactly one in-flight sweep; rerun/retry only on `added==0 && coalesced`, depth-capped. |
| codeword churn loop (the reverted `toClaim`) | repeated `settle` over a steady store emits zero new `queuePut` (no over-claim). |
| occlusion hide | `applyOcclusionPlan` over a scripted `gather.overlayCovered` hides the badge and drops it from strict. |
| doubled-word / over-sync | `onCodewordsChanged` + `settle` produce exactly the expected grammar push count. |

Keep ~6–8 Playwright drivers as a thin *maintained* soak suite (shared fixtures,
one runner) for the things unit tests genuinely cannot see — real shadow-DOM
placement, real IO timing, the 30-minute steady-state browse the project's soak
discipline requires. Delete the other ~45. The soak stops being "whatever script
last worked" and becomes a known-good harness, while the regression net moves to
fast deterministic units.

---

## 8. Migration sequence (behavior-preserving, one soak at the end)

Each step keeps `npm test` green and is independently revertable; nothing is
pushed until one consolidated real-Chrome soak passes (the project's batched-soak
rule, same as the restructure).

0. **Name the seams.** Define `BadgeOps` / `TrackerOps` / `PositionerOps` /
   `SyncOps` / `OcclusionOps` / `ClipOps` / `Scheduler` as interfaces over the
   concrete impls that already exist. Pure typing; no behavior.
1. **Lift the ordered pass.** Move `runSettlePipeline` + the four `apply*` +
   `reconcile` + `badgeNewlyCodeworded` + `reattachStrippedHosts` into
   `SettleEngine`, constructed in `content.ts` with the real impls. content.ts
   keeps its listeners, now calling `engine.settle(...)` etc. Land the fake
   collaborators + the settle-pass unit tests in the same commit.
2. **Lift discovery + reposition.** `scheduleBandDiscovery`, `scheduleReposition`,
   the scroll-frame loop, and the two front-ends become engine methods/internals.
   Add the single-flight and scroll-loop unit tests.
3. **Move the wiring.** A thin `wireSettleSignals(engine)` called once from boot
   holds the `addEventListener` calls, so importing `settle-engine.ts` attaches
   nothing — the property the tests need.
4. **Collapse the redundant `PageSessionDeps`.** `showHints`, `schedulePassSoon`,
   `scheduleReposition`, `scheduleDeferredReposition`, and the `discover*` hooks
   were callbacks *only because the driver lived in content.ts*. Sources now call
   engine methods through the `pageSession`-or-engine singleton; those entries in
   the deps interface die.
5. **Convert + prune the Playwright repros** (section 7) and wire the maintained
   soak job into the existing `.github/workflows/ci.yml`.

---

## 9. Where this leaves the architecture

- **The render reaction finally has a home.** `source → store → reaction` is now
  true on both reactions: grammar = `labels/label-sync.ts`, render =
  `lifecycle/settle-engine.ts`. The restructure's dropped "badge-manager
  subscribes to deltas" is resolved — render is viewport/scroll-signal-driven,
  not delta-driven, so it is an engine over the store read-model, not a delta
  subscriber. (That distinction, found during the Tier 2 cut, is why this is a
  separate doc and not a delta subscription.)
- **`content.ts` becomes construct-and-wire.** What remains is boot, the keyboard
  dispatch, the RPC/action handlers, the perf-snapshot integrator, and
  `engine` + `pageSession` construction. The `PageSessionDeps` seam mostly
  dissolves (step 4).
- **CI gains teeth.** The unit layer makes the required `npm test` check
  meaningful for the highest-incident path; the maintained soak becomes a slower
  manual job.

---

## 10. Open questions

- **Unify `reconcile()` and `settle()` or keep two entries?** `reconcile` is the
  cheap build-up pass on the `onCodewordsChanged` cadence; `settle` is the full
  ordered gather→plan→apply. Folding them risks running the heavy gather on every
  codeword flush; keeping them two preserves a fast path but is two entry points
  to reason about. Decide explicitly during step 1 — do not silently fold.
- **Do `occlusion` / `clip` stay injected, or move inside the engine?** They are
  flag-gated and already extracted; injecting keeps the engine honest about its
  reads, but adds two more `SettleDeps` fields. Lean injected; revisit if the
  interface bloats.
- **Scheduler abstraction depth.** `vi.useFakeTimers()` covers `setTimeout`
  cleanly; rAF and `requestIdleCallback` need an injected `scheduler` for
  deterministic single-flight/retry tests. Keep the abstraction to just those
  two methods — do not build a general effect system.

---

## Related documents

- notes/DESIGN_EXTENSION_RESTRUCTURE.md — the parent arc; this is the render
  reaction it deferred (its "badge-manager" idea, re-grounded).
- notes/completed/DESIGN_UNIFIED_RECONCILER.md — the pure plan/gather this
  consumes, and the step-order consolidation Option B would undo.
- notes/completed/DESIGN_HINT_LIFECYCLE_RECONCILER.md — origin of
  `reconcile` / `badgeNewlyCodeworded` as the level-triggered build-up.
- notes/completed/DESIGN_NAV_WIPE_RETIREMENT.md — the `toClaim` revert and the
  standing-claim-backstop open question the discovery concern inherits.
- notes/DESIGN_OBSERVER_DRIVEN_LAYOUT.md — the positioning/reconcilePass model
  the reposition concern drives.
- notes/DESIGN_HINT_OCCLUSION_FILTERING.md — the `applyOcclusionPlan` detection.
- notes/DESIGN_HINT_REUSE.md — the dormant-hint reuse `badgeNewlyCodeworded`
  depends on.
