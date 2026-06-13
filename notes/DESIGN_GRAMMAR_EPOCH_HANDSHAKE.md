# Grammar epoch handshake — level-triggered grammar convergence

Date: 2026-06-12
Status: Phases 0-2b IMPLEMENTED 2026-06-12 (2b landed in the follow-up
session after the dual-CS race closed — see "Phase 2b LANDED" below).
Remaining: 2b soak telemetry, then Phase 3 (trigger retirement on
evidence) and Phase 4 (CONFIRM fold).
Earlier status trail: Phases 0-2a same day. Phase 0 was already done by
parallel sessions (calibration refusal handling + evicted-field deletion).
Phase 1 live (plugin emits epoch, golden vectors pinned both sides, epoch on
the batch log line). Phase 2a live detect-only with a QUIESCENCE GATE added
on first-smoke evidence: scan/sync/strict traffic interleaves by design, so
the comparison only runs when no other batch is in flight and nothing is
queued (skippedBusy counts the rest).
FIRST CATCH + 2b BLOCKER: in a fresh-profile harness the tripwire exposed a
REAL pre-existing dual-CS boot race — two content scripts in one frame
(manifest injection racing the SW's programmatic inject; cs=2 in the
page-world bridge), each with its own session id, thrashing the plugin's
per-frame session (epoch=0 resets as C7 cleanup flips between them).
Mismatches there are true positives. Phase 2b (acting on mismatch) is
BLOCKED until the install-time dual-injection race is fixed — two CSes
would ping-pong republishes. Long-lived single-CS tabs are unaffected.

## Tripwire catch #2 (2026-06-12 evening): the resync trigger has rotted

Production evidence from the 2a soak, chased via browser.log +
actuator.log:

- The plugin wipes frame sessions on `frame_liveness_disconnect`
  MULTIPLE TIMES PER MINUTE on active tabs — MV3 service-worker idle churn
  drops every liveness Port each time the SW unloads.
- `BK_GRAMMAR_REPUBLISH {reason: sw_restart_resync}` has not fired since
  13:42 despite that churn — the enumerated trigger that exists for exactly
  this case is silent. Some healing arrives via the `reactivate` path
  (BK_SESSION_ROTATE without republish breadcrumbs), but it races the next
  wipe: same frame cleaned seconds apart with different session ids
  (cleared=51, then 53...).
- Net state: the plugin's per-frame grammar oscillates between wiped and
  partially-repushed subsets while the CS shadow holds the full set — the
  persistent bouncing mismatches (shadow 306 vs plugin 170/172/157...).
  Badges look fine (paint is CS-local); VOICE matching on those tabs is
  silently degraded much of the time. The triggers did not catch it; the
  tripwire did, within hours.

DIAGNOSIS COMPLETE (same evening): onResync is INNOCENT — it worked in
perfect lockstep all morning (disconnect = reconnect = republish, 3252
firings) and went quiet only because the SW stopped restarting after ~13:42
(kept alive by something; not itself a bug). The real defect is the
TAB-SWITCH WIPE / REFOCUS DELTA ASYMMETRY:

- On tab switch the SW posts session_end(tab_switch) and the plugin's
  cleanupFrameSessionLocked EMPTIES session.Codewords in-place
  (bridge.go:511 → batch.go cleanup; log: session_end_tab_tab_switch
  cleared=284).
- On switch-back the refocus path is a DELTA sync against an intact CS
  shadow → empty delta → nothing re-pushed. The plugin re-accumulates only
  strict-crossing re-puts — the scrolled-through subset (the observed
  plugin≈170 vs shadow≈306).
- Every tab switch therefore leaves most of the tab's codewords VOICE-DEAD
  until an unrelated full rotation heals it. The morning's constant
  SW-restart republishes masked the hole; when they stopped, it became
  permanent and the tripwire lit up.
- This contradicts the Option B read-time focused-source projection design
  (sessions kept, collections re-projected on focus): the destructive
  tab_switch wipe looks like a pre-Option-B remnant. Design-correct fix:
  de-project on tab switch (the SweptStale keep-but-deproject pattern)
  instead of emptying session state. Plugin-side; coordinate with the
  session that owns clearHintsState/sweeper work.

Implications, in priority order:
1. Fix the tab-switch wipe → de-projection (above). onResync needs nothing.
2. This is the strongest possible case for 2b: a level-triggered
   epoch_mismatch republish heals every variant of this without anyone
   enumerating SW lifecycle cases. 2b stays gated on the dual-CS install
   race fix, which is therefore promoted too.
3. The mismatch breadcrumb needs tab/frame/url context (current lines
   can't be attributed to a frame without cross-referencing) — add before
   the next soak round.
4. Latent, separate: a partially-failed per-prefix sync can leave the
   ACTUATOR collection missing entries that both session map and shadow
   still hold — invisible to the epoch (it compares CS↔plugin, not
   plugin↔actuator). Park for the bug list.

## Dual-CS race: lab repro + partial fix (2026-06-12 night)

REPRODUCED DETERMINISTICALLY: fresh-profile install + slow streaming page
(local fixture, body trickles ~2.5s) → 5/6 tabs boot TWO content scripts,
~25ms apart, both at document_idle. Mechanism: the SW's lazy injection
(issued mid-load, deferred by executeScript to document_idle) lands
back-to-back with the manifest script, and on Firefox the two run in
SEPARATE SANDBOXES — the window-expando idempotency guard is invisible
across them.

Fix landed (partial): the guard is now a `data-branchkit-cs` attribute on
documentElement (shared across sandboxes/worlds), with an aborted-marker on
the page-world bridge. It demonstrably catches duplicates the expando could
not (repro shows boot+ABORT pairs) — but most repro tabs STILL dual-boot,
the second copy blind to an attribute set ~17ms earlier in the same frame.
Open question: does Firefox hand the late executeScript copy a stale
document reference (injection queued against the pre-navigation document),
or is there an Xray/attribute-visibility subtlety? Next diagnostic:
provenance-mark each copy (manifest vs injected) and record
document.documentElement identity/readyState at guard time.

## Dual-CS race CLOSED (2026-06-12, follow-up session): the flush was the killer

Diagnosis (flush/boot/abort markers on the page-world bridge +
`scripts/_test-dual-cs-race.mjs`, the streaming-fixture repro promoted to a
tracked acceptance gate): NEITHER open question was real. Attribute
visibility was reliable in 30/30 instrumented tabs — every abort correctly
saw a guard set ~20ms earlier in the same frame, killing both the
stale-document and Xray hypotheses. The actual mechanism: on a
still-loading page, `flushOrphanGuard`'s executeScript (issued ~1s in,
after the ping ladder fails against a manifest CS that hasn't run yet) is
DEFERRED to document_idle — the exact convergence point of the manifest
boot and the queued injection. The bridge timeline is always
`flush → boot(+1-3ms) → second copy(+~20ms)`; scheduler order around the
manifest boot picks the outcome:
- flush first → injected copy boots, manifest copy ABORTS (a wasted full
  inject+abort cycle per fresh tab — every tab on this machine's timing);
- flush in between → it DELETES the manifest script's just-set guard and
  the injection boots a second live CS. This is the "blind to a 17ms-old
  attribute" state: the attribute wasn't invisible, it was gone.
flushOrphanGuard is the only guard-deleter in the system; ping-failure
means "didn't answer", not "orphan" — a healthy CS mid-init fails pings
too. The flush's correctness assumption was unsound on any loading tab.

Fix (commit 3bcf51f), two layers:
1. **Status gate (prevention).** `ensureContentScriptInjected` bails while
   `tab.status === 'loading'`: a loading tab's manifest CS is guaranteed
   to arrive at document_idle and a fresh document cannot carry a stale
   guard, so there is nothing to recover; `onUpdated{status:'complete'}`
   re-enters for genuine orphans/pre-existing tabs (which are never
   'loading').
2. **Guard keeper (level-triggered invariant).** The CS re-checks the
   guard attribute every 2.5s: missing → reclaim (a flush hit a live
   script; the queued sibling injection then aborts on the restored
   guard); foreign id → self-quiesce (TeardownReason 'superseded' — elder
   yields, exactly one survivor either way); dead context → quiesce, never
   reclaim (an orphan must not strand its successor). Converges ANY dual
   interleaving — including ones not yet discovered — to a single CS,
   mirroring the level-triggered posture of the reconciler and of this
   handshake itself.
Ride-along: the guard value is now the instance cs_id, so abort/flush
markers carry ownership and quiesceOrphan releases only its own guard.

Gate result: 30/30 tabs single-boot, zero flushes, zero aborts, across
25-chunk (~2.5s) and 10-chunk (~1s, load completing exactly at the ping
ladder's decision point) stream profiles. **2b is UNBLOCKED.**

## Phase 2b LANDED (2026-06-12, same session)

`checkGrammarEpoch`'s mismatch branch now acts: a confirmed quiescent
mismatch fires `republishAllGrammar('epoch_mismatch')` through a new
`LabelSyncDeps.republishAll` seam (content.ts wires the same hoisted body
the enumerated triggers call). The enumerated triggers stay (decision 4).

Loop guards (decision 5, one refinement): 5s cooldown between acts, and the
"per-page cap" is implemented as a CONSECUTIVE cap — 3 republishes with no
clean check in between → stop acting, go loud (`BK_GRAMMAR_EPOCH_CAP` +
`grammar_epoch:cap_exhausted` firehose breadcrumb), keep detect-only
logging. Any clean check resets the cap (`BK_GRAMMAR_EPOCH_CAP_CLEARED`).
Rationale for the refinement: a never-resetting per-page counter would
silently disable healing on long-lived tabs after a handful of legitimate,
days-apart heals — the cap's purpose is to bound a republish→mismatch
ping-pong, which is by definition consecutive. `republishes`/`capExhausted`
ride the perf snapshot via `grammarEpochStats`.

Verification (per the section below):
- tsc + 768 unit tests (new: act-on-mismatch, cooldown suppression,
  consecutive cap + loud flag + reset-on-clean under a fake performance
  clock). Wedge repro green twice. Classify sweep: discoveryGap=0,
  claimGap≤1 across the sweep. Coverage fixture (now tracked:
  `scripts/_test-coverage-curve.mjs`): interleaved A/B against the pre-2b
  build — load t95 within mutual noise (base 628/262ms vs head 404/705ms);
  earlier 1.8-2.8s outliers were machine load, not the change.
- LIVE, ORGANIC: during the verification runs browser.log captured real
  heal cycles — `BK_GRAMMAR_EPOCH_MISMATCH` → `BK_SESSION_ROTATE` →
  `BK_GRAMMAR_REPUBLISH {reason: epoch_mismatch}` → silence (converged;
  later quiescent checks pass) on both YouTube and the local fixture. The
  A/B's base-arm (2a-only) runs logged lone unhealed mismatches in the same
  window — an accidental detect-only control group.
- Live repros (`scripts/_test-epoch-live-repros.mjs`, tracked): bfcache
  back/forward green (badges stable, single boot, zero aborts, no late
  mismatch). Scripted extension-reload is NOT reachable under Playwright
  (about:debugging is privileged; the juggler connection hangs/closes) —
  the script self-reports that phase skipped; reload coverage = the status
  gate's unit tests + the dual-CS gate + the live soak. SW kill is
  Chrome-specific and likewise soak-covered.

TRIPWIRE CATCH #4 (found during 2b verification): the coverage fixture's
content swap (400 links replaced in place) deterministically leaves the
SHADOW larger than the plugin (e.g. shadow 208-263 vs plugin stuck at 188,
plugin hash stable across runs) — the inverse of catch #3's response-loss
ghosts: sentCodewords retains entries for wrappers that died without their
deletes landing. Parked with catch #3 on the bug list; 2b heals both (the
observed organic republishes above ARE this specimen healing). Repro:
`scripts/_test-coverage-curve.mjs`, watch browser.log during the swap
phase.

## Tripwire catch #3 (2026-06-12 night): response-loss ghost entries

Post-fix residual mismatches show the INVERSE signature — plugin LARGER
than shadow (417 vs 404, stable hash) on a tab whose batch trail is clean
(one session, zero deletes, no C7 churn, iframes correctly framed). The
delta is batches whose REQUEST the plugin applied but whose RESPONSE never
reached the CS (SW message round-trip lost): postBatch's catch synthesizes
`failed: sendMessage_failed` for every element, so the CS detaches those
wrappers (badges gone, shadow never updated) while the plugin keeps their
session entries and grammar — GHOST entries: voice-matchable codewords
bound to nothing. Classic apply-then-lose-ack asymmetry; the synthetic-
failure path treats "response lost" as "request not applied", which is the
one thing it cannot know.

Disposition: Phase 2b heals this structurally (the next quiescent epoch
mismatch republishes; rotation wipes the ghosts). A targeted fix (e.g.
idempotent batch ids so a retried batch can reconcile, or treating
transport failure as unknown-outcome and re-verifying instead of
synthesizing failure) is heavier than the value once 2b exists — park
unless ghost activations get reported. Tally for the day: the tripwire's
three catches are the dual-CS install race, the tab-switch wipe (fixed,
b73d9a2), and this.

## The disease, restated

The content script's delta-sync shadow (`sentCodewords`, label-sync.ts) and
the plugin's per-frame grammar can silently diverge, and every divergence
class found so far was patched with another enumerated edge trigger:

- `republishAllGrammar('sw_restart_resync')` — liveness Port reconnect after
  a SW restart (the plugin wiped the frame on disconnect; the shadow still
  believes everything is live).
- `republishAllGrammar('bfcache_restore')` — navigate-away ran purgeTab,
  then the frozen V8 context (shadow and all) came back.
- The plugin's `sse_connect` → `reactivate` push (sse.go:219) — plugin
  restart/reconnect wiped collections under a live shadow (the
  "painted hint not matchable" delta-desync, fixed 2026-06-01).

Each trigger is correct; the *pattern* is the same edge-triggered
enumeration the unified reconciler just cured for badge state. The next
desync class (and review bug #2 is already one: `calibration_active`
returns an empty response after `syncNow` drained the puts, so painted
badges stay unmatchable with no trigger to heal them) waits for a user
report and a new trigger.

## The handshake

Every `GrammarBatchResponse` (batch.go:329) additionally carries the
plugin's post-batch view of this frame's grammar:

```
epoch: { count: number, hash: string }
```

- `count` — live per-prefix entries for (tab, frame) across prefixes.
- `hash` — order-insensitive digest of the codeword set (XOR of FNV-1a of
  each codeword string; cheap, incremental, no sort). Membership only —
  flags like `in_strict_viewport` converge via the settle pass and are
  deliberately excluded.

The CS computes the same digest over its `sentCodewords` shadow when it
processes the response. Match → nothing (zero cost beyond the digest).
Mismatch → the existing recovery, made level-triggered:
`republishAllGrammar('epoch_mismatch')` — rotate session, full re-Put —
behind a cooldown so a persistent disagreement can't loop republishes.

Any desync, known or future, now self-heals within one batch round-trip of
the next sync, instead of waiting for its class to be discovered, named,
and wired to a trigger.

## Decisions

1. **Membership, not flags.** The digest covers codeword strings only.
   Strict/occlusion flags are owned by the settle pass; folding them in
   would make every scroll settle a "mismatch".
2. **Check on the last batch of a sync run only.** A chunked sync posts N
   batches; intermediate responses describe a half-applied state by
   construction. The CS compares epochs only on the final chunk (the
   plugin's response already includes that batch's effects, so a healthy
   run matches exactly).
3. **Detect first, act later (the Phase-C pattern).** Phase 2a ships the
   comparison as a tripwire — breadcrumb + counter on mismatch, no
   reactivate — and soaks. Phase 2b flips it to acting. The shadow-diff
   discipline caught nothing wrong in the reconciler arc precisely because
   the sim was verified before it drove anything; the same caution applies
   to a trigger that can emit full republishes. (Lesson from the toClaim
   revert: also gate on the coverage fixture — convergence *timing* is a
   first-class acceptance criterion now, not just end-state correctness.)
4. **Fast-paths stay until proven redundant.** The three enumerated
   triggers keep firing through 2a/2b; telemetry shows whether the
   handshake would have caught each firing. Delete them (or demote to
   comments) only on that evidence — mirror of the reconciler's
   IO-fast-path decision.
5. **Loop guard.** `epoch_mismatch` reactivates carry a cooldown
   (~5s) and a per-page cap with a firehose breadcrumb; a mismatch that
   survives a full republish is a real bug we want loud, not a silent
   republish storm.

## Phases

**Phase 0 — ride-along bug fixes (independent, land first).**
- Review bug #2: `calibration_active` drains puts without re-queue —
  mirror the deletes' restore-on-failure (label-sync.ts:186-189) for puts.
  The handshake would also heal this, but eventually-correct is the
  backstop, not the mechanism.
- Review bug #3: delete the dead `evicted` response field (both repos) —
  we are touching this wire anyway.

**Phase 1 — plugin emits the epoch (additive).** batch.go computes
{count, hash} from the per-frame state it already holds and attaches it to
every response. Golden-vector hash tests in Go.

**Phase 2a — CS compares, tripwire only.** Same digest over
`sentCodewords` (golden vectors shared with Go via a fixture file);
compare on final-chunk responses; mismatch → breadcrumb
(`grammar_epoch:mismatch`) + counter on the perf snapshot. Soak.

**Phase 2b — mismatch acts.** `republishAllGrammar('epoch_mismatch')`
behind the cooldown/cap. The three enumerated triggers stay.

**Phase 3 — retire redundant triggers.** Evidence-driven per decision 4.

**Phase 4 — fold CONFIRM into the claim exchange (review bug #5).**
CONFIRM_LABELS is fire-and-forget after CLAIM, so a RELEASE racing ahead
of CONFIRM leaves the SW pool free to hand the codeword to another frame.
Folding the confirm into the CLAIM_LABELS response path makes
claim+confirm one exchange. Separate wire (reservoir ↔ SW pool, not the
grammar batch), separate risk profile — its own commits, possibly its own
note if the reservoir reading surprises.

**Phase 4 LANDED (2026-06-12). The reservoir reading DID surprise — the
literal fold is a regression.** Assigning at CLAIM_LABELS (refill) time is
exactly the pre-PR-6 design that the reserved/assigned split replaced:
iframe reservoirs accumulated phantom ownership of codewords no wrapper
used and voice routing landed there (the QuickBase `fine jury` failure,
2026-06-05T17:18:37 — recorded in types.ts's LabelStack doc). And the
confirm cannot ride the refill exchange either: local grants are
synchronous and mostly don't coincide with a refill.

What ships instead — **confirm becomes the arbitrated exchange**:
- SW `confirmLabels` answers `{rejected}` per label: `reserved[frame]` →
  promote (unchanged); `assigned[frame]` → idempotent no-op; **in `free` →
  acquire directly** (the released-then-locally-reclaimed case that was a
  silent no-op — the hole that left the codeword free for another frame
  while this frame's wrapper held it); reserved/assigned to another frame
  or unknown string → **rejected**.
- The reservoir purges rejected codewords (outstanding/reserved/free) and
  hands them to a content-layer hook; the holding wrapper drops the
  codeword WITHOUT a RELEASE (releasing would free the winner's
  assignment), retracts its grammar entry (`queueDelete` +
  `scheduleSync('confirm_rejected')`, breadcrumb `BK_CONFIRM_REJECTED`),
  and the level-triggered reconcile claims it a fresh one.
- Net: the pool converges to exactly one owner per codeword under every
  interleaving — first-confirmer wins, the loser yields deterministically.
  The cross-frame duplicate class (review bug #5) is closed at the
  arbitration point rather than narrowed by dedup sets. The reservoir's
  `outstanding` dedup stays: it still covers the in-flight-confirm window
  against a concurrently-processed refill.

Verification: 776 unit tests (new: pool acquire-from-free, cross-frame
reject + single-owner convergence, unknown-string reject, idempotent
re-confirm; reservoir confirm-exchange send, rejected purge + handler
hand-off, outstanding-purge-enables-refill, malformed-response no-op).
Wedge green. Live bfcache gate green against the new exchange (badges
painting = confirms succeeding end-to-end).

## Cross-repo shape

Phases 1+ touch `plugins/browser` (Go, closed) and the extension. Additive
field first (plugin), consumer second (extension) — the standard
dependencies-first commit order; no version coupling because absent
`epoch` simply disables the check. Parallel-session caution applies to
plugins/browser.

## Verification

Per phase: tsc + both unit suites + wedge + classify sweep + the coverage
fixture (timing gate). End-to-end: the three live desync repros — extension
reload, SW kill (chrome://serviceworker-internals), bfcache back/forward —
each must show the mismatch breadcrumb in 2a and self-heal in 2b. The
grammar-churn discipline check rides the cooldown telemetry (zero
mismatches in steady state). Optional rider: reviving
`_test-live-churn.mjs` (rotted against the current plugin pipeline) would
directly exercise this wire; it is on the harness-promotion chore list.

## Out of scope

- Review bug #6 (dormant-iframe TTL lingering + silent SSE channel drops)
  — adjacent plugin-side hygiene, separate change.
- Multi-tab/browser grammar projection (owned by the focused-source
  projection design).
- The standing claim backstop (toClaim apply) — benched with its own data;
  unrelated wire.
