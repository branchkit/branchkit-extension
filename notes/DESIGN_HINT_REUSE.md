# HintBadge Reuse

**Status:** Proposed. Motivated by perceived paint latency on scroll-back —
BranchKit visibly lags Rango on dense lists/tables. After landing IO-debounce
shortening (50→16 ms), SW stack cache (10-20 ms saved per claim), and removal
of the 150 ms fade-in, BranchKit still feels slower than Rango. The remaining
gap is structural: BranchKit destroys and recreates the entire `HintBadge`
DOM on every viewport exit/re-enter cycle, where Rango keeps a persistent
`Hint` object and only toggles visibility.

## Problem

Current lifecycle (`branchkit-extension/src/observe/intersection-tracker.ts:209`
and `src/content.ts:1317`):

```
wrapper enters viewport
  → IO claim batch
  → SW returns codeword
  → onCodewordsChanged
  → reconcile → badgeNewlyCodeworded
  → w.hint = new HintBadge(...)        // Shadow DOM + observers + colors
  → w.hint.show()
  → placeOne(w)                         // probe + z-index walk + style writes

wrapper exits viewport
  → IO queueRelease
  → w.hint.remove()                     // untracks 4 observers, removes from DOM
  → w.hint = null
```

Cost per `new HintBadge`:
- `attachShadow({ mode: 'closed' })` — ~0.3-1 ms
- `<style>` injection with full CSS string — parse + apply
- Create 2-3 elements (host/outer/inner)
- `computeBadgeColors(target)` — APCA contrast calc, ~1-2 ms (apca-w3)
- Resolve `anchorParent` — DOM walk
- Subscribe to four observers:
  - `trackContainerResize(anchorParent)` — RO entry
  - `trackScrollAncestor(scrollAncestor, target)` — listener entry (nesting path only)
  - `trackTargetMutations(target)` — MO entry
  - `trackHostAttributes(host)` — MO entry
- `calculateZIndex(target, host)` — walks descendants + ancestors

On a fast scroll through a 30-row list, BranchKit pays this 30× on the way
down and 30× on the way back up. Rango's equivalent operations: `popLabel()`
from a Set, set `inner.textContent`, hide/show via `display:block`/`none`.

## Prior art — Rango's claim/release

Rango (`/tmp/rango/src/content/wrappers/ElementWrapper.ts`):

```js
// One Hint per wrapper, lazily created on first viewport entry:
intersect(isIntersecting: boolean) {
  this.isIntersecting = isIntersecting;
  if (this.isIntersecting && this.shouldBeHinted) {
    this.hint ??= new Hint(this.element);   // ←  Lazy, ONCE
    this.hint.claim();                       // ←  Just pops a label + queues
  } else if (this.hint?.label) {
    this.hint.release();                     // ←  Returns label + hides
  }
}
```

`Hint.claim()` pops a label string from a Set, sets `inner.textContent`,
queues the hint for batch paint. `Hint.release()` clears textContent + label,
hides the inner element, returns the label to the Set. The `Hint` object,
shadow host, container resolution, observers — all persist.

There's no "destroy and recreate" cycle. The DOM cost is paid once per
wrapper, ever (until the wrapper itself is dropped).

## Proposed: persistent HintBadge per wrapper

Match Rango's lifecycle:

```
wrapper enters viewport
  → IO claim batch
  → SW returns codeword
  → if !w.hint: w.hint = new HintBadge(...)    // FIRST TIME ONLY
    else:        w.hint.setLabel(codeword)     // SUBSEQUENT TIMES — cheap
  → w.hint.show()
  → placeOne(w)

wrapper exits viewport
  → IO queueRelease
  → w.hint.hide()                              // opacity 0; observers persist
  → w.hint.clearLabel()                        // textContent='', label=null
  // (DO NOT remove from DOM; DO NOT untrack observers)
```

Observers stay subscribed across visibility cycles. The host stays attached
to its `anchorParent`. The colors stay computed (badge keeps colored unless
the target changes). The shadow DOM is reused.

## What changes

### `HintBadge` API additions

Two new public methods, both mirroring patterns already present:

```typescript
class HintBadge {
  // Set the displayed label without recreating the badge. The colors are
  // recomputed only if the new label demands a category change (rare —
  // typically the wrapper's category is stable across visibility cycles).
  setLabel(label: LabelAssignment): void {
    this.label = label;
    this.inner.textContent = labelToDisplay(label, this.displayMode);
    this._size = null;  // re-measure on next badgeSize read
  }

  // Drop the current label without tearing down the badge. Used at IO exit:
  // the codeword goes back to the pool but the DOM stays for the next cycle.
  clearLabel(): void {
    this.label = null;
    this.inner.textContent = '';
  }
}
```

`hide()` already exists and only toggles the `.visible` class — no teardown
work. `show()` adds it back. Both are cheap.

### `intersection-tracker.queueRelease` change

Drop the `wrapper.hint.remove()` + `wrapper.hint = null` lines. Replace with:

```typescript
if (wrapper.hint) {
  wrapper.hint.hide();
  wrapper.hint.clearLabel();
}
```

The hint stays bound to the wrapper across visibility cycles, just dormant.

### `content.ts:badgeNewlyCodeworded` change

```typescript
function badgeNewlyCodeworded(): void {
  // ...
  for (let i = 0; i < newBadges.length; i++) {
    const w = newBadges[i];
    const label = poolLabelToAssignment(w.scanned.codeword);
    w.label = label;
    if (w.hint) {
      w.hint.setLabel(label);    // Reuse: fast path
    } else {
      w.hint = new HintBadge(...);  // First time: full construction
    }
    w.hint.show();
    placeOne(w, existingCount + i);
  }
}
```

### Wrapper teardown — when do we actually destroy?

The hint should be destroyed when the wrapper itself is dropped (target gone
from DOM, page navigation, frame teardown), not on viewport exit. That's
already what `detachWrapper` does via `hint.remove()`. No change needed
there; we just remove the eager destruction on IO exit.

## What stays the same

- Codeword pool semantics (sticky reclaim, frame assignment, voice routing).
- Placement math.
- Grammar sync (Put/Delete still fire on codeword churn).
- Observer behavior — same four observers, same coalescing logic.

## Edge cases and risks

### 1. Memory growth on long-lived tabs

Wrappers that have ever been intersecting now hold their `HintBadge` DOM
forever (until wrapper detach). On a YouTube /watch page where you've
scrolled past ~5000 comments over time, that's 5000 persistent shadow DOMs.

**Mitigation:** add a TTL — if a wrapper hasn't been intersecting for >N
seconds, fully `remove()` the hint and null it (current behavior, just
delayed). The TTL window covers the "scroll-back within seconds" case
which is the perceived-lag culprit, and lets memory recover for genuinely
long-distance scroll. Suggest 30-60 s.

Alternative: cap the total live-hint count (say 500) and LRU-evict beyond
that. More complex but tighter bound.

### 2. `retarget()` interaction

`retarget(newEl)` already moves the hint to a new target. With reuse, a
wrapper that rebinds to a new DOM node (DESIGN_WRAPPER_IDENTITY_STABILITY)
calls retarget on its existing hint — already working. No interaction.

### 3. Color recomputation

Colors are computed from the target. If the target's background changes
between visibility cycles (page theme toggle, container hover state), the
old colors are stale. `show()` already calls `applyColors()` so we get a
fresh computation on every visibility-on transition — no regression.

### 4. `setLabel` and the size cache

`_size` is cached for badge dimensions. A different label (different
text width) needs a fresh measurement. `setLabel` invalidates the cache;
the next `badgeSize` read re-measures from `inner.getBoundingClientRect()`.
One layout read per cycle, same as today's fresh-construction case.

### 5. Anchor-name churn (anchor-positioning path)

The anchor-positioning path writes `style.anchor-name` on the target. On
`hide()` we currently do nothing to this; on `remove()` we clear it. With
reuse, the anchor-name persists across hide/show cycles. That's correct —
the same anchor name still points to the same host. No clear needed.

### 6. Codeword stability vs sticky reclaim

Today's sticky reclaim re-grants `preferredCodeword` if still free in the
pool. Combined with hint reuse, the same wrapper that scrolls out and back
gets:
- Same codeword (sticky reclaim wins)
- Same hint object (reuse)
- Same shadow DOM, observers, colors
- Just a textContent re-write if codeword differs

If the pool was exhausted and a different codeword came back, `setLabel`
handles the text swap. The hint still has the same identity. This is
strictly better than today's "rebuild from zero."

## Implementation phases

1. **Add `setLabel` + `clearLabel` to `HintBadge`.** Wire up — no behavior
   change yet (no callers).
2. **Switch `intersection-tracker.queueRelease`** to hide + clearLabel
   instead of remove + null. At this point, IO exit no longer destroys.
3. **Switch `content.ts:badgeNewlyCodeworded`** to reuse existing
   `w.hint` when present. IO re-entry now uses the fast path.
4. **Add TTL eviction.** Periodic sweep (`setInterval` ~30 s) walks `store`,
   destroys hints that haven't been visible in N seconds.
5. **Measure and tune** the TTL. Default 60 s; expose via the badge-
   appearance settings panel if useful.

## Open questions

- **What's the right TTL?** 60 s feels right for typical scroll-back
  patterns, but unknown for very long lists. Could be tab-active time vs
  wall-clock time (a backgrounded tab shouldn't time out aggressively).
- **Should TTL be size-aware?** If memory pressure is low, keep hints
  longer. Probably overkill for v1.
- **Test coverage.** The wrapper-state machine has many edges (limbo
  state, retarget, alphabet regeneration, frame teardown). Need to verify
  hint reuse doesn't break any of them. Existing tests in `intersection-
  tracker.test.ts` are a good starting point; add reuse-specific cases.

## Estimated effort

- API additions (`setLabel`/`clearLabel`): 30 min
- Wire-up at IO queueRelease + badgeNewlyCodeworded: 1 hour
- TTL eviction: 1 hour
- Test updates: 1-2 hours
- Live verification + tuning: 1-2 hours

Total: 4-6 hours. Self-contained, no cross-repo changes, no design dependencies.

## Estimated paint-latency win

Per scroll-back, removing the per-cycle cost:
- `attachShadow`: ~0.5 ms
- Element + style creation: ~1-2 ms
- Color computation: ~1-2 ms
- 4 observer setups: ~2-4 ms (especially MutationObserver registration)
- `resolveContainer` walk: ~0.5-1 ms
- `calculateZIndex` walk: ~0.5-1 ms

Per-badge: ~5-10 ms saved. For a 30-row scroll-back: ~150-300 ms saved
across the batch. Visible win on dense pages.

First-paint (initial scroll down on a fresh page) is unchanged — the hint
has to be created at least once.

## References

- Rango lifecycle: `/tmp/rango/src/content/wrappers/ElementWrapper.ts` (intersect/claim/release)
- Rango Hint: `/tmp/rango/src/content/hints/Hint.ts` (claim/release methods)
- BranchKit current teardown: `branchkit-extension/src/observe/intersection-tracker.ts:209`
- BranchKit current build: `branchkit-extension/src/content.ts:1317`
- `retarget` model for safe in-place observer swaps: `src/render/hints.ts:716`
