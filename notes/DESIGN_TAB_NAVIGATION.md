# Design: Tab Navigation + Tab Switcher

**Status:** Proposal, 2026-06-17. Layer 1 (keyboard cycle) in progress.
**Goal:** Move between tabs (adjacent cycling) and jump to a specific tab (fuzzy search), via keyboard now and voice later — without building a keyboard-only thing that can't be reused for voice.

## Prior art (what we're borrowing)

- **Vimium** `TabCompleter` (`completion/completers.js:592`): `chrome.tabs.query({})` over ALL windows, substring-match query against **title + URL**, rank by word-relevancy when typing / **recency (MRU)** when the query is empty. Dispatch = focus the tab's window then `chrome.tabs.update(id, {active:true})` (`selectSpecificTab`, `main.js:176`). Cycling (`nextTab`/`previousTab`) is just neighbor-activate; `visitPreviousTab` reads a recency map.
- **Smart Tab Switcher**, **Modern Tab Switcher**, FuzzyTabs, Snipe, Tabber: same core; refinements worth stealing — combine **relevance + recency + frequency**, and **domain-first** ranking (match hostname before title, for many tabs on one site).
- **Voice prior art** ("Voice Actions for Chrome", etc.) validates **"switch to &lt;tab name&gt;"** — nobody's done it well alongside link hints, which is our opening.

## Core idea: tabs are a shared dynamic collection

The substrate is one thing, consumed by both input modes: **the set of open tabs, each with a searchable/spoken form and a recency rank.** Build this once; keyboard and voice both read it.

- **Keyboard** filters the collection in an overlay (sibling to the find bar / hints).
- **Voice** is a `switch to <tab>` command whose capture collection IS the tab set — the matcher's existing fuzzy/collection matching resolves it, **no new overlay UI**. This is the same machinery as the apps list (`open <app>`), so the voice version is nearly free once the collection is published.

**Unifying move:** reuse the **hint codeword system** for tabs. The switcher overlay shows a codeword badge per tab (the phonetic alphabet), so you select by **typing the fuzzy title OR speaking the codeword** off the same surface. Keyboard↔voice stay symmetric instead of two systems.

## The keyboard constraint (load-bearing)

In **always-visible hints mode**, `KeyHandler.handleKeyDown` (keyboard.ts:90) routes every letter key to **hint-filtering** — normal-mode keybinds (scroll, find, and any `gt`/`gT` tab binding) are shadowed while hints are painted. Implications:

- Plain letter/sequence tab keybinds (`gt`/`gT`) work in **manual mode / hints-hidden**, but NOT for an always-mode user mid-hint.
- To serve always-mode from the keyboard, a tab command must be **special-cased in `handleHintKey`** (like Escape/Backspace/Enter already are) using a **non-letter trigger** (letters are all hint-filter input), OR the switcher is **its own overlay/mode** opened by such a trigger.
- **Voice has no such conflict** — it works regardless of hint state. So for always-mode the voice path is the natural primary; keyboard cycling is the secondary affordance for hints-hidden contexts.

This is the main open design decision: which non-letter trigger (if any) opens the switcher / drives cycling in always-mode.

## Layered plan

**Layer 0 — shared substrate.** Background SW maintains the open-tab set + a **recency stack** (push tab id on `tabs.onActivated`; the extension already tracks active-tab via the focus handshake — reuse it). A single `switchTo(tabId)` = focus window + activate (mirror Vimium). This is what every layer calls.

**Layer 1 — adjacent cycling (this PR).** `next tab` / `previous tab` (cycle within current window), `last tab` (recency toggle — needs the recency stack, fast-follow). Keyboard defaults **Shift+H = previous, Shift+L = next** (Vimium convention), rebindable. These work in always-mode because a Shift+letter routes to the command path (the decouple in `keyboard.ts`), not the codeword filter — unlike a letter/`gt`-style sequence, which the hint filter would eat. Voice: static `next tab` / `previous tab` / `last tab`. Trivial — `chrome.tabs.query({currentWindow})` + `cycleTabIndex` + activate. NOTE: if BranchKit owns Shift+H/L, drop the same mappings from Vimium-C to avoid double-switching.

**Layer 2 — fuzzy switcher overlay.** A new overlay mode filtering the tab collection: **MRU default**, title+domain relevance on type, codeword badges per tab (reuse hints). Opened by a non-letter trigger (resolves the always-mode constraint). Enter / spoken codeword switches.

**Layer 3 — voice "switch to &lt;tab&gt;".** Publish the tab collection to the plugin (like the apps list); add a `switch to <tab>` command consuming it. Falls out of Layer 0 + the existing matcher; no overlay needed.

**Ranking:** start MRU (recency stack). Add title+domain relevance on typed query. Frequency is v2. Don't reinvent — port Vimium's `wordRelevancy` + `recencyScore` shape if it helps.

**Phasing rule:** never build a keyboard overlay that can't be reused for voice. Layer 0's collection + recency is the shared core; everything else consumes it.
