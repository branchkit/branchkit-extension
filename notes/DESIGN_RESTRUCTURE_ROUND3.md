# Restructure round 3 — re-extraction, the feature-module boundary, and the ratchet

**Status:** EXECUTED 2026-07-24 (same day as the draft), all commits local,
unit suite green (1,181 → 1,432 tests), builds clean. **One consolidated
real-browser soak still owed before push** — see section 9. Two lifts were
rejected-with-rationale during execution (section 8). Follow-on to
notes/DESIGN_EXTENSION_RESTRUCTURE.md (the June arc, Tiers 0-3 landed) after
its gains were erased a second time.

**One-line motivation:** the June restructure took `content.ts` from 4,134 to
~3,000 lines and predicted that "a plan that doesn't change where fixes land
will lose this race again." It lost it again — `content.ts` is back to 4,641 —
so round 3 does the re-extraction, plus the two things the prior rounds
lacked: a convention that makes new features land in their own modules by
default, and a CI ratchet that makes regrowth a failing build instead of a
discipline.

---

## 1. Current state, measured (2026-07-24)

### 1.1 The regrowth, round 2

| File | after June arc (2026-06-12) | today | delta |
|---|---|---|---|
| `content.ts` | ~3,000 | **4,641** | +1,150 net (+4,193 / −3,036 churn) |
| `background.ts` | ~1,135 | **2,273** | +1,138 net |

Neither file has a unit test. The June doc's observation still holds exactly:
the untested code and the un-extracted code are the same code.

Two gaps the June doc flagged have since been fixed and are NOT part of this
round: CI exists (`.github/workflows/ci.yml` — tsc, tests, build on every
push/PR) and the 52 throwaway Playwright drivers were pruned to a maintained
handful.

### 1.2 What the regrowth is — and crucially, what it is not

The June arc's structural change **held**. The delta cut is intact
(lifecycle mutates the store; grammar-sync subscribes), `PageSession.start`
still constructs the observers, and the extracted modules did not reabsorb
lifecycle logic. Round 2 did not fail by reversal.

It failed by **default landing zone**. The regrowth is new *feature concerns*
— voice selection/caret, the video/media layer, nudge rules, marks, palette,
storm-trap forensics (since deleted), perf sampling — and they landed in
`content.ts` because that is where command registration and message routing
live. The evidence is one number: there are **54 `dispatcher.register` calls
in `content.ts` and zero in any feature module**, even though `dispatcher`,
`registry`, and `keyHandler` have been importable singletons
(`core/singletons.ts`) since Tier 0. The boundary exists; nothing routes new
work to it.

`background.ts` regrew the same way: tab-markers/MRU/nav landed as proper
`background/` modules, but their wiring, the media routing, the palette
handlers, and the references sync all accreted inline — and the one section-4
extraction that never happened (`plugin/sse-transport.ts`) is still inline.

### 1.3 Cluster inventory — `content.ts` (4,641 lines)

Line numbers as of 2026-07-24; each cluster is a candidate lift with its
target home. Sizes are approximate.

| Cluster | Where | ~Lines | Target |
|---|---|---|---|
| Rules/nudge application (`applyMatchedRules`, `applyNudgeSet`, badge-size, caches) | 607–762 | 160 | `rules/rule-apply.ts` |
| Selection / caret / marks / page-nav commands (`currentPosition`, `savePreviousPosition`, `restorePosition`, `parseSelectionCommand`, `navigatePage`) | 1439–1674 | 240 | `activate/selection-commands.ts` (beside `activate/caret.ts`) |
| Scan orchestration (`doScan`, `doScanBatched`, `processScanBatch`, `scheduleDoScan`, `applyUserRuleToScan`) | 1851–1930, 2218–2570 | 550 | `scan/scan-orchestrator.ts` |
| Nav / bfcache / republish healers (`republishAllGrammar`, `restoreFromBfcache`, `rescanForNav`, `flushDeferredNavRescan`, `republishForActivation`) | 2571–2989 | 300 | `lifecycle/nav-rescan.ts` — **teardown-adjacent, see 4.3** |
| Orphan quiesce (`recordOrphanHit`, `quiesceOrphan`, `preNavObserverTeardown`) | 2692–2841 | 150 | **excluded this round** (see 4.3) |
| Message listener (`chrome.runtime.onMessage`, ~60 cases) | 3044–3500 | 450 | thins via the feature-module convention, not a lift |
| Perf/paint sampling + snapshot stats (`paintSamplerTick`, `latencySummary`, `discoverySourceStats`, `paintLatencyStats`, `snapshotExtras`) | 3505–3760 | 260 | `debug/perf-report.ts` |
| Settle-signal wiring (`wireSettleSignals`) | 3763–4032 | 270 | fold toward `lifecycle/page-session.ts` (it IS wiring — the stated owner) |
| Discovery walk + reevaluate (`discoverInSubtree*`, `reevaluateAttribute`) | 4038–4206 | 170 | stays (June decision: rules/attention/shadow coupling — unchanged) |
| Hint machinery lifecycle + hidden-tab suspend (`activateHintMachinery`, `suspend/resumeHintMachinery`, `onVisibilityChange`, `watchUndefinedCustomElements`) | 4207–4450 | 240 | `lifecycle/machinery-gate.ts` |
| Perf snapshot integrator (`buildPerfSnapshot`, `publishPerfSnapshot`, `shipPerfReport`) | 4452–4641 | 190 | integrator stays per the June decision; its stats *helpers* move with the sampling cluster |

Fully extracted, the residue (bootstrap, registration wiring, the
deliberately-kept discovery walk, the integrator) is a ~1,800-line file. That
is the realistic round-3 target — not the "construct one PageSession and
nothing else" end state, which the discovery-walk coupling still blocks.

### 1.4 Cluster inventory — `background.ts` (2,273 lines)

| Cluster | Where | ~Lines | Target |
|---|---|---|---|
| SSE transport (retry timers, `onSSEConnected/Disconnected`, `connectSSE`, `ensureOffscreen`, `connectDirectSSE`, `handleSSEEvent`, `teardownSSE`) | 66–170, 941–1230 | 430 | `plugin/sse-transport.ts` — the June section-4 item that never landed; `sse-backoff.ts` already exists as its helper |
| References sync (load/save/push/hydrate) | 226–287 | 60 | `background/references.ts` |
| Plugin forwarders (`forwardDispatchResult`, `forwardDebugLog`, `forwardPerfReport`, `postGrammarBatch`, `postFocus`, `postActiveTab`, session start/end) | 288–360, 792–940 | 220 | consolidate onto `plugin/actuator-client.ts` |
| Tab / zoom / palette actions (`handleTabAction`, `handleZoomAction`, `handlePaletteAction`, `switchToTabById`, palette voice pub) | 444–582, 718–791 | 280 | `background/tab-actions.ts`, `background/palette.ts` |
| Media routing (`tabHasVideo`, `syncMediaActive`, `resolveMediaTargetTab`, `sendMediaActionToTab`, `handleMediaAllAction`) | 583–717 | 130 | `background/media.ts` |
| Message listener (~430 lines of cases) | 1241–1673 | 430 | thins via convention |
| Tab lifecycle listeners + `purgeTab` + `logTabSwitch` | 1674–1860 | 180 | `background/tab-sessions.ts` (June section-4 item) |

`popup.ts` (1,176) and `options.ts` (964) are also untested roots, but they
are UI pages with different failure modes and are out of scope — noted so the
scope cut is a decision, not an oversight.

---

## 2. Phase 1 — the feature-module convention (change where fixes land FIRST)

This goes first because every Phase-2 lift should land in its final shape,
and because it is the piece whose absence lost rounds 1 and 2.

**The convention:** a feature owns one module that contains its handlers AND
its registration. The module imports `dispatcher` (and `keyHandler` if it has
mode interactions) from `core/singletons.ts` and registers its own actions;
`content.ts` merely side-effect-imports the feature module in a single
"feature manifest" block. Same shape on the SW side against the message
router. Concretely:

```ts
// activate/selection-commands.ts
import { dispatcher } from '../core/singletons';
export function registerSelectionCommands(): void {
  dispatcher.register('select_left', (params) => { ... });
  dispatcher.register('select_whole', () => { ... });
  ...
}
```

Explicit `register*()` calls from the bootstrap (not import-time
side effects) — the registration order stays readable in one place, and tests
can construct a fresh dispatcher and register a single feature against it.

**Message-listener routing:** the ~60-case `chrome.runtime.onMessage`
listener shrinks the same way — cases that are really action dispatches route
through `dispatcher`; cases that are transport (ping, debug bridge, state
queries) stay. The listener's job becomes routing, not behavior. Do NOT build
a generic message-routing framework for this; a `switch` that calls imported
feature functions is fine. The point is where the *bodies* live.

**Keymap stays where it is.** `buildRegistryFromKeymap` / `registry.replaceAll`
is the keys→actions mapping (live-editable, notes/DESIGN_KEYMAP_CONFIG.md) and
is orthogonal: feature modules own action *handlers*; the keymap owns which
keys invoke them.

The convention is enforced by the Phase-3 ratchet, not by review vigilance: a
new feature landing in `content.ts` pushes the file over its ceiling and
fails CI.

---

## 3. Phase 2 — the lifts (spec-per-lift, behavior-equivalent)

Same rules as the June arc, restated because they worked:

- **A cluster is not extracted until it has a spec** — the move and the test
  land in the same commit.
- **Behavior-equivalent relocation only.** No logic changes ride along. A
  latent bug found during a lift gets its own commit, before or after.
- Injection seams are already there (`pageSession`, the importable
  singletons, `bgState`); a lift that needs a NEW injection seam is a smell —
  stop and check whether the cluster boundary is wrong.

Suggested order, cheapest-first / riskiest-last:

1. `background.ts` clusters (1.4) — procedural, faked-`chrome.*` testable,
   no DOM. `sse-transport` first (biggest, self-contained, and its backoff
   helper is already extracted and tested). This is also where the
   consolidation onto `actuator-client` retires duplicated authed-POST
   boilerplate.
2. `content.ts` leaf clusters: rules/nudges, perf sampling, selection/caret
   commands (registered per Phase 1 as it moves), machinery-gate.
3. Scan orchestration — the biggest single lift; lands against
   `scan/`'s existing test fixtures.
4. Settle-signal wiring folds toward `PageSession` — last, because it touches
   the wiring of everything above.

Per the project's soak discipline (and exactly as decided in June): steps
land back-to-back behind green tests + tsc + build, and **one consolidated
real-browser soak** gates the push — not a soak per commit. The soak's watch
list: SSE reconnect/offscreen fallback (transport lift), grammar push parity
during scroll churn (scan lift), badge show/hide + selection commands by
voice and keyboard (feature-module re-registration).

---

## 4. Phase 3 — the ratchet

### 4.1 Mechanism

A ~30-line CI check, in the spirit of `check-gen` and `prefix-lint`: turn a
discipline into a gate.

- `monolith-ceilings.json` at the repo root:
  `{ "src/content.ts": 4700, "src/background.ts": 2300 }` — grandfathered at
  current size + small slack on adoption.
- `scripts/check-ceilings.mjs` compares `wc -l` against the ceiling; CI fails
  on exceed. Runs as a step in `ci.yml` next to `tsc --noEmit`.
- **Ratchet-down rule:** when a file sits more than 100 lines under its
  ceiling, the check fails with "lower the ceiling" — so extraction wins get
  locked in the same PR that earns them, and the ceiling monotonically
  tracks the file down. (Without this, the ceiling is a one-time cap that
  regrowth quietly refills.)

The ceilings file is a gate, not a mirror — drift is a loud CI failure, not
silent desync, so this does not trip the no-dual-sync rule.

### 4.2 What the ratchet means in practice

A bug fix that adds 30 lines to `content.ts` under the ceiling: lands
freely. A feature that adds 200: fails CI, and the correct response is the
Phase-1 shape — the feature lands as its own module with a registration call.
The escape valve for a genuine emergency is editing the ceiling in the same
PR, which is visible in review — the point is that growing the monolith
becomes a *decision*, never a default.

### 4.3 Fences (unchanged from standing policy)

- **Orphan/teardown code is excluded from bulk extraction.** `quiesceOrphan`,
  `preNavObserverTeardown`, `recordOrphanHit` stay in place this round. Per
  DESIGN_ORPHAN_CS_TEARDOWN_RETROSPECTIVE.md, changes there ship one layer at
  a time with their own long soak regardless of any plan — a "verbatim
  relocation" of teardown code still reorders module-init timing, which is
  exactly the class that has broken steady-state browsing before. If
  `lifecycle/nav-rescan.ts` (the nav/republish lift) can't be cut cleanly
  away from the teardown functions, it shrinks or waits.
- **One-in-one-out sensing freeze:** trivially satisfied — extraction adds no
  observer, timer, gate, or memo. Any lift that finds itself wanting one is
  out of scope.
- **The June keeps stay kept:** the discovery walk stays in `content.ts`
  (rules/attention/shadow coupling), `buildPerfSnapshot` stays the resident
  integrator, background-driven SPA-nav detection and content-side codeword
  reclamation are not touched.

---

## 5. What this round is NOT

- Not a redesign. The store-centric reactive model, the delta cut, the
  source/reaction split, and the SettleEngine are the architecture; this
  round moves code TO them.
- Not the display-grade mirror retirement, the orphan-CS paint fix, or the
  ladder-prune data read — those stay queued in
  PLAN_RELIABILITY_CONSOLIDATION.md section 6 and are not to be folded in as
  riders.
- Not a test-coverage project for `popup.ts` / `options.ts` (out of scope,
  section 1.4).

## 6. Payoff

The direct payoff is the same as June's: the incident-prone surface becomes
unit-testable, and review diffs stop being "somewhere in a 4,600-line file."
The compounding payoff is what Phase 1 + 3 buy that June didn't: the G1
text-targeting work, the Rango parity gaps, and whatever the demotion soak
surfaces will land as feature modules against a gated boundary — the first
arc in this repo where the monolith cannot quietly reabsorb the next month of
work.

## 7. Open questions

- Ceiling slack constants (adoption slack, the 100-line ratchet-down
  trigger) — bikeshed-grade; pick during Phase 3 implementation.
- Does the SW message listener route through a dispatcher-like registry, or
  stay a switch over imported functions? Start with the switch; a registry
  only if the case count keeps growing after the bodies move out.
- `wireSettleSignals` fold: into `PageSession.start` directly, or a
  `lifecycle/settle-wiring.ts` it calls? Decide when lifting — whichever
  leaves `PageSession` readable.

---

## 8. Execution log (2026-07-24) — what landed, what changed, what was rejected

Eight commits, each behavior-equivalent with a spec in the same commit:

1. `plugin/sse-transport.ts` — stream lifecycle for both engines, retry
   ladder, voice-pause intent, connection paint; behavior injected as four
   hooks (onPreConnect / onConnectedEdge / onEvent / onAlphabet) wired in
   background.ts. 16 tests. background.ts 2,273 → 1,978.
2. `plugin/plugin-api.ts` + `background/references.ts`. **Refinement over
   the section-1.4 sketch:** the typed endpoint wrappers did NOT consolidate
   onto actuator-client — actuator-client stays pure transport (discovery,
   creds, authed POST); plugin-api owns what the endpoints MEAN, including
   postGrammarBatch's letter<->spoken translation. → 1,732.
3. `background/tab-actions.ts`, `background/palette.ts`,
   `background/media.ts`, `background/tab-sessions.ts` — explicit wiring
   (initMedia / startDeadTabSweep); chrome listeners stay in background.ts
   as routing. 30 tests. → 1,292.
4. `debug/perf-report.ts` — paint sampler, discovery/latency stats,
   snapshotExtras; the buildPerfSnapshot integrator stays per the June
   decision. content.ts 4,641 → 4,354.
5. `rules/rule-apply.ts` — compiled-rule state + appliers +
   applyUserRuleToScan; wiring stays. **One reasoned seam change:**
   applyRuleBadgeSize no longer calls scheduleDoScan (both call sites
   already schedule on every size-changing path; the detach-all
   invalidation stays). → 4,252.
6. `scan/scan-orchestrator.ts` — doScan/scheduleDoScan/doScanBatched/
   processScanBatch verbatim. Enabling moves to designated homes:
   hintMachineryEnabled + suspended onto PageSession, claimCounters into
   debug/perf-counters, rememberClaimedCodewords into labels/codeword-recall,
   observeInvisibleCandidates into observe/visibility-tracker. → 3,792.
7. `activate/selection-commands.ts` — the first Phase-1 feature module:
   owns handlers AND registration (registerSelectionCommands from the
   bootstrap's feature-manifest block; nothing registers at import time,
   spec-pinned). → 3,625.
8. Phase 3 ratchet: `monolith-ceilings.json` + `scripts/check-ceilings.mjs`
   as a CI step (fails on exceed AND on >100 under). Ceilings:
   content.ts 3700, background.ts 1350.

**Rejected-with-rationale (do not re-attempt without new facts):**

- **`lifecycle/machinery-gate.ts` (section 1.3's activate/suspend/resume
  cluster).** Its resurrection guards call recordOrphanHit and its boot
  wiring interleaves with kickInitialScan/showBadges — this is the one
  content cluster where a "verbatim relocation" still reorders init timing
  in exactly the class DESIGN_ORPHAN_CS_TEARDOWN_RETROSPECTIVE.md fences.
  Per section 4.3: it shrinks or waits. It waits, until the orphan-CS paint
  arc (PLAN_RELIABILITY_CONSOLIDATION section 6 item 5) gives it a proper
  home.
- **The wireSettleSignals fold.** It is already the single wiring site the
  June settle-engine arc deliberately built (step 3); relocating it buys
  line count but no boundary, at listener-registration-timing risk.

End state vs the 1.3 target: content.ts 3,625 (target ~1,800 assumed the
two rejected lifts plus the nav/teardown cluster; those stay by fence, not
by omission). background.ts 1,292 — routing + wiring + init, its intended
shape.

## 9. The consolidated soak (owed before push)

Per section 3, one real-browser soak gates the push of the whole batch.
Chrome AND Firefox (the SSE engines differ). Watch list:

- **SSE transport:** kill + restart the BranchKit app mid-session → badges
  must become matchable again without a tab reload (host-restart healer on
  the connect edge). Pause voice from the popup → no reconnect chatter in
  the SW log; resume → reconnects. Leave the host down 2+ min → retry
  ladder settles at its 30s cap, standalone hints/keyboard unaffected.
- **Grammar path:** scroll churn on a heavy page (QuickBase report /
  YouTube results) → badges paint at walk speed, voice matches them;
  no over-/under-sync in the plugin log (postGrammarBatch moved modules).
- **Feature re-registration:** marks set/jump (m/\`), caret + visual mode by
  key and by voice ("select word", "copy that"), select_to, go_next/go_up,
  copy-URL, tab verbs + zoom by key and voice, palette open → voice select,
  "pause video" from another app (media routing), nudge-preview authoring
  from the popup.
- **Machinery gates (flags moved onto PageSession):** hide a tab 30s →
  suspend breadcrumb; reshow → catch-up scan + badges converge; a tab
  loaded in the background activates on first show.
- **Reload survival (standing requirement for ANY background.ts change):**
  reload at chrome://extensions → already-open heavy tabs recover without
  close+reopen, no double-CS, no stuck palette tag.
