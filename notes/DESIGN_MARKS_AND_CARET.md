# Design: Marks + Caret/Visual mode — the last Vimium features

**Status:** Part 1 (Marks) **landed** 2026-07-06 (committed locally, unpushed,
live-verify pending). Part 2 (Caret/Visual) is still proposal. The two remaining
substantial Vimium features BranchKit doesn't have. Reference read against real
source:
`/tmp/vimium/content_scripts/marks.js`, `/tmp/vimium/background_scripts/marks.js`,
`/tmp/vimium/content_scripts/mode_visual.js`. **No Vimium-C clone available
locally** — this note is Vimium-parity; Vimium-C divergences called out where
they matter (open question 1).

Two independent features, shippable separately. Marks is the smaller, self-
contained one and lands first; caret/visual is the bigger port.

---

## Part 1 — Marks (`m` / `` ` ``)

Jump to a saved scroll position (local) or a saved URL+scroll in any tab
(global). Vim's `[a-z]` = local, `[A-Z]` = global; `` `` `` / `'` = jump back to
the position before the last jump.

### How Vimium does it (the parts we keep)

- **`m`** enters a one-shot "create mark" mode (indicator "Create mark…",
  suppresses all keys); the **next printable key** is the mark's letter.
  Shift → global.
- **`` ` ``** enters a one-shot "goto mark" mode; next key is the letter.
- **Local mark** = `{scrollX, scrollY, hash}`, persisted keyed by URL
  (`vimiumMark|<url-sans-hash>|<char>`). Restore: if the mark has a `hash` and
  scroll is `0,0`, set `location.hash`; else `scrollTo(x, y)`.
- **Global mark** = `{url, tabId, scrollX, scrollY, secret}`. Goto: try the
  original tab (id still valid + URL matches) → else any tab with that URL →
  else open a new tab; then set scroll. Cross-tab, so it lives in the
  background.
- **Previous-position registers** `` ` `` and `'` both hold the pre-jump
  position; `setPreviousPosition()` runs on every local jump. That's why
  `` `` `` returns you.

### The one thing we change: no page `localStorage`

Vimium writes local marks to the **page's** `localStorage` (visible to and
clearable by the site — an anti-pattern we won't copy). BranchKit already
routes all cross-context state through the background over its message channel
(tab-nav, tab-markers). So **all marks go through the background**, stored in
`chrome.storage`:

- Local marks → `chrome.storage.session`, keyed `mark:local:<url-sans-hash>:<char>`
  (per-session is enough; upgrade to `.local` if we want cross-restart later).
- Global marks → `chrome.storage.local`, keyed `mark:global:<char>`, durable.

This keeps the page's own storage untouched and matches BranchKit's
"background owns cross-context state" convention.

### Key capture: reuse the `passNextKey` one-shot

The second key is a **wildcard letter**, so it can't be a `CommandRegistry`
binding (tokens are literal). It's exactly the `passNextArmed` shape already in
`KeyHandler`. Add two arm flags mirroring it:

- Catalog commands `mark_set` (bound `KeyM`) and `mark_jump` (bound `Backquote`),
  each a normal registry binding so **`m` / `` ` `` stay user-rebindable** in the
  keymap editor.
- Their handlers call `keyHandler.armMarkSet()` / `armMarkJump()`.
- At the top of `handleKeyDown` (next to the `passNextArmed` check): if a mark
  arm is set and the key is a printable letter, consume it, clear the arm, and
  fire an `onMark(op, letter, shift)` callback; Escape or non-letter cancels.
  `Backquote` while jump-armed = the previous-position jump.
- A brief mode-chip while armed ("MARK — press a letter") so the two-step is
  legible, cleared on capture. (The chip already renders transient modes.)

### Wiring

- `content.ts` sets `keyHandler.setMarkCallback((op, letter, shift) => …)`:
  - **set, local**: read `scrollingElement` scroll + `location.hash`, send
    `MARK_SET {scope:'local', url, letter, scrollX, scrollY, hash}` to bg.
  - **set, global**: send `MARK_SET {scope:'global', letter}` — bg reads the
    tab (url/id) and top-frame scroll itself.
  - **jump, local**: `MARK_JUMP {scope:'local', url, letter}` → bg returns the
    stored pos → content does the hash-vs-scroll restore, after stashing the
    current position into the previous-position register.
  - **jump, global**: `MARK_JUMP {scope:'global', letter}` → bg does the
    find-tab-or-open + set-scroll dance (ported from Vimium's `goto`).
- New `src/background/marks.ts` owns storage + the global goto (mirrors
  `background/tab-nav.ts`). Content-side lives in `src/marks.ts`.
- Feedback via the existing `render/toast.ts` ("Local mark m", "Jumped to
  global mark A", "Mark not set").

### Scope cuts for MVP

- **Top-frame scroll only.** Vimium fetches sub-frame scroll from the top frame
  for global marks; BranchKit records the top frame's scroll. Sub-frame marks
  are an edge case — note and defer.
- Previous-position: implement `` ` `` (and `'` as an alias) returning to the
  pre-jump spot. Cheap, high-value, keep it.

---

## Part 2 — Caret / Visual mode (`v` / `V`)

A keyboard-driven text caret and selection over page content, ending in a yank
(copy). Built entirely on `Selection.modify(alter, direction, granularity)`.

### The model (straight from `mode_visual.js`)

One `Movement` class wraps `getSelection()` and an `alterMethod`:

- **Caret mode** = `alterMethod: "move"`. There's no real caret on non-editable
  content, so the caret is **shown as a 1-character selection**: each command
  collapses to the anchor, runs the movement, then `extendByOneCharacter(forward)`
  to paint the 1-char highlight.
- **Visual mode** = `alterMethod: "extend"`. Movements grow/shrink the
  selection from a fixed anchor.
- **Visual-line** = a visual variant that snaps to whole lines and re-extends to
  line boundaries after each move.

`caret` / `visual` / `visual-line` are a **singleton group** — entering one
exits the others.

### Movement map (fixed, Vim-canonical — not registry-driven)

Owned by a self-contained `handleCaretKey`, mirroring how `handleHintKey` owns
the alphabet. These letters mean *movement* here, deliberately shadowing their
Normal-mode binds (`j/k` = scroll in Normal, = line move in caret) — which is
exactly why this can't route through the shared registry.

```
h/l  char back/fwd      w   vim-word fwd     0/$  line start/end
j/k  line down/up       e/b word fwd/back    gg/G doc start/end
(/)  sentence           {/}  paragraph       o    reverse ends
y    yank + exit        Y    yank line       Esc  collapse + exit
v    → visual           V    → visual-line   c    → caret
```

MVP subset: `h/j/k/l`, `w/b/e`, `0/$`, `gg/G`, `o`, `y`, `Esc`, and the
`v`/`V`/`c` mode switches. Sentence/paragraph/`aw`/`as`/find-in-selection can
follow. Vimium implements **word-forward char-by-char** (native `word`
granularity differs Linux/Windows); MVP uses native `word` and refines if it
misbehaves on macOS.

### Entry / exit

- **`v` from Normal**: if there's a usable selection already in the viewport →
  visual mode; else caret mode, establishing an initial anchor at the first
  "big" visible text node (Vimium's `TreeWalker`, first text node with ≥50
  non-whitespace chars, skipping editables/off-screen). If none found, abort
  with a toast.
- After every movement, `scrollIntoView` the selection focus (reuse
  `activate/scroller.ts`).
- **`y`**: copy `selection.toString()` via `clipboard.ts`, collapse, exit to
  Normal, toast "Yanked N characters".
- **Escape**: collapse (to focus in visual, to anchor in caret) and exit. If the
  selection landed in an editable, blur it so we don't get trapped in Insert.

### Where it lives

- New `src/activate/caret.ts` — the `Movement` class (the Selection.modify
  logic) + the three mode behaviors. This is the bulk (~200 lines ported).
- `activate/keyboard.ts` — `KeyMode` gains `'caret' | 'visual'` (+ a `lineWise`
  flag or a `'visual-line'` value); `handleKeyDown` routes to `handleCaretKey`
  when in those modes, same shape as the `handleHintKey` branch.
- `render/mode-chip.ts` — add `caret` ("CARET — hjkl move · v select · Esc")
  and `visual` ("VISUAL — hjkl extend · y yank · Esc") entries; `getMode()`
  returns them.
- Catalog: `caret_mode` (bound `KeyV`). Everything past entry is handled inside
  the caret handler, not the registry — same as hint mode.

### Insert-mode interaction (free)

Caret/visual are entered explicitly from Normal. If focus is in a field we're
already in Insert (keys pass to the page), so `v` types a `v` there — correct,
matches Vimium (caret mode is for reading page text, not editing fields). No
special handling needed.

---

## Voice (deferred, deliberately)

Both features are fast keyboard modal loops — many small motions (caret) or a
letter picked from the full alphabet (marks). Neither is a natural push-to-talk
fit, and both need extra wiring against the **closed command grammar** (free-
letter capture for marks; a movement vocabulary for caret). The genuinely
voice-shaped slice is coarse selection — "select word", "select to end of
line", "copy that" — a real differentiator, but it's a follow-up, not Vimium
parity. Keep this note keyboard-first; revisit voice selection separately.

---

## Sequencing

1. **Marks** — self-contained, one background module + one content module + the
   arm-key one-shot. High value, low blast radius. Land first.
2. **Caret/visual** — the `Movement` port + a new modal handler + chip entries.
   Bigger, but isolated to new files plus small `keyboard.ts`/`mode-chip.ts`
   edits.

Each ships independently; neither touches voice, hints, or the reconciler.

## Open questions

1. **Vimium-C parity.** No local clone. Vimium-C's marks/visual are broadly a
   superset (same `m`/`` ` ``/`v`/`V` verbs). Worth cloning
   `gdh7/Vimium-C` to diff before locking the keymap? The bulk is identical;
   the risk is a couple of default-bind differences. Recommend: proceed on
   Vimium parity, spot-check Vimium-C for the exact `v`/`V`/`o`/`c` defaults.
2. **Local mark persistence.** `storage.session` (per-browser-session, simplest)
   vs `storage.local` (survives restart, matches Vimium's localStorage
   durability). Lean session for MVP; trivial to promote.
3. **Visual-line as a 3rd mode value vs a `lineWise` flag** on visual. Lean
   flag — one fewer chip/mode to thread.
