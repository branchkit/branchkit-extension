# Reliability Consolidation — the way forward after the Rango audit

**Status:** EXECUTING, updated 2026-07-19. Phases 1 and 3 executed and Phase 4's
first cut landed 2026-07-18/19 (details inline per phase below); Phase 2's
policies are IN EFFECT (ledger ratified 2026-07-19; one-in-one-out is now a
standing review rule). Combined soak in progress before push — watch items listed in
DESIGN_OBSERVED_STATE_READ_TIME.md and DESIGN_STATIC_PAIR_GRAMMAR.md.
Remaining work is section 6.

**One-line motivation:** the 2026-07-18 audit (this extension vs Rango) found
that roughly half of ~280 recent commits were reliability firefighting, ~25 of
~30 incident classes were self-inflicted, and every *durable* win came from
removing or consolidating machinery (unified reconciler, positioning re-arch,
nav-path retirement, round-29 takeover deletion) while most regressions came
from adding a mitigation. This plan finishes the consolidation arc on purpose
instead of one soak at a time.

---

## 1. What the audit established

Numbers first. Rango: ~9k content-script lines, ~4 observer kinds, two 100ms
debounces, zero telemetry. Us: ~22k executable lines (after tests and comment
mass), ~16 observer kinds, ~20 listeners, ~12 timers.

The delta is justified **in kind** — three capabilities Rango deliberately
refuses:

1. **Codeword stability** (registry/limbo/rebind). Rango's labels are fungible
   letter-pairs inside Talon's static grammar; identity doesn't matter to its
   recognition. Ours are spoken pairs a user reads, holds in mind, and speaks
   1–2s later — a reshuffle in that window is a mis-click.
2. **Grammar/eligibility sync to the native host.** Rango has no external
   consumer.
3. **Seen-is-clickable** (strict viewport + occlusion). Rango paints hints on
   covered elements and accepts the wrongness.

The delta is NOT justified in **mechanism**: the top bug factories are (a) the
edge-triggered settle/discovery scheduler thicket, (b) teardown/lifecycle
across reload and nav, (c) the tri-owner codeword sync (CS ↔ SW ↔ plugin).
None of these is one of the three essential capabilities — they are the *how*,
accreted one soak at a time.

## 2. The phases

Ordered by leverage. Each phase is independently valuable; nothing depends on
a later phase.

### Phase 1 — SettleEngine extraction (biggest lever)

**EXECUTED 2026-07-18** — steps 0–5 (`22d2d25`, `2442713`, `a56df22`,
`a858d3c`, `3d51567`, scripts prune `215398c`). The settle/discovery driver
now lives in `src/lifecycle/settle-engine.ts` behind injected `SettleDeps`;
the scroll-back/nav-wedge/band-race/codeword-churn repro classes are
deterministic unit tests; the sibling 100ms timers have one owner. Soak is
consolidated with the observed-state read-time arc (which landed on top the
same day and deleted the stored-flag repair machinery this driver used to
defend — see DESIGN_OBSERVED_STATE_READ_TIME.md).

Original scope for reference:

Execute `DESIGN_SETTLE_ENGINE_EXTRACTION.md` (Option A, already designed and
sequenced). The ~1,200-line driver in content.ts is the highest-incident code
in the repo and is reachable only through Playwright — which the project has
already established is not authoritative. One constructed `SettleEngine` with
injected `SettleDeps` turns the scroll-back, nav-wedge, band-race, and
codeword-churn repros into deterministic unit tests, collapses the four
sibling 100ms timers into one owner, and shrinks content.ts toward
construct-and-wire.

Deliverable: the migration steps 0–5 in that doc, one consolidated soak at the
end (per the batched-soak rule).

### Phase 2 — sensing freeze + accepted-miss ledger (immediate, ~zero code)

Two standing policies, adoptable today:

**One-in-one-out.** A reliability fix may not add a new observer, timer, gate,
or memo unless it retires one. We are at ~16 observer kinds; the direction of
travel matters more than the count. Preference order when fixing a desync:
(1) make the periodic level-triggered reconcile cover it (eventual consistency
within one settle cadence is *fine* — that is Rango's entire correctness
model), (2) widen an existing gate, (3) only then new machinery, shadow-moded
first (the occlusion-memo pattern — it worked).

**Accepted-miss ledger.** Rango documents its bounded heuristics inline ("the
consequences are not catastrophic") and ships. We should keep an explicit
won't-fix-by-policy list instead of ambient open items. Proposed initial
entries — each is cosmetic once strict-viewport protects dispatch:

- First-paint occlusion (badge may flash over a cover for one settle).
- Partial-occlusion residue.
- `pointer-events: none` covers.
- Sub-250ms staleness of anything the settle pass repairs.

Ledger lives at the bottom of this file; entries need user sign-off since they
are product calls.

### Phase 3 — static pair grammar (shrinks the sync bug factory structurally)

**EXECUTED 2026-07-18/19, with a re-scope that revised this phase's payoff
estimate.** The investigation found Layer 1 was ALREADY static (the DAG
compiler's open states carry the full 26-word alphabet), so the work reduced
to Layer-2 pull-resolution at dispatch. The first default-on FAILED FAST —
prefix narrowing and the Discovery HUD both depended on the dependent-capture
shape, teaching us the mirror is load-bearing for THREE user surfaces (match
truth, narrowing, HUD), not just sync bookkeeping. The missing pieces
(capture-progress emission, display sources) were built and the retirement
pass landed 2026-07-19: sealed-only hint path, grammar-epoch handshake
deleted end-to-end (ext + plugin, ~−830 lines net). The vocab-lag,
commit-debounce-starvation, and decode-empty classes are structurally closed.
**Residue:** `label-sync.ts` (606) + `label-reservoir.ts` (479) survive as
display-grade infrastructure feeding narrowing/HUD/pool-claim latency — a
further cut must replace all three surfaces and is deferred (section 6).
Full history in DESIGN_STATIC_PAIR_GRAMMAR.md.

Original scope for reference:

`DESIGN_STATIC_PAIR_GRAMMAR.md` (new). The spoken codewords are pairs over a
fixed 26-word alphabet. Seed the platform with the full 26×26 pair set once,
permanently, and demote the per-viewport push from *recognition-critical* to
*eligibility metadata* (or retire it for pull-based resolution at dispatch).
The vocab-lag class, the 50ms commit-debounce starvation, the decode-empty
confusion, and most of the delta-mirror urgency (label-sync + reservoir +
epoch handshake ≈ 1,600 lines of bookkeeping) exist only because the grammar
currently tracks the viewport. This is the "no dual-sync coupling" structural
fix for bug factory (c). Cross-repo (voice plugin + extension), so it gets its
own design pass and decode-accuracy measurement via `just voice-regress`.

### Phase 4 — stability ladder prune (measured deletion, answers "is stability
worth it")

**FIRST CUT LANDED 2026-07-18** — the slot rebind tier deleted (`6259bf1`):
counters showed 0.4% of rebinds, its niche covered by key+coattail. Remaining
rungs (`rebind_key`, `rebind_coattail`, fingerprint) await a trail-read
window over real browsing before any further deletion (section 6).

Original scope for reference:

`DESIGN_STABILITY_LADDER_PRUNE.md` (new). Keep codeword stability — the audit
says it is contained, unit-tested, load-bearing for the nav simplifications,
and NOT a top bug factory since it landed. But the rebind ladder has four
mechanisms with soak-tuned thresholds and live counters (`rebind_key`,
`rebind_slot`, `rebind_coattail`, fingerprint). Read the counters from real
browsing trails; delete any rung that isn't earning its complexity. The
wholesale-removal option is analyzed honestly in that doc (short version: it
buys less reliability than it looks like, because stability isn't where the
bugs are).

## 3. What we are explicitly NOT doing

- **Not co-locating badges in the page DOM (Rango-style).** It would trade the
  occlusion stack for per-hint self-defense observers and reattach ladders,
  and it regresses the reconcile model's binding robustness (recorded in the
  positioning re-arch). Body-mounting stays; the occlusion stack is its known
  carrying cost, bounded by the accepted-miss ledger.
- **Not cutting tests or instrumentation.** ~40% of the repo is verification
  apparatus and it is what made the settle-storm and occlusion diagnoses
  possible. The prune target is *sensing/scheduling machinery*, not
  observability.
- **Not another mitigation round.** If a new incident lands mid-plan, the
  first question is which phase's deletion would have prevented it, not which
  new gate hides it.

## 4. Sequencing and effort

| Phase | Size | Risk | When |
|---|---|---|---|
| 2 (policies) | a paragraph in review checklists | none | now |
| 1 (SettleEngine) | ~1 week incl. fakes + test conversion | medium (one consolidated soak) | next |
| 4 (ladder prune) | days; mostly reading counters + deleting | low (limbo untouched) | after a trail-read window |
| 3 (static grammar) | cross-repo design pass first | medium (decode accuracy to verify) | after 1 |

Phases 1 and 4 are extension-local. Phase 3 touches the voice plugin and the
platform vocabulary seam; it should get its own review before code.

## 5. Accepted-miss ledger

**RATIFIED 2026-07-19 (user sign-off, all four entries + the one-in-one-out
policy in Phase 2).** Each entry: what we accept,
why it is safe for voice, and the one condition that would reopen it. Once
ratified, an entry here closes the corresponding ambient open item — a fix
for a ledgered miss is out of scope unless its reopen condition fires.

1. **First-paint occlusion.** A badge may paint over a cover for up to one
   settle pass after first paint. Safe: strict-viewport + read-time occlusion
   protect dispatch; the flash is cosmetic. Reopens if: a dispatch ever
   routes to a covered element, or the flash outlives one settle cadence.

2. **Partial-occlusion residue.** The 5-point sample can classify a partially
   covered element as visible, so a badge may sit on a partially covered
   target. Safe: the badge is readable enough to speak, and dispatch targets
   the element itself. Reopens if: real-site reports of pairs on targets that
   are effectively unclickable.

3. **`pointer-events: none` covers.** A visually occluding cover with
   `pointer-events:none` is invisible to elementFromPoint (the probe returns
   the element beneath — DESIGN_HINT_OCCLUSION_FILTERING.md research), so a
   badge may paint on a visually covered target. Safe: such covers are
   click-transparent by construction, so a spoken dispatch still lands on the
   target; the wrongness is a badge over content the user can't see (the
   clip-observer already catches the scroller-clip subset of this). No web
   primitive detects this class — a fix means geometry-diffing overlays.
   Reopens if: real usage shows spoken dispatches through such covers acting
   on content the user couldn't see, with surprising results.

4. **Sub-250ms staleness.** Anything the settle pass repairs (badge position,
   band membership) may be wrong for less than one settle cadence. Safe: the
   speak loop (read pair → speak → decode) is 1–2s, an order of magnitude
   above the cadence, and dispatch re-reads at action time. Reopens if: the
   cadence lengthens materially or dispatch stops re-reading.

## 6. Remaining work — rewritten 2026-07-19 (post-demotion queue)

Everything the original section listed is CLOSED: ledger + policy ratified,
batch pushed CI-green, tri-owner audit done (REVIEW_TRI_OWNER_SYNC), the
display-grade demotion arc executed and live-verified in both browsers
(DESIGN_DISPLAY_GRADE_DEMOTION.md), the follow-up cleanup landed
(tag-writer consolidation onto `applyDerivedHintsTag`, compat session_end
branch deleted, vocab-commit question closed as KEEP — union changes are
real during browser/tab churn and site attribution is not establishable
from logs). The queue from here, in order:

1. **Soak the demotion arc — the active work item is watching, not
   building.** Watch: HUD-menu staleness during scroll churn (relaxed
   cadence), the derived tag on unusual focus sequences (popup windows,
   drag-a-tab-out, PWA windows), badge doubling on 400-link grids +
   grammar-batch fragmentation + fling first-paint latency (observed-state
   arc, still open), verbs on the live strict gate. Per one-in-one-out, any
   fix that comes out of soak retires something.
2. **Smoke prefix-shadow question** (found 2026-07-19; details in the
   agent-primitives memory): bare "copy"/"close" don't preview-resolve
   while a browser is focused — longer patterns shadow them as
   continuations. First step is one deliberate runtime test (speak bare
   "copy" with a selection while browsing). If it fails live, this is a
   REAL matcher-level UX gap (prefix-blocking of bare literals) and
   deserves its own design conversation; either way the smoke sweep should
   learn to classify state-dependent shadowing instead of failing red.
3. **Ladder prune completion** — read the remaining rung counters
   (`rebind_key`, `rebind_coattail`, fingerprint, position) after a fresh
   trail window; delete what isn't earning its keep. Data decides.
   (Reminder from the first read: coattail was the TOP rung at 33.9% —
   never delete it without fresh data.)
4. **Display-grade mirror retirement — still DEFERRED, payoff shrunk
   again.** After the demotion its only consumers are the two HUD menus
   (prefix list + per-prefix strict); narrowing rides capture.progress and
   gate-arming is derived. Don't start without a forcing need; a
   relaxed-cadence HUD feed design would be the shape.
5. **Orphan-CS paint half of the reload quirk** — the one surviving piece
   of the June reload bug (dispatch half died with sealed resolution).
   Lives in the one-layer-at-a-time teardown space; needs its own arc when
   it earns one.

---

## Related documents

- notes/DESIGN_SETTLE_ENGINE_EXTRACTION.md — Phase 1, already designed.
- notes/DESIGN_STATIC_PAIR_GRAMMAR.md — Phase 3.
- notes/DESIGN_STABILITY_LADDER_PRUNE.md — Phase 4.
- notes/DESIGN_ORPHAN_CS_TEARDOWN_RETROSPECTIVE.md — why teardown changes ship
  one layer at a time regardless of this plan.
- notes/REVIEW_ARCHITECTURE_2026-06-11.md, REVIEW_EXTENSION_FOOTGUNS_2026-06-29.md
  — prior reviews this plan supersedes in direction.
