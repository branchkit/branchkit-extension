# Stability Ladder Prune — how much codeword stability is worth keeping

**Status:** EXECUTED 2026-07-18. Phase 4 of PLAN_RELIABILITY_CONSOLIDATION.md.
Answers the direct question raised after the Rango audit: *"if stability is
blocking simplicity, I'd consider removing it and letting hints repopulate in
any order."*

## Result (trail read 2026-07-18, ~7,900 perf records / one full day incl.
## the QuickBase soak and heavy YouTube — reset-aware cumulative deltas)

| Rung | Successful rebinds | Share | Verdict |
|---|---|---|---|
| rebind_coattail | 626 (all QuickBase) | 33.9% | **KEEP — prediction falsified** |
| rebind_key | 600 (319 YT / 281 QB) | 32.5% | KEEP |
| rebind_clean (fingerprint) | 579 (574 YT) | 31.4% | KEEP (T1) |
| rebind_position | 33 (all YT) | 1.8% | KEEP (above the 1% rule) |
| rebind_slot | 7 (5 YT / 2 QB) | 0.4% | **DELETED** |

(refuse_no_match 7,495 — most disconnects are genuine removals; refuse_distance 23.)

Section 3's prediction — "slot and coattail are the likely deletions" — was
half wrong in the direction that matters: **coattail is the single
highest-volume rung** and carries the QuickBase grid churn almost alone.
Measuring before deleting is the whole point of this doc; had we pruned on
intuition we'd have re-opened the fling-wave badge-churn class on the user's
primary work site. Slot met the pre-agreed rule on both prongs: <1% of
successful rebinds, and its designed niche (recycled-grid cell swaps) is
demonstrably carried by key+coattail on the exact site class it was built
for. Deleted with its thresholds, consts, probes (slotProbe /
limboSlotLiveness), wrapper field (slotAncestors), counter, snapshot
surfacing, and tests (~200 lines).

Wholesale stability removal: rejected per section 1 (unchanged by the data —
1,845 successful rebinds in one day is 1,845 avoided badge/codeword churns).

---

## 1. The honest accounting of wholesale removal

The question deserves a straight answer, so: what would dropping stability
entirely (Rango's model — identity = live DOM node, labels fungible) actually
buy and cost?

**It would buy less reliability than it looks like.** The audit's incident
ledger attributes the firefighting to three factories: the settle/discovery
scheduler, teardown/lifecycle across reload+nav, and the tri-owner sync. The
stability machinery is in none of them as a *cause*:

- The scheduler storms (settle storms, fling-wave, pointer burn) are about
  when passes run, not who owns which label.
- Orphan CS, SSE wedges, identity handshake — unrelated.
- The sync factory's root is grammar-tracks-viewport, addressed structurally
  by DESIGN_STATIC_PAIR_GRAMMAR.md. Note the direction of the interaction:
  *unstable* labels reshuffle more, which means MORE grammar churn under the
  current mirror, not less. Stability reduces sync pressure.
- The one incident class stability machinery caused directly — the rebind
  edges of the fling-wave arc (pop→dip→pop on recycled grids) — was tuning
  cost inside the ladder, and it is the part this doc proposes to prune.

The removable mass is also smaller than remembered: limbo (518) + rebind
(158) + codeword-memory (151) + the strong-key/slot/coattail portions of
wrapper-lifecycle and the registry ≈ **1,200–1,500 contained, unit-tested
lines** — under 7% of the executable core, and the best-factored 7% at that
(pure functions, real tests, live counters).

**It would cost more product than it looks like.** Three concrete losses:

1. **Mis-dispatch.** A user reads "bat jury", forms the utterance, speaks —
   1–2 seconds. React remounts the node in that window; without limbo the
   label moves; the utterance clicks something else. Rango tolerates this
   because Talon users speak terse letter labels near-instantly and Talon's
   grammar is static; our spoken pairs widen the window.
2. **Visible churn under always-on hints.** This deployment runs
   `hint_visibility="always"`. Pre-stability, label reshuffling on React
   remounts was a recorded product problem (the codeword-churn arc) — it
   would return as constant re-lettering on Gmail/YouTube-class pages, on
   every SPA click.
3. **The nav simplification would un-happen.** Nav-wipe retirement made SPA
   nav "just mutations" *because* limbo absorbs the disconnect/reconnect
   pulse and rebind reclaims identity. Remove limbo and every SPA nav is a
   full teardown+reshuffle again — either visibly (churn) or via resurrecting
   a nav-special path (the thing we just spent two retirement rounds
   deleting).

**Verdict: keep stability; it is not what stands between us and simplicity.**
The scheduler extraction (Phase 1) is. But the *ladder* on top of stability
is over-built, and that part we should prune with data.

## 2. The ladder, tiered

| Tier | Mechanism | Lines (approx) | Role |
|---|---|---|---|
| T1 | limbo (`observe/limbo.ts`) — 250ms grace + finalize sweep | 518 | absorbs React remounts + SPA nav pulses; enables nav-as-mutations |
| T1 | fingerprint rebind (`findLimboMatch` + positional tiebreak) | in rebind.ts (158) | the basic reclaim |
| T2 | strong-key rebind (`tryRebindByStrongKey`, key-ownership index) | part of wrapper-lifecycle | exact-identity fast path |
| T3 | slot rebind (`tryRebindBySlot`, ancestor slot chains, depth ≤6) | part of wrapper-lifecycle | row-swap grids |
| T3 | coattail rebind (`tryRebindByCoattail`) | part of wrapper-lifecycle | neighbors ride a confirmed rebind |
| T2 | cross-reload memory (`codeword-memory.ts` + `codeword-recall.ts`, Regime B) | ~470 SW-side | same codeword after full reload |

T1 is the product guarantee and stays. T2/T3 are accuracy amplifiers with
soak-tuned thresholds (`REBIND_DISTANCE_THRESHOLD_PX`, depth caps, ambiguity
gates) — exactly the kind of machinery the one-in-one-out policy exists for.

## 3. The prune, data-driven

The counters already exist: `rebindCounters` (`rebind_key`, `rebind_slot`,
`rebind_coattail`, fingerprint outcomes + ambiguity buckets) fed by
`tryRebindFromLimbo` and the finalize path, surfaced through the perf/trail
plumbing.

1. **Read a real browsing window.** Piggyback on the pending perf-trail read
   (the 2026-07-16 PENDING CHECK): pull per-rung hit counts and
   ambiguity-rejection counts from extension-perf trails over several days of
   normal use, per-site-class if the data allows (Gmail, YouTube, QuickBase).
2. **Decision rule, agreed before looking:** a rung whose successful rebinds
   are <1% of total rebinds across the window — or whose successes are
   confined to one site-class that T1+T2 also handle within one settle pass —
   is deleted, together with its thresholds, counters, and tests. No
   grandfathering "it might matter someday" (no-legacy-debt rule).
3. **Expected outcome (prediction, falsifiable):** `rebind_key` earns its
   keep (cheap, exact); `rebind_slot` and `rebind_coattail` are the likely
   deletions — they were added in the hottest fling-wave rounds against
   recycled-grid behavior that the reconciler + prime-at-attach have since
   changed. If the counters prove otherwise, they stay; that's the point of
   measuring.
4. **Cross-reload memory (Regime B) gets a product call, not a counter call:**
   it exists so a reload doesn't re-letter the page. Under always-on hints
   that is user-visible value; recommend keeping unless the user demotes it.
5. **Re-verify with `just voice-regress` + a normal-browsing soak** — rebind
   behavior changes are exactly the badge-identity class the corpus and the
   churn log can see.

## 4. What "hints repopulate in any order" would still be true of

Worth stating so the guarantee is understood narrowly: stability never
promises global ordering. Fresh elements get arbitrary pool labels; only
*existing* bindings resist churn (limbo window) and reloads (Regime B). The
product contract is "a label you are looking at keeps meaning what you think
it means" — not "the page always letters the same way." That contract is the
cheap part; the ladder's T3 rungs are refinements on top, and they are the
part on trial here.

---

## Related documents

- notes/PLAN_RELIABILITY_CONSOLIDATION.md — parent plan (Phase 4).
- notes/completed/DESIGN_HINT_LIFECYCLE_RECONCILER.md — the level-triggered
  base the ladder sits on.
- notes/DESIGN_CODEWORD_KEY_OWNERSHIP.md — strong-key mechanism (T2).
- notes/DESIGN_REGIME_B_RECALL.md — cross-reload memory (T2 product call).
- notes/completed/DESIGN_NAV_WIPE_RETIREMENT.md — why limbo is load-bearing
  for the nav path.
