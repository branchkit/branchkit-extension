# SSE resilience — real connect edges, stable-reset backoff, cred self-heal

Date: 2026-07-01. Status: implemented; harness green (see Verification);
live clean-baseline soak still pending before push.
Source: notes/REVIEW_EXTENSION_FOOTGUNS_2026-06-29.md (the two background/IPC
HIGHs + the offscreen MED), plus a masking bug found while implementing.

## The seam

The SW ↔ host connection has one honest signal — the SSE stream's `connected`
event — and everything else is inference. Four defects, all from trusting
inference over the signal:

### 1. The host-restart healer is masked (found during this work)

`republishActiveTab(activeTab, 'sse_reconnect')` (b7399f5, DESIGN_HOST_RESTART_
RESYNC.md) fires on the `HEALTH_STATUS` `false→true` edge of
`bgState.branchkitConnected`. But every reconnect path sets that flag `true`
OPTIMISTICALLY before the SSE is up:

- the retry callback (`background.ts:56`) after a successful `discoverPlugin()`
- `postGrammarBatch`'s discover-on-miss (`:377`)
- `init()` from the discovery result (`:1116`)

`HEALTH_STATUS(true)` always arrives after those, sees `wasConnected === true`,
and skips the healer. On Firefox the `HEALTH_STATUS` handler never runs at all
(the direct-`EventSource` `connected` listener does its own partial connect
work: focus + hydrate, no rescan/healer/backoff-cancel). So the healer is dead
on both engines — consistent with its design note still saying "verify on
clean baseline."

**Fix: the flag follows the signal, never leads it.** Remove all optimistic
sets. One `onSSEConnected()` runs on the real signal — Chrome's
`HEALTH_STATUS(true)` and Firefox's `connected` event — and does the full
connect work: flag, backoff bookkeeping, focus claim, reference hydrate,
rescan, republish healer. It runs on EVERY `connected` (not just flag edges):
a `connected` event means a NEW stream was established, so the plugin may be
fresh and the heal is warranted; reactivate is idempotent (same rotate+re-Put
that fires on every tab focus) and connects are rare. Edge-gating on the flag
is exactly what masked the healer — a reconnect after an UNDETECTED drop has
flag=true with a fresh plugin, and would skip the heal again.

`onSSEDisconnected()` is the mirror: flag false + schedule retry. Called from
`HEALTH_STATUS(false)` (now unconditionally — scheduleSSERetry is idempotent
while a timer is pending, and gating on the edge left "discover succeeded but
SSE never came up" unretried), Firefox `onerror`, and the alarm probe (4).

### 2. Backoff resets on every connect edge (review HIGH)

`cancelSSERetry()` reset the delay to 1s on every reconnect, so a crash-
looping host re-runs `discoverPlugin` (a real fetch) every ~1s forever.

**Fix: a reconnect earns the 1s reset only after the connection has held
`SSE_STABLE_RESET_MS` (30s).** A connection that drops sooner keeps the
ladder escalating (1→2→…→30s cap) across crash-loop cycles. Policy extracted
to `src/background/sse-backoff.ts` (pure, unit-tested); timers stay in
background.ts.

### 3. Stale creds wedge POSTs silently (review HIGH)

`ensureConnected()` returns true whenever `pluginPort`/`pluginToken` are
cached; nothing ever invalidates them. After a host restart whose SSE drop
went unnoticed, every POST 401s (or connection-refuses) forever, swallowed as
best-effort.

**Fix: `postToPlugin` clears the cached creds on 401/403 or a thrown fetch**
(connection refused/reset — the port's owner is gone). The next
`ensureConnected()`/`postGrammarBatch` rediscovers. One extra status fetch per
recovery; no behavior change for app-level non-auth errors (4xx validation
responses keep the creds).

### 4. Undetected drops stay undetected (review MED, promoted)

Chrome recovery was entirely SW-driven off `branchkitConnected`, which only
flips on a `HEALTH_STATUS(false)` a dead/wedged offscreen never sends. The
30s `connection-check` alarm trusted the flag, so a stale `true` disabled the
safety net — this is the window that makes (3) bite.

**Fix: the alarm probes reality instead of trusting the flag.** Offscreen
answers `SSE_STATUS` with `source.readyState === OPEN`; Firefox checks
`directSSE.readyState` directly. Probe says dead while flag says connected →
`onSSEDisconnected()`. Worst-case detection latency for a silent drop: one
alarm period (30s), after which retry + rediscovery + reconnect + heal all
follow from (1)-(3). A probe can catch a mid-reconnect CONNECTING stream and
schedule a redundant cycle; it self-corrects and connects are rare.

### 5. Two more, found by the harness's crash-loop scenario

- **Discover-on-miss had no throttle.** `ensureConnected` is called per-POST
  by ~12 forwarders; with the host down (or creds just cleared) every
  forward fired its own discovery fetch, and a batch burst turned into a
  discovery hammer that dwarfed the ladder (observed: 55-90 fetches/45s,
  ladder contributing ~6). Fix: `ensureConnected` is single-flight with a 5s
  negative cache; `postGrammarBatch`'s inline discover now routes through it.
  The ladder keeps calling `discoverPlugin` raw — reconnect pacing is its
  job, and the 1s first rung must not be blunted by the cache.
- **The offscreen `onerror` closed the wrong instance.** It closed whatever
  the module `source` pointed at; when two CONNECT_SSE raced, a superseded
  EventSource's error could close the NEW stream and leave itself unclosed —
  auto-reconnecting (and reporting phantom HEALTH_STATUS) forever, one more
  zombie per race (observed: bursts of 6-10 simultaneous connect attempts,
  growing per cycle). Fix: handlers capture their own instance; a superseded
  instance closes itself silently.

## What this deliberately does not do

- No offscreen self-reconnect: offscreen stays dumb (close on error, report,
  wait for CONNECT_SSE). The SW owns retry policy; two independent
  reconnectors racing each other is how the Firefox `connectDirectSSE` thrash
  (review MED) happens. That finding (guard un-awaited `connectSSE()` bursts
  in `postGrammarBatch`) was narrower after this change — connectSSE only
  fires there when creds were just rediscovered — and was left open here;
  CLOSED 2026-07-04: `connectDirectSSE` now keeps an in-flight socket whose
  creds URL is unchanged and not CLOSED, tearing down only on changed creds.
- No change to grammar-batch semantics or the hint-gate follow-up in
  DESIGN_HOST_RESTART_RESYNC.md ("mid-lifetime hint-gate desync").

## Verification

- Unit: sse-backoff ladder (escalate, cap, stable-reset, crash-loop
  no-reset).
- Harness (`scripts/_test-sse-resilience.mjs`): fake actuator + plugin
  (status endpoint, tokened POST endpoints, SSE `/events`). Green 2026-07-01:
  (A) boot → SSE connects, grammar batches flow;
  (B) host restart (SSE killed + token rotated) → reconnect on the new token
  in ~1s and grammar re-emitted (healer actually fires — the b7399f5
  verification that was never runnable pre-unmasking);
  (C) silent token rotation, SSE left OPEN → a POST 401s, creds clear, next
  batch succeeds on the new token in <1s with no SSE-drop signal to help;
  (D) host fully down 45s → 8 discovery fetches (pre-fix shape: 55-90),
  then reconnects when the host returns.
  Needs port 21551 free — quit BranchKit first.
- Live: the DESIGN_HOST_RESTART_RESYNC.md clean-baseline check (quit +
  relaunch BranchKit, hints matchable with no tab reopen), which was blocked
  on (1). High-blast-radius area — steady-state browse soak before merge.
