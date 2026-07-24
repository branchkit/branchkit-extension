# Implementation plan — voice-driven adjustable text selection

**Status:** Phases A–C **LANDED** (local, unpushed) 2026-07-22. Phase D (marks)
deferred. Companion to the design study `notes/DESIGN_VOICE_SELECTION_BOUNDS.md`
(Vimium/Rango inspiration) and `notes/DESIGN_MARKS_AND_CARET.md`. Builds on
Phase-1 cross-node find (`src/scan/find.ts` `buildFlatIndex`).

## What landed (2026-07-22)

- **Pure grammar** `src/activate/selection-grammar.ts` — `planModify` (verb ×
  granularity × direction × count → `Selection.modify` args), explicit
  `growthDir` state machine (`nextGrowthDir`), `opposite`. Unit-tested (jsdom has
  no `Selection.modify`, so the decision layer is pure + fully covered).
- **Portable segmentation** `src/activate/segmenter.ts` — `Intl.Segmenter`-backed
  `segmentStops`/`nextStop`/`lineBoundary`, editable-field selection
  (`applyFieldModify`/`readFieldRange`/`writeFieldRange`), and
  `nativeModifyWasInert` (measure-and-fallback, no engine sniffing). Unit-tested.
- **caret.ts** — rich `applyVoice(SelectionCommand)` (extend/shrink/flip/copy/
  exit + granularity/direction/count); page path runs native modify then falls
  back to the Segmenter when inert (Firefox sentence/paragraph/lineboundary);
  field path (`enterField`, reachable via `select {hint}` on a text input) drives
  `value` + `selectionStart/End`; `flip` inverts the tracked growth direction;
  yank shows a text preview. Phase B: `enterFromFind` (promote the current find
  match to a visual selection) + `extendToPhrase` (find + extend in one).
- **command-catalog.ts** — `caret_voice` replaced by discrete `select_extend`,
  `select_shrink`, `select_flip`, `select_copy`, `select_exit` (group Selection,
  `voiceContext:'caret'`, so they auto-appear in the `?` palette) + `select_to`
  (dictated-argument consumer, no `{text}` pattern — mirrors `find_immediate`).
- **content.ts** — dispatch for the discrete verbs (`parseSelectionCommand`),
  `select_to` registered + in `DISPATCH_PASSTHROUGH`, and `caret_mode` (`v`) now
  promotes an active find match into the selection.

### Live-test refinements (2026-07-22, second pass)

- **Whole-entity text objects `aw`/`as`/`ap` (+ inner `iw`/`is`/`ip`) rebuilt on a
  deterministic substrate.** Native `Selection.modify` sentence/paragraph is flaky
  in Chrome (produced "strange ap selection" + "as only grabbed caret→end"). Now
  `selectLexicalEntity` uses `buildBlockIndex` (find.ts — flat cross-node text of
  the nearest block, DOM⇄flat `posOf`/`rangeFor`) + `entitySpan`/`trimSpan`
  (segmenter.ts, pure + unit-tested): paragraph = whole block, word/sentence = the
  Segmenter span around the caret, cross-node correct (a sentence split by inline
  `<b>`/`<a>` selects whole). `i` prefix = inner (whitespace-trimmed). Fully
  testable in happy-dom (no Selection.modify) — see find.test.ts buildBlockIndex.
- **Find-and-select auto-extends on commit.** `n` used to skip to the *next* match
  before extending ("funky"). Added find `onCommit` callback → when caret mode is
  active, `caret.extendToCurrentMatch()` extends straight to the committed match.
  Flow is now: caret `v` → `/ query` Enter → selection extends to the match; `n`/`N`
  only for deliberately hopping to other occurrences. Anchors on the caret pos
  saved at `/` (`savedAnchor` + `setBaseAndExtent`), NOT the live Selection — the
  find input's focus was relocating it ("selects everything after the word").
- **Layered Escape — peel search → visual → caret → Normal** (user's mental model:
  each Escape undoes the last thing, in reverse order). The three highlights are
  independent: search = find's CSS highlight (orange match + pill), visual = the
  document Selection (native blue), caret = the collapsed point. `escape()` checks
  in fixed order: `isFindActive()` → `closeFindMode()` (clears the find highlight +
  pill, KEEPS the selection); else visual non-collapsed → `collapseToCaret()` (back
  to the anchor, stay in caret mode); else `exit()`. Search always sits above visual
  (a committed find only extends an existing/created selection), so fixed order ==
  entry order for every real flow. Non-Escape exits (yank, "stop selecting") still
  `closeFindMode()` in `exit()`. Fixes "Escape fully exits + caret moved on re-entry"
  and "I want to escape the search first, keeping the selection."

### `?` help + voice parity (2026-07-22, third pass)

- **Whole-entity voice select** `select_whole` — "select word / select sentence /
  select paragraph" → `selectLexicalEntity` (inner-trimmed), the voice twin of the
  keyboard `aw/as/ap`. Gated `voiceContext:'caret'`. This is the piece that was
  dropped when the old `caret_voice` "select word" moved to `extend` semantics.
  Field path (`selectFieldEntity`) covers input/textarea.
- **`?` overlay fixes** (`render/help-overlay.ts`): (1) the group grid's voice
  column was `nowrap`, so a command with many phrases (select_extend has 14)
  expanded it to full width and collapsed the command-name column to zero — bounded
  the column (`minmax(0, 1.4fr)`) and made phrases wrap. (2) Added a **"Inside a
  mode (typed keys)"** legend (`MODAL_KEYS`) documenting the handler-owned keys
  (caret/visual movement + text objects, hint letters, mark letters, video keys)
  that aren't registry commands and so never appeared in the table.

### Remaining voice work (mostly cross-repo)

- **`select_to` "extend to <phrase>"** voice trigger — consumer built; needs the
  voice-plugin arm-then-dictate flow (like "search"→find_immediate).
- **Text targeting "click/follow <text>"** — needs the page-word grammar index
  (DESIGN_TEXT_TARGETING.md); cross-repo, larger.
- Marks by voice, and a bare voice "start selecting" (caret entry without a hint) —
  deferred/minor.

### Remaining cross-repo wiring (NOT extension-local)

`select_to`'s trigger ("extend to <phrase>" → dictated query → `browser.select_to
{query}`) needs the **voice plugin** arm-then-dictate flow, exactly like "search"
→ `find_immediate` (see [[project_dictated_command_argument]]). The extension
consumer is done; the plugin arm on a new trigger word is the open piece. Until
then `extendToPhrase` is reachable via the `select_to` action directly.

Goal: after a find (or from a caret), let the user **grow / shrink / move the
bounds** of a selection by voice ("extend a sentence", "shrink a word", "flip",
"extend to <phrase>") and act on it ("copy"). Keyboard parity throughout.

## What already exists (extend, don't rebuild)

- **`src/activate/caret.ts`** — Vimium-style caret/visual mode. `Movement` class
  wraps `Selection.modify(alter, direction, granularity)`; `alter='move'`=caret,
  `'extend'`=visual. Has `extendByOneCharacter`, `collapseToAnchor/Focus`,
  `reverse()` (anchor flip), and **`findExtend`/`findNavigate` already integrate a
  find Range into the live Selection**. Granularities wired: char/word/line/
  sentence/paragraph/lineboundary.
- **`caret_voice` command** (`command-catalog.ts` id `caret_voice`, group
  `Selection`, `mappable:false`) — the voice entry point, dispatched with an `op`
  param (`content.ts` ~3343: `caret.applyVoice(op)`; ops today: word/line/sentence/
  end/start/copy/exit).
- **`caret_mode`, `visual_line_mode`** (group `Selection`) — keyboard entries.
- **Phase-1 flat index** (`buildFlatIndex`) — cross-node offset↔DOM map; the
  substrate for both find and any own-segmentation fallback.
- **`?` help overlay** (`render/help-overlay.ts`) builds from `COMMAND_CATALOG`
  grouped by `group`, showing every command with a keybind OR voice phrase. **New
  Selection commands appear there automatically** once added to the catalog.

## The grammar (verb × granularity × direction × count)

One `caret.applyVoice(op, params)` call = one `Selection.modify`. Map voice →
primitive:

| Voice | alter | granularity | direction | notes |
|---|---|---|---|---|
| "extend word/sentence/line/paragraph [back]" | extend | word/sentence/line/paragraph | forward/backward | count: "extend three words" |
| "shrink word/sentence/…" | extend | (same) | opposite of current growth | shrink = extend toward anchor |
| "extend to end of line/sentence" | extend | lineboundary/sentenceboundary | forward | |
| "flip" / "other end" | — | — | — | `reverse()` — swap anchor/focus |
| "extend to <phrase>" | extend | — | — | find-and-extend (Vimium C `f`): find phrase, extend focus to it |
| "copy" | — | — | — | capture selection → clipboard → HUD preview → exit |
| "caret/visual/exit" | move/extend | — | — | mode toggles (exist) |

Shrink = extend in the direction that reduces the span; needs explicit
**direction-state tracking** (research pitfall: `Selection.direction` unreliable —
keep our own anchor/focus-direction flag in caret.ts, updated on every op).

## Phases

**Phase A — grammar + catalog + `?` palette (the core).**
1. Extend `caret.ts` `applyVoice` to accept `{op, granularity, direction, count}`
   and drive `Selection.modify` (loop `count` times). Add `flip` (→ `reverse()`)
   and `shrink` (extend toward anchor via tracked direction).
2. Catalog entries (group `Selection`) so they surface in the `?` palette + are
   keyboard-mappable + voice-contributed. Proposed net-new commands:
   - `select_extend` — label "Extend selection", params: enum granularity
     (word|sentence|line|paragraph), enum direction (forward|back), number count;
     voice `extend {granularity}`, `extend {count} {granularity}`, `extend back {granularity}`.
   - `select_shrink` — "Shrink selection", same params; voice `shrink {granularity}`.
   - `select_flip` — "Flip selection end", voice `flip` / `other end`; keybind `o` in caret mode.
   - `select_copy` — "Copy selection", voice `copy that` / `copy selection`; captures + HUD preview.
   Keep `caret_voice` as the dispatch shim (or migrate its ops onto these).
   Decision to make: discrete commands (better palette discoverability) vs one
   parameterized `caret_voice` (fewer entries). LEAN discrete — the `?` palette is
   the whole point of this being in the command palette.
3. Keyboard parity: bind the same in caret/visual mode (extend already keyed;
   add/confirm `o`=flip, `y`=copy — exist in Vimium model).

**Phase B — find → selection handoff (the ergonomic win).**
4. On a find match, promote the find Range to the live Selection so it becomes the
   extendable anchor (research: Vimium auto-promotes caret→visual on non-empty
   match). Reuse `findExtend`/`findNavigate` (exist) + Phase-1 cross-node Ranges.
5. `select_to` / "extend to <phrase>" — one utterance: find `<phrase>` (cross-node,
   tolerant/fuzzy for voice), extend the selection's focus to that match. This is
   the headline interaction; folds find + extend.
   - Catalog `select_to`, group `Selection`, params: string phrase; voice
     `extend to {text}` / `select to {text}`. (Note the `{text}` capture — this is
     the SAME dictated-argument path as `find` search, so it rides the platform's
     find-dictate/arg plumbing, not a raw voice free-text slot.)

**Phase C — cross-engine + fields.**
6. Firefox lacks `sentence`/`paragraph`/`*boundary` granularities and
   `Selection.modify` is inert in inputs. Fallback: implement sentence/paragraph
   via **`Intl.Segmenter`** over the Phase-1 flat index (portable), and in editable
   fields use `input.value` + `selectionStart/End`. Feature-detect; degrade
   sentence→line where neither is available.
7. Hand-roll forward `word` if native word drift is a problem (Vimium/Vimium C both
   do) — or use `Intl.Segmenter('word')`.

**Phase D (later) — marks / named anchors (Rango pattern).**
8. Extend the existing `Marks` group: "mark this as <name>", "select from <name>
   to here" — name a location, select a span between two named/found points. Own
   sub-plan.

## Cross-cutting decisions

- **Real Selection vs our highlight.** For `copy` to use the system clipboard the
  span should be the real browser `Selection`; the CSS Custom Highlight shows the
  visual state. Reconcile: drive the real Selection, mirror to our highlight (or
  rely on native selection styling). Decide in Phase A spike.
- **Direction state** tracked explicitly in caret.ts (not read from the API).
- **Voice `{text}` for `select_to`** goes through the platform dictated-argument
  path (same as `search`), NOT a raw free-text voice slot — reuse, don't reinvent.
- **Extension-independence:** everything is a keyboard mode too (caret.ts already
  is); voice is the add-on. Keeps the standalone story whole.

## Testing

- Unit (vitest, jsdom): grammar → `Selection.modify` arg mapping; direction-state
  transitions; shrink logic; `Intl.Segmenter` sentence/paragraph over a flat index
  fixture; find→selection promotion with cross-node Ranges.
- Catalog: `command-catalog.test.ts` — new ids present, grouped `Selection`, voice
  patterns parse, appear in the help model (`help-overlay.test.ts`).
- Manual matrix: Chrome + Firefox (granularity degradation), prose + editable
  field, cross-node span, RTL sanity.

## Open questions (resolve before Phase A code)

- Discrete `select_*` commands vs one parameterized `caret_voice` — LEAN discrete
  for palette discoverability; confirm with the catalog/label conventions.
- Native `Selection.modify` vs `Intl.Segmenter` as the PRIMARY (not just FF
  fallback) — Segmenter is portable + testable but ignores layout (line
  granularity needs layout). Likely hybrid: Segmenter for word/sentence/paragraph,
  native for line/lineboundary. Spike both engines first.
- Does "copy" exit selection mode (Vimium yanks-and-exits) or stay for chained
  edits? Lean exit + HUD preview (matches Vimium; clearest for voice).
