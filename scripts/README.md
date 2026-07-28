# scripts/ — maintained set only

Pruned 2026-07-18 (settle-engine extraction step 5): 68 one-shot
investigation drivers deleted — they rotted fast, gated nothing, and their
regression coverage moved to the unit layer (settle-engine.test.ts and
friends). What remains is curated; the bar for adding a script here is
"will be run again on purpose", not "was useful once". One-shot repro
drivers should be written, used, and deleted in the same arc (underscore
prefix = soak/repro driver, not wired into any build).

Tooling: `build.mjs` / `build-manifest.mjs` / `dev.mjs` / `lib/`.
Harnesses wired into package.json: `test-perf`, `test-placement`,
`test-scroll-accel*`. Recent feature harnesses: `verify-badge-size*`,
`verify-nudge*`. Perf capture: `storm-summary.mjs`, `_watch-perf.py`,
`_snapshot.mjs`.

Maintained soak drivers (the classes unit tests can't see — real shadow
DOM, real IO timing, real sites):
- `_soak-orphan.mjs` — orphan-CS teardown soak (highest-blast-radius class)
- `_test-hints.mjs` — basic paint/activate sweep
- `_test-sites.mjs` — multi-site sweep (QuickBase, YouTube, Gmail, GitHub)
- `_test-qb-fling.mjs` — QuickBase grid fling (paint-latency class)
- `_test-gmail-fixture.mjs` — Gmail fixture (settle-storm class)
- `_test-videos-tab-wedge.mjs` — nav-time wedge guard (load-bearing fix ca25199)
- `_test-sse-resilience.mjs` — host restart/reconnect class

## Headless by default, `BK_HEADED=1` to watch

Everything that launches through `lib/launch.mjs` runs headless. A headed
browser on macOS activates on launch, so a harness run repeatedly steals
keyboard focus and makes the machine unusable for its duration — which is how
the verification you are meant to run before every commit becomes the one you
skip. Set `BK_HEADED=1` to open a window when a probe fails and you need to see
it happen.

Two things this cost, both measured rather than assumed (2026-07-28):

- Headless Chromium MUST be the full binary, not Playwright's default headless
  shell — the shell has no extension support, so the service worker never
  registers and every harness dies on `waitForEvent("serviceworker")`.
  `lib/launch.mjs` passes `channel: 'chromium'` when headless for this reason.
- Headless runs animations on a different rAF cadence, which exposed one
  harness probe that read a scroll position 91px into a 400px scroll after a
  fixed delay. It waits for the scroll to land now. If a probe starts failing
  only headless, suspect a fixed `settle()` standing in for a real wait before
  suspecting the browser.

Verified equal to the headed baselines: `harness:messages` 32/32 (27/27 when
this was written), `harness:realinput` 11 both engines, `harness:lifecycle`
7 PASS / 2 SKIP (the same two environmental skips), `test:placement`,
`test:scroll-accel`.

The six underscore one-off diagnostics above still launch headed on purpose —
you run those to watch them.

Caveat (standing): the Playwright harness has confounds (forced user
activation, synthetic scroll, no real voice) — treat results as indicative,
verify real behavior in a real browser before claiming a fix.
