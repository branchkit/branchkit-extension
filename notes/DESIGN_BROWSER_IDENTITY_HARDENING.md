# Browser identity & focus hardening

Status: proposal (2026-06-06)

Follow-on to `DESIGN_BROWSER_IDENTITY_FOCUS_HANDSHAKE.md` ("the handshake doc").
That doc decoupled *arming* (claim-driven, unlagged) from *identity* (OS-driven,
lazy) and is the right spine. This note is about the half it left fragile: the
**identity** half still rests on wall-clock correlation of two async signals, and
the **liveness** of a binding is conflated with its existence. A night of
aggressive reload testing on 2026-06-06 walked straight into both. This note
catalogs what broke, names the root causes, and lays out candidate architectures
— from a cheap plugin-local patch to a north-star that deletes the correlation
machinery entirely. It does not pick a winner; it frames the bet.

## What already landed from the handshake doc

For grounding, the current state of that doc's mechanisms:

- Section 4 (cold-start refresh): landed. `handleFocusPost` pulls
  `native.frontmost_app` when the OS bundle is stale relative to a claim.
- Section 5 (OS-inferred release): landed. `handleAppFocused` clears
  `FocusedConnID` when the newly-focused bundle differs from the focused conn's
  bound bundle.
- Section 6 (disconnect clears the focused slot): **partially landed, and the
  divergence matters.** The SSE-close path clears `FocusedConnID`,
  `FocusedTabID`, `LastFocusConnID`, `ConnToClient[conn]`, `ConnActiveTab[conn]`
  — but **deliberately keeps `ConnBundle[conn]`** (sse.go:96-99), the opposite of
  what section 6 specified ("clear ConnBundle[conn] … it refers to a conn that no
  longer exists"). The shipped comment justifies it: a reconnect with the *same*
  `conn_id` should pick its binding back up before the next handshake.
- The `KnownBrowsers` seed (main.go ~217) was never dropped. The handshake doc
  gated dropping it on sections 4/5/6 all landing cleanly; section 6 landed
  divergently, so the seed still stands.
- New 2026-06-06: `adoptFocusedSourceLocked` — on a `/focus` rebind, re-point the
  focused source at the live conn and purge the superseded conn's grammar. Fixes
  the clean in-place extension reload (browser stays frontmost, new `conn_id`, no
  app-focus event). Confirmed working. It does **not** address anything below.

## Failure modes observed 2026-06-06

All reproduced live, evidence in `actuator.log` around 23:51–00:05. Chrome's
extension connection turned over three times (`ad93cfb0` → `54e80d0e` →
`1dfde67f`) across reloads plus a spinning tab and Chrome/Firefox/Warp switches.

| # | Symptom | Mechanism |
|---|---|---|
| 1 | Reload while focused: badge paints, command matches, nothing navigates | Stale focused source; **fixed** by `adoptFocusedSourceLocked` |
| 2 | New connection never becomes focused source; `dispatch tab=0` | Dead predecessor's `ConnBundle` binding lingers and blocks the successor |
| 3 | Warp (a terminal) registered as a browser; every Warp focus wipes Chrome's grammar | Claim-vs-OS-focus race mis-paired Chrome's conn to the Warp bundle and learned it |
| 4 | `dispatch tab=0`, projection on fallback | Focused-source globals out of sync; multi-writer ordering |
| 5 | "air bat" resolves to frame 0 then frame 3067 across reprojections | Multi-frame grammar projection drift (extension-side label routing) |

Detail on the two that are not yet addressed:

**#2 — dead binding blocks the successor.** When `54e80d0e`'s SSE dropped, the
plugin kept `ConnBundle[54e80d0e] = com.google.Chrome` (section-6 divergence). The
successor `1dfde67f` connected but happened to connect *without* a focus-claim
trigger (Chrome stayed frontmost across the reload, so no `onFocusChanged`
fired). Its only signal was an active-tab POST — and the active-tab backstop is
gated on `connForBundleLocked(bundle) == ""`, which is false because the dead
binding still answers. So `1dfde67f` never bound, `FocusedConnID` stayed empty,
`FocusedTabID` stayed 0, and every dispatch went out with `tab=0` on fallback
routing. The user was stuck with no way to recover except an app-focus change.

**#3 — the correlation mis-attributes, then poisons.** The handshake binds
`conn → bundle` when a `/focus` claim and an OS app-focus event are both fresh
within `focusBindWindow` (~1s). During a laggy Warp→Chrome transition, Chrome's
`/focus(true)` claim arrived while the OS still reported **Warp** as frontmost
(the cold-start refresh even *pulled* `native.frontmost_app` and got Warp,
because Chrome had not finished focusing). `reconcileFocusBindingLocked` paired
Chrome's `1dfde67f` with the Warp bundle and ran `KnownBrowsers[Warp] = true`.
From then on every Warp focus took the `isBrowser` branch and fired a
browser-switch cleanup that **wiped the real browser's grammar**. One sub-second
race permanently corrupted the browser set for the plugin's lifetime. This is the
same class as `project_active_tab_not_frontmost`, but via the `/focus` path the
handshake doc trusted (section 3), not the active-tab backstop it had already
hardened.

Note the irony: the recovery we reached for (switch apps and back) is what
*triggered* #3. The workaround fed the race.

## Root causes

Three architectural smells underneath the five symptoms.

**A. Liveness is conflated with the binding.** `ConnBundle[conn]` can outlive the
SSE connection it describes (kept for same-conn reconnect). So "bound" does not
imply "live," yet `connForBundleLocked` and the active-tab backstop treat any
binding as authoritative. A dead binding answers queries and blocks successors
(#2). The same-conn-reconnect optimization is legitimate — but only because
`conn_id` is *stable across an SSE blip while the SW survives*. It is **not**
stable across an SW restart: `conn_id` is minted at background module load
(background.ts:84), so any SW restart (transient idle-death *or* reload) mints a
new one. The kept binding therefore only ever helps the narrow
SSE-dropped-but-SW-alive case, and in the much more common new-`conn_id` case it
is pure dead weight that misleads.

**B. Identity rests on wall-clock correlation of two independent async streams.**
The extension claim and the OS focus event are correlated by a ~1s freshness
window. Correlating two async streams by wall-clock is inherently racy, and the
race window is exactly a focus transition — the one moment the two streams are
*expected* to disagree (lagged OS event, in-flight transition). Worse, the
correlation is used to **learn** identity (`KnownBrowsers`), so a transient
mis-pair is not self-correcting; it is permanent (#3). Cold-start refresh
(section 4) makes the common case work but widens this specific hole: pulling the
frontmost app *during* a transition freshens the OS side to the wrong answer.

**C. The focused source is a multi-writer mutable global.** `FocusedConnID`,
`FocusedTabID`, `FocusedBundleID`, `FocusedBrowserBundleID` are poked by five
handlers — `handleAppFocused`, `handleFocusPost`, `handleActiveTabPost`, the SSE
disconnect defer, and now `adoptFocusedSourceLocked` — each with its own edge
cases and ordering assumptions. `tab=0` dispatches (#4) are the visible tip:
nobody set `FocusedTabID` in the order this particular interleaving needed. Every
new fix adds another writer and another interleaving.

## Design directions

Four directions, roughly cheapest-to-deepest. They compose; A and C are
plugin-local and low-risk, B is the north star with a feasibility cost, D is the
containment play if B does not pan out.

### D1 — Liveness-gate the binding (cheap, plugin-local)

Make resolution consider only **live** bindings. A binding `ConnBundle[conn]` is
live iff `conn` has a present entry in `SSEClients` (via `ConnToClient`). Change
`connForBundleLocked` to skip dead bindings, and let the active-tab backstop fire
when the bundle's only binding is dead. Keep dormant bindings in the map so a
same-`conn_id` SSE reconnect still reclaims its binding — but a *different*
`conn_id` for the same bundle is no longer blocked or misdirected by the corpse.

This fixes #2 directly and is a small, testable change with an obvious invariant
("dead conns never answer identity queries"). It is the natural completion of
section 6: instead of *deleting* the binding on disconnect (which loses the
same-conn-reconnect win), mark it dormant and gate readers on liveness.

Open sub-question: dormant bindings still need a GC so they do not accumulate
across a long session of reloads. A sweep keyed on "no live client AND superseded
by a live binding for the same bundle" covers it.

### D2 — OS-authoritative `conn → bundle` (north star — spike passed)

**Spike result (2026-06-06): feasible.** With the extension connected to the
plugin's listen port, `lsof -nP -iTCP:<port>` resolved the established connection
to pid 15123, whose executable path is
`/Applications/Google Chrome.app/.../Helpers/Google Chrome Helper.app/.../Google Chrome Helper --type=utility`.
The connection comes from a **helper (utility) process**, not the main browser —
so the naive `pid → immediately-enclosing .app → bundle` yields
`com.google.Chrome.helper`, which would *not* match the `com.google.Chrome` the
OS focus event reports, and would silently break everything. The fix is to
resolve to the **outermost `.app` in the executable path** (or walk to the
process-tree root: ppid 15067 is `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
directly). Outermost-`.app` gave `com.google.Chrome` — exact match to the OS
bundle. The probe ran unprivileged as the user (libproc enumerates same-user
process fds without root, same as lsof). Bonus finding: this worked while Chrome
was *backgrounded* (OS frontmost was Firefox) — identity is now **focus-independent**,
which the correlation approach could never be (it can only ever label the
*focused* browser, racily).

Stop *correlating* identity and start *asserting* it. The connection is a TCP
socket on loopback (connect.json hands the extension a port). The plugin maps
that socket to the OS process that opened it and asks the OS for that process's
bundle, so `conn → bundle` is known at connect time — no claim, no OS focus
event, no wall-clock window, no learned list, fork-proof by construction.

This is the *original* problem 1 from the handshake doc ("the browser names
itself and gets it wrong") solved at the root: the browser never names itself;
the OS names it. It collapses, in one stroke, the UA table, the `KnownBrowsers`
seed *and the whole `KnownBrowsers` mechanism*, the correlation window, *and* the
#3 mis-attribution/poisoning class. "Is this bundle a browser?" stops being a
question — a conn that resolves to a real app *is* a browser running our
extension, by construction. There is no list to maintain or poison.

Implementation shape (spike-validated above):

- New native method, e.g. `bundle_for_remote_port(remote_port) -> bundle_id`.
  Lives in the native layer (`OSActuator` impl), not the actuator core — stays
  within the licensing boundary. macOS impl: `proc_pidfdinfo` /
  `PROC_PIDFDSOCKETINFO` to match the loopback 4-tuple → pid → `proc_pidpath` →
  **outermost `.app`** → `CFBundleIdentifier`. Unprivileged for same-user
  processes (confirmed via lsof in the spike).
- The plugin calls it once at SSE-accept, passing the connection's ephemeral
  remote port, and stores `assertedBundle[conn]`. That is the entire identity
  story — no `/focus`-claim correlation, no `focusBindWindow`.
- One impl detail to confirm inline (not a blocker): libproc fd enumeration of
  another same-user process without special entitlements. The spike's unprivileged
  lsof strongly indicates yes; verify in the native method.

The deletion list is the handshake doc's "what gets deleted" plus the entire
`reconcileFocusBindingLocked` correlation, `focusBindWindow`, and `KnownBrowsers`.
A large, satisfying simplification — and the spike says it is reachable.

### D3 — Derive the focused source; stop mutating it (structural)

Replace the five-writer mutable globals with a single pure recompute. Hold the
raw inputs — live connections, per-conn last claim, per-conn active tab, OS
frontmost bundle (+ each timestamp) — and compute the focused `(conn, tab,
bundle)` from them in one `recomputeFocusedSource()` called whenever any input
changes. One writer, one place, no interleaving. This is the same move that
worked for the hint family in `project_hint_lifecycle_reconciler` (convert
edge-triggered mutation into one level-triggered reconcile pass), applied to
focus. It dissolves #4 and makes #1/#2's fixes fall out of the inputs rather than
out of yet another handler. Pairs naturally with D2 (the recompute reads an
asserted bundle instead of a correlated one).

### D4 — Make `KnownBrowsers` un-poisonable (containment, if not D2)

If D2 is deferred, at least stop a transient race from permanently corrupting the
browser set:

- Never learn a browser from a *pulled* (cold-start-refresh) OS bundle — only
  from a pushed app-focus event, which implies a settled transition.
- Require the claim and OS bundle to agree across two consecutive observations,
  not one sub-second coincidence, before learning.
- Allow un-learning: a bundle the OS later confirms is *not* the bound conn's app
  can be dropped from `KnownBrowsers`.

D4 is strictly inferior to D2 (it patches the correlation instead of removing it)
and is only worth building if the D2 spike fails.

## Recommended shape

The D2 spike passed, which collapses the decision tree: **D1 and D4 are both off
the table** (D1 was the stopgap if we delayed the real fix; D4 was the fallback
if D2 failed). The plan is D2 + D3, sequenced for a clean end state (per the
project's clean-end-state-via-sequencing norm — transitional steps are fine if
the final state is simpler):

1. **Native method `bundle_for_remote_port`** (native layer). Resolve the
   loopback socket → pid → outermost `.app` → bundle id. Confirm the libproc
   privilege detail inline. Smallest standalone piece; everything else consumes it.
2. **Plugin: assert identity at SSE-accept.** Call the native method once per
   connection, store `assertedBundle[conn]`. Introduce a `bundleForConn(conn)`
   accessor — the seam that makes the rest source-agnostic.
3. **D3 — recompute the focused source.** Replace the five mutators with one
   level-triggered `recomputeFocusedSource()` over (live conns, `assertedBundle`,
   active-tabs, OS frontmost). Delete `reconcileFocusBindingLocked`,
   `focusBindWindow`, the `KnownBrowsers` seed and mechanism, and the
   extension's UA table. #2, #3, #4 cease to exist by construction.

Ship one layer at a time with a long-soak between (the orphan-teardown history
says this subsystem punishes multi-layer drops). The `/focus` claim is retained
as a pure arming latency-optimization (it lets a browser arm before the OS focus
event lands), but it is no longer load-bearing for identity.

Tonight's `adoptFocusedSourceLocked` becomes a no-op once D3 derives the focused
source from inputs — no need to revert it; it is the right behavior expressed as
a mutation that D3 re-expresses as a derivation. The dead-binding bug (#2) is not
separately fixed; it cannot occur once the recompute only ever considers live
conns.

## Step 3 — the focused-source recompute (concrete design)

Implementation status as of 2026-06-06: native method (D2 core), SSE-accept
assertion + `bundleForConn` seam, and the asserted-identity *veto* (containment)
are all shipped. The veto stops the bleeding by refusing a binding that
contradicts the OS; step 3 removes the thing being vetoed.

### The insight that kills the race

Every mispairing came from *correlating two signals about different things*: the
extension's claim ("conn X's window is focused") and the OS event ("bundle B is
frontmost"), paired by a wall-clock window. When they referred to different apps
(X is Chrome, B is the agent that just stole focus), the pairing was a lie.

Asserted identity collapses the two signals onto one referent. The `/focus`
claim no longer needs a *separate* OS bundle to pair against — the claiming
connection already carries its own OS-resolved bundle in `AssertedBundle[X]`. So:

- `/focus(X, true)` ⇒ `FocusedConnID = X`, `FocusedBundleID = AssertedBundle[X]`.
  Unlagged (rides `onFocusChanged`), and **unpairable** — it reads X's own
  identity, never another app's focus event.
- `app.focused(B)` ⇒ focused conn = the live conn whose `AssertedBundle == B`,
  or none (B is a non-browser, or a browser without our extension).

These two entry points can no longer disagree into a mispairing, because neither
correlates across referents. The Warp/CoreLocationAgent case: `/focus(Chrome)`
sets the source to Chrome via Chrome's own asserted bundle; a subsequent
`app.focused(CoreLocationAgent)` finds no conn asserting that bundle and clears
the source (Chrome genuinely isn't frontmost anymore) — it never pins Chrome's
conn to the agent.

### The recompute

One level-triggered function, `recomputeFocusedSourceLocked()`, replaces the
scattered mutations. Inputs (all already maintained):

- `FocusedBundleID` — OS frontmost bundle (from `app.focused`).
- `AssertedBundle[conn]` — per *live* conn, OS-resolved (cleared on disconnect,
  so its key set IS the live-browser set — no `KnownBrowsers` needed).
- `ConnActiveTab[conn]` — per conn active tab.

```
recomputeFocusedSourceLocked():
    osBundle := FocusedBundleID
    focusedConn := the conn c with AssertedBundle[c] == osBundle   // "" if none
    if focusedConn != "":
        FocusedConnID         = focusedConn
        BrowserFocused        = true
        FocusedBrowserBundleID = osBundle
        FocusedTabID          = ConnActiveTab[focusedConn]
        SSEClientBundles[client(focusedConn)] = osBundle
    else:
        FocusedConnID  = ""        // OS frontmost isn't a connected browser
        FocusedTabID   = 0
        BrowserFocused = false
    reprojectFocusedSourceLocked() + drive the active/hints tag transition
```

Called on every input change: `app.focused`, `/active-tab`, SSE connect/
disconnect, and asserted-bundle resolution. The `/focus` claim is kept as an
unlagged fast-path that sets `FocusedConnID = X` / `FocusedBundleID =
AssertedBundle[X]` directly (covers the Firefox >1s `app.focused` lag), then
recomputes. Arming for a freshly-connected browser waits on its async assertion
(tens of ms); an already-connected browser refocuses with no delay.

### What gets deleted

`reconcileFocusBindingLocked`, `bindConnBundleLocked`, `assertedVetoesBindLocked`
(folded away — nothing to veto), `ConnBundle`, `KnownBrowsers` + its seed,
`LastFocusConnID` / `LastFocusAt` / `FocusedBundleAt`, `focusBindWindow`, the
cold-start-refresh dance, and the extension's UA table. `adoptFocusedSourceLocked`
collapses into the recompute (a disconnect/turnover just re-derives the source).

### Migration sequencing (bisectable, one behavior change)

1. Add `recomputeFocusedSourceLocked` and route `app.focused` / `/active-tab` /
   `/focus` / SSE-accept through it, still alongside the correlation (assert the
   two agree via the existing tripwire — should be silent now that the veto
   holds).
2. Flip the readers (projection gate, dispatch scoping) onto the recomputed
   source.
3. Delete the correlation machinery and the seed in one commit — the final state
   is strictly smaller.

Each step builds and passes tests; only step 2 changes behavior, so a regression
bisects to one commit. Long-soak after step 2 before step 3's deletions, per the
orphan-teardown discipline.

## Open questions

1. ~~**D2 helper-process attribution.**~~ **Resolved 2026-06-06** (see D2 spike):
   the connection comes from a Chrome helper, but outermost-`.app` resolution
   yields `com.google.Chrome`, matching the OS focus bundle. Solvable.
2. **libproc privilege.** Does `proc_pidfdinfo` on another same-user process need
   any entitlement under the app's sandbox/hardened-runtime config? lsof says no
   for same-user; confirm inside the native method's actual entitlement context.
3. **Multi-frame projection drift (#5).** Is this an identity problem at all, or
   purely extension-side label routing (which frame owns a codeword after a
   reproject)? Likely separable; track independently unless D3 changes the
   projection inputs enough to touch it.
4. **Forks / two instances of the same engine.** Two Chrome instances, or
   Chrome + Brave: D2 distinguishes by pid → outermost `.app`, so each resolves
   to its own bundle (the correlation never could). Two windows of the *same*
   Chrome instance share a pid/bundle but are different conns only if they run
   separate extension backgrounds — they don't (one SW per profile), so this is a
   non-issue. Confirm Brave/Arc resolve to their real bundles during impl.
5. **Connection re-resolution.** Is `assertedBundle[conn]` resolved once at accept
   and cached, or re-checked? Once is correct — a TCP connection's owning pid does
   not change. Cache at accept, drop on close.
