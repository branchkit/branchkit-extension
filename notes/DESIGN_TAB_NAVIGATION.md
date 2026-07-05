# Design: Tab Navigation + Command Palette

**Status:** Layer 0 (MRU stack) + Layer 1 (cycling) + tab verbs (Vimium parity, below) shipped 2026-07-01. Layer 3 (voice "switch to \<tab>") shipped 2026-07-02. Layer 2 (the palette) shipped 2026-07-05 in two same-day halves: keyboard MVP (Ctrl+K, extension-served iframe, tabs MRU-first + commands sources), then the voice half (codeword badges under an exclusive palette mode — see "Layer 2 voice half" below). Live verify pending. Still open: frecency, bookmarks source.
**Goal:** Move between tabs and jump to specific ones via keyboard and voice — without building a keyboard-only thing that can't be reused for voice — and grow the overlay into the modern successor of Vimium's Vomnibar rather than a one-source switcher.

## Prior art (what we're borrowing)

- **Vimium** `TabCompleter` (`completion/completers.js:592`): `chrome.tabs.query({})` over ALL windows, substring-match query against **title + URL**, rank by word-relevancy when typing / **recency (MRU)** when the query is empty. Dispatch = focus the tab's window then `chrome.tabs.update(id, {active:true})` (`selectSpecificTab`, `main.js:176`). Cycling (`nextTab`/`previousTab`) is just neighbor-activate; `visitPreviousTab` reads a recency map. Its **Vomnibar** is one bar with pluggable completers (tabs/bookmarks/history/domains), pre-scoped by trigger key (`T`/`b`/`o`) — the pluggable-source shape survives into our design; the destinations-only scope doesn't.
- **The command-palette lineage** (what superseded the Vomnibar): VS Code Ctrl+Shift+P → Linear/Notion/GitHub Cmd+K → in-browser: **Omni** (open-source Cmd+K extension), **Surfingkeys** (modern Vimium alternative, multi-source omnibar), **Tridactyl** (Firefox ex-command line), Arc's command bar, Chrome's abandoned **Commander** experiment (Ctrl+Space quick commands). The modern upgrade over Vimium: the palette searches **actions, not just destinations**. Two ranking ideas to steal outright: Firefox awesome-bar **frecency**, and the **MRU-first empty state** (open palette + Enter = previous tab, half of real switcher usage with zero typing).
- **Smart Tab Switcher**, **Modern Tab Switcher**, FuzzyTabs, Snipe, Tabber: same core; refinements worth stealing — combine **relevance + recency + frequency**, and **domain-first** ranking (match hostname before title, for many tabs on one site).
- **Voice prior art** ("Voice Actions for Chrome", etc.) validates **"switch to &lt;tab name&gt;"** — nobody's done it well alongside link hints, which is our opening.

## Core idea: tabs are a shared dynamic collection

The substrate is one thing, consumed by both input modes: **the set of open tabs, each with a searchable/spoken form and a recency rank.** Build this once; keyboard and voice both read it.

- **Keyboard** filters the collection in an overlay (sibling to the find bar / hints).
- **Voice** is a `switch to <tab>` command whose capture collection IS the tab set — the matcher's existing fuzzy/collection matching resolves it, **no new overlay UI**. This is the same machinery as the apps list (`open <app>`), so the voice version is nearly free once the collection is published.

**Unifying move:** reuse the **hint codeword system** in the palette. Every palette row (tab, command, later bookmark) shows a codeword badge (the phonetic alphabet), so you select by **typing the fuzzy query OR speaking the codeword** off the same surface. Keyboard↔voice stay symmetric instead of two systems.

## The keyboard constraint (load-bearing)

In **always-visible hints mode**, `KeyHandler.handleKeyDown` (keyboard.ts:90) routes every letter key to **hint-filtering** — normal-mode keybinds (scroll, find, and any `gt`/`gT` tab binding) are shadowed while hints are painted. Implications:

- Plain letter/sequence tab keybinds (`gt`/`gT`) work in **manual mode / hints-hidden**, but NOT for an always-mode user mid-hint.
- To serve always-mode from the keyboard, a command needs a **non-letter trigger** — either special-cased in `handleHintKey` or a modifier chord, which `handleKeyDown` routes to the command path even mid-hints (how the shipped tab verbs work).
- **Voice has no such conflict** — it works regardless of hint state. So for always-mode the voice path is the natural primary; keyboard is the secondary affordance.

**Trigger decision (resolved 2026-07-01): Ctrl+K opens the palette.** The universal palette chord; a real-modifier combo, so it routes to the command path in every mode including mid-hint and inside text fields (the Ctrl+S precedent — bound chords intercept and suppress the native shortcut). Rebindable like everything else.

## Layered plan

**Layer 0 — shared substrate. SHIPPED 2026-07-01 (MRU half).** Background SW maintains a **recency stack** (`background/tab-mru.ts`: `chrome.storage.session`, pushed on `tabs.onActivated`), consumed today by the `last_active_tab` verb. The remaining half — the published tab collection with searchable/spoken forms — lands with Layer 3.

**Layer 1 — adjacent cycling. SHIPPED.** `next tab` / `previous tab`, Shift+H/L, now voiced; subsumed into the tab-verbs table below. NOTE: if BranchKit owns Shift+H/L, drop the same mappings from Vimium-C to avoid double-switching.

**Layer 3 — voice "switch to &lt;tab&gt;". NEXT (resequenced before Layer 2).** Publish the open-tab set to the plugin as a collection (like the apps list); add `switch to <tab>` consuming it. No UI, and it forces the substrate honest before any overlay exists. Design cares:
- **Lexicon gap:** words absent from the recognition model's BPE lexicon are silently dropped — match on **distinctive title + domain words**, not full titles, and expect some tabs to be reachable only by domain word or codeword.
- **Title churn:** SPA pages retitle constantly (notification counts, now-playing). Debounce collection updates the way the hint grammar already does; a mid-utterance vocabulary rebuild is the exact bug class the unchanged-word-set guard fixed.
- **Disambiguation:** several tabs on one site share title words — dedup to distinctive forms, fall back to domain, and let the palette (once it exists) be the disambiguation surface for the rest.

**Layer 2 — the command palette.** See the next section.

**Ranking:** start MRU (recency stack). Add title+domain relevance on typed query; frecency is v2. Don't reinvent — port Vimium's `wordRelevancy` + `recencyScore` shape if it helps.

**Phasing rule:** never build a keyboard overlay that can't be reused for voice. Layer 0's collection + recency is the shared core; everything else consumes it.

## Layer 2 reframed: the command palette (2026-07-01)

Not a tab switcher with growth ambitions — a **generic filter-a-list overlay with pluggable sources**, launching with two:

1. **Open tabs** — MRU order when the query is empty (Enter on open = previous tab), title+domain relevance on type. Dispatch = focus window + activate, same as the verbs.
2. **Commands** — the command catalog is already a palette source: label, description, group, live keybind, voice phrases per entry. Selecting runs the command through the existing dispatcher. This makes the palette the discoverability surface for everything in the catalog ("how do I pin a tab?" → type "pin" → see the bind and the phrase, or just run it) — the actionable upgrade of the `?` cheat-sheet, and the thing neither Vimium nor Vimium-C does.

**Sources are declared, not hardcoded:** a source contributes `{items, emptyStateOrder, match(query), dispatch(item)}`. Bookmarks become source #3 by implementing that interface (follow-ups below). Sectioned results with source badges, not Vimium's flat list.

**Rendering/isolation:** an extension-served **iframe**, not the find-bar's in-page shadow DOM. Palette keystrokes reveal tab titles, command names, later bookmark names — the host page must not be able to observe them (Vimium's stated reason for the same choice). The settings-UI iframe isolation work is the in-house precedent.

**Voice symmetry:** every visible row carries a codeword badge; speaking the codeword selects it, same as hints. The palette is then just a synthetic page of hints from the grammar's point of view — no new matcher machinery.

**Non-goals (deliberate):**
- **URL entry / web-search fallback** (Vimium `o` typing a URL): the address bar does this better; zero marginal value.
- **History search:** corpus too large/churny for a recognition grammar (no voice analog), privacy-sensitive, and Ctrl+H + the address bar already cover it. Skipped indefinitely, not deferred.

### Layer 2 shipped — keyboard MVP (2026-07-05)

What landed:
- **Trigger:** `toggle_palette` catalog command, default `Ctrl+K` (backfills to
  existing users via `mergeNewDefaults`). Works in every mode — real-modifier
  chords route to the command path before the insert-mode yield. A bind fired
  in a subframe relays to the top frame (`PALETTE_OPEN` → `PALETTE_COMMAND`
  at frame 0).
- **Isolation:** full-viewport transparent iframe serving `palette.html`
  (`web_accessible_resources`), injected/removed by `render/palette-host.ts`
  with focus save/restore. Keystrokes never touch the host page.
- **Sources (pure model, `src/palette/model.ts`):** tabs — MRU-first empty
  state with the active tab demoted to the end, so open + Enter = previous
  tab; commands — every mappable catalog entry with live keybind + first
  voice phrase per row (the discoverability surface). Rows carry stable ids
  (`tab:<id>` / `cmd:<id>`) as the future voice-codeword anchor.
- **Ranking:** all query tokens must match; word-prefix > substring, small
  first-word lead bonus; ties fall back to source order (recency / catalog).
- **Dispatch:** palette page → `PALETTE_ACTION` → background closes the
  overlay in the origin tab (round-trip, so ordering is real), then switches
  the tab directly or runs the command through the origin tab's content
  dispatcher (`PALETTE_COMMAND`) — exact keybind semantics, tab verbs bounce
  back as `TAB_ACTION`.

Still open (v2 items):
- **Frecency** ranking; **bookmarks** as source #3 (batch the `bookmarks`
  permission with a store update); palette pre-warm if open latency ever
  bothers (today the iframe is created fresh per open).

### Layer 2 voice half — codeword badges (landed 2026-07-05, live verify pending)

Every palette row carries a spoken-alphabet badge; speaking the codeword
selects the row. Architecture decided after reading the platform's two-layer
model against the plugin code:

**The palette is an EXCLUSIVE mode, not a pool client.** The obvious approach
— claim palette codewords from the per-tab label pool so they can't collide
with painted page hints — was rejected. On a link-heavy always-mode page the
pool is near-exhausted and the palette would open badge-less. Instead the
plugin holds a `plugin.browser.palette` tag (preset tag, `exclusive: true`,
`as_gates` — the `plugin.windows.snap_mode` pattern) while palette rows are
published. Exclusivity does two things:

1. **Layer 2:** while the palette is open, every command not gated on the
   palette tag is suppressed — including the page-hint captures underneath.
   Palette codewords can therefore reuse the same alphabet words as painted
   hints with zero ambiguity: "the same word means different things by
   context" is the eligibility filter's whole job. No pool claim, no
   exhaustion, deterministic assignment (row N gets alphabet word N, pairs
   after 26).
2. **Layer 1, free:** an exclusive gate drives `compute_narrow_to`, so the
   engine narrows to the palette's word set at the next utterance boundary —
   off-mode acoustic neighbors become unproducible at the source. The palette
   is exactly the "focused, stable mode" the narrow was built for: content
   is frozen while open (publish once at open, never on refilter).

**Data path** (mirrors `browser_tabs`, one level simpler — palettes don't
exist in background browsers, so it's single-conn, not per-conn):
- Extension: palette page assigns codewords from the alphabet
  (chrome.storage.local `alphabet`) in empty-state row order, renders badges,
  sends the (codeword → row id) list + a (row id → dispatch) map to the
  background. Background keeps the dispatch map and POSTs
  `{conn_id, entries: [{spoken, row_id}]}` to the plugin's `POST /palette`.
- Plugin: entries land in the `browser_palette` collection
  (`as_named_entities`, key `spoken`, value `row_id`; multi-word keys are
  proven — app aliases like "activity monitor" ride the same matcher path).
  Non-empty entries Put the palette tag; empty entries Delete it.
- Match: contributed command `{browser_palette}` (bare capture, the
  switch_to_tab shape) with `context: "palette"` — a new contribution field;
  the registrar gates palette-context commands on the palette tag instead of
  app-active, and adds `ClearsTags(palette)` so the mode ends at match time,
  not after the round trip. `palette_select` rides `handleOnAction` → SSE
  like every browser action; the extension background resolves row_id through
  its dispatch map and reuses the keyboard path's close-then-execute.
- Voice close: contributed "hide" with `context: "palette"` →
  `palette_dismiss` (same word as hint-hide, disambiguated by context —
  while the palette is open the hint "hide" is suppressed by exclusivity,
  and vice versa when closed). Voice open: "palette" on `toggle_palette`.

**Stuck-tag safety** (an orphaned exclusive tag would suppress everything):
- Palette page closes itself on window blur (OS focus leaves the browser),
  which drains entries and clears the tag through the normal path.
- Plugin drains palette entries + tag whenever the focused source changes or
  browser focus is lost (`recomputeFocusedSourceLocked`), and on the
  publisher's SSE disconnect.
- Extension background clears on tab close (`tabs.onRemoved`) as backstop.

**Publish-once discipline:** codewords are assigned to ALL rows at open and
never reassigned on refilter — one collection replace at open, one drain at
close, nothing mid-utterance. Filtering only changes what's rendered; a
row's badge (and grammar entry) is stable for the palette's lifetime. All
entry words are alphabet words already in the engine union (grammar seed
`browser_palette: alphabet` declares it), so opening the palette costs no
HLG recompile — only the exclusive narrow does, at a boundary.

## Tab verbs (Vimium parity) — shipped 2026-07-01

The mechanical verbs that need no palette. Every verb has both a keyboard
bind and a voice phrase. One background handler (`handleTabAction`,
background.ts) serves both entry points:

- **Keyboard:** content dispatcher registration → `TAB_ACTION` message
  (replaced the old `SWITCH_TAB`) → background.
- **Voice:** intercepted in the background's `handleSSEEvent`
  (`TAB_ACTION_BY_ID`) *before* content forwarding, so tab verbs work even
  when the active page has no content script (chrome:// pages, PDFs).

Per the always-mode keyboard constraint above, every default bind is a
Shift-chord (bare letters are hint-filter input while badges are painted).

| Command | Keys | Voice | Notes |
|---|---|---|---|
| `next_tab` / `previous_tab` | Shift+L / Shift+H | "next tab" / "previous tab" | Layer 1, now voiced |
| `new_tab` | Shift+O | "new tab" | |
| `close_tab` | Shift+X | "close tab" | |
| `restore_tab` | Shift+Z | "reopen tab", "restore tab" | `chrome.sessions.restore()`; added the `sessions` permission (no new install warning — `tabs` already carries the history warning) |
| `duplicate_tab` | Shift+Y | "duplicate tab" | |
| `pin_tab` / `mute_tab` | Shift+P / Shift+M | "pin/unpin tab", "mute/unmute tab" | Toggles |
| `first_tab` / `last_tab` | Shift+1 / Shift+9 | "first tab" / "last tab" | Position (Cmd/Ctrl+9 convention). "last tab" means *rightmost*, not recency — recency is `last_active_tab` |
| `goto_tab` | unbound (mappable, `index` param) | "tab {number}" | 1-based, clamped |
| `move_tab_left` / `move_tab_right` | Shift+, / Shift+. | "move tab left/right" | Vimium `<<` / `>>`, clamped (no wrap) |
| `last_active_tab` | Shift+6 (`^`) | "swap tab" | Layer 0's recency stack: `background/tab-mru.ts`, MRU in `chrome.storage.session`, pushed on `tabs.onActivated`. Cross-window (focuses the tab's window) |

## Follow-ups beyond tabs (not this note's scope, recorded while fresh)

- **Bookmarks:** two halves sharing one design pass. Palette half = source #3
  via the source interface. Voice half = a published collection of bookmark
  titles ("bookmark \<name>"), same machinery as Layer 3's tab collection and
  the same lexicon/distinctive-words cares. Both need the `bookmarks`
  permission — batch its addition with a store update (a new permission on
  update disables the extension until re-approval when it carries a new
  warning; `bookmarks` does carry one).
- **Window verbs** (move tab to new window, close others/left/right): more
  Vimium-C parity, same `handleTabAction` shape if wanted.
