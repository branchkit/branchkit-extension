# Investigation — Firefox "extension is slowing things down" on YouTube /watch

**Status:** reposition cost paths resolved; discovery churn remains the open root cause. Most pages and YouTube homepage are fixed (68% → 0–8% sustained CPU). On YouTube /watch the two reposition paths (scroll + deferred/ResizeObserver) are now scoped to drifted badges and no longer dominate. The unattributed-to-YouTube stalls persist, but in real-Firefox driver runs at 5000+ wrappers the unresponsive-script warning no longer reproduces.

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
- Our JS is the minority of each stall, and the recurring our-JS labels are `moCallback` + `processMutations` + `discoverInSubtree` + `drainDiscovery` — i.e. the **mutation/discovery pipeline**, exactly the documented open root cause below. The reposition trims removed a *different* cost path.
- **`wrapperCount` climbed to 5000+ and did not plateau** within a 60s soak (peak == final). Possible leak: wrappers may not be released as YouTube recycles/virtualizes comment DOM. This amplifies every `store.all`-iterating loop over time. Unconfirmed — needs a dwell-then-idle test watching `wrapperCount` + `wrapperLimboCount`.

**Already fixed since this doc was written:** the trail-URL sender bug (step 6 below) — content now sends `url: location.href` (content.ts shipPerfReport) and background prefers it over `_sender.url` (background.ts ~959). No longer an action item.

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

In rough order (updated 2026-05-30 — the harness now lets you measure each change in real Firefox via `scripts/_drive-firefox-youtube.mjs`; A/B with `BK_EXT`):

1. **Confirm whether `wrapperCount` leaks.** Dwell-scroll then idle and watch `wrapperCount` + `wrapperLimboCount` in the trail. If it doesn't plateau as YouTube recycles comment DOM, that's a release gap amplifying every `store.all` loop — fix it first; it's cross-cutting.
2. **Cheap pre-filter on added roots.** Before enqueueing `scheduleDiscovery(node)`, do `if (!node.querySelector(HINTABLE_SELECTOR) && !node.matches(HINTABLE_SELECTOR)) skip`. Native + bailable; should save the deeper filter pipeline cost on the ~4000 mutations/sec that add nothing actionable. This is the most direct hit on the documented root cause.
3. **Ancestor-dedup in `pendingDiscoveryRoots`.** If A contains B and both are queued, process A and skip B. Currently `discoverInSubtree` redundantly re-walks B's subtree as part of A's, then walks B again from B itself.
4. **Diff our `processMutations` against Rango's `mutationCallback`.** Look specifically for what Rango does *less* of, not more. Use `/private/tmp/rango/src/content/wrappers/ElementWrapper.ts:225-278`. Then check Rango's `deepGetElements` cost vs our `deepQuerySelectorAll`; port if materially cheaper per-walk.

**Done since the original list:** the trail-URL sender bug is fixed (see the 2026-05-30 update note above). Running Rango side-by-side is still worth doing but no longer blocks — the real-Firefox driver already measures our own builds directly.

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
