# Investigation: long-session performance & the Firefox slowdown (2026-07-03)

**Status (2026-07-03):** quick wins 1–4 of "Recommended order" LANDED same day
(firehose re-gate, perf-publisher visibility gate + watchdog stop, ScrollTimeline
gate on scroll-accel, clip-observer root release — four commits on main, unpushed;
tests + tsc green). Medium/strategic items (5–11) and live Firefox re-verification
still open.

Trigger: user-observed Firefox slowdown after days of uptime (possibly machine-wide), fixed by
restarting Firefox. Question: is the extension responsible, and where do our steady-state and
cumulative costs sit vs Rango/Vimium?

Method: four parallel audits — cumulative growth/leaks, steady-state hot paths, Firefox-vs-Chrome
divergence, Rango/Vimium comparison (fresh clones + issue trackers). Top findings spot-verified
in source. No code changed.

## Verdict

The Firefox symptom is plausibly ours. No single leak — a stack of compounding factors, each
individually "fine," that multiply under Firefox's platform behavior (weak hidden-tab timer
throttling ~1s vs Chrome's ~1/min after 5min; persistent event page vs SW resets; lazy session
restore explaining why restart fixes it — unrestored tabs run no content script).

## Findings (severity order)

### 1. Clip-observer retains one IO per scroll-container root forever — pins detached SPA subtrees
`src/observe/clip-observer.ts:39` — `observersByRoot: Map<Element, IntersectionObserver>`.
`unobserveTarget()` removes target mappings but never disconnects/deletes the per-root observer,
even at zero targets. Only teardown/flag-off drain it. The Map key + IO root strongly reference
the container Element; a detached SPA route's main scroller pins its whole subtree. Default ON
(`bkClipObserver`), both browsers. Hundreds of SPA navs/day → plausibly tens–hundreds of MB per
long-lived tab. CONFIRMED unbounded (all writers/removers traced). **Top memory suspect.**
Fix shape: per-root target counts with disconnect-at-zero, or a wanted-roots sweep mirroring the
existing target sweep.

### 2. Per-tab telemetry timers, ungated, × Firefox throttling × tab count
`src/content.ts:3784` `publishPerfSnapshot` every 250ms (full store walk + JSON.stringify of all
perf buckets — the "<500B" comment is wrong once buckets populate) and `content.ts:3804`
`shipPerfReport` every 5s (sendMessage → background → HTTP POST /perf-report to the plugin).
Top-frame-only, but NO dev gate and NO visibility gate — `DESIGN_TEARDOWN_OWNERSHIP.md` labels
these "(dev)"; the code disagrees. Watchdog self-rescheduling 250ms chain in
`src/debug/perf-counters.ts:295,311` is outside SessionResources (survives quiesceOrphan).
On Firefox hidden tabs timers still fire ~1/s (~45× Chrome's clamp), every sendMessage resets the
event page's 30s idle timer (never idles), and the POSTs burn CPU in the Go plugin too — the
machine-wide component. Cost of each snapshot also scales with wrapper count (finding 4).

### 3. Firefox-only: scroll-accel re-arm loop never converges
`content.ts:789-793` calls `setScrollAccelEnabled(enabled)` without `isScrollTimelineSupported()`
(the check lives only inside `createScrollAccel`, which returns null on Firefox stable). Every
settle (~10Hz cap during activity), `reconcileScrollAccel` walks every live badge →
`syncScrollAccelChain` → `findScrollableAncestors` (shadow-piercing scrollHeight/clientHeight/
getComputedStyle per ancestor, reads right after pipeline writes). On Firefox `current` never
becomes non-empty → `sameElements` fails → `bumpRearm()` (setAttribute, tickles the host-attribute
MO) → arm → null → repeat, forever, on every badge inside any inner scroller (Gmail, QuickBase,
YouTube — exactly the keep-open-for-days tabs). Live tell:
`document.querySelectorAll('[data-bk-accel-rearms]')` values in the thousands, and
`<html data-bk-scroll-accel="unsupported">`.

### 4. Wrapper/badge accumulation on infinite scroll + O(N) multipliers
Deliberate trade (self-documented at `src/core/wrapper-lifecycle.ts:124-131`): wrappers never
detach while connected; badge reuse keeps every ever-banded badge alive (host + closed shadow
root + 2 MOs each). ~1-5k wrappers / 1-3k badges per hour of heavy feed scrolling. The growth is
a feature (scroll-back correctness, label stability); the problem is what iterates it:
- `finalizeExpiredLimboWrappers` copies the WHOLE store (`[...store.all]`) every 250ms forever,
  hidden tabs included (`observe/limbo.ts:249`, `content.ts:3501`)
- `buildPerfSnapshot` walks the store at 4Hz (finding 2)
- `idRegistry.register` linear-scans the registry per registration (`scan/registry.ts:151-161`)
  → discovery trends O(N²) on big stores
- `reconcilePass` iterates all registered badges per scroll frame (cheap short-circuit per hidden
  badge, but O(all-ever-built))
Limbo/disconnectedAt retention itself is BOUNDED and correctly evicted (≤~500ms) — not a leak;
the detached-DOM leak vector is finding 1.

### 5. Firehose breadcrumbs at threshold 1 — diagnostic regression
`src/debug/firehose.ts:12` default threshold 1 ("for the nav-wedge diagnostic pass" — loosened
for diagnostics, never restored). MO-path call sites pass no threshold → up to 6 sendMessages per
foreign mutation batch (`mutation-source.ts:221-360`) at ~80 callbacks/s on YouTube → hundreds of
msgs/s, each → background → HTTP POST /debug-log when connected. Contradicts
INVESTIGATION_YOUTUBE_WATCH_PERF.md which records ≥100 gating. Keeps the SW awake. Cheapest win.

### 6. Label-pool leak window in the persistent Firefox background
Frames dying without their liveness-Port onDisconnect leak codewords; the only reclaim is
`clearAllStacks()` in init (`background.ts:1285-1293`) — Chrome gets it on every SW recycle,
Firefox once per browser session. Days → pool exhaustion → claims return empty → badges stop
painting. Functional "restart fixes it," not slowness. Fix shape: periodic dead-tab sweep.

### 7. Smaller accumulators
- `codewordMemory:{tab}:{frame}` session-storage keys never evicted per-frame (deliberate for
  Regime B), only on tab close — iframe-churny long-lived tabs accumulate dead-frame keys
  (`labels/codeword-memory.ts:45`; frame-scoped clear exists but has no caller). Several MB/day-old
  portal tab, memory-backed so restart clears it.
- `branchkit_references` in storage.local: add-only, no pruning (`background.ts:182-242`). Slow.
- `contrastCache` in `render/badge-colors.ts:175`: unbounded in theory, hundreds of entries
  realistically. Low.
- Plugin-side extension-perf.jsonl bounded (2×64MiB rotation) but steady disk writes.

### 8. Adjacent correctness bug (not growth)
`container-resize-tracker.ts:53-64` + `hints.ts:938-951`: `HintBadge.remove()` untracks
`anchorParent` even when `refine()` never tracked it → refcount underflow unobserves a container
another badge still tracks. Silently kills resize tracking for surviving badges.

## What's clean (checked, for the record)
Steady-state scroll/render architecture is in good shape and matches or beats Rango: rAF
reconcile loop is scroll-gated and self-cancelling, read-all-then-write-all (no thrash),
composited transforms, `contain: layout size style`, shared constructable stylesheet, singleton
IOs with batched claim/release, settle gathers over bounded sets, grammar delta-sync batched
(50ms IT flush + 80ms sync debounce), occlusion hit-tests bounded (~5/badge at settle cadence),
SSE close-before-reopen with capped backoff (no handler leaks), Web Animations cancelled on all
paths, background maps pruned on tab close, debug rings bounded. Measured history: extension's
share of worst-page scroll stalls is the minority (70-95% is the page's own work).

## Rango / Vimium comparison
- Vimium's cheapness (zero rest cost) is structurally unavailable: hints exist ~2s then teardown
  to nothing; always-on + cross-SPA-nav label stability requires persistent wrappers. Its known
  ceiling is discovery cost (full-DOM enumeration, 2-3s on large pages in Firefox — issue #2489).
- Rango (closer comparable, always-on capable): we're AHEAD on background tabs (lazy discovery vs
  Rango wrapping everything at init even hidden) and mutation scoping (our reconciler vs Rango's
  debounced ALL-wrappers refresh at 10Hz). Rango's page-freeze live-lock (#216: reattach loop vs
  a fighting page) is the lesson our nav-wedge fix already encodes.
- Worth adopting: (a) giant-DOM circuit breaker — >25,000 elements → viewport-only wrapper
  materialization with suspend-on-exit (motivated by ~288k-element pages); we have no equivalent
  for a visible tab. (b) 5 module-level singleton observers for the whole page vs our ~2 MOs per
  badge — the observer half of DESIGN_HINT_REUSE. (c) focus-driven hint hiding (PLAN item 4,
  still unbuilt, trivially cheap). (d) two-tier necessary/optional label claims with cross-frame
  reclaim, if codeword pools ever get tight.
- Neither tracker shows a leak pattern matching our symptom (Rango: zero memory issues on file —
  but only because its state dies on real navigation; two latent retainers in its code
  (never-pruned entriesSeen Set, MO-removedNodes-dependent wrapper freeing) are patterns we
  cannot afford since we survive SPA navs indefinitely).
- Vimium's `showPopover()` top-layer trick (zero z-index computation) trades away in-page
  anchoring for nested scrollers — our single biggest always-on win. Don't take it.

## Recommended order
Quick (hours, high yield):
1. Firehose: restore ≥100 thresholds or add a global gate (finding 5).
2. Perf publishers: pause on `document.hidden` + dev-flag the 5s ship; fold watchdog chain into
   SessionResources (finding 2).
3. `setScrollAccelEnabled(enabled && isScrollTimelineSupported())` or short-circuit
   `syncScrollAccelChain` when no ctor (finding 3).
4. Clip-observer root release at zero targets (finding 1).
Medium:
5. Firefox background: periodic dead-tab label-pool sweep (finding 6).
6. `idRegistry.register` linear scan → Map lookup (finding 4 multiplier).
7. Limbo sweeper: skip when store small/tab hidden, or event-arm it (finding 4 multiplier;
   HIDDEN_TAB_SUSPEND deferred this — the deferral predates knowing store size grows unboundedly).
8. Container-resize refcount underflow (finding 8).
9. codewordMemory dead-frame eviction (call the existing frame-scoped clear on liveness loss).
Strategic:
10. Giant-DOM circuit breaker à la Rango.
11. DESIGN_HINT_REUSE observer half: shared singletons instead of 2 MOs/badge.

## Doc housekeeping
- PLAN_RANGO_TECHNIQUES.md item 2 (stacking-context z-index) marked "Not built" — stale;
  `src/placement/stacking.ts` landed 2026-06-02.
- DESIGN_TEARDOWN_OWNERSHIP.md labels publishPerfSnapshot/shipPerfReport "(dev)" — they are not
  dev-gated in code.

## Live confirmation on the user's running Firefox (before any fix)
- `document.documentElement.getAttribute('data-bk-scroll-accel')` → expect `unsupported`.
- Max of `[...document.querySelectorAll('[data-bk-accel-rearms]')].map(e => +e.getAttribute('data-bk-accel-rearms'))`
  on a long-open Gmail/QuickBase tab → thousands confirms finding 3.
- `about:memory` → measure → look for detached-window/orphan-node counts in BranchKit-hosting
  content processes → corroborates finding 1.
- `document.documentElement.dataset.branchkitPerf.length` → snapshot size vs the "<500B" claim.
