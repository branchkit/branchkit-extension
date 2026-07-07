# Design: Keyboard Modes — reclaim the alphabet with a Normal/Hint/Insert model

**Status:** Steps 1–2 landed 2026-07-05 (mode split + `f` + mode chip; full
bare-key Vimium keymap). Direct change — no feature flag, no back-compat
(pre-release). Supersedes the "everything is a chord" workaround. Step 3
(hint-dimming) dropped — the chip is the honest mode signal; badge visuals
would mischaracterize the always-voice-live hints (see step 3 below).
Functionally complete.

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
  still fire commands even here — the Ctrl+K/Ctrl+T palette precedent — so the
  palette opens while typing in a search box. (Shift+F hide is NOT a real-
  modifier chord, so it yields to the field — see the 2026-07-07 unification
  section.) Unchanged.
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
2. **LANDED** — `DEFAULT_KEYMAP` rewritten to Vimium/Vimium-C parity: scroll
   `j`/`k`/`h`/`l`, `d`/`u`, `gg`/`G`; find `/`/`n`/`N`; history `H`/`L`,
   reload `r`, focus `gi`; tabs `t`/`x`/`X`/`gt`/`gT`/`yt`/`^`/`g0`/`g$`; pin
   `P`, mute `M`; palette `Ctrl+K`, tab palette bare `T` + `Ctrl+T`; help `?`.
   Lock + dispatcher + palette-display tests updated.
3. ~~Hint-dimming in Normal~~ **DROPPED (2026-07-05).** Dimming the badges in
   Normal mode sends the wrong signal: the hints stay fully **voice**-live in
   every keyboard mode, so de-emphasizing them reads as "inactive" when
   they're not. The keyboard's mode is a property of the *keyboard*, not of
   the hints, so it belongs on the mode chip (which lives in the keyboard's
   corner), not on the always-on badges. A future badge visual, if any, must
   read as "keyboard-armed" (additive) rather than "hints-dimmed"
   (subtractive) — a careful design, not shipped for now. The chip is
   sufficient.
4. Help-overlay note on the mode model. (Partly done — usage text updated.)

Each step is shippable on its own; step 1 reclaimed the alphabet.

## Show/hide unification + the invisible-override fix (2026-07-07)

**Problem.** Badge show/hide had two settings on one axis: the *visible*
`hintVisibility` (Always / Toggle, in the popup) and an *invisible*, persisted
`hintsShown` sticky flag (the old Ctrl+S). The invisible one won — a stray
Ctrl+S left `hintsShown=false` in `chrome.storage.local`, so a user on "Always"
with voice connected saw no badges and no way to discover why. Two settings on
the same axis, one hidden, hidden wins = the footgun. Compounded by
inconsistent keys: `f` in Toggle mode, Ctrl+S in Always.

**Fix — one visible source of truth, one consistent gesture.**

- **`hintsShown` deleted entirely** (state, storage, getters, the
  `applyHintsShownState` boot reconcile, the `onHintsShownLoaded` handler).
  `shouldAutoShowBadges()` is now just `hintVisibility === 'always'`.
- **Hide in Always mode is momentary** — `toggleHints()` no longer persists
  anything. It flips this page's live `pageSession.badgesVisible`; the next
  page repaints (always mode) so "Always" always means always. A stray hide can
  never strand the badges off across navigation.
- **Persistent "stay hidden while I browse" *is* Toggle mode** — that's the
  one place a fresh page starts hidden. There is no longer a second mechanism
  that does the same thing invisibly inside Always mode.
- **One keybind, both modes:** `toggle_hints` rebound `Ctrl+S` → **`Shift+F`**
  (retiring Ctrl+S, which had also been shadowing the browser's Save Page As).
  `f` shows + enters hint mode; `Shift+F` toggles visibility. Trade-off: Shift+F
  is not a real-modifier chord, so unlike Ctrl+S it yields to text fields
  (types "F") instead of firing there — accepted (hiding badges mid-typing is
  rare; per-site passthrough covers any site that binds Shift+F).
- **Popup unchanged** — the existing Always / Toggle control is now the single
  source of truth and cannot lie about a hidden state, so no new popup control
  was needed (the originally-requested "expose Ctrl+S in the popup" became moot
  once the invisible flag was gone).

Orphaned `hintsShown:false` values left in some dev profiles are inert (nothing
reads them) and, if anything, resolve toward the correct "shown" behavior.
