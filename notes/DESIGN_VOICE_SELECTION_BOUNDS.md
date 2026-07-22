# Voice-driven adjustable text selection — design input (Vimium/Rango study)

**Status:** DESIGN INPUT, 2026-07-21. NOT started — outside-inspiration pass before
building (user request). Builds on: Phase 1 cross-node find flat-index
(`src/scan/find.ts` `buildFlatIndex`), existing caret/visual mode
(`src/activate/caret.ts`), and `notes/DESIGN_MARKS_AND_CARET.md`.

Goal: after a find, let the user **expand / shrink / move the bounds** of the
highlighted span by voice ("extend to end of sentence", "shrink a word", "select
to <phrase>"), then act on it (copy, etc.).

## The one primitive everything reduces to

Vimium, Vimium C, and every robust version of this build on
**`Selection.modify(alter, direction, granularity)`** (MDN). The vim keymap is a
thin dispatch table over three arguments:
- `alter`: `"move"` (caret — cursor moves, nothing selected) vs `"extend"`
  (visual — anchor fixed, focus moves). **This is the caret/visual split.**
- `direction`: `forward` | `backward` (logical, RTL-aware) | `left` | `right`.
- `granularity`: `character` | `word` | `line` | `sentence` | `paragraph` |
  `lineboundary` | `sentenceboundary` | `paragraphboundary` | `documentboundary`.

Our voice grammar should map **1:1** onto this: a `verb × granularity × direction
(× count)` command IS a `modify()` call. `caret.ts` already wraps this (its
`Movement` class calls `Selection.modify`), so we extend an existing seam, not a
new stack.

## What to borrow (from Vimium / Vimium C)

1. **`direction × granularity` grammar** — the single cleanest steal. "extend
   forward word", "extend back sentence", "shrink line". Counts: "extend three
   words".
2. **Anchor flip as a first-class verb** — Vimium `o` swaps anchor/focus
   (`setBaseAndExtent` with ends swapped) so you can adjust the *other* end after
   over-extending. Voice: "flip" / "other end". Essential for adjustment (not just
   growth).
3. **Find → selection handoff** — the big ergonomic win. A find leaves a real
   `Selection`; Vimium auto-promotes caret→visual when a match is non-empty so the
   matched text becomes the extendable anchor. Vimium C's **`f` = find-and-extend
   in one keystroke** beats Vimium's two-step `/` then `n`. For voice, fold it:
   **"extend to <phrase>"** / **"select to <phrase>"** = find + extend in one
   utterance. (We already have `findExtend`/`findNavigate` in caret.ts.)
4. **Copy exits and confirms with a preview** — yank = capture → exit → clipboard
   → HUD "Yanked 27 characters: …". The **preview is doubly important for voice**
   (no visible cursor). Reuse our toast/HUD.
5. **Rango "references"/marks for the *targeting* half** — name a location once
   ("mark this as intro"), reuse by name ("select from intro to here"). Good voice
   ergonomics; a later phase.

## What NOT to copy

- **Single-key vim motions (`h`/`l`/`w`/`b`)** — meaningless spoken. Voice wants
  explicit nouns + counts, not key-mashing.
- **Rango's element-only ceiling** — `copy content <hint>` copies a *whole
  element*; Rango has NO sub-span prose selection, no select-word/sentence, no
  expand/shrink. This is the gap we're explicitly filling — don't inherit it. It's
  also precedent that we'd be *ahead* of the reference voice tool here.
- **`window.find`** — non-standard, uncontrollable highlight, inconsistent
  (esp. Gecko). We already don't use it; keep it that way.

## Cross-engine pitfalls (plan for these up front)

- **Firefox lacks `sentence`/`paragraph`/`*boundary` granularities**, and
  `Selection.modify` is **inert inside text inputs** on FF. → Degrade
  sentence/paragraph → line/word on FF, OR implement sentence/paragraph ourselves
  over the Phase-1 flat index with **`Intl.Segmenter`** (word + sentence
  granularity, portable) — the flat index already maps offsets↔DOM, so segmenting
  it and setting a Range is straightforward. For editable fields, fall back to
  `input.value` + `selectionStart/End`.
- **Native `word` movement is OS-dependent** (Vimium/Vimium C both hand-roll
  forward word). Expect drift or hand-roll via Segmenter.
- **Selection direction isn't queryable reliably** — Vimium nudges a char to
  probe; Vimium C keeps a cached direction state machine. **Track anchor/focus
  direction explicitly** — the fragile part.
- **Caret establishment is a heuristic** in Vimium (first visible text node ≥50
  chars). Voice needs a **deliberate anchor** — our find result IS that anchor, so
  we sidestep the heuristic entirely (a real advantage of the find-first flow).
- **Selection lost on scroll-out** (Vimium clears it). For voice this may surprise;
  consider keeping the selection + offering "reselect".

## Proposed shape (for discussion — not building yet)

The find result becomes a live `Selection` (promote find Range → `addRange`), then
a small voice grammar drives `Selection.modify`:

- **Grow/shrink:** "extend word|sentence|line|paragraph [forward|back] [<count>]",
  "shrink …". (verb → alter=extend; direction; granularity; count)
- **Flip:** "flip" / "other end" (anchor swap).
- **Find-extend:** "extend to <phrase>" / "select to <phrase>" (find + extend, one
  utterance — the Vimium C `f` idea).
- **Act:** "copy" (capture → clipboard → HUD preview), later "cut"/"replace".
- **To boundary:** "extend to end of line|sentence", "to start of paragraph".
- Later (Rango-style marks): "mark this as <name>", "select from <name> to here".

Cross-cutting: track direction state explicitly; render the live selection via the
CSS Custom Highlight API (already cross-node capable) and/or the native Selection;
degrade granularities per engine.

## Escape semantics: layered peel, and the mode-stack seam (2026-07-22)

Selection is really three independent layers stacked on the page, each with its
own highlight:

- **search** — a committed find over the selection (find's CSS Custom Highlight:
  orange current match + yellow others, plus the pill).
- **visual** — the extended span (the real document `Selection`, native blue).
- **caret** — the collapsed 1-char point.

Escape **peels the last layer added, keeping the ones below** — so `v` → `/`query
Enter → Escape clears *only* the find highlight/pill and leaves the blue
selection; the next Escape collapses that to the caret; the next exits to Normal.

**Implementation is a fixed-order check, NOT a generic LIFO stack** (`caret.ts`
`escape()`): `isFindActive()` → `closeFindMode()`; else visual-non-collapsed →
`collapseToCaret()`; else `exit()`. This *equals* LIFO only because of a
**structural invariant**: search can only sit on top of visual (a committed find
only extends a selection that already exists or that it just created), and visual
only on caret — the three can't be entered in any other order. So fixed priority
== entry order for every real flow, with no stack bookkeeping. (Non-Escape exits —
yank, "stop selecting" — tear all layers down at once; only Escape peels.)

**The seam, for later.** If a future gesture can put a layer on top out of order
(e.g. a *new* visual on top of an active search), fixed priority diverges from
true LIFO and this should become a real stack: an array pushed on layer-entry,
popped on Escape. The wider extension has more modes (hint, video, mark, insert,
palette) managed separately in `keyboard.ts` as a flat `KeyMode` + per-mode Escape
handlers with genuinely different semantics (hint's Escape cancels a typed prefix
first; video also exits on `q`/`w`; find distinguishes bar-open vs committed). A
single global LIFO mode stack across all of them is plausible but is a high-blast-
radius refactor (the keyboard routing is hard-won) and would have to flatten those
per-mode nuances. **Decision: keep the fixed-order peel for caret/visual/search;
do NOT generalize yet.** When a mode genuinely nests in arbitrary order, introduce
`pushMode`/`popMode` in `keyboard.ts` with each mode owning a "what does peeling me
mean" callback — that's the moment, not before.

## Open questions

- Native `Selection.modify` vs our-own segmentation (`Intl.Segmenter` over the flat
  index) — probably native where available, Segmenter as the portable fallback for
  sentence/paragraph. Decide after a spike on both engines.
- Does the selection stay a highlight (our CSS highlight) or become the real
  browser selection (so system copy works)? Likely the real selection for copy, our
  highlight for the visual state — reconcile the two.
- Keyboard parity: expose the same as a keyboard mode (caret.ts already is one) so
  it's not voice-only (extension-independence principle).

## Sources
- Vimium visual/caret: `philc/vimium` `content_scripts/mode_visual.js` + wiki Visual-Mode.
- Vimium C: `gdh1995/vimium-c` `content/visual.ts`, `background/key_mappings.ts`.
- Rango: `david-tejada/rango` readme; `rango-talon` `src/rango.talon` (element-only; no prose selection).
- MDN: Selection.modify, Selection, Range, CSS Custom Highlight API, Window.find.
