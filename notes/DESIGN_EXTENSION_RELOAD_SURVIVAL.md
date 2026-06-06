# Extension Reload / Auto-Update Survival

**Status:** Layer 1 (SW-side reinjection robustness) decided + implemented
2026-06-06; Layers 2–3 (orphan teardown) remain forward-design, deferred behind a
soak. The Phase 0 framing below is retained — it still gates the *risky* layers;
Layer 1 is deliberately the slice that does NOT require resolving it first.

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

- **Layer 2 (deferred; needs soak): orphan blast-radius minimization.** Only if
  Layer 1's breadcrumbs show symptom 1 (the cascade) still hangs a tab: gate the
  highest-frequency observer emitters behind a cheap `chrome.runtime?.id` check so
  an orphan that outlives its quiesce can't start the cascade — WITHOUT changing
  `sendMessage`'s throw semantics (constraint 2; the throw may be load-bearing
  backpressure).

- **Layer 3 (deferred; needs soak; highest risk): complete the teardown.** Track
  every `setTimeout`/rAF/listener on the page session and abort them atomically on
  orphan (the retrospective's direction). Last resort, only if 1+2 are insufficient.

**Note (stale code comment corrected):** `content.ts:124-127` claims the
`port.onDisconnect` teardown is unbuilt "follow-up work (step A)". It has since
landed — `plugin/liveness.ts:56-77` discriminates orphan vs. transient SW restart
and calls `onOrphan()` → `quiesceOrphan`. The remaining gap is timing/ordering and
the teardown's known coverage holes (untracked timers/listeners), not the absence
of a teardown trigger.

**How the developer tests Layer 1 (one reload):** with a busy tab (YouTube /watch)
and an idle tab open, reload at `chrome://extensions` and watch the firehose:
`pipeline.bg_reinject_dispatched` (count) then `pipeline.bg_reinject_tab` →
`pipeline.cs_rescan_received` per tab. Both tabs recovering without close+reopen ⇒
Layer 1 sufficed. A hung tab ⇒ Layer 2 (cascade). A tab that reinjects but whose
later F5 yields no CS ⇒ symptom 2 (separate Chrome quirk; see Open questions). Git
is the backstop — revert if steady-state browsing regresses over a soak.

## Open questions

- Phase 0 outcome — auto-update-real or unpacked-dev-only? (Gates everything.)
- Are symptoms 1 and 2 the same root cause seen at different moments, or genuinely
  separate? (Determines whether one fix covers both.)
- What does `flushOrphanGuard` already cover, and does it change the retrospective's
  gap analysis?
- Is the sync-throw-as-backpressure hypothesis true? (Must be answered before any
  `sendMessage` wrapper ships — it's the suspected cause of the last regression.)

## References

- `notes/DESIGN_ORPHAN_CS_TEARDOWN_RETROSPECTIVE.md` — post-mortem of the failed
  2026-06-02 fix; the source of the constraints list above.
- Memory: [[extension-reload-orphans-cs]] (symptom 2 + the auto-update severity
  flag), [[extension-reload-cs-sync-bug]] (the adjacent, mostly-addressed thread),
  [[orphan-teardown-high-blast-radius]] (why this space breaks unrelated browsing).
- Investigation scripts (gitignored): `scripts/_test-extension-reload-*.mjs`,
  `scripts/_test-videos-tab-wedge.mjs` (the wedge guard).
