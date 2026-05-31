# Investigation — Firefox "extension is slowing things down" on YouTube /watch

**Status:** the *scroll-soak* freeze is resolved — preliminary field confirmation 2026-05-30 (user reports normal real-Firefox use with no freeze "so far"; keep watching over longer sessions before treating as permanently closed). Every scroll-path lead is addressed — discovery churn (ancestor-dedup + light-DOM pre-filter), both reposition paths (scroll + deferred scoped to drifted), and the trail-URL bug. In real-Firefox driver runs at 5000+ wrappers the unresponsive-script warning no longer reproduces under scroll; the residual scroll stalls are 70–95% YouTube's own layout/paint (confirmed by an extension-off control that stalls as hard or harder).

**OPEN (2026-05-30): a distinct *nav-time* wedge — reproduces in the driver, but real Firefox is clean.** See the "Nav-time wedge" section below. In the A/B driver a same-document SPA nav (clicking a YouTube recommendation, /watch → /watch) wedges the renderer so hard Firefox's debugging protocol stops responding, while an extension-off control on the *same* nav sails through — so under harness stress the cost is the extension's, not YouTube's. **Re-confirmed deterministically 2026-05-30 after `8c0e368`** (which fixed only the scroll-soak path, not this one). **But** the user's *real* Firefox navs in the same window completed cleanly (`cs_nav_step` breadcrumbs all fire on schedule, no wedge), matching their lived experience — so this is "reproduces under harness stress, low real-world impact," not a confirmed production regression. Attribution is still blocked because the driver wedges too hard to ship any breadcrumb/perf line; pinning the step needs a *real-Firefox* repro. This is the current open code lead.

**Audience:** a fresh agent picking up this work cold. The session that produced this doc burned through 8+ iterations on the symptom, made real but incomplete progress, and stepped back to write this up. Rango handles YouTube /watch without this problem; we have a local copy at `/private/tmp/rango/` to compare against.

---

## Update — 2026-05-30 (reposition paths resolved; real-Firefox harness landed)

A later session built the tooling the original doc lacked (a way to drive **real** Firefox with the live extension and measure the freeze ourselves) and resolved the reposition cost paths. What changed:

**New harness (committed):**
- `scripts/_drive-firefox-youtube.mjs` — drives real Firefox (playwright-webextext, `installTemporaryAddon`) on /watch with the nesting path forced (`layout.css.anchor-positioning.enabled: false`), tall viewport + dwelling deep-scroll to reproduce the heavy state. Reads perf via `document.documentElement.dataset.branchkitPerf`. `BK_EXT=<dir>` selects an alternate build for A/B.
- `scripts/_drive-firefox-control.mjs` — same page/soak with NO extension and a mirrored page-injected watchdog, to attribute stalls to YouTube's own work.
- `scripts/_watch-perf.py` — reads the JSONL trail, surfaces CPU share / longtasks / reposition buckets and watchdog stall attribution.
- Watchdog stall attribution (perf-counters.ts): a breadcrumb ring splits each ≥100ms main-thread block into `trackedMs` (our instrumented JS) vs `unattributedMs` (browser render/paint of injected DOM, or page script).

**Fixes landed:**
- `8b2c8fe` — window-scroll reposition scoped to drifted badges.
- `0525e98` — deferred/ResizeObserver/mutation/focus/transition reposition also scoped to drifted (was full-replace 'all'). Interleaved real-Firefox A/B at ~4500 wrappers: total reposition CPU −43%, full-replace path −73%. Window `resize` stays 'all' for genuine global layout/clamping changes.

**Key findings from the heavy-state repro (5235–5449 wrappers, ~200 painted badges):**
- Every main-thread stall is **70–95% unattributed** (YouTube's own layout/paint). The extension-off control stalls as hard or harder than extension-on — YouTube alone blocks the main thread up to ~1s during comment-load scroll.
- Our JS is the minority of each stall. The recurring our-JS labels are `moCallback` + `processMutations` (receiving YouTube's mutation firehose) + `discoverInSubtree` + `drainDiscovery` + reposition. All already optimized — see below.

**Discovery churn is already addressed (commit `8fe4e4c`, predates this doc's "open root cause" framing).** The mutation→discovery path now has ancestor-dedup (`hasQueuedAncestor`) and a shadow-sound light-DOM pre-filter (`subtreeMaybeHintable`: native `matches()`/`querySelector()`, bails at first hit; shadow-hosted hintables arrive via the separate `SHADOW_EVENT` attach path). Real trail numbers at the heaviest state (wrap=5283): of **45,730 enqueued roots, 96% deduped, 1% skipped by the pre-filter, only 2% (939) actually walked** (1677ms cumulative, ~1.8ms each). 98% of YouTube's mutation churn is filtered before the expensive walk. The residual `moCallback`/`processMutations` cost (~1674 batches) is the irreducible cost of *receiving* the mutations; cutting it would mean narrowing the MutationObserver's scope, which risks missing real DOM changes for little gain (our share is already the minority).

**Wrapper-leak hypothesis — refuted (2026-05-30).** A scroll-accumulate-then-idle test showed `wrapperLimboCount` and `wrapperDisconnectedOutOfLimbo` stay **0** throughout, and `wrapperCount` **plateaus** the instant scrolling stops (flat for 30s idle). The earlier "climbs to 5000+ / peak == final" reading was an artifact of scrolling continuously the whole soak (always loading new content, never idling). The store ratchets up to the session high-water-mark and doesn't drop on scroll-to-top — but that's because YouTube /watch keeps all rendered comment/suggested DOM live (no virtualization), so the wrappers correctly track still-connected elements. Not our leak. Bounding it would need viewport-scoped wrapper eviction, but the prior "strict-viewport IO" attempt was reverted for per-element overhead — poor trade.

**Already fixed since this doc was written:** the trail-URL sender bug (step 6 below) — content now sends `url: location.href` (content.ts shipPerfReport) and background prefers it over `_sender.url` (background.ts ~959). No longer an action item.

---

## Nav-time wedge (OPEN, 2026-05-30) — attributed to the extension

**Symptom.** A same-document SPA navigation on YouTube (clicking a recommendation, /watch → /watch) freezes the tab. Distinct from the scroll soak: it's a single hard block at nav time, not sustained scroll CPU.

**A/B attribution (the gate the scroll work taught us to run first).** `scripts/_drive-firefox-nav-ab.mjs` drives the *same* nav under identical page-injected instrumentation (a heartbeat ticking every 100ms + a watchdog), with the only variable being whether the extension is loaded:

| Metric (25s post-nav window) | Control — no extension | Extension ON |
|---|---|---|
| reads that succeeded | 31/31 | ~1, then protocol-dead |
| heartbeat ticks (≈250 ⇒ thread free) | 263 | 29 (near-frozen) |
| worst single stall | 531ms | 1171ms |
| renderer | stayed live | wedged; juggler pipe died |

Control sails through; extension-on nearly freezes. **The nav-time cost is ours.** (Contrast the scroll case, where the control stalled as hard ⇒ YouTube's cost.)

**Re-confirmed 2026-05-30 (deterministic, after `8c0e368`).** Re-ran the A/B driver on the current build (which includes `8c0e368`'s full-page-swap discovery slicing) to check whether the scroll-soak fix also closed this. It did not — the nav-time wedge is a *separate* path:

| Arm | heartbeat ticks | reads timed out | worst stall |
|---|---|---|---|
| Control (no ext) | 262 (free) | 0/31 | 1006ms |
| Extension ON, run 1 | 29 (wedged) | 1/2 | 869ms |
| Extension ON, run 2 | 29 (wedged) | 1/2 | 951ms |

Both ext-on runs reproduced the wedge identically (29 ticks, only ~2 reads completed in 25s, the rest 4s-timed-out; `ctx.close()` then hung on the dead renderer). `8c0e368` fixed the *scroll-soak* HUGE_MUTATIONS path; this `from_cache`-nav path is untouched by it. So this section stays **OPEN**.

**Important divergence — driver wedges, real Firefox does not.** During the same window the user's *real* Firefox did several /watch SPA navs, and their `cs_nav_step` breadcrumbs in `actuator.log` show the from_cache path **completing cleanly every time**: `drop_disconnected` + `sync_now` at `at_ms:0`, then `deferred_scan` firing on schedule at `at_ms:~303`. No wedge — matching the user's lived experience that nav "feels fine now." Only the Playwright-driven Firefox wedges. Candidate reasons the harness amplifies it: cold fresh profile (no warm HTTP/media cache), Playwright/juggler instrumentation overhead, and a constrained single-tab context — none of which the real browser hits. This does **not** clear the path (the driver proves the extension *can* wedge a /watch nav), but it downgrades it from "confirmed production regression" to "reproduces under harness stress; real-world impact currently low."

**Attribution still blocked — the driver can't self-report, and every readback channel dies with the wedge.** The driver's video (`qQDrqV5Hw4c`) produced **zero** usable lines in the perf trail and `actuator.log` — it wedges too hard to ship anything, exactly as the original note predicted.

Two things learned 2026-05-30 while trying to attribute it anyway:

1. **The driver is Firefox *Nightly* (`org.mozilla.nightly`), a different browser bundle from the user's daily Firefox (`org.mozilla.firefox`).** Playwright's bundled Firefox is Nightly. The focus gate confirms it: while the driver window held OS focus, the plugin logged `grammar batch REJECTED inactive_browser bundle="org.mozilla.firefox" focused="org.mozilla.nightly"` — i.e. it rejected the user's *real* Firefox because the driver's Nightly was the focused browser. So (a) the clean `cs_nav_step` breadcrumbs cited above are genuinely the stable browser, not the driver, and (b) the wedge is currently only observed in the cold, Playwright-instrumented Nightly harness.

2. **The recovery-read trick does not work.** I extended the driver to wait ≤90s post-wedge and read the page's own `dataset.branchkitPerf` CPU buckets (which survive in the page even when it can't ship them). It hung without printing — once the wedge kills Firefox's juggler pipe, *every* Playwright channel dies, DOM reads included. There is no read path through Playwright that outlives this wedge.

**So attribution needs a side-channel that leaves the wedged renderer.** Two viable options, both real work: (a) add a dev-only ring buffer in the background service worker that retains the last N `cs_nav_step`/perf messages, then read it from the SW's *own* Playwright target — a separate juggler target that survives a content-main-thread wedge; or (b) run the driver with the Nightly window genuinely OS-focused so the existing `cs_nav_step`/perf POSTs reach the plugin and land in `actuator.log` despite the content wedge. Until one of those lands, **which** step wedges is unproven — and note the leading hypothesis (from_cache teardown+rebuild) is itself unconfirmed: the wedge may instead be the connection-independent baseline path (MutationObserver firehose + discovery + badge teardown/re-layout on YouTube's full-page DOM swap), which runs regardless of whether the plugin delivered a rescan. Do not build the fix until one of these channels pins the step.

**What fires at nav (grounding for the fix, not yet a measured hot-path attribution).**
- Detection is correct and verified: `background.ts` `onHistoryStateUpdated`/`onReferenceFragmentUpdated` → debounced `scheduleSpaRescan` → bounded `rescan` action → `PageSession.onUrlChange` → `rescanForNav` (confirmed on real Firefox via `cs_rescan_received {reason:"spa_nav"}`).
- **`scheduleSpaRescan` hardcodes `from_cache: 'true'`** (`background.ts:1222`). So *every* SPA nav — including a genuine video→video content change — takes `rescanForNav`'s fast branch (`content.ts:1596`): `dropDisconnectedWrappers()` + `syncNow()` + a deferred `doScanBatched()` at +300ms. It never takes the full-`doScan` branch and never distinguishes app-refocus from a real content swap.
- That deferred full-page walk then **races YouTube replacing the entire page DOM** (a much larger single mutation burst than incremental scroll), so the discovery firehose + the rescan's own walk + re-establishing ~200 badges all land together on a fresh heavy page.

**Still to pin before designing the fix:** which of those is the dominant cost (the `doScanBatched` walk, the mutation-firehose drain from the DOM swap, or badge re-layout). The page wedges too hard to self-report — the new page shipped *zero* perf snapshots — so capture must either wait for post-burst recovery (read the watchdog breadcrumb's `topLabels` from the trail once a snapshot finally ships) or add nav-path timing that ships before the wedge.

**Instrumentation added 2026-05-30 (to pin it on the next repro).** The attribution was stuck because the watchdog only attributes a stall window against `recordCpu` labels; anything unlabeled lands in `unattributedMs`, indistinguishable from YouTube's own layout/paint. The from_cache fast path's two synchronous steps were both unlabeled. Closed that:

- `dropDisconnectedWrappers` (`content.ts`) now emits `recordCpu('dropDisconnectedWrappers', …)` + a `:size:` bucket. On a full DOM swap *every* wrapper disconnects at once, so if this step is the cost it'll now surface in `topLabels` instead of hiding in `unattributedMs`.
- `rescanForNav`'s from_cache branch now posts `pipeline.cs_nav_step` breadcrumbs (`drop_disconnected` → `sync_now` → `deferred_scan`, each with `at_ms` relative to rescan entry) to the service worker *before* each heavy step. The SW never wedges, so even a hard freeze leaves a trail of the last step entered + inter-step gaps — unlike the post-completion `cs_scan_completed`, which never ships when the thread freezes. (`syncNow` itself is left unlabeled for CPU on purpose: it's mostly `await postBatch` network time, so a wall-clock mark would be misleading; the breadcrumb gap on either side of it captures its real wall cost.)

**Repro to pin it:** run `scripts/_drive-firefox-nav-ab.mjs` (extension-on arm) after a build, do the /watch → /watch nav, then read the trail: the last `cs_nav_step` before the watchdog stall names the step it died in; if a perf snapshot ships on recovery, its `watchdogStalls[].topLabels` now distinguishes `dropDisconnectedWrappers` / `processScanBatch:syncA|syncB` (the walk) / `moCallback`+`processMutations`+`drainDiscovery` (the firehose drain) from `unattributedMs` (browser reflow of our badge DOM, i.e. re-layout). high `unattributedMs` with low tracked ⇒ badge re-layout / browser paint; high `doScanBatched`/`syncA|syncB` ⇒ the walk; high `moCallback`/`drainDiscovery` ⇒ the firehose.

**Leading hypothesis (not yet measured — don't build the fix until the repro above confirms).** `scheduleSpaRescan` hardcodes `from_cache:'true'`, a path designed for app-*refocus* where the DOM is unchanged. On a genuine content swap it does the worst of both: a full teardown (every wrapper disconnects → dropped → ~200 deletes synced) *and* a full rebuild (the deferred `doScanBatched` at +300ms), stacked and timed to land in the middle of YouTube's new-page render + the giant DOM-swap mutation burst. If confirmed, candidate fixes (cheapest first): push the reconciliation walk to `requestIdleCallback`/a longer adaptive delay so it stops racing the render burst; gate the walk on the mutation firehose settling into a quiet window; or have the content script distinguish "URL changed, DOM same" (skip teardown) from "URL changed, DOM swapped" (idle-scheduled rebuild).

---

## Problem statement

Firefox shows a "BranchKit Browser is slowing down Firefox. To speed up your browser, stop this extension." dialog with a Stop button. On YouTube /watch during scroll, the warning fires; sometimes the tab freezes outright (no more snapshot publishes), occasionally the whole Firefox process appears to stall (cross-tab effects: a `studio.youtube.com` tab in the trail had a 16-second wall gap between snapshots while our /watch tab was hung).

Original prior commit that started this work: `a45c48b perf: cached text probe + perf JSONL trail + watchdog`. That added the perf JSONL trail at `~/Library/Application Support/BranchKitDev/plugins/browser/extension-perf.jsonl` and a watchdog that recorded any single-task stall ≥100ms. The watchdog never fired during the freeze — that's a load-bearing diagnostic clue.

## What the watchdog missed

Firefox's heuristic for "extension is slowing things down" is **sustained CPU share**, not single-stall length. The cached-text-probe + watchdog work was targeting the wrong metric. We added `cpu.share` to each snapshot (now in `buildPerfSnapshot()` in content.ts ~line 3127) that measures `sum(bucket.totalMs delta) / wallMs delta` since the prior publish. This is the metric Firefox is reacting to. With it in place, the dominant cost paths became visible:

| Scenario | wall | bucket breakdown | pct |
|---|---|---|---|
| YouTube homepage, initial load (wrap=214) | 419ms | moCallback=34/96ms · processMutations=34/89ms · discoverInSubtree=673/84ms · placeBadges:reposition=2/9ms | **68.7%** |
| YouTube homepage, navigation (wrap=696) | 134ms | placeBadges:reposition=1/17ms · recheckPendingVisibility=3/16ms · placeBadges:show=1/7ms | **30.6%** |
| YouTube /watch, scroll burst (wrap=64) | 97ms | drainDiscovery=2/16ms · **discoverInSubtree=397/13ms** · drainReevaluations=1/2ms | **36.1%** |

That last row is the unresolved worst case: 397 discovery walks in 97ms = **~4000 walks/sec**, almost none of which find new hintables (wrap stayed at 64). YouTube fires DOM mutations at a sustained rate our discovery throttling can't fully absorb.

## What we tried (in order)

All committed in `c477f02 perf: cpu.share metric + 5 partial mitigations`.

1. **`cpu.share` metric** — sustained-CPU% per publish window with per-bucket deltas. Made every subsequent diagnosis possible. Keep.

2. **Strict-viewport IO + per-wrapper `inStrictViewport` flag** — second `IntersectionObserver` with `rootMargin: '0px'` to narrow `scheduleReposition`'s set to badges the user can actually see. **Reverted** — when wrap counts climbed past ~250 during scroll on /watch, the doubled per-element observation overhead appeared to contribute to a process-wide stall. The scroll debounce (#6 below) subsumes the optimization.

3. **`scheduleDiscovery` Set + rAF drain** — mirrors Rango's debounced refresh pattern. MO callback no longer calls `discoverInSubtree` synchronously per added node; instead it adds the root to `pendingDiscoveryRoots` and schedules a `drainDiscovery` rAF that processes the queue. Pre-fix YouTube homepage saw 673 sync discovery calls in 419ms (84ms total work); post-fix saw 48 calls / 1ms in the equivalent window. Keep.

4. **Time-sliced `drainDiscovery`** — added an 8ms budget per drain pass with re-queueing of unprocessed roots. Intended to prevent any single drain from blocking the main thread on a giant root or a large batch. Keep, but it's not the limiting factor for /watch — see "what didn't work" below.

5. **Time-sliced `scanInBatches`** — the previous implementation called `collectHintables` upfront, eagerly walking the entire document + filtering every candidate (isVisible/isHintableExtra/isRedundant) before yielding the first batch. On heavy pages that's a single 500ms+ blocking task that the snapshot publisher's setInterval can't survive. Rewrote `scanInBatches` to interleave walk + filter, yielding a batch every `batchSize` accepted candidates so the caller's `await setTimeout(0)` between batches drains the event loop. Keep.

6. **Initial scan deferred via `setTimeout(0)`** — `chrome.storage.local.get('alphabet', cb)` callback used to call `doScan()` synchronously, blocking the publisher's first sample. Now wraps in a single-tick defer. Tried `requestIdleCallback` first — it never fired on YouTube /watch (no true idle window), so even with the 2s timeout the scan stretched indefinitely and hints never appeared. Plain `setTimeout(0)` is what works. Keep.

7. **Scroll listener debounced via `scheduleDeferredReposition`** — `window.addEventListener('scroll', scheduleReposition)` was firing ~30 times/sec during scroll, each one running `placeBadges` over the visible set (~8ms per call at wrap=99 = 22% sustained during scroll, tripped Firefox warning, AND starved YouTube's own scroll-driven lazy-loading so content below the fold never rendered). Routed scroll through the 100ms `scheduleDeferredReposition` debounce — per the existing architectural note, badges already follow scroll via CSS positioning, the JS reposition is for edge cases only. Result: scroll spike dropped 22% → 8%, and YouTube's lazy-load started working again. Keep.

## What we tried that didn't work

- **`requestIdleCallback` for initial scan** — never fires on hyperactive pages even with a 2s timeout, leaves hints absent indefinitely. Replaced with `setTimeout(0)`.
- **Strict-viewport IO** — solved one workload (reposition cost on steady-state heavy pages) but introduced another (per-wrapper observation overhead during high-wrap scroll on /watch). Net negative.
- **Threshold-gated strict-viewport filter** — same per-wrapper overhead problem regardless of threshold.
- **Defaulting `inStrictViewport=false`** — solved a navigation-burst spike but didn't address the underlying observation overhead.

## Why /watch is still bad after all six fixes

The remaining hot path on /watch during scroll is:

1. YouTube fires DOM mutations at ~4000/sec (real number from the trail — `discoverInSubtree=397 calls in 97ms`)
2. Each childList mutation enqueues an added root into `pendingDiscoveryRoots`
3. `drainDiscovery` time-slices at 8ms per rAF pass, processes ~200 roots/pass, re-queues the rest
4. Each `discoverInSubtree(root)` calls `scanElements(root)` → `collectHintables(root)` → walks the subtree, runs the filter pipeline (selector match, EXCLUDE check, hint-host check, isVisible, isRedundant, etc.) on every node

The total work is large *because* the input is large. The queue stays full because YouTube keeps emitting. Time-slicing prevents any single rAF callback from blowing the budget, but the cumulative work across many rAFs still consumes a significant CPU fraction.

Critically: **almost none of those 4000 mutations/sec add new hintables.** Wrap=64 stayed at 64 during the spike. We're walking subtrees that turn out to contain nothing actionable for us.

## Why Rango doesn't have this problem (the open question)

We have Rango's source at `/private/tmp/rango/` for comparison. Key files:

- `src/content/wrappers/ElementWrapper.ts` — its MutationObserver setup
- `src/content/wrappers/refresh.ts` — its debounced refresh
- `src/content/wrappers/ElementWrapper.ts:77` — `addWrappersFrom(root)` — its discovery walk

Rango's mutation callback (`ElementWrapper.ts:225-278`) walks added/removed nodes synchronously and calls `addWrappersFrom` per added node. No throttling, no debouncing of the discovery walk itself. The debounce is on `refresh()` (positioning, color updates, isHintable recompute) — not on discovery.

So Rango does discover synchronously. Yet it doesn't trip Firefox on YouTube /watch (per the user's testing — we should verify). The structural difference we haven't yet identified is somewhere in:

1. **What it queries.** Rango's `deepGetElements` (per `addWrappersFrom`) returns ALL elements, then filters by `isHintable`. We use a CSS selector to pre-filter (`HINTABLE_SELECTOR` or `EXTRA_SELECTOR`). Our approach should be cheaper per-mutation — but maybe the selector is too broad and matches non-hintable things YouTube changes a lot? Worth dumping `scanCandidatesSeen` vs `scanKeptAsHintable` ratio.
2. **When it queries.** Rango may bail early on mutations that look like they can't possibly contain hintables (a `head` mutation, a text-only change, a style-only change). Our `processMutations` filters out `attributes` mutations (those go to `scheduleReevaluation`), but for `childList` we enqueue every added Element regardless of type.
3. **What it does with results.** Rango's discovery feeds a `wrappers` map; nothing else happens until `refresh()` debounces. Our discovery directly calls `attachWrapper`, which calls `tracker.observe` + `resizeObserver.observe`. Per-wrapper observation cost during high-volume discovery may be where we diverge.
4. **Shadow DOM walk.** Both walk shadow roots. Need to verify the recursive cost is comparable.

This is the lead for the next agent. **Read Rango's `addWrappersFrom`, `mutationCallback`, and the things they call. Compare what gets done per mutation. Find the structural difference.**

There are local comparison scripts in `scripts/_rango-compare.mjs` and `scripts/_rango-aggressive.mjs` from earlier work — these load both extensions side-by-side and might be useful for A/B testing.

## Other things worth knowing before re-investigating

- **The trail URL is the sender frame URL, not `location.href`.** `_sender.url` (in `src/background.ts` ~line 954) captures the URL the content script was injected into. After YouTube SPA navigation from homepage → /watch, the sender URL stays as `www.youtube.com/` even though `location.href` is `/watch`. So trail samples labeled `www.youtube.com/` may actually be from /watch tabs. This caused real confusion mid-investigation. Worth fixing — pass `location.href` through the message body and prefer it over `_sender.url`.
- **Snapshots publish every 5s** (`setInterval(shipPerfReport, 5000)` in content.ts). If the main thread is blocked for more than ~5s, we lose visibility. A freeze produces no trail data — you only see what happened in the *prior* window. That's why the smoking-gun sample for /watch is so valuable (one snapshot caught the spike before the freeze).
- **Content scripts run per-frame.** YouTube /watch has the chat as a separate iframe. The chat's content script publishes separately. Watch-page samples and chat-iframe samples are distinct rows in the trail. Chat samples carry `youtube.com/live_chat...` URLs.
- **The user runs `hint_visibility="always"`** (per their stored preferences) — hints paint automatically on tab focus. Don't tell them to say "show".
- **The MutationObserver is connected to `document.body || document.documentElement` with `subtree: true, attributes: true, attributeFilter: ['class','style', ...]`.** So it sees the entire document.

## Suggested next steps for a fresh investigation

**As of 2026-05-30 the code leads below are all done.** What remains is field confirmation, not implementation.

1. **Field confirmation (the real open item).** Have the user run a long real-world /watch session in their actual Firefox with the current build (real scroll cadence, real session length, real extension+browser) and confirm the unresponsive-script warning does not appear. The driver reproduces 5000+ wrappers without the warning, but only a real session closes this out for sure.
2. **Only if the warning resurfaces in the field:** the one untried lever is narrowing the MutationObserver scope (it currently observes `document.body` with `subtree: true, attributes: true`, so it receives YouTube's full ~1674-batch mutation firehose). This is high-risk — narrowing risks missing real DOM changes — so it's a last resort, not a default.

**Done since the original list (do not re-attempt):**
- Discovery pre-filter + ancestor-dedup — committed `8fe4e4c`; 98% of enqueued roots filtered before the walk (see update note above).
- Both reposition paths scoped to drifted — `8b2c8fe` (scroll) + `0525e98` (deferred/RO); −43% reposition CPU.
- Trail-URL sender bug — fixed.
- Wrapper-leak hypothesis — refuted (limbo/outOfLimbo stay 0, count plateaus when idle).
- Rango side-by-side comparison is no longer needed to make progress — the real-Firefox driver measures our own builds directly.

## What to commit / what to keep

Committed in `c477f02`:
- `cpu.share` metric — keep regardless of outcome, it's the right diagnostic
- 5 mitigations listed above — meaningful improvement on most pages; partial improvement on /watch

Not committed (this doc): the design context above.

## Reproducing the worst case

1. Build extension: `cd branchkit-extension && npm run build`
2. Load `dist/firefox/` in Firefox via `about:debugging` → "Load Temporary Add-on"
3. Open a YouTube `/watch?v=...` URL
4. Wait for the page to settle (hints appear at top)
5. Scroll down quickly through comments / suggested videos
6. Within ~10-30 seconds the warning typically appears

Trail data lives at `~/Library/Application Support/BranchKitDev/plugins/browser/extension-perf.jsonl`. Each line is one snapshot. The grep recipe used throughout the investigation:

```bash
tail -300 ~/Library/Application\ Support/BranchKitDev/plugins/browser/extension-perf.jsonl | \
  python3 -c "
import json, sys
for line in sys.stdin:
    e = json.loads(line)
    if e['browser'] != 'firefox' or 'youtube' not in e['url']: continue
    s = e['snapshot']
    share = s.get('cpu', {}).get('share') or {}
    top = sorted(share.get('buckets', {}).items(), key=lambda kv: -kv[1]['dMs'])[:5]
    bk = ' '.join(f'{k}={v[\"dCount\"]}/{v[\"dMs\"]}ms' for k,v in top)
    print(f't={e[\"ts\"][11:23]} wrap={s.get(\"wrapperCount\"):4} pct={share.get(\"pct\",0):5}% | {bk}')
"
```
