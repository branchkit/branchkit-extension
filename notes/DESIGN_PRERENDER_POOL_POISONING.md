# Prerender pool poisoning — phantom-frame reservations wedge voice on fresh tabs

**Status:** designed + implemented 2026-07-24, same day as the field diagnosis.
Root-caused live during the round-3 soak (a wedged AW pair on a fresh
Wikipedia tab). Pre-existing — the confirm-rejection storms go back through
every retained log segment (at least 2026-07-16) — but sealed pull-resolution
(2026-07-18/19) silently upgraded its severity: with the broadcast fallback
gone, an unconfirmed label is no longer "routes suboptimally," it is
**permanently unspeakable**.

## 1. The field evidence (2026-07-24, tab 148767678)

- CS (top frame, frame 0) painted 33 pair badges incl. `a w`; grammar reached
  the plugin (voice MATCHED "air"→"wave" and dispatched correctly).
- SW pool for the tab: `assigned` held THREE labels (frame 0);
  **`a w` — and nearly the CS's whole painted set — sat in `reserved` under
  frame 4241**, a frame id with no live document.
- Every dispatch: `resolved=none → no_such_hint`. Retries identical; no new
  claim traffic. Wedged until tab reload.
- 1s after CS boot: an 18-burst `BK_CONFIRM_REJECTED` storm — frame 0's
  confirms correctly rejected by arbitration ("another frame owns it").
- The same signature exists on most open tabs: exactly one large reservation
  block under one nonzero frame id (705, 3784, 4199, 4228, 4241, 4254 …)
  that nothing ever releases.

## 2. Mechanism

Chrome **prerenders** navigations (omnibox preload and friends). The content
script boots inside the prerendered document, whose sender carries a
**provisional nonzero frameId**. Its reservoir warm-up claims a block —
the pool records `reserved[label] = 4241`. On activation the same JS context
becomes the tab's top frame (frameId 0) and keeps its local label cache;
wrappers take labels from that cache and the reservoir confirms them — now as
frame 0. Arbitration compares `reserved[label] === 0`? No — 4241. Rejected,
every one.

Three structural gaps then compound it into a permanent wedge:

1. **No reaper for the phantom.** `releaseFrame` (liveness Port disconnect)
   DOES reap a dead frame's reservations — but a prerendered document that
   activates never dies; frame id 4241 simply stops being anyone's sender.
   Its reservations leak until tab close.
2. **Non-convergent recovery.** The confirm-rejection handler strips the
   wrapper and re-claims — but the reservoir re-grants from the SAME
   poisoned local cache (only the specific rejected strings are purged per
   round). The strip/re-grant/reject cycle burns down some labels and stalls,
   leaving wrappers holding labels the pool will never assign to them.
3. **No fallback under sealed dispatch.** Pre-2026-07-18, unconfirmed labels
   routed via broadcast — the bug was invisible. Sealed pull-resolution made
   pool assignment the only routing truth; unroutable now reports
   `no_such_hint` and executes nothing. (This is the pull-resolution
   feedback WORKING — the failure used to be silent.)

## 3. The fix — three layers, all widenings of existing machinery

Per the one-in-one-out sensing freeze: no new observers, timers, or CS
listeners. L1 widens the SW's existing message gate; L2 widens the claim
path; L3 widens the existing rejection handler.

**L1 — deny pool mutations from prerender-lifecycle senders (root).**
`chrome.runtime.MessageSender.documentLifecycle` names the sender's state.
CLAIM_LABELS from a `prerender` document returns an empty grant and never
touches the pool; CONFIRM_LABELS from one is ignored (nothing to arbitrate —
it was never granted). No CS-side change: after activation the existing
level-triggered machinery (IO claims, settle passes, idle backstops) retries
claims with the real frame 0 sender and converges. A prerender that never
activates costs nothing (it never held labels).

**L2 — reservation TTL: claims may steal stale reservations (reap).**
Reservations get a timestamp (`reservedAt`, lazily migrated; missing stamps
grandfather to now). When a claim's pass-2 exhausts `free`, it may steal
reservations older than 5 minutes. Stealing is safe by construction: if the
original owner ever confirms a stolen label, arbitration rejects it and the
owner's strip-and-reclaim recovery (now convergent per L3) replaces it. This
also reaps the OTHER leak source observed in the wild: short-lived iframes
(warmup pages, hovercards) whose reservoirs die pre-confirm during an
SW-asleep window.

**L3 — poisoned-cache flush on rejection (converge).**
Any confirm rejection means the local cache's provenance is suspect (the
pool granted those strings to a different identity). The reservoir drops its
entire unconfirmed free-list — releasing it owner-scoped (poisoned strings
are ignored by the pool's owner check; legitimately-ours strings return to
free) — and refills fresh. One rejection round now fully re-homes a
poisoned frame instead of grinding through partial purges.

## 4. What we deliberately do NOT do

- No CS `prerenderingchange` listener — L1's SW-side deny plus existing
  level-triggered convergence covers activation without new machinery.
- No liveness-port live-frame registry in the SW (the "is this frame alive"
  oracle) — the TTL steal achieves the reap without new state to maintain.
- No change to arbitration strictness — confirms still reject on owner
  mismatch; that check caught this bug and is load-bearing against
  cross-frame duplicates.
- No restoration of broadcast fallback — sealed dispatch's no-fallback is
  the correctness layer; the fix is making labels' provenance sound, not
  softening routing.

## 5. Sibling hole, found hours later: bfcache restore never re-asserted the pool

Field failure the same afternoon (post-fix): activate → "go back" → the
restored page's pairs all `no_such_hint` while pre-navigation pairs clicked
fine. Same disease class, different door:

- Entering bfcache closes the document's liveness Port; the SW's
  onDisconnect runs `releaseFrame`, freeing every label the page held.
  `restoreFromBfcache`'s comment claimed "pool claims survive bfcache" —
  written when the pool lived only in storage.session and before the
  Port-disconnect release existed. False for a long time; broadcast
  fallback hid it.
- On restore, the grammar republish healed the plugin side but nothing
  re-asserted the pool. `reconfirm` was wired only to the SW-restart resync
  (and no Port disconnect is delivered to a restoring page, so that path
  never fires here).

**Fix:** `restoreFromBfcache` now reconfirms every held codeword — twice.
The double-shot exists because the OUTGOING page's own port-disconnect
release carries the same frame id (documents in a tab share frame 0; the
pool cannot distinguish document generations) and races the restore: if its
release lands after our first reconfirm, it wipes the re-assertion. A second
idempotent reconfirm 1.5s later heals a lost race.

**Acknowledged deeper issue (not fixed here):** pool ownership is keyed by
(tab, frame) while lifetimes are per-DOCUMENT. Both this hole and the race
above stem from that identity gap; the clean fix is port-scoped (document-
generation) ownership. Deferred — the reconfirm exchange is self-correcting
and the pull-model tolerates transient divergence; revisit if the soak
shows residue.

**Open question:** whether a bfcache-restored page's liveness Port is live
CS-side (no disconnect was delivered at restore in the field logs). If it
is silently dead, SW-restart resync is also broken post-restore. Needs a
deliberate probe; tracked here rather than guessed at.

## 6. Verification

- Unit: pool spec — prerender-sender helper denies; TTL steal (fresh
  reservations safe, stale stolen, stamps migrate); reservoir spec —
  rejection flushes the unconfirmed cache and releases owner-scoped.
- Field: after deploy, `BK_CONFIRM_REJECTED` storms should collapse to rare
  single events (a genuine race), and the omnibox-navigation repro (type a
  URL, let it prerender, speak a pair) should route first try. The
  `no_such_hint` dispatch-result remains the tripwire if any residue
  survives.
