# Observation Footprint Reduction — Viewport as the Unit of Work

Status: design (2026-06-01) — **Move 1 (B1) measured and rejected; see update below.**

> **Update 2026-06-01 — Move 1 (B1) is dead; the document-level fold is rejected.**
> Instrumentation (`notes/INVESTIGATION_OBSERVER_CONSOLIDATION.md`) measured the
> per-wrapper MutationObserver fan-out on live heavy pages: it costs 2–11 ms over
> a full session, while the existing *filtered* document-level `moCallback`
> already costs 270–350 ms. So consolidating the per-wrapper observers saves
> nothing, and folding their job into one document-level MO would *widen*
> `moCallback`'s filter and inflate the dominant cost. If the warning recurs the
> lever is the opposite of this note's Move 1 — scope `moCallback` *down* (B4),
> not consolidate up. Moves 0 (A2, shipped), 2, and 3 are unaffected by this
> verdict; only Move 1 and the "fold to a single doc-level MO" idea are retired.

Companion docs:
- `notes/INVESTIGATION_OBSERVER_CONSOLIDATION.md` — the measurement that retired
  Move 1 (B1) and the document-level fold. Read this before re-reading Move 1.
- `notes/PLAN_BROWSER_EXTENSION_PERF_OPTIMIZATION.md` — the Track A/B/C/D
  optimization menu this note picks a spine through.
- `notes/completed/DESIGN_HINT_LIFECYCLE_RECONCILER.md` — the level-triggered
  converge pass, landed. This note depends on it but addresses a different axis.
- `notes/PLAN_RANGO_TECHNIQUES.md` — feature-level Rango comparison. This note is
  the *architectural* companion (observation model, not individual features).
- `notes/DESIGN_OBSERVER_DRIVEN_LAYOUT.md` — the positioning-perf axis; shares the
  warm-`TargetRectStore` substrate.

## Why this note exists

Two separate efforts have been chasing the same Firefox "this extension is
slowing your browser" warning from opposite ends, and a third (the Rango
baseline investigation) just gave us a reference architecture. This note
consolidates them into one direction so we stop fixing the warning per-trigger.

The key finding from the reactivation-scope attempt (reverted 2026-06-01, see
the `project-reactivation-scope-reverted` memory): **the warning is
multi-source.** Scoping any single full-scan trigger cannot clear it. The
drivers, from the live perf trail:

1. The SPA-nav / from-cache rescan path still runs a full `doScanBatched`
   (~1409ms wall-clock on a Rumble video-page nav) because it wipes and rebuilds
   every wrapper — the "nav-rebuild smell."
2. The module-load initial scan.
3. Genuine `watchdog:delay` stalls (~1.8s YouTube, ~1s Rumble video) that are
   *page-caused*, independent of our scans.
4. Multiple heavy tabs summed by Firefox.
5. Per-wrapper `MutationObserver` fan-out (one per wrapper for host-attribute
   and target-mutation tracking).
6. Per-frame machinery across ~1000 ad/about:blank frames on ad-heavy pages
   (mitigated by Lever 1/2 — see below).

**Metric caveat that reframes everything:** `doScanBatched`'s recorded `dMs` is
WALL-CLOCK across all its `setTimeout(0)` batch yields, not main-thread block
time (the comment at the `recordCpu('doScanBatched')` site says so). A 6.7s
value seen under scroll is a scan *starved by scroll*, not 6.7s of CPU. Measured
real Rumble-scroll CPU was ~8% (~400ms / 5021ms). So the warning is not one
runaway scan — it is the sum of many cheap-but-constant per-frame and per-wrapper
costs plus page-caused stalls Firefox attributes to us. The fix has to cut the
*shared* cost model, not shave a single trigger.

## What this note is NOT

It is not the lifecycle reconciler. That work (just landed,
`DESIGN_HINT_LIFECYCLE_RECONCILER.md`) fixed badge *correctness* — missing/wrong
badges via a level-triggered converge pass that owns claim, build, tear-down, and
band-discovery. It proved the converge-pass shape is right and is the substrate
this note builds on. But it deliberately did NOT touch the observation *cost*:
we still create per-wrapper observers, still full-rescan on nav. That residue is
this note's subject.

## What already landed that this builds on

- **Lifecycle reconciler.** A single debounced `reconcile()` is now the
  convergence entry for claim/build/release; `reconcileTeardown()` is the bounded
  gBCR backstop; `scheduleBandDiscovery()` closes the discovery gap with a
  wedge-safe sliced walk. The "edges are signals that schedule a converge pass,
  not handlers that mutate state directly" model is in place. This is exactly the
  maintenance-pass shape Rango uses.
- **Levers 1 & 2 (Track D, shipped 2026-06-01, uncommitted).** Diagnostics gated
  to the top frame (D1); hint machinery skipped in frames that can't hold a hint
  (D2). These cut driver #6 — the per-frame ×1000 swarm. Rango has no equivalent;
  BranchKit is *ahead* here.
- **Nav-time wedge fix (`ca25199`, `preNavDetachAll`).** Load-bearing; proactive
  per-wrapper teardown before a known SPA swap. Must not regress. Any footprint
  work has to keep `scripts/_test-videos-tab-wedge.mjs` green.

## The Rango baseline

David Tejada's Rango (read from `/private/tmp/rango`, MV3, Chrome+Firefox+Safari,
same hint-overlay problem domain) is a useful reference because it sustains
hinting on dense SPAs without tripping the slow-extension warning. Its
architecture:

- **Persistent element model.** One `Map<Element, ElementWrapper>` built by a
  single startup walk (`deepGetElements`), then maintained incrementally. There
  is no concept of a full re-scan on navigation — the same persistent
  MutationObserver feeds wrapper add/remove for SPA navs and ordinary mutations
  alike (`src/content/observe.ts`).
- **~6 shared singleton observers**, plus one IntersectionObserver per
  scroll-container. Total observer count is single digits, independent of
  hintable count. No per-wrapper observers.
- **Lazy, viewport-scoped hint render.** A `BoundedIntersectionObserver` only
  renders hints for elements within viewport + margin; a 25k-element threshold
  switches strategy on huge pages. Off-screen wrappers exist in the model but
  paint nothing.
- **Single 100ms-debounced `refresh()`** (`src/content/refresh.ts`) as the
  maintenance pass — the analog of our `reconcile()`.
- **Read-batched layout** via `hints/layoutCache.ts` (one gBCR batch per frame).

What Rango does **NOT** solve: the cross-frame ad-swarm. It injects per-frame
like we do but has no top-frame gating and no frame-eligibility skip. Our Lever
1/2 is genuinely ahead. So the convergence target is "Rango's per-page model +
our per-frame gating," not "become Rango."

## The thesis: viewport is the unit of work

BranchKit observes every hintable element from discovery to teardown regardless
of whether it will ever be on screen, and creates per-wrapper observers to do it.
The cost scales with *document-total* hintables (×~7 observer-ish attachments per
wrapper). On a YouTube `/featured` page that is ~300 hintables × machinery even
though ~40 are ever visible.

Rango (and the partially-realized intent of our own observer-driven-layout and
lifecycle-reconciler notes) points at a different invariant: **the working set is
the viewport band, not the document.** Cost should scale with what the user can
see, and observation should be shared, not per-element. The lifecycle reconciler
already gives us the maintenance pass that makes a persistent-model-without-rescan
safe (incremental converge, no wipe). The remaining moves close the cost gap.

## The three moves (and one cheap pre-step)

Ordered cheapest-first. Each is independently shippable; the decision gate after
move 0/1 decides whether to commit to the larger ones.

### Move 0 (pre-step) — A2 skip-unhintable-subtree

Fast-reject subtrees rooted at opaque-content tags (`<video>`, `<canvas>`,
`<svg>`, large media-only blocks) at scan time. Never walk them, never attach.
Cheap (~3-4 days), low-risk, and a broad CPU win on exactly the media-heavy sites
(YouTube, Rumble, Netflix, Twitch) that trip the warning. This is the
recommended first action regardless of whether the larger refactor proceeds —
it shrinks every scan including the nav rescan we have not yet retired.

### Move 1 — B1 shared observer instances (per-wrapper MO consolidation)

> **RETIRED 2026-06-01 (measured).** The premise below — that the per-wrapper MO
> fan-out is "the biggest steady-state win" — is false. Measured cost is 2–11 ms
> per full session vs. `moCallback`'s 270–350 ms. Do not implement this. See
> `INVESTIGATION_OBSERVER_CONSOLIDATION.md`. The text is kept for the record.

The verified hotspot: `IntersectionTracker` (`content.ts:171`) and
`AttentionObserver` (`content.ts:857`) are *already* shared singletons, but
`trackHostAttributes` (`host-attribute-tracker.ts:55`) and `trackTargetMutations`
(`target-mutation-tracker.ts:55`) create a **new `MutationObserver` per wrapper**.
That per-element MO fan-out is where the count explodes — more precisely than the
plan's flat "~600 observers." Consolidate each to one instance watching N targets
(WeakMap-keyed dispatch), matching the IntersectionTracker pattern we already use.
Biggest steady-state win; brings us to Rango's single-digit observer count.

### Move 2 — B2 lazy observer attachment

Only attach the expensive trackers when a wrapper is in the AttentionObserver
band (Rango's BoundedIntersectionObserver model). Off-band wrappers hold the
codeword reservation but observe nothing. This is what makes cost scale with the
viewport rather than the document. Depends on Move 1 (cheap to promote/demote a
target on a shared observer; expensive to spin per-wrapper observers up and down).
Higher risk: voice-activating a "cold" wrapper must promote it to hot first —
acceptable since the codeword reservation persists, but adds first-activation
latency per cold element; verify it is imperceptible.

### Move 3 — Retire the nav wipe+rebuild

Driver #1. Once Moves 1+2 plus the landed reconciler make the persistent model
cheap to maintain, the SPA-nav path no longer needs to wipe every wrapper and
re-scan; it flows through the same incremental converge path as any other
mutation (Rango's model — one persistent MO, no nav special-case). This also
closes the `nav-rebuild-smell` memory item. `preNavDetachAll` stays as a perf
*hint* ("big swap coming"); only the full-store wipe+rebuild behind it retires.
This is the highest-payoff and highest-risk move — it must be last, behind a hard
wedge-repro gate, because the wedge fix exists precisely to survive the nav swap.

## Decision gate

> **Resolved 2026-06-01.** The gate ran. Move 0 (A2) shipped; Move 1 (B1) was
> instrumented instead of implemented and the measurement retired it (see the
> update at the top and `INVESTIGATION_OBSERVER_CONSOLIDATION.md`). The warning
> has not recurred. Net: do not pursue Move 1 or the document-level fold; if the
> warning returns, the measured driver is `moCallback` (270–350 ms) and the lever
> is B4 (scope it down). The original gate text follows.

After Move 0 (A2) and Move 1 (B1) ship and the build is exercised on the live
signed-in heavy pages (Rumble home + video, YouTube /watch, Gmail), re-measure
against the warning. If the warning is gone, stop — Moves 2 and 3 are
correctness-neutral cost refinements and can wait. If it persists, the trail will
say which driver still dominates (per-frame, per-wrapper, nav rescan, or
page-caused watchdog stalls). Only commit to Moves 2/3 against a measured
remaining driver, not speculatively. Driver #3 (page-caused `watchdog:delay`) may
turn out to be the floor we cannot move from the content script at all — confirm
whether those YouTube/Rumble stalls are ours or the page's before treating them
as in-scope.

## Where BranchKit must not regress

- **Nav-time wedge** (`scripts/_test-videos-tab-wedge.mjs`) green after every
  move. Move 3 especially.
- **Lifecycle buckets** (`scripts/_test-leak-measure.mjs classify`) — staleTrue,
  discoveryGap, noHintObject stay at zero across a scroll sweep; the reconciler's
  guarantees must survive observer consolidation.
- **Grammar/Vosk churn** — shared/lazy observers must not increase
  `vocabulary.commit` frequency. The reconciler's `grammar_already_owns` dedup
  should absorb it, but verify on a churny live page (the Phase 5/6 live-probe
  pattern, `scripts/_test-live-churn.mjs`).
- **Per-frame gating (Lever 1/2)** stays — it is the one axis Rango lacks and is
  load-bearing for the ad-swarm case the warning's heuristic actually sums.

## Open questions

- Does Move 2's hot/cold wrapper split add measurable first-activation latency on
  voice? The codeword reservation persists, so promotion is cheap, but the IO
  attach + first paint is not free. Measure before committing.
- Is driver #3 (page-caused watchdog stalls) actually attributable to us, or is
  Firefox summing page jank into the extension's budget? If the latter, no
  content-script change clears it and the warning has an irreducible floor on
  those sites.
- Move 3 (nav-rescan retirement) interacts with the active-tab grammar scoping
  and multi-tab clobber work — confirm the persistent-model nav path still
  re-projects the focused-source grammar correctly on SPA nav (it must, since the
  reconciler already drives grammar on incremental change, but verify).
