# Design: adaptive palette codeword length

**Status:** Part 1 IMPLEMENTED (2026-07-25). Part 2 REJECTED — verdict below.
User ask: bookmark palettes made "hints running out" real (the 650-pair
ceiling is plausible for bookmark libraries), and small palettes pay a
two-word cost they don't need ("if there are only 26 or under, show one
letter badges").

## Part 1 — uniform length per open (SHIPPED)

Badge length is chosen once per palette open from the known row count
(assignAndPublish has the full list in hand — no estimation):

- rows <= 26          -> all singles
- rows <= 650         -> all pairs
- rows <= 15,600      -> all triples (26×25×24)
- beyond              -> the tail goes unbadged, with a visible footer note
                         ("N rows without a voice badge — type to narrow"),
                         counted over the VISIBLE set so it retires itself as
                         narrowing brings the tail out of play.

Chop-safety holds because length is uniform WITHIN a session: no cross-length
keys ever coexist, so a chopped triple (two words) matches nothing — the
codewords.ts header prohibition is on MIXING, which stands. The dormant
`SINGLES` head/tail split knob was deleted (subsumed by tiering).
`codewordAt` unranks an index into no-repeat word sequences; the pair tier
enumerates identically to the old pairs-only code.

Engine check (done statically, pairs already proven live): the matcher's
`resolve_from_lists` (actuator matching.rs) consumes entity keys longest-first
up to 6 words, and the grammar DAG's `list_word_paths` splits each spoken key
into a word path of arbitrary length — no 2-word assumption anywhere. All
tiers use only alphabet words already seeded in the union
(`browser_palette: alphabet`), so no BPE-lexicon risk at any tier; tier
changes are pure STRUCTURE changes, covered by the existing debounced
vocabulary commit in handlePalettePost. Singles under the exclusive palette
tag are the snap-mode shape (bare words standalone-decodable only in-mode).

Cross-open inconsistency (a 30-row palette speaks pairs where yesterday's
20-row one spoke singles) is the accepted cost — the user explicitly chose it.
Tabs scope untouched (strip-mark convergence, not assignCodewords).

## Part 2 — filter-adaptive reassignment: NO

Rejected, not deferred. Three reasons, in order of weight:

1. **It reintroduces the chop hazard temporally.** Re-badging the narrowed
   set to singles means a pair key and a single key made of its first word
   exist on opposite sides of a re-badge instant. Speech in flight across
   that instant ("ocean" … pause, typed a letter meanwhile) is now a COMPLETE
   key for a different row — the exact mis-selection the uniform-length
   property exists to kill, in time rather than in space. Any fix is an
   epoch/settle protocol (stale-utterance windows, dual-validity beats — the
   pick-window class), which is a lot of machinery to guard a feature that…
2. **…buys almost nothing.** Badges stay valid while filtering today;
   narrow-then-speak-the-pair already works. The only win is one word of
   utterance after typing — and it costs a re-read: the user already read
   "ocean pearl" before narrowing; re-badging forces them to look again.
   Plausibly a net UX loss even before the hazards.
3. **Exclusive-gate churn.** The palette tag is exclusive, so its entries
   feed engine narrowing; per-settle re-publish = repeated narrow_to/DAG
   recompute + commit churn — the high-churn-under-exclusive-gate pattern the
   platform forbids for page hints.

Re-open trigger, if ever: field evidence that post-narrowing utterance length
is a real pain. The cheaper lever then is still not re-badging — it's keeping
the original badges and letting the visible subset's pairs stay speakable
(already true).

## Does any of this transfer to on-page hint badges? No.

Every precondition is palette-specific: hints have no open-boundary with a
known count (the set churns per scroll/mutation — a per-set length choice
would re-length badges constantly, the temporal mixing hazard again); their
chop safety comes from the matcher BRIDGE (positive partial continuation),
not structural uniformity; their capture is the fixed two-slot `hint_pair`
macro + prefix_shape context in the manifest, not per-entry literal keys; and
they run NON-exclusive (augment), where the grammar must stay stable by
design. Hint pairs stay as they are.

## Pointers

- palette/codewords.ts (tiering + chop-safety analysis)
- palette-page.ts render (overflow note), assignAndPublish
- background/palette.ts publishPaletteVoice (entries -> plugin /palette)
- plugins/browser palette.go (browser_palette collection, exclusive tag,
  debounced vocabulary commit)
- CLAUDE.md "Exclusive vs non-exclusive gates" (churn rationale)
