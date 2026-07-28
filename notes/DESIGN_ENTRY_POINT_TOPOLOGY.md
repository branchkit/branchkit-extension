# Entry-point topology — what is actually left in `content.ts` and `background.ts`

**Status:** **Phase 1 EXECUTED 2026-07-27** on branch
`refactor/background-message-router` — all CI gates green, NOT merged, NOT
verified in a real browser (see the execution log at the end). Phases 2–4
remain proposals. Follow-on to `notes/DESIGN_RESTRUCTURE_ROUND3.md` (executed
2026-07-24) and `notes/DESIGN_EXTENSION_RESTRUCTURE.md` (the June arc).

**One-line thesis:** the two entry points no longer hold much *logic* — they
hold *topology*. They are the only files that know every other module exists.
That is a different problem from the one rounds 1–3 solved, and re-running
those rounds a fourth time will not touch it.

---

## 1. Current state, measured (2026-07-27)

```
$ node scripts/check-ceilings.mjs
ok: src/content.ts 3611/3700
ok: src/background.ts 1307/1350
```

At the time this note was written `content.ts` sat at **exactly** its ceiling
(3620/3620) and the next line added to it failed CI. That read as the ratchet
working; §4.1 explains why it was the ratchet *mis*-set, and what replaced it.

| | `content.ts` | `background.ts` |
|---|---|---|
| lines (ratchet count) | 3,611 / 3,700 | 1,307 / 1,350 |
| imports | 93 | 28 |
| **exports** | **0** | **0** |
| top-level side effects | ~66 | ~20 |
| unit tests | none | none |

Context for the numbers: the extension is ~50k lines of TS across 16 module
directories, most carrying tests (`activate/` 9.1k, `scan/` 8k, `render/` 7.4k,
`labels/` 6.5k, `observe/` 6.3k, `background/` 4k across 34 files). `content.ts`
is ~7% of the codebase. **These are not un-decomposed monoliths.** They are
residue, and the residue has a specific and consistent shape.

### 1.1 Residue inventory — `content.ts`

| Cluster | Lines | Size |
|---|---|---|
| `chrome.runtime.onMessage` listener, 11 message types | 2361–2836 | ~475 |
| Lifecycle glue — bfcache restore, orphan quiesce, nav rescan, teardown | 1819–2340 | ~520 |
| 42 `dispatcher.register(...)` calls | 1097–1390 | ~300 |
| Callback/init wiring — 17 `init*` / `set*Callback` seams | 490–614, 1297–1546 | ~350 |
| Perf snapshot build / publish / ship | 3430–3619 | ~190 |
| Injection guard, frame gating, settle wiring, residual handlers | scattered | balance |

### 1.2 Residue inventory — `background.ts`

| Cluster | Lines | Size |
|---|---|---|
| **`chrome.runtime.onMessage` listener, 44 message types** | **351–851** | **~500 (38% of the file)** |
| `handleSSEEvent` fan-out | 199–335 | ~136 |
| ~14 top-level `chrome.*` event listeners (tabs, webNavigation, windows, alarms, storage, runtime) | 865–1247 | ~380 |
| `init()` / `reinjectContentScripts()` startup | 1075–1229 | ~150 |

`background.ts` is the easier of the two: **one function is 38% of it.** There
is no comparable single-target win in `content.ts`.

---

## 2. Why the residue regrows (and why round 4 of the same plan would too)

Round 3's post-mortem got the diagnosis right: rounds 1 and 2 failed not by
reversal but by **default landing zone** — new features landed in `content.ts`
because that is where command registration and message routing live. Round 3
answered with a convention plus a ratchet, and the evidence says both worked:
`dispatcher.register` went 54 → 42 in `content.ts` and 0 → 12 in feature
modules, and lifted modules carry tests.

But the convention only redirects *new* code. It does not remove the two
structural reasons the entry points remain the hub, and both of those reasons
are still fully intact:

**(a) Message routing is still centralized by construction.** Both files own a
single giant `if (message.type === …)` chain — 11 branches in `content.ts`, 44
in `background.ts`. A new message type has nowhere else to go. This is a second
dispatcher that never got the dispatcher treatment, sitting right next to a
working dispatcher.

**(b) The callback seams run the wrong way.** `content.ts` has 17 wiring calls
that inject behavior *down into* already-extracted modules:

```
initBadgeVisibility(…)         :490
setFindCallbacks(…)            :509
setScrollBoundaryCallback(…)   :543
initLabelSync(…)               :559
keyHandler.setEscapeHook(…)    :1426
keyHandler.setMatchPredicate(…):1538
keyHandler.setFilterCallback(…):1546
setModeMirrorSink(…) / setInnerTransientProbe(…) / initConnectionMirror(…) / …
```

Each of these means the module was extracted but cannot run without
`content.ts` booting it. The dependency is bidirectional. So **every extraction
adds an `init` line and a `register` line back to the entry point** — lifting a
feature out is close to net-neutral on the line count, which is exactly the
curve rounds 1–3 kept fighting.

This is the part rounds 1–3 never addressed, and it is the whole content of
this proposal.

---

## 3. The plan

Four levers, ordered by leverage-per-risk. Each phase is independently
landable, behavior-equivalent, and ends with a ratchet-down.

### Phase 1 — `background.ts` message router (highest value, lowest risk)

Turn the 44-branch chain at `background.ts:351–851` into a handler table that
modules populate, matching the shape `dispatcher` already has. The 34 modules
in `background/` are the natural owners — `TAB_ACTION`/`ZOOM_ACTION` to
`tab-actions.ts`, `PALETTE_*` to `palette.ts`, `MARK_*` to `marks.ts`,
`*_LABELS` to `labels/label-pool`, and so on. Handlers become exported
functions with real signatures, which means they become testable for the first
time; `background/` modules already have 12 test files to land them beside.

The `sendResponse` / `return true` async contract is the one real hazard — the
table's registration type must encode it so a handler cannot silently drop an
async response. Do this as a mechanical, type-enforced move with no behavior
edits.

*Expected: ~350–450 lines out of `background.ts`. Ratchet 1336 → ~900.*

### Phase 2 — invert the `content.ts` callback seams
**COMPLETE 2026-07-27. DIRECT §6a, STATEFUL §6b, CYCLE §6d.** 18 seams audited,
17 retired or rehomed; the one that remains (`onFindCommitted`) is a deliberate
composition, not an injection — **and after the review that one went too
(`4a53961`), so 18 of 18 are retired or rehomed.** `content.ts` 3610 → 3438,
94 → 90 imports, ceiling 3700 → 3500. Reviewed by five agents 2026-07-27 —
see §6e, which is where the disagreements are.


The structural fix, and the one that changes the growth curve rather than the
current number. For each of the 17 seams, remove the injection by making the
module acquire its dependency directly — an import where the cycle allows, or
a subscription to an existing shared surface (`core/singletons`, `core/store`,
`lifecycle/page-session`) where it does not.

Do this **one seam per commit** with its test. `render/badge-visibility.ts` is
the model to copy: it landed as a real module with its own tests for borrow
semantics and desync-toggle, and it held. The `find` and `label-sync` seams are
the best first candidates — both modules already have substantial test files
(`scan/find.test.ts` 884 lines, `labels/label-sync.test.ts` 614).

Each inversion removes 10–30 lines *and* removes a reason for `content.ts` to
import that module. The import count (93) is the metric to watch here, not the
line count.

*Expected: ~250–350 lines, and 93 imports down toward ~70.*

### Phase 3 — `content.ts` message router + command self-registration
**3a HALF DONE, 3b ALL BUT TWO DONE 2026-07-28, §6g.** The listener is the table
and ten of eleven branches are with their owners. `BRANCHKIT_ACTION` is the last
one: **unblocked and scoped in §6i** — two of its arms stay (they reach the
excluded nav glue), ~200 of 403 lines move. 3b: 41 of 43 registrations moved
(§6g.7); the two left need the same state relocation §6g.4 did, not a binding move.

Same move as phase 1 on the 11-branch listener at `content.ts:2361`, plus
finishing the command-registration convention: 42 `dispatcher.register` calls
still inline versus 12 already lifted. `registerPaletteCommands()` (:1216) and
`registerSelectionCommands()` (:1316) are the working precedent — the pattern
is blessed and proven, it just was not finished. Move them in feature-coherent
groups (scroll, media, find, hint-action), each group with the tests its module
can now support.

*Expected: ~400–500 lines.*

### Phase 4 — lift the perf block
**COMPLETE 2026-07-28, §6g.1.** 197 lines to `debug/perf-snapshot.ts`; ceiling
banked 3500 → 3300.

`buildPerfSnapshot` / `publishPerfSnapshot` / `shipPerfReport` and the report
interval, `content.ts:3430–3619`. Pure aggregation over counters that already
live in `debug/perf-counters`, plus a top-frame-only ship. No reason to sit in
the entry point. Mechanical, and it is the single easiest ~190 lines in either
file — worth doing first if phase 1 stalls and the ceiling needs immediate
headroom.

*Expected: ~190 lines.*

### Target end state

`content.ts` as a boot file in the low hundreds: install the injection guard,
start `pageSession`, call into feature init. `background.ts` similar. Neither
file is the place a new feature *can* land, because neither owns registration
or routing any more.

---

## 4. Exploiting the ratchet deliberately

`RATCHET_SLACK` is 100, and the script fails in both directions. Any phase that
wins more than 100 lines **must** lower the ceiling in the same PR — the win
cannot be quietly refilled later. That is a feature of this plan, not an
obstacle: sequence the phases so each one banks its headroom immediately, and
`monolith-ceilings.json` becomes the running score.

Do **not** raise the ceiling to buy room to work. The last raise
(3620 → 3815, then back down) was correct because it made a real overrun
visible; a raise to create working space would relaunch the exact cycle rounds
1–3 lost three times.

That prohibition is about **why**, not whether. Raising to accommodate code you
are about to write is the cycle. Moving a ceiling onto a legal grid point, or
off the zero-headroom pathology §4.1 describes, is not buying room — it is
placing the marker where a marker is allowed to sit, and the file underneath is
unchanged. `850 → 900` in `479c09f` is the second kind: `background.ts` had
landed exactly on 850, and the fix for that is never to trim the file to fit.

### 4.1 A ceiling is a band marker, not a measurement (2026-07-27)

The rule above is right and was applied too literally in the other direction.
`content.ts`'s ceiling had been tightened to *exactly* its line count, and a
ceiling with zero headroom stops measuring what it was built to measure — it
changes **what** you write rather than **how much**. Two worked examples from a
single session: a refused-key pulse was wired as a direct render call instead of
the house callback seam because the callback needed one line in `content.ts` and
there was none (corrected in `4912f51`), and two comment blocks were trimmed
purely to fit. The same session also over-applied the rule the other way,
lowering 3620 → 3617 after an extraction when the ratchet only compels a lower
at 100+ under. Both mistakes have one root: treating the ceiling as a target.

The slack is **one-directional** and this is the easy misread:

```js
if (lines > ceiling)                        → fail   // grew a monolith
else if (ceiling - lines > RATCHET_SLACK)   → fail   // bank the win
```

The 100 applies only *downward*. The design always intended the ceiling to sit
up to 100 lines above the file; that band **is** the working room.

This could not be fixed by writing the intent down — a ceiling pinned to the
file size and a file grown up to its ceiling are the same two numbers, so no
after-the-fact check can tell them apart. It is enforced by making the bad state
**unexpressible**: `check-ceilings.mjs` requires every ceiling to be a multiple
of `CEILING_GRANULARITY` (50), which is coarser than any single edit. 3620 is
not a ceiling you can write. `background.ts` was normalised 1336 → 1350 to
satisfy it — a one-time loosening of 14 lines, which is the price of the rule.

Deleting the gate was the first instinct and is wrong: `content.ts` has regrown
three times, and this plan uses `monolith-ceilings.json` as its running score,
so deleting it would take the instrument away from the refactor meant to fix it.

*(This decision was first recorded in `DESIGN_HINT_ENGINE.md` §6a, because JSON
cannot hold a comment. It lives here now — this note owns the ratchet, and a
reader of the rule above needs to meet its correction in the same place.)*

The other standing guard is the D2 `store.all` per-file pins in
`scripts/check-exhaustive.mjs`, which force any new sweep to be sanctioned
visibly. Neither guard should be weakened by this work.

---

## 5. What this is NOT

- **Not a file reorganization.** Rounds 1–3 established that reorg alone
  regresses — the structure held every time, and the line count came back
  anyway. Every phase here removes a *reason* for the entry point to be the
  hub. Moving code between files without removing that reason is the failure
  mode, not the plan.
- **Not a behavior change.** Every phase is intended to be behavior-equivalent.
  Anything that changes runtime behavior gets pulled out into its own change
  with its own soak.
- **Not a rewrite of the lifecycle glue.** The ~520 lines of bfcache / orphan
  quiesce / nav rescan in `content.ts:1819–2340` are deliberately excluded.
  That is the highest-blast-radius code in the extension (see
  `notes/DESIGN_TEARDOWN_OWNERSHIP.md`,
  `notes/DESIGN_ORPHAN_CS_TEARDOWN_RETROSPECTIVE.md`), the orphan-teardown arc
  is still soaking, and it should be touched on its own schedule with its own
  soak — never as a line-count play.
- **Not urgent for `background.ts`.** It has 29 lines of headroom and is not
  blocking. It is in this note because phase 1 is the cheapest large win
  available and it de-risks the same move on `content.ts` in phase 3.

---

## 6. Open questions

1. ~~**Handler-table shape.**~~ **RESOLVED — a separate registry, and ONE of
   them for both entry points (§6g.2). The "separate-but-parallel" lean was
   about content-vs-background, and it was wrong: the bundles are separate, so
   one module already gives two tables.**
2. **Frame gating.** Several `content.ts` handlers are top-frame-only
   (`GET_PAGE_STATUS`, `TAB_MARKER`). Does that predicate live in the table as
   registration metadata, or stay inside each handler? Metadata is tidier and
   makes the gate greppable; per-handler is a smaller diff.
3. ~~**Seam inversion vs. import cycles.**~~ **RESOLVED — audited 2026-07-27,
   see §6a. The suspect was wrong and the real obstacle is a different one.**
4. **Do the entry points get tests at the end?** Probably still no, and that is
   acceptable if they shrink to pure boot sequences. The goal was never to test
   `content.ts` — it was to make the code that *was* in `content.ts` testable.

### 6a. Seam audit (2026-07-27) — phase 2 is two jobs, not one

All 18 seams audited against the real import graph. (18, not 17: `4912f51`
added `keyHandler.setRefusedKeyCallback` once the ceiling stopped forbidding
the line.) They split three ways, and the middle group is the finding:

| | count | seams |
|---|---|---|
| **DIRECT** — target imports the dependency, no cycle | 10 | scroll-boundary, onConfirmRejected, connection-mirror, video-key, mode-change, refused-key, site-keys, mode-mirror-sink, match-predicate, filter-callback |
| **CYCLE** — needs a surface or an event | 4 | find-callbacks, leak-sweep, escape-hook, inner-transient-probe |
| **STATEFUL** — closes over `content.ts`-local mutable state | 4 | badge-visibility, label-sync, onRefillLanded, hint-escape |

**The named suspect was wrong.** `keyHandler` ↔ holders is *not* a cycle:
`labels/holder-registry.ts` has **zero relative imports** — a true leaf — so
`setMatchPredicate` and `setFilterCallback` inv­ert cleanly. `activate/keyboard.ts`
is itself a near-leaf (four imports). `render/mode-chip.ts`'s back-edge to it is
`import type { KeyMode }` only, erased at runtime.

**The real cycle is one shape, stated once:** *anything that imports
`core/singletons.ts` cannot be imported by `activate/keyboard.ts`*, because
`singletons.ts` constructs `new KeyHandler(...)`. That set is `palette-host`,
`badge-visibility`, `escape-cascade`, `selection-commands`, `key-preamble`,
`range-disambiguation`, and — added 2026-07-27 — `keymap/site-key-policy`.
That last one is a *pusher* (it calls `setExcluded`/`setPassKeys`), so
`keyboard.ts` has no reason to import it today. But if the key path ever needs
to *consult* per-site policy rather than be told, it must read
`keymap/keyboard-rules.ts`, which is a genuine leaf and does not reach
singletons — never `site-key-policy`. Singletons is the *pull* surface that lets a module
reach `keyHandler` — it is not an escape from the cycle when `keyboard.ts` is
the one that needs to reach out.

**The obstacle the plan missed is STATEFUL, not CYCLE.** Four seams close over
mutable state that lives in `content.ts`: the `SettleEngine` instance
(`content.ts:376`), `pendingHintAction` (:1115), `republishAllGrammar` (:1793),
and `findBorrow` (:503). No import can invert those — **the state has to move
first**, which is ordinary extraction work and should be sequenced ahead of the
inversions that depend on it. Phase 2 was scoped as one job; it is two.

One free win: `initConnectionMirror(() => {})` (:847) passes an **empty
callback**. The seam is dead and the parameter can go.

**DIRECT group EXECUTED 2026-07-27** (branch `refactor/seam-inversion`, four
commits). All ten inverted; `content.ts` 3610 → 3506, 94 → 90 imports, ceiling
3700 → 3600. Two homes emerged, and the split is principled:

- **`core/singletons.ts`** takes the six `keyHandler` seams. Not for
  convenience — `KeyHandler`'s hooks are `null` *by design*, since a null
  `matchPredicate` means "accept every key", which is what lets
  `activate/keyboard.test.ts` drive it without a registry. Defaulting the field
  would silently gate every unset test against an empty one. Singletons already
  constructs the handler and is the surface every module pulls it through.
- **The owning module** takes the rest, defaulting the hook in place and
  keeping the setter as a test seam: `core/modes.ts` (SW mirror transport),
  `activate/scroller.ts` (boundary report), `labels/label-reservoir.ts`
  (rejection → holder registry), `plugin/connection-mirror.ts`.

Two findings worth carrying forward. A defaulted hook exposed
`selection-commands.test.ts` asserting a caret edge sends *nothing* — true only
because no unit test had ever wired the sink, so it could not tell "posted
nothing" from "had no transport"; it now pins MODE_STACK-once-per-edge and
never a `CARET_ACTIVE` post. And the reservoir's default landed **uncovered** —
mutation-testing caught it (deleting `rejectAll` passed all 282 label tests,
because every existing test injects its own handler and pins only the
plumbing). Both are the extraction argument in miniature: the code was equally
untested in `content.ts`, but there was nowhere to put the test.

**Correction — the site-key seam was inverted into a side effect.** The DIRECT
pass put `applySiteKeys()` and `onSiteKeysChanged(...)` at `core/singletons.ts`
*module scope*, so an async `chrome.storage` read and a listener registration
fired at **import** time, in **import** order, across the seven modules that
pull `keyHandler` through singletons. That is not an inversion — it trades an
explicit boot call for an implicit one nobody schedules. (The `void …then()`
also had no `.catch`, so a failed read was an unhandled rejection at boot.)

Fixed with an explicit `installSiteKeyPolicy()` called once from `content.ts`.
**Adding a boot line back to the entry point was correct**: the goal is zero
behaviour *injection*, not zero lines. The distinguishing test for the rest of
this phase — every other hook in `singletons.ts` is a pure function assignment,
no I/O, no listener, no ordering. A seam that needs any of those needs a call
site, and the entry point is where call sites belong.

It landed in a **new `keymap/site-key-policy.ts`**, not in
`keymap/keyboard-rules.ts` as first planned: `popup.ts` and `options.ts` are
separate esbuild bundles that import `keyboard-rules` for their editors, and
reaching `keyHandler` from it would drag the whole content-script singleton
graph into both pages. A module that both a page bundle and the content script
import cannot be the one that touches singletons.

Original expectation, retained for the record: the DIRECT inversions are
unambiguous and land first.
The 4 CYCLE cases are where a small hint-owned surface is legitimately
warranted — this is the place the withdrawn `hints/install.ts` facade was
reaching for, and it is the right size for it *after* the inversions, not
instead of them.

### 6b. STATEFUL group EXECUTED 2026-07-27

All four landed, one seam per commit, `content.ts` 3514 → 3460, ceiling banked
3600 → 3550. Tests 2097 → 2124. Every commit ran tsc, vitest, both ceiling
gates, `npm run build`, and all three harnesses on both engines.

The audit's classification was right about three and instructive about the
fourth, and the recommended ordering — smallest and most independent first,
the one needing a design call last — held.

| seam | landed as | seam retired |
|---|---|---|
| `republishAllGrammar` | moved whole into `labels/label-sync.ts` | `LabelSyncDeps.republishAll` deleted |
| `findBorrow` | `assert/returnBadgeScreenBorrow` in `render/badge-visibility.ts` | none (find's cycle is real — see below) |
| `pendingHintAction` | a `KeyHandler` field | `initBadgeVisibility.resetHintAction`; half of `setHintEscapeCallback` |
| SettleEngine ref | new leaf `lifecycle/settle-engine-ref.ts` | `LabelSyncDeps.reconcile`; `onRefillLanded` wiring |

**`republishAllGrammar` was never stateful.** It is a hoisted function used at
:551 and defined at :1696 — *hoisting*, not state, was what stopped an import
from inverting it. Every collaborator it had already lived in label-sync, so it
moved whole and its seam field was deleted rather than inverted.

**`pageSession.engine` could not be the engine's home,** which the audit
expected it to be. The recorded reason (the `getSessionId` edge) is real but
not sufficient: page-session reaches label-sync a *second* way, through
`core/wrapper-lifecycle`, which imports the put queue structurally. Confirmed
by building the value-import graph and re-running reachability with each edge
dropped. Hence the leaf module — with `pageSession.engine` demoted to an
accessor over it, so there is still exactly one reference. A second copy
assigned beside the first is the two-artifacts-in-sync shape, and 10 read sites
already use the pageSession name — 9 of them without `?.`, which is the actual
argument: rewiring them to the nullable ref would have changed null-handling at
each. (`241fefd`'s message says "14 call sites, 10 non-optionally". That was a
whole-repo `grep -c` that swept in a design note and a code comment. Corrected
here; the decision is unaffected.)

**Mutation-testing earned its keep three times,** and the pattern is worth
naming: *a test that asserts the observable a bug also produces is not a test.*
- The borrow slot's "takes again next session" test passed with the slot
  never cleared, because a spent borrow still reports `took === true`, so the
  re-assert hides either way. Only the second *give-back* distinguishes them.
- `republishAllGrammar`'s `w.scanned.codeword` guard survived deletion, and
  that is the truth rather than a coverage gap — `fireBatchedSync`'s drain
  re-checks it, later, which is the check that matters. Recorded in the code;
  not papered over with a test that would have had to reach into `pendingPuts`.
- §6a's own warning about the reservoir's uncovered default was specific and
  applied directly: `onRefillLanded` had one caller and zero tests. Its tests
  were written and mutation-proven *before* the default existed. Both new
  defaults are covered.

**One real regression, caught by an existing test.** `hideBadges` used to fail
loud on use-before-init only *incidentally* — reaching
`requireHooks().resetHintAction()` was what proved the module was wired.
Retiring that hook removed the guarantee, and the surviving `requireHooks` sits
behind an `if (pendingMutation)`. `clearHintFilter` now asserts it outright.
The general form: **when a hook is retired, check what its call was
incidentally proving.**

### 6c. Four-agent review of the STATEFUL group (2026-07-27)

Four independent read-only reviewers ran against `7f867ce..HEAD`: behaviour
equivalence, boot order, test quality, and a fact-check of the load-bearing
import-graph claims. Two rebuilt the value-import graph from scratch (one via
the TypeScript compiler API, one via esbuild metafiles) rather than trusting
this note. Worth repeating: **the graph verdicts turn on `import type` being
erased**, and one reviewer noted that mis-parsing `page-session.ts`'s
`get engine(): import('./settle-engine').SettleEngine` would have inverted its
answer.

Behaviour equivalence was **not falsifiable** — all five relocations equivalent,
each with the specific fact that makes it so. Every architectural claim in §6b
verified except one arithmetic error (corrected above). No decision undermined.

**Three of the new tests could not fail**, all three mine, all three now fixed:
- The unsubscribe test's mock helper reset the listener array it then checked
  against, so the loop body never ran.
- "is inert when no engine" asserted a freshly constructed timer promise, not
  the code under test.
- The `committed_codewords` guard test passed on a leaked cooldown: that state
  is module-level and vitest reinstalls fake timers at the *real* clock, so a
  predecessor's `advanceTimersByTimeAsync(11_000)` stamps the cooldown into the
  future relative to the next test. `_resetShadowDesyncCooldownForTesting`
  closes it.

The generalisation, third time this arc: **an assertion that holds under both
the correct and the broken implementation is not a test.** Mutation-testing
catches it; reading does not. Two of these had passed a mutation pass — the
mutants chosen were the ones the tests could see.

**One arm has no honest test and is recorded as such.** The reservoir's
"no engine yet -> no-op" default is unobservable: `notifyRefillLanded` is the
last statement inside `refill`'s own `try/catch`, so a thrown non-null
assertion is swallowed with nothing downstream to notice. Any test there passes
either way. The label-sync twin IS testable because `syncNow` does not swallow.
Deleting the fake test beat keeping a green one.

Fixed in the same pass: `republishAllGrammar` gained a `deps` guard (the move
from a module-imported `store` to `deps.store` turned a function that could not
fail into one that throws if ever called before `initLabelSync`); the site-key
catch now also `console.warn`s, because `bkLog` ships over the runtime channel
that an invalidated context — the likeliest cause — has already killed; and a
new test drives a policy from non-empty back to empty, the one regression that
module could plausibly ship and which every prior test in the file missed.

**Pre-existing, surfaced but deliberately NOT fixed here** (each is a behaviour
change, and this phase is behaviour-equivalent by construction):

1. **The badge-screen borrow is not reset on same-document navigation.**
   `closeFindMode` is reachable only from `find_close`, the escape cascade, and
   caret — not from teardown or nav. Concrete: find opens over already-hidden
   badges (`took === false`), SPA nav, user shows badges, find reopens ->
   `assertBadgeScreenBorrow` sees a non-null slot with `took === false` and does
   nothing, so highlights paint under a live badge layer. Same class as the
   2026-07-26 field bug. The borrow now lives next to the code that could tie it
   to a session, which makes this the cheap moment.
2. **`render/palette-host.ts:43/46`** runs `chrome.runtime.getURL` and registers
   a `window` message listener at module scope, unowned by
   `pageSession.resources`, so it survives orphan teardown. It is the LAST
   survivor of the class §6a's correction fixed — the full module-scope
   inventory across all 141 content-bundle modules is otherwise clean.
3. **Nothing enforces that class.** `check-exhaustive.mjs` has no lint for
   module-scope side effects, so the singletons defect would land again
   silently. Cheap sixth lint, and the natural home for it.
4. **`installSiteKeyPolicy`'s unsubscribe is discarded** at its call site, so
   the storage listener outlives orphan quiesce. The old code had no unsubscribe
   at all, so this is not a regression — but the handle now exists and
   `SessionResources` has the slot for it.
5. **Site-key policy is not re-applied on same-document navigation**, and reads
   the *frame's* URL while the popup writes rules from the *tab's* — so a
   path-scoped rule sticks across an SPA route, and "keys off on github.com"
   leaves a third-party subframe fully bound.
6. **Untested wiring** (the modules are covered; the entry-point relay is not):
   the `promoteNewTabIfArmed` -> `activateWrapper` -> `takeHintAction` ordering
   in content.ts, whose reversal silently drops every new-tab promotion; the
   hint-escape callback body; and find's `onActivate`/`onPaintCleared` relay.

### 6d. CYCLE group EXECUTED 2026-07-27 — three of the four were not cycles

Six commits, `d300f58..12b8705`. `content.ts` 3452 → 3437, ceiling banked
3550 → 3500, tests 2124 → 2129. Every commit ran tsc, vitest, both gate
scripts, `npm run build`, and all three harnesses on both engines.

**The headline: §6a's CYCLE classification was wrong for three of the four.**
Each was re-checked against a value-import graph rebuilt from scratch (only
value edges; `import type` and type-position `import('x').Y` erased), and each
verdict below is a measurement, not a reading.

| seam | §6a said | actually | landed as |
|---|---|---|---|
| `initBadgeVisibility` | (survivor, 1 field) | **no path either direction** | retired; module imports `doScan` |
| `setInnerTransientProbe` | CYCLE | **`core/mode-stack` is a leaf** | registrant moves to `escape-cascade` |
| `setEscapeHook` | CYCLE | genuine, but only for `singletons` | registrant moves to `escape-cascade` |
| `installLeakSweep` | CYCLE | **half of it targets a leaf** | `isHeld` defaulted; `onSwept` stays |
| `setFindCallbacks` | CYCLE | one hop, one hex string | split; borrow goes home to find |

**Why the audit missed it, and it is one reason: §6a read each seam's own
comment, and every one of those comments was written by the pass that created
the seam.** `badge-visibility`'s said the scan "is a content.ts-local
orchestration this module has no import path to" — `doScan` is
`scan/scan-orchestrator.ts:69` and there is no path in *either* direction.
§6a even proves the reservoir case wrong in its own text, three paragraphs
before classifying it: `holder-registry` "has **zero relative imports** — a
true leaf", and `label-reservoir` was already importing `rejectAll` from it.
A seam's justification is evidence about what its author believed, not about
the graph.

**Two operations, not one, and they should be named differently.** Ten DIRECT
seams *inverted* (the module acquires its dependency). Two of these instead
changed **registrant** — the line moves verbatim to a module that already holds
both ends. `escape-cascade.ts` took both escape seams because it already
imports `keyHandler` (:48) and owns the one-order claim; `core/singletons`
looks ideal (three keyHandler hooks of exactly this shape already sit there)
and is illegal, because escape-cascade imports *it*.

**`FIND_HIGHLIGHT` was the whole find cycle, confirmed.** One hex string, one
edge. It now lives in `render/find-highlight.ts`, a leaf whose doc forbids it
an import — one would re-create the path it exists to cut. `render/` → `scan/find`
is 0/21 non-test modules (0/33 counting tests).

**The one that stayed, and why it is the most interesting result.** §6a
proposed a find-owned multicast for the surviving find seams, reasoning that
every call is a void notification. True, and not sufficient: the two
`onCommit` effects are **ordered**. Caret's extend calls `scrollFocusIntoView`;
`armSearchBadges` ranks by live viewport geometry and publishes
`in_strict_viewport` from it. A multicast hands that order to module import
order — and because it reconverges at the next scroll settle, a careless
reorder would pass every test and every manual check, and be wrong only until
the user's next scroll. So `onFindCommitted` is one slot, the composition stays
in content.ts, and the ordering is written down at both ends. **The defect
found here was not a seam; it was an undocumented dependency between two
adjacent lines.**

Entry points may **compose** features. What they may not do is **inject**
behaviour a module could acquire itself. That is the line this phase actually
drew, and it is why `installSiteKeyPolicy()` (§6a's correction) and
`onFindCommitted` both legitimately remain.

**Coverage, since three seams had none.** Every moved registration got a test
that can fail, and the technique is worth carrying: where a test file must
*replace* a hook to observe it (`escape-key-path.test.ts` installs a recorder),
it is green whether or not production registers anything — so the fake instead
**captures** the registration. Verified rather than assumed: under three
mutants of the escape hook, `escape-key-path.test.ts` stayed 19/19 green.

Two mechanical traps, both hit:
- `vi.mock` is hoisted by a **static match on that literal**. Aliasing the
  import (`vi as _vi`) silently skips hoisting; the mock never applies and the
  test just reads empty.
- A capture written at **import** time cannot live in a top-level `let` —
  ESM hoists the import above it (TDZ). Sibling recorder arrays only look like
  a precedent: they are written when a test calls in, never at import.

Mutation testing paid again, twice over. It caught that `openFindMode`'s and
`findImmediate`'s badge borrows were **uncovered** — and nearly did not, because
the three take-sites are identical lines and the first mutant removed the wrong
one. It also caught that the reservoir sweep's old `if (!this.isHeld) return`
made "nobody wired a predicate" and "the registry says nobody holds it"
indistinguishable, so every test that skipped `installLeakSweep` was silently
sweep-free.

**Deliberately NOT done: `initLabelSync`.** The prompt's expectation that it was
near-empty is wrong. `detachWrapper` (via `core/wrapper-lifecycle.ts:23`, five
symbols) and `isBadgesVisible` (via `lifecycle/page-session.ts:33`,
`getSessionId`) are genuine value 2-cycles. Only `store` is free, and it is
load-bearing for `label-sync.test.ts`, which injects a fresh `new WrapperStore()`
rather than the singleton. Retiring the rest wants the put queue lifted into a
leaf — which would also cut `wrapper-lifecycle → label-sync` and
`reservoir → label-sync`, the surviving `onLeakSwept` seam's reason. That is the
highest-leverage move left and it is its own piece of work, not a tail.

**Harness note.** `realinput`'s `dictate-announced` failed once ("gs did not
open the phrase box") and then passed six consecutive runs; `ext-dev` was
confirmed stopped. Nothing in these commits reaches the phrase-box open path.
Recorded as a flake to watch rather than explained away.

**Seams left in `content.ts`** (6): `setSettleEngine`, `initLabelSync`,
`onLeakSwept`, `initConnectionMirror`, `setHintEscapeCallback`, `initPoolAudit`
— plus `onFindCommitted`, which is a composition and is meant to be there.

---

**What was left before 6d.** The 4 CYCLE seams, unchanged, plus the tail of the find seam.
`setFindCallbacks` survives with `resetCycleTarget` / `clearSearchBadges` /
`caret` / `armSearchBadges` — `scan/find.ts` cannot import `badge-visibility`,
`search-badges`, or `selection-commands`. Two of those are hard structural
edges; the badge-visibility one is not, and is worth recording: the whole cycle
is a single hop, `render/badge-variant.ts:30` importing `FIND_HIGHLIGHT` from
`scan/find` — **one hex colour string**. Relocating that constant to a leaf
makes `badge-visibility → scan/find` unreachable outright. Cheapest available
move on the CYCLE group and it was verified, not assumed.

### 6e. Five-agent review of the CYCLE group (2026-07-27)

Five independent reviewers against `d300f58..HEAD`: import-graph fact-check,
behaviour equivalence, adversarial test quality (real mutation testing, in an
isolated clone), boot order / module-scope side effects, and the two judgment
calls. Fixes in `74d7f95`.

**The graph work held; the judgment and the tests did not.** That split is the
result worth keeping — the parts I verified mechanically were right, and the
parts I argued in prose were where the errors were.

**One real regression, caught by two reviewers independently.** `9018f6c`
claimed the always-mode residual was "unchanged — a stale slot was never
restored either." **False.** The stale slot survived the nav *with the find
session that owned it still alive*, and that session's ordinary exit restored
it — late, at find close, but it happened. Discarding removed that accidental
recovery and left an always-mode page badge-less after an SPA nav. Fixed by
driving visibility positively on `spa_nav`, which the discard's own doc had
named as the follow-up. **Still open, and pre-existing:**
`cancelRangePick('spa_nav')` eight lines above restores asynchronously, so the
manual-mode hide can read `badgesVisible` before it rises — the exact hazard
`discardBadgeScreenBorrow`'s doc describes, live on a neighbouring line. Needs a
deferred decision, not a reordering.

**§6d's `onCommit` ordering argument is weaker than it reads, and partly
motivated — ACTED ON, `2ad4d01`+`4a53961`: the arm now retries on the settle,
and with the race gone the seam is a multicast registered from the two modules
that own the effects. content.ts holds no find relay at all.** The mechanism is real but the premise is false on the dominant
path: `find.ts` calls `scrollToCurrent()` — a **smooth** scroll — on the line
*before* `onCommit`, so the viewport has not moved when the handler runs, and
`caret.isActive()` is false on most finds anyway. The argument also leads with
`in_strict_viewport`, which the browser plugin's own source says is
**display-only**; the cost that matters is *membership*, and if no match is
within ±1000px of the pre-scroll viewport `RangeBadgeSet.create` returns `null`,
unregisters the holder, and **search badges never appear for that find** — a
live bug on the non-caret path. Reconvergence is ~100 ms after scroll settle,
not "until the user's next scroll". The conclusion (not an anonymous multicast)
survives; the reason given does not carry it. Right fix: arm after find's own
scroll settles and make the `null` case recoverable — after which the two
effects genuinely are independent and the multicast is correct.

**Four tests that could not fail; 78 mutants run, none reused from the commit
messages.** The one that matters: *"discarding never re-shows"* asserted only
`badgesVisible === false`, which a **completely inert** discard also produces —
so the bug the function exists to fix was pinned only on the other path. I had
mutation-tested it, **with mutants I chose**. Also: `openFindMode` has four arms
and two were covered (a mutant left find running with no borrow at all — the
2026-07-26 field-bug class — green); `render/find-highlight.ts`, the module this
arc *added*, had no test; `resetCycleTarget` was relocated with zero coverage.
The find-highlight fix needed two attempts, because `toEqual({tint:
FIND_HIGHLIGHT})` passes against a byte-identical hardcoded duplicate — seeing
the difference takes a `doMock` to a sentinel colour.

**Boot order: all three module-scope registrations SAFE, proven not argued.**
Tarjan over the 141-module closure (two SCCs, neither touching them), confirmed
against the built artifact — `dist/chrome/content.js` is fully flattened, zero
`__esm()` wrappers, so evaluation order *is* source order. Idempotence holds:
module scope and content.ts's top level are the same once-per-evaluation tier,
so a re-inject re-runs all three in a fresh scope.

Three costs none of the seven commits stated:

- **Module evaluation order shifted broadly** (`scan/find` 61 → 106,
  `scan-orchestrator` 127 → 84). Inert — every moved module's top-level
  statements are pure declarations, and every registration still evaluates after
  its registry — but the next edge into that region does not get that for free.
- **The escape pair moved from *after* `installUncaughtCapture` to *before* it.**
  A throw there is no longer captured as `BK_UNCAUGHT`. The one failure mode
  that could occur is now also the one with no telemetry.
- **A latent cliff with no enforcement.** If anything in `core/singletons`'
  closure ever imports `escape-cascade`, the cycle inverts the order and the
  whole content bundle throws at import in every frame (esbuild lowers
  `const`→`var`, so: `Cannot read properties of undefined (reading
  'setEscapeHook')`), and `build.mjs`'s footer only swallows `"duplicate
  injection"`. **There is no import-cycle lint.**

**The module-scope pattern's real price, named.** `escape-cascade` and
`search-badges` are each imported by exactly one module — `content.ts` — for a
value each. If a refactor moves the last value use out, esbuild drops the module
and **the Escape key and the search-badge teardown silently stop working, with
every unit test green** (tests import those modules directly). This applies to
the two pre-existing siblings too, so it is inherited rather than created. The
proposed teeth: a `check-exhaustive.mjs` rule that those modules must remain in
`content.ts`'s value-import closure. That is the enforcement §6a's "seams may
live at module scope" rule never had.

**§6c item 2 is wrong: the module-scope inventory is NOT otherwise clean.**
Besides `palette-host`, at HEAD: `debug/perf-counters.ts:175` writes
`globalThis.__branchkitRecordCpu` — it **crosses bundles** and runs before the
duplicate-injection guard, so a duplicate injection rebinds the global to the
*aborted* bundle's recorder while five live modules read it through
`globalThis`, draining the live instance's CPU accounting into a dead bundle it
also pins. Unlike `palette-host` (inert), this one corrupts the live instance.
Also `debug/dev-keepalive.ts:15` (a 20 s unowned `setInterval`, DCE'd in release
but live in the dev and *harness* builds where orphan retention is measured) and
two module-scope observer allocations.

**Corrections to §6d's own prose:** "badge-variant becomes a true leaf" was true
of the pre-change tree only — as landed it imports `./find-highlight`. `0/22`
render modules is `0/21` non-test. Line counts in §6d and the Phase 2 header
were stale (the note was written at `12b8705`; two commits landed after it).

**Undeclared coupling.** `find` importing the real `badge-visibility` means
`caret.test.ts` and `escape-key-path.test.ts` now execute the real borrow slot
against the real `pageSession` — inert only because their stores are empty.
Raising `badgesVisible` in either produces an unhandled `flushNow` rejection out
of the async `showBadges`. Slot reset added to both; the comments say plainly
that it stops leakage between tests and does *not* make the files safe to
raise the flag in.

### 6f. The review's backlog, worked (2026-07-27)

`a44661a`..`80c6e33`. Everything §6e left open except the one product call.

**Lints F and G** (`scripts/check-exhaustive.mjs`). G is the enforcement §6a's
"a seam may live at module scope" rule never had: five modules install behaviour
purely by being imported, so each must stay in an entry point's value-import
closure or esbuild drops it and the feature silently stops existing with a green
suite. F rejects new import cycles, which here are a boot hazard rather than a
style issue. Both mutation-verified; F's baseline independently matches the SCCs
a reviewer computed via the TypeScript compiler API and esbuild metafiles.

**The search-badge arming bug**, which the review found while checking something
else. A find whose match is far down a long page got NO search badges at all,
permanently — arming happens at commit while find's own SMOOTH scroll is still
in flight, so nothing is within the ±1000px band, `create()` returns null and
unregisters the holder, and no reconcile can reach a set that was never made. It
retries on the scroll settle now. `RangeBadgeSet`'s contract was deliberately
NOT changed: `create() === null` means "nothing to badge" to
range-disambiguation, and one caller's bug is not a reason to change a contract
two callers read.

**`onFindCommitted` is a multicast again** — `12b8705`'s central decision,
reversed. With arming no longer racing a scroll the two effects are independent,
so both register from the modules that own them and **content.ts holds no find
relay at all**. 18 of 18.

**The put queue is a leaf**, and it settled the question §6e expected it to
open. `initLabelSync`'s `detachWrapper` and `isBadgesVisible` invert; `store`
stays, for test isolation rather than a cycle. But `onLeakSwept` now CANNOT go:
retiring the other two pointed label-sync into the lifecycle knot, and
observe/intersection-tracker reaches the reservoir from inside it, so
`reservoir → label-sync` would merge the label layer in — measured, the SCC goes
6 modules → 15. The layering is put-queue < reservoir < the knot < label-sync,
and that seam points UP. Two seams retired at the cost of the third staying is
the trade; lint F now enforces it.

**The nav's async restores.** Both fixed, and the first was an ordering bug in
`9018f6c` itself: `cancelRangePick`'s teardown calls `clearFindPaint`, which
RESTORES the borrow slot, and the discard ran after it. The pick's own borrow
needed an API — `cancelRangePick(reason, restoreBadges)` — with the keyboard
half still restoring, because a nav must not strand the user in a hint mode
entered for chips that no longer exist.

**`recordCpu` is an import.** The globalThis stash was justified as avoiding an
API surface and the graph says it never bought anything (perf-counters' only
import is a type). It bought a cross-bundle write before the injection guard,
which let a duplicate injection redirect the live instance's CPU accounting into
a dead bundle it also pinned in memory.

**Still open.** `closeFindMode()` on `spa_nav` — a product call, not a refactor:
find survives a same-document nav today with a pill advertising a count for a
page whose matches are gone, dead `n`/`N`, and Escape consumed by a dead layer.
Both reviewers argue for closing it; it changes what the user sees, so it waits
for a decision. Also still open: §6c item 3's module-scope side-effect lint,
which is blocked behind `render/palette-host.ts` — orphan-teardown ownership,
one layer at a time.

**The pattern across this whole session, worth carrying.** Four times a test
went in that could not fail, and every one was caught by mutation-testing with
mutants chosen by someone other than the author — including the author's own
re-check. Reading never caught one. The specific shape recurs: asserting an
observable that the BROKEN implementation also produces (a flag that is already
false, a hint mode that is already on, a hex that is coincidentally equal).

### 6g. Phase 4 and half of phase 3a EXECUTED (2026-07-28)

`5345ce3`..`28b97a4`, four commits. `content.ts` 3444 → **3202**, ceiling
3500 → **3300**, 95 → 93 imports, 2147 → **2203** tests. Stopped mid-3a on a
decision that is not mine to make — §6g.5.

#### 6g.1 Phase 4 — the perf block (`5345ce3`)

197 lines to `debug/perf-snapshot.ts`, installed by one call. Mechanical, as
predicted. Two things the plan did not know:

`perf-report.ts`'s header asserted the `buildPerfSnapshot` INTEGRATOR "stays in
content.ts by design (it reads counters from everywhere)". That is backwards —
reading from everywhere is a reason to be a **leaf that imports widely**, not a
reason to sit in the entry point. Nothing imports the new module but
`content.ts`, so its nine imports close no cycle and lint F is unmoved at 2.

**Module evaluation order did not shift at all**, unlike §6e's CYCLE group. The
import goes LAST in `content.ts`'s list, so every dependency was already
evaluated and only the new module itself is new to the order. That is a
generalisable trick, not luck: a leaf appended at the end of the entry point's
imports is order-neutral by construction.

One asymmetry preserved rather than corrected: the main-world reset trigger
resets five counter groups where `branchkitResetPerf` resets six, leaving the
watchdog baseline alone. It predates the lift. Pinned as-is, and named in the
module — a behaviour change belongs in its own commit, not smuggled into a move.

#### 6g.2 Phase 3a — the router is shared, not duplicated (`d91b935`)

Open question 1 leaned "separate-but-parallel" for the content router. **That
was decided without checking whether sharing was safe.** It is, and the reason
is in `build.mjs` rather than in the code: `content.ts` and `background.ts` are
separate esbuild entry points, so each bundle gets its own copy of the
module-level handler table. One module, two instances, no factory and no
instance parameter. `background/message-router.ts` → `core/message-router.ts`,
16 import paths, three `[BranchKit SW]` strings → `[BranchKit]`.

#### 6g.3 Phase 3a — the listener becomes the table (`2b2e68a`)

Ten of eleven branches to their owners; `BRANCHKIT_ACTION` composed inline
pending §6g.5. Two shape calls:

**The orphan guard is not an eleventh handler.** It is a statement about the
CONTEXT ("this elder is torn down"), and it must hold for types the table does
not know — the orphan gauge counts every message a dead context saw, including
unroutable ones. So the router grew `setMessageGuard`, checked above the type
lookup. The SW sets none.

**The frame gates read `window === window.top` at CALL time.** `window.top`
never changes for a frame's lifetime, so it costs nothing, and it is the
difference between a gate that can be tested and one that needs a module reload
to see it. `toast.ts` and `mode-chip.ts` already did it this way; a module-scope
const was the accident.

**Lint E's generalisation is the load-bearing part, and the obvious version is
wrong.** Two entry points means two SEPARATE tables, so registration is checked
against "some entry point" while disjointness is checked WITHIN one.
`MARK_RESTORE` in content's table and `MARK_SET` in the SW's are not competing
for anything; a global disjointness check would invent a constraint the runtime
does not have. All seven arms mutation-verified, including that the cross-table
case is deliberately allowed.

#### 6g.4 Phase 3a — two locals go to their features (`28b97a4`)

`phraseSnapshot` → `activate/snapshot.ts`, `lastActivatedElement` →
`scan/references.ts`. Both are read by `BRANCHKIT_ACTION`, so they had to move
first. `lastActivatedElement()` now returns null for a detached node instead of
handing one back for the caller to check — same behaviour, but a property of the
accessor rather than a convention. The keyboard path, the other writer, never
had that check.

#### 6g.5 STOPPED: `BRANCHKIT_ACTION` cannot leave without a decision

**Superseded by §6i — the decision was made and the split is scoped there.**

403 lines, and it closes over **nine** `content.ts` locals — measured, not
estimated: `DISPATCH_PASSTHROUGH_ACTIONS`, `INPUT_TYPES`,
`preNavObserverTeardown`, `reportNoSuchHint`, `republishForActivation`,
`scheduleHintRefresh`, `sealedDispatchSeen`, `shouldAutoShowBadges`,
`trimFrameUrl`.

Six are ordinary and would move with (or ahead of) the handler. The blocker is
`preNavObserverTeardown` (`content.ts:1888`): the nav-time wedge preempt, which
synchronously unobserves every wrapper before the simulated click triggers a DOM
swap. That is §5's excluded lifecycle glue and the load-bearing wedge fix. So
the handler cannot leave without one of:

1. **Split by dependency, not by feature.** Lift the element verbs, escape,
   selection, noop and the reference actions (~200 lines); leave `activate`
   inline because it is the only arm that touches the band. Honest and
   unblocking, but it draws the module boundary around an import constraint
   rather than around a concern, and phase 3b then inherits that shape.
2. **Reduce to ONE injection.** Move `trimFrameUrl` (a pure string helper that
   merely happens to be declared at :1860), `shouldAutoShowBadges` and
   `scheduleHintRefresh` out, then inject `preNavObserverTeardown` alone. One
   deliberate seam with a stated reason beats nine accidental ones — but phase 2
   spent a whole session retiring exactly this pattern, and re-introducing it
   for the largest handler needs saying out loud.
3. **Wait.** Take the whole handler once the orphan-teardown arc is out of soak
   and the band is touchable.

Also worth noting for whichever wins: `trimFrameUrl` has 15 call sites in
`content.ts` and is not lifecycle glue by nature — it is inside the excluded
LINE RANGE but not inside the excluded CONCERN. Whether §5's exclusion is drawn
on lines or on concerns is the smaller question hiding inside the big one.

#### 6g.6 What the mutation pass caught this time

56 mutants across the four commits, all killed **after three rewrites**. The
recurring shape held, and once again reading caught none of them:

- *"copies rather than aliases the counter objects"* asserted `not.toBe()`
  against a **hand-written duplicate**, which is true of an alias too. It
  mutates the source object after the snapshot now, and that kills all five
  aliasing mutants. This is §6f's third bullet, reproduced exactly.
- The RESOLVE_HINT not-found test passed against a handler that **ignored the
  codeword entirely**, because nothing resolvable was on the page. A resolvable
  wrapper has to be present for a negative to mean anything.
- A `MutationObserver` survives `vi.resetModules()`. A stale observer from an
  earlier test was answering the reset trigger, so the harness-off case looked
  installed and the installed case passed for the wrong reason. Found because
  the harness-off assertion failed — the one test in that file that could not
  be satisfied by leakage.

And one about the tooling rather than the code: **a mutant that does not compile
was being scored as "survived".** `GET_PAGE_STATUS: () => { … }` needs parens
around an object literal; without them the file fails to parse, vitest runs zero
tests, and a runner that counts failures sees none. The runner distinguishes
INVALID from SURVIVED now. Any mutation harness needs that check — "no test
failed" and "no test ran" are the same signal to a naive reader.

#### 6g.7 Phase 3b — SWEEP COMPLETE but for two, and the rule for whether a group gets a module

`df00f0e`..`61f8712`. `content.ts` 3202 → **2977**, ceiling 3300 → **3050**,
43 → **2** inline registrations, 2221 → 2262 tests.

**§6a's worry did not survive contact.** Measured across all 43 bodies: they
close over exactly **two** `content.ts` locals, `activateWrapper` and
`currentKeymap`, one command each. They were not entangled in entry-point state
the way `BRANCHKIT_ACTION` is — they were inline because nobody moved them.
That is what makes 3b independent of §6g.5's blocked decision.

**Whether a group needs its own `*-commands.ts` is a question about the import
graph, and the answer differs per group.** Three cases so far:

- `scroller.ts` imports nothing but a type, which is what lets `scan/find`
  depend on it for the mechanism alone. Registering there would drag the whole
  dispatcher/keyboard/mode-chip closure into everything that wanted to scroll
  an element. **Separate module**, on the §6f layering argument.
- `core/singletons` imports `activate/media`, so registering there would be a
  real cycle — the boot hazard lint F rejects, not a preference. **Separate
  module**, and the stronger reason.
- `scan/find` already reaches `core/singletons` transitively via
  `render/badge-visibility`. Importing the dispatcher closes no cycle and adds
  no closure. **Registration goes in the feature module**, as
  `registerSelectionCommands` always did.

The default is the third. Ask the graph before adding a file.

**Lint G2** (`scripts/check-exhaustive.mjs`, `c45449d`) is G's other half: G
catches a module that stops being IMPORTED, G2 an exported registrar that is
never CALLED. Same silent failure — the command stays in the catalog, its
keybind and voice phrase both resolve, nothing happens, and the registrar's own
tests pass because they call it themselves. Both sides read from the code, so a
new `register*Commands` export joins by existing; it caught `registerFindCommands`
before it was wired. Four arms plus a false-positive guard, mutation-verified.

**Two test findings, both the familiar shape.** Every find match assertion read
zero at first: happy-dom answers `checkVisibility()` falsy and find drops
invisible matches, so the whole group would have passed against a binding that
searched for the wrong string. And *"registers nothing at import time"* — which
scroll and media had and find did not — genuinely survived its mutant until
written. It matters more than it looks: a module that self-registers makes its
registrar decorative and **voids lint G2**, whose premise is that an uncalled
registrar loses its commands.

**Also surfaced, not fixed.** Collapsing ten copies of the cycle-target rule
exposed that the GENERIC `scroll` command does not consult the cycle target at
all, while the ten named ones do. After cycling to a sidebar, "scroll down"
scrolls the sidebar but the parameterised form scrolls the page. Invisible while
the copies were spread over 66 lines. Preserved and pinned by a test that says
why — it changes what a voice command does after a cycle, so it is a product
call.

**Remaining: 2**, and they are the two the opening measurement predicted:
`activate_hint` needs `activateWrapper`, `toggle_help` needs
`currentKeymap`. Those are state relocations of the §6g.4 kind, not binding
moves.

Seven groups, in order: scroll (14), media (7), find (5), nav + keyboard modes
(6, three destinations), tab + zoom (17 behind two loops), hint-action arms (5),
hint mode (2). Ten commits.

**What the hint-action group was kept for last to learn, and did.** They are the
same VERBS `BRANCHKIT_ACTION`'s element-verb arm handles, so §6g.5 option 1
was supposed to be informed by moving them. The answer is that the two paths
barely resemble each other: the keyboard verbs close over **nothing** — each is
`armHintAction(kind)` then `enterHintMode()`, a mode arm and no more — while
the voice verbs resolve a codeword to an element through three tiers and act on
it. Same verb to the user, no shared dependency, no reason for one to wait on
the other.

**And the measurement that actually moves §6g.5:** the element-verb arm does NOT
touch `preNavObserverTeardown`. Only the `activate` arm does. So the blocked
part of `BRANCHKIT_ACTION` is **one arm, not the handler**, and option 1 is
cheaper than it reads.

**Three collapses the moves exposed**, each a rule written out N times where the
copies hid it: the cycle-target delegate (×10), `armHint` (×5), and the
tab-verb forward (×14 behind a loop that already existed). Only the first
changed anything anyone could see — see the scroll asymmetry above.

**"Registers nothing at import time" had to be written three times before it
stopped being missed** (find, focus-input, badge-visibility). It is not
decoration: a module that self-registers makes its registrar decorative and
**voids lint G2**, whose whole premise is that an uncalled registrar loses its
commands.

**The other survivor worth naming**: dropping the `!overlayCodewordsLive()`
half of `hint_mode`'s guard passed every test. Badges-down alone is not the
paint condition, and the second half is a field bug from 2026-07-26
(`/ query Enter f` repainted every link hint over the search results just
asked for). Covered now by registering a real holder above ambient rank, with a
counterpart showing the paint returns when it lets go — "does not paint" alone
would pass against a `hint_mode` that never painted.

#### 6g.8 §7's unverified boundary is closed

§7 recorded after phase 1 that "a green suite here is not a green browser" —
every handler in both tables only ever runs behind `chrome.runtime.onMessage`,
and nothing in tsc, vitest or the build exercises that edge. That gap is now
`npm run harness:messages`: it sends each type from the service worker to a real
tab and reads what comes back. 7/7 through the new content table, including
`BRANCHKIT_ACTION`. Opt-in rather than part of the lifecycle run, so it does not
move that harness's PASS/SKIP baseline.

It counts its own probes, because **the first version reported ALL PROBES PASS
having run none** — it aborted on a bad fixture handle and `[].every()` is true.
A verification script needs the same scepticism as a test: a pass over an empty
list is not a pass.

### 6h. Eight-angle code review of the whole arc, and its fixes (2026-07-28)

`c67adac`..`0d668be`, eight commits. Reviewed `a58e053..HEAD` — phase 4, 3a and
3b together — with eight finder angles and six verifiers. Ten findings survived
verification; all ten are fixed. Three candidates were REFUTED and are recorded
below so they are not re-raised.

**The two that mattered were the ones the refactor itself created, and both were
proven by experiment rather than argued.** Dispersing 44 command registrations
from one contiguous `content.ts` block to eleven modules removed the adjacency
that was holding two invariants:

- `ActionDispatcher.register` was a silent last-write-wins `Map.set`. A reviewer
  inserted one colliding registration and watched **all nine lints, tsc and
  2262 tests stay green** while the primary scroll verb was dead — resolution
  decided by which registrar `content.ts` calls last. It throws now, matching
  the contract `registerMessageHandlers` was given in this same arc.
- `DISPATCH_PASSTHROUGH_ACTIONS` stayed in `content.ts` byte-identical while
  every handler it forwards to left. Lint D reads that set as PROOF an id is
  handled, so the one direction it cannot see is the one the move created.
  Renaming a handler **together with its own test** — what a developer actually
  does — left lint, tsc and the module's tests green while the voice command
  became a `console.warn`.

**A runtime throw is not a substitute for a lint, and finding out why was the
useful part.** No unit test can reach the duplicate throw, because each module's
tests register that module alone; cross-module collision is only observable once
every registrar has run. So lint D2 checks uniqueness statically — including the
three loop-driven tables a regex over `dispatcher.register('…')` cannot see —
and the throw stays as the backstop rather than the discovery mechanism.

**The throw earned itself immediately** by catching something unconsidered: the
`register*Commands` registrars build fresh closures per call, so they are **not
idempotent**, and two test files re-registered per case. That is a real property
of the convention, now documented on the seam and pinned by a test.

**A second `BK_UNCAUGHT` regression, undocumented until the review.** §6e
recorded one uncaught-coverage loss in this arc (the escape pair moving above
`installUncaughtCapture`); routing `content.ts`'s chain through the table
introduced another. The old listener had no try/catch, so a throw in the
~400-line voice dispatch escaped and became a `BK_UNCAUGHT` line carrying the
dispatch's `tr_`. `routeMessage` caught it and only `console.warn`ed — and
`console.*` is kept out of browser.log by design. `reportCaught` goes through
the emitter `uncaught.ts` was installed with rather than importing one, because
the two bundles emit differently (`bkLog` vs `forwardCoalesced`); that
indirection is also what makes the new path share the per-boot cap instead of
opening an uncapped second route.

**Payload types were traded away silently.** The table's value type imposes
`any`, so all eleven handlers read untyped payloads — proven by changing a field
read to `message.lettttters` and watching tsc stay at exit 0. `MessageOf<'X'>`
buys it back without changing the map shape. The failure it closes is not the
typo but a **sender-side rename in types.ts**: tsc updates the sender, accepts
it, and the receiver reads `undefined`. Background's 44 handlers traded the same
checking away before this branch and can adopt `MessageOf` incrementally.

**Two comments of mine were wrong and are corrected in place.** Both entry
points claimed that installing the listener before composing the maps reduces a
duplicate-type throw to "one map" / "one handler is missing". It does not:
`content.ts`'s registrations sit a thousand lines from the end and
`background.ts`'s ~38% in, so a collision also skips the settle wiring, the
pointer and key listeners, the machinery gate, the initial scan, and on the SW
side the tab listeners, `initMedia` and `init()`. Lint E prevents the collision;
the ordering only bounds the damage.

**Lint G2 generalised to `install*` as well as `register*Commands`** — 13
registrars. `installPerfReporting` and `installWindowFocusTracking` were covered
by nothing, and dropping the former stops the dataset mirror four harness
scripts read as a liveness probe. Its one blind spot is written into the lint:
the called-set is a union across entry points, so a registrar belonging to BOTH
and dropped from one still passes. `installUncaughtCapture` is the only such
case; fixing it needs per-registrar metadata, which is the list-to-maintain that
reading both sides from code exists to avoid. Deliberate trade, stated.

**The focus latch guarded listeners that outlive it.** `installed` was module
state, but the listeners are `pageSession.resources`, torn down as a set. After
a teardown a re-install would re-seed and attach nothing, freezing `hasFocus`
while lint E kept `GET_FOCUS_STATUS` answering it — failing by lying rather than
erroring. The latch is gone; re-installing means re-attaching. Note the test I
had written (`'re-seeds without double-registering'`) **pinned the hazard in
place** with a fake registry that never tears down.

**Three findings REFUTED, with evidence — do not re-raise:**

1. `pageSession.engine` being a `!`-assertion over a nullable ref in
   `perf-snapshot.ts`. Unreachable: `setSettleEngine` at `content.ts:439`
   unconditionally precedes `installPerfReporting()` at `:2975` in the same
   module body, and every entry point to `buildPerfSnapshot` is created inside
   the installer. `perf-report.ts:218` has done the identical read since before
   this branch.
2. The ungated `window.branchkitPerfStats` / `branchkitResetPerf` globals as a
   page-readable fingerprint. Wrong: those are **isolated-world** content-script
   globals, which is precisely why the dataset mirror exists as a cross-world
   bridge. The one genuinely page-world global (`__branchkitDebugJSON`) hops via
   `wrappedJSObject` and IS gated.
3. Per-frame registration cost. Unchanged: 56 `dispatcher.register` call sites
   at both `a58e053` and HEAD; the tab/zoom loops were already ungated
   module-scope work. Release `content.js` grew 2,655 bytes (+0.38%) across the
   whole arc, no new esbuild lazy-init wrappers, no bundle cross-contamination.

**What the review says about the arc's method.** The findings that mattered were
structural rather than local — no moved line was wrong, but three invariants
were being held by adjacency and lost it, and two of my own comments asserted a
containment the code did not have. Mutation testing per commit did not catch any
of them, because each change was individually correct; only reading the whole
range against its base surfaced them. That is an argument for reviewing an arc
at its end even when every step was verified.

### 6i. The `BRANCHKIT_ACTION` split — RESOLVED and scoped (2026-07-28)

**EXECUTED — see §6j.** The plan below is what was done; the measurements it
predicted held arm for arm.

**§6g.5's decision is made: the exclusion is drawn on CONCERNS, not line
ranges.** `trimFrameUrl` moves. It sits at `content.ts:1635`, between the
orphan-quiesce and BK_ACTIVATE_PATH sections and therefore inside §5's excluded
*band*, but it is a pure URL-trimming string helper with 15 callers and no
relationship to bfcache, orphan quiesce, nav rescan or teardown. Injecting it
instead would re-introduce the exact seam pattern phase 2 spent a session
retiring, for a function that trims a URL. Ratified by the user 2026-07-28.

**Option 1 is the plan, and it is a cleaner cut than §6g.5 could see.** Every
arm was mapped against the `content.ts` locals it actually uses (script: walk
the handler body, split on `action === …` / `*_ACTIONS.has(action)`, intersect
identifiers with top-level declarations minus imports):

| arm | `content.ts` locals it needs |
|---|---|
| `toggle_hints`, `rescan`, `set_badge_mode` | — |
| `history_back`, `history_forward`, `refresh` | — |
| `noop`, `name_reference` | — |
| `hover_hint` / `focus_hint` / `copytext_hint` / `caret_hint` | `sealedDispatchSeen`, `reportNoSuchHint`, `trimFrameUrl` |
| `escape`, `SELECTION_ACTIONS` | `trimFrameUrl` |
| `resolve_reference` | `INPUT_TYPES` |
| passthrough | `DISPATCH_PASSTHROUGH_ACTIONS` |
| **`reactivate`** | **`republishForActivation`** (:1886, nav-rescan region) |
| **`activate` / `activate_hint_newtab` / `activate_hint_background`** | **`preNavObserverTeardown`** (:1663, the nav wedge preempt) + `trimFrameUrl`, `sealedDispatchSeen`, `reportNoSuchHint`, `shouldAutoShowBadges`, `scheduleHintRefresh`, `INPUT_TYPES` |

**Exactly two arms reach into the excluded concern**, and they are the last two
rows. Everything above them — roughly 200 of the 403 lines — moves with
`trimFrameUrl`, `sealedDispatchSeen`, `reportNoSuchHint` and `INPUT_TYPES`, and
touches no lifecycle glue at all.

So the split is NOT "draw the module boundary around an import constraint",
which is what made option 1 unattractive when it was written. The boundary lands
on a real seam: **resolve-and-act-on-an-element** (movable) versus **navigate
away from this page** (the wedge preempt, the reactivation republish), which is
the orphan-teardown arc's territory and stays until that is out of soak.

**Sequencing when this runs.** Move the four helpers to leaves first, one commit,
so the split itself is a pure relocation — same shape as §6g.4, and it keeps the
diff that touches the voice path as small and readable as possible.

**Verification this needs beyond the usual gates.** realinput drives real keys,
not voice, and `harness:messages` probes exactly one benign voice verb
(`scroll_down`). The moved arms are the element verbs, escape, selection and the
reference actions — none of which any harness currently exercises through
`BRANCHKIT_ACTION`. Extend `scripts/harness/messages/run.mjs` with a probe per
moved arm BEFORE the move, so the harness can prove equivalence rather than
merely fail to notice. `pipelines.ingest_transcript` is NOT an option here: CLAUDE.md
is explicit that actions really execute and it must not be driven from automated
tests.

**Still after this, in order:** the two remaining registrations (`activate_hint`
needs `activateWrapper`, `toggle_help` needs `currentKeymap` — both §6g.4-shaped
state relocations), and phase 1's own residue, `handleSSEEvent` (~136 lines) plus
`storeAlphabet`, which §7 named and which would take `background.ts` under ~700.

### 6j. The split EXECUTED (2026-07-28)

`523d06b`..`23c9500`, three commits, in §6i's mandated order: probes, then
helpers, then the move. `content.ts` 2,985 → **2,772**, ceiling 3,050 → **2,850**,
`harness:messages` 11 → **27** probes. Tests unchanged at 2,278, lints at twelve.

| | lines |
|---|---|
| `activate/voice-dispatch.ts` | 264 (fifteen arms) |
| `activate/sealed-gate.ts` | 71 |
| `core/frame.ts` | 23 → 51 |
| stayed in `content.ts` | `activate` (110) + `reactivate` (2) |

**The plan was right about the shape and wrong about almost nothing** — which
is itself worth recording, because §6a, §6g.5 and §6h each had a
classification overturned by measurement and this one did not. The re-measure
agreed arm for arm: once the four helpers were leaves, `activate` and
`reactivate` were the only arms closing over anything left in the entry point.

#### 6j.1 The probes were the work

Two of three commits went in before a line of the handler moved, and the probe
commit took longer than the split. That ratio is the finding. §6i asked for
"a probe per moved arm"; writing them turned up four defects in the probes
themselves, and **every one was found by a mutant, none by reading**:

- **Two probes asserted the arm's own words and nothing else.** `copytext_hint`
  writes `detail = 'text copied'` from the element's text whether or not the
  copy happened, and `caret_hint` writes `'caret at element'` unconditionally.
  Both probes passed against a mutant that deleted the verb. They read the
  clipboard and the live DOM selection now, and only those halves kill it.
- **The selection pair asserted `ok`, which just mirrors `caret.isActive()`** —
  true for an arm that consults the caret and then applies nothing. It asserts
  the selected TEXT now. The mutant that dropped `caret.applyVoice` survived
  the first version and dies against the second.
- **`SET_BADGES_VISIBLE`'s painted count was filtering on the HOST's computed
  display and read 14 painted badges while all 14 were down.** The badge mirrors
  its own state to `[data-bk-shown]`; the probe reads that.

Seventeen mutants across four builds in the end, one per moved arm plus the
changed probes. All killed, each failure naming the real defect, nothing else
failing with it.

**Escape unwinds a caret in TWO stages, and the first probe could not see it.**
The first escape is an `inner` peel that collapses the visual selection to the
one-character block caret and leaves the entry on the mode stack; the second
peels the entry. Both report as the `selection` layer. The draft probe used a
selection verb that never entered visual mode, so it only ever reached stage
two and would have passed against a cascade with no inner peel at all. The
discriminator that works is the selection LENGTH: an implementation that
skipped the inner stage exits on the first escape, and the second call answers
`nothing to close`.

**A persistent profile makes a harness order-dependent silently.** The
`set_badge_mode` and reference arms WRITE state, and the profile is reused
between runs, so run N+1 started where run N stopped. Reset at startup now.
This is the same class as §6g.8's "reported ALL PROBES PASS having run none":
a verification script needs the scepticism of a test, and its own state is part
of that.

**Probe numbering in the comments is gone rather than renumbered.** It was a
second copy of the order, it had already drifted inside one editing session,
and `EXPECTED` already catches a short run.

#### 6j.2 The move itself was mechanical, and provably so

The moved text is byte-identical to what it replaced modulo indentation —
checked mechanically, 172 non-blank lines in and 172 out, not eyeballed.
`content.ts`'s own diff is **three non-comment lines**: the import, `reactivate`
moved to the head of the chain, and the delegating `else`. The `activate` arm
was not touched at all.

**`DISPATCH_PASSTHROUGH_ACTIONS` moved WITH the forwarder rather than staying.**
§6h found the failure in the mirror image: lint D reads that set as PROOF an id
is handled, so a set in one file and a forwarder in another is the one
direction it cannot see. Adjacency is the fix that finding argues for, and this
split was the chance to take it.

**Lint D hardcoded `content.ts` as where routes live, and failed loudly on 40
ids.** That is the lint working, not an obstacle. It reads a named
`ROUTE_FILES` list now. A list of filenames is normally what this file exists
to avoid, and the reason it is acceptable here is that it cannot go stale
silently in EITHER direction: an arm that moves to a fourth file takes its ids
out of `handled` and every voiced id in it fails with "no extension-side
route"; a file that stops holding the literal fails by name in `setLiteral`.
Both arms mutation-verified.

**§6g.1's import trick held.** All 18 modules `voice-dispatch` imports are
already imported above it in `content.ts` — verified by resolving both import
lists rather than by assuming — so appending it last leaves module evaluation
order unchanged.

#### 6j.3 Two decisions recorded rather than taken

**The three arm selectors are pairwise disjoint, and nothing enforces it.**
Measured: 24 named `action ===` arms, 37 `DISPATCH_PASSTHROUGH_ACTIONS` ids, 10
`SELECTION_ACTIONS` ids, all three intersections empty. That disjointness is
what makes reordering the chain (`reactivate` and `activate*` now checked
first) behaviour-preserving, and it used to be visible as one if/else ladder in
one file. This is the §6h class exactly — an invariant held by adjacency,
losing the adjacency.

Not linted, deliberately, and the argument is:

1. A collision needs TWO deliberate steps, not one slip. Lint D2 requires every
   passthrough id to have a `dispatcher.register` handler, so adding `escape`
   to the passthrough set also means registering an `escape` command.
2. The check needs the BRANCHKIT_ACTION chain's ids specifically, and
   `eqComparisons` over a whole file over-matches: `content.ts` has six
   `action === '…'` comparisons at :1246–:1298 that belong to the KEYBOARD
   hint-action path and a different `action` variable entirely. Scoping the
   check properly means parsing a function body by name, which is more fragile
   than the invariant it would guard. (That over-match is also a pre-existing
   looseness in lint D's `handled` set, named here because it was found here.)

If it is ever taken, the honest version reads the chain's range, not the file.

**The three-tier resolution wiring is now duplicated ACROSS a file boundary.**
The 16-line `resolveTarget(idParam, frameIdParam, codeword, {…})` block plus
the three `parseInt` lines above it are identical in the `activate` arm
(`content.ts`) and the element-verb arm (`voice-dispatch.ts`). The duplication
predates this work — §6g.5 measured it as one of the reasons both arms look
alike — but the split turned "two places in one file" into "two files", which
is worse.

The collapse is obvious (`resolveDispatchTarget(params)` beside
`sealedDispatchSeen`, which the same two call sites already share) and is NOT
in the excluded region: it touches neither `preNavObserverTeardown` nor
`republishForActivation` nor the bfcache/orphan-quiesce/nav-rescan/teardown
band. It is left undone because it edits the `activate` arm, and this arc's
rule is that a behaviour-preserving collapse is its own commit with its own
mutation pass, not a rider on a relocation (§6g.1). It is the obvious next
step and it now has a probe suite waiting for it.

#### 6j.4 What the split bought beyond the line count

`dispatchVoiceAction` is an exported function taking `(action, params)`. Fifteen
arms that were unreachable from a test — the `content.ts is untestable` problem
in its purest form, 0 exports and 66 top-level side effects — are now callable
directly.

**No unit tests were added for them, deliberately.** All fifteen are already
exercised over the real `chrome.runtime.onMessage` boundary by
`harness:messages`, against a real store, real badges and a real DOM. A
happy-dom unit test would assert less about a weaker substrate, and §6g.7's
find-command lesson is standing evidence: every find match assertion in that
group read zero at first because happy-dom answers `checkVisibility()` falsy.
The exportedness is worth having for the day an arm grows logic that deserves a
table test; re-testing what the probes already cover is not.

### 6k. Review of the split, and its fixes (2026-07-28)

`56fc37d`..`a7b5921` reviewed as a range against its base — §6h's method, and
§6h's conclusion is why it happened at all. Six fix commits, `b410ae0`..
`a97054a`. Baselines re-measured before anything: 27/27 probes, realinput 11
both engines, lifecycle 7 PASS / 2 environmental SKIP, twelve lints, 2,278
tests, all matching §6j's claims exactly.

**No moved line was wrong, and the split's own reasoning held.** The
relocation is byte-identical, re-verified mechanically rather than trusted: a
multiset diff of normalised non-blank lines shows that of the 201 removed from
`content.ts`, only six do not recur in `voice-dispatch.ts` — the replaced
comment block, `const` → `export const`, and the `reactivate` arm that stayed.
Disjointness re-measured and holds, including the cross-file pair §6j.3 did not
check. The §6g.1 import trick holds: `voice-dispatch` is import 97 of 98 and
all 18 of its imports resolve above it.

**What the review found is that the verification was one-sided, and the thing
holding it up was held up by nothing.** Every finding is that shape, and every
one was proven by a mutant rather than argued.

**The probes covered every arm that MOVED and neither of the two that stayed.**
§6i asked for "a probe per moved arm" and got exactly that, which left
`activate` and `reactivate` the only `BRANCHKIT_ACTION` arms with no coverage
anywhere — this harness is the only thing in `scripts/` that drives
`BRANCHKIT_ACTION` at all. The controlled experiment: the same one-line mutation
(`resolveFromStore` returning `undefined`) applied to each copy of the
duplicated three-tier wiring. In `voice-dispatch.ts` six probes fail. In
`content.ts` it survives tsc, four lint scripts, 2,278 tests and four
consecutive harness runs. **§6j.3's "it now has a probe suite waiting for it"
was false for the half the queued collapse edits** — that collapse would have
been verified on one side only. Now probed, and the mutant dies naming it.

**The sealed strict gate had no coverage at either call site.** No probe set
`prefix_letter`, the marker that arms it, and there is no `sealed-gate.test.ts`
— so `sealedDispatchSeen` could be replaced wholesale by `return true`,
clicking blind on off-screen, CSS-hidden and occluded targets, with every gate
and all 27 probes green. This is one of the four helpers the arc moved to a
leaf specifically so the split would be a pure relocation; the relocation was
verified textually and the rule inside it was never executed.

Two corrections while writing that probe are the more useful record:

- **A probe over an unresolvable codeword does NOT kill a defeated gate.** It
  refuses through `sealedDispatchSeen`'s not-an-element guard, which the mutant
  leaves intact, so it only ever exercises half the rule. Caught because the
  mutant survived it. A probe that survives its mutant is a hypothesis.
- **Driving the OFF-SCREEN case does not work**: the band re-assigns codewords
  on scroll, so the codeword stops resolving and the refusal comes from the
  not-an-element guard again. Occlusion leaves the target in the band. The
  assertion that makes it airtight is `resolution`: `reportNoSuchHint` echoes
  what it was given, so a gate refusing a RESOLVED element says `live_store`
  where a refusal over nothing says `none`. Asserting it turns a dropped
  wrapper into a loud failure instead of a pass for the wrong reason.

**`harness:messages` ran in no CI job, and three invariants had it as their
sole enforcement.** `ci.yml` runs tsc, the lints and the tests;
`lifecycle-harness.yml` ran only `harness:lifecycle`. So the arm-collision
invariant, the element-verb resolution tiers and the sealed gate were all being
held by a harness someone had to remember to run. Now wired, non-required,
alongside a second finding from reading that gate: **`src/content.ts` was not
in the path filter**, so a change to the bfcache / orphan-quiesce / nav-rescan
region — the lifecycle harness's whole subject and the highest blast-radius
code in the extension — did not run the lifecycle harness. 8 paths → 13, file
renamed `browser-harnesses.yml`.

**Both of §6j.3's self-flags were right to raise and one of its arguments was
wrong.** The disjointness *measurement* is correct. The reasoning for not
linting it — "a collision needs TWO deliberate steps" — is not: adding a named
`action === 'x'` arm to `content.ts` for an id already handled in
`voice-dispatch.ts` is ONE edit, lint D's `handled` is a union across route
files so it structurally cannot see a duplicate, and unlike
`dispatcher.register` there is no runtime throw. Mutation-verified: tsc, both
lint scripts and 2,278 tests stayed green, two probes caught it. So the
invariant is enforced — by the harness, which is why the CI wiring is the
load-bearing fix and not the probes.

**Lint D's over-match was real, exploitable, and there were two of it.** The
second was found by mutating the fix for the first, which is the part worth
keeping. A voiced catalog entry `{ id: 'hover' }` with no route anywhere passed
as "all 77 voiced catalog actions handled", because `activateWrapper`'s six
keyboard hint comparisons sat on a local that happened to also be called
`action`; defeating just one made it fail correctly. Those six are the
shortened forms of `hover_hint`/`focus_hint`/`caret_hint`/`copytext_hint` —
exactly what someone shortening a voice id reaches for. Then, with a third
demand source added for the extension's own dispatches, dropping the `rescan`
arm *still* passed: `background.ts`'s `data.action === 'rescan' || …` is a
DELIVERY decision (broadcast vs active tab) and both ids fall through to the
content script, yet lint D read the comparison as a route.

Both closed by **changing the shape, not the parser** — `hintAction` and a
named `BROADCAST_ACTIONS` set. §6j.3 was right that scoping the check properly
means parsing a function body and that this is more fragile than the invariant
it guards; it was wrong that this left nothing to do. The collision is between
two variables sharing a NAME, so renaming one removes it with no parser at all
and the regex stays as dumb as it was. (That over-match is also why §6j.3
counts 24 named arms; the chain has 18.)

**Lint D was missing a whole class of demand.** It asked about voiced catalog
ids and plugin-initiated ones; the extension's OWN dispatches — `BRANCHKIT_ACTION`
messages the SW builds with a literal id — belonged to neither. `rescan` and
`reactivate` live there, and deleting the `rescan` arm outright passed tsc,
both lint scripts and 2,278 tests. Read from source via `srcFiles()` rather
than listed, with its blind spot written in (`background/media.ts` builds its
payload from a variable, so its two ids are invisible; both handled today).

**Two harness defects that had nothing to do with the split.** The
`PALETTE_COMMAND` probe's wait, added in `43d8703` to fix a fixed-delay flake,
swallowed its own timeout (`.catch(() => {})`) — so a scroll that never landed
fell through and failed the assertion, reporting a HARNESS precondition failure
as a DISPATCHER failure. Seen three times in twelve runs. The misattribution is
fixed and certain; the underlying intermittent is not, and is labelled so, with
the one lead worth having: five seconds after a *successful* `scrollTo(0, 400)`
the page reads 82, so the passing path passes only because it reads the instant
`scrollY` crosses 380. And the `toggle_hints` probe asserted `toggleHints()`'s
own return value — §6j.1's disease exactly, one probe further down the file
than it looked. Inverting the snapshot to the HIDE edge passed it, lint C's
newly-added pin, tsc and 2,278 tests. The TTL is the discriminator, and the two
guards compose: deleting the sweep trips lint C's count, moving it to the wrong
edge trips the probe.

**Three findings REFUTED, with evidence — do not re-raise:**

1. **The `tr_` no longer joins across the module boundary.** Measured, not
   argued: a `bkLog` injected as the first statement of `dispatchVoiceAction`
   emitted `{"tag":"probe.corr_scope","data":{"arm":"rescan","correlationId":"tr_probe"}}`.
   `currentCorrelation` is module state in one bundle instance and the call is
   synchronous. Now pinned by a probe, with its blind spot written in: it rides
   `reactivate`, so it would stay green if `dispatchVoiceAction` ever went
   async. Closing that needs a `bkLog` reachable synchronously from a moved arm
   and none of the fifteen has one — checked, not assumed.
2. **The move silently changed a line.** It did not; see the multiset diff
   above. §6j.2's "172 in / 172 out" counts the handler body only.
3. **Module evaluation order changed.** The `voice-dispatch` claim is exact.
   But the arc's reasoning covered only one of the two new edges: `sealed-gate`
   was inserted at import 34, pulling `render/toast` (was 43), `plugin/resolve`
   (was 73) and `core/frame` (was 35) earlier. Checked both — `toast.ts` is four
   consts and a template string at module scope, `plugin/resolve.ts` one
   exported object literal. Inert, so benign. Recorded because it was unchecked,
   not because it bit.

**Cost.** `content.ts` 2,773 → 2,783 and `background.ts` 854 → 869, both from
the comments that make the two renames load-bearing. Growing the monolith in an
arc dedicated to shrinking it is worth stating plainly; §4.1's rule is that a
ceiling must not change *what* you write, and a rename whose whole failure mode
is that reverting it looks harmless has to carry its reason. Ceilings unchanged.

**What this review says about the method.** §6h found that reviewing an arc at
its end catches what per-commit mutation testing cannot, because each change is
individually correct. This one says something narrower and sharper: **every
finding here is about the verification, not the code.** The split was right,
the probes written for it were good, and the arc still shipped a gate with no
executable coverage, a probe suite that stopped at the file boundary, and a
harness that no CI job ran. Mutation testing per commit would not have found any
of it — the mutants that mattered had to be aimed at code the commits did not
touch. The generalisable move was mutating the FIX and not just the finding:
that is what turned up the second lint-D shadow and the fact that the first
sealed-gate probe could not kill its own mutant.

**Still queued, and now actually unblocked:** the duplicated `resolveTarget`
wiring (§6j.3), which has real coverage on both sides for the first time — done
in §6l; then `activate_hint`/`toggle_help`'s registrations; then
`handleSSEEvent` + `storeAlphabet`.

### 6l. The `resolveTarget` collapse (2026-07-28)

`dc110ff`. The 18-line binding that hands the live page to `resolveTarget` was
written out twice, byte-identical; it is now `activate/dispatch-target.ts` and
both call sites read two lines.

**The mutation pass is the whole argument.** Before §6k's probes, the same
one-line mutation (`resolveFromStore` returning `undefined`) killed six probes
in `voice-dispatch.ts` and *nothing* in `content.ts`. It now fails **nine**
probes across both arms from one edit. That is the difference between a shared
implementation and two copies that happen to agree, and it is why the probe
commit had to come first.

**Placed against §6j.3's suggestion, for a reason worth keeping.** Not
`activate-resolution.ts` — it imports three types and nothing else, which is
exactly what lets its algorithm carry a 344-line unit test, and binding five
live singletons into it would trade that for adjacency. Not `sealed-gate.ts`
either: that module is one rule in two halves and its coherence is the point.

**Three things the plan did not predict, all caught by tooling rather than
reading:**

- `tsc` found the one coupling the diff could not show: `idParam` feeds three
  `emitActivatePath` emits further down the activate arm. Diagnostics, not
  resolution, so it did not widen the change — but it is *returned* from the
  helper rather than re-parsed, because a second
  `parseInt(params?.id ?? '0', 10)` carrying the same magic default is the
  drift this commit exists to remove.
- Placed where `activate-resolution`'s import sat (index 11), it **hoisted
  `lifecycle/page-session` from 74 and `core/store` from 20** — both construct
  a singleton at module scope. Moved last (§6g.1's trick) and re-verified with
  §6k's own script rather than reasoned about. This is the third time in this
  arc that a new module edge moved evaluation order and the second time it was
  only noticed by running the check.
- **`capturePhraseSnapshot` had been a dead import in `content.ts` since
  `23c9500`** — 2 uses before the split, 1 (the import line) after.
  `noUnusedLocals` is `false`, so nothing caught it for five commits. Removed
  with two more in `voice-dispatch.ts`. It qualifies §6j.2's "content.ts's own
  diff is three non-comment lines", and it is the second time in two sessions
  that a checker's blind spot mattered more than the code did. **Turning
  `noUnusedLocals` on is its own commit and may surface a pile — open.**

**Deliberately untouched:** the holder consult. `content.ts`'s arm asks
`resolveCodewordAboveAmbient` about range picks and search badges before
reaching the collapsed block; the element verbs do not. Pre-existing, adjacent
to the moved lines, and folding it in would be a behaviour change wearing a
refactor's clothes.

`content.ts` 2,783 → 2,768, ceilings unchanged (82 under is inside the band,
and §4.1's correction is that over-applying the lower is its own mistake).

---

## 7. Execution log — phase 1, 2026-07-27

Branch `refactor/background-message-router`, seven commits, done in an isolated
worktree because another session was live in the main checkout at the time
(17 dirty files, including `content.ts`). **That is also why only phase 1 ran:
phases 2, 3 and 4 all edit `content.ts`, and racing a live agent on a
3,600-line untested file is how one of the two sessions loses its work.**

### What landed

| | before | after |
|---|---|---|
| `background.ts` | 1,307 | **838** |
| ceiling | 1,336 | **850** |
| onMessage listener | 44 branches, ~500 lines | `addListener(routeMessage)` |
| tests | 2,005 | **2,042** (+37 across 5 new files) |

The response contract moved into the router: a handler returns `undefined`
(fire-and-forget), a value (sync response), or a promise (async response), and
the router derives Chrome's keep-the-channel-open boolean once, under test.
`return true` is no longer written by hand anywhere.

Modules export handler maps rather than self-registering, so they stay
side-effect-free and unit-testable; `background.ts` composes them and nothing
else. New: `message-router.ts`, `command-overrides.ts`, `voice-status.ts`,
`label-messages.ts`, `plugin-messages.ts`. Existing modules (palette, marks,
tab-actions, tab-markers, media, mode-mirror, references, frame-router,
frame-liveness, debug-snapshot, log-coalesce) grew a handler map each.

**Verified none of the 44 types was lost or invented** — the union of
handler-map keys is exactly the original set.

### Two bugs the move surfaced

- `GRAMMAR_BATCH` had `.then(sendResponse)` with **no catch**, so a failed
  grammar post left the content script awaiting forever. The router closes the
  channel on a rejected handler, so a failed scan now fails fast.
- Nine branches carried their guard in the `if` (`&& Array.isArray(...)`), so a
  malformed payload fell silently through 500 lines to the bottom. Those guards
  are now early returns inside the handler they belong to.

### Lint E, and why it exists

`scripts/check-exhaustive.mjs` gained a fifth lint: every exported
`*MessageHandlers` map must be registered, and the listener must be
`routeMessage` outright. Both sides are read from the code, so there is no list
to keep in sync. Both arms are mutation-verified.

This is the part aimed at the failure mode rounds 1–3 died of. An unregistered
map drops its message types exactly as silently as the if-chain did, and a
reintroduced inline branch would otherwise coexist with the table quietly
forever. Now both fail the build.

### NOT verified — read this before merging

**No real-browser verification was done.** A green suite here is not a green
browser: these handlers only ever run behind `chrome.runtime.onMessage`, and
nothing in tsc, vitest, or the build exercises that boundary. The unit tests
call handlers directly.

The specific risk is the async contract. A handler that should return a promise
but returns undefined closes the channel early, and the symptom is a content
script awaiting a response that never comes — silent, and probably intermittent.

Smoke checks that would exercise the paths with the most surface, roughly in
value order:

1. **Hints paint and are voice-matchable** — covers `CLAIM_LABELS`,
   `CONFIRM_LABELS`, `GRAMMAR_BATCH`, the three highest-traffic async handlers.
2. **Palette opens, filters, and picks** — covers `PALETTE_BOOTSTRAP`, the one
   handler wrapped in a callback→promise adapter.
3. **Popup shows connected state; the pause toggle round-trips** — covers
   `GET_HEALTH` / `SET_VOICE_PAUSED`, the sync-vs-async pair.
4. **Set and jump a global mark across tabs** — `MARK_SET` / `MARK_JUMP`.
5. **The keymap editor lists and saves a voice phrase override** — the six
   command-override handlers, the group with the most translation logic.
6. **A tab marker appears on load** — `GET_TAB_MARKER`.

Also unaddressed: `background.ts` still holds `handleSSEEvent` (~136 lines) and
`storeAlphabet`, so `SSE_EVENT`, `ALPHABET` and `DEV_PING` register from the
entry point rather than a module. That is the honest residue and the obvious
next lift — it would take the file under ~700.

---

## 8. Sequencing note

Phase 4 is trivially separable and could land first purely to buy ceiling
headroom (`content.ts` currently has none, which will start blocking unrelated
work). Phase 1 is the largest win and is fully independent of the others.
Phases 2 and 3 both touch `content.ts` and should not be interleaved with each
other.
