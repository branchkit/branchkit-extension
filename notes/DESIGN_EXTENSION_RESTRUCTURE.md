# Extension Restructure — module boundaries and the content-script pipeline

**Status:** partially landed (updated 2026-05-30). The diagnosis (§1–2) still
holds, but reality has moved past the original "nothing built yet":
- **Module grouping shipped** — `src/` is now organized into intent-based dirs
  (`scan/ observe/ placement/ labels/ render/ activate/ rules/ debug/`, plus
  `adapters/` and `plugin/`). The names differ from the original §3.1 sketch
  (see the updated §3.1); the shipped names are now ground truth.
- **Step-1 leaf extraction substantially done** — `config.ts`, `plugin/liveness.ts`,
  `plugin/resolve.ts`, and the `debug/` telemetry files are out of the monolith.
  `content.ts` is down from 3,265 lines to ~2,854.
- **Step-3 SPA-nav fix built** — `webNavigation.onHistoryStateUpdated`
  (+`onReferenceFragmentUpdated`) feed a debounced bounded rescan
  (`background.ts` `scheduleSpaRescan`). **Step 3c (nav-time label-pool purge)
  was investigated and dropped 2026-05-30 as both redundant and unsafe** — see
  §5 step 3. The premise ("codewords leak across SPA navs") was true only
  *before* 3a/3b: now that the rescan is wired, the content script — which
  stays alive across same-document nav — drops disconnected wrappers and
  releases their codewords through the normal limbo→finalize path within
  ~500ms. A background-side `purgeTab`/`releaseFrame` at nav time would race
  that content-side ownership and corrupt the grammar (see §5 step 3 for the
  delete-collision).

**Still unbuilt (the high-value remainder):** the stage interfaces (§3.2), the
`PageSession` lifecycle object (§3.3), and reducing `content.ts` to wiring (§5
steps 2, 4-residual, 5).

**Motivation in one line:** the YouTube unresponsive-script freeze is not a
bug we keep failing to fix — it's the symptom of a content script that has
no internal boundaries, so the one hot path that matters (discover → filter →
attach → observe) can't be isolated, measured, or replaced without touching a
3,265-line file that also owns config, badges, grammar sync, perf telemetry,
and frame liveness.

This doc is about **structure**, not a new perf trick. The perf work already
has good design thinking behind it (`DESIGN_OBSERVER_DRIVEN_LAYOUT.md`,
`INVESTIGATION_YOUTUBE_WATCH_PERF.md`, `PLAN_RANGO_TECHNIQUES.md`). The problem
is that those designs land *inside* a monolith, so each lands as another
top-level function and another module-scoped observer next to the others, and
the system gets harder to reason about with every fix. We restructure so the
remaining perf work (and everything after it) lands against interfaces instead
of into a pile.

---

## 1. Current state, honestly

### 1.1 The monolith

`src/content.ts` is 3,265 lines. A top-level scan of its declarations shows it
owns, interleaved, at least these distinct concerns:

| # | Concern | Representative symbols |
|---|---------|------------------------|
| 1 | Subsystem ownership | `store`, `dispatcher`, `registry`, `keyHandler`, `tracker`, `resizeObserver`, `visibilityIO`, `visibilityMO`, `attentionObserver`, `targetRectStore`, `badgeReattachObserver`, `observer` |
| 2 | Config / storage wiring | `chrome.storage.sync/local` get + onChanged blocks |
| 3 | Domain rules | `applyMatchedRule`, `getExcludes` |
| 4 | Scan orchestration | `doScan`, `doScanBatched`, `processScanBatch`, `applyUserRuleToScan` |
| 5 | Wrapper lifecycle | `attachWrapper`, `detachWrapper`, `discoverInSubtree`, `tryRebindFromLimbo`, `rebindWrapper`, `dropDisconnectedWrappers`, `finalizeExpiredLimboWrappers` |
| 6 | Invisible-candidate visibility | `pendingVisibility`, `recheckPendingVisibility`, `observeInvisibleCandidates`, `visibilityMO/IO` |
| 7 | Badge show/hide/position | `showHints`, `hideHints`, `scheduleReposition`, `scheduleDeferredReposition`, `badgeNewlyCodeworded`, `updateBadgeLabels` |
| 8 | Mutation handling | `observer`, `processMutations`, `scheduleDiscovery`, `drainDiscovery`, `scheduleReevaluation`, `drainReevaluations` |
| 9 | Grammar / state sync | `scheduleBatchedSync`, `batchedStateSync`, `postGrammarBatch`, `claimLabelsForBatch`, `drainPendingDeletes`, `sessionId` |
| 10 | Label assignment | `poolLabelToAssignment`, `viewportSort` |
| 11 | Frame liveness / orphan | `openLivenessPort`, `quiesceOrphan`, `myFrameId` |
| 12 | Hint resolution / activation | `resolveHintLocally`, `activateWrapper`, `reportDispatchResult` |
| 13 | Perf instrumentation | `recordCpu`, `buildPerfSnapshot`, `publishPerfSnapshot`, `shipPerfReport`, watchdog, longtask, cpu-share (~200 lines) |
| 14 | Custom-element watching | `watchUndefinedCustomElements` |
| 15 | Messaging plumbing | `ensureSendMessageWrapped`, message router |

These talk to each other through module-scoped mutable variables
(`hintsVisible`, `sessionId`, `pendingVisibility`, `compiledRule`, a dozen
counters). There is no seam. A change to the lifecycle touches the same file
and often the same shared state as a change to badge positioning or grammar
sync.

### 1.2 The observer zoo

Roughly ten observers are instantiated at module scope, with responsibilities
that overlap and were added in different sessions:

- `observer` (global MutationObserver, ~line 2885) — discovery + reevaluation triggers
- `visibilityMO` (line 702) — re-check invisible candidates on attribute change
- `visibilityIO` (line 679) — invisible candidate became visible
- `attentionObserver` (`rootMargin '200%'`, line 806) — wrapper attach/detach candidacy
- `tracker` / IntersectionTracker (`rootMargin '200px'`, line 118) — codeword claim/release
- `resizeObserver` (line 640) — anchor-parent resize
- `badgeReattachObserver` (line 914) — re-mount badges the page tore out
- a `PerformanceObserver` (line 2567, longtask) plus two further inline
  MutationObservers (lines 241, 3254)

Note the class/instantiation split: several of these (`IntersectionTracker`,
`AttentionObserver`, the `*-tracker.ts` helpers, `target-rect-store.ts`,
`layout-cache.ts`, `placement/`, `adapters/`) already live in their own files —
content.ts only *instantiates and wires* them. The codebase has already been
drifting toward extraction; what's missing is a spine that owns the wiring and
the order. This restructure finishes a migration that's underway, it does not
crack open a virgin monolith — which is why the nested-directory layout in §3.1
is a continuation of the existing `placement/` + `adapters/` convention, not a
new one.

`DESIGN_OBSERVER_DRIVEN_LAYOUT.md` already recognizes this and proposes
collapsing the layout/lifecycle observers into a `LayoutSignalRouter` +
`TargetRectStore` (Phases 3–6, not yet cut over). That design is correct and
this doc does not relitigate it. But it currently has nowhere clean to live —
it would be three more module-scoped singletons inside `content.ts`.

### 1.3 Concrete gaps found while debugging the freeze (2026-05-29/30)

- **No SPA URL-change handler.** The content script re-establishes scan +
  grammar only on a full document load (the `chrome.storage.local.get('alphabet')`
  boot block) or via the MutationObserver firehose. On a YouTube in-site
  navigation (History API, no reload) there is no "the page is now a different
  page" signal — the script relies entirely on absorbing ~4000 mutations/sec,
  which is exactly the path that trips the unresponsive-script killer. The gap
  is on both sides: content.ts has no `popstate`/`pushState`/`replaceState`
  listener, and `background.ts`'s `tabs.onUpdated` (line 1162) fires only on
  `changeInfo.status === 'complete'` (full load), so the SPA case is unhandled.
  **Detection correction (2026-05-30, Playwright):** `tabs.onUpdated` cannot
  distinguish a History-API nav from a full load. On a YouTube in-site nav it
  reports `{status:'loading', url}` then `{status:'complete'}` — byte-identical
  to a full document load — so any `changeInfo.url` guess either misses real SPA
  navs or fires redundant rescans on every full load. The correct signal is
  `chrome.webNavigation.onHistoryStateUpdated` (+ `onReferenceFragmentUpdated`
  for hash routes), which fire *only* for same-document URL changes; this needs
  the `webNavigation` permission (added 2026-05-30). **Good news
  for step 3:** the reconcile machinery partly exists. content.ts already
  handles a `rescan` action (`content.ts:1596`), today
  triggered only by plugin-connect/focus. `onUrlChange` can route into that
  existing bounded path rather than build a new one.
- **Per-tab label pool is purged only on tab close (`chrome.tabs.onRemoved` →
  `purgeTab`), and that is correct.** An earlier read of this file took the
  stale `background.ts:1058` comment ("clear … when the tab is closed or starts
  navigating") at face value and concluded codewords leak across navigations.
  They do not, in either nav shape:
    - *Same-document (SPA) nav:* the content script stays alive. Old elements
      disconnect → limbo → finalize → `releaseLabel` (`element-wrapper.ts:82`),
      reclaiming codewords within ~500ms. The `scheduleSpaRescan` rescan
      (`from_cache` path, `content.ts:1600`) actively drives `dropDisconnectedWrappers`.
    - *Cross-document nav / tab close:* the content script dies. Per-frame
      reclamation runs through the liveness Port `onDisconnect` →
      `releaseFrame` (`background.ts:1091`), and `purgeTab` on tab close.
  The `background.ts:1058` comment is stale (says "or starts navigating") and
  the `releaseFrame` doc-comment in `label-pool.ts` is stale (says "Currently
  NOT wired") — both are corrected. The one residual is the long-known
  SW-idle window on Port `onDisconnect`, which is independent of navigation.
- **Perf trail is unbounded.** `extension-perf.jsonl` was 242 MB / 94,740 lines.
  `perf_report.go` keeps every sample by design ("clearing is manual").

These are not unrelated one-offs. They're all "lifecycle of a page/session was
never modeled as a thing" — which is itself a structural absence.

---

## 2. What's actually wrong (the diagnosis under the symptoms)

1. **No pipeline.** The flow from "DOM changed" to "badge painted + grammar
   pushed" exists, but only as a call graph spread across 15 concerns. You
   cannot point at "the discovery stage" and swap its implementation; you edit
   `discoverInSubtree`, which reaches into `store`, `attentionObserver`,
   `targetRectStore`, counters, and `schedulePushGrammar` directly.

2. **Lifecycle is implicit.** "A page" and "a hinting session for a page" are
   not objects. Their setup is the top-level execution of `content.ts`; their
   teardown is the V8 context dying. SPA navigation has neither, so it falls
   through every crack.

3. **Layout reads aren't disciplined.** `getComputedStyle`/`getBoundingClientRect`
   are called from ~15 sites. `layout-cache.ts` helps within a batch but isn't
   on the discovery filter path (`scanner.ts` `isVisible`/`isRedundant` read
   live). There's no single place that owns "when are we allowed to force a
   reflow." `DESIGN_OBSERVER_DRIVEN_LAYOUT` fixes this for positioning; nothing
   fixes it for discovery.

4. **Instrumentation is load-bearing and tangled.** The perf telemetry (~200
   lines + a watchdog + a longtask observer + cpu-share math) lives next to the
   logic it measures, sharing counters as module globals. It's the only reason
   we can debug at all, but it makes the file bigger and the hot functions
   noisier (`recordCpu` calls threaded through everything).

The throughline: **every fix has to be performed open-heart, on shared mutable
state, inside the file that does everything.** That's the "flimsy" feeling.

---

## 3. Target architecture

A content script is, structurally, a small reactive system: signals come in
(DOM mutations, viewport/resize/scroll, navigation, voice/keyboard commands),
and two outputs go out (painted badges, grammar/state pushed to the plugin).
Model it as an explicit pipeline of owned stages behind interfaces, plus an
explicit page-session lifecycle.

### 3.1 Module layout

The directory grouping below shipped 2026-05-30. The original sketch used
`core/ discover/ lifecycle/ layout/ telemetry/`; the names that actually landed
(`scan/ observe/ placement/ debug/`, config + layout-cache at root) are shown
here as ground truth. `(exists)` = file present today; `NEW` = still unbuilt,
shown in the dir it would land in.

```
src/
  content.ts                  // GOAL: thin — wire stages, own nothing but the graph
  config.ts                   // (exists) storage-backed settings — was core/config
  layout-cache.ts             // (exists) cross-stage rect/style cache — stays at root
  types.ts                    // (exists) shared types — stays at root
  core/                       // NEW dir — (re)introduced when these two land; that
    page-session.ts           //   NEW: lifecycle object (boot, navigate, teardown)
    pipeline.ts               //   NEW: stage interfaces + the orchestrator. (We
                              //   folded the lone config.ts up to root in the reorg;
                              //   core/ earns its place again as a ≥2-file boundary
                              //   once the lifecycle/orchestrator objects exist.)
  scan/                       // was "discover/"
    scanner.ts                // (exists) pure DOM→candidates, no side effects
    find.ts, references.ts, element-wrapper.ts, registry.ts, ...  // (exist)
    discovery.ts              // NEW: owns scheduleDiscovery/drain, ancestor-dedup,
                              //      the cheap pre-filter on added roots
  observe/                    // was "lifecycle/" + "layout/" (the observer zoo)
    attention-observer.ts     // (exists) attach/detach candidacy
    target-rect-store.ts      // (exists) the one canonical rect cache
    intersection-tracker.ts, *-tracker.ts  // (exist)
    limbo.ts                  // NEW: rebind/limbo/finalize (extract from content.ts)
  placement/                  // (exists) position math — index, compute, rango, ...
  labels/
    label-pool.ts             // (exists) square-fill pool
    label-sync.ts             // (exists) claim/release batching, sessionId, grammar push
  render/
    hints.ts                  // (exists) badge element
    badge-colors.ts           // (exists)
    badge-manager.ts          // NEW: show/hide/reposition orchestration
  activate/                   // NEW grouping — the "act on a chosen target" stage
    resolve.ts?               // resolveHintLocally + activate + report (see note*)
    event-sequence.ts, scroller.ts, keyboard.ts, snapshot.ts  // (exist)
  rules/                      // domain include/exclude/reveal + options UI (exist)
  plugin/
    liveness.ts               // (exists) Port + orphan handling
    resolve.ts                // (exists) plugin-side resolve  (*resolution currently
                              //   lives here, not activate/ — revisit when the
                              //   activate stage is formalized)
    grammar-batch.ts          // NEW: postGrammarBatch + delta-sync (extract)
  debug/                      // was "telemetry/" — diagnostics + perf
    perf-counters.ts, message-counters.ts  // (exist)
    debug-snapshot.ts         // (exists)
    perf.ts                   // NEW: snapshot, cpu-share, watchdog, longtask sink
```

This is a target, not a literal commit list. The point is **one concern per
file, behind an interface, with `content.ts` reduced to wiring.** Naming note:
the reorg chose stage-verb dirs (`scan/observe/placement/render/activate`) over
the original noun sketch (`discover/lifecycle/layout/render`); they describe the
same pipeline.

### 3.2 The pipeline

Define the stages as interfaces so each is independently testable and
replaceable (the observer-driven-layout cutover becomes "swap the layout
stage," not "rewrite content.ts"):

```ts
interface DiscoveryStage {
  // Given roots that may contain new candidates, emit hintable candidates.
  // Owns the cheap pre-filter + ancestor-dedup. Pure w.r.t. DOM reads it
  // declares; performs no attach.
  discover(roots: Iterable<Element>): CandidateBatch;
}

interface LifecycleStage {
  // Decides which candidates become live wrappers (attention region) and
  // which get torn down. Owns limbo/rebind. Emits attach/detach events.
  reconcile(batch: CandidateBatch): LifecycleDelta;
}

interface LabelStage {
  // Claims/releases codewords for attached/detached wrappers, batched.
  // Owns sessionId + the per-batch grammar push.
  sync(delta: LifecycleDelta): Promise<void>;
}

interface RenderStage {
  // Mounts/positions/tears down badges for currently-codeworded wrappers.
  // Reads geometry ONLY from TargetRectStore.
  render(delta: LifecycleDelta): void;
}
```

The orchestrator (`pipeline.ts`) is the only thing that knows the order. Each
signal source (mutation, navigation, command) feeds the front of the pipeline;
the orchestrator runs stages and routes deltas. Stage internals own their own
debouncing/time-slicing, but the orchestrator owns back-pressure (the thing the
investigation doc keeps reaching for: "stop walking subtrees that yield
nothing").

### 3.3 Page session as a first-class object

```ts
class PageSession {
  readonly id: string;          // replaces module-scoped sessionId
  start(): void;                // boot: config, initial scan, observers on
  onUrlChange(href: string): void;  // SPA nav: reconcile as a soft teardown+rescan
  teardown(reason): void;       // detach all, release codewords, observers off
}
```

`onUrlChange` is the missing signal. Wire it from a `popstate` +
patched-`history.pushState`/`replaceState` listener (the standard SPA-hint
approach; Rango/Vimium do this). On URL change we do a **bounded** reconcile:
release codewords for wrappers no longer in the DOM, rescan the viewport-near
region once, push grammar once — instead of absorbing the mutation firehose.
This directly addresses "page 2 doesn't register" and removes the dependency on
the 4000-mutations/sec path for the common navigation case.

Pool purge on navigation (the `background.ts` gap) becomes the SW-side half of
the same lifecycle: `PageSession.teardown`/`onUrlChange` is the authoritative
signal, not `onRemoved` alone.

### 3.4 Telemetry as an injected sink, not ambient globals

Stages take a `record(label, ms)` function by injection. `telemetry/perf.ts`
owns the buckets, cpu-share, watchdog, longtask observer, and the bounded trail
(rotate/cap — fix the 242 MB file). In tests and in non-dev builds the sink is a
no-op, so the hot functions aren't threaded with measurement noise. The
diagnostic value we depend on is preserved; it just stops living inside the
logic.

---

## 4. How this relates to existing docs

- **`DESIGN_OBSERVER_DRIVEN_LAYOUT.md`** — its `LayoutSignalRouter` +
  `TargetRectStore` are the implementation of the `layout/` modules and the
  `RenderStage`'s read discipline. This restructure gives that design a home
  (the `layout/` dir + the stage interface) so Phases 4–6 cut over by swapping
  the layout stage behind the interface rather than editing the monolith.
- **`INVESTIGATION_YOUTUBE_WATCH_PERF.md`** — its unresolved /watch worst case
  ("4000 mutations/sec, almost none yield hintables") is the `DiscoveryStage`'s
  problem to own: the cheap pre-filter on added roots and ancestor-dedup it
  recommends become methods on one stage with one place to measure, instead of
  edits to `discoverInSubtree` + `drainDiscovery` + `processMutations`.
- **`PLAN_RANGO_TECHNIQUES.md`** — done; informs `RenderStage`/`scroller`.

The restructure is the substrate that makes the rest of the perf roadmap
landable cleanly. It is explicitly *not* a rewrite of the algorithms — limbo,
rebind, square-fill pool, attention region, delta-sync all move largely intact
into their owning modules.

---

## 5. Migration sequence (clean end state via transitional seams)

Sequenced so each step ships independently, the extension stays working
throughout, and the final step deletes the scaffolding. No big-bang rewrite.

1. **Carve out leaf concerns with zero behavior change.** Move telemetry,
   liveness, resolve/activate, grammar-batch, and config into their own files;
   `content.ts` imports them. Pure relocation; counters become module exports
   or an injected sink. Lowest risk, immediately shrinks the monolith and makes
   the rest legible. **Substantially done (2026-05-30):** `config.ts`,
   `plugin/liveness.ts`, `plugin/resolve.ts`, and `debug/{perf,message}-counters`
   are extracted; the `src/`-wide intent-based regrouping landed in the same
   pass. Residual: `grammar-batch` and the perf `watchdog`/`longtask`/`cpu-share`
   block still live inside `content.ts`.

2. **Introduce the stage interfaces with the *current* code behind them.**
   Wrap existing discovery/lifecycle/label/render code in adapter objects that
   satisfy the interfaces but call today's functions. The orchestrator runs the
   adapters. Behavior identical; the seam now exists.

3. **Introduce `PageSession`** owning boot/teardown and, newly, `onUrlChange`.
   Wire SPA navigation. This is the first behavior change and the one that fixes
   the user-visible "page 2" bug — ship and validate it on its own. Concretely
   this is two small wires, not a new subsystem:
   (a) detect the URL change via `chrome.webNavigation.onHistoryStateUpdated`
   (+ `onReferenceFragmentUpdated`), top-frame only — *not* a `tabs.onUpdated`
   `changeInfo.url` guess, which can't separate SPA navs from full loads (see
   §1.3 detection correction); (b) route it into the *existing* bounded `rescan`
   action path (`content.ts:1596`) instead of the mutation firehose.

   **Status (2026-05-30):** (a) and (b) are built — `webNavigation` listeners
   feed `scheduleSpaRescan` (debounced) which dispatches the bounded `rescan`
   action. This was done ahead of `PageSession` — the wires landed directly in
   `background.ts`; the lifecycle object that would *own* them (§3.3) doesn't
   exist yet.

   **A third wire (c) — a nav-time `purgeTab`/`releaseFrame` from
   `background.ts` — was planned here but dropped 2026-05-30 after
   investigation.** It is both redundant and unsafe:
   - *Redundant.* The leak it targeted only existed before (a)/(b). Now that
     the rescan is wired, a same-document nav keeps the content script alive;
     its `dropDisconnectedWrappers` (driven by the `from_cache` rescan,
     `content.ts:1600`) sends the old elements to limbo, and finalize releases
     their codewords (`element-wrapper.ts:82`) within ~500ms. The content
     script owns codeword truth; the pool is a derived cache it keeps in step.
   - *Unsafe.* Releasing frame 0's codewords from `background.ts` at nav time
     returns them to `free` while limbo wrappers still hold them locally. A new
     wrapper then re-claims a head-of-pool codeword (e.g. `"a b"`) that an old
     limbo wrapper also holds; when that old wrapper finalizes ~250ms later, its
     `queueDelete("a b")` deletes the *new* badge's codeword from the plugin
     grammar — the fresh badge goes voice-unmatchable. A genuine correctness
     regression, so the literal step 3c is not the right shape.

   If transient pool pressure during the ~500ms limbo window ever proves to
   matter on a hard SPA nav (where rebind is pointless because the page truly
   changed), the *safe* refinement is content-side: on `reason:'spa_nav'`,
   release disconnected wrappers immediately instead of through limbo. The same
   owner does release-then-reclaim in order, so no collision. Not currently
   needed — flag if SPA-heavy sites show pool starvation.

4. **Replace stage internals one at a time** behind the stable interfaces:
   DiscoveryStage gets the pre-filter + ancestor-dedup (done 2026-05-30,
   commit `8fe4e4c` — even ahead of the step-2 seam; landed directly in
   `content.ts`). RenderStage's cutover to LayoutSignalRouter/TargetRectStore
   was re-scoped on 2026-05-30 — see `DESIGN_OBSERVER_DRIVEN_LAYOUT.md`
   "Course correction": the standalone flag-gated Phase 4 is dropped as
   behaviorally inert, and the positioning axis now forks into a
   cross-browser store path (Phases 5+5b together) and a Chromium CSS
   Anchor Positioning fast-path. Each swap is measured against the perf
   harness with the others held fixed.

5. **Delete the adapters and the residual `content.ts` logic.** Final commit:
   `content.ts` is wiring only; the transitional shims from step 2 are gone.

Per the project's "clean end state via sequencing" preference, the adapters in
step 2 are explicitly temporary and removed in step 5 — they exist only to keep
the tree green between refactors.

---

## 6. What we preserve / risks

- **Algorithms stay.** Square-fill pool, limbo/rebind identity stability,
  attention-region lifecycle, delta-sync grammar, the two-IO split (claim vs
  candidacy) all migrate intact. This is a boundary change, not a logic change —
  except for step 3's deliberate SPA-nav fix.
- **Test coverage is the safety net.** The suite is large (412 tests across
  scanner, allocator, label-pool, intersection-tracker, rebind, etc.). Each
  relocation step must keep it green; the interfaces in step 2 should make more
  of the lifecycle unit-testable than it is today (currently much is only
  reachable through the monolith).
- **Risk: the SPA-nav reconcile (step 3) is genuinely new behavior.** It needs
  Playwright validation on YouTube + a couple of SPA sites: navigate, confirm
  badges + grammar re-establish without the mutation firehose, and confirm the
  pool reclaims the prior page's codewords (via the content-side limbo→finalize
  release the rescan drives — *not* a background purge; see §5 step 3 for why a
  background purge corrupts the grammar).
- **Risk: hidden coupling via module globals.** Extraction will surface
  implicit dependencies (e.g. who reads `hintsVisible`). Expected; the point is
  to make them explicit parameters/state instead of ambient.

---

## 7. Open questions

- Does `IntersectionTracker` (claim/release) stay separate from the
  `LayoutSignalRouter`, or do they share one IO instance? `DESIGN_OBSERVER_DRIVEN_LAYOUT`
  §"Open Questions" leans separate-but-sharing-the-IO; the stage split here is
  compatible either way.
- Is `PageSession` per-frame (every content-script context owns one) with a
  thin top-frame coordinator, or is cross-frame state left to the
  background/plugin as today? Leaning per-frame — it matches the current
  per-frame injection model and the plugin already aggregates frames.
- How much of step 1 is worth doing before getting agreement on steps 2–5?
  Step 1 is pure upside regardless, so it could start immediately; 2–5 want
  sign-off on the stage shape first.
