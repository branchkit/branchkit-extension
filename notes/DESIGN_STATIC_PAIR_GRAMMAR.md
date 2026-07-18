# Static Pair Grammar — stop syncing the viewport into the recognizer

**Status:** RE-SCOPED 2026-07-18 after the platform investigation below. Phase
3 of PLAN_RELIABILITY_CONSOLIDATION.md. The Layer-1 half of this proposal
turned out to be ALREADY IMPLEMENTED by the platform's DAG compiler; the
remaining design is Layer-2 only (match-time resolution). Cross-repo (browser
plugin + extension; actuator untouched).

**One-line motivation:** the recognizer only ever needs 26 words. Everything
downstream of "the grammar must track the viewport" — the vocab-lag class, the
50ms commit-debounce starvation, decode-empty confusion, and most of the
delta-mirror bookkeeping in `labels/label-sync.ts` (843 lines) +
`label-reservoir.ts` (479) + the grammar-epoch handshake — is complexity spent
keeping three owners agreeing about a set that could be static.

---

## 0. Investigation findings (2026-07-18, live grammar export + compiler read)

The D1 DAG compiler (`actuator/src/pipeline/grammar_dag.rs`) already gives
hint pairs a static Layer 1:

1. **Dependent-capture tails compile to OPEN STATES** — final + a self-loop
   bounded by `dependent_capture_alphabet()`, which unions words across every
   grammar-HWM collection matching the template's skeleton
   (`browser_hints_*`). Its own doc comment: *"being HWM-fed, keys from
   since-deleted per-prefix collections survive, so the alphabet converges
   instead of churning per paint."*
2. **The live export confirms convergence**: 10 open states, each carrying the
   full current 26-word alphabet — including state 0 (start), so any alphabet
   sequence decodes from rest, regardless of which pairs are currently pushed.
3. **Live probe of the residual failure mode**: with hints gates active,
   `POST /v1/commands/resolve {"words":["arch","bam"],"preview":true}` →
   `matched:false` for a pair that decodes fine but isn't in the pushed
   per-prefix collections. Decode succeeds; MATCH fails on collection lag.
4. **The decode-empty class (2026-07-02 investigation) survives only for words
   outside the CURRENT alphabet** (retired decks — the open-state alphabet is
   the current 26, not the whole HWM union). A steady-state non-issue.
5. **voice-regress**: static-command clips green under the open-pair grammar
   (production has been running it through daily use). The formal
   confirmed-corpus gate is still blocked on the user's confirm-pass; the
   `--include-unreviewed` run's failures were retired-deck pair clips and
   unreviewed-quality clips — exactly the classes the corpus rules exclude.

**Consequence:** sections 2's "seed the full pair DAG" step and its accuracy
measurement are MOOT — the platform already runs an equivalent-or-looser
grammar, user-validated daily. The vocab-lag/recompile-churn class for hints
is structurally closed at Layer 1 TODAY. Everything below is re-read in that
light: the delta mirror's only remaining recognition role is keeping MATCH
(Layer 2) truthful, and the proposal reduces to moving pair resolution out of
the pushed collections.

## 0b. Re-scoped proposal (the Layer-2 cut)

Change the hint command's captures from the live per-prefix collections to the
**sealed 26-word alphabet collection**, and resolve pair→element at dispatch:

- Pattern becomes `<prefix:S_alpha> <suffix:S_alpha>` (browser-plugin-owned
  spec; the actuator stays generic — no new capture semantics needed).
- Match now succeeds for any alphabet pair while the hints gate is active;
  dispatch routes to the SW, which resolves letter-pair → tab/frame/wrapper
  from its own authoritative pool state (it already does the routing half) and
  answers "no such hint" with explicit feedback when the pair isn't live.
- The per-viewport push demotes to Discovery-HUD metadata + `_strict`
  eligibility on a relaxed cadence — no longer match-critical, so its
  staleness stops being a correctness bug, and the delta-mirror urgency
  (reservoir pre-fetch, epoch handshake re-push ladder) can be retired
  incrementally as consumers drop away.

Costs/open questions carry over from section 4 (mishears can now match
non-live pairs → dispatch-time not-found feedback; strict-viewport bias moves
to dispatch; HUD display cadence). Section 4's decode-accuracy question (cost
1) is answered by production; the UX gate (explicit "no such hint" vs today's
silent no-match) was ACCEPTED by the user 2026-07-18. Implementation plan
below.

## 0c. Implementation plan (seams identified 2026-07-18)

What the investigation of `plugins/browser/plugin.json` + the extension
showed the cut actually moves — three responsibilities, not one:

1. **Element metadata resolution.** The `hint_pair` capture macro's fields
   pull `{suffix.letter}`, `{suffix.id}`, `{suffix.frame_id}`,
   `{suffix.codeword}`, `{suffix.type}` from the pushed collection entries AT
   MATCH TIME — the action arrives pre-resolved. Under sealed captures the
   match yields only the two spoken words; the plugin forwards them and the
   extension SW resolves spoken pair → letter pair (`WORD_TO_LETTER`) →
   tab/frame/wrapper. Landing seam exists: `plugin/resolve.ts`
   `resolveHintLocally` + the SW's letter-pool routing.
2. **The strict gate.** The suffix slot targets the `_strict` companion
   collection, so seen-is-clickable is enforced by the MATCHER today. Moves
   to dispatch: the CS checks the wrapper's live strict state (fresher than
   the pushed mirror ever was) and refuses with the same not-found feedback.
3. **Not-found feedback.** New dispatch outcome (extension →
   `reportDispatchResult` → plugin): distinct HUD/audio cue for "no such
   hint"; also the mishear surface. Feedback design should reuse the
   existing dispatch-result plumbing, not add a channel.

**Step 0+1 IMPLEMENTED 2026-07-18** (plugin `hints_pull_resolution` flag,
default OFF — toggling needs a plugin restart): sealed-alphabet activate spec
(browser plugin collections.go; letters + words ride the params), SW letter
synth + unroutable-pair "no such hint" report (frame-router), CS live strict
gate (on-screen + isVisible + !cssHidden + !occluded) + refusal toast, plugin
warn-log on the no_such_hint dispatch result. Scope: the BARE activate only —
contributed verbs ({hint}/{hint+}) and the implicit multi-pair stay on the old
path (one layer at a time). Remaining in step 1: a toast for the SW-unroutable
path (needs a CS SHOW_TOAST message; today it logs + events only). DEFAULT flipped ON
2026-07-18 (user call — the flag is scaffolding, not a knob; escape hatch =
explicit false in plugin.browser.config). Live-verified: preview resolve
"arch bam" matches browser.activate under the sealed spec. Known soak
deltas: (1) no SetsOnPartial on the sealed shape (actuator validation
rejects it on non-dependent captures — the completing-tag scoped narrowing
during a chopped pair is lost; generic bridge still carries it), (2)
SW-unroutable path logs/events but has no toast yet.

**Step-2 outcome: FAILED FAST (2026-07-18, default back OFF).** Two
regressions the user caught within minutes of default-on, sharing one root —
the dependent-capture shape carries UX the plan credited to "sync
bookkeeping":
  1. **Prefix narrowing died.** Badges filtering to the spoken first word is
     driven by `_platform.dependent_capture.progress` (plugin consumes it →
     extension setMatchedChars/filter). Plain captures emit no progress.
  2. **Discovery HUD showed the alphabet.** The HUD's live-pair display comes
     from the per-prefix collections behind the dependent capture; the sealed
     pattern renders as its raw 26-word capture.
Requirements before any re-flip: (a) generic capture-progress emission for
plain multi-slot captures (actuator seam — generic, not plugin-specific) or
extension-side narrowing driven off a partial-dispatch signal; (b) a HUD
display source for sealed hint patterns (display-form metadata or
collection-backed rendering at relaxed cadence). REVISED READ: the per-prefix
mirror is load-bearing for THREE user surfaces (match truth, narrowing, HUD)
— the retirement payoff shrinks accordingly and the cut must replace all
three, not one.

**Retirement pass EXECUTED 2026-07-19** (payoff, user call — soak forfeited
deliberately, escape hatch = git revert): verbs ({hint}) + multi-pair macro
converted to the sealed shape (sealed captures + display sources + sealed
identity params; SetsOnPartial dropped per validator); the flag and legacy
activate branch DELETED; the grammar-epoch handshake DELETED end-to-end
(ext tripwire/republish ladder/probe/digest module + 3 test suites; plugin
digest + response field) — the mirror is display-grade and keeps only its
normal delta pushes. Live-verified: 6 sealed specs registered, 0 legacy
dependent specs. Net ~-830 lines. Still display-grade (NOT deleted):
label-sync delta mirror + strict pushes (feed the HUD menus/narrowing),
reservoir (pool-claim latency, unrelated to grammar truth). Watch during
daily use: verbs enforce the live strict gate now; chopped-pair
completing-tag scoping remains absent.

Steps (each independently landable, plugin + extension only):
  0. Flag: plugin setting `hints_pull_resolution` (default off) selecting
     between the two capture macros — manifest carries both; the gated
     command contribution flips (contribute.go owns the command patterns).
  1. Add the sealed macro (`<prefix:S_alpha> <suffix:S_alpha>` over the
     consumed `alphabet` collection) + plugin dispatch path forwarding raw
     words; extension SW resolution + strict check + not-found result.
  2. Soak with the flag ON (daily driving); the old path stays one flip away.
  3. Retirement pass (flag default on → old macro deleted → push demotes to
     HUD cadence → delta-mirror urgency machinery retires incrementally:
     epoch handshake re-push ladder, reservoir pre-fetch, `_strict`
     match-mirror). Clean-end-state rule: the final commit deletes the flag.

Grammar note: `grammar_seeds` already maps `browser_hints_*` → `alphabet`,
so Layer 1 is untouched by every step above.

---

## 1. Current shape

- Hint identity is letters (`words.ts`); voice is a 26-word overlay pushed by
  the plugin; spoken codewords are **pairs over that fixed alphabet** (26×26 =
  676, `label-pool.ts`).
- The extension pushes the *currently claimed* pairs per viewport change into
  per-prefix collections (`browser_hints_prefix` + `browser_hints_<word>`),
  REPLACE-style, focused tab only (DESIGN_ACTIVE_TAB_GRAMMAR_SCOPING.md,
  Option B landed 2026-06-01).
- The platform derives the structured DAG / HLG contribution from those
  collections. A pair not currently pushed is off-grammar: it decodes empty
  (see the 2026-07-02 codeword-decode investigation) and cannot match.
- Keeping the pushed mirror honest is the job of the delta-sync state machine
  (`sentCodewords`/`pendingPuts`/`pendingDeleteCodewords`), the reservoir, the
  epoch handshake, the strict re-push loop, and the vocab-lag tripwire on the
  platform side. This is bug factory (c) in the audit: stale dispatch,
  active-tab clobber (fixed), ACK loss, wipe/republish asymmetry all lived
  here.

## 2. Proposal

**Layer 1 (engine grammar): static.** When the alphabet loads, seed the pair
DAG with the full 26×26 cross product, once. The hint contribution to the
union grammar never changes again — no recompiles, no commit debounce in the
hot path, no lag tripwire for hints, `vocabulary.commit` churn from the
browser drops to zero. This is squarely inside the platform's own two-layer
principle: keep the engine grammar full and stable; context lives in Layer 2.

**Layer 2 (eligibility): coarse.** Pairs are matchable iff the existing
hints-active tag is set (non-exclusive augment, unchanged). We stop trying to
keep the *exact live pair set* match-eligible in real time.

**Resolution: pull at dispatch.** A matched pair routes to the browser plugin
→ SW → content script exactly as today (dispatch already round-trips to the
extension to click). The SW resolves word-pair → letter-pair → tab/frame/
wrapper from its own authoritative pool state. A pair that isn't live
resolves to a "no such hint" outcome with explicit user feedback, instead of
silently failing to match.

**What the per-viewport push becomes:** optional metadata for the Discovery
HUD and diagnostics, on a relaxed cadence (or template display — "say
<word> <word>" — and no push at all). It is no longer recognition-critical,
so its staleness stops being a correctness bug.

## 3. What this buys

- **Deletes the urgency, then most of the machinery.** The delta mirror,
  reservoir pre-fetch, epoch probes, and strict re-push loop exist because a
  missed or late push made painted badges unmatchable. With a static Layer 1
  and pull resolution, a missed push costs a HUD nicety, not a dead badge.
  Estimate ~1,200–1,600 lines eventually removable across `labels/` plus the
  plugin-side session-cleanup/replay complexity.
- **Kills recurring incident classes at the root:** vocab-lag/starvation,
  decode-empty-on-stale-grammar, reconnect-without-republish, tab-switch
  grammar wipe. Each was patched individually; all share this root.
- **Removes the paint→matchable latency window entirely.** Today a badge is
  speakable only after paint → claim → push → commit. Under this design a
  pair is decodable the moment the badge paints.

## 4. Costs and open questions

1. **Decode accuracy over 676 pairs vs ~N live pairs.** The competing-path
   set grows. Sherpa's neural CTC has no hallucination cliff, and the
   26-word alphabet was chosen for acoustic distinctness, but this must be
   measured, not asserted: run `just voice-regress` with the full
   cross-product DAG exported and compare against the live-set baseline over
   the confirmed calibration corpus. This measurement gates the whole design.
2. **Mishears can now land on non-live pairs.** Today an off-viewport pair
   fails to match (falls through); under this design it matches and resolves
   to "no such hint" feedback. Arguably better UX (explicit) but it is a
   behavior change; the not-found feedback path must be designed (HUD flash?
   spoken? silent?).
3. **Strict-viewport / occlusion match-gating moves to dispatch time.** The
   `_strict` companion currently biases matching toward what is actually
   visible. Under pull resolution the same rule is enforced by the SW/CS at
   dispatch ("visible right now?"), which is *more* current than the pushed
   mirror ever was — but the matcher loses a disambiguation signal. Assess
   whether any command/pair collision relied on strict gating.
4. **Discovery HUD.** Decide: relaxed-cadence push (keep showing live pairs,
   staleness now harmless) vs template entry. Recommend relaxed push first —
   smallest visible change.
5. **Multi-browser focus routing is unaffected** (FocusedBundleID gating on
   dispatch stays; it routes actions, not grammar).
6. **Sizing check on the DAG.** 676 two-word sequences over 26 words is a
   trivially small graph by HLG standards, but confirm compile cost once at
   alphabet load is acceptable (it is a one-time boundary-gated recompile).

## 5. Migration sketch

0. **Measure first (gate).** Export a full cross-product grammar and run
   voice-regress + a live A/B on real pages. If accuracy regresses beyond
   noise, stop here and keep the mirror (the plan's other phases don't depend
   on this one).
1. Plugin seeds full per-prefix collections at alphabet load; extension keeps
   pushing as today (pushes become REPLACE-with-superset no-ops for Layer 1).
   Soak: nothing should change except vocab-lag going quiet.
2. Move resolution to pull: dispatch resolves via SW pool state; add the
   not-found feedback path. Extension pushes continue only for HUD.
3. Retire recognition-critical sync machinery (delta mirror urgency,
   reservoir, epoch handshake) as each stops having a consumer. Final commit
   deletes the transitional adapters (clean-end-state rule).

---

## Related documents

- notes/PLAN_RELIABILITY_CONSOLIDATION.md — parent plan (Phase 3).
- notes/DESIGN_ACTIVE_TAB_GRAMMAR_SCOPING.md — the clobber arc this
  structurally obsoletes for Layer 1 (Option B projection stays for routing).
- notes/DESIGN_GRAMMAR_EPOCH_HANDSHAKE.md — the machinery step 3 retires.
- ../../notes/DESIGN_PLATFORM_VOCABULARY.md — the two-layer principle this
  leans on (full stable Layer 1, Layer 2 does context).
