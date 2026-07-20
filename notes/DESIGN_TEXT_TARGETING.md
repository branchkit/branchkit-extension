# Text-based element targeting (G1) — act on an element by its text, no badge

**Status:** DESIGN, opened 2026-07-19. From ANALYSIS_RANGO_FEATURE_PARITY.md G1
(the standout gap) + G7/G3 (its "paste/insert to target" companion — the "pace to
target" line). Not started.

## What it is

Today the only way to act on an element is to read/type/say its hint badge. This
adds a second path: **name the element by its visible text.**

- Keyboard: `click Submit` → clicks the button whose accessible name best matches
  "Submit", with no badge round-trip.
- Voice: "click Submit" → same, and this is the bigger win — no codeword to read
  aloud, which is the single most-fatiguing part of voice hint navigation.

Rango proves the pattern with two verbs; we mirror them:
- **`follow <text>`** — best-matching **visible clickable** element (the common case).
- **`button <text>`** — best match **anywhere on the page** (including off-screen /
  behind menus), for "I know it's there but can't see it."

## Why it fits our architecture (mostly built already)

1. **Candidate text exists.** `scan/accessible-name.ts::accessibleName(el)` already
   computes each candidate's accessible name (currently feeding fingerprints and
   grammar labels, capped at 256 chars). The target corpus is the scanner's
   existing candidate set — no new observation.
2. **The command shape exists.** `command-catalog.ts` already supports `{text}`
   captures (`"find {text}"`). A `click {text}` / `follow {text}` command is a
   catalog entry with a text slot — the extension owns the vocabulary, the
   platform expands the capture (per the extension-independence principle). No new
   capture machinery.
3. **A text matcher exists to borrow from.** `scan/find.ts::findMatchRanges`
   already normalizes + matches query text against the DOM; the ranking function
   here is adjacent, not novel.

So G1 is: a **matcher** over the candidate set's accessible names + a **command
entry** + a **disambiguation UX**. No new permission, no new observer.

## The matcher

Rank candidates against the spoken/typed query:
- Normalize both sides (lowercase, collapse whitespace, strip punctuation) —
  reuse find's normalization.
- Score: exact accessible-name match > prefix > word-subset > substring >
  fuzzy. Break ties by **visibility + viewport proximity** (a visible in-band
  match beats an off-screen one) — we already derive visibility at settle time
  (observed-state read-time arc), so read it fresh, don't store.
- `follow` filters to visible clickable candidates first; `button` scores the
  whole set.

## Disambiguation UX (the hard part, and where we can beat Rango)

When the top match is unambiguous (clear score leader, visible) → act immediately.
When several candidates tie (three "Edit" buttons):
- **Paint hint badges on only the matching candidates** and let the user pick by
  badge — reusing our entire hint pipeline for the tie-break. This is strictly
  better than a blind "best guess" and is a natural fit: the badge system is
  already the disambiguation primitive.
- Voice: the same matching-subset badges appear; say the codeword. This composes
  with the sealed pull-resolution dispatch already in place.

This means G1 is not a parallel targeting stack — it's a **pre-filter that feeds
the existing hint/dispatch pipeline** when ambiguous, and a fast-path when not.

## Companion: act-on-target verbs (G6/G7/G3 — "paste to target")

Once "resolve text → element" exists, the *verb* is a parameter. The same
resolution powers a family, and "paste to target" is the one the user flagged:
- `follow <text>` / `click <text>` — activate (G1 core)
- `focus <text>`, `hover <text>`, `show <text>` (info tooltip) — permission-free
- `menu <text>` — synthesize the element's own context menu (permission-free)
- **`insert <words> to <text>`** — type text into the matched field (G7)
- **`paste to <text>`** — paste the clipboard into the matched field (G3). **This
  is the only member needing `clipboardRead`** (or a user-gesture path). Decide
  the permission with this verb specifically, not the whole family.

Recommend building G1 (resolve + activate + disambiguation) first as the spine,
then adding verbs. Paste is the last one because it's the only permission cost.

## Standalone vs voice

- **Standalone keyboard:** a text-target mode (e.g. a key that opens a small
  input like find, but Enter *acts on the element* instead of scrolling to text).
  Keeps the Vimium-class keyboard story whole — works with no app.
- **Voice:** the `{text}` capture on the catalog command; the platform's matcher
  hands us the recognized text, we resolve + act. Nothing platform-specific
  leaks into the actuator (it stays generic).

## The voice path is the hard part — and it's NOT a free `{text}` capture

Resolved 2026-07-19 by reading `command-catalog.ts:216-219` (the `find_immediate`
entry) + `notes/DESIGN_PLATFORM_VOCABULARY.md`. The keyboard path is trivial; the
voice path has a real constraint we must design around, not verify away.

**The finding, verbatim from the code:** `find {text}` is `mappable:false` with no
voice pattern, and the comment explains why — *"the closed command engine can only
hear words already in its union, so 'find {text}' never did real find-in-page. A
future page-word index ('find <word:page_words>') would re-target this action."*

So: **a free unbounded `{text}` voice capture does not work today and can't.**
Sherpa's CTC+HLG only decodes words in the union grammar; an arbitrary page word
("Submit", "Checkout") isn't in the union unless we put it there. This is the same
reason hint badges encode to a **sealed fixed alphabet** — it never churns the
union. Text targeting can't use that trick: matching real words is the whole point.

**The path the code already names — a page-word index.** Contribute the current
page's element-name words (from the scanner's `accessibleName`s) as a named-entity
collection into the grammar union, so `click <word:page_words>` is matchable while
that page is focused. Mechanism exists: it's the HWM / `entity_cache` contribution
in DESIGN_PLATFORM_VOCABULARY (`feeds_matching=as_named_entities`), the same seam
hint codewords already ride.

**The cost, stated honestly:** unlike sealed hint pairs (zero union churn), page
words **churn the union on every scan/nav → an HLG recompile per page**
(boundary-gated, expensive). Options: (a) accept per-page recompiles, debounced,
with the existing vocab-lag tripwire covering the trailing window; (b) commit a
bounded page-word snapshot per focus and refresh lazily. Either way this is a
platform-vocabulary feature that crosses into the actuator/plugin — **not
extension-local.**

### Revised phasing (this finding changes it)

- **Phase 1 — keyboard G1, extension-only.** Text-target mode + matcher +
  disambiguation. No union, no recompile, no platform work. Cheap, self-contained,
  shippable independent of the voice stack. Delivers the standalone-tool win.
- **Phase 2 — voice G1, platform track.** The page-word index: element names →
  named-entity union contribution, per-focus commit, recompile budgeting, vocab-lag
  coverage. Larger, cross-repo, gated on DESIGN_PLATFORM_VOCABULARY. Validate with
  the `voice-regress` harness (note its caveat: dynamic per-page vocab, like hint
  codewords, only decodes when the matching context is live).

## Other open questions
- Match confidence threshold for act-immediately vs disambiguate — tune on real
  pages; start conservative (disambiguate on any near-tie).
- Scope of `button` (whole page) vs our strict-viewport/occlusion model: acting
  on an off-screen element is a deliberate exception to "seen-is-clickable" —
  gate it so `follow` keeps the guarantee and only `button` relaxes it.
- Keyboard: is this a distinct mode, or does hint-mode gain text-filtering (type
  letters that match either a codeword OR the element's text)? The latter is more
  Vimium-like and may be the better standalone shape — evaluate both.

## Non-goals

- Not replacing hint badges — this is an *additional* path; badges stay the
  precise disambiguator and the voice-sealed dispatch primitive.
- No new observers/permissions for the core (G1); only `paste to` (G3) considers
  `clipboardRead`, on its own merits.
