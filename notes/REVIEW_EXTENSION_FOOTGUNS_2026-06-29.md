# BranchKit Extension — Foot-gun Review + Firefox Ghost-Hint Investigation

Date: 2026-06-29
Trigger: report of "ghost hints" appearing while scrolling Wikipedia in Firefox,
plus a request for a general evaluation of weak points.

Method: direct read of the positioning, lifecycle, and label/grammar pipelines
(`placement/`, `render/hints.ts`, `render/reconcile-positioner.ts`,
`lifecycle/`, `observe/intersection-tracker.ts`, `observe/visibility-tracker.ts`,
and the show/build path in `content.ts`), plus three parallel subsystem reads:
background/injection/orphan/IPC, labels/grammar-epoch/plugin-liveness, and
scan/activate/dispatch/storage. Findings marked **verified** were checked
against source directly; the rest carry file:line cites and are flagged as
needing live confirmation.

---

## 1. The Firefox / Wikipedia ghost hints

### Leading hypothesis: stuck-translucent `bk-pending` badges

A badge paints **translucent** (`opacity: 0.55`, the `bk-pending` class) from the
moment it shows until the native plugin acknowledges its codeword in the voice
grammar. The class is added in `render/hints.ts:746-749` and only removed by
`markGrammarReady()` (`render/hints.ts:763`, driven from `content.ts:2008`).

The ACK arrives on two different cadences:

- **First-paint badges** get a synchronous ACK from the scan-path POST
  (`content.ts:1980-2008`): the response's `succeeded` set drives
  `markGrammarReady()` in the same task, so they go opaque immediately.
- **Scroll-revealed badges** take the async path: the IntersectionObserver
  claims a codeword (`observe/intersection-tracker.ts:182-189`), the codeword is
  pushed to the plugin in a later grammar batch, and `markGrammarReady` only
  fires when that batch's response returns.

`isPaintReady` (`content.ts:1113`) returns true (paint opaque) only when
`grammarReady` is set OR the voice alphabet isn't loaded at all. So a
keyboard-only / standalone user never sees translucency. With BranchKit
connected, the async grammar-batch path is the one in play for everything
revealed by scrolling — and on a link-dense page in always-hints mode, that is
a lot of badges per scroll.

That async path is exactly where the Firefox SSE/grammar seam is weakest (see
section 3): Firefox uses a direct `EventSource` rather than Chrome's offscreen
document, and the labels review found several ways an ACK can be dropped, mis-
arbitrated, or stranded after a republish cap. Any of those leaves the
scroll-revealed badges sitting at 55% opacity — read on the page as "ghost
hints that show up when I scroll."

This is the leading hypothesis but is **not yet confirmed against a live
Firefox + Wikipedia session.**

### One-step confirmation

In the Firefox page console on the article, after scrolling:

```js
document.querySelectorAll('[data-bk-pending]').length
```

`data-bk-pending` is mirrored onto each badge's light-DOM host while it's
translucent (`render/hints.ts:748`) and removed by `markGrammarReady`
(`:765`). If this stays > 0 after the page settles, the ghosts are
stuck-translucent badges and the fix is in the Firefox grammar-ACK path, not
positioning.

### Alternative: stale-position / sticky badges

If `data-bk-pending` is 0, the ghosts are a positioning artifact. Two real
weaknesses feed this:

- `_viewportFixed` is computed **once** at construction and on retarget
  (`render/hints.ts:407`, `container-resolution.ts:22`) and never re-evaluated.
  `position: sticky` is treated identically to `fixed`
  (`container-resolution.ts:27`), but a sticky element rides the scroll until it
  sticks. So a sticky badge's correctness depends entirely on the per-frame JS
  chase.
- The off-screen-hide sweep only runs at **settle**, not during the scroll
  itself (`content.ts:2796-2826` vs the per-frame `reconcileScrollFrame` at
  `:2845-2854`, which repositions but does not hide). On Firefox there is no
  ScrollTimeline accelerator (`render/scroll-accel.ts:22`), so every
  viewport-pinned badge is chased on the main thread; a dropped frame shows the
  badge lagging its target. Wikipedia's sticky header and TOC are where this
  would surface.

To classify, grab a `Ctrl+Alt+A` debug snapshot and read each badge's
`viewportFixed`, `reconcileOffset`, `hostTransform`, and `occluded` from the
`HintBadge.diagnostics` getter (`render/hints.ts:957-1034`).

---

## 2. Overall assessment

The hint pipeline is in good shape and the design is sound: a level-triggered
reconciler (`lifecycle/reconcile.ts`) as the single desired-state derivation,
batched read-then-write positioning (`render/reconcile-positioner.ts`), and
careful hint reuse across viewport cycles (`DESIGN_HINT_REUSE.md`). The
build/show path is correctly strict-viewport gated (`content.ts:1440-1471`), so
the 1000px IO band can't paint badges into empty space, and the dormant-reuse
empty-box trap is guarded (`render/hints.ts:730`, `content.ts:1454`).

The risk has migrated to the **boundaries**: the orphan/teardown lifecycle, the
Firefox SSE/grammar-ACK seam, and stale-credential / backoff handling. That is
where the findings below concentrate.

---

## 3. Findings by subsystem

Severity is high/med/low. "Verified" means checked against source in this pass.

### Background / injection / orphan / IPC

- **HIGH — orphaned content scripts still execute actions.** Verified.
  `quiesceOrphan` (`content.ts:2212-2260`) tears down observers and badge hosts
  but never removes the `runtime.onMessage` listener (`:2503`), and the handler
  has no torn-down guard. A superseded elder CS retains a live `chrome.runtime`
  context and can still run `activate` / `history_back` / `location.reload()`
  (`:2536-2543`). This is a repeat of the known orphan-CS failure class. Fix:
  first line of the handler, `if (pageSession.isTornDown) return false;`. Lowest
  effort, highest value.
- **HIGH — SSE backoff resets on every connect edge.** FIXED 2026-07-01
  (notes/DESIGN_SSE_RESILIENCE.md): reset now requires a 30s-stable
  connection (`sse-backoff.ts`). Original finding:
  `background.ts:40-64` early-returns if a retry timer exists, but
  `cancelSSERetry` (`:721`) resets `sseRetryDelay` to 1s on every successful
  HEALTH_STATUS reconnect. A host that crash-loops re-runs `discoverPlugin`
  (a real fetch) every ~1s forever with no escalation. Fix: only reset backoff
  after the connection has been stable for N seconds.
- **HIGH — stale plugin creds wedge all POSTs silently.** FIXED 2026-07-01
  (notes/DESIGN_SSE_RESILIENCE.md): postToPlugin clears creds on 401/403 or
  thrown fetch; ensureConnected is single-flight + negative-cached.
  Original finding:
  `plugin/actuator-client.ts:33-88`: after a host restart with a new token,
  `ensureConnected()` returns true on the cached port/token, POSTs 401, and the
  error is swallowed as best-effort; nothing forces re-discovery while
  `pluginPort` is truthy. Fix: clear `pluginPort`/`pluginToken` on a
  401/network error so the next `ensureConnected` rediscovers.
- **MED — Firefox `connectDirectSSE` can thrash/duplicate.** MITIGATED
  2026-07-01: postGrammarBatch's discover now goes through single-flight
  ensureConnected, so port-missing bursts share one discovery; an
  already-connecting guard for the redundant connectSSE calls that remain is
  still open. Original finding:
  `background.ts:532-580` closes the prior source at entry, so serial re-entry
  is fine, but `postGrammarBatch` (`:378`) calls `connectSSE()` un-awaited on
  every port-missing batch; a burst before the first `connected` event each
  closes and reopens the EventSource. Guard with an already-connecting flag for
  the Firefox path.
- **MED — Chrome offscreen SSE has no self-recovery if the SW is idle-killed.**
  FIXED 2026-07-01 (notes/DESIGN_SSE_RESILIENCE.md): the 30s alarm now probes
  the offscreen stream's actual readyState (SSE_STATUS) instead of trusting
  the flag; also fixed a zombie-EventSource factory in offscreen's onerror
  (closed the wrong instance under racing CONNECT_SSE). Original finding: Recovery is entirely SW-driven via the `branchkitConnected` flag,
  which only flips on a HEALTH_STATUS message a dead SW never receives
  (`offscreen.ts:48-57`, `background.ts:1200`). Have the alarm actively ping
  offscreen for liveness, or let offscreen self-reconnect and report.
- **LOW — `broadcastToAllTabs` URL filter is narrower than `isInjectableURL`**
  (`frame-router.ts:56`): misses `about:` / `view-source:`. Harmless (sends are
  swallowed) but inconsistent.

### Labels / codewords / grammar-epoch

- **HIGH — `RELEASE_LABELS` is owner-blind across frames.** FIXED 2026-07-01:
  `releaseLabels` now takes the sender's `frameId` (authoritative from
  `_sender`, not payload) and only frees labels assigned/reserved to that
  frame, mirroring `confirmLabels`. Regression tests in `label-pool.test.ts`
  ("frame-scoped release"). Original finding:
  `label-pool.ts:293-318` releases any matching codeword regardless of owning
  frame, and the SW handler drops `frameId` (`background.ts:769-776`). Frame A
  releasing a stale local copy of `"a s"` can free frame B's live, painted
  codeword — turning B's badge into a paint-but-not-matchable ghost, and
  allowing the pool to re-issue `"a s"` to a third frame (the cross-frame
  duplicate the pool exists to prevent). Fix: scope release to
  `assigned[cw] === frameId`, as `confirmLabels` already does.
- **HIGH — confirm-rejection can leave an opaque-but-wrong badge.** RETRACTED
  2026-07-01: this was already handled when the review was written — the
  review missed the `labelReservoir.onConfirmRejected` wiring in
  `content.ts` (epoch-handshake Phase 4, commit 0d2fa9d), which does exactly
  the suggested fix: `queueDelete` + wrapper strip + reconcile. Original
  finding: A frame can win the grammar batch (badge goes opaque,
  `sentCodewords` records it — `label-sync.ts:608-619`) but lose the codeword in
  the later `confirmLabels` arbitration (`label-reservoir.ts:241-256`). The
  rejection purges reservoir state but never rolls back `sentCodewords` or
  re-Deletes the grammar entry, so the losing frame shows a "ready" badge whose
  codeword routes elsewhere. Fix: feed confirm-rejections back into label-sync
  to `queueDelete` + `sentCodewords.delete`.
- **MED — epoch republish cap-exhaust has no recovery.** Verified.
  `label-sync.ts:397-415`: after 3 republishes with no clean check it goes loud
  and stops acting. The loud log is dev-only; production users get a silently
  diverged grammar with no self-heal until an unrelated session rotation. Fix:
  on cap-exhaust, fall back to one full `rotateSession` + `republishAll`.
- **MED — SW startup clears the pool but not codeword memory.** Verified.
  `background.ts:1096` calls `clearAllStacks()` on init; `codewordMemory:*`
  survives, so post-restart recall points at codewords the freshly-cleared pool
  will also hand front-of-pool to different fresh elements. Recall-vs-fresh
  collisions spike after every SW restart. Fix: clear memory alongside stacks,
  or validate recall against live pool state.
- **MED — `outstanding` reservoir set is never swept.** Verified no cap.
  `label-reservoir.ts:89,246`: a teardown path that doesn't call
  `reservoir.release()` leaks the codeword in `outstanding` permanently,
  slowly starving refill over a long SPA session. Fix: reconcile `outstanding`
  against the live store periodically, or cap it.

### Scan / activate / dispatch

- **HIGH — voice "find" leaves undismissable, count-less highlights.** FIXED
  2026-07-01: a committed pill (query + live "3 of 17" + n/N·esc hint) now
  shows for voice find AND for keyboard find after Enter, persisting until
  Escape / "close find" (new voice phrase) / `/`-refine. Highlights stay per
  the Vimium-C model. Original finding:
  `scan/find.ts:362-367`: `findImmediate` sets `state.active` and paints
  persistent highlights but never creates the bar or count pill, so there's no
  visible affordance and no obvious dismiss. Fix: have `findImmediate` create
  the bar (or at least a count pill).
- **MED — accessible-name is uncapped on most paths.** Verified.
  `scan/accessible-name.ts:30,92`: the 256-char cap is applied only in step 8;
  the `aria-labelledby`, name-from-content, and `describedby` paths return
  uncapped `innerText`, so a button wrapping a big text blob yields a multi-KB
  codeword label. Fix: apply the cap uniformly at the return points.
- **MED — anchor activation may double-navigate or no-op on plain links.**
  Speculation, needs runtime check. `activate/event-sequence.ts:58-76` synthes-
  izes an untrusted `click`, which won't trigger default navigation on a plain
  `<a href>`; confirm plain links navigate via this path and aren't either
  dropped or double-fired alongside a site handler. `lastClicked` (`:51`) is a
  module global, never frame-scoped.
- **LOW — selector blacklist regex `/href/` over-matches** any class/id
  containing the substring (`scan/selector-generator.ts:4`); and
  `resolveSelectorPath` re-queries the first segment from `document`, so a
  selector unique inside a shadow root can resolve wrong in the light DOM
  (`:157`).
- **LOW — keymap round-trip asymmetry** (`activate/key-combo.ts:25-48`):
  `parseCombo` accepts `cmd` but `serializeCombo` emits `meta`; a mixed-form
  storage path defeats the self-echo skip and forces a needless registry
  rebuild. Normalize `cmd` to `meta` at parse time.

No XSS surface was found in codeword/label rendering — badges use `textContent`
and the find bar is built via DOM APIs, not `innerHTML`; `CSS.escape` is used
correctly in the selector generator.

---

## 4. Suggested order

1. Orphan-listener guard (`content.ts` onMessage) — one line, closes a known
   high-blast-radius class.
2. Confirm the Firefox ghost diagnosis with the `data-bk-pending` count, then
   fix whichever path it implicates (grammar-ACK seam vs sticky positioning).
3. Owner-scope `RELEASE_LABELS` and roll back confirm-rejections — the two
   cross-frame grammar correctness bugs.
4. Stale-cred clear on 401 + stable-connection backoff reset — the SSE
   resilience pair.
5. Accessible-name cap and the voice-find affordance — smaller, user-facing.

The orphan-teardown items carry the project's documented high blast radius;
ship them one layer at a time and run a long soak before merging.
