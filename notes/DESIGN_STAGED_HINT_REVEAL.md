# Staged Hint Reveal and Discovery HUD

**Status:** Partially landed (marker added 2026-05-30). Phase 1 (first-word
display mode) shipped 2026-05-18 — `setMatchedChars` + the `'first-word'`
display-mode case in `src/render/hints.ts`. Phase 2 (Discovery HUD) and Phase 3
(voice narrow action) are **unbuilt** (`DiscoveryHUD` does not exist in `src/`).

## Problem

On pages with many hintable elements, showing full two-word labels ("arch bake") creates visual noise. Users need to read and remember both words before speaking, which slows the interaction. The first word narrows the set dramatically (26 options per prefix), but the second word requires scanning scattered badges across the page.

## Prior Art

### Vimium (keyboard-first, two-letter codes)

- Shows all hint codes upfront as full pairs ("SA", "DG").
- First keypress hides non-matching hints entirely (`display: none`).
- Matched prefix is highlighted within remaining hints.
- Hint assignment spatially clusters same-prefix codes: links in the same screen region share a first letter, so the first keypress acts as a "zoom to region." This is an algorithmic trick in the assignment, not a UI feature.
- No HUD or status indicator. Feedback is entirely in the hint markers.
- Auto-activates when a single match remains.

### Rango (voice-first, two-letter codes)

- Persistent labels overlaid at all times. No progressive narrowing.
- Voice input is atomic: user speaks both letters as a single utterance.
- No intermediate filtering state because the input model is a complete phrase, not character-by-character.
- Labels optimized for acoustic distinctiveness, not typing efficiency.
- No HUD or discovery overlay.

### Surfingkeys (keyboard, configurable alphabet)

- Similar to Vimium: full codes upfront, first key hides non-matching.
- "Rich hints" feature shows additional context about targets.
- Regional hints mode (L key): spatial narrowing by selecting a page region first.

### Tridactyl (keyboard, text-filter option)

- Vimperator filter mode: type link text to narrow, then type numeric code to select.
- Separates "I know roughly what I want" from "I'm selecting exactly."
- `;` prefix for secondary actions with no discovery of available options -- a known UX gap.

### What Nobody Ships

- No extension shows a discovery HUD listing filtered options.
- No extension shows a "you've typed X" status indicator.
- No extension adapts hint code length to page density.

## Design

### New Display Mode: First Word

A fourth `BadgeDisplayMode` value: `'first-word'`.

**Stage 1 -- Browsing (passive overlay)**

Badges show two parts: first word + second letter. E.g., "arch l", "bake d", "cape a". Always a unique identifier per element. Benefits:

- Lower visual noise than two full words ("arch lime"), but still uniquely identifies each element.
- The word is readable at a glance; the letter is compact.
- Proportional to surrounding text (adaptive font sizing).

**Stage 2 -- Narrowing (after first word is spoken/typed)**

When the user speaks the first word or types its first letter:

1. Non-matching badges hide (existing `setFiltered` behavior).
2. Matching badges transform: the matched first word collapses to its letter (dimmed), and the second codeword expands to the full word. "arch" becomes "**a** bake", "**a** cape", "**a** dune". This keeps the badge compact (avoids overlapping nearby badges) while revealing the second word the user needs to say.
3. If the discovery HUD setting is enabled, a floating panel also appears listing the options.

The inline badge expansion is the primary discovery mechanism. The HUD is supplementary -- it helps when matching badges are scattered across a long page and hard to scan visually.

**Stage 3 -- Selection**

User speaks the second word or types the second letter. The matching element activates.

### Discovery HUD (Optional)

A toggleable floating panel that appears during Stage 2. Controlled by a setting (`discoveryHud: boolean`, default off).

Positioned at a fixed viewport location (bottom-center or top-right).

Content:

```
a  bake   [Sign In]
   cape   [Search]
   dune   [Submit]
   elm    [Home]
   ...
```

Each row: second word + truncated accessible name of the target element. Sorted by DOM order (matching badge visual order on page).

**Properties:**

- Shadow DOM, same isolation as badges.
- Appears with a fast fade-in (100ms).
- Dismisses on Escape, second word selection, or clicking outside.
- Max 26 rows (one prefix never has more than 26 suffixes).
- Scrollable if needed, but 26 rows at ~18px each fits most viewports.
- Keyboard: arrow keys navigate, Enter selects the highlighted row.

### Voice Integration

**Investigation result:** Vosk buffers the full utterance and emits one transcript with "arch bake" as a single string. The voice plugin's orchestrator splits it into words and processes them sequentially in one call -- "arch" fires a `noop` (prefix match), "bake" fires `activate` (suffix match). The browser plugin currently **discards the noop** and only forwards `activate` via SSE. The extension never sees the first word separately.

**Implications:**

- Keyboard narrowing works today without changes (user types letters one at a time).
- Voice narrowing requires a protocol change: the browser plugin must forward the prefix `noop` as a `narrow` SSE event so the extension can enter Stage 2.
- When the user says both words quickly, the `narrow` and `activate` events arrive back-to-back. The extension can skip Stage 2 rendering if `activate` arrives before the next animation frame.
- When the user says only the first word and pauses, Vosk finalizes after ~0.8s with just the prefix. The `narrow` event arrives alone, Stage 2 renders, and the extension waits for the second word.

**Protocol change (Phase 3):**

The browser plugin's `handleOnAction` should forward prefix-match noops as:

```
event: action
data: {"action":"narrow","params":{"prefix":"arch","letter":"a"}}
```

This is a small change in `plugins/browser/src/collections.go` -- add an SSE push for `browser.noop` actions that carry hint prefix info.

### Keyboard Integration

Keyboard flow maps naturally:

1. Press `f` to enter hint mode (badges show first words).
2. Type a letter (e.g., `a` for "arch") -- Stage 2: matching badges expand to full second words, HUD appears (if enabled).
3. Type second letter (e.g., `b`) -- element activates.
4. Or press Escape to cancel and return to Stage 1.

This is identical to the existing two-letter keyboard flow, just with the display changing from letters to words.

## Settings

The popup dropdown for hint labels becomes:

```
Hint labels:
  Letters      -- "ab"
  First word   -- "arch" (expands to full second word on match)
  Words        -- "arch bake"
```

A separate toggle for the discovery HUD:

```
Discovery HUD:  [on] / [off]
```

The "Both" option (`both`, currently shows "A arch") can be removed -- first-word mode is strictly more useful.

## Implementation Sketch

### Phase 1: First-Word Display Mode (no HUD) -- COMPLETE (2026-05-18)

1. ~~Add `'first-word'` to `BadgeDisplayMode` type.~~ Done: `src/types.ts`.
2. ~~In `labelToDisplay()`, return first word + second letter for first-word mode.~~ Done: `src/words.ts`. Two-word labels show "arch l"; single-word labels show just the word.
3. ~~Update `setMatchedChars()` for first-word mode.~~ Done: `src/hints.ts`. Stage 2 collapses first word to dimmed letter + expands second position to full word ("arch l" becomes "a lime"). Badge size cache invalidated on transform.
4. ~~Add popup option.~~ Done: `popup.html`. "First word" option between Letters and Words.
5. Unit tests for `labelToDisplay` first-word mode: `src/words.test.ts`.

This phase is useful on its own: less visual noise, and the inline expansion provides discovery without a HUD.

### Phase 2: Discovery HUD

1. New `DiscoveryHUD` class (shadow DOM panel).
2. `content.ts` creates the HUD when entering Stage 2 (if setting enabled).
3. Populate with filtered wrappers: second word + accessible name.
4. Keyboard navigation (arrows + Enter).
5. Auto-dismiss on selection or Escape.
6. Add toggle setting in popup.

### Phase 3: Voice Narrow Action

1. Verify Vosk sends individual word events (not buffered pairs).
2. Browser plugin adds `narrow` action handler if needed, or confirm existing `activate` with partial codeword works.
3. Test the full flow: say first word, see expansion, say second word, element activates.

## Resolved Questions

1. **Vosk word delivery.** Vosk buffers and sends both words as one transcript. The voice plugin processes them sequentially but only `activate` reaches the extension today. Protocol change needed for voice-triggered Stage 2 (Phase 3). Keyboard Stage 2 works without changes.

2. **Badge transform in Stage 2.** Decided: first word collapses to its dimmed letter, second position expands to the full word. "arch l" becomes "a lime". Keeps badges compact and clearly signals "first part consumed."

3. **Stage 1 display.** Decided: always show two parts (first word + second letter) so every badge is a unique identifier. No ambiguity, no need to wait for Stage 2 to distinguish elements.

4. **Fast two-word utterances.** When `narrow` and `activate` arrive back-to-back (user speaks both words quickly), skip Stage 2 if `activate` resolves before the next animation frame. Fast speakers get fast activation.

## Open Questions

1. **Spatial clustering.** Investigation confirmed this is a one-line change: replace the `rankByDistance` sort in `intersection-tracker.ts:214-221` with a top-left spatial sort (same comparator already exists as `viewportSort()` in content.ts). The pool's prefix-first ordering means contiguous claims share a prefix naturally. **Recommendation: do it.** The benefit is that the first word becomes a region selector ("arch" = top of page, "rain" = middle). Users develop spatial intuition over time. The cost is minimal -- focus-distance sorting gave slightly better labels to the focused element, but spatial predictability is more valuable. Independent of staged reveal, so can land separately.

2. ~~**Badge width change during Stage 2.**~~ Resolved: snap with no animation. `_size` cache is invalidated so placement can adjust, but no CSS transition on width.

3. **HUD positioning.** Bottom-center or top-right? Bottom-center is more visible but may overlap page content. Top-right is out of the way but requires eye movement. Could be user-configurable, but start with bottom-center and iterate.

4. **What replaces "Both" mode?** First-word mode ("arch l") subsumes "both" ("A arch"). Remove "both" from settings? Or keep for users who prefer it?
