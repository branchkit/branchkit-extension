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

Caveat (standing): the Playwright harness has confounds (forced user
activation, synthetic scroll, no real voice) — treat results as indicative,
verify real behavior in a real browser before claiming a fix.
