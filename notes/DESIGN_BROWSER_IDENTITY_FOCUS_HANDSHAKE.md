# Browser identity via focus handshake

Status: proposal (2026-05-30)

## Problem

The cross-browser focus gate exists so a spoken hint command fires only in the
browser the user is actually looking at, not in a backgrounded second browser
that is also running BranchKit. The gate works by comparing two bundle IDs:

- `state.FocusedBundleID` — which app macOS says is frontmost. **Authoritative.**
  Sourced from `_platform.app.focused` (`handleAppFocused`) and primed at startup
  via `native.frontmost_app` (`primeFocusedBundle`).
- the bundle the extension **self-reports** on each grammar batch and on SSE
  connect — `browserBundleID`, computed by `detectBundleID()` in background.ts.

`detectBundleID()` is a user-agent sniff. That is the flaw. The UA string does
not name the macOS bundle, so the mapping is a hardcoded guess that is wrong for
every fork of a supported engine:

| Browser | UA contains | self-reports | real bundle |
|---|---|---|---|
| Brave | `Chrome` | `com.google.Chrome` | `com.brave.Browser` |
| Edge | `Edg` | `com.microsoft.edgemac` | (correct only by luck) |
| Firefox Nightly | `Firefox` | `org.mozilla.firefox` | `org.mozilla.nightly` |
| Vivaldi / Opera / etc. | `Chrome` | `com.google.Chrome` | various |

When the self-reported bundle disagrees with the OS bundle, the gate compares two
strings that can never match for the focused browser, and the gate rejects the
real foreground browser's grammar. Adding more rows to the UA table is a
treadmill: it breaks on the next fork and on any browser we did not anticipate.

## Insight

Only one of the two bundle IDs is broken. The OS-focused bundle is always
correct — macOS knows exactly which app is frontmost, fork or not. The bug is
entirely in the extension naming **itself**. So the fix is: **the browser never
names itself.** Identity comes from the OS; the extension only has to tell the
plugin *which SSE connection belongs to the browser that just gained focus*, and
the plugin labels that connection with the bundle the OS already reported.

This is a handshake, not a lookup. The extension asserts "this connection is
focused now"; the plugin answers "then this connection is whatever the OS says
is frontmost."

## Mechanism

### 1. Connection identity: `conn_id`

The extension cannot learn its own server-side client ID (the plugin derives it
from the SSE channel pointer, `fmt.Sprintf("%p", ch)`). So the extension mints a
stable nonce, `conn_id`, once per background lifetime, and uses it everywhere it
currently uses `bundle_id`:

- SSE connect URL: `…/events?token=…&conn_id=<nonce>` (replaces `bundle_id`)
- grammar batch POST body: `{ …, conn_id }` (replaces `bundle_id`)
- new focus POST (below): `{ conn_id, focused }`

For Chrome the EventSource lives in the offscreen document; the background owns
`conn_id` and passes it through the existing `CONNECT_SSE` message alongside
port/token. Background owns batch POSTs and focus POSTs directly. Single source,
both transports.

The plugin maps `conn_id -> clientID` at SSE connect (re-mapping on reconnect,
since the channel pointer changes). All per-connection state keys off `conn_id`'s
mapped `clientID` exactly as it keys off the SSE client today.

### 2. Focus assertion: `POST /focus`

New plugin endpoint (authenticated, same bearer token as `/grammar/batch`).
The extension posts `{ conn_id, focused: true }` when its window gains OS focus
and `{ conn_id, focused: false }` when it loses focus. Triggers in the extension:

- `chrome.windows.onFocusChanged` into a `normal` window → `focused: true`
  (and `WINDOW_ID_NONE` / non-normal → `focused: false`)
- at SSE connect, if `document.hasFocus()` is already true → `focused: true`
  (covers the cold-start case where a browser is frontmost before its SSE
  connects)

This reuses the existing focus plumbing: `onFocusChanged` at background.ts:1311
and the `windowHasFocus` window focus/blur listeners at content.ts:1451-1458.

### 3. Binding: OS bundle + focus claim, reconciled by recency

The plugin holds two timestamped facts and asserts a binding when they agree:

- `FocusedBundleID` + when it last changed (from `handleAppFocused`)
- `lastFocusClaim { conn_id, at }` (from `POST /focus … focused:true`)

A binding `conn_id -> bundle` is asserted when **both** are fresh (within a small
window, ~2s) and the OS bundle is a known browser. The bundle value always comes
from the OS; the focus claim only selects *which connection* to label. This
resolves the race in either arrival order:

- **OS event first** (`app.focused{brave}` arrives, then Brave's `/focus`):
  on the focus claim, bind `conn_brave -> brave` using the current OS bundle. ✓
- **Focus claim first** (`/focus` arrives, then `app.focused{brave}`): the claim
  is recorded but not yet bound; when the OS event lands and a fresh claim
  exists, bind. ✓

`SSEClientBundles[clientID]` becomes the *output* of this binding rather than the
self-reported input it is today. Everything downstream is unchanged in shape:

- batch gate (batch.go:489) compares `binding[conn_id]` vs `FocusedBundleID`
- `sendToFocusedClientsLocked` (sse.go:20-24) scopes dispatch by the same binding
- `buildTabPrefixState(bundleID, tabID)` gets the bound bundle
- `cleanupBundleSessionsLocked(prevBrowser, "browser_switch")` keys off the bound
  bundle on switch (handleAppFocused already drives this)

## Edge cases

- **Multi-window, same browser.** One extension background = one SSE connection =
  one `conn_id` per browser instance. Window focus changes within the same
  browser do not change the bundle, so no rebind. Tab-prefix scoping still keys
  off `tab_id` as today.
- **Tab switch vs browser switch.** Tab switch: same `conn_id`, same bound bundle,
  no rebind (existing `republishActiveTab`/tab-prefix path handles it). Browser
  switch: OS posts the new bundle, the new browser claims focus, plugin binds the
  new `conn_id`; the previous browser's binding is now stale (`binding != Focused`)
  so its batches are gated out, and `cleanupBundleSessionsLocked` wipes it.
- **Cold start.** `primeFocusedBundle` seeds `FocusedBundleID` at plugin launch.
  If a browser is already frontmost, its SSE connects and, with
  `document.hasFocus()`, immediately claims focus → binds. The launch fail-open
  (`FocusedBundleID == ""` accepts the first batch, batch.go:487) stays as the
  safety net while the handshake completes.
- **Focus on a non-browser** (Terminal frontmost). `FocusedBundleID` = Terminal,
  no connection's binding matches, every browser's batch is gated out. Correct.
- **Reconnect.** `conn_id` is stable for the background's lifetime; on SSE
  reconnect the plugin re-maps `conn_id -> clientID` and the extension re-asserts
  focus if currently focused. Binding survives or is re-established within one
  focus claim.
- **Cold gap before first claim.** A focused browser whose batch arrives before
  its focus claim has no binding yet → gated out for one batch cycle. Mitigated
  by claiming focus at connect when `document.hasFocus()`, so the binding usually
  precedes the first batch. Transient; the content script re-queues.
- **Unknown bundle never in a table.** No table exists anymore. Any
  Chromium/Gecko fork works because identity is the OS bundle, whatever it is.

## What gets deleted

- `detectBundleID()` and `browserBundleID` in background.ts (the UA table).
- `bundle_id` on the SSE URL and on the grammar batch body, replaced by `conn_id`.
- The static `KnownBrowsers` seed map's role as an identity source. `registerBrowser`
  still records observed browser bundles for the gate's "is this a browser"
  check, but those bundles now arrive from the OS (`handleAppFocused`), not from
  extension self-report.

## Scope

- Extension (branchkit-extension): mint `conn_id`, thread it through batch + SSE +
  offscreen, add `POST /focus` calls on focus transitions, delete `detectBundleID`.
- Plugin (plugins/browser, closed): `conn_id -> clientID` map, `POST /focus`
  handler, recency-reconciled `conn_id -> bundle` binding, repoint gate/dispatch/
  cleanup/tab-prefix off the binding.
- Actuator: no change. Stays generic; this is all plugin + extension.
