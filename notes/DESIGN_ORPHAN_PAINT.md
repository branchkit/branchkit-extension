# Orphan-CS paint — the arc, the tripwire, the probe

Date: 2026-07-24
Status: Layer 1 (orphan-paint tripwire) implemented. Layers 2+ pending.

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
