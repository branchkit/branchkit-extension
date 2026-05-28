# Wrapper Identity Stability

Draft. Status: proposed.

## Problem

BranchKit has two notions of "what does this codeword refer to":

1. **DOM identity** — a specific `Element` node. Held by `ElementWrapper.element`, the `WrapperStore.byElement` Map key, the `HintBadge.target` field, and every per-element observer (IntersectionObserver, ResizeObserver, the three new tracker modules).
2. **Logical identity** — "the Send button," whichever DOM node currently represents it. Already implemented in `src/registry.ts` as `WeakRef<Element>` plus a fingerprint (role + name + tag + text + href + inputType), with a `fingerprintFallback()` path that recovers the new element after a React swap.

The two layers are inconsistent. The dispatch path uses logical identity and works correctly across React reconciliation — voice activation finds the new element by fingerprint. The wrapper layer uses DOM identity, so when an element disconnects:

1. `dropDisconnectedWrappers()` calls `detachWrapper(element)`
2. `store.removeWrapperByElement` runs `w.releaseLabel()` (returns codeword to the pool) and `w.destroy()` (removes the badge from the DOM)
3. `~50–200ms later`, `doScan()` discovers the new element and creates a fresh wrapper with a freshly-claimed codeword

User-visible result: badges flicker off and reappear with **different letters** in the same visual positions. Voice users lose codeword continuity across every modal open, list refresh, or SPA navigation. The element is logically the same; the system treats it as new.

## Goal

Bring the wrapper layer in line with the registry's identity-stable model. A wrapper that loses its DOM element should enter a brief limbo state during which it can be re-bound to a fingerprint-matching replacement element. Same wrapper, same codeword, same badge — only the element pointer changes.

## Current architecture map

Every site that holds an `Element` reference associated with a wrapper, and what assumption it embeds:

| Site | Reference | Assumption |
|---|---|---|
| `WrapperStore.byElement: Map<Element, ElementWrapper>` | key | element is the wrapper's stable identity |
| `WrapperStore.findWrapperFor(el)` | key lookup | "is this element wrapped?" answered by reference equality |
| `WrapperStore.removeWrapperByElement(el)` | key delete | unmap on element removal |
| `ElementWrapper.element` | field | direct access from callers; `readonly` by convention, not by `as const` |
| `ElementWrapper.scanned.id` | registry id | survives rebind already (registry has `rebindRef`) |
| `registry.reverseIndex: WeakMap<Element, number>` | key | element→id lookup |
| `registry.entries[id].ref: WeakRef<Element>` | pointer | **already mutable** via `rebindRef()` |
| `HintBadge.target: Element` | field | positioning math (`updatePosition`, `badgeSize`, `applyColors`, `setMatchedChars`) |
| `HintBadge.anchorParent: HTMLElement` | field | container resolution result; badge host's DOM parent |
| `tracker.io.observe(element)` | IO observation | per-wrapper viewport tracking |
| `resizeObserver.observe(element)` | RO observation | per-wrapper visibility detection (the hintability one, not #1) |
| `trackContainerResize(anchor)` | per-anchor MO | #1 wakeup trigger |
| `trackTargetMutations(target)` | per-target MO | #2 wakeup trigger |
| `trackHostAttributes(host)` | per-host MO | #7 defender (host is the badge's own div, NOT the target — survives rebind unchanged) |
| `badgeReattachObserver` | body-level MO | finds by `data-branchkit-hint` attribute, not by ref — survives rebind unchanged |

Counting: 11 sites need a rebind hook; 2 sites (`host-attribute-tracker`, `badgeReattachObserver`) are unaffected.

## Proposed model

### Identity-stable wrapper

`ElementWrapper.element` becomes a mutable pointer. The wrapper's identity is its `scanned.id` (registry id) and `fingerprint` (snapshot of role/name/tag/text taken at construction). Codeword binds to the wrapper, not to the element.

Two new lifecycle states on the wrapper:

```typescript
interface ElementWrapper {
  element: Element;            // now mutable
  scanned: ScannedElement;
  hint: HintBadge | null;
  label: LabelAssignment | null;
  disconnectedAt: number | null;  // null when connected; timestamp when first observed disconnected
  // ... existing fields
}
```

A `WrapperHandle` adapter shim (see "Migration sequencing" below) gives callers a stable façade during the transition.

### Limbo lifecycle

States: `connected → limbo → (rebound | finalized)`.

```
discovery
   │
   ▼
connected ──disconnect detected──► limbo ──fingerprint match within deadline──► connected (rebound)
                                     │
                                     └─deadline elapsed─► finalized (current detach path)
```

Transitions:

- **Enter limbo**: `dropDisconnectedWrappers()` sets `disconnectedAt = now()` instead of immediately calling `detachWrapper`. Per-element observers stay attached to the (disconnected) element — they're harmless until untracked.
- **Rebind**: when `discoverInSubtree()` encounters a new hintable element, before creating a fresh wrapper it asks the store: "is there a limbo wrapper whose fingerprint matches this element?" If yes — and only one match — rebind.
- **Finalize**: a sweeper (piggyback on the existing huge-mutation timer, or a dedicated 250ms interval) calls `detachWrapper` on any limbo wrapper whose `disconnectedAt` is older than the deadline.

### Rebind operation

```typescript
function rebindWrapper(w: ElementWrapper, newEl: Element): void {
  const oldEl = w.element;

  // Store reverse-index
  store.rebindElement(oldEl, newEl, w);  // removes old key, adds new

  // Registry — already supports this
  if (w.scanned.id > 0) idRegistry.rebindRef(w.scanned.id, newEl);

  // Refresh fingerprint in case the new element has minor variations
  // (text changes that are within fingerprint tolerance)
  if (w.scanned.id > 0) idRegistry.refreshFingerprint(w.scanned.id, newEl);

  // Per-wrapper observers (DOM identity)
  tracker.unobserve(oldEl);
  tracker.observe(newEl);
  resizeObserver.unobserve(oldEl);
  resizeObserver.observe(newEl);

  // Badge retargeting
  if (w.hint) w.hint.retarget(newEl);

  // Mutable element pointer last
  w.element = newEl;
  w.disconnectedAt = null;
}
```

`HintBadge.retarget(newEl)` is the load-bearing new method:

```typescript
retarget(newEl: Element): void {
  untrackContainerResize(this.anchorParent);
  untrackTargetMutations(this.target);

  this.target = newEl;
  const ctx = resolveBadgeContext(newEl, this.host, this.outer);
  this.anchorParent = ctx.container;
  // host is already moved by appendChild inside resolveBadgeContext

  trackContainerResize(this.anchorParent);
  trackTargetMutations(this.target);
  // host-attribute tracker: no change (same host)

  this.reposition();
}
```

### Badge state during limbo

Three options:

| Option | Behavior | Pros | Cons |
|---|---|---|---|
| (a) Hide immediately | Hide the badge as soon as `disconnectedAt` is set | No stale-position flash | Brief disappearance even when rebind succeeds |
| (b) Leave visible at last position | Keep showing until rebound or finalized | No flicker on successful rebind | Up to 250ms of stale position if finalized |
| (c) Move to "wherever the element thinks it is" | The disconnected element's `getBoundingClientRect()` returns `{0,0,0,0}` | — | Badge teleports to (0,0), worst UX |

**Recommendation: (b).** Most disconnects are followed by rebind within ~16ms (one React render); the brief stale position is invisible. The rare finalize-after-250ms case shows a slightly-wrong badge for that window, which is no worse than today's "badge gone entirely" experience.

### Fingerprint disambiguation

The registry's fingerprint already has known false-positive cases: a list with two `[Reply]` buttons has two elements with identical (role=button, name="Reply", tag=button, text="Reply"). Rebinding one to the wrong sibling would be a real correctness bug — voice activation would then click the wrong row.

Options:

- **Position hint** — store the wrapper's last-known rect at disconnect. Prefer the candidate element whose rect is closest. Requires storing rect on disconnect.
- **DOM-path hint** — store the parent's signature (parent role + tag, optionally aria-label). Only rebind if the new element's parent matches. Cheap, narrows most cases.
- **Refuse on ambiguity** — if more than one limbo wrapper matches the new element's fingerprint (or vice versa), refuse to rebind both: finalize all of them and let them be re-created fresh. Today's behavior, just delayed.

**Recommendation for v1: refuse on ambiguity.** Easier to reason about correctness; bias toward correctness over completeness. Position hint and DOM-path hint can be added in v2 if the refuse rate is too high in practice. Instrument the refuse path so we can measure it.

## Tracker module changes

Already enumerated in the "Current architecture map" above. Concretely:

- `container-resize-tracker`: unaffected as a module; `HintBadge.retarget()` is responsible for untrack(old)+track(new). The tracker is element-keyed and works correctly across rebind.
- `target-mutation-tracker`: same pattern.
- `host-attribute-tracker`: unaffected — host element is the badge's own div, unchanged across target rebind.
- `intersection-tracker`: needs `unobserve(oldEl) + observe(newEl)` on rebind. The `pendingClaim` set is keyed by wrapper, not by element, so codeword claim/release continuity is preserved automatically.
- `resizeObserver` in `content.ts:586` (visibility detection): same pattern.
- `badgeReattachObserver`: unaffected — finds by attribute, not by ref.

## Migration sequencing

Two approaches:

**Option A: Big-bang.** Single commit that flips `wrapper.element` to mutable and adds `rebindWrapper` + all tracker updates at once. Risk: large diff; reviewer can't easily verify individual sites are correct; revert risk.

**Option B: Adapter shim, incremental migration.**

1. Introduce a `WrapperHandle` interface that exposes `getElement(): Element` + `onElementChanged(callback)`. `ElementWrapper` implements it.
2. Migrate sites one at a time from direct `.element` access to `getElement()` + subscription.
3. Once all hot sites use the handle interface, flip `element` to mutable and add `rebindWrapper`.
4. Drop the shim once everything's migrated.

**Recommendation: Option B.** The shim is small (~50 lines), reviewable incrementally, and gives us a forcing function to find sites that read `.element` once and cache it (which would break under rebind). Adapter callsites are mechanical; the design choices are isolated to the rebind algorithm.

Concrete order:

1. Add `WrapperHandle` interface + `getElement()` on `ElementWrapper` (no behavior change yet)
2. Add `disconnectedAt` field, change `dropDisconnectedWrappers` to set it instead of detaching (no rebind yet — just a delay)
3. Add finalize sweeper (250ms deadline → detachWrapper)
4. Add fingerprint-match lookup in `discoverInSubtree`, refuse-on-ambiguity policy
5. Add `HintBadge.retarget()` and `rebindWrapper()`; wire into discoverInSubtree
6. Migrate hot-path sites from `.element` to `getElement()`
7. Add observability: count rebinds, finalizes, refusals; surface in debug overlay
8. Per-site soak: load Gmail / Linear / Discord, exercise the modal flows, confirm codeword continuity

## Alternatives considered

- **Cosmetic-only fix**: delay `badge.remove()` by 200ms but still drop the wrapper. Codeword still churns; only the visual flicker is smoothed. Net: doesn't address voice-continuity, which is the actual product gap.
- **Per-site fingerprint policy**: site-specific fingerprint extensions (e.g., on Gmail also fingerprint the email subject). Pro: handles known ambiguous cases. Con: maintenance escape-hatch; doesn't scale to the long tail.
- **Page-side stable ID injection**: require pages to add `data-bk-id`. Pro: zero ambiguity. Con: not a real option — extension can't require page cooperation.
- **More aggressive disconnect debouncing**: defer `dropDisconnectedWrappers` by N ms before running it. Pro: simplest. Con: same outcome as today, just slower — the wrapper still dies, codeword still churns. Doesn't fix anything.

## Open questions

1. **Codeword reservation during limbo.** Does the codeword stay claimed (preventing new wrappers from getting it) or release immediately?
   - Hold: rebind is guaranteed to get the same codeword. Cost: pool fragmentation during heavy churn — a Discord scroll could leak temporarily-reserved codewords for the deadline window.
   - Release: simpler, no fragmentation. Cost: rebind may get a different codeword (defeats the whole goal in pool-pressure scenarios).
   - **Tentative**: hold. The 676-codeword pool size and the ~250ms deadline put a worst-case ceiling on fragmentation that's well within budget.

2. **bfcache restore.** Existing `idRegistry.clear()` runs on `pageshow.persisted`. Should we also clear limbo? The wrappers' `.element` refs are likely valid (V8 context preserved) but the layout may have shifted. Probably: finalize all limbo wrappers immediately on bfcache restore, let the rescan rebuild fresh.

3. **iframe removal.** When an iframe element disconnects from its parent frame, all wrappers in that frame should finalize at once. The frame's own content script will tear down via the existing port-disconnect path, but the parent's MO might see the iframe removal first. Likely a no-op (the per-iframe content script's wrappers aren't in the parent's store), but worth verifying.

4. **Fingerprint refresh during limbo.** If the new element's text changed slightly (e.g., "Reply" → "Reply (1)"), `fingerprintsEqual` returns false. Do we run a more permissive match during limbo? Tradeoff: leniency increases match rate (good) but raises false-positive risk (bad).

5. **Test harness.** happy-dom doesn't simulate React reconciliation. We'd need either:
   - A stub harness that mimics the disconnect-then-insert pattern (synthetic test)
   - Playwright tests against real React fixtures (heavier infrastructure)
   - Both, with the synthetic harness as the fast-feedback path and Playwright as the integration check

## Decision needed

Three decisions before implementation:

1. Go / no-go on Option B (incremental migration with `WrapperHandle` shim)
2. v1 disambiguation policy: refuse-on-ambiguity vs. position-hint
3. Codeword reservation policy during limbo: hold vs. release

Implementation work, assuming Option B + refuse + hold: estimated 5–8 days, split across 8 steps above. Each step is independently revertable.
