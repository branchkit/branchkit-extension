# Lifecycle harness — automating the protocol half of soak

**Status:** skeleton BUILT + shaken out same day (scripts/harness/lifecycle/,
`npm run harness:lifecycle`). First run: fresh-load PASS (12 badges, all
routable, end-to-end through the on-demand POOL_AUDIT surface); bfcache,
prerender, and reload SKIP loudly — each has a named engagement blocker
under automation (section 7). The invariant plumbing is proven; the
remaining work is transition ENGAGEMENT, not assertion machinery. Motivated by the round-3 soak day: two
months-old protocol bugs (prerender pool poisoning, bfcache non-reassert)
were findable only by a human speaking hint pairs at the right moments.
Both would have been caught mechanically by asserting ONE invariant across
a matrix of document-lifecycle transitions. Companion to the field tripwire
(debug/pool-audit.ts, landed same day): the tripwire watches the DEV
machine's normal browsing; this harness makes the same invariant a
pre-merge gate.

## 1. Scope — what soak jobs this does and does not absorb

Soak currently conflates two jobs:

- **Protocol correctness across lifecycle transitions** — claims, routing,
  grammar sync surviving reload / navigation / bfcache / prerender / SW
  restart / iframe churn. Automatable, and this harness's whole scope.
- **Perceptual quality** — paint feel, occlusion judgment, real voice
  acoustics. NOT in scope; stays human, per the standing
  Playwright-not-authoritative rule. That rule is about perceptual claims
  (forced user-activation, synthetic-scroll artifacts, no real voice); it
  does not disqualify protocol assertions, which are exact and
  machine-checkable.

The harness runs WITHOUT BranchKit (extension-independence: CI has no host).
Everything it asserts is extension-internal: CS wrapper state, SW pool
state, dispatch-result plumbing. Voice is not simulated; routability is
read from the pool, which since sealed pull-resolution IS the routing truth.

## 2. The one invariant

> Every painted badge's codeword is assigned, in the SW pool, to the
> document that painted it.

Checked via the POOL_AUDIT read (same message the field tripwire uses):
`unroutable == [] && foreign == []`. This single assertion, evaluated after
each transition in the matrix, catches the entire pool-divergence class —
both 2026-07-24 bugs, the June fine-jury class, and any future regression
in claim/confirm/release ordering. Secondary assertions per scenario:
wrapper count sanity (badges exist at all), no BK_CONFIRM_REJECTED
breadcrumbs during the scenario (rejections in a single-browser scripted
run indicate a protocol race, not arbitration doing its job), and no
leaked reservations older than the scenario runtime.

## 3. The transition matrix

Each scenario = drive the transition, settle, assert the invariant.
Deterministic triggers exist for every one:

| Transition | Trigger in harness |
|---|---|
| Fresh load | goto fixture page |
| Full navigation + back/forward (bfcache) | goto → goto → history.back()/forward() |
| SPA navigation | fixture pushState/replaceState buttons |
| **Prerender activation** | fixture A carries `<script type="speculationrules">` for fixture B; click through → B activates from prerender |
| Extension reload survival | CDP-driven reload of the unpacked extension, existing reinject path |
| SW idle-kill + resync | kill via `chrome://serviceworker-internals` CDP or `chrome.processes`; next message wakes it |
| iframe add/remove | fixture inserts/removes a hintable iframe |
| Hidden-tab suspend/resume | background the tab 30s+ (or CDP `Page.setWebLifecycleState`), foreground |
| Tab close reclaim | close tab, assert pool stack cleared |
| Cross-frame duplicate probe | two frames claim concurrently; assert disjoint assignment |

Composites (the real killers are sequences): prerender → activate →
back/forward; reload → bfcache restore; SW kill mid-scroll → resync.

## 4. Shape

- `scripts/harness/lifecycle/` — one file per scenario over shared fixtures
  (`test-fixtures/lifecycle/*.html`), a shared driver (launch unpacked
  extension, read SW state via CDP evaluate in the SW context, read CS
  state via the existing `__branchkit__capture_snapshot` harness hook), and
  one runner (`node scripts/harness/lifecycle/run.mjs [scenario]`).
- Assertion access: POOL_AUDIT needs a caller inside the extension — the
  harness drives it through the existing harness-hook CustomEvent surface
  (dev builds only, same gate as the tripwire) rather than a new
  page-exposed API.
- Chrome first (prerender + CDP are Chrome-shaped); Firefox variant later
  for the scenarios it supports (no speculation rules; bfcache + reload +
  iframe churn all apply).
- CI: headed-new Chrome in the existing workflow as a separate,
  non-required job initially; promote to required once flake-clean for a
  couple of weeks. Locally: `npm run harness:lifecycle` before merging
  anything that touches labels/, liveness, or the background routing.

## 5. What this changes about the soak ritual

- Protocol changes (labels/, plugin/liveness, frame routing, session
  plumbing): harness green replaces the scripted-manual soak; the field
  tripwire covers the long tail during normal use.
- Perceptual changes (render/, placement/, occlusion): human eyes, as today
  — but scoped and rare.
- The fenced classes (orphan/teardown, observer construction): keep the
  full human soak; their failure mode (steady-state browsing breakage) is
  exactly the perceptual-adjacent kind the harness undersees.

## 6. Non-goals

- No voice simulation, no Sherpa in the loop (that's `just voice-regress`,
  app-side, already landed).
- No perceptual assertions (badge positions, paint timing) — those live in
  the existing perf harnesses and human review.
- Not a 53rd throwaway driver: scenarios share fixtures and the driver, and
  a scenario isn't merged without being wired into the runner — the same
  "not extracted until it has a spec" discipline, applied to harnesses.

## 7. Shakeout findings (2026-07-24) — engagement blockers

The skip design immediately earned its keep: three of four transitions are
not engaged by default under Playwright/CDP, and each skip names why
instead of passing vacuously.

- **bfcache:** `pageshow.persisted=false` under automation. Modern Chrome
  claims bfcache+DevTools coexistence, so something in the CDP session or
  page state disqualifies it. Next step: subscribe to CDP
  `Page.backForwardCacheNotUsed` and surface `notRestoredExplanations` in
  the skip message — the browser will tell us the exact blocker.
- **prerender:** speculation-rules prerender never started
  (`document.prerendering=false` at B's parse). DevTools/CDP attach is a
  documented PreloadingEligibility blocker in some Chrome versions. Next
  step: CDP `Preload` domain to read the eligibility verdict; if
  automation-blocked outright, this scenario stays a permanent loud skip
  and the transition remains covered by the field tripwire.
- **reload:** `chrome.runtime.reload()` is inert for command-line-loaded
  extensions (no new SW appears; known Chromium quirk). Next step: drive
  the chrome://extensions UI reload button (open shadow DOM) — the real
  user path anyway.

Until engagement lands, coverage for these three transitions comes from
the field tripwire (debug/pool-audit.ts, always on in dev browsing) plus
the manual checks — the harness's honest skips keep that visible instead
of implying automation covers it.
