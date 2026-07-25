# Design: adaptive palette codeword length

**Status:** PROPOSED (investigation scope for a fresh session, 2026-07-25).
User ask: bookmark palettes made "hints running out" real (the 650-pair
ceiling is plausible for bookmark libraries), and small palettes pay a
two-word cost they don't need ("if there are only 26 or under, show one
letter badges").

## Current state (palette/codewords.ts — read its header first)

- Codewords assigned ONCE per palette open, from the 26-word voice alphabet,
  in empty-state row order. Deterministic; **refiltering never reassigns**.
- **Uniform two-word pairs, deliberately** — the chop-safety property: every
  key is exactly two words, so a chopped utterance is never a complete key.
  The palette has no matcher bridge (page hints handle chop with one), so
  uniformity removes the ambiguity structurally. The header explicitly rules
  out MIXING lengths (a chopped triple's first two words = a valid pair).
- Dormant `SINGLES = 0` knob: one-word badges for head rows from the alphabet
  HEAD, pairs drawn only from the TAIL — a disjoint split that keeps a
  chopped pair from matching a single. Shipped at 0 for uniformity + the
  650-row ceiling.
- Rows past `maxVoiceRows()` (650) silently get NO badge (`if (!cw) continue`
  in palette-page assignAndPublish). No user-visible signal.

## Part 1 — uniform length per open (near-settled, small)

The full row list is in hand at assignment time (assignAndPublish), so the
choice is fully informed, not estimated:

- rows <= 26        -> all singles (chop impossible: no multi-word keys)
- rows <= 650       -> all pairs (today)
- rows <= 26*25*24  -> all triples (a chopped triple = two words; no pair
                       keys exist in-session, so it matches nothing)

Chop-safety holds because length is uniform WITHIN a session; the header's
prohibition is on mixing, not on per-open choice. Badge display
(codewordDisplay) and the publish path are length-agnostic already.

Checks for the implementing session:
- Matcher/engine: `{browser_palette}` entries are plain spoken phrases —
  confirm 3-word entries decode fine under the exclusive palette narrowing
  (pairs already do; expect yes).
- Cross-open inconsistency is the accepted cost (user explicitly wants it:
  "I don't want it to always show three letters if we don't have to").
- Tabs scope is untouched (strip-mark convergence, not assignCodewords).
- Overflow past the chosen tier: still badge-less rows — consider a one-line
  visible signal ("N rows unbadged — type to narrow") per the no-silent-caps
  rule.

## Part 2 — filter-adaptive reassignment (the actual investigation)

User intuition: after narrowing, the visible set is small, so codewords could
shrink to singles. Hazards that need design, not just code:

1. **Stability invariant reversal.** "Stable badges; refiltering never
   reassigns" is deliberate. Re-badging mid-session invalidates what the user
   just read; speech in flight against the old badge is the stale-utterance /
   mis-dispatch class (cf. pick-window work). Any design needs an epoch/settle
   story (reassign only at a debounced typing pause? keep old keys valid one
   beat?).
2. **Exclusive-gate collection churn.** The palette holds an EXCLUSIVE tag;
   its entries feed engine narrowing. Per-keystroke re-publish = the
   high-churn-under-exclusive-gate pattern the platform forbids for page
   hints (constant HLG recompile staging). At minimum: debounce hard, publish
   only on settle, measure.
3. **Do we need it at all?** Badges stay VALID while filtering today —
   narrow-then-speak-the-pair already works. The win is only utterance
   length. Weigh against 1+2; a plausible verdict is "part 1 yes, part 2 no."

## Pointers

- palette/codewords.ts (assignment + chop-safety analysis)
- palette-page.ts assignAndPublish (row set, publish), renderCurrent
- background/palette.ts publishPaletteVoice (entries -> plugin /palette)
- plugins/browser palette.go (browser_palette collection, exclusive tag)
- CLAUDE.md "Exclusive vs non-exclusive gates" (churn rationale)
