# Tri-owner codeword sync — audit read after the pull-resolution payoff

Status: audit read, 2026-07-19. Read-only; no design decision made.

This is the audit-style read PLAN_RELIABILITY_CONSOLIDATION.md section 6 item 3
asks for: re-derive from current code what CS, SW, and plugin still own in the
codeword sync, now that the grammar-epoch handshake is deleted, hint dispatch is
sealed pull-resolution, and the label-sync mirror is display-grade
(DESIGN_STATIC_PAIR_GRAMMAR.md 0/0b/0c). Everything below was read from source
this session, not from the docs; where I could not verify, it says UNVERIFIED.

## 1. The sync surfaces as they exist now

### CS <-> SW

- **Label pool IPC** — `CLAIM_LABELS` / `CONFIRM_LABELS` / `RELEASE_LABELS`,
  single-sender = the reservoir (src/labels/label-reservoir.ts:29-63, enforced
  by label-ipc-isolation.test.ts). SW side is the per-tab
  free/reserved/assigned stack (src/labels/label-pool.ts:139, arbitrated
  confirm at label-pool.ts:242, owner-scoped release at label-pool.ts:304).
  **Dispatch-critical, and more so than before**: `getFrameForLabel`
  (label-pool.ts:333) is now the routing truth for every sealed hint dispatch.
  Owner: SW (arbitration), CS reservoir (local grant/latency).
- **GRAMMAR_BATCH** — label-sync delta state machine
  (src/labels/label-sync.ts, 606 lines: sentCodewords/pendingPuts/
  pendingDeleteCodewords, 80ms debounce + 400ms deadline, mass-claim fast
  path, pipelined chunks) → background.ts:1256 handler → `postGrammarBatch`
  (src/background.ts:821, letter<->spoken translation, conn_id stamp) →
  plugin `/grammar/batch`. Content is **display-grade** (feeds HUD menus and
  the strict companions); the batch ALSO carries two non-display roles noted
  in section 2. Owner: CS (truth), SW (transport + translation), plugin
  (derived sessions).
- **Frame-liveness Port** (src/background.ts:1696-1724) — lifetime-as-signal
  cleanup spine: `releaseFrame` (pool), frame-scoped `/hints/session_end`,
  codeword-memory eviction; `onResync` on the CS side re-confirms pool
  ownership then full-republishes (src/content.ts:2626-2644).
  **Dispatch-critical** (pool reclamation) + display healer.
- **Codeword memory** (Regime B) — SW-persisted fingerprint→codeword store
  (src/labels/codeword-memory.ts), CS recall/remember. Stability feature;
  orthogonal to sync truth. Not in scope for collapse.
- **Inbound action routing** — `translateInboundAction`
  (src/background/frame-router.ts:35-54): spoken→letter rewrite, and the
  sealed-path marker: when `prefix_letter`/`suffix_letter` are present it
  synthesizes the letter-token codeword; `routeFrameForAction`
  (frame-router.ts:199) looks it up in the pool; unroutable sealed pairs
  report `no_such_hint` through the dispatch-result channel
  (frame-router.ts:139-149, background.ts:298-310). **Dispatch-critical.**
- **Alphabet mirror** — voice alphabet in chrome.storage.local + SW-realm
  overlay (background.ts:200-221). Translation-grade; pool identity is fixed
  letters and never churns with it (label-pool.ts:114-121).

### SW <-> plugin

- **`/grammar/batch`** → per-source FrameSessions, focused-source projection,
  per-prefix `browser_hints_<word>` + `_strict` companions + prefix list
  (plugins/browser/src/batch.go, 1251 lines: admit/commit/project/rollback,
  30s stale-frame TTL sweep at batch.go:824). Consumers of the pushed
  collections today: Discovery HUD display sources only
  (collections.go:212-213, contribute.go:216-217). **Display-grade content;
  control-signal wrapper** (below).
- **`/hints/session_end`** — tab_switch/window_focus deprojects (sessions
  kept, bridge.go:651-656); tab close destroys; tab-wide end drops the hints
  tag (bridge.go:665-668). `/hints/session_start` now only ensures the
  command skeleton (bridge.go:672-693).
- **`/focus` + `/active-tab`** → focus recompute revives deprojected sessions
  and reprojects with zero extension traffic (focus.go:208-219).
- **SSE downstream** — action dispatch fan-out to the OS-focused browser's
  clients (sse.go:85, `sendToFocusedClientsLocked`) — **dispatch-critical
  transport**; capture-progress prefix forwarding as a synthetic `noop`
  (focus.go:520-559) — **display-grade narrowing** (badge dimming,
  content.ts:3372-3392); `reactivate` republish requests.
- **`/dispatch-result` / `/debug-log` / `/perf-report`** — observability.

### Plugin <-> actuator

- **`browser_alpha`** sealed alphabet collection (grammar.go:62-83) — the
  collection the sealed captures bind. **Match-critical, static** (changes
  only on alphabet swap). Layer 1 is grammar-seeded (`plugin.json`
  grammar_seeds: `browser_hints_*` → `alphabet`), so the engine grammar never
  tracks the viewport.
- **Sealed command specs** — bare activate + implicit multi-pair
  (collections.go:202-251), contributed `{hint}`/`{hint+}` verbs
  (contribute.go:158-228), `hint_pair` macro (plugin.json). Params carry
  letters + words only (`sealedHintFields`, collections.go:126-134) — no id,
  no frame_id.
- **`plugin.browser.hints` tag** (hint_gate.go) — the Layer-2 gate; without
  it sealed pairs fall through to the alphabet command. **Match-critical.**
- **Capture-progress subscription** (main.go:286) — the actuator emits
  generically for plain multi-slot captures
  (actuator/src/services/matching_service.rs:2184), so prefix narrowing does
  NOT depend on the pushed per-prefix collections.

## 2. What the payoff actually changed (verified)

- Sealed dispatches resolve pair→element at dispatch: SW pool routes the
  frame (frame-router.ts:211), the CS resolves codeword→wrapper from its own
  store/snapshot and enforces the live strict gate
  (content.ts:3140-3152, `sealedDispatchSeen` content.ts:1728). The epoch
  handshake is gone from both repos (only comments remain; label-sync.ts:302
  records the deletion).
- The grammar push retains exactly two non-display jobs:
  1. **Hint-gate arming.** The first batch of a scan arms the tag
     (batch.go:1033-1041); tab-wide session_end drops it. Matchability of
     every hint pair rides this, not the pushed content.
  2. **Calibration refusal + freed-letter ordering.** `calibration_active`
     refusals are real (label-sync.ts:272-300 retry pacing), and delete-
     before-reuse ordering (deletes ride batch 0, label-sync.ts:552-560)
     matters as long as per-prefix collections key on suffix words.
- **The surprise, against the plan's hypothesis:** the plan guessed "the SW's
  remaining role in the sync may have shrunk enough to collapse." The
  opposite happened. The SW's pool became the single dispatch-resolution
  authority (routing truth for every sealed pair); it is the PLUGIN half that
  shrank — from recognition-truth owner to display projector + tag gate +
  SSE transport. The collapse question is now mostly a plugin/batch-protocol
  question, not an SW question.

## 3. Vestigial or collapsible, with dependencies and risk

Ordered by confidence.

**(a) Dead residue from the epoch deletion — delete now, no risk.**
- `LabelSyncDeps.republishAll` is declared and injected
  (label-sync.ts:59-65, content.ts:527) but has no remaining caller inside
  label-sync (its sole consumer was the deleted epoch-mismatch recovery).
- Stale comments: "Epoch tripwire on the final chunk only"
  (label-sync.ts:533-534) now guards a plain reconcile; frame-router.ts:59-61
  still says "the relay drops grammar batches from non-active tabs" while
  background.ts:1270-1273 says the opposite ("No active-tab gate: every tab
  POSTs freely"); DESIGN_GRAMMAR_EPOCH_HANDSHAKE.md's status header does not
  record the 2026-07-19 deletion (the record lives in
  DESIGN_STATIC_PAIR_GRAMMAR.md and a label-sync comment).

**(b) The tab-switch wipe/republish cycle — the one structural candidate.**
On every tab activation in always-mode: `endHintSessionOnOldTab` +
`republishActiveTab` (background.ts:1776-1784) → CS `reactivate` → session
rotation + full re-Put of the whole wrapper store. But the plugin already
keeps backgrounded tabs' sessions and reprojects them on focus with zero
extension traffic (bridge.go:651-656, focus.go:208-219) — the republish is
content-redundant. What keeps it load-bearing is ONLY the hints tag: tab-wide
session_end drops the tag (bridge.go:665-668) and nothing on the
revive/reproject path re-arms it (grep: `transitionToGrammarOwned` fires from
batch arrival, browser-focus, calibration, voice_session_reset — not from
focus.go:214-215's revive), so the switch-back republish's first batch is
what re-arms matchability. Replacement: arm the gate from the focus-recompute
reproject when the revived projection is non-empty, then drop the per-switch
republish (or demote it to a relaxed-cadence HUD refresh). This is the
discovery-decoupling smell (state overloaded as control signal) landing in
one concrete spot. Risk: medium — it changes when matchability arms;
cross-repo (SW + plugin); verify with `just smoke` (matchable sweep) and the
ingest-transcript HUD loop. Not orphan-teardown class (no listener/lifecycle
changes), so normal sequencing applies.

**(c) Per-codeword grammar-ACK paint gating (`bk-pending`) — semantics
silently inverted.** `markGrammarReady` flips a badge opaque only on plugin
ACK (label-sync.ts:522-530, content.ts:2452-2460; `isPaintReady`
content.ts:1718). That gate encoded "translucent = voice not live for THIS
badge," which was true when match truth was the pushed collection. Under
sealed matching a painted badge is speakable the moment the hints tag is up —
the pair matches (any alphabet pair), the SW routes it (pool), the CS
resolves it (store) — with no push involved. The ACK now tracks HUD-menu
membership, which the translucency was never meant to signal. Depends on it
today: the badge paint path and the scan-path solidify logic only.
Replacement: connection-level readiness only (the `isBranchKitConnected` term
already exists), or drop the pending state entirely. Risk: low-medium — pure
UX semantics; keep the transport-failure keep-painted behavior
(label-sync.ts:473-491), which is independent and load-bearing.

**(d) Failed-Put detach — punishes a dispatchable badge.** A plugin-side per-
codeword failure detaches the wrapper (label-sync.ts:507-519; scan-path
rollback content.ts:2478-2483). Rationale was badge-implies-matchable; now a
failed Put costs a HUD-menu entry while the badge remains fully dispatchable.
Replacement: keep painted, log, let the next delta retry. Risk: low, but the
release accounting must stay correct (a detach releases the label back to the
reservoir; keeping the wrapper means the codeword stays held — that is the
correct new behavior, and the leak sweep at content.ts:563-576 backstops it).

**(e) Sync urgency machinery — retunable once (c) lands.** The mass-claim
fast path (label-sync.ts:316-330), the 80ms/400ms debounce+deadline pair, and
the parallel-chunk pipelining (round 29c) all exist to shrink the
paint→ACK translucent window and the match-truth staleness window. Both
consumers disappear with (c); the push can relax toward a HUD cadence. Do
this by loosening constants, not restructuring — the single-flight guard
(label-sync.ts:374) and delete-ordering stay regardless.

**(f) Per-batch `vocabulary.commit` — probable no-op, verify before
touching.** batch.go:964 schedules the debounced engine commit on every
batch with successes, but hint words are always alphabet members and
`browser_hints_*` is grammar-seeded to `alphabet`, so the desired union
should never change from hint churn. UNVERIFIED: whether the platform's
committed-vs-desired proxy (the vocab-lag tripwire seam,
/inspector/vocabulary) still wants the commit for bookkeeping even when the
word set is unchanged. Check the inspector during a scroll burst before
deleting; the 50ms debounce means the current cost is small either way.

**(g) The stale-frame_id reload bug (memory note, 2026-06-05) — class
structurally changed; verify then close.** The old path shipped
`{suffix.frame_id}` resolved at match time from pushed entries — a plugin-
held cache that went stale across extension reloads. Sealed dispatches carry
no frame_id at all; routing happens per-dispatch from the live arbitrated
pool, and `params.frame_id` only ever guarded the id-based resolution tiers
that were already dead weight (activate-resolution.ts:6-12, 72-80). After a
reload, SW init's `clearAllStacks` (label-pool.ts:409) resets the pool and
re-injected CSes claim fresh. The orphan-CS half of that note (stale CS
paints but can't receive) is a separate lifecycle problem and unchanged.
UNVERIFIED live — worth one deliberate reload test before editing the memory
note.

**Explicit keeps (not vestigial, do not fold into a collapse):**
- The reservoir and its confirm exchange, outstanding-dedup, and leak sweep —
  dispatch routing truth + claim latency; the single-sender invariant comment
  (label-reservoir.ts:29-63) is still exactly right.
- The pool's arbitration and owner-scoped release (cross-frame duplicate
  prevention) — dispatch-critical.
- The liveness Port cleanup spine and `clearAllStacks`/`sweepDeadStacks`.
- The calibration refusal retry (a real wholesale-refusal path).
- `sentCodewords`/pending-delete shadow — required at ANY push cadence to
  distinguish real deletes from never-sent.
- The three republish healers (sse_connect host-restart, sw_restart_resync,
  bfcache_restore — content.ts:2535-2546 triggers) — they heal pool confirms,
  the gate, and the HUD in one motion; only the tab-switch trigger (b) is
  redundant, and only after its gate-arm replacement exists.

## 4. Recommendation

A consolidation design note is warranted, but narrower than "collapse the
tri-owner sync." The sync did not survive as a bug factory — its
recognition-truth core is gone; what survives is one control-signal
entanglement (b) plus a layer of urgency/ACK machinery whose reason retired
with the payoff (c)(d)(e). Suggested scope for the note:

1. Land (a) immediately — dead dep + stale comments, no design needed.
2. The note's single structural decision: gate-arm decoupling (b) — arm the
   hints tag from the focus-recompute reproject, retire the per-tab-switch
   wipe/republish. This is the last place the mirror's freshness is a
   matchability input.
3. One follow-on layer, shipped separately: ACK demotion (c) + failed-Put
   keep-painted (d) + cadence relax (e). These are extension-local.
4. (f) and (g) are verification errands, not design items.

Explicitly NOT in scope: the reservoir/pool machinery (keeps list above);
anything the ratified accepted-miss ledger covers (first-paint occlusion,
partial occlusion, pointer-events:none covers, sub-250ms staleness — a
collapse must not be justified by fixing a ledgered miss); the live strict
dispatch gate and no_such_hint feedback (they ARE the new correctness layer);
orphan-CS teardown paths (per DESIGN_ORPHAN_CS_TEARDOWN_RETROSPECTIVE.md, any
change there ships one layer at a time regardless); and the full
display-mirror retirement, which PLAN_RELIABILITY_CONSOLIDATION.md section 6
item 5 already defers — this read confirms its three surfaces (HUD prefix
menu, HUD per-prefix strict menu, gate arming) and that badge-dim narrowing
is NOT one of them (it rides capture.progress, not the collections).
