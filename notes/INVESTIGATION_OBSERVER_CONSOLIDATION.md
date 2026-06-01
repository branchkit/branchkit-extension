# Observer Consolidation — Investigation

Status: resolved (2026-06-01) — measured; do NOT consolidate, do NOT fold. See
"Result" below.

## Result (2026-06-01)

The instrumentation ran on live heavy pages (YouTube, Rumble, Gmail) and the
verdict inverts the plan's assumption. Cumulative over full sessions:

| Host | moCallback (existing doc-level MO, *filtered*) | hostAttribute | targetMutation |
|---|---|---|---|
| youtube.com | 419 calls / 350 ms | 2 ms | 11 ms |
| rumble.com | 610 calls / 337 ms | 1 ms | 0 ms |
| mail.google.com | 612 calls / 273 ms | 0.6 ms | 0.3 ms |

Two findings:

1. **The per-wrapper MO fan-out is not a cost driver.** The two trackers we
   planned to consolidate (B1) cost 2 ms and 11 ms across a *full* YouTube
   session, sub-resolution per call. There is nothing meaningful to save by
   consolidating them. **B1 is dead.**

2. **The document-level fold would make things worse — and `moCallback` already
   proves it, so the throwaway probe proposed below is unnecessary.** `moCallback`
   *is* a live document-level MutationObserver, merely attribute-*filtered*, and
   it is already the single largest instrumented MO cost at 270–350 ms on the
   heavy pages. The fold means *widening* that filter to absorb the
   target-mutation job, so the fold's cost is `≥ 350 ms` by construction. Trading
   away 11 ms of per-wrapper cost to inflate the already-dominant 350 ms cost
   center is a bad trade.

**Correction to the "What we are measuring" caveat below:** it claimed the
per-element aggregate is an *upper bound* on the doc-level fire rate. The data
shows the opposite — it is a *lower bound*. `moCallback` fires 419× vs
targetMutation's 171× because the doc-level MO covers the whole page (player,
comments, ads) while the per-wrapper observers see only mutations *near hints*.
The fold fires more, not fewer.

**Decision:** leave both per-wrapper trackers exactly as they are. Do not
consolidate (B1), do not fold to a document-level MO. If the Firefox warning ever
recurs, the data points at the opposite lever — **B4 (scope/narrow `moCallback`'s
350 ms down)**, not folding more work into it. The callback-rate instrumentation
stays in place (cheap, behind the perf trail) as a standing tripwire.

The investigation context that produced this verdict follows.

---

Status (original): investigating (2026-06-01)

Companion docs:
- `notes/DESIGN_OBSERVATION_FOOTPRINT.md` — the viewport-as-unit-of-work spine.
  Its "Move 1 (B1 shared observers)" is the item this investigation interrogates.
- `notes/PLAN_BROWSER_EXTENSION_PERF_OPTIMIZATION.md` — B1 (shared instances) and
  B4 (scoped MutationObserver) are the two plan items in tension here.

## Why this note exists

We attempted the design note's Move 1 — consolidate the per-wrapper observers into
shared instances — and reverted it the same day. The attempt and its reversal
taught us something the plan didn't capture, so before re-attempting we are
recording (a) why the obvious consolidation is not the clean win the plan assumed,
and (b) what we need to measure to decide the real consolidation.

This is a measure-first gate, consistent with the decision gate already written
into `DESIGN_OBSERVATION_FOOTPRINT.md`. The Firefox "this extension is slowing
your browser" warning has **not recurred** since A2 (opaque-subtree prune) and
Levers 1/2 (per-frame gating) shipped, so nothing is forcing the call. We are
buying clarity, not reacting to a live fire.

## What the codebase actually has

A grep of every observer instantiation (`new MutationObserver / ResizeObserver /
IntersectionObserver`) shows the per-element (one-object-per-wrapper) fan-out is
exactly **two** observers:

| Observer | API | Per-element? |
|---|---|---|
| `observe/host-attribute-tracker` | MutationObserver | yes — one per host |
| `observe/target-mutation-tracker` | MutationObserver | yes — one per target |
| `observe/intersection-tracker` | IntersectionObserver | no — singleton |
| `observe/attention-observer` | IntersectionObserver | no — singleton |
| `observe/container-resize-tracker` | ResizeObserver | no — singleton, refcounted |
| `observe/scroll-ancestor-tracker` | scroll listener | no — one per container |
| main page MO, visibility IO/MO/RO, reset MO (content.ts) | — | no — singletons / one-offs |

So on a YouTube `/featured` page (~87 wrappers) the per-wrapper observer count is
~174 MutationObservers plus a handful of singletons — not the "~600 / ×7" the
original plan estimated. The design note's refinement was correct; the original
plan over-counted.

## The root cause the plan missed

It is not a coincidence that both fan-out observers are `MutationObserver`s.
**`MutationObserver` is the only one of the three observer APIs with no
`unobserve(node)`.**

- `container-resize-tracker` (ResizeObserver) and the two IntersectionObserver
  trackers consolidated cleanly into singletons *because RO and IO have
  `unobserve`* — you add and remove individual targets on one shared instance for
  free.
- A "shared MutationObserver watching N specific nodes" cannot remove one node.
  Every untrack becomes `disconnect()` + re-`observe()` all survivors — an
  `O(live badges)` loop on the hot teardown path (teardown happens constantly
  during scroll and nav). The reverted attempt traded N idle observer-objects for
  exactly this churn. That is a relocation of cost, not a removal of it.

So consolidating the two MO trackers the obvious way (shared instance +
per-target dispatch) is structurally penalized in a way the IO/RO consolidations
were not. This is intrinsic to the API, not an implementation detail.

There is a second penalty specific to `target-mutation-tracker`: it observes with
`subtree: true`, so a record's `.target` is the mutated *descendant*, not the
observed root. `store.findWrapperFor` is an exact `Map.get` (no ancestor
resolution), so a shared observer would need a `closest`-style ancestor walk per
record to dispatch the per-target work (`ensureBound` anchor self-heal,
`invalidateProbe`). `host-attribute-tracker` does not have this problem (it
observes `{ attributes: true }` only, so the record's target *is* the host).

## The one clean escape, and its cost

Rango (read from `/private/tmp/rango`) sidesteps the no-`unobserve` problem
entirely: it never points a MutationObserver at *specific nodes*. It observes the
whole `document` once (plus each shadowRoot once on discovery) for the page's
lifetime, and never untracks. With a stable root that is never removed, the
no-`unobserve` problem does not exist. Its single `mutationCallback`
(`src/content/wrappers/ElementWrapper.ts`) handles attribute reconcile, wrapper
add/remove, and schedules one debounced `refresh()` — no per-element MO at all.

BranchKit could fold *both* per-wrapper MO jobs into one document-level MO. That
is a genuine simplification — it deletes two trackers and their `track`/`untrack`
calls in `render/hints.ts`:

- **host-attribute job** → in the doc MO callback, filter records to
  `data-branchkit-hint` hosts and reconcile. No per-host tracking.
- **target-mutation job** → schedule a reposition on any foreign mutation.
  BranchKit already has the debounced `reconcile()` / `scheduleDeferredReposition()`
  substrate that Rango leans on, plus the landed lifecycle reconciler.

The cost is the thing plan-item B4 was explicitly avoiding: a document-level MO
with `{ attributes, childList, subtree }` **fires on every page mutation**, not
just near our hosts. Today BranchKit's main MO is deliberately attribute-*filtered*
to dodge that. Rango eats the page-wide fire and absorbs it with a 100ms debounce.
Whether BranchKit's debounce absorbs it as well **is an empirical question, not a
code-reading one.**

## What we are measuring (and why)

To turn "is the page-wide-fire cost acceptable?" from a guess into a number, we
instrument the two per-wrapper MO callbacks with the existing `recordCpu` sink
(via the global `__branchkitRecordCpu` accessor the IO trackers already use):

- `hostAttribute:callback` — fires + summed ms for the per-host MO fan-out.
- `targetMutation:callback` — fires + summed ms for the per-target MO fan-out.

These surface in the perf trail's `cpu.buckets` (cumulative) and `cpu.share`
per-bucket delta (`dCount` = fires in the window, `dMs` = cost in the window).
Trail file: `~/Library/Application Support/BranchKitDev/plugins/browser/extension-perf.jsonl`.

Read the numbers on live heavy pages (YouTube `/featured` + `/watch`, Rumble home
+ video, Gmail). The two questions they answer:

1. **Fire rate.** `targetMutation:callback` dCount/sec is the page-mutation
   pressure we would inherit at the document level. Caveat: the per-element
   aggregate *over-counts* a doc-level MO, because a mutation nested under M
   tracked targets fires M times here but once at the document level. So the
   measured rate is an upper bound on the doc-level fire rate — if even the upper
   bound is cheap, the fold is safe; if it is alarming, we need the true
   doc-level rate before deciding (a throwaway doc-level MO probe).
2. **Cost per fire.** `dMs / dCount` says whether each fire is trivial (the fold
   is dominated by browser dispatch, which a debounce flattens) or expensive (the
   per-call work itself matters and a debounce alone will not save us).

## Decision gate

- If the measured fire rate and per-call cost are both low on the heavy pages →
  the document-level fold is a safe simplification; proceed to design it (delete
  the two trackers, widen the main MO, route through the debounced reconcile),
  gated behind `scripts/_test-videos-tab-wedge.mjs` and the lifecycle-bucket
  classify test.
- If the fire rate is alarming but the upper-bound caveat is doing the work →
  build a throwaway document-level MO probe to get the true doc-level rate before
  committing.
- If per-call cost is high → the fold is not a free lunch; revisit B4 (scoped /
  per-region MO) instead of a single document-level one.
- If the numbers are unremarkable and the warning stays gone → leave the two
  per-wrapper trackers as they are. The original per-host design has a clean
  `O(1)` untrack and is the correct shape *given BranchKit observes specific
  nodes*; do not consolidate for its own sake.

## What not to repeat

- Do **not** re-attempt the "shared MutationObserver + per-target dispatch"
  consolidation. It is the awkward middle: it keeps the observe-specific-nodes
  design (so it inherits the no-`unobserve` churn) without gaining the
  document-level model's freedom from untracking. The reverted attempt was this
  shape.
- Keep the wedge fix (`preNavDetachAll`, `ca25199`) load-bearing. Any future
  fold must keep `scripts/_test-videos-tab-wedge.mjs` green.
