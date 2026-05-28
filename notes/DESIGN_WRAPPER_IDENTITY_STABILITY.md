# Wrapper Identity Stability

Draft. Status: proposed (three decisions resolved internally; awaiting implementation go-ahead).

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

Options considered:

- **Position hint** — store the wrapper's last-known rect at disconnect. Use rect-center distance as the tiebreaker among multiple fingerprint matches.
- **DOM-path hint** — store the parent's signature (parent role + tag, optionally aria-label). Only rebind if the new element's parent matches.
- **Refuse on ambiguity** — if more than one limbo wrapper matches the new element's fingerprint (or vice versa), finalize all ambiguous wrappers and let them be re-created fresh. Equivalent to today's behavior, just delayed.

**Decision: position-hint.** The ambiguous cases (Gmail thread list, Slack reactions, social feed buttons) are exactly where #5 needs to work — refuse-on-ambiguity would make the feature vestigial in the cases that matter most. Position-hint is cheap and the rect data is already touched by the allocator.

Algorithm:

1. **On disconnect**: capture the element's `getBoundingClientRect()` as `lastRect` on the wrapper. One layout read; reuses the cached rect if available.
2. **On new-element discovery**: find all limbo wrappers whose `fingerprintsEqual(wrapper.scanned.fingerprint, newFp)`.
3. **If zero matches**: create a fresh wrapper (existing path).
4. **If exactly one match**: rebind.
5. **If multiple matches**: pick the wrapper whose `lastRect` center is nearest to the new element's rect center. If the winning distance is > **REBIND_DISTANCE_THRESHOLD** (initial: 50px), refuse all — finalize the ambiguous limbo wrappers, create a fresh wrapper for the new element.

The 50px threshold means "list rearranged because new item inserted at top, every row shifted down" falls through to refuse (the wrappers genuinely moved, not swapped). Tunable based on instrumentation. Per-axis distance, not Euclidean — vertical and horizontal mismatches mean different things on different sites.

Instrumentation must distinguish three counter buckets so calibration is grounded:
- `rebind_clean`: unique fingerprint match, no ambiguity
- `rebind_position`: multiple matches, position tiebreaker resolved within threshold
- `refuse_distance`: multiple matches, winner exceeded distance threshold
- `refuse_no_match`: limbo wrapper expired with no fingerprint match found

A high `refuse_distance` rate on a given site indicates the threshold is too tight or the page is doing something exotic (full-list reordering). A high `refuse_no_match` rate indicates fingerprint refresh is the bigger lever (see open question 4).

## Tracker module changes

Already enumerated in the "Current architecture map" above. Concretely:

- `container-resize-tracker`: unaffected as a module; `HintBadge.retarget()` is responsible for untrack(old)+track(new). The tracker is element-keyed and works correctly across rebind.
- `target-mutation-tracker`: same pattern.
- `host-attribute-tracker`: unaffected — host element is the badge's own div, unchanged across target rebind.
- `intersection-tracker`: needs `unobserve(oldEl) + observe(newEl)` on rebind. The `pendingClaim` set is keyed by wrapper, not by element, so codeword claim/release continuity is preserved automatically.
- `resizeObserver` in `content.ts:586` (visibility detection): same pattern.
- `badgeReattachObserver`: unaffected — finds by attribute, not by ref.

## Migration sequencing

Two approaches considered:

**Option A: Big-bang.** Single commit that flips `wrapper.element` to mutable and adds `rebindWrapper` + all tracker updates at once.

**Option B: Adapter shim.** Introduce a `WrapperHandle` interface exposing `getElement()` + `onElementChanged(callback)`. Migrate sites one at a time, then flip `element` to mutable. Drop the shim after.

**Decision: big-bang.** Actual surface count from `grep -rn '\.element\b' src/ --exclude='*.test.ts'`: **48 occurrences across 11 files**, heavily concentrated in `content.ts` (20). Almost all are read-and-use patterns; no caching of the ref across async boundaries that would break under mutation. There's no `wrapper.element =` write anywhere in the codebase today — the field is only set in the constructor.

The shim's value is when the surface is large enough that migration spans days or weeks and concurrent work needs an adapter. At 48 sites, the shim adds review burden (every site changes twice — once to adopt `getElement()`, once to drop it) without proportional risk reduction. Big-bang is one atomic refactor with a single comprehensive test pass.

Concrete order:

1. Add `disconnectedAt: number | null` and `lastRect: DOMRect | null` fields to `ElementWrapper`. Change `dropDisconnectedWrappers` to set them instead of calling `detachWrapper`. No rebind yet — just a delayed finalize. Verify badges stay visible for ~250ms after disconnect instead of disappearing immediately.
2. Add finalize sweeper (250ms deadline → existing `detachWrapper` path). Verify limbo wrappers actually clear after the deadline. Pool size remains bounded.
3. Add fingerprint-match lookup + position-distance tiebreaker in `discoverInSubtree`. Refuse path on threshold-exceeded ambiguity. Verify ambiguous-list scenarios refuse cleanly.
4. Add `HintBadge.retarget(newEl)` + `rebindWrapper()`. Wire into `discoverInSubtree`. This is the big-bang step — `wrapper.element` becomes mutable, all 11 sites change atomically (no callers actually break because they all read once and use immediately).
5. Add four-bucket instrumentation (`rebind_clean`, `rebind_position`, `refuse_distance`, `refuse_no_match`) accessible via debug overlay + console. Soak on Gmail / Linear / Discord; tune `REBIND_DISTANCE_THRESHOLD` based on observed distributions.
6. Decide on bfcache, iframe-removal, and fingerprint-refresh policies based on what the soak reveals (see open questions).

## Alternatives considered

- **Cosmetic-only fix**: delay `badge.remove()` by 200ms but still drop the wrapper. Codeword still churns; only the visual flicker is smoothed. Net: doesn't address voice-continuity, which is the actual product gap.
- **Per-site fingerprint policy**: site-specific fingerprint extensions (e.g., on Gmail also fingerprint the email subject). Pro: handles known ambiguous cases. Con: maintenance escape-hatch; doesn't scale to the long tail.
- **Page-side stable ID injection**: require pages to add `data-bk-id`. Pro: zero ambiguity. Con: not a real option — extension can't require page cooperation.
- **More aggressive disconnect debouncing**: defer `dropDisconnectedWrappers` by N ms before running it. Pro: simplest. Con: same outcome as today, just slower — the wrapper still dies, codeword still churns. Doesn't fix anything.

## Decisions resolved

| # | Question | Decision | Why |
|---|---|---|---|
| 1 | Migration approach | Big-bang | 48 sites across 11 files; no cached-ref patterns; shim adds review burden without proportional risk reduction |
| 2 | Disambiguation policy | Position-hint + 50px threshold | Refuse-on-ambiguity would make the feature vestigial in its highest-value cases (Gmail thread list, social feeds); rect data is already touched by the allocator |
| 3 | Codeword during limbo | Hold | `releaseLabels` unshift only preserves order in uncontested cases; concurrent IO claims during scroll-plus-render would shuffle the codeword. Hold guarantees continuity at bounded worst-case (676 codewords × 250ms) |

## Codeword reservation rationale (decision 3 detail)

`releaseLabels()` does `stack.free.unshift(...)`, so an *uncontested* release-then-reclaim cycle returns the same codeword. This works on a quiet page. But:

- The `IntersectionTracker` (`intersection-tracker.ts:50ms` debounce) batches claims for newly-scrolled-in elements
- A typical user gesture is scroll + click, which produces concurrent React-render disconnects and IO-driven new claims
- Released codewords sit at the head of the stack for ~16ms before being grabbed by the IO batch flush; if rebind happens after that, the wrapper gets a different codeword

Hold avoids the race entirely. Worst case: 676 codewords held in limbo for 250ms (the pool fully reserved). Only relevant when more genuinely-new elements appear during a render than were disconnected — rare in practice. Those new elements wait up to 250ms for an empty slot. Acceptable.

## Open questions

1. **bfcache restore.** Existing `idRegistry.clear()` runs on `pageshow.persisted`. Should we also clear limbo? The wrappers' `.element` refs are likely valid (V8 context preserved) but the layout may have shifted. Probably: finalize all limbo wrappers immediately on bfcache restore, let the rescan rebuild fresh. Defer until soak reveals whether this matters.

2. **iframe removal.** When an iframe element disconnects from its parent frame, all wrappers in that frame should finalize at once. The frame's own content script will tear down via the existing port-disconnect path, but the parent's MO might see the iframe removal first. Likely a no-op (the per-iframe content script's wrappers aren't in the parent's store), but worth verifying.

3. **Fingerprint refresh during limbo.** If the new element's text changed slightly (e.g., "Reply" → "Reply (1)"), `fingerprintsEqual` returns false. Do we run a more permissive match during limbo? Tradeoff: leniency increases match rate (good) but raises false-positive risk (bad). Defer to v2 if `refuse_no_match` counter is high.

4. **Test harness.** happy-dom doesn't simulate React reconciliation. We need either:
   - A stub harness that mimics the disconnect-then-insert pattern (synthetic test)
   - Playwright tests against real React fixtures (heavier infrastructure)
   - Both, with the synthetic harness as the fast-feedback path and Playwright as the integration check
   - Initial direction: synthetic harness first. Playwright integration only if synthetic misses real bugs.

## Estimated work

**3–5 days** across the 6 implementation steps above. Each step is independently revertable. The big-bang step (4) is the largest single diff but lands once `disconnectedAt` + finalize sweeper (steps 1–2) prove the lifecycle change is safe in isolation.
