# Design: Palette URL Entry + Web Search

Status: all three phases implemented 2026-08-02 (search row + engine
template, URL row + destination heuristic, `open_bookmark` → `navigate`
rename), live verify pending. Child of `notes/DESIGN_TAB_NAVIGATION.md`
(Layer 2); reconciles with `notes/DESIGN_PALETTE_ON_RESTRICTED_PAGES.md`.

The palette ranks over what already exists — open tabs, bookmarks, commands.
There is no path to a destination the browser has never seen: no "go to this
URL" and no "search the web for this". Vimium's Vomnibar has both (a bare
string that doesn't parse as a URL falls through to the default search engine;
`ge` edits the current URL). This is the last structural gap between the
palette and the Vomnibar, and it compounds with the restricted-pages work:
Route A there makes the palette the new tab page, and a new tab page that
cannot take you anywhere new is not a new tab page.

## What already exists (three facts that shape the design)

**Dispatch is solved.** `PaletteDispatch` already has a variant that navigates
to a bare URL — `{ kind: 'open_bookmark', url }` — and `handlePaletteAction`
(`background/palette.ts`) already implements placement via `OpenWhere`:
`'blank'` (new focused tab, the default since the 2026-07-31 bookmark
decision), `'stash'` (background tab), `'here'` (origin tab, reachable through
the API but currently unasked-for). A URL or search row is just this dispatch
with a synthesized `url`. Rename the kind to `navigate` when the second caller
lands — it stops being about bookmarks — but nothing new is needed in the
background half.

**The empty-query Enter default is load-bearing.** `buildTabItems`
(`palette/model.ts`) deliberately sinks the active tab to the end so that
open-palette + Enter lands on the *previous* tab — zero-typing tab switching,
called out in the code as half of real switcher usage. The Vomnibar puts
URL-ish input at the top unconditionally; we must not. Constraint: **no
synthesized row at empty query.** The rows exist only once there is a query,
so the browse state and the Enter default are untouched.

**`resolvePaletteQuery`'s recovery is gated on "matches nothing".** Both of
its voice recoveries — the appended-utterance retry ("gmailgithub") and the
phonetic correction — fire only when the literal box text finds zero hits. A
synthesized row matches *every* query by construction, so if it is visible to
that gate, `hits()` is universally true and both recoveries go permanently
dead. Constraint: **query-derived rows are excluded from the corpus
`resolvePaletteQuery` sees.** They are appended after query resolution, ranked
never, positioned by rule. This is the one place the feature can silently
break something that already works.

## Design: query-derived rows

Every current source enumerates a corpus and gets filtered. These rows are the
opposite — derived from the query itself, nothing to enumerate, nothing to
rank. That is a new structural role, so it does not join `PaletteSourceId`;
instead `filterPalette`'s caller appends a synthesized section after
filtering:

- **Search row** — always present when the query is non-empty. Label
  "Search for “<query>”", subtitle names the engine host. Dispatch:
  `open_bookmark` with the engine template applied. Position: **last**. It is
  the fallthrough, not the guess — the palette's whole point is that the
  ranked match above it is usually right, and a search row above real hits
  would demote them.
- **URL row** — present only when the query *parses as a destination*. Label
  "Go to <normalized-url>". Position: **first**. When you have typed
  something URL-shaped, that intent is unambiguous and Enter should honor it;
  this matches omnibox behavior and the Vomnibar.

URL detection is a heuristic, and the failure modes are asymmetric: a missed
URL still has the search row (engines redirect bare domains anyway), while a
false positive hijacks Enter from a real match. So detect conservatively:
has a scheme, or `localhost[:port]`, or contains a dot with no whitespace and
a plausible TLD-ish tail. Exact-first still holds — the rows never rewrite
what was typed; normalization (prepending `https://`) happens in the dispatch
payload, with the row label showing the normalized form so Enter has no
surprises.

**Scopes.** The rows appear in the full palette (`scope` absent) and the
bookmarks scope — both answer "take me somewhere". The tabs and commands
scopes are closed sets by intent; a search row there would break the scope's
promise (and its empty-state message).

**Placement.** Same `OpenWhere` surface as bookmarks, same default (`blank`).
One rule, not two: "rows that navigate open a new tab unless you say
otherwise". Whatever modifier the bookmark rows grow applies here unchanged.

**Engine template.** A single user setting, a template string with `%s`
(`https://duckduckgo.com/?q=%s` style), default set to a mainstream engine.
Not a curated engine menu — the closed shape is "one template", the valve is
that the string is yours (the structural-opinion/content-valve split).
Keyword-prefixed engines (Vimium's `w foo` → Wikipedia) are cheap syntax on
top later, but hidden syntax is exactly what the palette exists to replace,
so they are out of v1 and would need a discoverable surface to come back.

**Selection.** Nothing new. The rows are rows: arrow keys reach them, Enter
activates, and in letter mode they take a label like any other row — so voice
selects them by codeword once the query is typed or dictated. Voice *search*
is therefore free end to end: "palette all", dictate the query (the platform's
caret sink already types transcripts into the box, and the search row is
appended after `resolvePaletteQuery` runs, so the retry/phonetic recoveries
still work), then Enter or the codeword.

## Reconciliation with the restricted-pages note

Route A (own the new tab page) has the hard constraint that Ctrl+T + typing
must keep going to the omnibox — so on the NTP itself, URL entry and search
stay Chrome's job and these rows are redundant there. Where they matter is the
rest of that note's dead zone: `chrome://` pages, the Web Store, the PDF
viewer, orphaned-content-script tabs — anywhere the palette is reachable but
the page cannot be scripted, navigating away is the *only* useful act, and
today the palette can only do it if a bookmark or open tab happens to match.
These rows are what make the standalone palette a complete exit from a
restricted page. Build order is independent; value compounds.

## Deferred: voice URL dictation

Speaking a never-visited URL ("github dot com slash anthropics") is out of
scope, and the reason is structural, not effort: every voice recovery the
palette has works by snapping a mishearing to a **closed candidate set** —
`bestPageMatch` against words that exist in the palette. A novel URL has no
candidate set; there is nothing to snap to. Whisper on URL-shaped speech
produces spacing, casing, and homophone errors ("get hub", "slash" vs "/")
that no downstream matcher can repair, because correctness isn't defined by
any corpus we hold.

What would make this pickable up later:
- a `url` **dictation profile** alongside `query`
  (`notes/DESIGN_DICTATION_PROFILES.md` in the app repo): spoken-form
  rewriting ("dot" → ".", "slash" → "/", no inter-word spaces), engaged when
  the palette box is the focus target and the text is URL-shaped;
- or sidestepping novelty entirely: history as a candidate set (a `history`
  source is the Vomnibar feature we deliberately haven't taken), which turns
  most "go to X" utterances back into closed-set matching and shrinks the
  truly-novel remainder to first-ever visits — where the search row is
  honestly the better voice path anyway ("search github anthropics", first
  result).

Do not re-propose voice URL dictation as a fresh feature; extend this section
or graduate it to its own note when someone takes it on — after these rows
ship, since the profile would target a row structure that this note defines.

## Phases

1. **Search row.** Engine template setting + synthesized last row in the full
   and bookmarks scopes, `open_bookmark` dispatch, excluded from the
   `resolvePaletteQuery` corpus. Model change is pure and unit-testable
   (`model.test.ts`): row presence/position, corpus exclusion (the retry and
   phonetic recoveries must still fire with the row present — regression
   tests, since breaking them is silent).
2. **URL row.** Detection heuristic + normalized dispatch, first-position
   rule. Pure, table-driven tests over the heuristic.
3. **Rename** `open_bookmark` → `navigate` once both callers exist (no
   compat concerns pre-launch).
