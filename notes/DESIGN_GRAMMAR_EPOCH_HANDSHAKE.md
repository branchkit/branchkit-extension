# Grammar epoch handshake — level-triggered grammar convergence

Date: 2026-06-12
Status: Phases 0-2a IMPLEMENTED 2026-06-12. Phase 0 was already done by
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

Implications, in priority order:
1. Diagnose/fix why onResync (liveness reconnect → sw_restart_resync) no
   longer fires — likely the biggest voice-reliability bug currently live.
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
