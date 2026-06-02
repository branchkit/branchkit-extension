# Browser identity via focus handshake

Status: proposal (2026-05-30, revised 2026-06-01 with implementation findings)

## Problem

Two separate problems live in the same place, and conflating them is what makes
this area fragile.

**Problem 1 — the browser names itself, and gets it wrong.** The cross-browser
focus gate decides whether a spoken hint command fires in the browser the user
is actually looking at, not in a backgrounded second browser also running
BranchKit. Historically the gate compared two bundle IDs:

- `state.FocusedBundleID` — which app macOS says is frontmost. **Authoritative.**
  Sourced from `_platform.app.focused` (`handleAppFocused`) and primed at startup
  via `native.frontmost_app`.
- the bundle the extension **self-reports**, computed by a user-agent sniff
  (`detectBundleID()` in background.ts).

The UA string does not name the macOS bundle, so the self-report is a hardcoded
guess that is wrong for every fork of a supported engine:

| Browser | UA contains | self-reports | real bundle |
|---|---|---|---|
| Brave | `Chrome` | `com.google.Chrome` | `com.brave.Browser` |
| Edge | `Edg` | `com.microsoft.edgemac` | (correct only by luck) |
| Firefox Nightly | `Firefox` | `org.mozilla.firefox` | `org.mozilla.nightly` |
| Vivaldi / Opera / etc. | `Chrome` | `com.google.Chrome` | various |

When the self-reported bundle disagrees with the OS bundle, the gate compares two
strings that can never match, and rejects the real foreground browser's grammar.
Adding rows to the UA table is a treadmill.

**Problem 2 — a second, hand-maintained list of browser names.** Independently of
the UA sniff, the plugin ships a static `KnownBrowsers` seed map (Chrome, Edge,
Safari, Firefox, Arc — `main.go:197`). Its job is "is this frontmost bundle a
browser at all?" It is a pure first-focus latency optimization: it arms the gate
instantly and asserts browser identity before any handshake completes. Forks are
learned dynamically by `reconcileFocusBindingLocked`, but only after the user
focuses them once. So today there are **two** lists to maintain — the UA table in
the extension and the seed map in the plugin — and a new browser needs both.

The user's framing: *"we also have this duplicate list of browsers that we're
maintaining that would have to be updated and maintained… if we make [the
handshake] load-bearing, it might simplify things."*

## The core insight: arming and identity are two different jobs

The handshake today is **coupled**: a browser's grammar only becomes matchable
once the plugin has bound its connection to a known browser bundle
(`KnownBrowsers[FocusedBundleID]`). That single coupling is the reason both lists
matter and the reason the Firefox focus lag hurts. Pull it apart:

- **"Arm the hints"** — make this browser's painted badges voice-matchable. This
  is driven by the extension's **focus claim**, which rides
  `chrome.windows.onFocusChanged` and is **not lagged**. It needs to know *which
  connection* just gained focus. It does **not** need to know the bundle name.

- **"Which bundle is this connection?"** — needed only to scope dispatch and
  projection when **more than one browser** is connected. This is driven by the
  **OS focus event**, which **can lag >1s on Firefox**. It is only consulted when
  there is contention to resolve, and it can be resolved **lazily**.

Today these are fused through `FocusedBundleID`, so the slow, fork-fragile,
list-dependent identity lookup is on the critical path of the fast, common case
(one browser, focused, painting badges). Decoupling them means:

1. The seed list and the UA table both stop being load-bearing for the common
   case. A lone browser arms on its own claim, instantly, fork or not.
2. Bundle identity is still derived from the OS (always correct), but only when
   contention actually requires it.

This is the load-bearing-handshake direction: the handshake becomes the single
source of truth for *which connection is focused*, and the OS becomes the single
source of truth for *what that connection's bundle is*. Neither is a maintained
list.

## Mechanism

### 1. Connection identity: `conn_id`

The extension cannot learn its own server-side client ID (the plugin derives it
from the SSE channel pointer). So the extension mints a stable nonce, `conn_id`,
once per background lifetime, and uses it everywhere it currently uses
`bundle_id`:

- SSE connect URL: `…/events?token=…&conn_id=<nonce>` (replaces `bundle_id`)
- grammar batch POST body: `{ …, conn_id }` (replaces `bundle_id`)
- focus POST: `{ conn_id, focused }`
- active-tab POST: `{ conn_id, tab_id }`

For Chrome the EventSource lives in the offscreen document; the background owns
`conn_id` and passes it through the existing `CONNECT_SSE` message. Single source,
both transports. The plugin maps `conn_id -> clientID` (i.e. `connId`) at SSE
connect, re-mapping on reconnect since the channel pointer changes. All
per-connection state keys off the mapped `connId` exactly as it does today.

### 2. Focus assertion drives arming: `POST /focus`

The extension posts `{ conn_id, focused: true }` when its window gains OS focus
and `{ conn_id, focused: false }` when it loses focus:

- `chrome.windows.onFocusChanged` into a `normal` window → `focused: true`
  (`WINDOW_ID_NONE` / non-normal → `focused: false`)
- at SSE connect, if `document.hasFocus()` is already true → `focused: true`
  (cold-start: a browser frontmost before its SSE connects)

The claim is **unlagged** — it comes straight from `onFocusChanged`, not from the
macOS app-focus event the plugin receives. On a `focused: true` claim the plugin
immediately marks `FocusedConnID = conn`, which is all the Option B focused-source
projection needs to arm that connection's grammar. **No bundle name is required
to arm.** This is what lets a lone browser — including any fork — become
matchable the instant it claims focus, with no seed, no UA table, no lag.

### 3. Bundle identity is resolved lazily from the OS

The plugin holds two timestamped facts:

- `FocusedBundleID` + when it last changed (from `handleAppFocused`, OS-sourced,
  authoritative, may lag).
- `lastFocusClaim { conn_id, at }` (from `POST /focus … focused:true`, unlagged).

A binding `conn_id -> bundle` is asserted when **both** are fresh (within
`focusBindWindow`, ~1s) — the bundle value always comes from the OS; the claim
only selects *which connection* to label. This resolves the race in either order:

- **Claim first** (the common, unlagged path): arm immediately on the claim. When
  the OS event lands within the window, label the already-armed connection. The
  user is matching badges during the gap; identity catches up silently.
- **OS event first**: record the bundle; on the next claim, bind.

Crucially, **arming does not wait for the binding.** The binding only gates the
*multi-browser* and *multi-tab* scoping decisions (below). A connection that is
armed but not yet bound behaves exactly like a single connected browser — which
is correct, because until a second browser's bundle is known there is no
contention to scope against.

`reconcileFocusBindingLocked` remains the **only** path that registers a
newly-observed bundle as a browser (the wall-clock-gated `/focus`-claim path).
The active-tab backstop must never register a new bundle — an active-tab POST
proves a connection is *alive*, not *frontmost* (see
[[project-active-tab-not-frontmost]], the bug fixed 2026-06-01).

### 4. Cold-start refresh: claim re-primes a stale OS bundle

The §3 race resolution assumes both signals fire within `focusBindWindow` of
each other. There is one case where they don't: the plugin is launched while a
browser is already OS-focused, so no `_platform.app.focused` event ever fires —
the bundle is stable, the OS has nothing to emit. `primeFocusedBundle` seeds
`FocusedBundleID` at boot, but `FocusedBundleAt` is then the boot time, which
ages out of the window long before the user's first focus interaction. When
the extension's SSE connect then posts a `focused: true` claim (via the
`document.hasFocus()` path in §2), the OS bundle is stale relative to the
claim and `reconcileFocusBindingLocked` rejects the otherwise-correct binding.

The fix is symmetric with §2: a fresh claim re-primes the OS side. On a
`focused: true` claim, if `FocusedBundleAt` is older than `focusBindWindow`,
synchronously call `native.frontmost_app` and refresh `FocusedBundleID` /
`FocusedBundleAt` before reconciling. The wall-clock window stays the single
freshness invariant; the only change is that the bundle side can be re-queried
on demand when a claim arrives with no recent OS event to pair against.

This closes the only path by which the seed was load-bearing rather than an
optimization. Without it, dropping the seed strands cold-start arming — the
exact masking the design exists to escape. With it, the cold-start case
behaves identically to a normal claim-then-OS-event sequence, just with the
"OS event" sourced via pull instead of push.

### 5. Release inferred by the plugin, not asserted by the extension

The weak link in making the handshake load-bearing is the **release** (blur)
signal. Today `focused: false` is a best-effort `fetch` from `onFocusChanged`
under MV3, where the service worker may already be suspending — so a browser can
blur without a clean release POST ever landing. The pre-fix symptom of a missed
release is exactly what we hit on 2026-06-01: a stale binding pinned the wrong app
as the focused browser.

The robust source of release is the one the plugin **already owns**: the macOS
app-focus event. When `handleAppFocused` reports a new frontmost bundle, the
plugin can infer that the *previously* bound connection is no longer focused,
without waiting for the extension's `focused: false`:

- On `app.focused{X}`, clear `FocusedConnID` if the previously focused connection's
  bound bundle ≠ X. The extension's `focused: false` becomes a redundant
  fast-path hint, not the authority.
- A focus *claim* still arms; a focus *release* is derived from the OS telling us
  someone else is frontmost. This makes the plugin tolerant of a dropped
  `focused: false` — the next OS focus event reconciles it.

This is the prerequisite for dropping the seed: the seed currently masks
release-signal gaps because a re-focus of a seeded browser re-arms via
`KnownBrowsers` regardless of binding state. Without the seed, release must be
reliable on its own, and OS-inferred release provides that.

### 6. Connection lifecycle clears the focused slot

§5 covers the case where focus moves to another app while the focused conn is
still alive. There is a third case: the **focused conn itself goes away** —
browser closed, BranchKit restarted, extension reloaded mid-session, SSE
channel reset. Today nothing clears `FocusedConnID` when its conn disconnects,
so a defunct conn ID can stay in the focused slot indefinitely. The next time
*any* browser sends a grammar batch, the plugin compares the live conn against
the stale slot, finds they disagree, and stores the batch as "non-focused" —
projection skips it, the canonical per-prefix collections stay empty, and any
hint command falls through to whatever pattern matches the codeword globally
(e.g. `<keys:keys|alphabet>` → letter press).

This is the actual root cause of the 2026-06-01 hint-misfire incident: a stale
`FocusedConnID` left over from an earlier browser session caused every Firefox
grammar batch to be stored "non-focused" for 2+ minutes, until an unrelated
app-focus event happened to re-bind the slot.

The fix is plugin-local and trivial: on SSE channel close, if the closing conn
matches `FocusedConnID`, clear it (and clear `FocusedTabID`, `ConnBundle[conn]`,
`ConnActiveTab[conn]`, `SSEClientBundles[client]` while we're at it — they all
refer to a conn that no longer exists). The next focus event from any live
browser will re-establish the focused slot legitimately.

This closes a gap §5 doesn't reach: §5 fires on **app-focus changes**, which
don't always coincide with conn lifecycle. A user can quit Chrome while
Firefox stays focused — no app-focus change, but Chrome's conn has gone away.
Without §6, Chrome's conn keeps the focused slot until something else triggers
release. With §6, the SSE close itself is the signal.

The interaction with §5 is clean: if both fire (focused conn disconnects AND
app focus shifts at the same time), they both clear the slot, idempotent. No
ordering dependency.

## Behavior of each handshake consumer during the binding window

Four things depend on the handshake. The decoupling changes *when* each is
gated, so each is enumerated for the window between "claim arrives" and "binding
asserted":

1. **Multi-browser grammar projection** (`projectionSourceLocked` /
   `reprojectFocusedSourceLocked`, batch.go). Gated on `FocusedConnID`, set by the
   **claim** — so it arms immediately, no binding needed. With one browser the
   fail-open (`FocusedConnID` falls back to the batch's own conn) already covers
   it. **Not blocked by the window.**

2. **Multi-browser dispatch scoping** (`sendToFocusedClientsLocked` /
   `SSEClientBundles`, sse.go). Needs the **bundle** to route a dispatch to the
   right browser's clients. During the window the bundle may be unset; the
   existing fallback is a full broadcast to all connected clients. With one
   browser this is correct (the broadcast reaches the only browser). With two
   browsers mid-window, a dispatch could briefly reach both — bounded to the
   sub-second window and only when a second browser is connected *and* a dispatch
   fires in that window. Acceptable; same exposure as today's seed-miss on a fork.

3. **Multi-tab projection scoping** (`FocusedTabID`). Set from the active-tab POST
   on the focused connection. Independent of bundle identity — keys off
   `conn_id` + `tab_id`. **Not blocked by the window.** This is now the sole
   multi-tab clobber guard (the extension posts every tab's grammar freely; the
   plugin's `FocusedTabID` does the narrowing — background.ts:1035).

4. **Fork gate-arming** (registering a never-before-seen bundle as a browser).
   Happens on `reconcileFocusBindingLocked` when claim + OS bundle agree. This is
   the one consumer that *should* wait for the binding — it is the moment we learn
   "this fork is a browser." It is no longer needed to *arm* (consumer 1 already
   did, claim-driven); it only records the bundle for future multi-browser scoping.

Summary: arming (1, 3) is claim-driven and never waits. Identity-scoped
dispatch (2) and fork-learning (4) consult the binding but degrade to
broadcast / one-cycle-late, never to a wiped grammar. The pathological case the
old coupling created — a missed/wrong binding *wiping* the focused browser's
grammar — is gone, because grammar arming no longer routes through the bundle.

## Handling the Firefox >1s first-focus lag without the seed

The seed's only real value was making the first focus of a *seeded* browser
instant despite the macOS app-focus event lagging >1s on Firefox. With arming
decoupled from identity:

- The lag now only delays *bundle labeling*, not arming. Firefox arms on its
  unlagged claim; badges are matchable immediately.
- During the lag, Firefox behaves as a single armed-but-unbound browser. If it is
  genuinely the only browser, that is fully correct. If a second browser is also
  connected, dispatch falls back to broadcast for the lag window (consumer 2) —
  the same bounded exposure described above.
- When the OS event finally lands, the fresh claim is still on record
  (`lastFocusClaim`), so the binding asserts and multi-browser scoping tightens.

So the lag stops being a correctness problem and becomes an invisible
identity-settling delay. The seed is no longer buying instant arming — the claim
already does — which is what makes it safe to drop.

## What gets deleted

- `detectBundleID()` and `browserBundleID` in background.ts (the UA table).
- `bundle_id` on the SSE URL and grammar batch body, replaced by `conn_id`.
- The static `KnownBrowsers` seed map (`main.go:197`). Its "is this a browser"
  role is replaced by bundles observed through `reconcileFocusBindingLocked`
  (OS-sourced). **Prerequisites:** cold-start refresh (mechanism §4) and
  OS-inferred release (mechanism §5) and disconnect-clears-slot (mechanism §6)
  must all land first — the seed currently masks the cold-start arming gap,
  dropped-release gaps, AND stale-conn-survives-disconnect gaps.

## Open questions / sequencing

1. **Three gating dependencies before the seed drops.** Cold-start refresh (§4)
   closes the only path where the seed is load-bearing rather than an
   optimization; OS-inferred release (§5) closes the dropped-`focused:false`
   strand; disconnect clears (§6) closes the conn-died-while-focused strand.
   Land §4, §5, §6, then drop the seed — in that order. §4–§6 can land
   together since they're plugin-local and don't depend on each other.
2. **Two forks of the same engine, both connected, before either binds.** Bounded
   broadcast window (consumer 2). Likely acceptable; flag for a soak test rather
   than a new mechanism.

## Scope

- Extension (branchkit-extension): mint `conn_id`, thread through batch + SSE +
  active-tab + offscreen; add `POST /focus` on focus transitions; delete
  `detectBundleID`.
- Plugin (plugins/browser, closed): `conn_id -> connId` map; `POST /focus`
  handler that arms `FocusedConnID` on claim; recency-reconciled lazy
  `conn_id -> bundle` binding; cold-start refresh in `handleFocusPost`;
  OS-inferred release in `handleAppFocused`; SSE-close clears focused slot
  (§6); repoint dispatch/cleanup off the binding; remove the seed (last,
  after §4, §5, §6).
- Actuator: no change. Stays generic; plugin + extension only.
