# Settle trigger scoping — the idle-storm fix

2026-07-15/16. Follow-up to the settle-storm diagnosis (firehose rounds 1-2,
diag commits f78cca6 / b165414).

## What the capture showed

Idle Gmail inbox, focused, hands off: a settle pipeline pair every ~505ms,
forever — 4 settles/sec, ~59.6ms settleGather each, ~24% main-thread share
on a 210-wrapper tab. The instrumentation attributed every cycle:

```
vismo_target:attr:style:div.T-aT4-Mp          (x68 in 60s)
mo_target:child:rm:div.T-aT4-Mp-aPV:under:div (x68 in 60s)
settle:enter:store:deferred:mo-batch+passSoon:vis-mo
settle:enter:store:unattributed               (the twin, ~100ms later)
```

Gmail's own UI (the `T-aT4-Mp` widget family) does a style write plus a
child add/remove about twice a second, forever. NOT our writes: the second
settle of each pair enters `unattributed`, and the vis-MO's `[own]`
sightings are rare and small (badge transforms are identical-value at idle,
which CSSOM doesn't even serialize into mutation records). There is no
self-re-arm and no plan-vs-writer strict disagreement (`strictflip:*` ~0 at
idle). The regression is pure amplification of a cosmetic page tick:

1. **Duplicate pass.** One tick arms BOTH `scheduleDeferredReposition`
   (page MO, 'mo-batch') and `schedulePassSoon` (visibility MO, 'vis-mo')
   — two independent 100ms timers, each running the identical
   `runSettlePipeline('store')` ~100ms apart.
2. **Unscoped visibility MO.** It watches class/style document-wide with no
   own-mutation filter and no relevance check; ANY flip anywhere requests a
   full settle. The old (pre-Phase-E) backstop this demotion replaced was a
   bounded 100ms recheck loop — cheap per tick. The unified pass is not.
3. **Unscoped mo-batch settle.** Every foreign mutation batch requests a
   full settle, when the only thing an untracked-content change warrants is
   a positioner pass ("layout may have shifted" — reposition is the
   consumer of that signal; discovery of ADDED content rides
   drainDiscovery, removal handling rides dropDisconnectedWrappers).

## The fix (three edges, all at the trigger source)

1. **One store pass per signal window.** `runSettlePipeline('store')`
   cancels the sibling store timer at entry (the firing timer already
   nulled itself). Any signal arriving after the synchronous pass re-arms
   fresh. Not damping — the sibling was requesting the pass that just ran.
2. **Relevance gate on the visibility MO.** Refined after round 3 (the
   first containment-only gate still passed the Gmail tick — `T-aT4-Mp`
   relates to tracked elements by containment). Per mutated node: relevant
   if it IS a tracked element (wrapper or parked candidate); if it's an
   ANCESTOR of one, a `style` record must touch a visibility-affecting
   property (display / visibility / opacity / content-visibility / clip —
   checked against new AND old inline style via `attributeOldValue`, so
   removing `display:none` is a reveal) while class/open/hidden flips stay
   fail-open; a node strictly INSIDE a tracked element is irrelevant
   (computed visibility flows from self + ancestors; size-collapse side
   effects ride the ResizeObserver paths). Composed-tree containment so
   shadow-hosted wrappers count; own badge hosts excluded. Batches with
   more than a handful of distinct nodes pass automatically. Skips are
   counted (`visMoIrrelevantSkips`) — visible compression, not a silent
   drop.
3. **mo-batch downgrade.** A foreign batch whose records touch no tracked
   element schedules the positioner pass (badge positions still converge
   after reflow) instead of a full settle. Batches touching tracked
   elements keep the full settle — the QuickBase double-buffered flip
   (class reveal on a container full of tracked wrappers) stays on the
   settle+sweep-arm path (round 14), and added-node discovery rides
   drainDiscovery regardless.

## Accepted residuals

- An untracked-content change that reflows tracked elements across the
  strict-viewport boundary without any scroll/resize/transition signal now
  converges `_strict` at the next real settle instead of within 100ms.
  Positions (the user-visible part) still converge via the downgrade's
  positioner pass; scroll — the dominant way things cross the boundary —
  has its own settle.
- The relevance sweep is O(targets × tracked) per batch, capped at 8
  distinct targets before passing automatically; at idle-tick rates this is
  microseconds against a 59ms settle.

## Verification

- Idle Gmail (the storm tab): settle:enter ~0/min while `mo_target:`/
  `vismo_target:` ticks continue (page keeps ticking; we stop responding).
- QuickBase interaction: mass reveal / badge paint unchanged (settle path
  for tracked-relevant batches intact).
- Wedge test, full vitest.
