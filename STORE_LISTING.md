# Store Listing — BranchKit Browser

Use this content when submitting to Chrome Web Store and Firefox Add-ons.

Framing rule (do not regress): **BranchKit Browser is a standalone keyboard
navigation tool.** It works fully on its own — no account, no companion app, no
network. Voice control is an *optional* add-on that activates only when the
user also runs the BranchKit desktop app. Lead every surface with the
keyboard-first story; present voice as an enhancement, never a requirement.

---

## Name

BranchKit Browser

## Short Description (132 chars max for Chrome)

Hint badges to click, type & navigate any site by keyboard. Optional hands-free voice control with the BranchKit app.

## Full Description

BranchKit Browser lets you drive the web without a mouse. Press a key, and every
clickable thing on the page gets a short hint badge — type the badge to click it,
focus a field, or open a link. Scrolling, find, history, and tab navigation are
all one keystroke away, Vim-style. It works on any website with no setup.

**Keyboard navigation (works on its own — no app, no account, nothing to sign
into):**
- `f` — show hint badges on links, buttons, and fields; type a badge to activate it
- `j` / `k` / `h` / `l` — scroll; `d` / `u` — half page; `gg` / `G` — top / bottom
- `/` then `n` / `N` — find on page and jump between matches
- `H` / `L` — back / forward; `r` — refresh
- `gi` — focus the first text field; `i` — insert mode (keys pass to the page)
- `]]` / `[[` — next / previous page; `yy` — copy the page URL
- `yf` — copy a link's URL; `yc` — copy a badge's text; `gf` — focus; `gh` — hover
- Every binding is configurable on the options page.

**Optional: hands-free voice control.** Install the BranchKit desktop app and the
same hint badges become speakable — say a badge's codeword (e.g. "arch", "beam",
"cave") through push-to-talk to click, type, or navigate, no keyboard needed.
Voice adds three quick element groups on top of the keyboard commands:
- "go" — clickable elements (buttons, links, tabs)
- "set" — form fields (inputs, dropdowns, textareas)
- "tables" — data-table navigation

**Privacy first:**
- Works entirely on your device. With no companion app, nothing leaves the
  browser at all.
- When the optional desktop app is connected, page-element data is sent only to
  that app on your own machine (localhost) — never to any external server.
- No analytics, no tracking, no browsing history or personal data collected or
  stored.

**Works with** Chrome, Edge, Arc, and Firefox.

**Open source** — inspect the code yourself.

## Category

Chrome Web Store: Accessibility
Firefox Add-ons: Accessibility

## Tags / Keywords

keyboard navigation, accessibility, hands-free, vim, voice control, hint badges,
mouseless browsing, dictation

---

## Review notes (paste into the reviewer-notes / justification fields)

### Single purpose

One purpose: **navigate and act on web-page elements without a mouse, via hint
badges** — driven by keyboard on its own, or by voice when the optional BranchKit
desktop app is present. Scrolling, find, history, and tab commands all serve that
one navigation purpose.

### How to verify with zero setup

The extension is fully functional standalone — a reviewer does **not** need the
desktop app. On any page, press `f`: hint badges appear; type a badge's letters
to click. `j`/`k` scroll, `/` finds. No sign-in, no network. The desktop app only
adds voice as an alternative input to the exact same actions.

### Comparable approved extensions

This is the same pattern as established, approved tools: **Vimium** (keyboard hint
navigation — declares `<all_urls>` host, `scripting`, `sessions`, `tabs`,
`webNavigation`, and more) and **Rango** (voice + keyboard hint navigation —
declares `activeTab`, `offscreen`, `tabs`, `webNavigation`). BranchKit requests a
**narrower** set than Rango (we do not request clipboard, contextMenus, bookmarks,
or notifications).

### Network / remote code

No remote code is loaded or executed (no `eval`, no remotely-hosted scripts;
everything is bundled at build time). The extension makes **no** outbound network
requests except, when the user has installed and connected the optional BranchKit
desktop app, to that app on `http://127.0.0.1` (localhost) on the user's own
machine. That channel carries structured action data only — never code, never
HTML that gets injected.

### Per-permission justification

| Permission | Why BranchKit needs it |
|---|---|
| `<all_urls>` (host) | Show hint badges on / read interactive elements of any page (can't predict which sites the user visits), and re-inject the content script into tabs open from before install. Element data (visible labels, CSS selectors) is used only to build hint mappings; with no app it never leaves the browser, and with the app it goes only to localhost. |
| `http://127.0.0.1/*` (host) | **Optional** — connect to the user's own BranchKit desktop app (the voice add-on) over localhost. No external servers. The extension is fully functional without it. |
| `tabs` | Route an activated hint or voice action to the correct tab; propagate badge-display setting changes to open tabs; tab-navigation commands (next / previous / most-recently-used). |
| `storage` | Persist badge display mode (word / letter / both) and the user's keymap. |
| `scripting` | Lazily inject the content script into tabs that predate install or were discarded by the browser. |
| `webNavigation` | Detect single-page-app route changes (`onHistoryStateUpdated` / `onReferenceFragmentUpdated`) so hints re-scan after client-side navigation. |
| `sessions` | The "reopen last-closed tab" command (the Ctrl/Cmd+Shift+T equivalent). |
| `alarms` | A periodic (30s) heartbeat that checks whether the optional desktop app is still connected. |
| `offscreen` (Chrome only) | Hold a persistent connection to the optional desktop app in an offscreen document — an MV3 service worker cannot keep a long-lived connection open. Not present in the Firefox build. |

Note: `activeTab` is intentionally **not** requested — `<all_urls>` host access
already covers the active tab, so requesting `activeTab` would be redundant.
