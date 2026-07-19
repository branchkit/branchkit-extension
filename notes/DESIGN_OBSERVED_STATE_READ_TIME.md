# Observed state is read, not stored

**Status: EXECUTED — all three phases implemented 2026-07-18 (same day as
the design, user-approved). Phase 1 cssHidden `4358239`, phase 2 occlusion
`8459d69`, phase 3 band membership + plan-applied claims `358543f`. Net
across the arc: ~-380 lines, 1,241 tests green. Execution deviations are
recorded inline (phase 2: `w.clipped` stays; phase 3: scan pre-POST claims
stay, the idle tick runs the convergence pass rather than a bare wake-up,
`bandSweepRepairs/Releases` counters renamed `bandConvergeClaims/Releases`).
SOAK WATCH (June-revert class): badge doubling on 400-link grids,
grammar-batch fragmentation during loads, fling first-paint latency.**

## Thesis

The extension stores three claims about the world on `ElementWrapper` —
`isInViewport`, `cssHidden`, and `occluded`/`overlayCovered` — and then runs
an ever-growing apparatus to keep those stored claims from lying: the IO
entry pipeline, prime-at-attach, the mid-fling band sweep, the plan's
`toRepair` stale-FALSE class, the two-strike exit ledger, the cssHidden
delta apply, and (as of this week) a 2s idle tick whose first job is to run
the band sweep because the flags *still* lie after a load storm.

These three are **observations** — facts about current DOM geometry and
style that the browser will happily re-state at any time. They are not
decisions (which codeword this wrapper holds, whether a badge object was
built) and not identity (fingerprint, limbo, lastRect-at-disconnect). The
arc: stop storing observations. Wrappers keep decisions and identity only;
observers demote to wake-up signals ("something changed near X — run a
pass"); the settle gather becomes the **single derivation point** where
observations are read fresh; and every consumer — the plan, the strict stamp,
the voice-dispatch gate — consumes the derivation, never a stored flag.

A stored observation can be *wrong* (the event that would have updated it was
dropped, discarded, or raced). A derived observation can only be *stale by
one settle*, and the settle is exactly the moment we act on it.

## Why now — the evidence

**The manageusers stale-FALSE cohort (2026-07-18).** 275 wrappers sat
geometrically in-band with `isInViewport === false` for 17.9s (p90
band_to_claimed) until a pointer move triggered a settle whose repair class
healed 172–275 flags at once. Root cause found and fixed this session
(`src/observe/limbo.ts` graduation path): limbo entry never unobserves, so
for a same-node reconnect (QuickBase re-attaches the same DOM nodes on
re-render) graduation's `observe()` was a spec **no-op** — no initial entry —
while the entry the IO *did* deliver during the limbo window had been
discarded by the limbo guard. The IO's per-target state matched reality, so
no crossing ever fired again. The flag was a permanent lie with no event
left to correct it. The fix (cycle unobserve→observe on graduation) closes
this instance; the *class* — stored flag + missed event = standing lie —
is what this design closes. The load-storm churn that makes the window wide
is not exotic: one manageusers load showed 1,296 limbo entries and 428
key/coattail rebinds against a 719-wrapper store.

**The four-phenomena history.** The 2026-05-31 investigation (memory:
observation-layer-leaks) found three of four missing-badge phenomena were the
same root: the `{observed, inViewport, codeword, hint}` sub-states desyncing
under mutation storms, each dropped/reordered event producing a different
stale combination. The reconciler closed the *convergence* gap but kept the
stored flags as inputs — so we still need repair classes to fix the inputs
before the reconcile can trust them.

**The Rango audit.** ~Half of ~280 recent commits were firefighting; the
durable wins all came from removal. The repair apparatus around these three
flags is the largest remaining thicket that exists only to compensate for
storing what we could read.

## Inventory

### `isInViewport` (the IO band flag, ±1000px)

Writers today (5, plus a default):
| Writer | Site | Nature |
|---|---|---|
| IO entries | `intersection-tracker.ts` handleEntries | event, can be discarded (limbo guard) or arrive stale |
| Band sweep | `intersection-tracker.ts` sweepBand | geometry read → flag write, 10Hz mid-fling + every 2s idle tick |
| Prime-at-attach | `wrapper-lifecycle.ts` primeInBandClaims | optimistic geometry write at attach; skips boxless elements (flag then wrong until IO speaks) |
| Plan apply | `settle-engine.ts` (toRelease/toRepair) | settle-time geometry correction of the other writers |
| Constructor default | `element-wrapper.ts:72` `= true` | a stored guess |

Readers: `wantsCodeword`/`wantsHint` (desired-state), gather set enumeration,
the claim flush guard (`doFlush` drops labels for flag-false wrappers), the
idle tick's owed-walk, plan inputs, diagnostics/snapshot.

### `cssHidden`

Writers: build-time paint gate (`content.ts:1914`), settle visibility pass +
plan `cssHiddenDelta` apply (`settle-engine.ts:319,420`). All are
`!isVisible(el)` at some past moment.
Readers: voice-dispatch gate (`content.ts:1681`), `wantsStrict` inputs,
strict stamp (`strict-viewport.ts:132`), plan.

### `occluded` / `overlayCovered`

Writers: occlusion pass (`occlusion.ts:58`, clip-observer fold) and the plan
applying gather's `overlayCovered` map (`settle-engine.ts:456`).
Readers: voice-dispatch gate, `wantsStrict`, strict stamp.

Note the dispatch gate (`content.ts:1675`) is already a *mixed* model: it
reads rect and `isVisible` live at dispatch time but consults the **stored**
`cssHidden`/`occluded` flags — live geometry gated by possibly-stale style
claims. The sealed-dispatch live strict gate (pull-resolution payoff) went
further and reads everything live. That is the direction.

### Explicitly NOT observations (stays on the wrapper)

- **Decisions:** `scanned.codeword`, `preferredCodeword`, `grammarReady`,
  the `hint` object and its dormancy (DESIGN_HINT_REUSE), pending
  claim/release queues.
- **Identity:** fingerprint/registry id, `disconnectedAt` (limbo),
  `lastRect` — *last known* position, explicitly historical, consumed only
  by the rebind tiebreaker. A snapshot labeled as a snapshot is honest;
  a snapshot labeled as current truth is the bug class.
- **Latency stamps** (`tInBand`, `tClaimed`, …): historical by definition.

## Target architecture

1. **Gather is the single derivation point.** `gatherSettleReads` already
   enumerates near-store-sized sets and reads fresh rects/styles/hit-tests
   once per settle. It grows a derived `inBand` (geometryInBand over the
   rect it already read) and keeps `cssVisible` and `overlayCovered` as the
   only sources of those facts. The plan consumes gather outputs
   exclusively; no plan input is a stored observation.
2. **Observers demote to wake-up signals.** IO entries, RO ticks, clip-IO
   and visibility-MO events stop writing wrapper state; they arm the settle
   single-flight (most already do). An observer event can then be dropped,
   coalesced, or delivered late with *zero* correctness cost — it only ever
   costs one settle of latency, and the idle tick already bounds that at 2s.
3. **Claims become plan-applied.** `toClaim` is computed from derived band
   state and applied by the pass — and the *inline* claim paths (IO
   handleEntries claim branch, primeInBandClaims, the scan pipeline's
   pre-POST inline claims) cease to exist. This **supersedes the
   standing-claim-backstop open item in
   `notes/completed/DESIGN_NAV_WIPE_RETIREMENT.md`**: the June attempt was
   reverted because plan-applied claims *raced* the inline claims (badge
   doubling, 285-batch grammar trickle). The race had two participants;
   this design deletes the other one. With a single claim applier there is
   nothing to race, and claim/sync waves coalesce at settle cadence by
   construction.
4. **Dispatch reads live.** The voice gate drops its stored-flag half and
   goes full live-probe (rect + isVisible + occlusion probe at dispatch),
   converging with the sealed-dispatch gate that already works this way.

## Cost gate (measured 2026-07-18, extension-perf.jsonl, 3,554 samples / ~5h visible)

The question "what would full-store per-settle geometry cost?" turns out to
be nearly moot: **the gather's bounded sets already converge to the full
store on every real page class**, because hinted ∪ codeworded ∪ stale-FALSE
candidates ≈ everything the store holds.

| Page class | settles/min | gbcr/settle (p50) | store (p50) | ratio | gather wall/settle |
|---|---|---|---|---|---|
| qb-manageusers | 0.4–0.7 | 719 | 719 | 1.00 | 52–102ms |
| quickbase | 2.8–5.5 | 645 | 623–646 | ~1.00 | 34–42ms |
| youtube-watch | 25–36 | 245 | 244–250 | ~1.00 | 3.3–3.9ms |
| youtube-browse | 13–35 | 145 | 148–153 | ~0.95 | 2.9–6.9ms |
| rumble | 0.1–1.8 | 140 | 140–145 | ~1.00 | 2.3–2.6ms |
| claude.ai | ~10 | 76 | 76–91 | ~0.90 | 4.7ms |

Decomposition (b1/b2/b3 buckets): the rect batch (b2) costs **0.3–6.4ms even
at 719 rects** — one forced reflow then warm-cache reads. Gather wall time on
QuickBase is dominated ~90% by **b3 occlusion hit-tests** (~305/settle,
30–93ms), which this arc does not touch (the memo stays; see non-goals).
Deriving `inBand` at read time adds one `geometryInBand()` per already-read
rect — arithmetic, no layout.

Cadence × store size anti-correlate in the trail: big stores settle rarely
(manageusers: 719 wrappers, 0.5/min), storm cadences have small stores
(shorts: ~820 settles in 30s of storm, 61 wrappers). The worst product
(big store × storm) is the giant-DOM breaker's territory (open sibling),
not this arc's.

Idle-backstop arming (proxy: bandSweepRepairs time series + settle-rate
delta post-23:45 build): on manageusers the tick's sweep healed the
stale-FALSE cohort **once, right after load** (0 → 172 repairs in one step),
then stayed flat for 20+ minutes; steady-state settle rate rose only
0.41 → 0.66/min. The tick's work is load-transient, not steady drip —
consistent with the cohort being a one-shot event-loss artifact (now also
fixed at the root for the limbo case).

**Gate:** each phase lands only if the trail shows (a) settle wall/settle
non-regressing per class (±10%), (b) fling paint latency (band_to_claimed
p90) non-regressing on the YouTube classes, (c) no new repair-class counters
needed. Phase 3 additionally gates on the coverage fixture (400-link grid)
matching the post-revert 648ms t95 — the number the June revert protected.

## Phased landing (one flag at a time, each phase deletes its apparatus)

**Phase 1 — `cssHidden` (lowest risk, smallest fan-out).**
Derivation: gather's `cssVisible` map (already computed). Strict stamp and
plan take it from gather; the dispatch gate calls `isVisible(target)` live
(it already reads the rect live — this closes the mixed model).
Deletes: the stored flag, `cssHiddenDelta` + its apply loop, the build-time
flag write, the recheck-loop remnant that maintains it between settles.
Risk: hover-reveal menus — between-settle visibility flips already arm
`schedulePassSoon` via the visibility MO; that wake-up survives, only its
flag write dies.

**Phase 2 — `occluded`/`overlayCovered`.**
Derivation: gather batch-3 verdicts (memo-accelerated) become the only
occlusion truth; strict inputs and dispatch consume them (dispatch does a
live 5-point probe, as the sealed gate already does).
Deletes: both stored flags, the occlusion applier's flag writes.
Risk: none new — consumers already receive these as inputs "as the appliers
would leave them" (desired-state.ts); this makes that literal.
*Deviation recorded at implementation (2026-07-18): `w.clipped` STAYS —
the first sketch above wanted the clip-observer's flag half gone too, but
on contact `clipped` is the clip IO's own continuously-maintained state
(single writer, cleared on unobserve/drain, membership reconciled
level-triggered each settle), i.e. a tracked-invalidation cache per this
note's own non-goals taxonomy — not a copy of a droppable event. Retiring
it would regress the flicker-free clip hide for no lie-class payoff. The
applied visual OR-fold moved to the badge (HintBadge.applyOcclusion,
paint-decision state); out-of-settle consumers use `isOccludedLive`.*

**Phase 3 — `isInViewport` + plan-applied claims (the big one, own beachhead).**
Derivation: `inBand = geometryInBand(gather.rects.get(w))`; `wantsCodeword`/
`wantsHint` become `(w, inputs)` predicates like `wantsStrict` already is.
IO entries stop writing the flag and stop queueing claims — they arm the
settle. The fling path keeps its cadence: the 10Hz sweep body becomes "run
the derivation + plan on the band-crossing set" instead of "repair flags,
then reconcile from flags" — same reads, no intermediate stored state.
Deletes: the stored flag and its `= true` constructor guess, the sweep's
flag-repair half + two-strike `pendingExit` ledger, `toRepair` (the
stale-FALSE class becomes unrepresentable), `primeInBandClaims` (attach arms
a pass; the pass claims), the IO claim branch + the `doFlush` flag guard
(replaced by a fresh-rect guard in the pass), `refreshViewportClaims`, the
idle tick's owed-walk + band-sweep half (the tick survives as a bare
wake-up heartbeat, or dies if the wake-up set proves complete — decide on
trail data, not in this note).
Risk: this is the June-revert territory — land behind a flag, watch the
coverage fixture for doubling and the grammar-batch counters for
fragmentation. The structural difference from June (no second claim path
to race) is the argument; the fixture is the proof.
*Execution deviations (2026-07-18): (a) the scan pipeline's pre-POST
inline claims are KEPT — they claim for elements not yet in the store
(born codeworded, deduped by filterNewBatchRefs), so they are disjoint
from the plan's store-claim path by construction, and deleting them would
restructure the batch protocol and regress the paint-at-walk-speed
reveal; the arc's thesis (no stored observations) is untouched by them.
(b) No flag gate was used — the phases landed directly per the loop
mandate; the escape hatch is git revert. (c) The idle tick runs
reconcile() (band-convergence + build) each tick and arms the full pass
when work was found — with no stored flag there is no cheaper owed-walk,
and the v2 tick already ran the geometry sweep at this cadence. (d) The
two-strike exit ledger gained a 50ms minimum strike spacing so
near-instant per-batch reconciles can't defeat the temporal hysteresis.*

Sequencing between phases: ship, soak in daily use ≥ a few days of trail,
read the counters, then next phase. The idle tick stays in place until the
whole arc lands (it is currently load-bearing for the cohort-heal case on
quiet pages, and it costs nothing at steady state).

## Non-goals

- **The occlusion memo and the strict probe cache stay.** They are
  read-time caches *with tracked invalidation* (dirty regions, epochs) —
  the healthy kind: a cache that can be wrong only until its invalidation
  fires, not until an unrelated repair loop notices. This arc converts the
  three stored flags into consumers of exactly that pattern.
- **No IO removal.** The band IO remains the cheapest wake-up for
  "something crossed ±1000px"; we stop treating its entries as a state
  transport.
- **No change to limbo/fingerprint identity, codeword stickiness, badge
  dormancy, or `lastRect`** — decisions and identity are wrapper state by
  design.
- **No strict/band unification.** The band notion (paint) and strict notion
  (voice) stay distinct predicates; they merely read from one gather.
- **Not the giant-DOM breaker.** Cost blowups from store × cadence products
  beyond the measured envelope are that design's job.

## Open questions for review

1. **Between-settle freshness for `wantsShown`'s `flagInBand` input** —
   phase 3 makes shown-ness strictly settle-cadenced. The trail says settles
   are frequent when it matters (scroll/mutation arm them) and the 2s tick
   bounds the quiet-page case; is 2s an acceptable ceiling for a badge that
   *should* have painted (today's flag path has the same ceiling — the tick
   is what enforces it)?
2. **Gather set under phase 3** — with no stored flag, the rect set's
   "stale-FALSE candidate" term disappears and the set is simply "live,
   connected wrappers" (measured ≈ same size). Confirm no page class in the
   wild breaks the anti-correlation (the gate's per-class wall-time check
   covers this empirically).
3. **Does the idle tick die at the end?** Leaning keep-as-heartbeat (a 2s
   no-op walk is free insurance against a missed wake-up); decide on trail
   evidence after phase 3 soaks.
