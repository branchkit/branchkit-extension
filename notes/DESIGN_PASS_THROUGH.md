# Design: keyboard pass-through (Vimium-style insert mode + exclusions)

**Status:** IMPLEMENTED 2026-07-06 (extension-only). Fills the gap vs
Vimium/Vimium-C: a way to hand the keyboard to the page so its own bare-key
shortcuts (Gmail `j`/`k`, GitHub, web apps, games) work.

## The problem

BranchKit's `KeyHandler` only yields to the page **automatically** when focus is
in an editable field (`isInsertMode()` in `src/activate/keyboard.ts`). On pages
that use bare-key shortcuts **outside** text fields, BranchKit's binds (`f`,
scroll keys, hint letters) shadow the site's, with no escape hatch.

## Three mechanisms

All live in `KeyHandler`; the pass-through checks sit at the **top** of
`handleKeyDown` (before the chord path), so in pass-through even Ctrl/Cmd combos
reach the page.

1. **Explicit pass-through (`insert_mode`, bound to `i`).** `enterInsertMode()`
   sets `forcedInsert`; every key reaches the page until **Escape** (the only key
   intercepted, to exit). The mode chip shows `PASS-THROUGH`. Vimium's insert
   mode. Keyboard-only — no voice pattern (voice is unaffected by keyboard
   modes).
2. **Pass next key (`pass_next_key`, unbound by default).** `armPassNextKey()`
   hands exactly the next keystroke to the page, then normal handling resumes.
   Vimium's `passNextKey`.
3. **Per-site exclusion (all-or-nothing).** `setExcluded(true)` = keybinds off
   for this host, every key to the page (Escape included). Persisted under
   `keyExclusions`, toggled from the popup ("Shortcuts here: On/Off").
4. **Per-site granular passthrough.** `setPassKeys([...])` = pass just these keys
   (matched against `event.key`) to the page while the REST of BranchKit's binds
   keep working — the Gmail case: pass `j`/`k`/`e`, keep `f`. Checked in normal
   mode only (hint typing + Ctrl/Cmd chords unaffected). Persisted under
   `keyPassthrough` (host → chars), edited from the popup's "Pass keys to site"
   field (each typed character is one key). Vimium's passKeys.

Both per-site levels live in `src/key-exclusions.ts`; the content script reads
the combined `getSiteKeyState(host)` on load and re-applies via
`onSiteKeysChanged`. Voice is always unaffected.

`getMode()` reports `insert` whenever `forcedInsert || excluded`, so the chip and
any consumer see one "pass-through" state. Automatic field-insert stays quiet
(no chip), unchanged.

## Not doing (yet)

- Glob patterns for exclusions/passthrough — V1 matches exact `hostname`.
- Special-key passthrough (Enter/Tab/arrows) in the popup field — V1 takes
  printable characters (matched against `event.key`), which covers Gmail-style
  letter/symbol shortcuts.
