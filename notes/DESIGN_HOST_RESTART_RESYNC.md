# Host-restart resync — heal hints after the BranchKit app restarts

Date: 2026-06-27. Status: fix landed (extension half); verify on clean baseline.
Update 2026-07-01: the healer as landed never actually fired — it keyed on a
`false→true` edge of `branchkitConnected`, but every reconnect path set that
flag optimistically before the stream was up (and Firefox never ran the
HEALTH_STATUS handler at all), so the edge was always masked. Unmasked by the
real-connect-edge refactor in notes/DESIGN_SSE_RESILIENCE.md (1) and verified
end-to-end by `scripts/_test-sse-resilience.mjs` scenario B (grammar re-emitted
~1s after a host restart with a rotated token).

## The gap

The connection between content scripts and BranchKit breaks two ways, and only
one was healed:

- **Service-worker restart** (Chrome idle-kills the MV3 SW, constantly): the
  per-frame liveness Port drops, the content script reconnects, and
  `onResync()` rebuilds the grammar (rotate session + re-emit codewords). See
  `plugin/liveness.ts`. Healed.
- **Host restart** (the BranchKit *app* restarts — `just build` in dev; in
  production: app updates, crashes, quit/reopen): the SSE drops but the SW does
  **not** die. So the liveness Ports never drop, `onResync` never fires, and the
  only thing that runs on SSE reconnect (`HEALTH_STATUS` in `background.ts`) was
  `rescanActiveTab()` — a DOM re-scan, NOT a grammar `reactivate`. The restarted
  plugin lost every frame's grammar, so codewords were never re-emitted: badges
  paint but aren't matchable until a manual tab reopen. **Unhealed.**

This is not just dev friction — it hits a production user on every app update or
crash. Discovered after a session of repeated `just build` relaunches left open
tabs with painted-but-dead hints.

## The fix (extension)

On SSE reconnect (host came back), also `republishActiveTab(activeTab,
'sse_reconnect')` — the same `reactivate` (rotate session + re-Put grammar) the
SW-restart `onResync` path and tab activation already use. The active tab
recovers immediately; other tabs heal on next focus via the existing
`tab_activated` reactivate. Two-line change: a `reason` param on
`republishActiveTab` (for telemetry) + the call in the reconnect handler.

Scope note: on a host restart the browser **plugin subprocess** restarts too, so
its hint-gate (`hint_gate.go`) resets to Idle. Re-emitting the grammar is
therefore sufficient — the fresh gate will `Put` the hints tag cleanly when the
first batch lands. No plugin change needed for the host-restart case.

## Separate finding (not fixed here): mid-lifetime hint-gate desync

`hint_gate.transitionToGrammarOwned` skips the tag `Put` whenever its cached
`state` is already `GrammarOwned` (the hot-path optimization for ~688 redundant
grammar pushes). If the actuator-side tag is cleared *without* the gate being
told (`markCleared`/`transitionToIdle` not called — e.g. a `clearsTags` path or
session reset the gate doesn't observe), the gate stays `GrammarOwned`, keeps
SET-skipping, and the tag stays gone → codewords un-matchable
(`hints tag SET-skipped … grammar_already_owns` in the log). This is a separate,
rarer mid-lifetime bug, NOT the host-restart case (which resets the gate). Needs
its own trace of the clearsTags ↔ markCleared interaction before any change —
the gate is a small state machine and a wrong "always re-Put" would spam the hot
path. Tracked for follow-up.

## Verification

The dev env must be at a clean baseline first (quit BranchKit, reload extension,
fresh tab) — you can't verify recovery from an already-churned state. Then:
deliberately quit + relaunch BranchKit and confirm hints in the open tab become
matchable again with **no tab reopen** (look for `BRANCHKIT_ACTION reactivate
reason=sse_reconnect` → grammar re-Put → `hints tag SET`). High-blast-radius
area — 30+ min steady-state browse soak before merge.
