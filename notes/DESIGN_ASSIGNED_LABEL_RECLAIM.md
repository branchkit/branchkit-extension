# Stranded assignments — the label pool's one-way leak

**Status:** Diagnosed from field evidence 2026-07-29, fix proposed, not yet built.
**Siblings:** `DESIGN_DOCUMENT_SCOPED_POOL_OWNERSHIP.md` (who owns a label),
`DESIGN_PRERENDER_POOL_POISONING.md` (stranded *reservations*, and the L2 steal
that reclaims them). This note is that note's missing half.

## The report

Find on a Wikipedia article: 74 matches, **zero badges**. Same gesture on an
earlier page had worked. Then, a few pages later, it worked again.

```
[search_badges.armed] {"matches":74, "badged":0,
                       "pool_free":0, "pool_outstanding":94, "refilling":true}
```

Find was fine. There were no labels to give it.

## What the pool actually looked like

Two `Ctrl+Alt+A` snapshots, six minutes apart, same tab. The pool is 676 pairs.

| | 01:41 (find failed) | 01:47 (find worked) |
|---|---|---|
| `free` | 0 | **0** |
| `stale_reservations` | 290 | **0** |
| assigned | 4 docs / 386 | 4 docs / 614 |
| reserved | 3 docs / 290 | 2 docs / 62 |
| `ff59c275` assigned | **126** | **126** |
| `1ccf760f` assigned | **122** | **122** |

Three things follow, and together they explain both snapshots exactly.

**The reserved side self-heals.** 290 stale reservations went to 0 as the L2
steal (`DESIGN_PRERENDER_POOL_POISONING.md`) reclaimed them and handed them to
the incoming document. That is the whole reason the second search worked.

**The assigned side does not.** `ff59c275` and `1ccf760f` hold *byte-identical*
counts across both snapshots — 126 and 122 — through six minutes and several
navigations. `ff59c275`'s liveness Port died at **01:16**; it still held 126
labels at **01:47**. That is 248 of 676 labels, 37% of the pool, gone.

**The success was not a recovery.** `free` is 0 in the working snapshot too. The
second search succeeded by consuming the last reclaimable supply, not because
the pool refilled. The next find on a heavy page fails again.

## Mechanism

`releaseDocument(tabId, docId)` is correct and doc-scoped: it frees exactly that
document's `assigned` *and* `reserved` entries and can never touch a successor's.
It has exactly one caller — the per-frame liveness Port's `onDisconnect` in
`background/frame-liveness.ts`.

So the leak is not in the release. It is that **the release is never called.**

`releaseDocument`'s own doc comment names the gap and then mis-bounds it:

> The one residual gap is the service-worker-idle window: if the SW is
> terminated when the frame dies, `onDisconnect` may not fire until the SW next
> wakes, so the reclaim is **delayed (bounded by the 676-label pool capacity,
> not lost)**.

"Delayed, not lost" is the false step. If the service worker is not running when
the Port dies, there is no listener to fire, and **Chrome does not replay
disconnects for ports that died while the worker was asleep**. When the worker
next wakes, the document is already gone: nothing holds its `docId`, nothing
will ever call `releaseDocument` for it, and no other path reclaims `assigned`.
The 676-capacity bound assumed a deferred delivery that never arrives.

MV3 idle-terminates aggressively, and navigation is exactly when a content
script dies and the worker is most likely to be idle — so this fires on ordinary
browsing, not an exotic race.

### Why the existing guards don't cover it

- **The L2 steal** reclaims from `stack.reserved` only, gated on
  `RESERVATION_STALE_MS`. `stack.assigned` has no `assignedAt` stamp and no
  reclaim of any kind. That asymmetry is precisely what the two snapshots show.
- **The Go plugin's `session_end ignored (doc mismatch)` fence** is correct and
  must stay. Its comment records the 2026-07-24 Wikipedia ZY repro, where an
  unfenced cleanup destroyed 262 of the *successor's* live codewords. It governs
  the plugin's grammar sessions, not the extension's label pool. **It is not
  this bug** — an early read of this investigation blamed it, wrongly.
- **`clearStack`** runs on tab close only, so a long-lived tab never resets.

## The fix

Give `assigned` a reclaim, mirroring what `reserved` already has, and drive it
off liveness rather than off time alone.

1. **Stamp assignments.** `assignedAt[label]`, written where `reservedAt` is.
2. **Reap on demand, not on a timer.** When a grant request finds `free`
   exhausted and the stale-reservation steal is still short, sweep `assigned`
   for labels whose owning `docId` has no live liveness Port and whose stamp is
   older than a generous TTL. Release those and continue the grant.
3. **Keep it doc-scoped.** Same invariant as `releaseDocument`: reap by `docId`,
   never by `(tab, frame)`, so a successor at the same frame key is
   unrepresentable as a victim.

### Traps this must not fall into

- **`livePortDocs` is in-memory and dies with the worker.** Immediately after a
  restart every document looks dead, and a naive liveness check would wipe the
  live page. The TTL is what covers that window — it must comfortably exceed the
  time content scripts take to re-register their Ports through the SW-restart
  healer. Liveness alone is not sufficient; the conjunction is.
- **A late confirm from a reaped document** must lose arbitration and recover
  through the existing rejection handler, exactly as an L2-stolen reservation
  does. This is not new machinery — reuse it.
- **Do not widen the Go fence** to "fix" this. It is load-bearing and this is
  not its bug.

## How to know it worked

- **Reproduce first.** Navigate several heavy pages (an article with ~1,300
  hintable elements will do), taking a snapshot each time, and watch `free`
  ratchet down without recovering. That monotonic fall *is* the bug; a fix makes
  it recover.
- **Unit-testable without a browser.** `releaseDocument` and the stack are pure
  over a fake stack: seed `assigned` for a dead doc plus a live one, run the
  reap, assert only the dead doc's labels return and the live doc is untouched.
- **The mutation that matters:** make the reap ignore the liveness check. It must
  then fail a test that has a live document holding labels — otherwise the reap
  is free to eat the live page and nothing would say so.

## Why this was invisible

Every gate is per-page. The harnesses launch a fresh profile, run one scenario,
and exit — a pool leak needs *several navigations in one long-lived tab* to show,
which is the one shape nothing automated does. It only surfaces as a user
noticing that a feature which worked ten minutes ago has quietly stopped, and
then works again later for reasons that look like superstition.

The instrumentation, to its credit, was already sufficient: `poolSnapshot`'s
per-document breakdown plus `stale_reservations` made this a ten-minute
diagnosis once someone looked. Two snapshots six minutes apart is what turned
"strange" into a mechanism.
