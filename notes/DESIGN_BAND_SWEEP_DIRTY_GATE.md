# Band-sweep dirty gate (+ shadow-root observation)

2026-07-15. Outcome of the settle-cost investigation that started as "shared observer
refactor" (INVESTIGATION_LONG_SESSION_PERF.md strategic item 11) and pivoted on
measurement.

## Why the original idea is dead

Item 11 proposed consolidating the two per-badge MutationObservers into shared
singletons. INVESTIGATION_OBSERVER_CONSOLIDATION.md already measured and rejected this
2026-06-01 (2 + 11 ms across a full YouTube session; no `MutationObserver.unobserve`
means a shared instance makes teardown O(live badges)). Re-measured live 2026-07-15 on
the user's perf trail: `targetMutation:callback` + `hostAttribute:callback` = 38 ms
combined across four tabs' entire lifetimes; not in the top 12 of a 25-minute active
window. Item 11 should be corrected in the investigation note — it re-recommends a
measured dead end.

Related stale doc found on the way: `target-mutation-tracker.ts`'s header still
describes anchor-name self-heal. anchor-name was removed with the JS reconcile
positioner (df8b89a); the tracker's live job is `invalidateProbe` +
`scheduleDeferredReposition` on a target style clobber. Reword, keep the tracker.
`host-attribute-tracker` is load-bearing (defends the host's `display` against
attribute-stripping pages) — untouched.

## What actually costs (live trail, 25-min window, 4 tabs)

| bucket | window | notes |
|---|---|---|
| `discoverInSubtreeBatched` | 8.4 s / 224 calls | 221 on ONE idle YouTube /watch tab |
| `recheckPendingVisibility` | 3.6 s / 4364 calls | pointer-triggered promote (separate lever) |
| `settleGather` | 1.7 s / 238 settles | gCS ancestor walk + occlusion hit-tests (separate levers) |
| `moCallback` | 0.5 s | June's attributeFilter scoping worked |

The dominant item is the band-discovery sweep: `runSettlePipeline` arms
`scheduleBandDiscovery` on EVERY settle (round 14), and each sweep re-walks
`document.body` (~37 ms on a big DOM). On the measured tab the settles came from
attribute churn (media UI) with `moCallback` at 0.4/s and near-zero childList adds —
sweep yield ~zero, by construction.

## Why every-settle arming is obsolete

Round 14 armed the sweep on every settle because class-flip reveals (QuickBase
double-buffered grids) were only discoverable by the walk. Since then, dedicated
sensors took over every reveal class:

- Seen-but-invisible candidates are PARKED (`trackPendingCandidate`, attention
  observer onEnter) with visibilityIO + visibilityRO + a doc-level
  class/style/open/hidden MO connected while candidates exist. Class flips, box
  gains, `<details>`/`hidden` toggles promote at rAF speed — no walk.
- Pure `:hover` reveals: pointerover recheck (no walk).
- Mass reveals: the plan's repair count fast-arms the sweep (kept, unchanged).
- attachShadow: MAIN-world wrapper → SHADOW_EVENT → immediate `discoverInSubtree`
  on the host; disconnected attaches leave a TTL signal that widens drain
  pre-filter checks.
- childList adds: drainDiscovery walks every added root the MO delivers; the huge
  path full-body-walks.

What genuinely still needs the walk:

1. Adds whose incremental handling was skipped or raced (pre-filter false negative,
   storm coalescing) — always co-occur with a childList record the MO DID see.
2. Appends INSIDE a long-lived shadow root — the page MO does not observe shadow
   trees; these produce no record at all. Today they wait for a settle sweep anyway
   (0.5–3 s).
3. Unknown-unknowns — the sweep is the system's self-heal insurance.

## Design

Two pieces, two commits.

### 1. Observe open shadow roots with the page MO

The scanner's shadow pierce (`deepQuerySelectorAll`) gains a sighting hook; the
mutation source registers every pierced open root on the SAME page MutationObserver
instance (`observer.observe(shadowRoot, samePageOptions)` — one instance, many
targets, spec-supported). WeakSet guard against re-registration; reset on detach so
the post-resume walk re-registers. Own roots (hosts under `[data-branchkit-hint]` /
our overlay hosts) are skipped.

This closes gap 2 as a product improvement in its own right: shadow-interior appends
move from sweep cadence (0.5–3 s) to the normal incremental path (drainDiscovery, rAF
chain). It is also what makes the dirty gate's signal sound — without it, gating on
childList adds would starve shadow-heavy sites (Reddit-class) for the length of the
long-stop.

### 2. Gate the sweep on a DOM-add epoch

`mutation-source` keeps `domAddEpoch`, bumped when a callback delivers at least one
foreign childList record with added nodes (covers light DOM + observed shadow roots),
unconditionally on the manual-mode deferred path, and on
`attachPageMutationObserver` (boot + hidden-tab resume — mutations during suspend are
unseen, so resume forces the next settle's sweep).

`scheduleBandDiscovery` consults a pure gate (new `lifecycle/band-sweep-gate.ts`):

- fast-arm (`revealRepairs >= REVEAL_REPAIR_FAST_ARM`) bypasses the gate — unchanged.
- run when `domAddEpoch !== discoverySweptEpoch` (adds happened since the last walk
  started — the walk captures the epoch at start, so mid-walk adds re-arm).
- run when `now - discoverySweepEndAt >= 30_000` (long-stop: insurance for gap 3 and
  any residual MO-blind class, e.g. a root attached before its host was walked).
- otherwise SKIP: `firehoseStep('band_discovery:skip_clean')` + a
  `bandDiscovery:skipClean` count bucket in the perf trail — visible, not silent.

Plan repairs below fast-arm do NOT force a sweep: they are existing-wrapper flag
repairs; the plan's own toClaim/toBuild/toShow lists handle them (round 33d), and the
sweep's follow-through never ran for them anyway (round 33c early-return).

The coalesce/retry machinery is untouched: the gate runs at entry, before the
single-flight check, so a skipped request never sets rerun flags; a retry re-enters
the gate with the then-current epoch (a mid-walk re-render bumps it — exactly the
race the retry exists for).

Kill switch: `chrome.storage.local` `bkSweepGate` (default on), read at boot like
`bkOcclusion` — `set({bkSweepGate:false})` restores every-settle arming.

## Expected effect

On the measured idle-watch tab: 221 sweeps → ~2 (long-stop only), ~8 s of walk per
25 min gone. Scroll on dynamic pages is unaffected (lazy-loading content bumps the
epoch continuously — sweeps run exactly as often as content actually arrives).
Shadow-heavy pages get faster badges, not slower.

## Tests

- Unit: gate decision table (epoch clean/dirty × fast-arm × long-stop); epoch bump
  sites in mutation-source (foreign adds bump, removals/attributes don't, manual path
  bumps, attach bumps); shadow-root registration (pierce → observe → interior append
  delivers records; own-root skip; detach resets guard).
- `scripts/_test-band-discovery.mjs` rework: the old synthesis (append into an open
  shadow root) stops being a gap once roots are observed — the append now badges
  incrementally, which the test asserts as the new fast path. The backstop itself is
  exercised via a harness-build fault hook that drops one discovery root
  (simulating the storm race): childList add seen (epoch dirty) + root dropped →
  element unbadged → scroll settle → gated sweep runs → badged.
- Wedge guard: `scripts/_test-videos-tab-wedge.mjs` stays green.

## Revert levers

`bkSweepGate:false` (behavior), or revert commit 2 (gate) independently of commit 1
(shadow observation) — they are deliberately separable.
