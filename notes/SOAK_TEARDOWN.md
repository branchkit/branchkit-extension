# Soak procedure — orphan content-script teardown

How to soak (and objectively evaluate) any change to the orphan/teardown arc:
Phase 1 guards, the Phase 2a registry migration, or anything that touches
`quiesceOrphan`, listeners, intervals, timers, or observers. Companion to
`DESIGN_TEARDOWN_OWNERSHIP.md`. Run before pushing any such change — local tests
and a clean build do NOT catch this regression class (the 2026-06-02 lockup
passed all of them).

## What we're actually testing

The failure mode is **service-worker saturation**: orphaned content scripts whose
loops survive teardown keep pumping the shared SW, which gates injection/routing
for every tab — so the symptom is fresh, unrelated tabs hanging, not just the
orphaned tab. The soak's job is to confirm an orphan goes (and stays) quiet after
teardown. See `DESIGN_TEARDOWN_OWNERSHIP.md` sections 4-5.

## The objective signals

You do not have to eyeball "feels fine." Four measurable signals, strongest
first:

1. **`branchkitOrphanHits` gauge (the number).** A dev counter increments every
   time a torn-down content script's guard fires (a surviving listener/event
   reached a handler after teardown) and mirrors to the page:
   ```js
   // run in the ORPHANED tab's console (top frame)
   document.documentElement.dataset.branchkitOrphanHits
   ```
   Read it right after teardown, then again 60s later, then 5 min later. **It
   should stop climbing.** A value that keeps rising = surviving orphan activity
   (teardown is incomplete). Absent attribute = zero post-teardown hits (ideal).
2. **"Extension context invalidated" console rate.** Every surviving loop that
   touches a `chrome.*` API throws this synchronously. After the orphan logs
   `content script torn down ... Self-quiesced.`, the rate of these should fall
   toward zero. A sustained/climbing stream = surviving loops.
3. **Service-worker CPU.** Chrome Task Manager (Shift+Esc) → "Service Worker:
   BranchKit", and `chrome://serviceworker-internals`. Should be near-idle when
   you are not interacting. Pegged/climbing = an orphan is pumping it.
4. **Fresh-tab test.** Open a new tab on an unrelated URL. It should load
   promptly. Hanging here is the canonical 2026-06-02 tell.

## Procedure

1. Build + load the unpacked extension (`npm run build`, load `dist/chrome`).
2. Open YouTube `/watch` (the pathological case — heavy DOM, shadow roots,
   constant mutation) plus 2-3 unrelated tabs.
3. On the YouTube tab: open DevTools console. Also open Chrome Task Manager
   (Shift+Esc) and a `chrome://serviceworker-internals` tab.
4. Orphan the open tabs: at `chrome://extensions`, toggle BranchKit off then on
   (or press its reload). This invalidates the open tabs' content-script contexts
   and injects fresh ones — the elder+successor overlap we're testing.
5. Idle for 5-10 minutes. Do NOT interact with the page. Watch the four signals.
   Sample `branchkitOrphanHits` at t+0, t+1min, t+5min.
6. Repeat with several heavy tabs open at once (the swarm — the original
   "must close every tab" pain).
7. For Firefox: same flow via `about:debugging` → reload the temporary add-on.
   Firefox is the stricter target (it flags unresponsive extensions).

## Pass / fail

PASS:
- `branchkitOrphanHits` stops climbing after teardown (stable number, or
  attribute never appears).
- "Extension context invalidated" rate decays to ~0.
- SW CPU near-idle at rest.
- Fresh tabs load promptly; no "Page Unresponsive" on any tab.

FAIL (revert, do not push):
- `branchkitOrphanHits` keeps rising minutes after teardown.
- Sustained SW CPU or a climbing console-error stream while idle.
- Any tab — especially a fresh/unrelated one — hangs.

## Per-lift expectations

The gauge gives a clean before/after as the migration proceeds:

- Pre-Phase-1: high orphan hits + error rate (intervals, timers, and the
  resurrection handlers all firing).
- Post-Lift-3 (current): intervals and fire-once timers are gone, so the residual
  is **listener-driven** — `onMessage`, `visibilitychange`, `SHADOW_EVENT`. The
  gauge should show a lower, listener-paced number.
- Post-Lift-4 (DOM listeners removed): the resurrection-handler hits should drop
  to ~0; only `onMessage` (kept by design) can still register a hit, and only in
  the superseded-but-live-elder case.

## The automated harness vs. the real soak

`scripts/_soak-orphan.mjs` (`npm run build:chrome && node scripts/_soak-orphan.mjs`)
is the deterministic half. It loads the extension headful, forces the teardown
path (dispatches `__branchkit__force_teardown`), fires the resurrection-driving
events (attachShadow → `SHADOW_EVENT`, visibilitychange, scroll), and reads
`branchkitOrphanHits`. It objectively answers "do these listeners still fire
after teardown?" — the teardown-COMPLETENESS question and the before/after signal
for Lift 4. Pre-Lift-4 it reports a residual (one hit per shadow attach, e.g.
`50` for a 50-event burst); Lift 4 should drive it to ~0.

What it does NOT cover: the emergent SW-saturation failure (orphan loops pumping
the shared SW over minutes until tabs hang). Per `[[playwright-not-authoritative]]`
the harness forces activation and can't hold a real steady-state, so it's a fast
pre-filter, not the gate. The real-Chrome / real-Firefox idle soak above remains
the push gate.

(The `__branchkit__force_teardown` listener is a pre-launch test affordance —
gate or remove it before shipping, since it lets any page tear down the content
script on itself.)
