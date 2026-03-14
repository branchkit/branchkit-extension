# Privacy Policy — BranchKit Browser Extension

**Last updated:** March 14, 2026

## What the extension does

BranchKit Browser scans web pages to identify interactive elements (form fields, buttons, links, tabs) and displays voice-navigable hint badges on them. It works with the BranchKit desktop app to enable hands-free browser navigation.

## Data collected

The extension collects the following data from web pages you visit:

- **Element labels** — the visible text of buttons, links, and form field labels
- **Element selectors** — CSS selectors used to identify elements on the page (e.g., `button.submit`, `input[name="email"]`)
- **Element types** — whether an element is an input, button, link, or other interactive control

This data is used solely to generate voice command mappings so you can say a codeword to interact with a specific element.

## Where data is sent

All data is sent exclusively to **localhost** (`127.0.0.1`) — the BranchKit desktop app running on your own computer. Specifically:

- Element data is sent to the BranchKit browser plugin via HTTP on a random local port
- No data is ever transmitted to external servers, cloud services, or third parties
- No analytics, telemetry, or tracking of any kind

## Data storage

- **Badge display preference** (word, letter, or both) is stored in `chrome.storage.sync` / `browser.storage.local`
- No browsing history, URLs, page content, or personal information is stored
- No cookies are set or read

## Permissions explained

| Permission | Why it's needed |
|---|---|
| `<all_urls>` (host) | Scan interactive elements on any page for voice navigation |
| `http://127.0.0.1/*` (host) | Communicate with BranchKit desktop app on localhost |
| `tabs` | Route voice command results to the correct browser tab |
| `activeTab` | Identify which tab is currently focused for voice commands |
| `storage` | Persist badge display mode preference |
| `alarms` | Periodically check connection to BranchKit desktop app |
| `offscreen` (Chrome only) | Maintain persistent connection to desktop app |

## Open source

The extension source code is available for inspection. The BranchKit desktop app is developed by BranchKit.

## Contact

For privacy questions, contact: privacy@branchkit.dev
