# Orphan-CS paint — the arc, the tripwire, the probe

Date: 2026-07-24
Status: ARC COMPLETE — all five layers landed same-day. Layer 2 answered
the port question; layer 3 shipped both mechanisms + the CacheFlushed
finding; layer 4 (observer fold) caught the attention-IO teardown leak;
layer 5 landed the machinery-gate lift (content.ts 3576, ceiling 3620).
Settle-fold: re-evaluated post-arc and REMAINS rejected — wireSettleSignals
is already the deliberate single wiring site (June settle-engine arc);
relocation buys line count, not a boundary. Remaining: extended real-world
soak (layers 3-5 shipped same-day); Firefox field evidence via the probe.

The dedicated orphan-CS teardown arc (kickoff brief in session memory;
required reading: `DESIGN_ORPHAN_CS_TEARDOWN_RETROSPECTIVE.md`,
`SOAK_TEARDOWN.md`, `DESIGN_TEARDOWN_OWNERSHIP.md`). Deliverables: (1) the
PAINT half of the reload quirk — an orphaned content script keeps badges
painted that it can no longer service; (2) coherent teardown ownership;
(3) thereby unblock the two round-3 fenced lifts (machinery-gate,
settle-fold — `DESIGN_RESTRUCTURE_ROUND3.md` sec 8).

## Where the arc starts from

Phase 1 guards + Phase 2a registry Lifts 1–4 are DONE and in pushed history
(see `DESIGN_TEARDOWN_OWNERSHIP.md` "Status"). Every interval, fire-once
timeout, and window/document listener is registry-owned; teardown-completeness
is objectively verified by `npm run soak:orphan` (SHADOW_EVENT residual
50 → 0). The sync `sendMessage` throw stays as the backstop brake. What this
arc adds is the PAINT story (below) plus the deferred consolidation (Lift 5,
Lift 3b) and the ownership contract.

## The paint gap

`quiesceOrphan` removes badge hosts — but only when it RUNS. It runs via
`liveness.onOrphan`, which needs the liveness Port's `onDisconnect` to fire
in a context where `chrome.runtime.id` is gone. The gap windows:

- **No disconnect delivered.** A page in bfcache during an extension reload
  gets no Port-disconnect event; on restore the elder repaints from
  `restoreFromBfcache` with a dead context. (Prime suspect — the
  `DESIGN_PRERENDER_POOL_POISONING.md` sec 5 open question about whether a
  restored page's Port is silently dead is the same seam.)
- **Elder repaint after successor boot.** The successor's boot sweep clears
  old hosts once; a resurrection path in the elder that repaints AFTER that
  sweep leaves badges no store owns.
- **No successor arrives.** Reinjection missed the tab/frame; the orphan's
  paint sits until navigation.

POOL_AUDIT (painted-vs-routable) cannot see any of these: orphan hosts are
not in the fresh store, so there is nothing to ask the pool about. The
detector has to be DOM-side.

## Layer 1 — the tripwire (this commit)

Every badge host is stamped at creation with its creator's
`documentInstanceId` (`data-branchkit-doc`, `render/hints.ts`) — the same
CS-context identity the pool re-key uses, with exactly the right lifetime
(same id across bfcache/prerender, new id per injection). The
`host-attribute-tracker` restores the stamp if a page sanitizer strips it
(it would otherwise read as stale).

`debug/pool-audit.ts` — the existing dev-build sweep — gains the paint half:
`countForeignBadgeHosts()` counts hosts stamped by a different context.
Report-only, same contract as the pool half:

- Periodic + boot + on-demand ticks WARN `BK_STALE_PAINT` with the foreign
  doc ids. Runs even with an empty store and even when the SW is asleep
  (pure DOM read).
- The harness on-demand payload carries `stale_hosts`/`stale_docs`;
  `assertClean` in the lifecycle-harness driver fails on `stale_hosts > 0`,
  so EVERY scenario (reload, bfcache, sw-restart, iframe, roundtrip) now
  asserts no-stale-paint for free.
- The debug snapshot's visibility block gains `foreign_badge_hosts`.

No new observer/timer/gate — rides the existing audit machinery (one-in-
one-out satisfied). No self-healing: a healer would mask exactly what
layers 2–3 need to see in the field.

## Layer 2 findings (2026-07-24, harness-proven)

The probe (`debug/bfcache-probe.ts` + `LIVENESS_QUERY` + the
`probeLivenessPortState` export) samples the channel from both ends at
restore and 2s later. First harness run, Chromium, reproduced on all three
restores (bfcache scenario + both A-restores in the roundtrip):

```
restore[ctx=ok port=post_ok sw=false] settled[ctx=ok port=post_ok sw=false]
```

**The silently-dead port state is REAL and is the deterministic outcome of
every bfcache restore:**

- CS-side, the port object still believes the channel is open
  (`postMessage` doesn't throw) — `onDisconnect` never fired and never
  will. The disconnect happened while the page was frozen and Chrome does
  not deliver it on restore.
- SW-side, the port is long gone (its `onDisconnect` ran at bfcache entry —
  established; it's why the restore reconfirm exists).
- 2s later: unchanged. **No self-healing** — the reconnect ladder lives in
  the CS's `onDisconnect` handler, which never runs.

Confirmed consequences:

1. **SW-restart resync is broken for every bfcache-restored page.** The
   resync path is triggered by CS-side port `onDisconnect`; a restored
   page's port is a zombie, so a later SW restart is invisible to it —
   grammar and pool ownership die silently on that page.
2. **The restored document's labels have no disconnect-driven release.**
   The restore reconfirm re-acquires labels for a doc whose release
   trigger (port disconnect) is already spent. When the restored doc
   finally dies, nothing releases them until the dead-tab sweep — widens
   the "dead frames in an open tab" v1 gap to every restored page.
3. **The stale-paint mechanism is confirmed as designed-in, not
   incidental**: an extension reload while a page sits in bfcache can't
   reach that page (its channel is already dead), so `onOrphan` can never
   fire → the page restores, repaints, and its badges are serviced by
   nobody. `ctx_valid:false` in a restore sample is that exact event
   (dataset-mirrored, since bkLog can't transmit from a dead context).

Fix direction for Layer 3 (not implemented — findings first): on restore,
drop the zombie port object and REOPEN the liveness Port (restore already
owns the reconfirm+republish work, so the reopen must not double-fire
onResync); if `chrome.runtime.id` is gone at restore, the page is an
orphan — `pageSession.teardown('orphan')` instead of repaint. A
reload-while-in-bfcache harness scenario would pin consequence 3.

Field evidence channel: the probe logs `BK_BFCACHE_PORT_PROBE` on every
real back/forward restore in dev builds — Firefox samples will come from
normal field browsing (harness bfcache is chromium-only; Firefox loud-skips
under automation).

## Layer 3 (2026-07-24) — both mechanisms shipped, one commit each

**Mechanism A — repair the channel** (`repairLivenessAfterBfcacheRestore`,
`plugin/liveness.ts`). On restore, reopen the Port — but only after the SW
confirms it isn't tracking this doc (LIVENESS_QUERY): never sever a
possibly-healthy channel, since a self-disconnect of a live port would fire
our own releaseDocument and race the restore reconfirm (the race class
doc-scoped ownership retired). Reopens with isReconnect=false — restore
owns the reconfirm+republish; the reopen buys the FUTURE (working
onDisconnect → next SW restart resyncs; labels regain disconnect-driven
release). Harness pin `assertChannelHealed`: the settled probe sample must
show port=post_ok sw=true — green on every restore, both scenarios.

**Mechanism B — dead context tears down instead of repainting**
(restoreFromBfcache, content.ts). If `chrome.runtime.id` is gone at
restore, the elder was orphaned while frozen and can never be serviced:
`pageSession.teardown('orphan')` and return. Timing is safe by
construction — the check runs synchronously in the pageshow dispatch,
before any successor CS could have painted, so the host sweep removes only
the elder's paint.

**Finding (CDP-named): Chrome flushes the bfcache on extension reload**
(`CacheFlushed`). The canonical reload-during-bfcache window therefore
CANNOT occur on Chromium — Back after a reload is a fresh load with a
fresh CS. The `bfcache-reload` scenario stays in the matrix as a named
permanent skip (re-engages if Chrome's behavior changes; validity-checked:
it loud-skips rather than passing vacuously if the orphan condition isn't
staged). Mechanism B stays as ~10 lines of defense-in-depth for the paths
the flush does NOT cover: Firefox extension reload (not automatable —
field evidence via the probe's ctx_valid:false samples + BK_STALE_PAINT),
the build-while-loaded wedge (extension dies with NO reload → no flush),
and crash/uninstall edges.

Consequence for the arc: the PAINT half's canonical Chrome window is
closed by the browser itself; residual exposure is Firefox + wedge paths,
now guarded by mechanism B and watched by the layer-1 tripwire. The
layer-2/3 substance on Chrome was the CHANNEL half (SW-restart resync +
label release), now fixed and pinned.

## Layer sequence (proposed 2026-07-24)

1. **Tripwire** (this) — soak in normal dev browsing; it names the real
   stale-paint mechanism instead of us guessing.
2. **bfcache-port probe** — deliberately answer sec-5's open question:
   instrument `restoreFromBfcache` to record Port + context state; harness
   bfcache scenario reads it. Report findings before fixing.
3. **Fix the paint half** — shaped by 1+2. Candidates: on restore, dead
   context → `pageSession.teardown('orphan')` instead of repaint; live
   context + dead port → reopen through the resync path. One mechanism per
   commit, each soaked per `SOAK_TEARDOWN.md`.
4. **Ownership consolidation** — Lift 5 (fold big observers; `quiesceOrphan`
   body → `teardownAll()`), Lift 3b (named-slot clear-reset timers), written
   contract for `onOrphan` → `pageSession.teardown` → hook;
   `preNavObserverTeardown` documented as nav-wedge preempt, NOT teardown.
   Gate the `__branchkit__force_teardown` affordance behind harness hooks.
5. **Unblocked round-3 lifts** — machinery-gate moves out with its guards;
   settle-fold re-evaluated (may stay rejected). Ratchet ceilings down.

Constraints throughout: one layer at a time, real-browser soak per layer
(green tests are insufficient — the 2026-06-02 lockup passed all of them),
the sendMessage throw stays, wedge guardrail stays green.
