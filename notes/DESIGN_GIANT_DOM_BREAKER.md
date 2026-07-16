# Giant-DOM circuit breaker — design

2026-07-16. Strategic item 10 from INVESTIGATION_LONG_SESSION_PERF.md
(Rango comparison: ">25,000 elements → viewport-only wrapper
materialization with suspend-on-exit, motivated by ~288k-element pages; we
have no equivalent for a visible tab"). Design-first: the Rango-style
breaker trades away codeword stability — the product differentiator — so
the cheap semantic-preserving lever has to be separated from the true
degraded mode before anything is built.

## Where giant DOMs actually hurt us (post-2026-07 state)

The full-body walk (`discoverInSubtreeBatched`) is already sliced
(SWEEP_WALK_BATCH_SIZE batches, scheduler.yield hops, slab budget) and
gated (band-sweep dirty gate: epoch-clean + <30s skips ~99% of idle
sweeps). What remains on an N-element page:

1. **Boot / SPA-nav discovery** — O(N) total CPU regardless of slicing
   (~37ms at "big DOM" scale; a 288k-element page is ~10× that, paid in
   slices but paid).
2. **Post-add storm sweeps** — any real childList add bumps the epoch, so
   the next settle's sweep re-walks the WHOLE body even when the add was
   one widget. On churny giant pages that's O(N) per storm window.
3. **Store scale on hintable-dense pages** — wrappers persist page-wide by
   design; limbo sweeps, grammar sync size, and per-wrapper observers grow
   with total discovered hintables, not viewport.
4. NOT a giant-DOM problem anymore: reevaluations, gathers, occlusion
   (bounded sets / memoized), pointer rechecks (scoped) all scale with
   tracked/mutated sets, not DOM size.

## Options

**Option B — geometric subtree pruning of the walk (semantic-preserving,
recommended first).** The band sweep's INTENT was always band-scoped; the
walk just enumerates everything and lets flags/claims filter. Instead:
before descending into a top-level (or scroll-container-level) subtree
root, one gBCR decides whether the subtree's box intersects the attention
band — fully-outside subtrees are skipped wholesale. Long documents are
vertically distributed, so this prunes most of a giant page for O(fanout)
rect reads. Preserves every semantic: wrappers stay persistent, labels
stay stable, off-band content is discovered when the band reaches it
(exactly what the band model already promises). Known blind spot:
out-of-flow descendants (position:fixed inside a below-fold container)
whose paint sits in-band while their static ancestor doesn't — rare
pattern; the attention IO + parked sensors + 30s long-stop unpruned walk
backstop it. Gate to pages >25k elements to bound risk (below that, the
walk is cheap enough that pruning only adds rect reads).

**Option A — Rango-style viewport-only materialization + suspend-on-exit
(true breaker, only if B's numbers don't hold).** Above a hard threshold,
wrappers outside the extended viewport are torn down and their codewords
released. Caps store scale (problem 3) — but labels then CHANGE on scroll
return, which is precisely the stability regression the
codeword-stability arc exists to prevent. If ever built, it is a visible
degraded mode for pathological pages, not a tuning knob: threshold well
past anything a designed page reaches (Rango's 25k is ~10× a heavy app
page), and the trade named in the HUD/settings, not silent.

**Option C — store-scale mitigations without suspend** (limbo sweep
event-arming, grammar-sync windowing) if problem 3 shows up without
problem 1/2 — cheaper surgical fixes exist per subsystem.

## Phase 0 — measurement before machinery (the occlusion-memo discipline)

We have no live evidence of which problem class real giant pages hit. Add
to the 5s PERF_REPORT snapshot:

- `domElementCount` (`document.getElementsByTagName('*').length` — live
  collection, O(1) length read)
- already present: wrapperCount, `discoverInSubtreeBatched` /
  `bandDiscovery` cpu buckets

Decision gate from a week of the user's real browsing: which pages exceed
25k elements, and on those, is the cost in the walk buckets (→ Option B),
the store-scaled buckets (→ Option C), or both at crippling scale (→
Option A discussion). No machinery before the numbers.

## Open questions

- Pruning granularity for Option B: top-level children vs scroll-container
  roots (the container-resize tracker + scroll-accel already know the
  scroller set — reuse?).
- Does the boot walk (problem 1) deserve pruning too, or only the repeat
  sweeps? Boot pays once; storms pay repeatedly — measure separately
  (`discoverInSubtreeBatched` by source: boot vs mo_huge vs band).
- Threshold: 25k borrowed from Rango; our per-element walk cost differs
  (subtreeMaybeHintable prefilter). Phase 0 data should set it.
