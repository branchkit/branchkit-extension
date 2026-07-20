# Privacy Policy — BranchKit Browser Extension

**Last updated:** July 19, 2026

## What the extension does

BranchKit Browser is a keyboard navigation tool. It scans web pages to identify
interactive elements (links, buttons, form fields, tabs) and draws hint badges on
them so you can click, type, and navigate without a mouse. It works entirely on
your own device.

Voice control is an **optional** add-on: if you also install the BranchKit desktop
app, the same badges become speakable. The extension is fully functional without
the app — everything below distinguishes the two cases.

## Data sent off your device

**None.** BranchKit Browser makes no outbound network requests to any external
server, ever. There are no analytics, no telemetry, and no tracking of any kind.

- **Without the desktop app:** all element scanning happens in the page and nothing
  leaves the browser at all.
- **With the optional desktop app connected:** element data (below) is sent only to
  the BranchKit app running on **your own computer** (`http://127.0.0.1`,
  localhost) — never to any remote server or third party.

## Data read from web pages

To draw hint badges and build voice command mappings, the extension reads, from
pages you visit:

- **Element text** — the visible text of buttons, links, and form-field labels
- **Element selectors** — CSS selectors used to locate elements (e.g., `button.submit`)
- **Element types** — whether an element is an input, button, link, or other control

This data is used solely to map a badge (or spoken codeword) to the element it
points at. It is processed transiently, is not collected or stored by us, and —
per the section above — never leaves your device except to the optional local app.

## Data storage

- **Preferences only** — your badge display mode (word / letter / both) and your
  keymap are stored in the browser's extension storage (`storage.sync` /
  `storage.local`).
- No browsing history, URLs, page content, or personal information is stored.
- No cookies are set or read.

## Permissions explained

| Permission | Why it's needed |
|---|---|
| `<all_urls>` (host) | Draw hint badges on / read interactive elements of any page for keyboard and voice navigation |
| `http://127.0.0.1/*` (host) | *Optional* — communicate with the BranchKit desktop app on localhost (voice add-on only) |
| `tabs` | Route a navigation action to the correct tab; propagate display-setting changes |
| `storage` | Persist badge display mode and keymap preferences |
| `scripting` | Inject the badge script into tabs that predate install |
| `webNavigation` | Detect single-page-app route changes to re-scan hints |
| `sessions` | Reopen the most-recently-closed tab (the "restore tab" command) |
| `alarms` | Periodically check whether the optional desktop app is still connected |
| `offscreen` (Chrome only) | Maintain the persistent connection to the optional desktop app |

## Open source

The extension source code is available for inspection. The optional BranchKit
desktop app is developed by BranchKit.

## Contact

For privacy questions, contact: privacy@branchkit.dev
