# Design: Palette Keyboard Modes + Bare Vim Navigation

Status: proposal. Scope: all four palette scopes (`tabs`, `commands`,
`bookmarks`, `all`). Supersedes the narrow tab-palette-only version of this note.

Two things, and they need each other:

1. **Walk the list with the keys that scroll a page** — `j`/`k` a row, `d`/`u`
   half a screen, `g`/`G` the ends — instead of leaving the home row for arrows.
2. **One keyboard model across every palette.** Today only the tab palette has a
   letter mode; the others open straight into a text box. That asymmetry is
   invisible and it misleads — the author of the feature expected `/`-to-search
   everywhere and was surprised to find it tabs-only. That is the strongest
   available evidence the current shape is not learnable, and it is why this note
   grew from "add nav keys" to "unify the modes".

## Not a page-hint problem

State this first, because the intuitive read is wrong and costs an afternoon:
**nothing bound inside the palette can shadow a page hint.** Three independent
layers already guarantee it.

- The palette is an extension-origin iframe that takes focus on open, so page
  keydowns never fire. The mode-stack entry says so in as many words:
  `capture: 'none'`, with `peelable: false` because the iframe owns focus
  (`src/core/mode-stack.ts:200-215`).
- `PaletteHolder` is `claim = 'exclusive'` at `EXCLUSIVE_OVERLAY_PRIORITY`
  (`src/palette/palette-holder.ts:60-64`), so `holder-registry` short-circuits
  every in-page codeword query to `swallowed`.
- The plugin holds `plugin.browser.palette` with `exclusive: true`
  (`plugins/browser/plugin.json:158-168`), so the matcher suppresses every
  non-palette command for voice.

Two framings rejected on that basis, recorded so they are not re-proposed:
excluding the nav letters from `LETTERS_26` would tax hint labels on every page
to fix a collision that does not exist, and an "`f` arms hints" gate is page-side
machinery the palette iframe never sees.

The conflict is with the palette's **own** two label surfaces, both of which
consume bare letters:

1. **Tab marks** — `buildMarkerSequence` (`src/background/tab-markers.ts:41-50`):
   the first `MARKER_SINGLES = 16` letters of the ergonomic head are singles, the
   disjoint tail forms pairs. Prefix-free, so a single activates on one keystroke.
   The default head is `a s d f g h j k l q w e r t y u`, so `d j k u` are all
   single-letter marks today.
2. **Row badges** — `assignCodewords` (`src/palette/codewords.ts:122`), a
   uniform-length codeword per row, assigned once per open.

## The mode model

**Every scope has both modes. Letter mode is the default. `/` enters search.**

| | Letter mode (default on open) | Search mode |
|---|---|---|
| Bare letters | activate a mark/badge | query text |
| `j k d u g G` | navigate the list | query text |
| `/` | → search mode | query text |
| Arrows, `Tab`/`Shift+Tab`, `Enter` | navigate / activate | same |

Uniform Escape, three clauses, **no per-scope branching**:

1. A typed prefix is pending → clear it.
2. In search mode → return to letter mode (clearing the query).
3. Otherwise → close.

That deletes the current `scope === 'tabs' ? enterLetterMode() : close()` special
case at `palette-page.ts:557` and the tabs-only guard on `enterLetterMode()` at
`:721`, and `mode`'s initial value flips from `'fuzzy'` (`:120`) to `'letter'`.

**Dismissal does not regress.** A fresh palette opens in letter mode with no
prefix, so clause 3 fires and one Escape closes it — same as today. The
two-press path only exists after you have entered search, which is exactly when a
step-back is wanted.

**What it costs: `/` before typing a command name.** That is a real keystroke on
the command palette's dominant path, and it is the price of the uniform model —
accepted deliberately, because the alternative is the invisible asymmetry that
prompted this note. Partly offset: in letter mode a command is reachable in two
keystrokes via its badge, against `/` plus three or four characters of its name.

**Letter mode works for badges because the tiers are already uniform-length.**
`assignCodewords` gives every row in an open a badge of the *same* length —
chosen as the chop-safety property (`codewords.ts:9-21`) — and uniform length is
prefix-free for free. So `classifyMarkInput` generalizes to badges with no new
invariant. One detail: classify against the **letter form**,
`codewordDisplay(cw, alphabet, 'letter')` → `"qr"`, not `codewordToken`'s
space-separated `"q r"`.

**The mode must be visible.** `src/render/mode-chip.ts` exists for precisely this
failure and states the reason in its header: *"the user can't tell from the page
whether a letter fires a keybind (Normal) or filters a hint (Hint) — so the mode
is shown."* Same problem, same answer — a footer indicator in the palette. Not
literal reuse: mode-chip is a page content-script component in a shadow root and
the palette is an iframe, so this is a sibling following the same rationale.

`#footer` (`palette.html:134`) is the place, but it is not empty: it starts
`hidden` and already carries the dictation chip (`palette-page.ts:660-663`) and
the bookmarks palette's sticky three-verb footer (`:667-674`). The mode indicator
has to coexist with those rather than own the row — and it must be visible in
both modes, so the footer can no longer be `hidden` by default.

## Reserving the nav letters

Bare `j` cannot both navigate and type mark `j`. So the nav letters are withheld
from **both** label pools at open, and pressing one navigates.

**Derive the set, don't hardcode it.** The frame already imports `loadKeymap` and
`COMMAND_CATALOG` (`src/palette-page.ts:18-19`) to render live keybinds on
command rows. Collect the bindings of the *vertical* list-navigation family:

| Command | Default | Palette meaning |
|---|---|---|
| `scroll_down` | `KeyJ` | selection +1 |
| `scroll_up` | `KeyK` | selection −1 |
| `scroll_half_down` | `KeyD` | + half a screen |
| `scroll_half_up` | `KeyU` | − half a screen |
| `scroll_top` | `KeyG KeyG` | first row |
| `scroll_bottom` | `shift+KeyG` | last row |

**The reservation test mirrors the mark consumer rather than inventing a parallel
rule.** A key collides exactly when it satisfies the predicate at
`src/palette-page.ts:546` — single-character `e.key`, no Ctrl/Meta/Alt — because
that branch calls `typeMarkLetter(e.key.toLowerCase())`. Read straight off it:

- **Shift+letter collides.** Shift is absent from the guard, `e.key` for Shift+G
  is `"G"` (length 1), and the regex is case-insensitive with an explicit
  `.toLowerCase()`. So `shift+KeyG` types mark `g` today, and reserves `g`.
- **Ctrl / Meta / Alt chords do not collide** and reserve nothing.
- **Every step of a sequence collides.** `KeyG KeyG` reserves `g` because the
  first press is eaten as a mark before the second arrives. `KeyG KeyT` would
  reserve both `g` and `t`.

Consequences, all wanted:

- `scroll_left`/`scroll_right` (`h`/`l`) are **not** in the family — a list has no
  horizontal axis — so `h` and `l` stay label letters.
- Non-family sequences like `KeyZ KeyI` (zoom) reserve nothing and simply do not
  work in the palette. Correct: zoom is not a palette action.
- Arrow-key users reserve nothing and lose no capacity. A Colemak user on `n`/`e`
  reserves those automatically.

With shipping defaults the reserved set is **`d g j k u`** — five letters. This
anchors eligibility on the command's structural role in the catalog rather than a
per-key list (`feedback_generalize_on_matching_role`), from one source, so there
is nothing to keep in sync (`feedback_no_dual_sync_coupling`).

Reserving beats arming a mode. Jumping to a tab by its mark is the tab palette's
whole purpose; putting it behind an arming keystroke taxes the common path to
save five letters out of twenty-six that we have measured headroom for.

### Capacity

All five default letters fall in the 16-letter ergonomic head, so tab-mark
singles lose five and the pair pool is untouched:

| Pool | Today | With `d g j k u` reserved |
|---|---|---|
| Tab marks (`MARKER_SINGLES = 16`) | 16 singles + 90 pairs = **106** | 11 singles + 90 pairs = **101** |
| Badges, singles tier | 26 | 21 |
| Badges, pairs tier | 650 (26×25) | 420 (21×20) |
| Badges, triples tier | 15,600 | 7,980 |

Five tabs off a 106-tab ceiling. The badge cost bites one narrow band: a palette
of 421–650 rows now needs triple-word codewords where pairs used to fit. That is
a voice-verbosity cost for heavy-bookmark users only, and it buys typeable badges
in every palette.

### The trap in `codewords.ts`

Do **not** implement badge reservation by shortening the alphabet array. That
array is the letter↔word dictionary:

- `assignCodewords` hard-rejects `alphabet.length !== 26` (`codewords.ts:127`).
- `codewordDisplay` indexes `'abcdefghijklmnopqrstuvwxyz'[i]` by alphabet
  position (`:88`).
- `codewordToken` maps word→letter via `indexOf` with an `idx > 25` guard
  (`:217`).

Shorten it and every badge silently binds to the wrong letter — the same class of
bug the file's own header warns about when it explains why the parameter is the
assigning array and "deliberately NOT `LETTERS_26`".

Give the *unranking* an eligible-letter subset while display and token mapping
keep all 26: `codewordAt` builds `pool` from the eligible letters, and
`codewordLength` takes the eligible count instead of hardcoding 26.
`buildMarkerSequence` takes the same reserved set and filters head and tail
before pairing, so the split stays disjoint and marks stay prefix-free.

## What `d` / `u` mean

**Half the visible rows, floored, minimum 1.**

The key is bound to `scroll_half_down`. If `d` means half a screen on the page
and three quarters of one in the palette, that is a divergence to remember for no
gain — "half" is inherited from the binding rather than invented
(`feedback_structural_vs_content_opinion`). 75% was considered and rejected on
that basis; it also leaves only a sliver of overlap, where half guarantees you
land on a row that was already on screen, so a jump is never blind.

**Measure, don't hardcode.** `#list` is `max-height: 52vh`
(`palette.html:42-43`) with ~23px rows, so visible rows scale with window height
— roughly 20 at 900px, half that on a short window. Count the `.row` elements
intersecting the scroll viewport: exact, and it absorbs section headers and any
future variable-height row without a second rule. Keep measurement in the DOM
caller and arithmetic in a pure `paletteJumpStep(visibleRows)`, matching how
`classifyMarkInput`, `filterPalette` and `buildMarkerSequence` already separate
pure core from glue.

**`j`/`k` wrap; `d`/`u`/`g`/`G` clamp.** `moveSelection` already wraps modulo
`flat.length` (`:396-400`), right for a single-row step on a short list. A
half-screen jump that teleports bottom-to-top is disorienting, so the jumps
clamp — and clamping means `d` at the bottom lands exactly on the last row
rather than no-oping, so repeated `d` walks to the end.

## Top and bottom: a single `g`, no sequence machinery

**`g` jumps to the first row, `G` to the last.** No pending-prefix state, no
partial-match timeout in the frame. `Home`/`End` are wired to the same two
actions; they collide with nothing and cost two lines.

The page needs `gg` only to disambiguate its `g`-prefix family (`gg`, `gi`, `gu`,
`gs`). None of that exists inside the palette, so the disambiguation buys
nothing. And the muscle-memory objection dissolves: **`gg` still does the right
thing**, because jumping to the first row is idempotent — the first press lands
there and the second is a no-op. Both habits produce "top". A timeout would add
state whose only observable effect is making the first `g` wait.

### Why `G` is safe when Shift means "new tab" elsewhere

Shift is already spoken for on the hint surface: in hint mode
`src/activate/keyboard.ts:608` sets `newTabArmed = true` on any Shift-typed hint
letter, and `:373-374` promotes the pending action to `'newtab'`. Capitals mean
"open in a new tab". The palette has the same feature designed but voice-only —
`palette_select_newtab` (`'blank {palette}'`, dispatched at
`src/background/sse-events.ts:158`), whose catalog comment already speaks of "the
modifier", so the keyboard form is anticipated rather than hypothetical.
`dispatchItem` (`src/palette-page.ts:134-136`) is modifier-blind today, so
nothing collides yet — but `G` must not foreclose it.

It doesn't, and the reason is the reservation itself: **reserved letters and label
letters are disjoint sets by construction.** One rule, no ambiguous case:

> Shift+letter opens that letter's row in a new tab. A reserved letter labels no
> row, so Shift on a reserved letter performs its nav command's shifted variant.

There is no row labelled `g` for `Shift+G` to open, so `Shift+G` can only mean
`scroll_bottom`. Every other capital stays available for the new-tab keyboard
path when it lands. The disjointness the pools already guarantee for chop-safety
does second duty here, and it generalizes with the derivation: whatever letter
carries `scroll_bottom`, its shifted form is claimable for the same reason.

## Accepted costs

- **`/` before typing a command name.** Discussed above; the price of the uniform
  model.
- **Stale marks after a keymap edit.** Tab marks are assigned in the background
  and stable for a tab's lifetime by design (`tab-markers.ts:18-21`). Rebind
  scrolling and an already-open tab holding a now-reserved letter keeps a mark
  that no longer activates, until it closes. Let it drain rather than reassign:
  perceptual continuity is the point of the pool model, and keymap edits are rare.
- **Triple-word badges in the 421–650-row band.** Voice verbosity for
  heavy-bookmark users, in exchange for typeable badges everywhere.
- **Reserved-set churn is open-scoped.** Labels are assigned once per open
  (publish-once discipline), so the set is read at open and a keymap edit applies
  at the next one. No mid-session reassignment — re-deriving on every `/` would
  reassign badges mid-open, the temporal chop hazard
  `DESIGN_PALETTE_ADAPTIVE_CODEWORDS.md` rejected Part 2 over.

## Non-goals

- Any change to page hint labels, `LETTERS_26`, or `label-pool.ts`.
- Configurable palette-side bindings. Ship the derived defaults; if it ever needs
  real config, the shape is `palette_next` / `palette_prev` / `palette_next_page`
  / `palette_prev_page` as catalog entries under a `palette` group, not a second
  keymap surface.
- Reviving the deleted `SINGLES` head/tail knob for badges. Tiering subsumed it.
- The Shift+letter new-tab keyboard path. Reserved for it, not building it.

## Implementation

Two phases, each coherent alone. Phase 1 changes only the tab palette's
behaviour; phase 2 is where the other scopes gain letter mode, and it lands the
badge reservation in the same commit as the benefit that pays for it.

**Phase 1 — mechanics + tab palette**

1. `src/keymap/palette-reserved.ts` (new, pure + tested): given `KeymapEntry[]`,
   return the reserved letter set. For each vertical-nav-family binding, walk
   **every step** of the sequence (parse with `key-combo.ts`, don't hand-split),
   keep steps with no Ctrl/Meta/Alt whose code is `Key<A-Z>`, map to the lowercase
   letter. Shift is ignored when deciding — `shift+KeyG` reserves `g` — because
   that is what `:546-548` eats.
2. `src/background/tab-markers.ts`: `buildMarkerSequence(singles, reserved)`
   filters head and tail before pairing; background reads the keymap from
   `chrome.storage.sync`.
3. `src/palette-page.ts`: pure `paletteJumpStep(visibleRows)`; a `clampSelection`
   sibling to `moveSelection`; a nav branch with the common navigation at `:513`,
   **above** the letter-mode consume at `:546`.
4. The Escape rule and the footer mode indicator.

**Phase 2 — letter mode everywhere**

5. `src/palette/codewords.ts`: `codewordLength(rowCount, eligibleCount)`;
   `codewordAt` unranks over the eligible sublist; display and token paths
   unchanged and still 26-wide.
6. `src/palette-page.ts`: drop the `scope === 'tabs'` guards at `:524`, `:557`
   and `:721`; `mode` initialises to `'letter'`; letter mode classifies against
   `codewordDisplay(cw, alphabet, 'letter')` for non-tabs scopes.

**Tests.** Reserved-set derivation (defaults → `{d,g,j,k,u}`; arrows → empty;
`KeyG KeyT` → `{g,t}`; `ctrl+KeyD` → empty). Marker-pool prefix-freedom and
capacity under reservation. `paletteJumpStep`. Badge prefix-freedom under a
reduced alphabet, and that `codewordDisplay`/`codewordToken` still round-trip
through the full 26. The Escape ladder per mode. `palette-page.ts` has no test
file today — the pure helpers are where the coverage goes.

## Open questions

1. **A tab's handle differs between scopes.** `palette-page.ts:588-597` gives
   tabs their stable marks in `tabs` scope but positional `assignCodewords`
   badges in `all` scope — so with letter mode everywhere, the same tab is typed
   as `f` in one palette and `qr` in another. Pre-existing, newly visible.
   Probably wants `all` scope to prefer a tab's mark, which means mixing mark and
   badge label lengths in one open — and that reopens chop safety, so it is not a
   one-liner. Decide before phase 2 ships.
2. **`MARKER_SINGLES` retune — raising it is a *bad* trade.** All five reserved
   letters sit in the head, so 16 now yields 11 singles. The instinct is to raise
   it; the arithmetic says don't, because letters moved head-ward cost the pair
   pool quadratically:

   | `MARKER_SINGLES` | Singles | Pairs | Total |
   |---|---|---|---|
   | 12 | 8 | 156 | **164** |
   | 16 (today) | 11 | 90 | **101** |
   | 18 | 13 | 56 | **69** |
   | 21 | 16 | 20 | **36** |

   Singles-count and total capacity pull in opposite directions, and reservation
   shifts the optimum *down*. 16 is a defensible middle; changing it wants real
   peak-tab-count data, which the open question in `DESIGN_TAB_MARKERS.md` also
   wants — resolve them together, not here.
3. **Does the footer indicator need a first-run nudge?** The `/`-to-search step is
   the one genuinely new thing a returning user must learn. A persistent footer
   hint may be enough; if not, the answer is a one-time line, not a tour.
4. **Keymap editor warning text.** `DESIGN_KEYMAP_CONFIG.md` warns on bare
   lowercase letters because they type codewords in always-mode. After this,
   binding vertical nav to a bare letter also shrinks the palette pools — worth a
   clause, low priority.
