# Plan: mode stack + holder registry implementation

**Design:** `notes/DESIGN_MODE_STACK_AND_CODEWORD_HOLDERS.md`
**Status:** Wave 1 LANDED + committed 2026-07-26 (ext `3b37642`, browser
`64f55cc`, app `90d3bbb`; not pushed). Wave 2 design pass done 2026-07-26 —
the design doc's three open questions are resolved and it now carries the
testing strategy this plan's Wave 2 builds against. Wave 2 LANDED 2026-07-26
(`40c946f`..`171163d`). Wave 3 C1 LANDED 2026-07-26: every sweep is
registry-derived, `codeword-routing.ts` + `codeword-holders.ts` (v1) deleted,
`StoreCodewordHooks` retired per the wave checkpoint; C1b (teardown fan-out
on the orphan path) is the next, separate commit. One C1 deviation from the
design's sketch: the spoken activate path consults
`resolveCodewordAboveAmbient` — the registry loop cut at the declared ambient
rank — instead of the full `resolveCodeword`, because its element leg
(snapshot-first resolution, sealed strict gate, tab-target variants,
dispatch reporting) is the ambient store's answer for that input and cannot
ride a `(codeword) -> outcome` hook; the typed path uses the full loop, with
the store's sole-completion bookkeeping folded into its activate delegate.
Wave 3 C2 LANDED 2026-07-26, with one deliberate resequencing forced by the
gate itself: escape-key-path.test.ts must stay green UNMODIFIED through C2,
and its harness mocks range-disambiguation + selection-commands at module
level — so the cascade's DECIDER cannot consult the stack until C3 converts
that harness (which the gate rule permits only mechanically, at C3). C2
therefore lands the stack as the writer-side spine: every mode's one
entry/exit implementation pushes/pops the production singleton
(core/modes.ts) in lockstep with the flag it still sets — hint/video in
KeyHandler, caret on the selection-commands active edge, find at session
begin/end, range_pick at arm/teardown/onEmpty, palette at open/close — the
real peelInner probes are installed (hint's typed prefix via
KeyHandler.peelHintPrefix; caret's staged unwind via CaretController.
peelInner, which escape() now routes through, one implementation), and
peelTop's behavior — inner-before-mode, temporal order on the reachable
find-then-video stacking — is proven by new tests against real module state.
The cascade flips to peelTop in C3, when the flags die and the gate's
harness converts.

Wave 3 C3 is landing in three green commits, per the design's own risk note
("land the stack driving the existing flags first, verify, then delete the
flags in a separate commit"): **C3a (LANDED 2026-07-26)** — the cascade's
decider IS peelTop: runEscapeCascade derives the order from the stack (last
pushed first peeled, peelInner transients first) and keeps only the per-mode
exit effects (cancelRangePick / escapeHintMode / caret.exit /
exitVideoMode / closeFindMode — each one's internal pop of the entry peelTop
already took is a no-op). The gate's harness converted mechanically
(armPick/armCaret push the entries the way production arms them — a pick
re-enters hint mode then pushes itself, so it is newest BY CONSTRUCTION and
the "outranks everything" row holds under temporal order; assertions
untouched). The palette spec became peelable:false for this page-side stack
with the reason recorded (its iframe owns focus; blur closes it; the spoken
exit is the plugin's external tag clear, C4's mirror). One reporting delta,
deliberate: a find opened DURING a caret session is its own entry above
caret, so escape now peels and reports it as 'find' (same thing closed;
caret's staged 'caret_find' peelInner stage is unreachable from peelTop and
dies in C3b). **C3b (LANDED 2026-07-26)** — findFloor replaced by
sessionOwnsFind (stack-order derivation: a find entry above caret was opened
mid-session, so exit still closes the session's own find and leaves the
user's); caret.escape() deleted (the cascade owns the composition; tests use
escapeStep = peelInner-else-exit with production-shaped push/pop
controllers); PickEntryState/pickWindowHooks/entryOnEmpty retired — the
screen borrow/restore lives in range-disambiguation, its snapshot riding the
range_pick entry's floor payload, reaching the badge layer through
pageSession.deps (hideBadges joined showBadges) and the keyboard through the
singleton; the snapshot uses isHintMode(), closing the getMode()-ranked
known gap. **C3c (LANDED 2026-07-26)** — keyboard.ts's `mode`/`caretMode`/`videoMode`
fields are gone: routing walks the stack newest-first to the topmost
bare-keys entry (a capture:'none' find or palette above is stepped past; a
range pick routes to the hint machinery it entered with), getMode()'s
precedence ladder derives from the stack (mark arm and forced-insert/
exclusion stay keyboard transients), isModalCapture/isHintMode/isVideoMode
are stack reads, and the caret lifetime pushes/pops inside
enterCaretMode/exitCaretMode — the one keyboard-side entry per mode, uniform
with hint and video, with `caretSub` kept as the chip's display detail only
(nothing routes or gates on it). The gate file needed NO edits for this
slice. C3 is complete; C4 (SW mirror) and C5 (collector) remain.
**Repos touched:** `branchkit-extension` (bulk), `plugins/browser` (tag mirror),
`app` (pin bumps only).

## Sequencing principle

**File contention, not logical dependency, is the binding constraint.** The
findings are mostly independent of each other but `src/content.ts` is touched by
half of them, and `src/activate/escape-cascade.ts` and `src/scan/find.ts` are
each touched by two. Parallelism therefore has to be organised by *file
ownership*, not by finding.

Each parallel agent gets a **git worktree** and an exclusive file list. An
integrator merges. Where two findings share a file, they are given to the same
agent rather than split.

## Wave ordering, and why bugs come before primitives

Wave 1 fixes the ranked bugs against the current architecture. That looks
backwards — the primitives delete most of this code — but:

1. The bugs are live now and the refactor is not a weekend.
2. **Each fix's test is the regression gate the refactor must keep passing.**
   The tests survive even where the code doesn't. Landing them first converts
   "did the refactor preserve behaviour" from a judgement call into a red/green.
3. The Wave 1 work is where the remaining uncertainty is. Several findings were
   read, not run. A wave that has to reproduce each one is the cheapest way to
   find out which are wrong.

---

## Wave 1 — the ranked bugs (6 agents, parallel, worktrees)

Each agent: reproduce → fix → regression test → `just test` + targeted vitest
green. No agent commits; the integrator does, after the merge.

### A1 — plugin-side tags (`plugins/browser`, own repo, zero extension overlap)

Files: `src/caret.go`, `src/find.go`, `src/palette.go`, `src/video.go`,
`src/collections.go`, `src/*_test.go`.

- Issue the tag `Delete` **before** clearing local `TagSet` bookkeeping, in all
  four sync functions. `hint_gate.go:96-104` is the model and carries the
  rationale; copy the reasoning, not just the shape.
- Add the video mode tag to `reconcileExternalTagClears` so the platform's
  global "over" forwards an exit imperative. Needs a corresponding extension
  action (coordinate with A2 on the action name — propose `video_exit`).
- Accept a caret `{active:true}` claim from any frame of the focused connection,
  not just the top frame (pairs with A6). Keep the "exit is honoured from any
  connection" rule.

Acceptance: a table test asserting that a failing Delete leaves `TagSet` true so
the next drain retries; a test that an external clear of `video_mode` forwards.

### A2 — escape ordering (`escape-cascade.ts`, `keyboard.ts`, and the ~15-line keydown preamble in `content.ts`)

Files: `src/activate/escape-cascade.ts`, `src/activate/keyboard.ts`,
`src/activate/escape-cascade.test.ts`, `src/activate/keyboard.test.ts`, and
**only** `content.ts` lines ~3117-3140 (declared region — A6 owns the rest).

- Add the video layer to the cascade; wire `keyHandler.exitVideoMode` behind it.
- Switch the find layer's predicate from `isFindBarOpen()` to `isFindActive()`
  so a committed pill is peelable by voice.
- Move the committed-find Escape out of `handleFindNavKey` and into the cascade,
  so the key stops peeling find ahead of hint mode. `n`/`N` stay where they are.

Acceptance: **a test that drives the real key path** — construct a
`KeyboardEvent`, dispatch it at the listener content installs, and assert the
peeled layer. The existing `escape-cascade.test.ts` calls `runEscapeCascade`
directly and therefore cannot observe the divergence its own header claims to
guard. This test is the point of the agent; the fixes are secondary.

### A3 — caret exit (`caret.ts`)

Files: `src/activate/caret.ts`, `src/activate/caret.test.ts`.

- `exit()` must not `closeFindMode()` on a find session it did not create.
  Record a find floor at entry (interim; the stack deletes it in Wave 3).
- `escape()`'s "search always sits above visual" assumption is false for the
  `enterFromFind` flow. Peel by which layer is newer, not by a fixed rank.

Acceptance: `/quick` Enter → `v` → `y` leaves the find session intact (pill,
highlights, `FIND_ACTIVE`). Regression test asserts the tag post is not emitted.

### A4 — the find box (`find.ts`)

Files: `src/scan/find.ts`, `src/scan/find.test.ts`.

- `findImmediate` sets `state.mode = 'find'`; `endSession` resets it.
- `findImmediate` fires `onCommit` only in `find` mode.
- 229 / `isComposing` guard in `handleFindBarKey`.
- `autocorrect`/`autocapitalize`/`spellcheck` off on the input, and re-examine
  whether `insertReplacementText` should still count as dictation once
  autocorrect is disabled.
- Close on blur, matching the palette's load-bearing behaviour.

Acceptance: a test that a `highlight` session followed by a voice find paints
`HL_ALL`/`HL_CURRENT`, not `HL_PHRASE`. A test that an autocorrect-shaped
`insertReplacementText` does not auto-commit.

### A5 — pool accounting (`scan-orchestrator.ts`, `range-badge-set.ts`)

Files: `src/scan/scan-orchestrator.ts`, `src/render/range-badge-set.ts`,
their tests.

- The delete guard at `scan-orchestrator.ts:413` asks `store.all.some(...)`;
  it must ask the same compound question `content.ts:564` asks —
  `store.byCodeword(cw) !== undefined || heldOutsideStore(cw)`.
- Resolve the speakable-vs-usable contradiction in `RangeBadgeSet.add`: the
  no-alphabet branch keeps badges on the grounds that admission only governs
  speech, and fifteen lines later a per-codeword rejection removes the badge.
  Decide which is right per rejection *reason* (cross-document collision →
  remove; local pool race → keep, retry) and make the comment match.

Acceptance: a test that a codeword recycled from a `RangeBadgeSet` release into
a fresh claim is not queued for delete.

### A6 — content wiring (`content.ts` and the two modules it injects into)

Files: `src/content.ts` (except A2's declared region),
`src/activate/selection-commands.ts`, `src/activate/range-disambiguation.ts`,
`src/activate/search-badges.ts`.

- Drop the `isTopFrame` guard on the `CARET_ACTIVE` post so a subframe caret
  session sets the tag (pairs with A1). Keep the edge dedupe per frame.
- Record and restore the keyboard mode across a pick window, alongside the
  existing `restoreBadges` (interim; the stack deletes it in Wave 3).
- Call `clearSearchBadges` wherever `cancelRangePick` is called —
  `content.ts:2159` (orphan teardown) and `:2296` (SPA nav).
- Drive `reconcileRangePickChips` / `reconcileSearchBadges` from every settle
  kind, not only `afterScrollSettle`.
- Route the spoken codeword path (`content.ts:2602`) and the spoken prefix path
  (`:2899`) through `codeword-routing.ts`. Keep the dispatch reporting at the
  call site; move only the ordering. The `showBadges()` divergence goes away as
  a consequence — confirm that is wanted before removing it.

Acceptance: a test that speaking a search-badge prefix during a find session
does not re-show the page's link hints.

### Integration

One integrator agent merges the six worktrees in the order A1, A5, A3, A4, A2,
A6 (least-contended first), runs `just build --full`, `just test`,
`cd plugins && go test ./browser/src/...`, and the full vitest suite. Commits
per repo, narrow paths, `git diff --cached` checked before each — the checkout
is shared with other sessions. **No pushes.**

### Wave 1 verification (not optional, not a subagent)

- `just smoke` — clean.
- `just voice-regress` — no pass→fail transitions.
- Manual, in a real browser (Playwright is not authoritative here): video mode
  entered by "video" and exited by "over"; subframe "highlight <phrase>" then
  "copy that"; `/quick` Enter → `v` → `y`; committed find + hint mode + Escape
  vs "over".
- HUD-visible states via `ingest_transcript` + `/v1/native/screenshot` for the
  pick chips and the video mode HUD.

---

## Wave 2 — primitives (3 agents, parallel, new files only)

Zero contention: each agent creates files nothing imports yet, plus unit tests
against the primitive in isolation. No call sites are migrated. Each primitive
ships WITH its conformance suite (design doc, "Testing strategy") — the suite
is part of the primitive, not a follow-up.

- **B1 — `src/labels/holder-registry.ts` + `src/testing/holder-conformance.ts`.**
  The v2 `CodewordHolder` interface, priority ordering, `claim` mode, the
  discriminated `reconcile(settle: SettleKind)` hook, and the derived
  `resolveCodeword` / `matchesPrefix` / `narrow` / `soleMatch`. Plus a
  `StoreHolder` adapter that makes `ObservableWrapperStore` a registered
  holder. Tests: the conformance suite run over synthetic holders AND the
  `StoreHolder` adapter; a three-holder registry proves exclusivity,
  fall-through, and priority; the registration meta-test (every registered
  holder gets the suite).
- **B2 — `src/core/mode-stack.ts` + `src/core/derive-mirror.ts` +
  `src/testing/modespec-conformance.ts`.** The `ModeSpec` table (with
  `peelInner`), push/pop/peelTop, floor recording, and `deriveMirror` as a pure
  function with its edge-transition diff. No wiring, no `chrome` imports.
  Tests: the ModeSpec conformance suite over the real table; the fast-check
  properties (reverse-order peel, floor restore, one-transition-per-edge,
  no-exclusive-tag-with-empty-stack — including mirror-RPC-failure ops);
  `deriveMirror` table tests (subframe caret, two-frame find, empty map).
  Adds `fast-check` as a devDependency.
- **B3 — `src/scan/phrase-collector.ts`.** Input semantics only, no DOM.
  Tests: chunked dictated insert commits once after the last chunk; a keystroke
  cancels a pending commit; 229 and `isComposing` are not keystrokes; a
  re-dictation replaces rather than appends.

Wave 2 can start as soon as the design is accepted — it does not depend on
Wave 1 landing, only on not colliding with it, which is guaranteed by the
new-files-only rule.

**Wave 2 exit criteria** (before any C-step): all three primitives + suites
green; `@vitest/coverage-v8` installed and the coverage baseline for the
blast-radius list recorded and committed; the ceiling-honesty commit landed
(raise to actuals 3814/1335, reason recorded — design doc, "The monolith
ceiling"). Sensing-freeze delta for the wave: zero adds, zero retirements —
the retirements land at C1/C3/C4 per the design doc's wave checkpoints.

---

## Wave 3 — migration (serial, one agent at a time, in this order)

Each step deletes call sites across `content.ts`, so these cannot be parallel.
Each step is one commit that leaves the tree green.

- **C1 — holders.** Every sweep in the design's inventory iterates the registry.
  `codeword-routing.ts` collapses to the sort. `StoreCodewordHooks` and the
  inline voice ordering are deleted. **Teardown wiring is deferred to C1b** and
  landed separately — orphan-CS teardown is the high-blast-radius area and gets
  its own commit and its own soak.
- **C2 — modes, driving the existing flags.** Every entry/exit goes through
  push/pop; push/pop set today's `KeyHandler` fields and controller state. The
  escape cascade becomes `peelTop`. Behaviour identical; Wave 1's tests are the
  proof.
- **C3 — delete the flags.** `entryFloor`, `restoreBadges`, `pickWindowHooks`,
  `keyboard.ts`'s four mode fields, `caret.escape()`'s internal order. This is
  the commit the design's "clean end state" promises.
- **C4 — the mirror moves to the SW.** Frames post their stack top;
  `plugin/plugin-api.ts` computes the tag set; `caretActivePushed`, the
  `isTopFrame` guards, the 300 ms focus re-assert, and
  `reconcileExternalTagClears`' hardcoded pair all go.
- **C5 — the collector.** `find.ts` and `palette-page.ts` both consume it.
  `FindMode`, `MODE_UI`, and the duplicated dictation predicates go.

Verification after **each** step, not at the end: `just smoke`,
`just voice-regress`, the Wave 1 manual list.

---

## Wave 4 — gates (2 agents, parallel)

- **D1 — a real-input test harness.** The gap that let all of this through is
  that every mode/escape test calls the module directly. One harness that
  dispatches real `KeyboardEvent`s and real `ingest_transcript`-shaped actions
  into a jsdom content script, so "key and voice do the same thing" is an
  assertion rather than a comment. Wave 1's A2 test is the seed; this
  generalises it.
- **D2 — exhaustiveness lint.** Every `ModeSpec` has a mirror decision (or an
  explicit `null` with a reason); every registered holder declares a priority;
  no `store.all` iteration outside the store module. Wire into CI the way
  `just check-gen` is wired.

---

## Scale, honestly

Wave 1 is the only part I'd commit to a shape for: six agents, each a
day-scale change, plus integration and a real-browser pass. Waves 2–4 are a
multi-week arc and the estimate is not worth much until Wave 1 tells us how many
of the ten findings were real.

## Recommendation

**Land Wave 1 and stop.** Then decide on the primitives with the regression
tests in hand and with a count of how many findings reproduced. The design is
worth writing down now — it is what makes Wave 1's fixes interim rather than
permanent — but committing to Waves 2–4 before Wave 1 reports is deciding
without the evidence the wave exists to produce.

If Wave 1 reproduces most findings, the primitives are justified and the order
above holds. If it reproduces two or three, the right answer is probably B1 and
B2 only, and the phrase collector stays a duplication we live with.
