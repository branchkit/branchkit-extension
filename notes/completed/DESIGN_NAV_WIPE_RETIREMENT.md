# Nav-wipe retirement — a SPA nav is just a large mutation batch

Date: 2026-06-12
Status: COMPLETE — soak passed 2026-06-12. Final form after two soak
corrections (trail below): limbo identity across navs (no hard detach, no
wipe), the nav doScan tail KEPT (it is the bulk claim+grammar pipeline),
the runWhenIdle unbound-rIC fix, and the per-pass toClaim apply REVERTED
(fragmented claim waves + raced the scan's inline claims). Coverage
fixture: load t95 648ms vs 1664ms pre-arc.
Found along the way: runWhenIdle invoked requestIdleCallback unbound —
band discovery had been silently dead after its first invocation in both
engines (fixed, 7bca447; likely the persistent classify discoveryGap).
Scroll-after-nav acceptance: 48 badged / 60 codeworded post-nav+scroll
(the 2026-05-31 symptom was 243 wrappers / 14 codewords).
SOAK CORRECTION (same day): the first cut also dropped the nav-tail doScan,
misreading it as redundant discovery — it is actually the BULK claim +
grammar pipeline (doScanBatched claims inline per batch). On claim-heavy
swaps where rebind can't rescue identity (QuickBase report→report, ~230
fresh claims per nav, swap slower than the rebind window) the IO/settle
trickle path delivered hints+grammar seconds late. The doScan tail is
restored for both rescan kinds. SECOND CORRECTION (same soak): step 1's
per-pass toClaim apply itself was the deeper cause — it fragments
claim/sync into many small waves during load (the trickle; 285 grammar
batches / 167 release messages on one QuickBase tab) and produced badge
DOUBLING on the coverage fixture (176 hosts for 88 anchors at 7fe37a0) —
it races the scan pipeline's inline claims. REVERTED to emit-only
telemetry; the standing-claim-backstop idea needs its own design against
this data. (That design now exists: DESIGN_OBSERVED_STATE_READ_TIME.md,
2026-07-18 — plan-applied claims with the inline claim paths deleted, so
the race this revert protected against has no second participant.) What stands of the retirement: no hard detach, limbo identity
across navs, no nav-specific wipe, plus the runWhenIdle fix. Coverage
fixture (400-link grid): load t95 648ms post-revert vs 1664ms pre-arc vs
2205ms with toClaim — net faster than where we started, swap converges
instantly via rebind.
(Smell recorded 2026-05-31 — "we shouldn't be doing anything specific to
navigation".)

## What the nav path does today, precisely

`rescanForNav('spa_nav')` (content.ts), idle-scheduled after the swap:

1. `preNavDetachAll('rescan', sparePersistent=true)` — hard-detaches every
   wrapper whose element is disconnected and not yet in limbo. Connected
   (persistent chrome) wrappers and limbo wrappers are spared — the
   `sparePersistent` refinement already retired the original full-store
   wipe. What remains bespoke: the hard detach RELEASES those codewords
   immediately, bypassing the limbo → key-ownership → rebind machinery that
   owns disconnection everywhere else.
2. `syncNow('refocus_from_cache')` — grammar republish, same session id (the
   matcher's vocab stays intact mid-rescan). Generic and cheap; not a smell.
3. Deferred (idle ≤300ms): `doScan()` — a FULL document rescan — then
   `reconcile()` (the one-shot claim backstop), `flushNow`, `showHints`.

Plus the voice path: `preNavObserverTeardown('activate_click')` synchronously
unobserves every wrapper BEFORE the simulated click — the wedge preempt
(ca25199). **This stays.** It is part of why the Firefox freeze stays fixed,
it detaches nothing, and it is cheap. Do not relitigate.

## Why each bespoke piece is now redundant

- **The hard detach** duplicates `dropDisconnectedWrappers`: the
  MutationObserver sees the swap (HUGE_MUTATIONS path) and parks
  disconnected wrappers in limbo, where key-ownership / fingerprint rebind
  preserve codeword identity across the re-mount — the exact stability
  machinery the hard detach forfeits. Mass non-rebinding wrappers finalize
  at the 250ms deadline; that is the same codeword release, just AFTER
  rebind got its chance.
- **The full `doScan`** duplicates discovery the swap already triggers:
  HUGE_MUTATIONS → `discoverInSubtreeBatched` (the same sliced walk doScan
  uses), plus the settle pipeline's band discovery for anything the storm
  drops.
- **The one-shot claim backstop** (`reconcile()` at the nav tail, added in
  52f30c4 for the wiped-codewords regression) is superseded by the unified
  pass — which runs on every settle and at the demoted backstops' cadence —
  EXCEPT that the pass currently only *emits* `toClaim`; claims still apply
  only via the IO fast-path and repair-triggered `refreshViewportClaims`.
  That is the one real gap (the documented scroll-after-nav claim hole:
  243 wrappers / 14 codewords, 2026-05-31).

## The change

**Step 1 — the pass applies `toClaim`.** `applyTeardownPlan` (rename:
`applyLifecyclePlan`) queues the plan's `toClaim` list on the tracker
(`pendingClaim.add` + `scheduleFlush` — the same thing
`refreshViewportClaims` does, minus its own store walk) every pass, not just
on repair settles. This makes the settle pass the standing claim backstop:
any in-band codeword-less wrapper converges within one settle, navigation or
not. Grammar-churn discipline holds — steady state has no in-band
codeword-less wrappers, so the list is empty and nothing flushes.

**Step 2 — the spa_nav handler becomes a hint.** `rescanForNav('spa_nav')`
shrinks to:
  - `hideHints()` reset in manual mode (page-identity behavior, stays);
  - `dropDisconnectedWrappers()` instead of `preNavDetachAll` (limbo owns
    the swapped-out content);
  - `syncNow` republish (unchanged);
  - ~~request band discovery + schedulePassSoon instead of the full doScan
    tail~~ — REVISED by the soak correction above: the doScan tail stays
    (it is the bulk claim+grammar pipeline, not redundant discovery); what
    the retirement removes is the hard detach and the wipe, not the scan.
  - `showHints` re-paint stays gated on hintsVisible as today (paint comes
    from claims landing → `badgeNewlyCodeworded`, as on any other page).
- The refocus (`from_cache`, non-spa_nav) branch is already the generic
  reuse path and is untouched.

**Step 3 — delete the residue.** `preNavDetachAll` (both callers gone — the
activate path already uses `preNavObserverTeardown`), the stale "activate
path runs preNavDetachAll" comments, and the nav-tail claim backstop.

## What stays, explicitly

- `preNavObserverTeardown` on the activate-click path (the wedge preempt).
- The background `webNavigation` SPA-nav signal + `rescan` routing
  (detection is legitimately generic; only the rebuild was bespoke).
- `syncNow` session-reuse semantics (no plugin-side collection wipe).
- Band discovery's idle-scheduled single-flight shape.

## Risks

- **The wedge** is the standing risk for anything touching the nav path
  (ca25199 is hard-won). `scripts/_test-videos-tab-wedge.mjs` after every
  step; the preempt itself is untouched.
- **Mass limbo finalize.** A full swap parks hundreds of wrappers in limbo;
  at the 250ms deadline the non-rebinders finalize in one sweeper tick
  (detach + grammar deletes). The sweeper is O(store) and detach is cheap,
  but this is the new bulk moment — watch
  `finalizeExpiredLimboWrappers` cost on the /watch repro before and after.
- **Rebind mis-binding across navs.** Limbo rebind was designed for
  same-page re-mounts; a nav replaces content wholesale, so fingerprint
  collisions across pages (nav-A's "Subscribe" vs nav-B's "Subscribe")
  could rebind a codeword onto a different-but-identical control. That is
  arguably a feature (perceptual continuity — same control, same codeword),
  and key-ownership (href) disambiguates links. Watch rebind counters on
  the classify sweep for surprises.
- **Discovery latency.** Today's nav path force-rescans at idle ≤300ms; the
  generic path depends on the MO having seen the swap. If a swap's records
  are dropped wholesale (the storm case), content waits for the next settle
  band sweep (~scroll or backstop tick). Mitigation: the spa_nav hint
  requests the band sweep immediately, so worst case ≈ idle-sweep latency —
  comparable to today's deferred scan.

## Verification

Per step: tsc + unit suite + wedge repro. End: classify sweep within
baseline on the leak-measure page AND the /watch nav repro
(`_drive-firefox-nav.mjs` family) checking badge coverage after nav +
scroll-after-nav (the 2026-05-31 hole). Then this change's OWN soak —
nav behavior has a history of regressions that pass green tests.

## Out of scope

- Grammar epoch handshake (arc 2, own note).
- The orphan-CS reload gaps (tracked separately).
- Accel fold into the plan (still the reconciler note's open question).
