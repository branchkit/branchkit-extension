# Extension Restructure — a store-centric reactive architecture

**Status:** partially landed; re-conceived 2026-06-06. The original diagnosis
(a content script with no internal boundaries) still holds and has gotten
worse, not better. This revision replaces the earlier "linear stage pipeline"
target with a model that actually matches the code — a shared store with signal
sources feeding it and reactions responding to it — and folds in a testing plan,
because the investigation found that the untested code and the un-extracted code
are the same code.

**One-line motivation:** every bug fix lands as another top-level function and
another module-scoped observer inside `content.ts`, so the system gets harder to
reason about with every fix. We restructure so the remaining work lands against
a boundary instead of into a pile.

---

## 1. Current state, measured

### 1.1 The monoliths are regrowing

| File | Lines | Role | Tests |
|---|---|---|---|
| `content.ts` | **4,134** | per-frame content script: owns ~15 concerns | none |
| `background.ts` | **1,687** | service worker: transport, routing, injection | none |
| everything else | ≤1,083 | extracted feature modules | mostly good |

`content.ts` was ~2,854 lines on 2026-05-30, when the previous version of this
doc declared "step-1 leaf extraction substantially done." It is now 4,134 — a
45% regrowth in a week, entirely from the badge-lifecycle / occlusion /
scroll-back fixes that all landed as new top-level functions in the monolith.
This is the thesis demonstrating itself: with no boundary, fixes accrete in the
one file, and the previous restructure's gains were erased by a normal week of
bug-fixing. A plan that doesn't change where fixes *land* will lose this race
again.

### 1.2 The shape of `content.ts`: one core, a ring of satellites

A coupling analysis (which top-level block touches which module-level state)
shows `content.ts` is not 15 separable concerns. It is one **strongly-connected
core** with satellites:

- **The core (the tangle).** `store` (the `WrapperStore` instance) is referenced
  by **52 of ~70 top-level blocks**. Around it sit the lifecycle functions
  (`attachWrapper` / `detachWrapper`), the render orchestrators (`showHints` /
  `hideHints`), and the six observers whose inline callbacks call all of those.
  They reference each other through `store` and through direct calls, so none of
  them lifts out alone.
- **The satellites.** Limbo/rebind, visibility-recovery, reposition scheduling,
  and discovery/mutation-drain each own a small pocket of private state but reach
  into the core by calling 2–4 of its functions (`attachWrapper`, `detachWrapper`,
  `showHints`, `scheduleSync`).

Two facts from the analysis make the path tractable:

- **All 11 hub singletons are declared once and never reassigned** — `store`,
  `tracker`, `observer`, `resizeObserver`, `attentionObserver`, `targetRectStore`,
  `visibilityIO`, `visibilityMO`, `registry`, `dispatcher`, `keyHandler`. They are
  stable references, not mutable state, so they are safe to make importable.
- **`schedulePushGrammar` is a one-line alias** to `scheduleSync` (already in
  `labels/label-sync.ts`). The lifecycle's "tell the grammar to update" edge is
  already a thin call into an extracted module — it just isn't modeled as a
  subscription yet.

### 1.3 Why the satellites are coupled: imperative fan-out

The reason the core is strongly connected is that **state mutation and reaction
are interleaved imperatively**. `attachWrapper` does not just add a wrapper to
the store — it also calls `scheduleSync()` (push grammar) and, on some paths,
`scheduleReposition()` / `showHints()` (paint). `detachWrapper` does the same in
reverse. Every site that changes the wrapper set must remember to also poke
grammar and render. That "remember to also poke" is the coupling, repeated at ~50
call sites.

### 1.4 The testability gap is the extraction gap

Unit coverage by directory:

```
scan/      9 src,  9 test      observe/   6 src, 4 test
labels/    7 src,  7 test      placement/ 5 src, 4 test
activate/  6 src,  5 test      render/    5 src, 3 test
lifecycle/ 4 src,  3 test      rules/     4 src, 2 test
debug/     3 src,  1 test
adapters/  2 src,  0 test      plugin/    2 src, 0 test
src/ root 11 src,  0 test   ← content.ts, background.ts, options, popup, …
```

The extracted modules are well-tested (538 tests total). The untested surface is
precisely the code that hasn't been extracted: both monoliths, the entry points,
adapters, and the plugin transport. The lifecycle logic that causes the most
production incidents (limbo, rebind, visibility, nav) is only reachable through
the monolith, so it can only be exercised by the ad-hoc Playwright drivers, not
by unit tests. **Extraction is the lever for testability** — the two goals are
the same move.

### 1.5 Supporting gaps found while investigating

- **No CI.** There is no `.github/workflows`. The 538-test suite runs only when
  someone types `npm test`. Nothing gates a merge.
- **Integration tests are 52 throwaway repros.** `scripts/` holds 52
  `_test-*` / `_drive-firefox-*` Playwright drivers (vs. 6 maintained harnesses).
  Each was written to reproduce one hard bug, then left to rot. The "30-minute
  soak before merge" discipline this project relies on (orphan-teardown and nav
  changes have repeatedly broken steady-state browsing despite green unit tests)
  is run by hand against these, with no shared fixtures and no guarantee any
  given script still works.
- **`background.ts` is a second, lighter monolith.** It is mostly async functions
  over ~8 connection-state globals (`pluginPort`, `pluginToken`,
  `branchkitConnected`, `cachedActiveTabId`, `directSSE`, the retry timers). Its
  seams are cleaner than `content.ts`'s because it is procedural and stateless-ish,
  but it is untested and growing.

---

## 2. The improved concept: store-centric reactive

A content script is a small reactive system. Signals come in (DOM mutations,
viewport/scroll/resize, navigation, voice/keyboard commands, page-driven
visibility changes); two outputs go out (badges painted, grammar pushed to the
plugin). The previous doc modeled this as a **linear pipeline** of stages
(Discovery → Lifecycle → Label → Render). That framing is wrong for this code:
limbo/rebind and visibility-recovery are *feedback loops* (a disconnect parks a
wrapper, a later mutation rebinds it; an invisible candidate later becomes
visible and is promoted), and several signals (scroll, resize, command) skip
"discovery" entirely. Forcing them into a 4-stage line is why the previous plan
stalled at the interfaces.

The accurate model is **one store, many sources, a few reactions**:

```
            sources                         the model                 reactions
  ┌───────────────────────────┐         ┌──────────────┐        ┌──────────────┐
  │ MutationObserver           │         │              │        │ grammar sync  │
  │ IntersectionTracker        │ mutate  │ WrapperStore │ emit   │ (label-sync)  │
  │ AttentionObserver          ├────────►│   + deltas   ├───────►│              │
  │ visibility IO/MO           │         │              │ delta  │ render/place  │
  │ resize / scroll            │         │ single source│        │ (badge paint) │
  │ message listener (cmd/nav) │         │ of truth     │        │              │
  └───────────────────────────┘         └──────────────┘        └──────────────┘
```

- **The store is the single source of truth** for "what hintable elements exist
  and what state each is in" (live / limbo / in-viewport / codeworded / hinted).
  It already exists as `WrapperStore`; today it is a passive container.
- **A Source translates one external signal into store mutations** and nothing
  else. The observers, the discovery walk, and the message listener are sources.
  A source's only job is "the world changed → tell the store."
- **A Reaction responds to store deltas** to produce an output. There are exactly
  two: grammar-sync (push codewords to the plugin) and render (mount / position /
  tear down badges). Reactions never mutate the wrapper set; they only read it
  and emit side effects.

### 2.1 The surgical cut: make the store emit deltas

The single change that dissolves the strongly-connected core is to give the
store an **observable delta stream**:

```ts
type WrapperDelta =
  | { kind: 'attached';   wrapper: ElementWrapper }
  | { kind: 'detached';   wrapper: ElementWrapper }
  | { kind: 'rebound';    wrapper: ElementWrapper; from: Element }
  | { kind: 'visibility'; wrapper: ElementWrapper; visible: boolean };

store.attach(w);         // mutates the set AND emits { kind: 'attached', … }
store.subscribe(onDelta) // grammar-sync and render subscribe here
```

Today `attachWrapper` is `store.add(w)` plus an imperative `scheduleSync()` plus
sometimes `scheduleReposition()`. After the cut, `attachWrapper` is just
`store.attach(w)`; grammar-sync and render are subscribers that decide for
themselves what an `attached` delta means (sync debounces a grammar push; render
schedules a paint). The ~50 "remember to also poke grammar/render" call sites
collapse into one subscription per reaction.

This is what converts the core from a cycle into a flow:

```
   before (cycle)                         after (flow)
   attachWrapper ─► scheduleSync          source ─► store.attach
        ▲   │  └──► showHints                          │ emits delta
        │   ▼                                          ▼
   observers ◄─ rebindWrapper             grammar-sync   render   (subscribers)
   (everyone calls everyone)             (one-way; no back-edges to lifecycle)
```

It is also the change that makes the lifecycle unit-testable: a test mutates a
fake store and asserts on the emitted deltas, with no observers, no DOM paint,
and no plugin transport in the picture.

### 2.2 PageSession owns the wiring and the lifecycle

`PageSession` (already exists, `lifecycle/page-session.ts`) is the per-frame
object that constructs the store, the sources, and the reactions, wires the
subscriptions, and owns the lifecycle transitions (`start` / `onUrlChange` /
`restore` / `teardown`). It is currently a transitional injection seam — it holds
per-frame timer/flag state but delegates the actual logic to free functions in
`content.ts` via hooks. The end state is that `content.ts` constructs one
`PageSession` and does nothing else; the session owns the graph.

---

## 3. Target file structure

The directory grouping is already good — `scan/ observe/ placement/ labels/
render/ activate/ rules/ lifecycle/ plugin/ debug/ adapters/` are intent-based
and mostly one-concern-per-file. The restructure does **not** rename these; it
fills the gaps and assigns each file a role (source / reaction / model /
wiring). `(exists)` = present today; `NEW` = to be extracted from a monolith.

```
src/
  content.ts                 // GOAL: construct one PageSession, nothing else
  background.ts              // GOAL: construct the SW objects below, nothing else
  types.ts                   // (exists) shared types — stays at root
  layout-cache.ts            // (exists) cross-cut rect/style cache — stays at root
  config.ts, bootstrap.ts    // (exists) storage-backed settings + boot entry

  core/                      // NEW dir — the model + the graph
    store.ts                 //   (exists) WrapperStore instance; delta emitter lands here in Tier 2
    singletons.ts            //   (exists) dispatcher/registry/keyHandler/targetRectStore instances
    wrapper-lifecycle.ts     //   (exists) attach/detach (the SCC core); limbo/rebind
                             //        in observe/limbo.ts, the discovery walk still in
                             //        content.ts. Eventually emits store deltas instead
                             //        of calling grammar/render directly (Tier 2)

  lifecycle/                 // (exists) the per-frame session + reconcile policy
    page-session.ts          //   (exists) owns start/teardown/onUrlChange/restore
    reconcile.ts, strict-viewport.ts, desired-state.ts   // (exist)

  observe/                   // SOURCES — translate one signal into store mutations
    intersection-tracker.ts, attention-observer.ts       // (exist)
    target-rect-store.ts, *-tracker.ts                   // (exist)
    visibility-tracker.ts    //   (exists) pendingVisibility + visibility IO/MO
    limbo.ts                 //   (exists) limbo/rebind/finalize over the store
    mutation-source.ts       //   (exists) the discovery MutationObserver + drain + coalesce

  scan/                      // (exists) pure DOM → candidates (a source's helper)
  placement/                 // (exists) position math (a render helper)
  labels/
    label-sync.ts            // (exists) REACTION: subscribe to deltas → grammar push
    label-pool.ts, rebind.ts, …                          // (exist)
  render/
    hints.ts, badge-colors.ts                            // (exist)
    badge-manager.ts         //   NEW: REACTION: subscribe to deltas → mount/position
  activate/                  // (exists) act-on-a-chosen-target stage
  rules/, plugin/, debug/, adapters/                     // (exist)
```

New files are few and each is a lift of an existing cluster, not a green-field
abstraction: `core/store.ts` (the delta cut), `core/wrapper-lifecycle.ts`,
`observe/visibility-tracker.ts`, `observe/mutation-source.ts`,
`render/badge-manager.ts`. The integrator `buildPerfSnapshot` stays in
`content.ts` (it reads counters from everywhere by design); the data-only
counters it reads move into `debug/perf-counters.ts`.

---

## 4. The background service worker

`background.ts` gets the same treatment at lower risk, because its coupling is to
~8 connection globals rather than a shared DOM model. Target extractions, each
testable with a faked `chrome.*`:

- `plugin/actuator-client.ts` — **Landed 2026-06-07.** Owns the connection
  (`pluginPort` / `pluginToken`, `discoverPlugin`) and the authed-POST boilerplate
  the ~12 `forward*` / `post*` / reference forwarders duplicated. Two postures
  preserved: `ensureConnected()` (discover-on-miss) for the diagnostic/grammar/
  reference pushes, and bare `postToPlugin()` (bail-on-miss) for focus / active-tab.
  `background.ts` reads the connection via `getPluginPort`/`getPluginToken` (SSE
  path). 8-test spec with a faked `fetch`; background.ts 1,687 → 1,506 lines.
  (`branchkitConnected` stays in background.ts — it's SSE state, not plugin-HTTP.)
- `plugin/sse-transport.ts` — the offscreen-vs-direct SSE split
  (`ensureOffscreen` / `connectDirectSSE` / `handleSSEEvent` + retry/backoff).
- `background/injection.ts` — `injectContentScriptFiles` / `tryInject` /
  `pingContentScript` / `withInjectLock` / `ensureContentScriptInjected` /
  `reinjectContentScripts` (the inject-lock state machine).
- `background/frame-router.ts` — `routeFrameForAction` / `resolveHintFromTab` /
  `broadcastToAllTabs` / `notifyActiveTab` / `resolveActiveContentTab`.
- `background/tab-sessions.ts` — `purgeTab` / `endHintSessionOnOldTab` /
  `logTabSwitch` / `scheduleSpaRescan` and the per-tab maps.

`background.ts` then constructs these and registers the chrome listeners. This is
mostly mechanical and is the cheapest place to demonstrate the "construct objects,
own nothing" end state before doing it to `content.ts`.

---

## 5. Migration sequence (clean end state via transitional seams)

Sequenced so each step ships independently, the extension stays working, the
final step deletes the scaffolding, and the risky change (the delta cut) lands
only after the cheap de-risking moves. Each step keeps `npm test` green and is
independently revertable. Per the project's soak discipline, work that touches
lifecycle, observers, or teardown gets a 30-minute real-browser soak before merge
— not just unit green. **Decision 2026-06-06:** the soak is batched once at the
end of the *whole refactor* (Tiers 1–3, each step behavior-equivalent and
unit-verified) rather than after every commit or tier. Steps land back-to-back
behind green tests + clean builds; nothing is pushed until that single
consolidated real-Chrome soak passes. Tier 2's delta cut keeps a transitional
double-drive (new subscribers alongside the old imperative calls, verified equal
before deletion) so it too stays behavior-equivalent and inside the one soak.

**Tier 0 — enabling moves (mechanical, no behavior change, do first).**
These carry essentially no risk and unblock everything after them.
1. **Promote the plain singletons** (`store`, `targetRectStore`, `registry`,
   `dispatcher`, `keyHandler`) into importable modules. `store` alone is the
   52-block import barrier; these five have no inline callbacks, so the move is a
   pure relocation. (The six observers carry page-coupled inline callbacks — they
   move later, with their source clusters.) **Landed 2026-06-06**: `core/store.ts`
   holds `store`; `core/singletons.ts` holds the other four; `content.ts` imports
   them. Behavior-identical, suite green.
2. **Move the data-only counters** (`mo*`, `finalize*`, `dropDisconnected*`,
   `discoveryRoots*`) into `debug/perf-counters.ts`; blocks bump fields on the
   imported `lifecycleCounters` object, `buildPerfSnapshot` spreads it. Removes a
   whole fan-out cluster and makes the integrator's inputs explicit. **Landed
   2026-06-06**: the eleven bare-`let` counters became the `lifecycleCounters`
   object in `debug/perf-counters.ts` (with `resetLifecycleCounters`). Note:
   `claimCounters` and `rebindCounters` were deliberately left in place — they are
   already objects (no exported-`let` reassignment problem) and `rebindCounters`
   is also read by `render/debug-overlay.ts`; move them only if a later extraction
   needs them, to keep this step's blast radius to content.ts alone.

**Tier 1 — lift the satellites (medium risk, one soak at end of tier).**
With `store` importable, each satellite cluster becomes a one-file lift that
still calls the core imperatively (no delta cut yet):
3. `observe/visibility-tracker.ts` — the `pendingVisibility` + visibility IO/MO
   recovery loop. **Landed 2026-06-06**: the set, both visibility observers, and
   the recheck/throttle logic moved out; `content.ts`'s attention observer feeds
   it via `trackPendingCandidate` / `untrackPendingCandidate`, and `attachWrapper`
   / `showHints` / `pageSession` are injected via `initVisibilityTracker` (the
   transitional seam). `observeInvisibleCandidates` stays in `content.ts` with the
   attention observer it drives. Teardown now also clears the pending set and the
   abandon timer (the inline version only disconnected the observers — a latent
   stray-timer fix). Shipped with a 5-test spec; tsc clean, 543 tests green.
   **Soak still owed** before this is trusted/pushed — it touches the
   visibility-observer + teardown paths the project flags as high-blast-radius.
4. `observe/limbo.ts` — limbo / rebind / finalize orchestration over the store.
   **Landed 2026-06-06**: `collectLimboWrappers` / `tryRebindFromLimbo` /
   `rebindWrapper` / `dropDisconnectedWrappers` / `finalizeExpiredLimboWrappers`
   and the `rebindCounters` instance moved out (~185 lines); the pure
   rebind-distance decision already lived in `labels/rebind.ts`. `detachWrapper`
   and the two observers it re-anchors on (`tracker`, `resizeObserver`) are
   injected via `initLimbo`. Shipped with a 6-test spec; tsc clean, 549 tests
   green. **Soak owed** (batched — see above).
5. `core/wrapper-lifecycle.ts` — attach/detach. **Order correction (2026-06-06):**
   this must precede `mutation-source` below, not follow it. `mutation-source`'s
   `processMutations` → `drainDiscovery` → `discoverInSubtree` → `attachWrapper` /
   `tryRebindFromLimbo`, and `drainReevaluations` → `reevaluateAttribute` →
   `attachWrapper` / `detachWrapper` — i.e. the source sits *on top of* the
   lifecycle. Extracting lifecycle first lets `mutation-source` import it instead
   of injecting a large surface. **Landed 2026-06-06**: `attachWrapper`,
   `detachWrapper`, `seedPreferredFromMemory`, `reconcileEvictedCodewords`, and
   `attachDiscovered` moved out (~112 lines); the three observers
   (`tracker` / `resizeObserver` / `attentionObserver`) are injected via
   `initWrapperLifecycle`. Scoped tighter than the original sketch: the discovery
   *walk* (`discoverInSubtree` / `discoverInSubtreeBatched`) and
   `reevaluateAttribute` stayed in content.ts — they reach the rules / attention /
   shadow surfaces and move with `mutation-source` (step 6), which keeps this
   lift's injection to the three observers. 4-test spec; tsc clean, 553 tests
   green. **Soak owed** (batched). Note the accumulating observer-injection
   surface (`limbo` + this lift inject `tracker`/`resizeObserver`/
   `attentionObserver`) is the signal that Tier 3 (observer relocation) is the
   natural close of this arc.
6. `observe/mutation-source.ts` — the discovery MutationObserver + drain +
   reevaluation coalescing, importing the lifecycle/limbo modules above.
   **Landed 2026-06-06**: the page `observer`, `processMutations`,
   `scheduleDiscovery`/`drainDiscovery`, `scheduleReevaluation`/`drainReevaluations`,
   `isOwnMutation`, `hasQueuedAncestor`, and the huge-mutation short-circuit moved
   out (~357 lines). Scoped to the *source* machinery: the discovery walk
   (`discoverInSubtree`/`discoverInSubtreeBatched`), `reevaluateAttribute`, and the
   reposition schedulers stay in content.ts (rules/attention/shadow + reposition
   coupled) and are injected via `initMutationSource`. Two supporting moves fell
   out: `firehoseStep` (used all over content.ts) became the shared
   `debug/firehose.ts`, and the manual-mode `pendingMutation` flag moved onto
   `PageSession` (consolidating per-frame flags, avoiding an extra inject).
   `teardownMutationSource` disconnects the observer for quiesceOrphan. 4-test
   routing spec; tsc clean, 557 tests green. **Soak owed** (batched). This is the
   perf-critical firehose (YouTube-freeze territory) — the highest-priority thing
   to watch in the consolidated soak.

**Tier 1 is now complete.** `content.ts` is down from 4,134 → 3,225 lines; the
satellites + lifecycle/limbo/mutation source live in their own modules behind
injection seams. The four behavior-affecting commits (visibility, limbo,
wrapper-lifecycle, mutation-source) await the one batched real-browser soak
before anything is pushed.

**Tier 2 — the delta cut (the architecture change, highest value).**
7. Add the delta emitter to `core/store.ts`. Mutators emit; nothing subscribes
   yet (deltas are dead). Pure addition, behavior-identical.
8. Make `label-sync` and `badge-manager` **subscribe** to deltas, while the
   imperative `scheduleSync` / reposition calls still fire (transitional
   double-drive). Verify subscribers produce the same pushes/paints as the
   imperative calls.
9. **Delete the imperative calls.** This is the commit that breaks the cycle:
   sources mutate the store, reactions subscribe, lifecycle no longer references
   grammar or render. The transitional double-drive from step 8 is removed here.

**Tier 3 — finish the wiring.**
10. Move source construction (the six observers, with their now-thin callbacks)
    onto `PageSession.start()`. This was the "entangled boot" the previous plan
    deferred — it is safe *now* because steps 5–9 made the observer callbacks thin
    (mutate the store, no reaching into render/grammar). This also retires the
    growing observer-injection surface the Tier 1 lifts accumulated (`limbo` and
    wrapper-lifecycle inject `tracker` / `resizeObserver` / `attentionObserver`).
11. `background.ts` extraction (Tier-0-equivalent risk; can run in parallel any
    time — see section 4).
12. **Delete the residue.** `content.ts` and `background.ts` become construct-and-
    wire only; transitional shims are gone.

The previous plan's stage interfaces (`DiscoveryStage` / `LifecycleStage` /
`LabelStage` / `RenderStage`) are **dropped** — the source/reaction split plus
the delta stream is the boundary, and four parallel interfaces over a feedback
system added indirection without matching the data flow.

---

## 6. Testing plan (improve as we go)

The restructure is also the testing fix; these are not separate projects.

- **Unit-testability falls out of extraction.** Each Tier-1/Tier-2 module lands
  with its own spec: `wrapper-lifecycle` (attach → limbo → rebind → finalize,
  asserting on emitted deltas against a fake store), `visibility-tracker`
  (candidate → promote), `badge-manager` (delta → mount/position via the existing
  `placement` tests' fixtures). Today none of this is reachable without the
  monolith. Rule for the migration: **a cluster is not "extracted" until it has a
  spec** — the move and the test land in the same commit.
- **The delta cut makes the core logic pure.** After step 6, the
  source→store→reaction contract is testable end-to-end in `happy-dom` with no
  observers and no plugin transport: drive a fake source, assert the deltas, then
  assert the subscribers' outputs. This is the highest-value new coverage and is
  impossible before the cut.
- **`background.ts` becomes testable with a faked `chrome.*`.** `ActuatorClient`,
  `injection`, and `frame-router` are async functions over chrome APIs; a thin
  `fake-chrome` test helper (a few hundred lines, shared) unlocks all of them. No
  such helper exists today, which is why `background.ts` has zero tests.
- **Promote the load-bearing Playwright repros into a maintained suite.** The 52
  ad-hoc drivers encode real regressions (nav-time wedge, scroll-back missing /
  stranded badges, codeword stability, perf soak). Pick the ~8 that map to
  hard-won fixes, give them shared fixtures and a runner, and delete the rest.
  The soak-before-merge step then runs a known-good harness, not whatever script
  last worked. This is the integration analogue of "a cluster isn't extracted
  until it has a spec."
- **Add CI.** A GitHub Actions workflow running `npm test` and `tsc --noEmit` on
  every PR. The suite is large and currently gates nothing; wiring it as a
  required check is a few lines and stops the next regression from depending on
  someone remembering to run tests locally. (The maintained integration suite can
  follow as a separate, slower, manually-triggered job once it exists.)

---

## 7. What we preserve, what we drop, and the risks

**Preserved intact (this is a boundary change, not a logic change).** Square-fill
label pool, limbo/rebind identity stability, the attention-region lifecycle,
delta-sync grammar, the two-IO split (narrow-margin claim vs. wide-margin
candidacy), the CSS-anchor / reconcile positioning model. They move into their
owning modules unchanged.

**Carried forward from prior work (do not relitigate):**
- **SPA-nav detection stays background-driven.** `chrome.webNavigation.
  onHistoryStateUpdated` (+ `onReferenceFragmentUpdated`) is the correct signal —
  `tabs.onUpdated` cannot distinguish a History-API nav from a full load. It
  routes into the existing bounded `rescan` action; `PageSession.onUrlChange` is
  the content-side handler. Do **not** monkey-patch `history.pushState` in the
  page world.
- **Codeword reclamation on navigation is content-side.** A same-document nav
  keeps the content script alive; disconnected wrappers go limbo → finalize →
  `releaseLabel` within ~500ms. The content script owns codeword truth; the
  background pool is a derived cache. Background `purgeTab` stays wired to tab
  close (`onRemoved`) only.
- **The dropped nav-time background purge (former "step 3c") stays dropped.**
  Releasing a frame's codewords from `background.ts` at nav time races the
  content script's local ownership: a new wrapper re-claims a head-of-pool
  codeword that an old limbo wrapper still holds, and the old wrapper's finalize
  `queueDelete` then deletes the *new* badge's codeword — a real
  voice-unmatchable regression. If transient pool pressure ever bites on a hard
  SPA nav, the safe refinement is content-side: on `reason:'spa_nav'`, release
  disconnected wrappers immediately instead of through limbo (same owner,
  release-then-reclaim in order, no collision).

**Dropped from the previous plan:** the four-stage pipeline interfaces (replaced
by source/reaction + delta stream, section 2).

**Risks.**
- *The delta cut (steps 6–8) is the real behavior-equivalence test.* Mitigated by
  the transitional double-drive (step 7): both the old imperative calls and the
  new subscribers run, and we verify identical pushes/paints before deleting the
  imperative path. Soak required.
- *Hidden coupling via module globals surfaces during extraction* (e.g. who reads
  `hintsVisible`). Expected and desired — the point is to make these explicit
  subscriptions or parameters. `hintsVisible` already moved onto `PageSession`.
- *Observer-construction relocation (step 9) was the freeze-risky part.* It is
  deliberately last, after the callbacks are thin, so the relocation moves nearly
  inert closures rather than the entangled boot it would have moved if attempted
  first.

---

## 8. Open questions

- Does `IntersectionTracker` (claim/release) share one IO instance with the
  attention observer, or stay separate? The source/reaction split is compatible
  either way; defer to the perf harness.
- Delta granularity: is `{ kind: 'visibility' }` one delta type, or do grammar
  and render want different visibility events? Start with one; split only if a
  subscriber needs to distinguish.
- Should `core/store.ts` deltas be synchronous (emit inside the mutator) or
  micro-task-batched? Synchronous is simpler to reason about and to test; the
  reactions already debounce their own outputs, so batching at the store adds
  little. Start synchronous.
