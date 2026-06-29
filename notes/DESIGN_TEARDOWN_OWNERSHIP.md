# Content-script teardown — the model, the structural cause, and the path

Date: 2026-06-29
Status: proposal (in-progress). Phase 1 is a small, shippable change; Phase 2 is
the structural endgame and is soak-gated.

Companion to `DESIGN_ORPHAN_CS_TEARDOWN_RETROSPECTIVE.md` (the 2026-06-02 failed
fix) and `REVIEW_EXTENSION_FOOTGUNS_2026-06-29.md` (the finding that surfaced
this). Where the retrospective recorded *that* an orphan-teardown change broke
unrelated browsing and left root cause "unknown," this note builds the complete
model, names the structural cause, explains why the bug class is hard to
investigate, and proposes a two-phase fix.

The trigger was small: the `chrome.runtime.onMessage` handler
(`content.ts:2503`) has no `isTornDown` guard, so a torn-down orphan can still
fire navigations and clicks. Investigating "should we just add the guard?" kept
moving the recommendation, which is itself the tell that the problem is
structural, not a single missing line.

---

## 1. The complete inbound-surface inventory

`quiesceOrphan` (`content.ts:2212-2260`) is the teardown body, invoked via
`pageSession.teardown()` (`page-session.ts:300`, which flips `toreDown`
permanently — never reset). Verified against source:

It STOPS:
- the page MutationObserver (`teardownMutationSource`)
- the IntersectionObserver / claim tracker (`tracker.disconnectAll`)
- the resize and clip observers
- the discovery rAF and the scroll-reposition rAF
- the visibility tracker (its IO + MO)
- the reconcile positioner registry (`drainReconcilePositioner` — empties it)
- removes badge hosts (`[data-branchkit-hint]`) and releases the guard attr

It clears **no `setInterval`** and removes **no event listener**.

Only two inbound paths self-stop: `guardKeeper` clears itself when torn down
(`content.ts:253`), and `keydown`/`keyup` guard on `isTornDown`
(`:3136`, `:3200`).

Everything else survives teardown and keeps firing into a dead session:

| Survivor | Does | Class |
|---|---|---|
| `onMessage` (`:2503`) | nav / click / scan / grammar (`history.back` `:2536`, `location.reload` `:2543`, `activate` `:2544`) | blast radius |
| `onVisibilityChange` (`:3414`) | `resumeHintMachinery`/`activateHintMachinery` — **re-creates the MO + scan loop** | resurrection |
| `SHADOW_EVENT` (`:3481`) | `discoverInSubtree` → store deltas → grammar sync; frequent on SPA sites | resurrection |
| `storage.onChanged` (`:653`) | alphabet change → `rotateSession` + grammar re-push | one-shot work |
| `pageshow` persisted (`:2066`) | `pageSession.restore()` grammar re-push | one-shot work |
| `capture_snapshot` (`:3226`) | overwrites the debug snapshot mirror | one-shot, test-only |
| `focus`/`blur` (`:2044`/`:2047`) | set a `windowHasFocus` bool | harmless |
| reposition schedulers (`:2828`,`:3026`,`:3039`,`:3080-3111`) | no-op — reconcile registry is drained | safe-by-emptiness |
| `finalizeExpiredLimboWrappers` (interval, `:3361`) | limbo finalize | survives |
| `publishPerfSnapshot` (interval 250ms, `:3641`, dev) | writes snapshot mirror | survives |
| `shipPerfReport` (interval, `:3672`, dev) | `sendMessage` to SW | survives |

The only brake on the surviving set today is an **emergent** one: raw
`chrome.runtime.sendMessage` throws synchronously ("Extension context
invalidated") on a dead context, and that throw aborts the rest of whatever
handler/loop called it. `safe-send.ts` does not exist in the tree (the
2026-06-02 revert held), so the throw is intact — which is why current main is
stable.

## 2. The model in two pictures

Actors — why an orphan hangs every tab, not just its own:

```
   ┌───────────────────────── one tab ─────────────────────────┐
   │  PAGE  (DOM · scroll · mutations · shadow attaches)        │
   │     │ fires events into BOTH live scripts                  │
   │     ▼                                                      │
   │  ┌──────────────┐         ┌──────────────┐                 │
   │  │ ELDER CS     │         │ SUCCESSOR CS │  (coexist after │
   │  │ (orphaned)   │         │ (live)       │   reload /       │
   │  └──────┬───────┘         └──────┬───────┘   supersede)     │
   └─────────┼────────────────────────┼───────────────────────-─┘
             │ sendMessage            │ sendMessage
             ▼                        ▼
        ┌─────────────────────────────────────┐
        │     SERVICE WORKER  (ONE, SHARED)    │  gates injection,
        │     injection · routing · SSE relay  │  routing & SSE for
        └──────────────────┬──────────────────┘  EVERY tab
                           ▼
                   Native plugin (voice grammar)
```

Teardown — what stops vs. what keeps running:

```
  pageSession.teardown()  ──▶  quiesceOrphan()

  ┌── STOPS (and by which brake) ─────────────────────────────┐
  │  page MutationObserver ........... source removed         │
  │  IntersectionObserver / tracker .. source removed         │
  │  resize / clip observers ......... source removed         │
  │  discovery rAF · scroll rAF ...... source removed         │
  │  reconcile registry ──drained──▶ reposition listeners     │
  │                                   go no-op (drain)        │
  │  guardKeeper ..................... self-clears (flag)      │
  │  keydown / keyup ................. isTornDown guard        │
  └───────────────────────────────────────────────────────────┘

  ┌── SURVIVES (still firing into a dead session) ────────────┐
  │  onMessage ............. nav / click / scan / grammar      │
  │  onVisibilityChange .... RE-CREATES the MO + scan loop  ┐  │
  │  SHADOW_EVENT .......... re-discovery + grammar         │  │
  │  storage.onChanged ..... alphabet re-push               │  │
  │  pageshow / snapshot ... grammar re-push / mirror       │  │
  │  shipPerfReport (intvl)  sendMessage every N ms (dev)   │  │
  │  publishPerfSnapshot ... every 250ms (dev)              │  │
  │  finalizeLimbo (intvl) . every deadline                 │  │
  │                                                         │  │
  │  the ONLY brake on all of these today =                 │  │
  │  the SYNC THROW from sendMessage on a dead context      │  │
  │  ("context invalidated") — load-bearing backpressure    │  │
  │                                                         │  │
  │  RESURRECTION: the two ┐ handlers can UNDO the STOPS ◀──┘  │
  │  box by re-creating the observers it just removed         │
  └───────────────────────────────────────────────────────────┘
```

One sentence: teardown is a partial set of brakes; the synchronous throw is the
catch-all brake on everything teardown misses; and two handlers can un-apply
teardown by recreating the observers.

## 3. The structural cause

The "scattered guards" framing is a symptom. Three structural causes, all
observable directly in source (not theories):

1. **Teardown is enumerated, not derived from ownership.** `quiesceOrphan` is a
   hand-maintained list. Resources are created at module scope scattered across
   ~3,700 lines; a separate function must remember to stop each. Nothing couples
   "I created this observer/interval/listener" to "teardown stops it," so the
   creation sites and the teardown list are two artifacts that must be kept in
   sync by hand — a silent-drift hazard. `onMessage`, the three intervals, and
   the resurrection handlers were missed because nothing structurally forced
   them to be remembered. This is the same enumeration-instead-of-convergence
   disease the hint lifecycle had (see `REVIEW_ARCHITECTURE_2026-06-11.md`), in
   a second subsystem.

2. **The actual safety mechanism is implicit and accidental.** Nobody designed
   "the synchronous `sendMessage` throw is the brake." It emerged from error
   handling and is now load-bearing for everything teardown forgets. A safety
   system that was never named can't be reasoned about — which is exactly how
   `safeSendMessage` removed it on 2026-06-02 without anyone seeing what was
   removed.

3. **Two generations share one mutable substrate with no isolation.** Elder and
   successor both write the page DOM (badge hosts, the guard attribute, dataset
   mirrors) and both talk to the one shared SW. The only arbitration is a single
   guard attribute polled every 2.5s (`guardKeeper`, `GUARD_KEEPER_INTERVAL_MS`)
   — not per-action, not generation-stamped. So the orphan's writes interleave
   with the successor's, and the orphan can even un-do teardown.

## 4. Why this bug class is hard to investigate

Structural reasons, not oversight:

- **Non-local in space.** Cause is tab A's orphan; symptom is tab B hanging,
  mediated by the shared SW. You inspect the broken tab and the bug isn't there.
  Almost certainly why the retrospective landed on "root cause: unknown."
- **Non-local in time.** Steady-state accumulation ("left the tab idle, it
  became unresponsive"), not a deterministic throw at a line. No breakpoint for
  "gradually got slow."
- **Requires a transient two-generation state.** Only visible during the
  elder+successor overlap after reload/supersede. Single-generation tests pass
  clean (all 486 did, both browsers).
- **The brake is invisible.** You can't grep for "the backpressure mechanism" —
  it's an emergent property of error handling. Changing it gives no signal that
  a safety system was removed.
- **The failure degrades the tools.** When the SW saturates, the browser and
  devtools get janky, and you can't attach to a torn-down isolated world — the
  act of reproducing it damages the environment you'd debug it in.

The same non-locality is why reading one handler kept moving the
recommendation: correctness depends on the whole scattered surface at once, just
as the production failure depends on the whole multi-tab, multi-generation
system at once.

## 5. The 2026-06-02 failure, re-explained through the model

Theory (strong, not proven — no isolated repro was captured). The symptom
"fresh, unrelated tabs hung" is impossible for a content-script-only change, so
the locus was **service-worker saturation**. Mechanism:

- The failed fix's Layer 3 (`safeSendMessage`) swallowed the throw, so surviving
  loops in the SURVIVES box ran to completion and rescheduled instead of dying
  at the throw — each lap also posting a message the SW had to process.
- Layer 2 cancelled only 4 tracked timers and left ~20 untracked `setTimeout`s,
  the rAF chains, and reservoir debounces running (the retrospective says so).
- So surviving loops × no brake = each orphaned tab becomes a message pump; the
  shared SW saturates; injection/routing for every tab stalls.

The throw was load-bearing backpressure, and it was removed while teardown was
incomplete. AbortController (Layer 1) was likely a red herring — the relatively
safe layer. `safeSendMessage` was the dangerous one. This is why the
retrospective's constraint 1 (ship one layer at a time) matters.

## 6. The two-phase path

### Phase 1 — make teardown "stick" (now, low risk)

Scope falls out of the model rather than being guessed per handler. Add the same
additive-brake pattern already used by `keydown`/`keyup`:

- Guard the **resurrection paths** at the work functions, not the listeners, so
  any current or future caller is covered: `activateHintMachinery`,
  `resumeHintMachinery`, `discoverInSubtree` return early when `isTornDown`.
  These are what let an orphan rebuild the observers `quiesceOrphan` removed.
- Guard `onMessage` (`:2503`) at the handler entry for blast radius.
- Skip `focus`/`blur` (no work) and the reposition schedulers (already
  safe-by-emptiness). The three low-value one-shots (`storage.onChanged`,
  `pageshow`, `capture_snapshot`) are optional — guard for consistency only.

Why this is safe: `isTornDown` is only ever true post-teardown, and teardown is
permanent, so every guard is a no-op in normal operation and cannot affect the
successor handoff or steady-state. It ADDS brakes; it does not touch the throw
or add AbortController — the opposite direction from what broke. Still soak it
(constraint 7).

### Phase 2 — ownership-derived teardown (later, soak-gated)

The structural fix, consistent with the convergence-over-enumeration direction
the rest of the codebase is taking:

- A session-scoped resource registry: every `addEventListener`, `setInterval`,
  `setTimeout`, observer, and rAF is created through a `pageSession`-owned helper
  that records it, so `teardown()` stops the entire set with no hand-maintained
  list. The restructure already made `pageSession` the owner of construction
  (`PageSession.start()`), so the owner exists — this extends it to own
  destruction too.
- Make backpressure explicit: a named guard at the `sendMessage` boundary rather
  than reliance on the emergent throw. The throw can only retire once the
  registry guarantees nothing is left running to need braking — never before.

## 7. Constraints (carried from the retrospective, still binding)

1. Ship one layer at a time, behind a guard — three-layer landings can't be
   bisected.
2. Do not change `sendMessage` failure semantics until every call site is
   audited for "this throws on orphan." The throw is load-bearing until proven
   otherwise.
3. Construct the registry owner before anything references it (the TDZ footgun).
4. `quiesceOrphan` stays idempotent and must not throw — every step its own
   try/catch.
5. Verify on a fresh tab AND on pre-existing tabs — two separate failure paths.
6. The wedge guardrail (`scripts/_test-videos-tab-wedge.mjs`) stays green.
7. Don't trust "tests pass / builds clean." Run a steady-state soak (open
   YouTube, leave 30+ min, snap SW CPU + responsiveness) before declaring done.

## 8. Open questions

- Which surviving loop pumps the SW hardest? Cheapest way to learn is to
  re-land Layer 3 (`safeSendMessage`) alone behind a flag and watch SW CPU on an
  orphaned YouTube tab — only worth doing if Phase 2 is greenlit.
- Does Phase 1's resurrection guard fully close the orphan-resumes-MO path, or
  does `finalizeExpiredLimboWrappers` (surviving interval) keep enough alive to
  matter? Measure during the Phase 1 soak.
- Should the guard attribute become a per-action generation stamp (so routed
  activations can be rejected by stale generation) rather than a 2.5s poll? Ties
  to the background review's frame-staleness finding.
