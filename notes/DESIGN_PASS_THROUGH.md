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
3. **Per-site exclusion.** `setExcluded(true)` = keybinds off for this host,
   every key to the page (Escape included — the site may use it). Persisted in
   `chrome.storage.sync` under `keyExclusions` (`src/key-exclusions.ts`), toggled
   from the popup ("Shortcuts here: On/Off"), read by the content script on load
   and kept live via `onKeyExclusionsChanged`. Voice still works; re-enable from
   the popup.

`getMode()` reports `insert` whenever `forcedInsert || excluded`, so the chip and
any consumer see one "pass-through" state. Automatic field-insert stays quiet
(no chip), unchanged.

## Not doing (yet)

- Per-site **pass-only-these-keys** (Vimium's granular passkeys) — V1 is
  all-or-nothing per site.
- Glob patterns for exclusions — V1 matches exact `hostname`.
