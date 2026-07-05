# Design: Keyboard Modes — reclaim the alphabet with a Normal/Hint/Insert model

**Status:** Step 1 landed 2026-07-05 (mode split + `f` + mode chip). Direct
change — no feature flag, no back-compat (pre-release). Supersedes the
"everything is a chord" workaround. Steps 2–4 (full bare-key keymap, hint-
dimming, help note) still open.

## Problem

BranchKit made hints always *typeable*: in always-visible-hints mode,
`KeyHandler.handleKeyDown` (activate/keyboard.ts) routes every bare letter to
hint-filtering. That consumes the entire alphabet, so every keybind we ship —
scroll, the tab verbs, find-next — has to be a Shift- or Ctrl-chord. It's a
workaround, and it blocks a real Vim/Vimium-C keybind set (`gg`, `G`, `d`,
`x`, `gt`/`gT`, …). We want the alphabet back.

## Core insight: visibility ≠ typeability

Hints are always *visible* because the product is **voice-first** — you need
the codewords on screen to *speak* them. That's non-negotiable and unchanged.
But being visible does not require being *typeable*. Today we conflated the
two. Splitting them is the whole design: hints stay painted for voice, but the
keyboard only sends letters to them in an explicit **hint mode**. Everywhere
else, bare letters are keybinds.

## The model: three modes

- **Insert** — focused in an editable field (`isInsertMode()` already detects
  this). Keys pass through to the page. Real-modifier chords (Ctrl/Alt/Meta)
  still fire commands even here — the Ctrl+S / Ctrl+K precedent — so the
  palette and hide-hints work while typing in a search box. Unchanged.
- **Normal** — the default, and the reclaimed one. Bare letters and sequences
  are **keybinds** (`gg`, `d`, `gt`, `f`, …). Hints are visible (for voice)
  but NOT typeable. This is the new behavior.
- **Hint** — entered from Normal by **`f`**. Letters now filter/activate hints
  exactly as today (`handleHintKey`: prefix filter, capital = new tab, Enter =
  first visible, Backspace, two-stage Escape). Escape or activation returns to
  Normal.

Voice is **orthogonal** to all of this — it's push-to-talk with no keyboard
mode, and it works identically regardless of which keyboard mode is active.
The keyboard mode only gates keyboard routing.

## The mode indicator (load-bearing UX)

Because hints stay painted in every mode, the user cannot tell from the page
whether a letter will fire a keybind or filter a hint. So the mode must be
**shown**. Two surfaces, ideally both:

1. **A persistent mode chip** — a small shadow-DOM badge in a corner
   ("NORMAL" / "HINT"; hidden or dimmed in Insert). Content-side, same
   isolation pattern as the find bar / help overlay.
2. **Hints arm visually in hint mode** — in Normal the hint badges are dimmed
   (present for voice, clearly not the keyboard target); pressing `f`
   brightens/"arms" them. This makes the transition legible without reading
   the chip.

Recommend shipping both: the chip names the mode, the hint-dimming shows
"typeable now." Start with the chip if we want the smaller first step.

## Transitions

| From | Trigger | To |
|---|---|---|
| Normal | `f` | Hint |
| Hint | Escape (no prefix) / activation | Normal |
| Normal/Hint | focus an editable field | Insert |
| Insert | blur | Normal |
| any | real-modifier chord (Ctrl/Alt/Meta) | fires command, mode unchanged |

`f` in **manual** hint-visibility also *shows* the hints (scan + paint) before
arming; in **always** mode they're already painted, so `f` only arms typing.
Hint mode's existing new-tab affordance (capital mid-codeword) is unchanged.

## The reclaimed keymap (proposed default)

With bare letters free, `DEFAULT_KEYMAP` moves to Vimium-parity. Sketch (final
set tunable in the existing keymap editor):

- **Hints:** `f` (arm/activate hints), new-tab variant via the capital
  affordance (already in hint mode).
- **Scroll:** `j`/`k` (down/up), `d`/`u` (half), `g g`/`G` (top/bottom),
  `h`/`l` (left/right).
- **Find:** `/` (open), `n`/`N` (next/prev).
- **Tabs:** `g t`/`g T` (next/prev), `x` (close), `X` (restore), `t` (new),
  `y t` (duplicate); position verbs as needed. **`T` opens the tab palette**
  (Vimium's tab-search key) — now possible as a bare key.
- **Palette:** `Ctrl+K` (full) / `Ctrl+T` (tabs) stay real-modifier chords so
  they also work in Insert mode; the bare `T` above is the Normal-mode twin.
- **Help:** `?`.

The multi-key sequence machinery already exists (`CommandRegistry.match`
handles `KeyG KeyG` with the 500 ms partial window), so `gg`/`gt` need no new
matcher.

## What this simplifies

Every Shift-chord tab verb we shipped (`Shift+H/L` etc.) can become a bare
Vim key (`gt`/`gT`), and `Ctrl+T`'s bare twin `T` becomes available. The
palette, the tab marks, and voice are all untouched — this is purely the
keyboard routing layer. It *removes* the always-typeable special case rather
than adding machinery.

## Implementation notes (`activate/keyboard.ts`)

- Replace the `mode: 'normal' | 'insert' | 'hint'` handling so Normal is the
  real default even when `hintsVisible()` is true. Delete the
  `this.mode === 'hint' || this.hintsVisible()` → `handleHintKey` branch in
  `handleKeyDown`; that branch is the always-typeable workaround.
- `f` (a Normal-mode command) calls `enterHintMode()` (and, in manual
  visibility, dispatches `show_hints` first).
- Insert detection and the real-modifier-chord fast path stay as-is.
- Add the mode chip (new content-side element) + drive its state from
  `KeyHandler.getMode()` transitions (a small onModeChange callback, mirroring
  `setFilterCallback`).
- Rewrite `DEFAULT_KEYMAP` (command-catalog.ts) to the bare-key set;
  drop the "hidden-only" caveats in its comments (every key is now reachable
  in Normal mode). Update the catalog lock tests.

## Open questions

1. **Mode chip vs hint-dimming** — ship one or both first? (Recommend chip
   first; dimming as a fast follow.)
2. **Exact default keymap** — strict Vimium parity vs BranchKit-specific
   tweaks. The editor makes this low-stakes; pick a sane default.
3. **`Escape` in Normal** — no-op, or blur/clear? (Lean no-op; Escape is
   Hint→Normal and Insert→blur.)
4. **Discoverability** — the help overlay (`?`) already lists binds; it should
   note the mode model. The palette (Ctrl+K) is the other discovery surface.

## Plan

1. **LANDED** — Mode split in `keyboard.ts` (Normal default; the always-
   typeable `hintsVisible` branch deleted; `f` → `hint_mode` command enters
   Hint) + the mode chip (`render/mode-chip.ts`, shown in Hint only) wired via
   `setModeChangeCallback`. `KeyF` → `hint_mode` in `DEFAULT_KEYMAP`. Help
   overlay updated. Keyboard tests rewritten for the new model. The alphabet
   is reclaimed — the previously "hidden-only" bare binds (h/l/n/cs//) now work
   in always-mode.
2. Rewrite `DEFAULT_KEYMAP` to bare Vim/Vimium-C keys; migrate the tab verbs
   off Shift-chords; add bare `T` for the tab palette; update lock tests.
3. Hint-dimming in Normal (visual arm on `f`).
4. Help-overlay note on the mode model. (Partly done — usage text updated.)

Each step is shippable on its own; step 1 reclaimed the alphabet.
