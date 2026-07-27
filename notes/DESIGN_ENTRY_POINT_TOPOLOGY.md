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
ok: src/content.ts 3620/3620
ok: src/background.ts 1307/1336
```

`content.ts` is **exactly at its ceiling**. The next line added to it fails CI.
That is the ratchet working as designed, and it is also the reason this note
exists now rather than after the next regrowth cycle.

| | `content.ts` | `background.ts` |
|---|---|---|
| lines (ratchet count) | 3,620 / 3,620 | 1,307 / 1,336 |
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
3. **Seam inversion vs. import cycles.** Some of the 17 seams likely exist
   precisely to break a cycle (`keyHandler` ↔ holders is the suspect). Those
   may need a shared registry rather than a direct import. Worth auditing all
   17 up front and splitting the list into "direct import" and "needs a
   surface" before starting phase 2.
4. **Do the entry points get tests at the end?** Probably still no, and that is
   acceptable if they shrink to pure boot sequences. The goal was never to test
   `content.ts` — it was to make the code that *was* in `content.ts` testable.

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
