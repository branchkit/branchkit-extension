# Design: Pause voice (manual disconnect)

**Status:** IMPLEMENTED (2026-07-07). Behavior spec for the user-facing "pause
voice" toggle in the popup. Built on the connection-mirror work landed the same
day (see "Substrate" below). Live verify pending.

**Landed as:** actuator-client transport gate (`setVoicePaused` + `voicePaused`
checks in `discoverPlugin`/`ensureConnected`); background pause lifecycle
(`pauseVoice`/`resumeVoice`/`teardownSSE`, sticky `voicePaused` loaded in
`init()`, guards on the retry ladder / connection-check alarm /
`permissions.onAdded` / `onSSEConnected` / `handleSSEEvent`, `SET_VOICE_PAUSED`
message, `GET_HEALTH` gains `paused`); offscreen `DISCONNECT_SSE`; popup
"Voice: On / Paused" toggle + "Voice paused" status state.

**Goal:** Let a user who is running BranchKit deliberately stop the browser
extension from engaging voice — while keeping hints + keyboard fully live —
without quitting the app. Rare but real: the privacy case (BranchKit running
for dictation elsewhere, browser stays out of it), quieting background traffic,
or testing standalone behavior without tearing the host down.

## Principle: pause is subordinate to connection

You can only pause something that is running. Pause is **not** a free-floating
preference; it is a state that layers on top of a present host. This is the
whole design constraint — everything below falls out of it.

The service worker already separates the two signals this rests on (the
existing comments call it out: "discovery success is NOT connection success"):

- **Host running / discoverable** — `discoverPlugin()` succeeds; the app is
  reachable at `127.0.0.1`. (background.ts / plugin/actuator-client.ts)
- **Connected** — the SSE stream is actually up; `bgState.branchkitConnected`
  is true, flipped only by the stream's real `connected` event and its drop
  (`onSSEConnected` / `onSSEDisconnected`).

Pause lives in the gap: **discoverable, but we deliberately do not hold the
stream open.**

## State model

| User intent | Host | State | Badges / voice surfaces | Pause toggle |
|---|---|---|---|---|
| not paused | absent | **Standalone** | opaque, no voice | hidden — nothing to pause |
| not paused | running | **Connected** | translucent→opaque, voice live | shown, "on" |
| paused | (either) | **Paused** | opaque, voice surfaces hidden | shown, "off" |

Consequences that make the model coherent:

- **The toggle is only actionable from Connected.** When BranchKit isn't
  running you are already standalone; a pause control there would be a no-op
  with no visible effect, and a latent flag you can set while standalone
  produces the "why won't it connect when I launch the app?" confusion. So the
  toggle appears only when there is something to pause (Connected) or something
  to un-pause (currently Paused).
- **Paused is an explicit status, not "not detected."** The status text must
  read "Voice paused" — reusing "BranchKit not detected" while the app is
  demonstrably running reads as a bug. This is the third status state the
  popup gains.
- **Standalone and Paused look identical to content scripts, by design.** Both
  are "voice is not usable right now": badges opaque, help-overlay voice
  surfaces hidden, keyboard fully live. Content scripts do not need to know
  *why* — they read one bit (see Substrate). Only the popup distinguishes
  paused-by-choice from host-absent, because only the popup owns the intent.

## The one real decision: pause is sticky until un-paused

Once set, pause **persists until the user un-pauses** — it does not clear when
the app cycles. While paused the SW goes fully dormant for voice: closes the
SSE, stops the retry ladder, and stops discovery. Un-pausing resumes the normal
discover→connect flow.

Why sticky rather than clearing on host-down:

- The primary use case is privacy — "the browser should not engage voice." If
  pause cleared on every app relaunch, the browser would silently start
  connecting again each time BranchKit started, defeating the intent and
  forcing a re-pause every session.
- Going fully dormant while paused means we do **not** need to keep probing
  whether the host is up. The user chose to pause; host presence is moot until
  they un-pause, at which point we discover and connect if it's there. Cheaper
  (no background polling) and it sidesteps the "app running but shown
  disconnected" ambiguity — the status is simply "Voice paused."

Rejected alternative — **ephemeral pause** (pause lasts only within one host
availability episode; an app restart auto-reconnects fresh). Simpler in that it
needs no persisted flag, and it maps literally onto "you can only pause while
it's running." But it fails the privacy case and surprises the user who
expects their choice to stick. Not chosen.

## Substrate: what already exists (landed 2026-07-07)

The content-side experience of a manual disconnect is **already built and
tested** by the connection-mirror work. A pause is, to every content script,
just another way to reach `branchkitConnected = false`:

- `src/plugin/connection-mirror.ts` mirrors `branchkitConnected` from the SW
  into `chrome.storage.local`; content scripts read it in `isPaintReady`
  (content.ts) so disconnected badges paint opaque, and the live-disconnect
  edge flips already-painted `bk-pending` badges opaque in place.
- The help overlay gates its voice surfaces (spoken-phrase column, voice-only
  commands, spoken-alphabet table) on `alphabet.loaded && isBranchKitConnected()`
  (render/help-overlay.ts).

So pausing = "make the SW hold `branchkitConnected` false and stay there." All
of the downstream paint/overlay behavior comes for free. **The only new work is
SW-side connection lifecycle + the popup control.**

## Implementation sketch (SW-side)

New persisted intent, e.g. `voicePaused` in `chrome.storage.local` (local, not
sync — it tracks this machine's relationship to the local host, like the
alphabet and the mirror).

1. **Pause action** (message from popup):
   - set `voicePaused = true`
   - `clearSSERetryTimer()` and tear down the live stream (offscreen
     `CONNECT_SSE` teardown / close `directSSE`)
   - `onSSEDisconnected()`-style flip: `bgState.branchkitConnected = false`,
     badge off, **write the mirror false** (`chrome.storage.local` — the same
     write `onSSEDisconnected` now does) so content scripts flip opaque
   - do **not** `scheduleSSERetry()` — this is the one disconnect that must not
     re-arm the ladder

2. **Un-pause action:**
   - set `voicePaused = false`
   - run the normal boot path: `discoverPlugin()` → `connectSSE()` on success,
     else `scheduleSSERetry()`

3. **Respect the flag at every auto-connect entry point** — guard so a paused
   SW never reconnects on its own:
   - `init()` (SW wake / startup): if paused, skip discovery, ensure the mirror
     is false, and stop. (Mirrors the existing discovery-failure branch that
     already writes the mirror false.)
   - the `connection-check` alarm handler: if paused, do nothing (no probe, no
     `scheduleSSERetry`).
   - `permissions.onAdded` (Firefox grant): if paused, do not auto-connect.
   - `postGrammarBatch`'s discover-on-miss: already no-ops usefully — a paused
     SW returns transport failure, which after the flash-loop fix keeps badges
     painted and re-queues puts. No detach. (Good: confirms the transport-
     failure path is the correct floor for "voice absent for any reason.")

4. **`GET_HEALTH` / popup status:** extend the response so the popup can render
   three states — connected, paused, and not-detected — instead of inferring
   from `branchkit` alone. e.g. `{ branchkit, paused }`.

Invariant to preserve: **pause never gates grammar transport logic beyond the
connect decision.** The mirror is paint-only; the flash-loop fix means a
wrongly-held-false state can't strand painted badges. Pause simply removes the
reason to connect; it does not add a new suppression path inside the sync
pipeline.

## Popup UX

- Status row gains the "Voice paused" state (dot styling: reuse disconnected /
  a distinct "muted" color — cosmetic, decide at build).
- A toggle — framed as **"Voice: On / Off"** or **"Pause voice"**, not
  "Disconnect" (the honest effect is "voice stops, hints + keyboard keep
  working," not "sever a socket").
- Visibility rule: show the toggle when Connected (to pause) or Paused (to
  un-pause). Hidden in Standalone. The existing Firefox "Allow BranchKit
  connection" grant button is orthogonal and unchanged.

## Out of scope

- Per-site pause (this is a global, host-relationship switch; per-domain hint
  suppression already lives in the rules editor).
- Any actuator/plugin-side change — this is purely extension connection
  lifecycle. The plugin already tolerates a browser connection going away.
- Distinguishing standalone-by-choice from host-absent *to content scripts* —
  deliberately collapsed to one bit (see model). Only the popup cares.

## Related

- notes/DESIGN_EXTENSION_INDEPENDENCE.md — standalone is a first-class mode;
  voice is an opt-in overlay. Pause is the user exercising that independence
  deliberately.
- notes/DESIGN_EXTENSION_CONNECTION_HEALTH.md — A1 toolbar badge is "state, not
  error" and explicitly declines to distinguish standalone-by-choice from
  host-vanished at the badge. Pause adds an intent the *popup* can name, but the
  badge stays state-only.
- notes/DESIGN_SSE_RESILIENCE.md — the retry ladder + connection-check alarm
  that pause must suppress.
- The 2026-07-07 flash-loop fix (transport failure keeps painted hints) and the
  connection mirror (disconnected badges paint opaque; help overlay gates voice
  surfaces) are the substrate this sits on.
