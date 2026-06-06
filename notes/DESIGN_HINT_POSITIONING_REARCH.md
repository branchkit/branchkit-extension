# Hint Badge Positioning — Re-architecture Proposal

**Status:** Proposed (2026-06-06). Investigation complete; awaiting direction
before any implementation. No code changes yet.

## Why this note exists

Badge positioning/anchoring/stability has been fixed-then-regressed at least
four distinct times (≥9 reverts in the cluster), and the design notes already
flag it as the highest-blast-radius area. The latest instance: a voice
"soft-detach" codeword-stability fix (2026-06-06) was built, trace-confirmed,
and reverted because it caused a YouTube badge "scroll off the page" regression
(see `DESIGN_CODEWORD_STABILITY.md`). Rather than patch again, this proposes
treating the positioning layer as a deliberate re-architecture.

## Root cause (convergent across investigation)

The badge is glued to its target by writing an inline `anchor-name: --bk-N`
**onto the page's own element** and relying on CSS Anchor Positioning. That one
choice is the upstream cause of nearly every failure mode:

- **Write-war over a page-owned inline style.** YouTube rewrites target inline
  `style` ~10×/sec, stripping our `anchor-name`; `anchor()` then resolves to
  nothing and the host collapses to the document origin and scrolls off.
- **Node recreation drops the binding.** List virtualization recreates the
  target node without our `anchor-name`; the per-node MutationObserver meant to
  repair it is attached to the now-dead node.
- **Repair refuses to run in the failure window.** The repair pass
  (`ensureBound`/`reconcilePlacement`, `content.ts`/`render/hints.ts`) is
  edge-triggered and/or gated behind a 100 ms scroll-settle debounce (never
  settles during continuous scroll), **skips limbo wrappers**, and **requires
  visibility** — so it won't repair exactly when the badge is loose.

The invariant that keeps getting violated: *a binding (or wrapper state tuple)
is mutated edge-triggered and assumed to persist, but hostile pages recreate
nodes / drop observer events under mutation storms.*

## Two hard constraints

**C1 — Binding robustness on hostile/dynamic pages.** The glue must not depend
on state living on a node the page owns, overwrites, and recreates.

**C2 — Cross-browser uniformity.** CSS Anchor Positioning is Chromium 125+;
Firefox only shipped it ~147 and it is **broken for `position:fixed`-ancestor
targets through Firefox 150** (host collapses to 0,0 — see
`render/hints.ts:44-52`); no `strict_min_version` is pinned, so pre-147 Firefox
(no anchor positioning) is also in scope. The extension therefore already runs
**two positioning models**:
- *Anchor mode* (Chromium, non-fixed targets) — compositor-driven, zero JS scroll.
- *Nesting mode* (Firefox always-or-mostly, + Chromium fixed-ancestor targets) —
  host physically nested in the target's scroll-ancestor + JS settle-reposition.

Both are fragile, differently (anchor → dangle on style-churn; nesting →
container drift). Maintaining two divergent models with non-overlapping repair
paths is itself a named root weakness.

**C3 — Chromium per-frame perf budget (the reason JS-reposition was avoided).**
Anchor mode exists to get *zero-JS compositor scroll* for hundreds of badges,
which was part of escaping the nav-time main-thread wedge. Any move to JS
repositioning must keep per-frame/settle work bounded (O(visible), batched reads
then writes, IntersectionObserver-gated) or it re-lights the wedge. Note: Firefox
already pays the JS-reposition cost in production, so a unified JS model extends a
proven path rather than introducing a new risk class.

**C3 — MEASURED 2026-06-06 (Playwright, real Chromium, YouTube search results, a
hostile mutating page). C3 is satisfied.** A batched reconcile pass (batched
`getBoundingClientRect` reads, then composited `transform` writes) over the
visible badge set costs **~0.5–1ms median**, and the cost is **dominated by one
forced reflow, essentially independent of N**:
- read of 1 target (dirty) ≈ read of 60 visible targets (dirty): both ~0.5ms median.
- N-scaling of batched dirty reads: 100→1.2ms, 300→1.2ms, 600→1.8ms median.
- clean (layout-not-dirty) reads: 0.1ms / 60. Composited `transform` writes: 0.1ms / 60 (free).
- spikes (p95 ~6ms, max ~20ms) coincide with the page's *own* heavy-layout frames.

Interpretation: O(visible) is effectively *O(one reflow)* — the model scales to
dense pages. A **settle-debounced** reconcile (scroll-end / mutation-settle) is
trivially affordable (~1ms occasionally). A **per-frame-during-scroll** reconcile
fits the 16.7ms frame budget with wide headroom at the median; the multi-ms p95/max
spikes occur on frames the browser was already reflowing, and must be kept off the
nav-time storm (IO-gate + idle-schedule, per the wedge discipline). Caveat: measured
on one machine via Playwright — order-of-magnitude and the reflow-dominance /
N-independence conclusions are architectural (machine-independent), but confirm the
spike behavior in the user's real Chrome before relying on a per-frame variant.

## How established tools position hints (evidence)

None of Vimium, Vimium C, Surfingkeys, Tridactyl, or Rango use CSS Anchor
Positioning. They use JS rect computation + absolute positioning:
- **Vimium / Surfingkeys**: compute rects once at hint-mode entry; hint mode is
  ephemeral, so staleness never surfaces. (Does not fit always-on badges.)
- **Tridactyl**: single container `translate`d by `-scroll` on rAF; no
  target-recreation handling.
- **Rango** (always-on, closest to us): a **wrapper element** at the target's
  box (no anchor-name to strip), auto-following on scroll, plus **ResizeObserver**
  (size), **MutationObserver** (re-attach when the page deletes our node), and
  **IntersectionObserver** (viewport claim/release for virtualization).

## Candidate directions

### Option 1 — Harden the CSS anchor binding (keep anchor positioning)
Set `anchor-name` via an injected stylesheet rule keyed to a data-attribute
(harder to strip than inline style) + `anchor-scope`; re-stamp on rebind.
- C1: partial — still loses on hidden/recreated anchors and DOM-order traps.
- **C2: fails** — anchor positioning is absent/broken on Firefox, so Firefox
  stays on the fragile nesting path. This is a Chrome-only fix that *keeps* the
  dual-model.
- C3: best (preserves compositor scroll on Chromium).
- **Verdict: rejected as the primary fix** — does not satisfy C2; perpetuates the
  dual-model root weakness.

### Option 2 — Rango-style wrapper-append (pure JS, unified)
Badge lives in a wrapper tied to the target's box (in/near the target's subtree),
auto-following on scroll with zero per-frame JS; MutationObserver re-attaches when
the page deletes it; IntersectionObserver gates viewport; ResizeObserver tracks
size.
- C1: strong — no page-owned inline state to strip; survives style rewrites.
- C2: full — one model on all engines; delete both current paths.
- C3: good — auto-follow is largely compositor/layout-driven, not per-frame JS;
  but injecting into the page subtree can trip the page's own MutationObserver/CSS
  and the page may remove the node (handled by the re-attach MO).
- Risk: DOM injection into hostile subtrees; needs the re-attach guard and care
  with page CSS/`contain`.

### Option 3 — Single batched rAF reconcile (pure JS, unified)
One reconcile pass over *visible* badges (IntersectionObserver-gated): batch all
`getBoundingClientRect` reads, then batch host `transform`/`top`/`left` writes.
Hosts stay body-mounted (no page-subtree injection).
- C1: strong — position derived from live geometry each pass; no page-owned state.
- C2: full — one model on all engines.
- C3: the explicit risk — reintroduces per-frame JS. Must be O(visible), batched
  (no read/write interleaving), IO-gated, and coalesced to scroll/mutation
  settles where possible. This is the variable to measure against the wedge.
- Advantage over Option 2: no page-subtree injection, so it can't trip the page's
  MO or be removed by the page; simplest mental model (one pass owns position).

## Recommendation

Pursue a **unified pure-JS positioning model (Option 2 or 3)** and **delete both
the anchor and nesting paths**. This is the only direction that satisfies C1 and
C2 and dissolves the dual-model root weakness; Option 1 is a Chrome-only band-aid.

Between 2 and 3: lean **Option 3 (batched rAF reconcile)** as the lower-risk
starting point — it avoids injecting into hostile page subtrees (Option 2's main
hazard) and gives a single owner of position. Borrow Option 2's observer wiring
(IntersectionObserver viewport gate, MutationObserver host re-attach, fingerprint
rebind on node recreation) regardless of which we pick.

**The gating unknown was C3 (Chromium per-frame budget) — now MEASURED and it
holds** (see the C3 measurement above: ~0.5–1ms/pass, reflow-dominated,
N-independent). So Option 3 is perf-viable and is the recommended direction. The
residual risk is the multi-ms p95/max spikes; mitigate with the existing wedge
discipline (IO-gate the reconcile to visible badges, idle-schedule it, keep it off
the nav-time mutation storm) and a settle-debounced cadence, escalating to
per-frame-during-scroll only if drift is perceptible. Option 2's compositor
auto-follow remains the fallback if a per-frame variant proves janky in real Chrome.

## Phasing (low-risk, one layer at a time)

1. **Measure C3** — DONE 2026-06-06 (see the C3 measurement block above). Result:
   batched reconcile is reflow-dominated, ~0.5–1ms/pass, N-independent → budget holds.
2. **Spike Option 3** behind the existing path (or a flag): batched IO-gated rAF
   reconcile for a subset; compare drift + perf to anchor mode on YouTube/QuickBase.
3. If it holds: migrate fully, **delete** `anchorMode`/`supportsAnchorPositioning`/
   `anchorResolvesAcrossFixed`/nesting + their split repair paths; collapse to one
   model. Re-verify the nav-time wedge (YouTube channel "Videos" voice-activate).
4. 30+ min real-use soak on YouTube/QuickBase (Chrome AND Firefox) before merge.

## Migration plan (synthesized from the audit workflow, 2026-06-06)

A 5-dimension parallel audit scoped the deletion of the anchor + nesting paths.
The full reports are in the workflow output; the load-bearing conclusions:

### The one decision to make first — placement clamp

Today placement (`placement/rango.ts` `getAvailableSpace`) clamps a badge to its
`anchorParent`'s available space *unless* `anchorMode` is true (body-mounted →
unbounded). **Latent bug in the landed spike:** reconcile mode passes
`anchorMode=false`, so its body-mounted host is clamped to a container it isn't
nested in — wrong-by-construction. The migration must make **"body-mounted ⇒
unbounded space" universal** (since the reconcile host is always body-mounted).

That single change determines how much deletes:
- **Recommended:** drop the container space-clamp universally. Then
  `resolveContainer`'s clip-escalation, `findBadgeContainer`, `findLimitParent`,
  `getSpaceInAncestor`, `findScrollAncestor`, the `anchorParent` field, and the
  `container-resize-tracker` registration all become deletable.
- **Open sub-question (decide at phase 5):** keep sticky/fixed clamping
  (`findStickyBound`)? A gBCR-following reconciler arguably makes it redundant (a
  target scrolling under a sticky header is simply followed). If kept, retain a
  *minimal* "nearest clip/sticky ancestor" resolver — NOT the clip-escalation
  `resolveContainer`. If dropped, `anchorParent` + all the container helpers go.

### Production cadence (replaces the spike's free-running rAF)

Make the reconciler a **pure `reconcilePass()` invoked by the existing content.ts
settle handlers** (`scheduleScrollReposition`, `scheduleDeferredReposition`,
`onScrollAncestor`, the huge-mutation `.then`), reusing their already-tuned 100ms
debounce + rAF single-flight — so there's ONE coalescing policy and it's
wedge-safe by construction (it only runs when a settle handler that already
yields after the storm calls it). **IO-gate** the pass to the visible set
(`wrapper.isInViewport`), keeping the batched read-all-then-write-all structure.
Do **not** keep a self-rescheduling rAF. (Optional later: escalate to per-frame
only *while actively scrolling*, if soak shows perceptible trailing.)

### Keep-list — do NOT delete (would break the build or reopen fixed bugs)

- `src/lifecycle/reconcile.ts` — the LIFECYCLE band reconciler (name collision
  with the positioner; it's the only production reader of `TargetRectStore`).
- `TargetRectStore` — still backs the lifecycle band check (drop only the
  scroll-ancestor drift-sampler readers).
- `compute.ts` no-viewport-floor (`Math.max(0,…)` removal) — load-bearing scroll-
  back fix (`d35201a`); shared by all models. Only update its anchor-flavored comments.
- `host-attribute-tracker` — survives (defends our body-mounted host), reduced role:
  display arg collapses to always `'block'`.
- The settle handlers' non-positioning backstops — `reconcileTeardown`,
  `scheduleBandDiscovery`, `reconcileStrictViewport` — excise only the positioning lines.
- `placeBadges`/`placeOne` (build path), `anchorParent` *iff* the sticky-clamp is kept.

### Orphan-teardown gap (must fix — high blast radius)

`quiesceOrphan` (`content.ts:~2213`) removes hosts via raw
`querySelectorAll('[data-branchkit-hint]').remove()`, bypassing `HintBadge.remove()`
— the only `unregisterReconcile` site. So the reconciler registry would leak and a
settle-driven pass could spin on a dead frame. Add a `reconcile-positioner` drain/stop
to `quiesceOrphan`. (Relates to the orphan-teardown blast-radius memory.)

### Deletion sequence (build green at every step; one layer at a time)

1. **Cadence first, still flag-gated:** rewire `reconcile-positioner.ts` from
   free-rAF to settle-gated + IO-gated; add `reconcile-positioner.test.ts`; add the
   `quiesceOrphan` drain. Anchor/nesting untouched. Soak.
2. **Flip `bkJsPosition` default ON**, anchor/nesting still present as fallback.
   30+ min soak on YouTube + QuickBase, **Chrome AND Firefox**; re-run the wedge
   repro (`scripts/_test-videos-tab-wedge.mjs` / YouTube channel "Videos" voice-activate).
3. **Delete the Firefox layer** (`anchorResolvesAcrossFixed`, `hasFixedAncestor`,
   nesting constructor/retarget/reattach branches, `resolveBadgeContext`,
   `scrollAncestor` field + `scroll-ancestor-tracker`). Lowest risk — reconcile
   already replaces it and Firefox already paid the JS cost. Re-verify the wedge.
4. **Delete the anchor layer** (`supportsAnchorPositioning`, `anchorOffsetCss`,
   `setupAnchorHost`, anchor branches, `anchorName`, `ensureBound`).
5. **Delete the shared repair/cadence scaffolding** (`reconcilePlacement` + its 4
   call sites, `ensureContainer`, `needsScrollReposition`/`needsLayoutReposition` +
   the `drifted`/`all` `scheduleReposition` split, and `scrollSensitive`/
   `geometryDependent` **in lockstep with `placement/rango.ts` + `compute.ts`**).
   Resolve the sticky-clamp sub-question here. Re-verify the wedge.
6. **Delete dead diagnostics + the flag** (`pushPositionLog`/`getPositionLog`/
   `setPositionCaller`, anchor diagnostics in `hints.ts` + `debug-snapshot.ts`,
   `jsRepositionEnabled`/`bkJsPosition`). Reconcile is now the default-and-only model.

### Tests

- **Delete:** `hints.test.ts` anchor-mode describe (~292–424), `needsScrollReposition`
  describe (~426–488), `ensureBound` cases; `scroll-ancestor-tracker.test.ts`,
  `container-resize-tracker.test.ts`, `target-mutation-tracker.test.ts`.
- **Update:** the retarget describe (assert reconcile-mode: host stays body-mounted,
  target swaps, registry membership preserved) + remove every `setAnchorSupport` pin;
  `host-attribute-tracker.test.ts` (display `contents`→`block`); `compute.test.ts`
  (drop `scrollSensitive`/`geometryDependent` assertions iff those fields are dropped).
- **Add:** `reconcile-positioner.test.ts` — batched read-then-write ordering, IO-gate
  skip (hidden/disconnected/no-offset → `reconcileRead` null), settle-debounce
  coalescing, registry empties ⇒ no scheduled work.
- No `content.test.ts` exists, so `content.ts` deletions have no unit net — the
  **soak is the regression gate**.

### Soak gates (pass/fail)

(a) no watchdog stall above the control baseline; nav-time `max_sync_ms` stays ~20–70ms;
(b) `reconcilePositioner:tick` median ≤1ms, p95 within frame budget on YouTube /watch +
search grid and QuickBase table scroll; (c) no Firefox "extension is slowing things
down" warning over 30+ min; (d) badges visibly track on fast scroll on BOTH engines;
(e) the YouTube channel-"Videos" voice-activate wedge does NOT return. The
`placeBadges:*` CPU buckets should drop to ~0 (reposition path retired) and
`reconcilePositioner:tick` should absorb a small bounded cost — that delta is the
headline evidence.

### Watch-outs

- **isInViewport desync** as the gate input can freeze a visible badge (stale-FALSE);
  let the band reconciler (`content.ts:~1617`) converge `isInViewport` first / gate on
  the in-band geometric set right after a nav.
- **Chromium regression caveat:** this moves Chromium *from* zero-JS compositor scroll
  *to* JS reconcile (Firefox is neutral-to-better). C3 says affordable; confirm scroll
  stays smooth on a dense Chromium grid.
- Removing the `onTargetMutation` `ensureBound` early-return means YouTube's ~10×/sec
  style rewrites now fall through to the settle/reconcile path — verify the trigger
  rate doesn't spike (the 100ms debounce should absorb it).

## Step 1 refinement (2026-06-06): document-anchored host (kills the scroll wiggle)

Real-Chrome testing of the step-1 landing showed a visible scroll "wiggle": the
badge lagged the content by ~1 frame and caught up. Cause: the spike mounted the
host `position:fixed` (viewport-anchored) and wrote viewport coords, so every
scroll frame the badge had to be re-chased by main-thread JS — and main-thread
reposition always trails the compositor's scroll by a frame.

Fix (landed): mount the reconcile host `position:absolute` (document-anchored)
and write DOCUMENT coords (`getBoundingClientRect` + `window.scrollX/Y` + baked
offset). The document position is scroll-invariant, so on window scroll the host
rides the compositor in lockstep with the page content — zero main-thread lag,
no wiggle. `reconcilePass()` writing the same scroll-invariant value mid-scroll is
now harmless (correct regardless of timing). JS re-pin is only needed when the
target moves *within* the document — layout changes and **inner-pane (overflow
container) scrolls**, where an document-anchored host does NOT ride the inner
scroller and the scroll-active loop still chases (residual wiggle possible there;
revisit with the Option 2 wrapper if inner-pane wiggle proves perceptible).
Touches `setupReconcileHost` + `reconcileRead` only; flag still gates; tests +
the Playwright scroll-tracking check stay green.

## Deferred (tracked, NOT abandoned): inner-pane / sticky wiggle

The document-anchored host kills the wiggle for window scroll but not for targets
that move within the document during scroll — `position:sticky` sidebars and inner
overflow scrollers (YouTube's secondary column is the live example). This is ugly
enough to need an eventual fix; it is deferred deliberately, with reasons:

- **It's in direct tension with the north star (codeword stability).** The only
  true fix is to make the badge ride the inner scroller, and the obvious way —
  nest the badge in the page subtree (Option 2 / co-location) — is exactly the
  page-owned-node fragility (page recreate/remove on nav/virtualization) that
  REGRESSES codeword stability. So the obvious fix is the wrong fix. (Empirically,
  2026-06-06 Firefox probes: the existing nesting path escalates the host to body
  anyway → it doesn't even fix the inner-pane case without adding clip-management.)
- **It should be designed once, against the unified single-reconcile model** the
  migration produces — not bolted onto the 3-model code about to be deleted.
- Cosmetic, vs the load-bearing codeword-stability goal.

**Scheduled slot:** after the migration collapses to one reconcile model AND the
codeword-stability soft-detach re-lands. **Leading candidate (resolves the
tension):** CSS scroll-driven animation (`animation-timeline: scroll(nearest …)`)
binding the host's transform to the inner scroller's scroll position on the
compositor, while keeping the host body-mounted — rides inner scroll WITHOUT
subtree injection. Verify Chrome/Firefox support + interaction with reconcile
transform writes. Fallback: scoped co-location for inner-pane targets only,
accepting the binding tradeoff there.

## Relationship to prior notes

- Supersedes the positioning halves of `DESIGN_OBSERVER_DRIVEN_LAYOUT`,
  `DESIGN_HINT_LIFECYCLE_RECONCILER`, and the anchor fast-path — those are the
  patches this re-architecture would replace.
- Must preserve the nav-time wedge fix's intent (`DESIGN_NAV_TIME_RESCAN`): bounded
  synchronous work, no per-element layout thrash during the DOM swap.
- The reverted soft-detach (`DESIGN_CODEWORD_STABILITY`) is orthogonal: codeword
  *identity* stability across nav is a separate concern from *position* stability;
  a unified position model removes the limbo/`reconcilePlacement` collision that
  sank the soft-detach, which may make a future identity fix safer.
