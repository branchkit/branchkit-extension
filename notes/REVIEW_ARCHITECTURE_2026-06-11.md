# BranchKit Extension — Architecture Review

Date: 2026-06-11
Method: full read of `content.ts`, the restructure/observer-consolidation/soak
notes, and recent git history, plus three parallel deep-reads of the
observation layer, the label/grammar-sync pipeline (extension + plugins/browser
Go side), and scan/placement/render. Bug claims marked **verified** were
re-checked against source directly; the rest carry file:line cites from the
subsystem reads.

---

## 1. Overall assessment

The extension is solving a genuinely harder problem than Rango/Vimium, and the
codebase knows it. Rango's simplicity comes from properties this project
deliberately gave up: hints are ephemeral (reset on nav), keyboard-driven (no
external grammar to keep consistent), and label-to-element binding doesn't need
to survive anything. BranchKit added three invariants Rango never pays for —
**persistent hints that track elements**, **a voice grammar synced across four
processes** (content script → service worker → Go plugin → actuator/Vosk), and
**codeword stability across scroll/nav/reload** — and most of the complexity
here is essential to those, not accidental.

Per-bug engineering quality is high: investigations are measured (the
observer-consolidation note is a model of "measure, then don't do the obvious
thing"), fixes are well-reasoned, and the diagnostics investment (snapshots,
perf trail, firehose breadcrumbs) is what made the hard bugs findable.

The "first-pass fixes built up cumulatively" suspicion is correct, and the
evidence is structural:

- **297 commits since 2026-05-25** (~18/day).
- `content.ts` regrew 3,225 → 3,562 lines in the four days after restructure
  Tier 1 finished — the restructure doc's own thesis ("fixes accrete in the one
  file") demonstrating itself.
- Visible fix → revert → refix cycles in the log (the accelerator
  chain-update pair 334781b / 85ae299).
- The settle pipeline is duplicated byte-for-byte in two handlers
  (content.ts:2876-2911 scroll-settle, :2974-3006 deferred-settle), with its
  ordering constraints ("occlusion before strict", "recheck before strict")
  enforced only by comments.

## 2. The central observation: convergence over enumeration

The codebase has been independently converging on one idea from three
directions — level-triggered reconciliation — but it exists as fragments:

- The badge lifecycle has ~8 reconcile-ish passes (`reconcile`,
  `reconcileTeardown`, `reconcileStrictViewport`, `reconcileOcclusion`,
  `reconcileClipObservation`, `reconcileScrollAccel`,
  `recheckHintedVisibility`, `scheduleBandDiscovery`), each born from one bug,
  each with its own scheduling, guards, retry caps, and cost discipline.
- `computeReconcilePlan` (lifecycle/reconcile.ts) already computes the full
  desired-vs-actual delta — but it runs only as a **diagnostic shadow**
  (`reconcileShadow` in the perf snapshot) that drives nothing.
- The grammar layer heals by *enumerating wipe paths* (SSE-connect
  `reactivate`, liveness `onResync`, bfcache republish) instead of converging
  on observed state.

The endgame: **one settle pipeline whose engine is the plan computation that
already exists**, with IO/MO events demoted to "schedule the pass sooner"
hints — and the same epoch-style convergence for grammar sync. Every
scroll-back badge bug fixed to date (stale-TRUE, stale-FALSE, discovery gap,
dormant-label restore) was a desync between an edge-triggered flag and
reality; a plan-driven reconciler makes the bug class structurally impossible
instead of individually patched.

This is the same pattern already chosen for the actuator's state system:
convergence over enumeration. The extension got there piecewise under fire;
it is worth making it the architecture on purpose.

## 3. Concrete bugs found

| # | Bug | Where | Severity | Status |
|---|---|---|---|---|
| 1 | **Band-margin drift**: `RECONCILE_BAND_MARGIN_PX = 200` claims to mirror the IO margin, but the IntersectionTracker was widened to 1000px ("Was 200 px; Rango uses 1000 px"). `reconcileTeardown` and the reconcile-shadow diagnostic disagree with IO ground truth by 800px; only the `hint?.isVisible` guard (content.ts:1488) prevents codeword-release thrash. Stale 200px comments also at strict-viewport.ts:5, desired-state.ts:19. | reconcile.ts:44-46 vs intersection-tracker.ts:35 | High — silent mis-teardown + polluted tripwire diagnostic | **verified** |
| 2 | **`calibration_active` silently eats grammar puts**: `syncNow` drains `pendingPuts` before POSTing; the plugin's calibration response returns empty succeeded/failed (batch.go:753), so drained wrappers are never re-queued — painted but unmatchable until something else re-queues them. Deletes already have restore-on-failure handling (label-sync.ts:186-189); puts need the mirror. | label-sync.ts:236-238, 296-330 | High — the "badge painted, command does nothing" class | **verified** |
| 3 | **Dead `evicted` protocol field**: handled at content.ts:1908 and label-sync.ts:323-328, typed in types.ts — but no Go code in plugins/browser ever sets it. Leftover from the cumulative-REPLACE era. | both repos | Low — delete | **verified** (grep: zero hits in Go) |
| 4 | **Stale-FALSE viewport repair only covers hinted wrappers**: `reconcileTeardown` filters on `w.hint` (content.ts:1470), so a wrapper that missed its *initial* IO enter (never claimed, never hinted) is never flag-repaired — `wantsCodeword` reads the stale flag and `refreshViewportClaims` skips it forever. | content.ts:1462-1503, intersection-tracker.ts:127 | Medium — residual scroll-back-missing-badge mode | cited, not independently re-verified |
| 5 | **CONFIRM race is cross-frame**: release-before-CONFIRM is deduped within a frame (`outstanding` set), but CONFIRM_LABELS is fire-and-forget, so the SW pool can still consider the codeword free — a different frame can claim it, producing the duplicate codewords the pool exists to prevent. | label-reservoir.ts:51-89, 216-221; label-pool.ts | Medium | cited, not independently re-verified |
| 6 | **Stale grammar lingers / silent drops**: dormant-iframe TTL exclusion only *emits* deletes when a later sync touches the prefix (entries can linger in actuator collections indefinitely); the SSE channel (chan 16) silently drops `activate` dispatches when full, unlogged. | batch.go:25, 592; sse.go:92-106 | Medium — violates the no-silent-drops principle | cited, not independently re-verified |

## 4. Dead weight to delete (greenfield rules apply)

1. **Two dead positioning generations.** `reconcileMode=true` / `anchorMode=false`
   are hardcoded (hints.ts:570-571), yet: `needsScrollReposition` /
   `needsLayoutReposition` are constant-false (hints.ts:1228-1243),
   `reposition()` is a no-op (:1214), ~80 lines of anchor-only diagnostics
   (:1278-1365), sticky/space clamps short-circuited (position.ts:172-205), and
   the container-resolution stack (hints.ts:58-195) survives only to pick
   `anchorParent` for resize-tracking. Worst: `scheduleReposition`
   (content.ts:2745-2807) still runs `cacheLayout` over every visible badge
   each settle just to filter into a **guaranteed-empty** `placeBadges` — only
   its off-screen-hide side effect is live. *Verify the constant-false claims
   before deleting; this is a sizeable destructive change.*
2. **`TargetRectStore`** — built explicitly to end on-demand layout reads, has
   zero production readers (reconcile.ts:28-30 admits it). Finish the cutover
   (strict-viewport + reconcileTeardown read warm rects) or delete it; the
   half-state is the worst option.
3. **The `evicted` field** (bug 3).
4. **44 of the 52 throwaway Playwright scripts** — promote the ~8 that encode
   hard-won regressions (videos-tab wedge, scroll-back gap, codeword coverage,
   reload survival) into a maintained suite with shared fixtures; delete the
   rest. (Already named in the restructure doc's testing plan.)
5. **hints.ts grab-bag** (1,449 lines): legacy container-resolution, scroll-accel
   glue, ~145 lines of mostly-dead anchor forensics, leader-line, and the
   actual HintBadge — four files pretending to be one.

## 5. Remaining perf levers (measured, not speculative)

- **`cacheLayout`'s descendant walk** (layout-cache.ts:40-43) caches rect+style
  for *every descendant* of every element, needed only by `calculateZIndex`
  (itself `querySelectorAll('*')` + per-descendant `getComputedStyle` per badge
  per placement — stacking.ts:100-105). Move z-index computation to
  construction/refine time, cache per anchorParent. Biggest single read-cost
  win on dense pages.
- **B4 from the observer-consolidation investigation**: the doc-level MO at
  270-350ms/session is the dominant observer cost. The per-wrapper trackers
  are settled (2ms/11ms — leave them alone; do NOT consolidate).
- **Shared constructable stylesheet** for badge shadow roots instead of N
  duplicate ~80-line `<style>` blocks (hints.ts:589-671).
- Scroll-accel health check walks ancestors with live `getComputedStyle` per
  armed badge per frame (scroll-accel.ts:88-117).

## 6. Process gaps

- **No CI.** 580+ tests gate nothing. GitHub Actions running `npm test` +
  `tsc --noEmit` is an afternoon and stops the next regression from depending
  on someone remembering.
- **Soak discipline is right but unencoded** — promote the 8 load-bearing
  Playwright repros so "soak" is a known-good harness, not whatever script
  last worked.
- `content.ts` regrowth needs an explicit backstop (review rule or line-count
  tripwire), or the restructure loses the race again — the doc itself predicts
  this.

## 7. Recommended sequence

**Week 1 — verified bugs + cheap structure (all S, low risk):**
band-margin fix → `calibration_active` re-queue fix → delete `evicted` →
extract one `runSettlePipeline()` shared by both settle handlers → SSE drop
logging + plugin TTL sweeper → CI.

**Weeks 2-3 — deletion sprint (M, low-medium risk):**
dead positioning generations (replace `scheduleReposition`'s sweep with an
off-screen-hide pass over reconcile-positioner rects) → `cacheLayout`/z-index
fix → split hints.ts → shared stylesheet → TargetRectStore decision →
stale-FALSE repair for never-hinted wrappers. One batched 30-min soak per the
existing discipline; keep `_test-videos-tab-wedge.mjs` green throughout (the
wedge fix stays load-bearing).

**The two structural arcs (the real payoff):**

1. **Unify the reconciler** — finish restructure Tier 3 (observers onto
   PageSession), then collapse the 8 passes into one ordered, budgeted
   pipeline driven by `computeReconcilePlan` as the engine rather than the
   shadow. This retires the scroll-back bug class rather than its instances.
2. **Grammar epoch handshake** — each batch response carries the plugin's
   per-frame codeword count/hash; mismatch auto-triggers reactivate. Replaces
   the three enumerated full-repush triggers with level-triggered self-healing.
   Then fold CONFIRM into the claim exchange to close the cross-frame race.

## 8. What this review did NOT cover

- `background.ts` (1,135 lines) beyond label/codeword routing — its extraction
  is already planned and partially done (restructure doc, Tier "background").
- `options.ts` / `popup.ts` (1,287 lines combined), `rules/`, `activate/`
  (scroller, event-sequence, keyboard), Firefox-vs-Chrome split, offscreen SSE
  transport.
- The actuator side of the grammar pipeline past the plugin's RPC calls.
- Live-browser behavior of anything — this was a code review, not a soak.
