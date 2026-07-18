# Static Pair Grammar — stop syncing the viewport into the recognizer

**Status:** proposal, 2026-07-18. Phase 3 of PLAN_RELIABILITY_CONSOLIDATION.md.
Cross-repo (extension + voice plugin + platform vocabulary seam); needs a
platform-side design pass before code.

**One-line motivation:** the recognizer only ever needs 26 words. Everything
downstream of "the grammar must track the viewport" — the vocab-lag class, the
50ms commit-debounce starvation, decode-empty confusion, and most of the
delta-mirror bookkeeping in `labels/label-sync.ts` (843 lines) +
`label-reservoir.ts` (479) + the grammar-epoch handshake — is complexity spent
keeping three owners agreeing about a set that could be static.

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
