# Rango-Inspired Improvements for BranchKit Browser

Reference clone at `/tmp/rango` (david-tejada/rango).

## Status

| # | Technique | Effort | Status |
|---|-----------|--------|--------|
| 1 | Layout caching | Medium | Done |
| 2 | Stacking context + z-index | Medium | Done |
| 3 | Sticky header detection | Medium | Done |
| 4 | Focus-driven visibility | Low | Done |
| 5 | Event dispatch order | High | Done |

Items 6 (deep shadow DOM) and 7 (scroll region detection) are already implemented in BranchKit.

## Sequencing

```
Phase 1 (foundation)     Phase 2 (polish)
                         
1. Layout cache ──────┐  4. Focus visibility
                      │  5. Event dispatch
2. Stacking context ──┘     
3. Sticky headers
```

Layout cache lands first because stacking context detection hammers `getComputedStyle` and `getBoundingClientRect` across many elements. Without caching, adding z-index calculation to every badge would cause layout thrashing on pages with 100+ hints.

Stacking context detection depends on cached styles. Sticky header detection is independent but completes the "hints render correctly" story before moving to interaction polish.

Phase 2 items (focus visibility, event dispatch) are independent of each other and of Phase 1, but are lower priority because they affect interaction quality, not visual correctness.

---

## 1. Layout Caching

**Problem:** Every `updatePosition()` call reads `getBoundingClientRect()` live. For 200 hints repositioning on resize, that's 400+ forced reflows.

**Rango's approach** (`layoutCache.ts`, 202 lines): Six `Map` caches for bounding rects, offset parents, text rects, client dimensions, and computed styles. `cacheLayout(targets)` batches reads for a set of elements + their ancestors (up to 10 levels). Getter functions check cache first, fall back to live reads. Cache is cleared after each render pass.

**BranchKit changes:**
- New file: `layout-cache.ts`
- `hints.ts`: `updatePosition()` uses cached getters instead of live reads
- `content.ts`: call `cacheLayout()` before batch operations (show, reposition), `clearCache()` after

**Rango reference:** `/tmp/rango/src/content/hints/layoutCache.ts`

---

## 2. Stacking Context Detection + Z-Index Calculation

**Problem:** BranchKit hardcodes `z-index: 2147483647`. On pages where elements create stacking contexts (transforms, filters, opacity < 1, will-change), badges can render behind interactive elements. Gmail, Notion, and Figma all trigger this.

**Rango's approach** (90 lines across two files):
- `createsStackingContext(el)` checks 13+ CSS properties: position + z-index on flex/grid children, fixed/sticky, opacity < 1, mix-blend-mode, transform, filter, backdrop-filter, perspective, clip-path, mask, isolation, will-change
- `calculateZIndex(target)` walks descendants for max z-index among stacking contexts, then walks ancestors resetting at each new context boundary. Returns `max + 5` (safety buffer for hover-triggered z-index changes)

**BranchKit changes:**
- New file: `stacking-context.ts` (port `createsStackingContext` + `calculateZIndex`)
- `hints.ts`: replace hardcoded z-index on host with calculated value in `show()`
- Cache the calculated z-index per badge (don't recalculate on every reposition)

**Rango reference:**
- `/tmp/rango/src/content/hints/positioning/createsStackingContext.ts`
- `/tmp/rango/src/content/hints/Hint.ts` lines 151-189

---

## 3. Sticky Header Detection During Scroll

**Problem:** BranchKit's `snapToElement()` detects sticky headers at 3 fixed probe points before scrolling, but doesn't re-check after scroll completes. Sites with stacked sticky headers (Slack, Discord, Gmail) can still occlude the target.

**Rango's approach** (`scroll.ts`, 115 lines in `snapScroll()`):
1. Before scroll: `elementsFromPoint()` at the target's pre-scroll position, walk results checking for `position: sticky/fixed` with visibility checks
2. Subtract detected header height from scroll distance
3. After scroll: add `scrollend` listener, re-probe for sticky elements at new position
4. If another sticky found, scroll again by the difference (loop handles stacked headers)

**BranchKit changes:**
- `scroller.ts`: update `snapToElement()` to add `scrollend` re-probe loop
- Expand from 3 probe points to Rango's full-element scan via `elementsFromPoint()`
- Add visibility filtering (skip `display: none`, `visibility: hidden`, `opacity: 0`)

**Rango reference:** `/tmp/rango/src/content/actions/scroll.ts` lines 67-182

---

## 4. Focus-Driven Visibility

**Problem:** When a user focuses an input/textarea, the hint badge covering it is distracting. It should hide on focus and reappear on blur.

**Rango's approach** (27 lines): In Hint constructor, if target `isEditable()`, add focus/blur listeners. Focus hides the hint, blur shows it. Checks `document.hasFocus()` and `document.activeElement` at construction time to handle already-focused elements.

**BranchKit changes:**
- `hints.ts`: add focus/blur listeners in HintBadge constructor for editable targets
- Use `focusin`/`focusout` (they bubble, unlike `focus`/`blur`) for reliability
- Consider hiding hints for ALL focused elements, not just editables — a focused button's badge is also visual noise

**Rango reference:** `/tmp/rango/src/content/hints/Hint.ts` lines 368-379

---

## 5. Event Dispatch Order

**Problem:** BranchKit uses native `.click()` and `.focus()`. This works for simple links but breaks on sites with custom event handling (React synthetic events, drag libraries, Notion-style editors). These sites expect the full pointer/mouse/click sequence.

**Rango's approach** (400 lines across two files):

Event sequence: `pointerdown` -> `mousedown` -> `focus` -> `pointerup` -> `mouseup` -> `click`

All events dispatched with `composed: true` (crosses shadow DOM), correct `pointerId`, `button`, `buttons`, and `pointerType: "mouse"` properties.

Special cases:
- **Anchors**: native `.click()` for proper tab handling
- **Editables**: `window.focus()` first, then selection management
- **File inputs**: focus + Enter key instead of click
- **Selects**: focus + Alt+Down to open dropdown
- **Clipboard buttons**: inject interceptor script to detect `navigator.clipboard.write()`

**BranchKit changes:**
- `dispatcher.ts`: expand from 59 lines to full event dispatch
- New file possible: `event-sequence.ts` for the dispatch logic
- Add element-type routing (anchor, editable, file input, select)

**Rango reference:**
- `/tmp/rango/src/content/dom/dispatchEvents.ts`
- `/tmp/rango/src/content/actions/clickElement.ts`

---

## Already Implemented (No Action Needed)

### Deep Shadow DOM Traversal
BranchKit's `scanner.ts` already implements recursive shadow DOM piercing with the same leaf-tag optimization Rango uses. No changes needed.

### Scroll Region Detection
BranchKit's `scroller.ts` already has geometric sidebar detection with the same `children.length >= 5` heuristic. Site-specific overrides are also present. No changes needed.
