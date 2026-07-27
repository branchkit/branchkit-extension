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
**DIRECT and STATEFUL groups executed 2026-07-27 — see §6a and §6b. CYCLE group
(4 seams) outstanding.**


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

Same move as phase 1 on the 11-branch listener at `content.ts:2361`, plus
finishing the command-registration convention: 42 `dispatcher.register` calls
still inline versus 12 already lifted. `registerPaletteCommands()` (:1216) and
`registerSelectionCommands()` (:1316) are the working precedent — the pattern
is blessed and proven, it just was not finished. Move them in feature-coherent
groups (scroll, media, find, hint-action), each group with the tests its module
can now support.

*Expected: ~400–500 lines.*

### Phase 4 — lift the perf block

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

1. **Handler-table shape.** Reuse `core/dispatcher` for messages, or a separate
   thinner registry? Messages have a `sendResponse` + `return true` async
   contract that dispatcher actions do not. Leaning separate-but-parallel, so
   neither surface grows the other's concerns.
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

**What is left.** The 4 CYCLE seams, unchanged, plus the tail of the find seam.
`setFindCallbacks` survives with `resetCycleTarget` / `clearSearchBadges` /
`caret` / `armSearchBadges` — `scan/find.ts` cannot import `badge-visibility`,
`search-badges`, or `selection-commands`. Two of those are hard structural
edges; the badge-visibility one is not, and is worth recording: the whole cycle
is a single hop, `render/badge-variant.ts:30` importing `FIND_HIGHLIGHT` from
`scan/find` — **one hex colour string**. Relocating that constant to a leaf
makes `badge-visibility → scan/find` unreachable outright. Cheapest available
move on the CYCLE group and it was verified, not assumed.

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
