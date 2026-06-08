# Command Discoverability ("?" help)

**Status:** Proposal. Direction not yet chosen — see "Open Decision".

A "what can I say here?" surface, inspired by Vimium / Vimium-C's `?`
help dialog. Investigated 2026-06-08 while wrapping up the cascading
domain-rules work.

## How Vimium-C does it (reference)

The help dialog is an **in-page injected overlay**, not a separate
window. The content script draws a centered, style-isolated panel into
the current page:

- `front/help_dialog.html` — a `<div id="HDlg" class="R Scroll UI">`
  positioned `top: 52px; left: calc(50% - 479px)`, triggered by
  `kFgCmd.showHelpDialog` (`content/commands.ts`).
- `.R { all: initial }` is the style-reset trick so the host page's CSS
  can't bleed into the panel.
- The exclusions editor itself is a *separate* surface — it lives in
  both the toolbar popup (`pages/action.html`) and the options page
  (`pages/options.html`), sharing one `#exclusionRules` component. That
  popup/options split is the model BranchKit's domain-rules UI already
  follows.

So: the help dialog and the rules editor are two different things. The
help dialog is read-only reference content injected over the page.

## The data-boundary problem

A genuine command cheatsheet wants to list the voice commands available
right now: `scroll down`, `back`, `new tab`, category filters
(`links`, `buttons`, `tables`), `click <codeword>`, etc.

The extension does NOT have those command phrases. The boundary:

| Data | Owner |
|------|-------|
| Hint codewords + their elements (`store.all`) | extension |
| Element categories (`link`/`button`/`input`/`tab`/`edit`/`view`/`tables`) | extension (closed `Category` type) |
| Domain rules in effect | extension |
| Connection status, hint mode, label mode | extension (already in popup) |
| **Voice command phrases** (what words trigger what) | **browser plugin + actuator** |

The extension *receives* commands (`show_hints_category`, `show_hints`,
`activate_hint`, …) but never the vocabulary that maps spoken words to
them. That lives in `plugins/browser/` and the actuator command
registry.

This means a true command cheatsheet is a cross-boundary feature, and
arguably a platform one — the right home for "all active commands in
this context" is the actuator / Discovery HUD (see the app repo's
`notes/DESIGN_DISCOVERY_DECOUPLING.md`), which already owns the active
command set across every plugin, not just the browser.

## Approaches

### A. Extension-local overlay (small, self-contained)

In-page overlay (Vimium-C mechanism) listing only what the extension
knows: the hint categories present on the page, the domain rules in
effect, and connection/mode status. Testable today, no cross-repo work.

Weakness: with hints already always-visible (this user's setup), an
overlay of active hints is largely redundant, and it still can't show
the voice command phrases — the actual question being asked.

### B. Platform-sourced overlay (the real cheatsheet)

The actuator/HUD surfaces the active command set for the current
context; the extension (or any plugin's surface) renders it. This is
the honest "what can I say here" across all plugins, context-aware, and
it reuses the in-page overlay mechanism only for presentation. Bigger:
needs a platform command-enumeration endpoint and ties into the
Discovery HUD decoupling track.

### C. Static reference on the options page

A help section documenting the browser plugin's commands as authored
text. Easiest, but static and not context-aware, and it rots when the
plugin's vocabulary changes — the same maintenance smell that got
seed-default rules rejected (Decision #3 in the domain-rules design).

## Open Decision

A is shippable now but marginal for a hints-always-visible user. B is
the feature actually being asked for but is platform-scoped. C is cheap
but carries a known rot smell.

Recommendation: **B**, scoped as its own platform design pass (active
command enumeration + a generic overlay renderer), rather than bolting a
limited version onto the extension. Confirm direction before building.
