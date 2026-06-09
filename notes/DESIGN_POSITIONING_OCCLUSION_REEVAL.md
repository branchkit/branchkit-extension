# Positioning & Occlusion — Architecture Re-evaluation

**Status:** Proposal (2026-06-09). Re-opens the body-mount-vs-nesting decision
from `notes/completed/DESIGN_HINT_POSITIONING_REARCH.md`, this time with
**occlusion-correctness as a first-class constraint** — which the original
re-arch never weighed. Backed by a four-track investigation (Rango source, our
own git history, a feasibility read of the current code, and a cross-tool
prior-art survey). Recommends a direction; no code beyond the already-landed
flag-gated prototypes.

## Why re-open this

Body-mounted badges (host on `document.body`, max z-index, positioned by a JS
reconcile pass) **escape the page's clipping and stacking**. So when a target
scrolls out of an overflow pane, or is covered by an overlay, the badge keeps
painting over the now-invisible element — a "ghost." On app-shell pages
(QuickBase) this is pervasive and confusing.

The original re-arch (2026-06-06) deleted the two models that *did* inherit
clipping/stacking (CSS-anchor and nesting) and chose body-mount. It was decided
on three constraints — **C1** binding robustness, **C2** cross-browser
uniformity, **C3** per-frame perf. **Occlusion-correctness was never on the
scale.** Nesting handled it for free; we lost that benefit as an unweighed side
effect. This note puts it on the scale and asks: revert toward nesting, or build
the occlusion layer on top of body-mount?

## What the investigation found

### 1. Reverting to nesting does NOT cleanly solve it — our own history proves it

Our deleted nesting was **not naive**. It already had what you'd reach for:
- a body-level re-attach `MutationObserver` (`badgeReattachObserver`, `dcd9883`)
  explicitly built "from the Rango pattern" — re-appends a stripped host;
- container re-resolution + fingerprint rebind (`retarget` → `resolveContainer`).

It still failed on the exact hostile pages that drove the re-arch: YouTube
"continuously strips our nested badge hosts out of its managed subtrees"
(`6c707b8`), producing **~560 reattaches/sec** and forcing bespoke throttles
(`fbc71d2` circuit breaker + per-badge rate-limiter) that, when tripped, **make
badges stop reappearing** on pathological hosts. Nesting was deleted to remove
the **hazard class** — "no page-subtree injection, so it can't trip the page's MO
or be removed by the page" — not because our implementation lacked a guard. That
is a *structural* win, not an implementation detail.

### 2. Rango's nesting isn't self-healing either

Rango buys occlusion-for-free by nesting, but its re-attach guard is a **one-shot
latch** (`wasReattached`) behind a **100ms debounce**, with a **terminal
release-on-`body`** path. Against ~10×/sec DOM rewrites or container recreation,
hints escalate up the tree and then **drop** rather than recover. Its
repositioning is settle-debounced, not compositor-driven — it survives scroll
only because the nested host scrolls natively with its container. Verdict from
the source read: *"a strong default that degrades gracefully (drops hints) under
hostility — not a self-healing mechanism you can lean on for adversarial pages."*
And Rango's own `document.body` fallback hints (no apt container) lose occlusion
correctness exactly like ours do.

So: **nesting trades our hard-won binding robustness for occlusion-correctness
that is itself imperfect under hostility.** Not a clean win.

### 3. Body-mount + synthetic occlusion is feasible, and mostly proven

Keeping the body-mounted host, we can re-derive clipping/occlusion ourselves:
- **Clipping → IntersectionObserver rooted at the scroll container** (the landed
  `clip-observer.ts`): compositor-driven, overflow-clip-aware, **flicker-free**,
  no per-frame JS. Covers "target scrolled out of its pane." This is the same
  geometric-clip approach Floating UI's `hide`/`detectOverflow` middleware uses —
  mainstream and proven. Cheap. (Optional later: per-pass `clip-path: inset(…)`
  to the scroller's visible rect for *partial-slice* fidelity and multi-level
  nested scrollers; rect-only, higher cost — hold in reserve.)
- **Overlay → multi-point `elementFromPoint`** (upgrade the current center-only
  hit-test to center + corners, majority-covered ⇒ occluded): fixes the
  partial-occlusion false-negatives (the QuickBase "BM" ghost, whose center sat
  in a visible sliver). 4–5 hit-tests per visible badge per *settle* (already
  debounced, visible-set gated) — linear, acceptable.

`content-visibility`/containment is a dead end (a body-mounted node can't inherit
an unrelated ancestor's clip). z-index comparison is unreliable (re-deriving
paint order in JS is strictly worse than `elementFromPoint`). `checkVisibility()`
does self-visibility, not occlusion.

### 4. We're in genuinely novel territory — but the pieces exist

Cross-tool survey: **nobody** ships *always-on + non-nested + occlusion-correct*.
The proven combinations are: ephemeral hints (Vimium/Surfingkeys/Tridactyl — dodge
occlusion-over-time by recomputing each keypress); ephemeral-but-live overlay
hints with real `elementFromPoint` occlusion (Link Hints); and **always-on +
nested + occlusion-correct (Rango — the only one, via nesting)**. The combination
we want is unsolved — but its building blocks are proven (Floating UI's clip math
for clipping; Link Hints' `elementFromPoint` for overlays). We'd be assembling
them *continuously on a body-mounted persistent overlay* — new, but not a leap.

## The decision, with occlusion now on the scale

| | Revert to nesting | Stay body-mount + synthetic occlusion (recommended) |
|---|---|---|
| Binding under hostile mutation (C1) | ⚠️ reopens the strip/reattach-storm hazard class our history + Rango both show only "degrades gracefully = drops hints" | ✅ structural win retained — nothing for the page to strip |
| Cross-browser (C2) | ✅ | ✅ |
| Clipping occlusion | ✅ free (when nested) / ❌ on body-fallback | ✅ IO-clip (≈complete); clip-path in reserve for partial/nested |
| Overlay occlusion | ✅ free (when nested) / ❌ on body-fallback | ◑ multi-point hit-test (most); residue below |
| Failure mode | badge in **wrong place** (corner/off-page) or **dropped** | badge **briefly mispainted** then corrected; small residue |
| Maturity | proven (Rango) but we already tried it and reverted | novel assembly of proven pieces |

## Recommendation

**Do not revert to nesting. Keep the body-mounted host and build occlusion as a
layered detector on top of it.** Rationale: nesting would trade a *structural*
binding-robustness win for occlusion-correctness that our own history (560
reattaches/sec, circuit-breakers that drop badges) and Rango's own design ("drops
hints under hostility") show is *not* clean — and it re-imports the exact hazard
that caused the ≥9-revert era. The hybrid keeps binding robustness AND recovers
occlusion-correctness for the dominant cases:

1. **Clipping (the common case): IntersectionObserver rooted at the scroll
   container** — the landed `clip-observer.ts`. Default mechanism. Flicker-free,
   compositor-driven, mainstream (Floating UI parallel).
2. **Overlay (the hard case): multi-point `elementFromPoint`** — upgrade the
   landed center-only `occlusion.ts`. Catches partial occlusion.
3. **Compose** both into the effective `occluded` (already wired via
   `applyOcclusion`), driving the visual hide + the strict-viewport voice drop.

## What we explicitly accept (the irreducible residue)

Without nesting, two overlay sub-cases are undetectable and we **document them as
a known limitation** (and note that nesting *on its body-fallback path* fails them
too, so this is not unique to body-mount):
- **`pointer-events:none` decorative covers** — `elementFromPoint` returns the
  target *through* them.
- **Cross-origin-iframe covers** — opaque to `elementFromPoint`.
Plus, on the clipping side, **non-rectangular / transformed ancestor clips** are
approximated by the rectangular IO/`inset` (rare).

These are uncommon. The honest framing: the hybrid fixes ~all clipping and most
overlay ghosts; a small, well-characterized residue remains that *no* body-mount
technique recovers.

## Phasing (each flag-gated, one layer, soak before default-on)

1. **`bkClipObserver` (landed, prototype)** — IO-root=scroller clip detection.
   Soak on grid-scroll pages; this is the biggest, cleanest win.
2. **Multi-point upgrade to `occlusion.ts`** (center → center+corners). Soak.
3. **Compose + flip defaults** once both soak clean: fold `bkClipObserver` and
   `bkOcclusion` toward default-on (like the accelerator), or merge into one
   `bkOcclusion` flag.
4. **(Deferred, only if partial-slice/nested-scroller fidelity matters)**
   per-pass `clip-path: inset(…)`. Not needed for v1.
5. Update `DESIGN_HINT_OCCLUSION_FILTERING.md` to point here for the architecture
   rationale; record the residue as a permanent known-limitation.

## Provenance

Four-track investigation, 2026-06-09: Rango source (`/tmp/rango`), our git history
(`630f35c`/`bd48b21`/`df8b89a` deletions; `dcd9883`→`fbc71d2`→`6c707b8` re-attach
saga), current-code feasibility (`render/hints.ts`, `reconcile-positioner.ts`,
`observe/clip-observer.ts`, `observe/occlusion.ts`), prior-art survey (Vimium,
Vimium-C, Link Hints, Surfingkeys, Tridactyl, Floating UI). Supersedes the
"deferred overlay case" framing in `DESIGN_HINT_OCCLUSION_FILTERING.md` with a
concrete, recommended path.
