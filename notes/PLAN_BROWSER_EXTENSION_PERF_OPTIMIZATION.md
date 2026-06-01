# Browser Extension Performance Optimization Plan

Status: planning (2026-05-31)

## Context

The nav-time wedge investigation (notes/INVESTIGATION_YOUTUBE_WATCH_PERF.md) shipped a fix for the worst case — Firefox no longer freezes on YouTube `/@channel/featured → /videos`. The fix proves the underlying architecture is correctable, but it doesn't change the constant per-page cost model. The extension still:

- Pays a 1-2 second badge-paint delay after every SPA nav.
- Attaches 500-700+ observer instances on a YouTube `/featured` page (~87 wrappers × ~7 observer types per wrapper).
- Runs a body-subtree `MutationObserver` that fires on every page mutation, page-wide.
- Runs a body-level badge-reattach observer (now rate-limited but still fires).
- Lazy-attaches no observers — every hintable element is observed from discovery to teardown regardless of viewport position.

The 2026-05-30 wedge was the cliff edge of this model. The cliff is patched; the slope is still real.

## Goal

Reduce constant-cost overhead so:

1. **Badge paint after SPA nav drops below 500ms** on heavy pages (currently 1-2s).
2. **Steady-state main-thread cost stays below Firefox's slow-extension warning threshold** even on the heaviest SPA targets.
3. **Memory/observer count scales sublinearly** with page hintable count (currently linear ×~7).

Non-goal: rewriting the discovery pipeline. The intent is amortizing the existing pipeline's per-target cost via shared instances and lazy attachment, not changing what we observe.

## Track A — Quick wins (ship-ready)

These are low-risk, contained, and provide immediate user-visible improvement.

### A1. Per-host badge-reattach rate budget

**Status:** partially done (per-badge rate limiter shipped 2026-05-31).

**Problem:** the per-badge limiter handles the steady-state YouTube case but doesn't generalize. A new site that yanks badges on different elements each frame would still spin the loop until each individual badge hits its giveup threshold.

**Approach:** add a host-level circuit breaker. If the badge-reattach observer fires more than N times in a 1-second window, suspend reattach for the rest of the session and log a diagnostic. The page works without our reattach safety net (badges may disappear on some sites, but the page never wedges).

**Effort:** ~1 day. Touches `badgeReattachObserver` in `content.ts`.

### A2. Skip-unhintable-subtree pre-filter

**Status:** landed (uncommitted, 2026-06-01). Move 0 of `DESIGN_OBSERVATION_FOOTPRINT.md`.

**Problem:** `<video>`, `<canvas>`, `<svg>` content, and large media-only DOM subtrees can't contain hintable elements but we still walk them in `doScanBatched` and observe their mutations.

**Approach:** at scan time, fast-reject subtrees rooted at element types known to contain no hintables (a static allowlist of opaque-content tags). Skip the deep walk; never attach observers to descendants.

**What actually shipped (scope refinement):** the real per-scan cost from opaque
content was `findShadowHosts`'s `querySelectorAll('*')` enumeration — it touched
every `<path>`/`<g>` inside every `<svg>` icon (and MathML, etc.) doing a
tag-lookup + `.shadowRoot` access per node. The native hintable-selector pass
(`querySelectorAll(scanSelector)`) never matched inside opaque tags, so it needed
no change. Fix: rewrote `findShadowHosts` to use a `TreeWalker` with
`FILTER_REJECT` on an `OPAQUE_SUBTREE_TAGS` set (`svg, math, canvas, video,
audio, picture, iframe`), so descendants of opaque roots are never visited. New
perf counter `shadowHostPrunedSubtrees` (surfaced via `buildPerfSnapshot` → the
perf trail) records pruned roots per scan for the before/after decision-gate
measurement. Tradeoff (per the plan's intent): a shadow host nested inside an
`<svg foreignObject>` is no longer pierced — vanishingly rare; light-DOM
hintables in a foreignObject are still found by the untouched native pass.
Unit-tested in `scanner.test.ts` ("opaque-subtree pruning (A2)", 3 cases).

**Estimated win:** 30-50% reduction in scan time on media-heavy sites (YouTube, Netflix, Twitch). **Pending live confirmation** — measure `shadowHostPrunedSubtrees` and scan time on Rumble/YouTube before deciding on Moves 1-3.

**Effort:** ~3-4 days estimated; actual was contained (the cost localized to one function). Touched `src/scan/scanner.ts` (NOT `find.ts` — that's find-in-page, unrelated).

### A3. Adaptive deferred_scan delay

**Problem:** the 300ms `setTimeout` in `rescanForNav` is a fixed margin chosen pessimistically (assuming YouTube's swap takes that long). On lighter pages it's pure wait.

**Approach:** replace `setTimeout(300)` with `requestIdleCallback({ timeout: 300 })` so the scan fires at the first idle window (often <50ms on light pages) but still caps at 300ms.

**Estimated win:** badge appearance drops from ~750ms to ~250ms on most pages; no regression on heavy pages.

**Effort:** ~1 hour. One-line change in `rescanForNav`.

## Track B — Architectural shifts (multi-week)

Real performance ceiling moves. Each is independent and shippable on its own.

### B1. Shared observer instances

**Problem:** each wrapper creates its own `IntersectionObserver`, `ResizeObserver`, `AttentionObserver`, plus per-target trackers (HostAttribute, TargetMutation, ContainerResize, ScrollAncestor). ~7 instances × 87 wrappers = ~600 observer objects on YouTube `/featured`.

**Approach:** consolidate to one instance per *kind*, watching N targets. Browser-side cost: one observer with N targets is dramatically cheaper than N observers with 1 target each. We already do this for some (`tracker` is a single IntersectionObserver) — extend to all.

**Estimated win:** observer count drops from ~600 to ~10. Steady-state CPU on JS-heavy sites drops proportionally.

**Effort:** ~2-3 days per observer type; ~1-2 weeks total. Touches `src/observe/*` and `content.ts:attachWrapper`/`detachWrapper`.

**Risk:** medium. Per-target callback dispatch logic needs to be careful with element identity (WeakMap keying).

### B2. Lazy observer attachment

**Problem:** we observe every hintable element from discovery onward, even if it's far below the fold and the user will never see it in this session.

**Approach:** only attach the expensive observers (RO, AttentionObserver, TargetMutationTracker) when the badge is potentially visible (in the AttentionObserver's broad-viewport band). Off-band elements stay in a lightweight wrapper that holds the codeword reservation but observes nothing.

**Estimated win:** observer count scales with viewport-visible hintables, not document-total. On YouTube `/featured` with ~300 hintables but ~40 visible, that's a ~7× steady-state reduction.

**Effort:** ~1-2 weeks. Requires lifecycle redesign: hot/cold wrapper states and transitions.

**Risk:** medium-high. Voice activation on a "cold" wrapper requires promoting it to hot first — possible but adds latency to first activation per element.

### B3. Pause-during-page-transition mode

**Problem:** today's pre-click teardown is an ad-hoc lifecycle hook. Other transition triggers (full reload, bfcache restore, manual rescan) don't get the same treatment.

**Approach:** generalize into a `PageSession.suspend()` / `.resume()` API. Suspended state: all per-wrapper observers disconnected, MO callbacks short-circuited, grammar sync paused. Resume on mutation quiescence (250ms without an MO fire) OR on an explicit signal (SPA-nav settled).

**Estimated win:** consistent behavior across all transition kinds. The badge-paint delay becomes predictable rather than per-trigger.

**Effort:** ~2-3 days. Touches `src/lifecycle/page-session.ts` and the observer setup points.

**Risk:** low. Mostly refactoring existing teardown logic.

### B4. Scoped MutationObserver

**Problem:** the main MO observes `document.body` with `subtree: true`. Every YouTube page-chrome animation, every off-screen lazy-load, every comment thread expansion fires our callback even though we only care about regions where wrappers exist.

**Approach:** observe per-active-region. Each scroll-ancestor or major container that holds wrappers gets its own MO; body-level MO only watches for new top-level regions.

**Estimated win:** main MO callback rate on media-heavy sites drops by ~5-10×.

**Effort:** ~1 week. Requires reasoning about region boundaries.

**Risk:** medium. Some mutations span regions; we need a fallback for the "page rearranged everything" case.

## Track C — Stretch / research

Bigger ideas that aren't actionable yet but worth tracking.

### C1. Off-main-thread grammar batch

Move grammar batch construction + the codeword pool to a Web Worker. The content script just sends element snapshots; worker manages claims/releases and returns batch payloads to post. Reduces main-thread blocking during scans.

### C2. Smarter discovery cadence

Currently we rescan on every MO batch via `scheduleDiscovery` → `drainDiscovery`. Could use a longer settle window (e.g. 500ms after last mutation) on hosts where mutation rate is high, accepting a UX latency for badge appearance.

### C3. Per-site profiles

Empirical config table: known-heavy hosts get more aggressive throttling, known-light hosts get tighter responsiveness. The opposite of today's one-size-fits-all approach. Risks fragmentation; only worth it if the simpler measures don't suffice.

## Track D — Per-frame footprint (shipped 2026-06-01)

Tracks A–C all reduce per-*page* cost. They miss the axis that actually drives
the recurring Firefox slow-extension warning: the extension injects into *every*
frame (`all_frames: true, match_about_blank: true` on `<all_urls>`), and an
ad-heavy page (Rumble live) spawns ~1000 ad/about:blank frames. The warning's
heuristic sums content-script CPU across all of them, so even cheap per-frame
work ×1000 trips it. A perf-trail evaluation while scrolling Wikipedia confirmed
Wikipedia itself is light (extension tracked 0ms across its stalls) — the cost
was the still-open Rumble swarm plus our own per-frame diagnostics.

### D1. Gate diagnostics to the top frame (done)

The watchdog timer loop, longtask observer, the 250ms dataset publisher, and the
5s perf-report ship all started on module load in every frame. None of their
output is read in a subframe. Gated all four to the top frame
(`window === window.top`). The top-frame snapshot now carries `frames`
(`window.length`) so the trail still surfaces swarm size without one ship per
subframe. Touches `content.ts` + `debug/perf-counters.ts` (`startPerfObservers`).

### D2. Skip hint machinery in frames that can't hold a hint (done)

A subframe that is `about:blank` or renders below ~2500px² (tracking pixels,
collapsed/hidden ad slots) can't show a usable badge, so it skips the page-wide
MutationObserver, the initial scan, and the limbo sweeper. The top frame is
always eligible; large legit cross-origin embeds (Google Docs/Workspace, OAuth
forms) stay fully active. `about:blank` is self-healing (navigating to a real
URL re-injects the script fresh); a frame that grows past the threshold is woken
by a one-shot `ResizeObserver`. Conservative threshold chosen to never strip
hints from real embeds — sized named-ad frames still run. Touches `content.ts`
(`frameMayHoldHints` / `activateHintMachinery`).

Deferred more-aggressive option: also skip cross-origin frames below a
banner-ad size cap (~300×300). Rejected for now — risks a small legit
cross-origin widget losing hints. Revisit if D1+D2 don't clear the warning.

## Recommended order

1. **A3** (1 hour) — immediate UX win
2. **A1** (1 day) — closes the badge-reattach class of bugs
3. **A2** (3-4 days) — broad CPU win on media sites
4. **B3** (2-3 days) — consolidates the lifecycle, prerequisite for B1/B2
5. **B1** (1-2 weeks) — biggest steady-state win
6. **B2** (1-2 weeks) — best follow-up to B1
7. **B4** (1 week) — final cleanup

Total: ~6-8 weeks of bounded work to take the extension from "usable" to "polished" on heavy SPAs.

## Tracking signals

Add to actuator log to validate each shipped optimization:

- `observer.count`: total live observer instances at steady state
- `mo.fires.per_sec`: main MO callback rate (sampled)
- `badge.paint.ms`: time from SPA-nav dispatch to first badge visible
- `discovery.budget_breaks`: rate at which drainDiscovery exceeds its 8ms budget

Sentinel: Firefox slow-extension warning should not fire under normal use on any of the top-20 SPA sites (YouTube, Twitter, Gmail, Reddit, etc.).
