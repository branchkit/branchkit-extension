# Extension Reload / Auto-Update Survival

**Status:** Layer 1 (SW-side reinjection robustness) verified shipped + committed
2026-06-06 (code-checked, not just claimed — see Verified findings). Three of the
four open questions are resolved from code. **Gating reload run 2026-06-06: Layer 1
confirmed sufficient** — a real `chrome://extensions` reload with an open YouTube tab
auto-recovered the orphaned content script in ~700ms (fresh scan + codewords
re-committed, no cascade errors, no close+reopen), and the user confirmed live hint
paint + working voice commands afterward. **Layer 2 is therefore shelved** — its
plan stays recorded below but is not coded, since the cascade it targets did not
appear. Layer 3 remains forward-design. Caveat: the reload tested a YouTube
`/results` page, not `/watch` with a video playing (the heaviest-churn case); revive
Layer 2 only if symptom 1 ever surfaces there. Symptom 2 (F5-after-reload injects no
CS) did **not** reproduce on a 2026-06-06 Chrome F5 trial — the
`tabs.onUpdated{complete}` → `ensureContentScriptInjected` backstop re-injected a
fresh CS cleanly (see Gating test Result) — so it is downgraded to "not reproduced,"
not closed (it has been intermittent historically). The Phase 0 framing below is
retained
— it still gates the *risky* layers; Layer 1 was deliberately the slice that does
NOT require resolving it first.

## Goal

When BranchKit reloads (dev) or **auto-updates (production)**, already-open tabs
must keep working: no hung/unresponsive page, no silently-missing hints, no
"close every tab" workaround. This is a first-impression UX risk — a user whose
tabs break after an update concludes the extension is buggy, not that Chrome
orphaned a content script.

## The symptoms (do NOT conflate — likely distinct root causes)

1. **Orphan sync-throw cascade → page unresponsive.** The reloaded extension
   invalidates the old content script's `chrome.runtime` context, but its V8
   context (timers, observers, listeners) keeps running. On a busy page each
   `sendMessage` throws *synchronously* with "Extension context invalidated";
   `.catch()` only handles async rejection, so the sync throws escape and cascade
   into uncaught errors until the tab is unresponsive. This is the symptom the
   2026-06-02 fix attempt targeted (and regressed). See
   `DESIGN_ORPHAN_CS_TEARDOWN_RETROSPECTIVE.md`.

2. **F5-after-reload injects no content script → hints silently absent.** After a
   reload, refreshing an already-open tab loads with no CS at all — the
   declarative `content_scripts` entries appear to go inert on the renderer for
   that tab until a full browser restart. No cascade, just silent absence.
   Documented only in memory ([[extension-reload-orphans-cs]]), not yet in any
   design. Mechanism unknown.

3. **(Adjacent, mostly addressed — out of scope here.)** CS↔plugin codeword/
   frame_id sync staleness after reload — the identity-hardening work this sprint
   addressed the focused-source side. Cross-referenced so a future reader doesn't
   re-merge it into this effort: [[extension-reload-cs-sync-bug]].

A real fix must handle 1 and 2, and they may need different mechanisms (1 is about
tearing the *old* script down cleanly; 2 is about getting a *new* script to
inject on F5).

## Phase 0 — the gating question (resolve before choosing an approach)

**Does this reproduce under production triggers, or only unpacked-dev reload?**

- **Fresh install is probably NOT a trigger** — Chrome doesn't inject manifest
  `content_scripts` into already-open tabs on install, so there's no prior script
  to orphan; those tabs simply have no BranchKit until reloaded.
- **Auto-update IS the production analogue of a dev reload** — Chrome silently
  swaps the extension (and orphans every open tab's content script) with no user
  action. Disable/enable is a manual equivalent.

The severity hinges entirely on this:
- If symptoms 1/2 reproduce on auto-update / disable-enable → real "BranchKit
  broke all my tabs" bug, prioritize accordingly.
- If they're specific to *unpacked-extension* reload via `chrome://extensions`
  → dev-only annoyance, close+reopen workaround is acceptable, deprioritize.

How to test (hard to trigger on demand — needs design):
- A packed (`.crx` or Web Store unlisted/test) build with a version bump, then
  force an update check (`chrome.runtime.requestUpdateCheck`) in a controlled
  setup, with an open busy tab (YouTube /watch) + an idle tab, observing both
  symptoms.
- Disable→enable the extension at `chrome://extensions` as a cheaper manual
  proxy; confirm whether it behaves like reload or like auto-update.
- Capture with the existing breadcrumbs: `pipeline.bg_rescan_dispatched` should be
  followed by `pipeline.cs_rescan_received`; absence on F5 is symptom 2's tell.

## Existing infrastructure (verified present 2026-06-06)

- `quiesceOrphan` (`content.ts:2164`) — disconnects observers on orphan; the
  retrospective's gap analysis still applies (untracked `setTimeout`s, document/
  window listeners, pending rAF keep firing into dead `chrome.runtime`).
- Liveness discriminator (`plugin/liveness.ts:45`, `openLivenessPort`) —
  distinguishes orphan vs transient SW restart.
- `reinjectContentScripts` (`background.ts:1608`) — re-injects a fresh CS after
  install/update; this is what makes hints come back on existing tabs (but does
  NOT fix symptom 2's F5 path).
- **Orphan guard** (`flushOrphanGuard`, `background.ts:865`) — a mechanism the
  2026-06-02 retrospective predates; understand what it does before any new work,
  it may already cover part of the teardown surface.

## Verified findings (2026-06-06, code-grounded) — resolves 3 of 4 open questions

Read against the current tree, not assumed:

1. **Layer 1 is genuinely in and complete**, not just "decided."
   `reinjectContentScripts` (`background.ts:1613`) filters out chrome://, discarded,
   and other non-injectable tabs, emits `pipeline.bg_reinject_dispatched {count}`,
   then fans every target through `ensureContentScriptInjected` concurrently
   (`Promise.all`), each emitting `pipeline.bg_reinject_tab {tab_id}`. The ping-first
   path (`ensureContentScriptInjected`, `background.ts:1035`) is the double-injection
   guard: a tab already carrying a fresh CS answers the ping and is never
   re-injected. It also one-time-unregisters the reverted 2026-06-05 experiment's
   dynamic scripts (`bk-bootstrap`, `bk-content`) so their persisted registrations
   can't double-inject.

2. **The backpressure hypothesis (constraint 2) is narrower than the retrospective
   feared.** The three sites it flagged as "uses the throw/response as control flow"
   — `label-reservoir.ts:265` (CLAIM_LABELS), `label-sync.ts:174` (GRAMMAR_BATCH),
   and the CONFIRM/RELEASE pair — all `await` the send **inside a `try/catch`**. A
   synchronous throw from an orphaned `chrome.runtime.sendMessage` is caught by that
   same `catch` exactly like an async rejection, and each catch path is benign (the
   reservoir holds its depth and the reconciler re-queues; the batch restores its
   drained deletes and returns an error result). So these sites do **not** depend on
   the sync throw escaping. The putative "throw-as-emergency-brake" exists only at
   the **fire-and-forget** emitters that use a bare `.catch(() => {})` — where a sync
   throw is not caught and aborts the rest of the callback — or no `.catch()` at all
   (e.g. `content.ts:2744` REFERENCE_NAMES_CHANGED). This is exactly what makes a
   *targeted* Layer 2 gate safe where the global `safeSendMessage` drop-in was not:
   gate only the fire-and-forget firehose, never the await+catch sites.

3. **`flushOrphanGuard` does not change the gap analysis.** It clears only the *new*
   script's `__branchkitContentInjected` idempotency flag across frames
   (`background.ts:992`) so a fresh CS can initialize; it does nothing to the
   *orphan's* timers, listeners, or observers. The teardown-completeness gap the
   retrospective named still stands.

4. **The cheap liveness gate already exists as a pattern** — `typeof chrome !==
   'undefined' && !!chrome.runtime?.id` (`plugin/liveness.ts:70`). Layer 2 reuses it;
   no new primitive needed.

**Test-harness reality (correction to Phase 0's "needs design").** Four
`scripts/_test-extension-reload-*.mjs` harnesses already exist (refresh, probes,
alt-paths, firefox). `probes`/`alt-paths` claim to have *reproduced* symptom 2
("F5 dies after reload") and even localized it (PROBE 2: programmatic
`executeScript` works where declarative `content_scripts` go inert — precisely
Layer 1's mechanism). Per [[playwright-not-authoritative]] these are treated as
investigative, not authoritative: forced user-activation, synthetic scroll, and
`chrome.runtime.reload()`-vs-real-reload differences confound them (alt-paths exists
specifically because the first script may have been a `chrome.runtime.reload()`
artifact). They are a starting point for symptom-2 work, not evidence about whether
Layer 1 closed anything.

## Constraints any attempt must satisfy (carried from the retrospective)

These are hard-won; design *against* this list, don't bolt past it.

1. **Ship one layer at a time, behind a guard, with a soak between.** The
   three-layer landing made bisection impossible.
2. **Do not change `sendMessage`'s failure semantics until the backpressure
   assumption is disproven.** The sync throw on orphan context may be
   load-bearing as self-limiting backpressure; the `safeSendMessage` drop-in that
   returned `undefined` is the prime suspect for the steady-state-hang regression.
   Audit `label-reservoir`, `label-sync`, `element-wrapper` (they use the throw /
   response as control flow).
3. **Construct the AbortController owner before anything references it** (TDZ
   footgun — references live in arrow closures evaluated later).
4. **`quiesceOrphan` must stay idempotent and never throw** — every step in its
   own `try/catch`.
5. **Verify on a fresh tab AND a pre-existing tab** — the two symptoms surface on
   different paths.
6. **Wedge guardrail (`scripts/_test-videos-tab-wedge.mjs`) stays green.**
7. **Don't trust "tests pass / build clean."** The reverted fix passed all tests
   and built on both browsers; the regression was steady-state-only, hours in.
   Long soak (open YouTube, idle 30 min, snap CPU + responsiveness) before
   declaring any fix shipped. See [[orphan-teardown-high-blast-radius]].

## Candidate approaches (sketch — undecided, pending Phase 0)

Not chosen; recorded so Phase 1 starts from options, not a blank page.

- **Complete the teardown, carefully** (the retrospective's direction, re-attempted
  one layer at a time): track every timer/listener/rAF on the page session, abort
  them atomically on orphan, but keep `sendMessage`'s throw semantics until proven
  safe. Highest risk per the retrospective.
- **Make symptom 2's injection robust independently.** If the declarative entries
  go inert after reload, a `chrome.scripting` programmatic re-register on update
  *could* restore F5 injection — but the prior `registerContentScripts` attempt
  regressed (duplicate manifest+dynamic injection overran the renderer); any
  re-attempt must prevent the double-fire, not just dedupe after the fact.
- **Minimize the orphan blast radius** rather than tearing down perfectly: gate the
  busiest emitters (the firehose of `sendMessage` from observers) behind a single
  cheap `chrome.runtime?.id` liveness check so the cascade can't start, accepting
  that some orphan work still runs harmlessly until navigation.
- **Lean on Chrome's own lifecycle** where possible (does a newer MV3 give a
  cleaner orphan signal than `runtime.id` going undefined?). Research item.

## Decision (2026-06-06) — scope to dev reload, ship SW-side reinjection robustness first

**Phase 0 resolved pragmatically for the dev case.** The immediate target is the
dev `chrome://extensions` **reload**, which the developer hits constantly. We are
not blocking the lowest-risk layer on a packed-CRX auto-update repro: auto-update
orphans open tabs the same way, so a dev-reload fix is expected to carry over, and
Layer 1 is chosen precisely because it is correct regardless of which symptom
(cascade vs. no-CS) dominates.

**Layering — one at a time, soak between (per the constraints list above):**

- **Layer 1 (implemented this change; SW-side only; low blast radius): make
  reinjection reliable, idempotent, and legible.** Route the per-tab work in
  `reinjectContentScripts` through the ping-first `ensureContentScriptInjected`
  path (ping → retry → `withInjectLock` → re-ping → `flushOrphanGuard` → inject)
  instead of the blunt `flushOrphanGuard + injectContentScriptFiles`, so a tab that
  already carries a fresh CS is never double-injected — double-injection was the
  named failure mode of the reverted 2026-06-05 `registerContentScripts`
  experiment. Fan the tabs out concurrently (`Promise.all`) so the ping-retry
  latency doesn't serialize across every open tab. Add `pipeline.bg_reinject_*`
  breadcrumbs so the next reload shows, in the firehose, how many tabs were
  reinjected and whether `cs_rescan_received` follows per tab. This layer runs
  entirely in the service worker, so it cannot start an orphan sync-throw cascade
  in the page; the worst case is a no-op.

- **Layer 2 (planned + guarded, NOT yet coded; needs the gating reload + a soak):
  orphan blast-radius minimization.** Gate the fire-and-forget firehose emitters
  behind the cheap `chrome.runtime?.id` liveness check so an orphan that outlives its
  quiesce — or fires in the window before quiesce runs — can't start the cascade.
  Concrete, implementation-ready shape:

  - **Gate sites (the firehose, not every emitter).** Rank by frequency under the
    cascade using the per-type counters that already exist —
    `debug/message-counters.ts` monkeypatches `sendMessage` and
    `messageCountersSnapshot().byType` surfaces the counts in the perf snapshot. The
    known hot, fire-and-forget, observer-driven emitters are `firehoseStep`
    (`content.ts:3587`, MO-burst telemetry), the `moCallback:sample` emit
    (`content.ts:3731`), and `REMEMBER_CODEWORDS` (`content.ts:235`). These fire
    hundreds of times on YouTube /watch and their bare `.catch(() => {})` lets a sync
    throw escape. Leave the await+`try/catch` sites (GRAMMAR_BATCH, CLAIM_LABELS)
    untouched per finding 2.
  - **Mechanism.** One small helper — `isExtensionContextAlive()` returning `typeof
    chrome !== 'undefined' && !!chrome.runtime?.id` (the liveness.ts pattern) — and an
    early `if (!isExtensionContextAlive()) return;` at the top of each gated emitter
    helper. No `sendMessage` wrapper, no change to await+catch sites, so the
    load-bearing backpressure path is untouched. The orphan's other callback work
    still runs but degrades to cheap no-ops instead of a throw cascade.
  - **Guard (constraint 1).** A single module-level `const LAYER2_EMITTER_GATE` in
    `content.ts` so the gate flips off in one edit if a soak regresses, and so this
    layer lands in isolation — no Layer 3 riding along, which was the un-bisectable
    mistake of `15c1381`.
  - **Why this is the safe slice.** It only suppresses already-fire-and-forget
    telemetry on a context that is tearing down anyway; worst case is a few missing
    breadcrumbs from a dying tab. It does not touch `sendMessage` semantics, the
    reservoir/batch await sites, or `quiesceOrphan`.
  - **Decision gate.** Land this only if the gating reload (below) shows symptom 1
    still hangs a busy tab after Layer 1. If the tab survives, skip straight to
    symptom 2 (injection) — Layer 2 buys nothing there.
  - **Soak + verify.** After landing, run the steady-state soak (open YouTube, idle
    30 min, snap CPU + responsiveness) and keep `scripts/_test-videos-tab-wedge.mjs`
    green before declaring it shipped (constraints 6, 7, and
    [[orphan-teardown-high-blast-radius]]).

- **Layer 3 (deferred; needs soak; highest risk): complete the teardown.** Track
  every `setTimeout`/rAF/listener on the page session and abort them atomically on
  orphan (the retrospective's direction). Last resort, only if 1+2 are insufficient.

**Note (stale code comment corrected):** `content.ts:124-127` claims the
`port.onDisconnect` teardown is unbuilt "follow-up work (step A)". It has since
landed — `plugin/liveness.ts:56-77` discriminates orphan vs. transient SW restart
and calls `onOrphan()` → `quiesceOrphan`. The remaining gap is timing/ordering and
the teardown's known coverage holes (untracked timers/listeners), not the absence
of a teardown trigger.

## Gating test — run this next (not yet done since Layer 1 landed)

This single observation decides whether Layer 2 is needed; until it runs, Layer 2
stays uncoded. Real Chrome, not Playwright (the harness scripts confound this — see
Test-harness reality and [[playwright-not-authoritative]]).

Setup: open a busy tab (YouTube /watch) **and** an idle tab on an unrelated URL,
then reload BranchKit at `chrome://extensions` (the real-user path, not
`chrome.runtime.reload()`). Watch the dev firehose for the Layer 1 breadcrumbs:

```bash
tail -f ~/Library/Application\ Support/BranchKitDev/firehose.current.jsonl \
  | grep --line-buffered -E 'pipeline.bg_reinject|pipeline.cs_rescan_received'
```

(Same breadcrumbs also land in the browser plugin's replay buffer and the Settings
Traffic tab, if the firehose shape is inconvenient to grep.)

Healthy trace: `pipeline.bg_reinject_dispatched {count}` → `pipeline.bg_reinject_tab
{tab_id}` per tab → `pipeline.cs_rescan_received` per tab. Then branch:

| Observation | Meaning | Next |
|---|---|---|
| Both tabs recover, no close+reopen | Layer 1 sufficed | Stop — no Layer 2. |
| Busy tab hangs / unresponsive | Symptom 1 cascade survives Layer 1 | Land Layer 2 (above). |
| Reinjects, but a later F5 yields no CS / no hints | Symptom 2 (injection), separate quirk | Symptom-2 track (probe scripts), not Layer 2. |
| `bg_reinject_tab` with no following `cs_rescan_received` | Tab reinjected but CS never booted | Inspect that tab's console; likely symptom 2. |

Git is the backstop — revert if steady-state browsing regresses over a soak.

**Result (2026-06-06).** Run with one YouTube tab open (a `/results` search page).
Trace: `bg_reinject_dispatched {count:1}` → `bg_reinject_tab {148764532}` → a fresh
CS session scanned (`kind=scan`, 12–15 elements) and re-committed codewords within
~700ms, with zero "Extension context invalidated" / "duplicate injection" in the
logs. User confirmed the tab stayed live afterward: hint badges paint, voice commands
navigate (one link mis-fired once and worked on retry — within normal
hint-activation noise, not a hang). Maps to the top row: **Layer 1 sufficed, Layer 2
shelved.** Not yet exercised: the `/watch`-with-video pathological case, and the
page-DevTools-console view of the orphan window (the actuator logs can't see
page-side errors — but a wedged page could not have run the fresh scan that landed,
which is strong evidence against a hang).

**Symptom-2 F5 follow-up (2026-06-06).** Same session, immediately after: the user
clicked Chrome's refresh button on the same tab. It reloaded cleanly — no hang, hints
re-painted. Logs show a fresh CS connection (`conn=24589810`, new session
`2e250363`) running a full `kind=scan` plus incremental grammar batches and
re-committing codewords, no errors. So the `tabs.onUpdated{complete}` →
`ensureContentScriptInjected` backstop covers the F5 path here — symptom 2 did not
reproduce. One Chrome trial on a `/results` page; symptom 2 has been intermittent
before, so treat as a positive data point, not a closure. Not yet tested on Firefox
(where declarative re-injection is flakier) or a second consecutive F5.

## Open questions

- **(OPEN — gates the risky layers)** Phase 0 outcome: auto-update-real or
  unpacked-dev-only? Still wants a packed-CRX update repro; the Gating test above is
  the cheaper dev-side proxy that unblocks the Layer 2 decision regardless.
- **(OPEN — empirical)** Are symptoms 1 and 2 the same root cause at different
  moments, or genuinely separate? Determines whether one fix covers both. The Gating
  test's two-tab observation begins to separate them.
- **(RESOLVED, finding 3)** What does `flushOrphanGuard` cover, and does it change
  the gap analysis? It clears only the new script's injection guard across frames; it
  does not touch the orphan's timers/listeners, so the gap analysis stands.
- **(PARTIALLY RESOLVED, finding 2)** Is the sync-throw-as-backpressure hypothesis
  true? The three flagged control-flow sites are sync-throw-safe (await + `try/catch`),
  so Layer 2 as scoped — gating fire-and-forget emitters, never wrapping
  `sendMessage` — carries none of that risk and no longer waits on this. Whether the
  throw is genuinely load-bearing at the bare-`.catch()` sites is still unproven and
  would still block any *global* `sendMessage` wrapper (Layer 3 territory).

## References

- `notes/DESIGN_ORPHAN_CS_TEARDOWN_RETROSPECTIVE.md` — post-mortem of the failed
  2026-06-02 fix; the source of the constraints list above.
- Memory: [[extension-reload-orphans-cs]] (symptom 2 + the auto-update severity
  flag), [[extension-reload-cs-sync-bug]] (the adjacent, mostly-addressed thread),
  [[orphan-teardown-high-blast-radius]] (why this space breaks unrelated browsing).
- Investigation scripts (gitignored): `scripts/_test-extension-reload-*.mjs`,
  `scripts/_test-videos-tab-wedge.mjs` (the wedge guard).
