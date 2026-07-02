# Design: Extension Connection Health

**Status:** Proposal (2026-07-02). Motivated by the same-day incident below. Two shippable pieces (visibility, harness isolation) plus a diagnosis-gated addendum (the wedge itself).
**Goal:** A dead extension↔BranchKit link should announce itself within seconds, on both sides of the wire — and test harnesses should never join a live session uninvited.

## The incident (2026-07-02)

After a rebuild of `dist/` while real Chrome had the unpacked extension loaded, the extension went fully dark: no SSE connection, no reconnect for 20+ minutes despite the retry ladder and the 30s alarm. The user diagnosed it by pressing Ctrl+S into a void. The platform *knew* the whole time — the browser plugin logged `app focused bundle="com.google.Chrome" is_browser=false` on every Chrome focus, i.e. "the frontmost app is a browser that had a live connection earlier this session and now has none" — but no surface showed it. Separately, a Playwright harness run connected its Chrome-for-Testing to the live plugin, claimed OS focus via the handshake, and projected fixture-page grammar + tab words into the global collections for ~25 seconds, deprojecting the user's real browser mid-session.

Three failure classes, three owners:

1. **Silent dead link** — this note, piece A.
2. **Harness pollution** — this note, piece B.
3. **The wedge mechanism itself** — addendum, gated on evidence (what chrome://extensions actually showed). The adjacent F5-after-reload and auto-update questions stay owned by DESIGN_EXTENSION_RELOAD_SURVIVAL.md; nothing here duplicates them.

## A. Connection-state visibility

Two layers, one per side of the wire, so either side dying is visible from the other.

### A1. Extension side: toolbar icon state

Drive `chrome.action.setBadgeText`/`setBadgeBackgroundColor` (Firefox: `browser.action`) from the existing connection state machine — the same transitions that already flip `bgState.branchkitConnected` (`onSSEConnected` / `onSSEDisconnected` / `HEALTH_STATUS`). No new state tracking; the badge is a projection of state we already maintain.

**Framing is load-bearing:** standalone (no BranchKit) is a first-class mode — hints + keyboard work without the host by design (PLAN_EXTENSION_INDEPENDENCE.md). So the badge vocabulary is *state, not error*:

- **Connected:** small colored dot (or "•"), the quiet good state.
- **Standalone:** no badge at all. A user who never installs BranchKit never sees connection chrome of any kind.

The distinction between "standalone by choice" and "standalone because the host just vanished" is deliberately NOT drawn here — the extension can't tell them apart, and guessing produces false alarms. That distinction belongs to the side that can tell: the plugin (A2).

Cost: ~20 lines in the SW. No content-script involvement, no polling — transitions only. The popup's existing `GET_HEALTH` readout stays as the detail view.

### A2. Plugin side: stale-disconnect tripwire

The browser plugin (NOT the actuator — this is browser behavior) gains a per-session memory of which bundles have ever held a live connection: a `SeenBundles map[string]bool` populated where `AssertedBundle` is written (`resolveAssertedBundle`). Then, in `handleAppFocused`:

- Frontmost bundle is in `SeenBundles` but `connForAssertedBundleLocked` finds no live conn → arm a one-shot timer (grace period ~10s, generous enough for the SW retry ladder and the 30s-alarm respawn path to win the race on a routine reconnect).
- Timer fires with still no conn for that bundle → emit once per episode:
  - `Warn`-level log line (`[FOCUS] extension disconnected bundle=%q for >10s — reload at chrome://extensions`) so it crossposts to actuator.log per the plugin-logging-v2 threshold rules;
  - `browser.extension_disconnected` event on the bus (observability surfaces get it for free);
  - a HUD nudge with the remediation text, via whatever notification channel exists at implementation time — if none fits, v1 is the Warn + a health row on the browser plugin's settings tab ("Chrome — disconnected since 04:25, reload at chrome://extensions") and the toast is v2. Do not build a new notification primitive for this.
- Conn for that bundle returns → clear the episode; the next disconnect re-arms.

Why episode-scoped and focus-driven rather than a background poller: the moment the user *looks at* the broken browser is exactly the moment the nudge is actionable, and `handleAppFocused` already fires there. No steady-state cost, no timers ticking for browsers the user isn't using.

Together A1+A2 cover both directions: host dies → extension badge drops to standalone; extension dies → plugin nudges on next browser focus.

## B. Harness isolation

**Rule (already in force, recorded in session memory): never run the Playwright harness against a running BranchKit mid-session.** This section makes the rule structural instead of behavioral.

Mechanism: a `branchkit_discovery_disabled` flag in `chrome.storage.local`, checked at the single choke point `discoverPlugin()` (all connection paths — `ensureConnected`, the SSE retry ladder, `init` — funnel through it). Flag set → `discoverPlugin` returns false immediately; the extension is deterministically standalone. A storage flag beats a build define because the harness loads the same `dist/` artifact the user does — no second build flavor to drift.

Enforcement lives in the scripts, not in convention:

- A shared launch helper for the `scripts/_test-*.mjs` family (they already seed `alphabet` / `hintVisibility` via `sw.evaluate` — same hook) that sets the flag **by default** before any navigation. Individual scripts opting into live-plugin behavior (e.g. `_test-active-tab-gate.mjs`) pass `{allowDiscovery: true}` explicitly.
- Pre-flight tripwire in the helper: if discovery is allowed AND `http://127.0.0.1:21551` answers, refuse to run unless `BRANCHKIT_ALLOW_LIVE=1` is set, printing why. An opted-in test hitting a *live user session* is exactly the incident; make it a conscious act.

Non-goal: plugin-side rejection of `com.google.chrome.for.testing` by bundle id. A denylist of browser identities in the plugin is the wrong layer (forks are legitimate; the identity-hardening work deliberately trusts OS-asserted bundles) and would break the opted-in gate tests.

## Addendum: the wedge (diagnosis pending)

Hypothesis for the 2026-07-02 outage: MV3 service workers idle-terminate and re-read their JS from disk on respawn. `npm run build` swapped `dist/chrome/*` under the loaded extension; the SW respawned into a mixed generation (new `background.js` against the old loaded manifest, or a mid-write file) and errored terminally — a state the retry ladder can't see because there is no running SW to retry from.

Evidence needed before designing: the chrome://extensions error banner (or absence of one) from the actual incident, and whether `chrome://serviceworker-internals` showed start failures. If confirmed, candidate fixes, smallest first:

1. **Atomic dist swap** — `scripts/build.mjs` writes to `dist/.chrome.tmp` and renames into place, closing the mid-write window.
2. **Build↔reload coupling** — bare `npm run build` pings the dev-reload websocket (port 35729) when a watcher is listening, so "files changed" and "extension reloaded" can't be separate events. (The version-skew window — SW respawn between an out-of-band build and any reload — only closes this way; atomicity alone doesn't.)

If the banner shows something else entirely, revisit — don't ship fixes for an unconfirmed mechanism.

## Sequencing

1. **B** first: smallest, and it removes a live-session hazard that recurs every time an agent or the user runs the harness.
2. **A1** next (trivial), then **A2** (small): together they convert this failure class from "minutes of confusion" to "a badge and a nudge."
3. **Addendum** only after the error-state evidence lands.
