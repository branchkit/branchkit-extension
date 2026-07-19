# Display-grade demotion follow-through — finish what the payoff started

**Status:** EXECUTED 2026-07-19, all three phases (user go; between-phase
soak deliberately forfeited per the push-forward posture — escape hatch is
per-phase git revert). Follow-on to REVIEW_TRI_OWNER_SYNC_2026-07-19.md.
Phase 0 = dead epoch residue (with-note commit). Phase 1 = derived hints tag
(plugin `focusedTabHasGrammarLocked` + active-tab derivation, plugin-side
tab-switch deproject) + SW retirement of per-switch session_end/republish;
the plugin keeps the session_end deproject branch as a no-op-compat path
while pre-phase-1 SWs are live. Phase 2 = bk-pending/grammarReady machinery
deleted end-to-end (badge paints solid; per-codeword ACK demoted to delta
bookkeeping), failed-Put keeps painted + requeues, cadence 80/400 →
250/1000ms, mass-claim fast path retired. **LIVE-VERIFIED 2026-07-19** (user, Firefox + Chrome, post-reload of the
new build): per-switch `session_end_tab_switch` traffic STOPPED at the
reload boundary; the derivation observed doing both halves
(`active_tab_derived` arms on kept-grammar switch-backs,
`active_tab_no_grammar` drops on empty/fresh tabs); sealed dispatches
activated correctly on post-reload fresh frames with zero `no_such_hint` —
which also CLOSES errand (g): the stale-frame_id reload class is dead
(memory note updated). Errand (f) CLOSED as KEEP
(2026-07-19): live logs show the union genuinely changes during browser/tab
churn (a −353/+353 swap on a browser switch, ±1-word tab-title churn), and
per-site attribution isn't establishable from logs — deleting the batch-site
commit risks the vocab-lag class to save a debounced no-op; rationale
comment at the batch.go schedule site. FOLLOW-UP LANDED same day (plugin):
tag-writer consolidation — browser_focus / voice_session_reset /
post_activate_re_put / active-tab all route through one
`applyDerivedHintsTag` (fixing the refocus-onto-empty-tab arm window);
rearmHintGate stays a pure arm edge (fires pre-commit, can't read the
projection it creates); the pre-phase-1 compat session_end branch deleted.

**One-line motivation:** the sealed pull-resolution payoff moved match truth
and dispatch routing off the grammar push, but the machinery that defended
the old arrangement still runs. This note removes it. Everything here is
deletion or demotion — one-in-one-out is satisfied by construction.

## The one structural decision: the hints tag becomes derived state

Today the `plugin.browser.hints` tag (matchability of every hint pair) is
edge-triggered: armed by the first batch of a scan (batch.go:1033), dropped
by tab-wide session_end. That coupling is the only reason the per-tab-switch
wipe/republish cycle (background.ts:1776-1784) is load-bearing — the plugin
already revives and reprojects backgrounded sessions with zero extension
traffic (focus.go:208-219), but nothing on that path re-arms the tag.

The fix is the same move the observed-state arc made for wrapper flags: stop
storing the conclusion, derive it. **The tag becomes a pure function of the
focused-source projection** — recomputed wherever the projection changes
(focus recompute, batch commit, session end/destroy): non-empty projection
with a connected focused source → tag up; empty or none → tag down. One
derivation point replaces two edge triggers, and the tab-switch republish
stops being a matchability input.

- Chrome-page / no-CS tabs fall out naturally: focus recompute finds no
  projection, tag drops.
- First scan on a fresh tab: batch commit makes the projection non-empty,
  the same derivation arms it — no separate batch-arrival trigger.
- Calibration's tag handling is untouched (its refusal path is a keep).

## Phases

### Phase 0 — dead residue (lands with this note, ext-local)

Per the review's item (a): delete the callerless `LabelSyncDeps.republishAll`
dep and its injection; fix the two stale comments (label-sync.ts epoch
tripwire wording, frame-router.ts active-tab-drop claim contradicted by
background.ts:1270); stamp DESIGN_GRAMMAR_EPOCH_HANDSHAKE.md's status header
with the 2026-07-19 deletion so the record lives where a reader looks first.

### Phase 1 — gate-arm decoupling (cross-repo: plugin + SW)

1. Plugin: extract a single `recomputeHintsTag(source)` derivation and call
   it from focus recompute, batch commit, and session end/destroy paths;
   delete the batch-arrival arm and the session_end tag drop as independent
   writers.
2. SW: retire `endHintSessionOnOldTab` + `republishActiveTab` on tab
   activation (background.ts:1776-1784). Tab switches become
   deproject/reproject only — no CS traffic, no wrapper-store re-Put.
3. The three non-tab-switch republish healers (sse_connect, sw_restart_resync,
   bfcache_restore) stay — they heal pool confirms and the HUD, not just the
   tag.

Risk: medium — this changes when matchability arms. Not orphan-teardown
class (no listener/lifecycle changes). Verify: `just smoke` matchable sweep
across tab switches (hint pairs eligible on the refocused tab without a
republish), the ingest-transcript HUD loop, and a chrome://-page switch
(tag drops). Ship alone; soak in daily use before Phase 2.

### Phase 2 — ACK demotion layer (ext-local, one commit)

Review items (c)+(d)+(e), shipped together because they share one rationale
(the ACK no longer means speakable):

- `bk-pending` translucency keys on `isBranchKitConnected` only; the
  per-codeword `markGrammarReady` gate and scan-path solidify logic go.
  Transport-failure keep-painted behavior stays (independent, load-bearing).
- Failed-Put keeps the wrapper painted (log + next-delta retry replaces
  detach). The codeword stays held by the wrapper — correct under sealed
  dispatch; the leak sweep backstops accounting.
- Urgency constants relax toward HUD cadence (loosen the 80ms/400ms pair,
  drop the mass-claim fast path) — by constant tuning, not restructuring.
  Single-flight guard and delete-before-reuse ordering stay.

Risk: low-medium, pure UX semantics + cadence. Watch: HUD menu staleness
during scroll bursts (menus may trail by the relaxed cadence — acceptable,
they are display).

### Verification errands (no design, any time)

- **(f)** Watch `/inspector/vocabulary` during a scroll burst: confirm the
  per-batch `vocabulary.commit` never changes the desired union (hint words
  are alphabet members). If confirmed no-op, delete the batch.go:964
  schedule in Phase 2's commit; if the committed-proxy bookkeeping wants it,
  keep and note why inline.
- **(g)** One deliberate extension reload: verify sealed dispatches route
  correctly to fresh frames (no frame_id in params; pool reset + fresh
  claims). On pass, close the 2026-06-05 stale-frame_id memory note's
  dispatch half (the orphan-CS paint half is separate and unchanged).

## Not in scope

Copied from the review so this note is self-contained: reservoir/pool
machinery and the confirm exchange; the liveness Port spine; calibration
refusal retry; the sentCodewords/pending-delete shadow; the live strict
dispatch gate and no_such_hint feedback; anything the ratified accepted-miss
ledger covers; orphan-CS teardown paths (one layer at a time, always); full
display-mirror retirement (PLAN section 6 item 5, still deferred — after
this note lands, its remaining surfaces are the two HUD menus only).
