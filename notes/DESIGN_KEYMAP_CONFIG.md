# Design: User-Configurable Keymap (GUI-first, self-documenting)

**Status:** Scoping + implementation plan, 2026-06-17. No code yet.
**Goal:** Make the extension's in-page keyboard commands user-rebindable through a **GUI editor** — pick a command from a searchable dropdown, capture a key, set typed params via UI controls. Modern and self-documenting; explicitly *not* a Vimium-style text config.

## Scope boundary

- **In:** the browser extension's content-script keybinds (`CommandRegistry` in `content.ts`, matched by `KeyHandler`).
- **Out:** OS hotkeys (Option+G/T, owned by the Swift shell / actuator) and **voice** binding (resolves via the actuator matcher + collections). Keyboard-only.

## Why GUI-first (not text config)

Vimium/Tridactyl ship *text-only* keymaps because they predate good in-extension settings UIs; Surfingkeys went all-in on raw JS (arbitrary code = security + complexity). We have a fixed command vocabulary and a real options page, so the modern pattern fits: **command-first + key-capture + typed params**, like VS Code's keybindings editor, `chrome://extensions/shortcuts`, and Raycast — GUI primary, optional JSON for backup. Self-documenting: you browse commands with descriptions and *see* what params each takes, instead of memorizing syntax.

## Components

### 1. Command catalog (`command-catalog.ts`) — the keystone
Declarative metadata for every command; powers the editor dropdown, the param controls, the `?` cheat-sheet, and validation. Shape:
```
{ id, label, group, description, mappable: boolean, params: ParamSchema[] }
ParamSchema = { name, type: 'number'|'enum'|'string', options?, min?, max?, default? }
```
Concrete (from the current handlers):
- No-param (most): `scroll_down/up`, `scroll_half_down/up`, `scroll_top/bottom`, `scroll_left/right`, `cycle_scroll_target`, `show_hints`, `show_hints_newtab`, `hide_hints`, `toggle_hints`, `activate_first_visible`, `find_open/close/next/previous`, `next_tab`, `previous_tab`.
- Param, mappable:
  - `scroll` — `direction` enum(up/down/left/right), `amount` enum(step/half/page), `count` number.
  - `scroll_to_percent` — `percent` number [0,100] default 50.
  - `show_hints_category` — `category` enum(link/button/input/tab/edit/view/tables).
- **Not mappable** (runtime values, marked `mappable:false`, hidden from the editor): `activate_hint` (codeword), `find_immediate` (query), `scroll_to_element` (page selector).
- New: `show_help` (the `?` cheat-sheet) and `toggle_hints` becomes the home of the hide chord (below).

### 2. Default keymap + structured store
- `DEFAULT_KEYMAP`: the current hardcoded `registry.add(...)` set (content.ts ~798–816 + Shift+H/L), moved into a constant of `{ keys, command, params? }`.
- `keymap-storage.ts`: **mirror `badge-settings-storage.ts` / `domain-rules-storage.ts`** — `loadKeymap()`, `saveKeymap()`, `onKeymapChanged()`, `DEFAULT_KEYMAP`, on `chrome.storage.sync`. Store the **full effective map** (defaults + user edits) as a structured array — simplest for the GUI (the editor reads/writes objects, no parsing). Optional JSON export/import for backup/sharing (not the primary path).

### 3. Data-driven registry, then modifier-aware routing (split)
This splits into a low-risk half (landed) and the load-bearing half (deferred to land *with* the editor):

**3a — data-driven registry (DONE, Phase 1).** `CommandRegistry.replaceAll(entries)`; `content.ts` builds the registry from `DEFAULT_KEYMAP` instead of hardcoded `registry.add` calls. **No routing-semantic change** — bindings still match on `e.key` tokens (`"F"`, `"gg"`, `"/"`), so all 34 keyboard tests stay green. This is what lets a future editor rebuild bindings (`onKeymapChanged` → `replaceAll`). The hide chord + `Ctrl+Alt+A` stay special in the keydown listener for now.

**3b — modifier-aware routing (DEFERRED, lands with the editor/storage).** Today `handleKeyDown` early-returns on Ctrl/Alt/Meta and the registry matches on `e.key` (so `Ctrl+H` ≡ `h`); only Shift+letter and bare keys reach the registry. To bind arbitrary modifier combos from the GUI:
- **Canonical key tokens via `event.code`** (layout-independent), reusing `key-combo.ts` (`comboFromEvent`/`serializeCombo` → `"ctrl+KeyF"`, `"shift+KeyH"`, `"KeyG"`); generalize to **sequences** (`"KeyG KeyG"`). This migrates `DEFAULT_KEYMAP` off the legacy `e.key` tokens.
- **Routing (one rule):** lowercase letter while hints visible → codeword filter (unchanged); **everything else → the command registry**; matched → run, unmatched → `return false` → falls through to other extensions (preserves Vimium-C pass-through for `Ctrl+H`, `<`, `>`, etc.).
- **The hide chord stops being special** — a default keymap entry (`ctrl+KeyF` → `toggle_hints`), rebindable; the editor/store replaces the standalone `hintHideKey` config + `getHintHideKey()`. **Only `Ctrl+Alt+A` (dev snapshot) stays hard-coded** ahead of the registry.
- **Why deferred:** this changes live routing (every keyboard test switches from `e.key` to `event.code`) and supersedes the shipping `getHintHideKey()` config, so it must land where it's testable end-to-end with a manual always-mode pass — i.e. alongside the editor + storage, not as a blind refactor.

### 4. Key-capture + validation (reuse + generalize `key-combo.ts`)
- Capture widget: "Press a key" → `comboFromEvent` → `serializeCombo`; display via `comboDisplay`.
- Generalize `isComboAllowed` → **bindability for always-mode**: allow modifier combos, **Shift+letter**, non-letter keys, sequences; **warn (don't hard-reject) on a bare lowercase letter** ("types codewords in always-mode — use a modifier or uppercase"); flag conflicts (two commands on one key) and reserved (`Ctrl+Alt+A`).

### 5. GUI editor (options page) — mirror the domain-rules editor
The options page is vanilla JS + `<template>` cloning. The **domain-rules editor** (list of structured entries with `kind-select`/`matcher-type` dropdowns, add/edit/delete, `syncKindUI` show/hide of dependent controls, drag-reorder, validation) and the **badge-settings form** (debounced save + `onChanged`-echo guard + reset) are the exact precedents. A new "Keyboard shortcuts" section:
- One row per binding (HTML `<template>`, like `rule-template`): **command** searchable dropdown (grouped by catalog `group`, label + description); **key** capture widget; **param controls** rendered from the command's schema and shown/hidden on command change (the `syncKindUI` pattern) — number input for `percent`, enum dropdown for `category`/`direction`/`amount`.
- Add / edit / delete; live validation + the always-mode warning; "reset to defaults". Persist via `keymap-storage` with the badge-settings `onChanged`-echo guard.

### 6. `?` cheat-sheet
`show_help` command → a content-script read-only overlay listing the **effective** keymap grouped by catalog `group` (key + label + description). Always reflects current bindings. (`?` is itself a default binding.)

## File map

New: `src/command-catalog.ts`, `src/keymap-storage.ts`, `src/help-overlay.ts` (the `?` overlay), `options.html` keymap section + row template.
Touched: `src/dispatcher.ts` (`CommandRegistry.replaceAll`, canonical match), `src/activate/keyboard.ts` (modifier-aware routing/`keyToString`), `src/activate/key-combo.ts` (sequences + generalized bindability), `src/content.ts` (build registry from keymap; drop the hardcoded `registry.add` block + the hide-chord special-case; wire `onKeymapChanged`), `src/options.ts` (editor section).

## Phased plan

- **Phase 0 — data (DONE):** `command-catalog.ts` (metadata + param schemas for all 26 actions) and `DEFAULT_KEYMAP` (extracted from content.ts). Pure data; `command-catalog.test.ts` asserts the catalog covers exactly the registered actions, mappable flags are correct, and the extracted defaults match content.ts.
- **Phase 1 — data-driven registry (DONE):** `CommandRegistry.replaceAll` + build the registry from `DEFAULT_KEYMAP` in content.ts (replacing the hardcoded `registry.add` block). **No routing change** (still `e.key` tokens; hide chord + Ctrl+Alt+A stay special). `dispatcher.test.ts` covers `replaceAll`; all 819 tests green. Foundation for the editor — but no user-visible change yet.
- **Phase 2 — modifier-aware routing + storage + editor:** the deferred §3b routing migration (canonical `event.code` tokens + sequences, route modifier combos through the registry, fold the hide chord into the keymap) lands here, **with** `keymap-storage.ts` and the options-page editor (rows, command dropdown, key-capture, schema-driven param controls, validation + always-mode warnings, reset) and `onKeymapChanged` → `replaceAll`. Bundling them means the routing change ships where it's testable end-to-end. **Gate: a manual always-mode keyboard pass before merge** (lowercase→filter, Shift/modifier/non-letter→commands, unbound→Vimium-C fall-through, hide chord still toggles).
- **Phase 3 — polish:** `?` cheat-sheet overlay; JSON export/import; conflict/shadow badges in the editor; drag-reorder; per-`when` scoping if ever needed.

## Risks / open questions

- **Routing migration is the load-bearing change** — moving modifier combos into the registry and `e.key`→`event.code` canonical tokens must preserve: lowercase codeword typing, Shift+letter commands, and unbound-combo pass-through to Vimium-C. Heavy unit coverage + a manual always-mode pass before merge.
- **Sequences** (`gg`, future multi-key) generalize `key-combo` from single-combo to combo-sequences — scope carefully; single-combo binds (the common case) first.
- **Order semantics** — the registry matches first-wins + partial (timeout) for sequences; the editor's row order may matter, or we dedupe by key. Decide in Phase 2.
- **Param UI breadth** — only 3 mappable param commands today; keep the schema renderer minimal (number + enum) and grow as commands gain params.

## Non-goals
Voice command binding (actuator-side), OS hotkeys (Swift shell), and arbitrary-JS commands (Surfingkeys-style) are out — this is a fixed-vocabulary, GUI-bound keyboard keymap.
