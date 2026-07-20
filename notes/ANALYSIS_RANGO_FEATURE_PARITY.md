# Rango feature-parity analysis — what we're missing (and what we're not)

**Status:** analysis, 2026-07-19. Prompted by the store-submission note's line
"we request fewer permissions than Rango." That's true, but it raised the
question: do the extra permissions mean Rango has features we lack? Answer:
**mostly no** — and the real gaps are mostly permission-free.

Sources: Rango readme/command reference (github.com/david-tejada/rango), our
`command-catalog.ts` (58 commands) read this session.

## The reframe: Rango's extra permissions are NOT four missing features

| Rango permission | What it powers in Rango | Our status |
|---|---|---|
| `clipboardWrite` | copy link / text / markdown from Talon (no user gesture) | We already copy (`clipboard.ts` via Clipboard API + execCommand). Works on keyboard gesture; **voice-driven copy may need the permission** — verify. |
| `clipboardRead` | **`paste to <target>`** — paste clipboard into a field | **Real gap** (see G3). This is the one permission tied to a genuinely missing feature. |
| `contextMenus` | right-click menu: "Add keys to exclude" (per-site), quick actions | **Convenience/discoverability gap** (G8). We have no browser context menu. |
| `notifications` | OS notifications for command feedback | **Not a gap — we chose better.** We use in-page toasts (`render/toast.ts`), no permission, works in fullscreen/unfocused pages. Do NOT add. |
| `bookmarks` | unclear from the readme (URL completion? open-bookmark?) | **Unclear — probably low value.** Verify Rango's actual use before treating as a gap. |

So: of four "extra" permissions, one maps to a real feature (paste), one to a
convenience (context menu), one we deliberately do better (toasts vs
notifications), one is unclear. The permission count is not a feature-count.

## Where WE are ahead of Rango

Worth stating so the gap list is honest:
- **Command palette + tab palette** (`toggle_palette`, `toggle_tab_palette`) — Rango has none (its "tab hunt" is our tab palette).
- **Page zoom** (`zoom_in/out/reset`) — Rango only resizes hints.
- **Rich media/video control** (`media_play_pause/mute/speed/seek/restart/pause_all/mute_all`, `video_mode`) — Rango has only basic audio-tab commands.
- **Vim-style position marks** (`mark_set/mark_jump`, local+global) and **caret/visual-line modes** (`caret_mode`, `visual_line_mode`, `caret_voice`).
- **Tab management breadth** (`duplicate/pin/mute/move-left/right/goto-N/last-active/switch-by-codeword`).

## The real gaps (prioritized)

### Permission-FREE (pure capability — no new manifest risk)

- **G1 — Text-based element targeting** (`follow <text>` / `button <text>`):
  click the element whose visible text best matches what you say/type, WITHOUT a
  hint badge. We are hint-badge-only. **Highest-value gap** — huge voice
  ergonomics win ("click Submit" with no codeword read), and a common
  accessibility pattern. Needs a fuzzy text→element matcher over the same
  candidate set the scanner already builds.
- **G2 — Named element references** (`mark <target> as <text>`, `mark show`,
  `mark clear`): give an element a custom name, refer to it later. We have stable
  auto-codewords (`labels/codeword-memory.ts`) but no user-assigned names. Power-
  user / scripting feature; overlaps our codeword-stability work.
- **G5 — Show element info** (`show <target>`): tooltip with a hinted element's
  title/URL without acting. Small, useful for links.
- **G6 — Open an element's own context menu** (`menu <target>`): synthesize a
  contextmenu event on a hinted element. NOT the browser context-menu permission
  — a content-script event. Small.
- **G7 — Text insertion into a targeted field** (`insert <text> to <target>` /
  `enter <text>`): type/submit text into a specific hinted field. We have
  `focus_input` + `insert_mode` (keyboard passthrough) but not "put THIS text in
  THAT field" — matters most for voice.
- **G9 — Interactive per-element hint curation** (`include`/`exclude <target>`,
  `custom hints save`, `hint extra` for poor-accessibility elements): user tunes
  which elements get hints, persisted per-site. We have static exclude rules
  (`rules/`) but no interactive save. `hint extra` (force hints where a11y is
  poor) is the notable sub-feature.
- **G10 — Tab split / directional close** (`tab split` to a new window;
  `close left/right/other`). We have most tab ops; these few are missing.

### Permission-NEEDING (weigh the permission cost)

- **G3 — Paste into field** (`paste to <target>`): needs `clipboardRead` (or a
  user-gesture path). The single feature genuinely behind a Rango permission.
  Pairs with G7. Worth it if we add text-input-to-target at all.
- **G4 — Copy as markdown / URL parts** (`copy mark`, `copy page host|path|...`):
  formatting layer on our existing copy. `clipboardWrite` only needed for the
  voice/no-gesture path. Low effort, low risk.
- **G8 — Browser context menu** (`contextMenus`): right-click quick actions +
  per-site key exclusion. Adds a permission (innocuous, no scary warning) mostly
  for discoverability. Defer unless we want the discoverability win.

## Recommendation

1. **G1 (text targeting) is the standout** — permission-free, biggest UX gain,
   fits our scanner. Strongest single addition.
2. **G7 + G3 (text-into-field, then paste-into-field)** as a pair — the paste
   half is the only thing that justifies `clipboardRead`; decide together.
3. G4, G5, G6, G2 are cheap follow-ons, no new permissions.
4. Do **not** add `notifications` (toasts are better). Verify Rango's `bookmarks`
   use before considering it; likely skip.

None of this blocks store submission — the current set is coherent and shippable.
This is a post-launch feature roadmap, sequenced by value ÷ permission-cost.
