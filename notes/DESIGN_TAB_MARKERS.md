# Design: Tab Markers — spoken codewords on the tab strip

**Status:** Proposal (2026-07-05). Behind a toggle, default OFF.
**Goal:** Make every open tab addressable by voice *without* opening the
palette — a stable spoken codeword visibly attached to each tab, readable
straight off the tab strip. Say "tab", the strip is your menu; say a tab's
codeword, you're there.

## The constraint that shapes everything

Extensions cannot draw on the native tab strip. The only pixels we control
up there are the tab's **title** and its **favicon**. So a tab marker is a
**title prefix** — the tab reads `a| GitHub — pulls` (letter display) —
applied by the content script via `document.title`. The favicon is a
possible second surface (covers pinned tabs) but is out of scope for v1.

## Chosen approach: an exclusive "tab mode" (Option C)

Saying **"tab"** enters an exclusive mode — the same machinery as
`plugin.windows.snap_mode` and the command palette's exclusive tag. While
the mode is held:

- **Page-hint captures (and every non-tab command) are suppressed** by the
  exclusive gate. This is the load-bearing move: because tab markers no
  longer compete with the hundreds of page hints, they only need to be
  unique *among tabs* — so they can be **single letters**. "arch" means
  tab-arch in this mode and hint-arch on the page, disambiguated purely by
  context (Layer 2's whole job).
- **The engine grammar narrows to the tab word set** (`compute_narrow_to`,
  which every exclusive gate drives). The recognizer listens for only the
  tab words → materially better accuracy, something a plain inline capture
  can't offer.
- **The tab strip is the discovery surface.** Every tab shows its codeword;
  the Discovery HUD can also enumerate them (see "Discovery is free"). Say
  the codeword → switch + clear the mode. Or "tab arch" in one breath — the
  fast path always works; the mode never gates speed.

**One voice language for tabs: markers, not positions.** The trigger is
"tab", and what follows is always a codeword — never a number. See "Markers
supersede voice-positional" for why the existing "tab {number}" voice phrase
is retired here.

```
  you say "tab"  ──►  exclusive tab-mode tag set:
                        • page hints suppressed
                        • engine narrows to tab words (accuracy ↑)
                        • strip shows each tab's codeword
                          ┌──────────────────────────┐
                          │ a| GitHub   b| Gmail       │
                          │ c| Docs     d| Figma       │
                          └──────────────────────────┘
  you say "arch" ──►  switch to GitHub + exit mode
  (or "tab arch" in one breath — fast path still works)
```

This is really *palette semantics with the tab strip as the menu instead of
an overlay* — same exclusive-tag lifecycle, same stuck-tag drains, just a
different surface and a smaller membership.

### Why single letters work here (and the reserved-letter split)

Single-word markers cover 26 tabs. To exceed that without losing chop
safety, reserve the alphabet into two **disjoint** zones:

```
   a b c d e f g h i j k l m n o p   │   q r s t u v w x y z
   └──────── SINGLES (head) ─────────┘   └─── PAIR POOL (tail) ──┘
        S one-word markers                 pairs drawn ONLY from here
```

A pair (e.g. "quill reef") never contains a head letter, so **no single
marker is ever the first word of a pair**. "arch" said alone is
unambiguously the single even across a pause — nothing continues it.
Prefix-free by construction → chop-safe with **no bridge**. (This is the
exact `codewords.ts` `SINGLES` mechanism already written for the palette;
the palette runs it at `SINGLES = 0` because it holds tabs *plus* every
command; tab mode runs it at ~16 because it holds only tabs.)

Capacity is `S + P·(P−1)` with `P = 26 − S`:

| Reserved singles (S) | Pair pool | Pairs | **Total tabs** |
|---|---|---|---|
| 20 | 6 | 30 | 50 |
| 18 | 8 | 56 | 74 |
| **16** | **10** | **90** | **106** |
| 14 | 12 | 132 | 146 |
| 12 | 14 | 182 | 194 |

**Default S = 16**: sixteen single-letter fast markers + ninety pairs cover
a 100-tab session. Drop to 14 for habitual 100+ hoarders. One-line constant,
retune once seen live.

### Markers supersede voice-positional

We ship a positional voice command today: `goto_tab`, phrase **"tab
{number}"** — switch to the Nth tab by position (1-based, shipped
2026-07-01). Keeping it alongside marker mode would put **two addressing
languages under one concept** — say "tab" and you'd be offered both numbers
and letters for the same tabs. That ambiguity is exactly what a voice UI
should avoid, so **markers become the sole voice tab-addressing** and the
"tab {number}" *voice phrase is retired*.

- `goto_tab` keeps `mappable: true` — it stays a **keyboard-bindable**
  action (a key isn't a spoken option, so it can't pollute the voice space).
  It just loses its `voice` pattern. (Dropping the command outright is also
  fine; keeping the mappable action is the zero-regret choice.)
- Nothing of value is lost from voice: **"first tab" / "last tab"** already
  name the common endpoints, so the only thing "tab {number}" uniquely did
  was *count to the Nth tab* — the awkward-at-scale chore markers exist to
  replace. You stop counting and say the codeword you can see.

This also removes the trigger-collision worry entirely: with "tab {number}"
gone from voice, "tab" is free to be the marker trigger with nothing to
compete against. (Open-question #2, closed.)

### Marker assignment & stability

Markers are **stable per tab for its lifetime** (perceptual continuity, same
principle as hint codewords) — Rango's pool model:

- Pool `{ free: string[], assigned: { tabId: marker } }`, singles sorted
  ahead of pairs so they're handed out first.
- Assign on `tabs.onCreated` (pop from `free`), release on `onRemoved`
  (return to `free`), transfer on `onReplaced` (Chrome tab discarding).
- **Never reassigned while a tab is alive** — a marker that moves can't be
  learned.

Consequence: single letters land on your **longer-lived tabs** (they grabbed
them first and held them); new ephemeral tabs get pairs. Reasonable default.
Open knob: if we'd rather singles track *most-recently-used* than
*longest-lived*, MRU-reassignment trades some stability for "your active set
is always single-letter" — deferred unless it's felt.

State in `chrome.storage.session` (survives SW restarts, dies with the
browser — matching tab-id lifetime), plus title-parse reconciliation at init
(below) so restored sessions keep their visible marks across a browser
restart.

## Voice wiring: a tab-scoped codeword collection

Unlike the current voice "switch to \<tab\>" (flat `browser_tabs`, title/
domain words, no mode), the marker mode needs its own scoped collection so
the exclusive gate can suppress everything else:

- **`plugin.browser.tab_mode`** — a `tag` collection, `exclusive: true`,
  `as_gates`, set by the "tab" trigger command and cleared on selection /
  drain (mirrors `plugin.windows.snap_mode` and the palette tag).
- **`browser_tab_marks`** — `as_named_entities`, key = spoken codeword,
  value = `tab_id`. Published by the extension when the mode opens (or kept
  live and gated — see phasing). The marker-select command
  (`{browser_tab_marks}`, gated on `tab_mode`, `ClearsTags` on match)
  resolves the codeword → `tab_id`, dispatched exactly like today's
  `switch_to_tab`.
- Grammar seed `browser_tab_marks: alphabet` (marker words are alphabet
  words, already in the engine union → no HLG recompile to publish them;
  only the exclusive narrow recompiles, at a boundary).

This touches the plugin (declare the tag + collection + a trigger command),
but it's **palette-grade coupling reusing existing mechanisms**, not a new
matcher primitive.

**Discovery is free.** Verified in the matcher this session: the Discovery
HUD is populated generically — `completions_inner` →
`steps_to_discover_items` → `expand_step_to_items` enumerates *any* capture
collection's entries (proven by `expand_step_single_collection` in
`matching_service.rs`). So "tab" as a partial already blooms the HUD with
every marker; no dependent/prefix-suffix structure needed to get discovery.

## Options considered (why C, not A or B)

| | A — flat inline | B — dependent prefix/suffix | **C — exclusive mode** |
|---|---|---|---|
| Separates from page hints by | `switch to` verb prefix | the completing-tag bridge | **exclusive gate** |
| Marker length | pairs (chop safety) | 1–2 words, reused | **1 word (+ pairs past S)** |
| Narrows the engine? | no | no | **yes (accuracy)** |
| "Lead you along" | HUD on trigger only | paused, per-word | HUD on trigger; single-word so no per-word step |
| Code lives | extension only | ext + plugin + bridge | ext + plugin (palette-grade) |

- **A (flat inline)** was the original proposal: zero plugin changes, but no
  engine narrowing and forced pair-length markers.
- **B (dependent + bridge)** buys paused per-word narrowing, but that only
  does real work when many items share a first word — a hint-scale property
  tabs don't have (a tab's first word is usually unique, so the second word
  is redundant ceremony). Overkill for tabs.
- **C** gives the shortest possible markers (single letters), the accuracy
  win of engine narrowing, and the "say tab, see your tabs" lead-along —
  reusing the exclusive-tag machinery we already built and hardened for the
  palette. Chop-safe via the reserved-letter split, no bridge.

A stays documented as the **zero-plugin fallback** if the mode's coupling
ever proves not worth it.

## Prior art: Rango's tab markers (studied 2026-07-05)

Rango ships title-prefix tab markers. Key files:
`src/background/tabs/tabMarkers.ts` (pool),
`src/content/setup/decorateTitle.ts` (title writing),
`src/background/tabs/getBareTitle.ts` (undecorated-title accessor),
`e2e/decorateTitle.test.ts`. What we take:

1. **Background-event-driven re-decoration, not a content observer.** The
   background listens to `tabs.onUpdated` (title changes) and messages the
   tab to re-decorate. No `<title>` MutationObserver in every page.
2. **Three anti-fight guards** in the content decorator:
   - *Echo guard:* remember `lastDecoratedTitle`; ignore the title-update
     message when `document.title` still equals it (our own write echoing
     back). Loop prevention.
   - *Incremental-edit guard:* if the new title merely *contains* the last
     decorated title (Bandcamp prepends "▶︎ "), accept it as still-decorated
     rather than re-stripping — don't fight pages that edit incrementally.
   - *Strip-before-apply:* always `removeDecorations()` before prefixing
     (regex `^[a-z]{1,2} ?\| ?`), so re-entry, extension updates, and
     double-decoration are idempotent.
3. **Restart recovery by parsing titles.** On init, extract markers from
   existing titles with that regex and re-adopt them. Because the marker is
   baked into the restored title, marks survive "Continue where you left
   off" though tab ids don't.
4. **Pool lifecycle** = assign on `onCreated`, release on `onRemoved`,
   transfer on `onReplaced`. (Our reserved-letter pool, above, is this with
   the singles/pairs split.)
5. **A bare-title accessor** with a content-script-unreachable fallback.
6. **Settings**: include-in-title toggle, uppercase, compact delimiter,
   hide-when-hints-globally-off.
7. **Empty-title/PDF care:** skip decorating when the title is empty; remove
   decorations when an empty-title doc becomes current.

Where we diverge: Rango's markers are static — the strip letter is the
*only* way to know a tab's codeword, so they must be short and always
visible. We add the exclusive mode (engine narrowing + Discovery HUD), so
the strip mark is a convenience over a discovery mechanism that stands on
its own — and marks that never render (chrome://, PDFs) are still speakable.

## Display

Title prefix follows **`badgeDisplayMode`** (the knob hints and the palette
already read):
- `letter` → `a| GitHub — pulls` (1–2 chars — the sane default in the
  space-starved strip)
- `word` → `arch | GitHub — pulls`
- `both` / `first-word` → the palette's `codewordDisplay` mapping.

Delimiter: Rango's `|` (compact, regex-friendly, visually quiet). The strip
regex must cover every display mode's emission and match ONLY at string
start.

## The churn war (the part that needs care)

SPA pages rewrite `document.title` constantly. Adopt Rango's protocol
wholesale: background `tabs.onUpdated(title)` → message tab → content
decorator with the three guards. Our background already listens to
`tabs.onUpdated` for the tab-word publisher, so the hook exists.

**Grammar-side stripping is load-bearing.** `tab-collection.ts` derives
spoken words FROM titles for the existing title/domain "switch to" path. It
must strip the marker prefix before `titleWords()` runs, or marker letters
leak into the word grammar. The tab-marker twin of Rango's `getBareTitle`,
applied at the one chokepoint where titles become grammar. The debounced
publish + unchanged-set guard absorb the decoration write itself (our title
write → `onUpdated` → publish reschedule → no-op, stripped word set
unchanged).

## Coverage gaps and side effects (why the toggle defaults off)

- **No content script → no visible mark**: chrome:// pages, Web Store, PDFs
  (empty-title care per Rango). The mark still exists in the pool + the
  marker collection, so it's still speakable in tab mode / the palette — just
  not readable off the strip. Do NOT reload unreachable tabs.
- **Pinned tabs** show favicon only — invisible mark. Favicon badge is v2.
- **History pollution**: history entries record decorated titles. Accepted
  behind the toggle.
- **Window title / screen shares** show the prefix; a few sites echo
  `document.title` into their own UI.
- **Session-restore tabs** keep baked-in marks until reconciliation re-adopts
  them (feature) — but if the toggle was OFF between sessions, init must
  strip stale marks from restored titles.

## Settings surface

One toggle: **"Mark tabs with spoken codewords"**, default off, in the
options page by the hint appearance settings (`chrome.storage.sync`, picked
up by background + content on `storage.onChanged` — flipping it off must
strip every decorated title live, not just stop decorating new ones).
Display mode is NOT a second toggle — it follows `badgeDisplayMode`.

## Open questions

1. **Palette convergence.** With marks on, the palette's tab rows could show
   each tab's *stable mark* instead of ephemeral palette codewords — one
   codeword per tab everywhere. Requires the palette to read the mark table
   for its tab rows. Desirable for coherence; deferred to after the mode
   ships.
2. ~~**Trigger word.**~~ **RESOLVED** — see "Markers supersede
   voice-positional". "tab {number}" voice is retired, so "tab" is the
   marker trigger with no collision. One remaining sub-choice: whether bare
   "tab" is a robust enough recognition trigger or wants a more distinctive
   form ("go tab", Rango's) — a recognition-robustness call to make once
   live, not a collision problem.
3. **Reserved-letter tuning.** S = 16 default; confirm against real
   peak-tab-count once live. MRU-vs-longest-lived for single assignment is a
   sub-knob.
4. **Favicon badge for pinned tabs** (canvas-drawn overlay, content-side
   icon swap). v2.
5. **Firefox**: same APIs (`tabs.onUpdated`, session storage, exclusive
   gate); persistent background simplifies the pool. No known blockers.

## Phased plan

1. **Marker pool + title decoration** — background reserved-letter pool +
   content decorator with Rango's three guards; toggle; live-strip on
   toggle-off; restart reconciliation; grammar-side marker stripping in
   `tab-collection.ts`. Visible marks, no mode yet (existing "switch to
   \<title word\>" still works and now has a visual anchor).
2. **Exclusive tab mode** — `plugin.browser.tab_mode` tag +
   `browser_tab_marks` collection + "tab" trigger command + marker-select
   command, with the palette's stuck-tag drains (select / blur / focus-loss
   / disconnect). "tab \<marker\>" live end to end, engine-narrowed. **Retire
   `goto_tab`'s "tab {number}" voice phrase** in the same change (keep the
   mappable action) so voice tab-addressing is markers-only.
3. **Palette convergence** (open question 1) + soak, then the default-on
   decision.

Each phase is independently shippable and keyboard/hints-safe; phase 1 alone
is useful on its own.
