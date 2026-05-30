# Badge Placement Engine

Overlap-free hint badge positioning with leader lines for displaced badges.

**Status:** Proposal / unbuilt (marker added 2026-05-30). Not implemented. The
live placement strategy is `RangoStrategy` (`src/placement/rango.ts`), which
uses Rango-style nudge positioning with no occupancy/collision model;
z-index is reading-order based. Leader-line scaffolding exists in
`src/render/hints.ts` (`setLeader`, `bk-leader`) but is inert — `setLeader` is
never called. Pick this up if overlap on dense pages becomes a real complaint.

## Problem

BranchKit places 50-200 hint badges on a page. Each badge currently sits 24px to the left of its target element. On dense UIs (nav menus, stacked lists, Gmail, Slack), badges overlap each other, making labels unreadable and targets unidentifiable.

No browser extension has solved this well:
- **Vimium**: Groups overlapping badges into stacks, lets users TAB-cycle z-index. Accepts the problem.
- **Vimium-C**: Subtractive rectangle partitioning — splits occluded rects into fragments and repositions. Better, but still produces visual noise.
- **Rango**: Nudge positioning (badges sit partially inside targets). No collision detection at all.

## Prior art from other fields

### Cartography (label placement)

Map labeling is a formally studied NP-hard problem (Christensen/Marks/Shieber 1995). Three algorithms are fast enough for real-time:

**Greedy N-position model.** For each label, try N candidate positions around the anchor point (4-position: cardinal; 8-position: + diagonals). Take the first non-colliding slot. O(n x N). Achieves ~70% overlap-free placement.

**Occupancy bitmap** (Luo/Keshavan 2021, IEEE VIS). Rasterize placed labels onto a 2D grid. For each new label, check if its grid cells are occupied. Cost is O(label_area / cell_size^2) per label — independent of total label count. At 8px cell size with small badges: 2-5ms for 200 labels.

**Mapbox GridIndex.** 30px spatial hash grid. Insert geometry, query for collisions in O(1) per cell. Runs at 60fps with hundreds of labels in production maps.

### Game UI (nameplate stacking)

MMO nameplates (WoW) use vertical displacement — overlapping nameplates push upward in a column. Instantly intuitive. RTS games use selective rendering — only show labels for selected units.

**Spatial hashing** is the standard game engine technique for broad-phase collision detection. Divide the viewport into grid cells; only check elements sharing a cell. Reduces O(n^2) to O(n).

### Technical illustration (leader lines)

ISO 128 and CAD annotation systems define callout labels with connecting leader lines. Rules: lines should be straight (one bend max), must not cross each other, labels sit outside the busy area, each connection must be unambiguous.

### Data visualization

D3's force-directed layout treats labels as repelling particles attracted to their anchors. High quality but needs 300-500 iterations — too slow for single-frame placement. The `d3-annotation` library separates subject/note/connector, with smart connector routing.

## Design

### Three-layer architecture

```
Layer 1: Candidate positions     "Where could this badge go?"
Layer 2: Occupancy bitmap        "Is this spot taken?"
Layer 3: Leader lines            "Badge moved — show the connection"
```

### Layer 1: Candidate positions

For each target element, generate 6 candidate badge positions in priority order:

```
                 [2: above-left]  [3: above-right]
[1: inside-left] [target element.................]
                 [4: below-left]  [5: below-right]
                                  [6: below-far-right]
```

Position 1 (inside-left) places the badge overlapping the left edge of the target, vertically centered. This is the tightest placement — the badge sits on or inside its target, making the association obvious without a leader line.

Positions 2-6 are fallbacks at increasing distance. The exact pixel offsets:

```
1. inside-left:     x = target.left - badge.width * 0.3,  y = target.top + 2
2. above-left:      x = target.left,                      y = target.top - badge.height - 2
3. above-right:     x = target.right - badge.width,       y = target.top - badge.height - 2
4. below-left:      x = target.left,                      y = target.bottom + 2
5. below-right:     x = target.right - badge.width,       y = target.bottom + 2
6. below-far-right: x = target.right + 4,                 y = target.bottom + 2
```

Candidates are generated once per badge per layout pass. If all 6 collide, the badge takes position 1 anyway (overlap is better than no badge).

### Layer 2: Occupancy bitmap

A 2D grid tracks which viewport regions are occupied by placed badges. The grid cell size is 8px — small enough for accurate collision detection, large enough to keep the bitmap compact.

**Data structure.** A flat `Uint8Array` of size `ceil(viewportWidth / 8) * ceil(viewportHeight / 8)`. Each byte represents one 8x8px cell: 0 = free, 1 = occupied. For a 1920x1080 viewport: 240 x 135 = 32,400 bytes (~32KB).

**Operations:**

```
mark(rect):   Set cells overlapping rect to 1
test(rect):   Return true if any cell overlapping rect is 1
clear():      Zero the entire array
```

Both `mark` and `test` iterate over `ceil(rect.width / 8) * ceil(rect.height / 8)` cells. For a 40x18px badge: 5 x 3 = 15 cell lookups. Constant-time relative to total badge count.

**Badge-only tracking.** The bitmap tracks placed badges, not target elements. On dense pages (nav menus, toolbars), the targets tile the entire region — reserving their rects would leave zero free cells and every badge would fall through to forced-overlap fallback, defeating the engine. Badges are meant to overlap their own targets (position 1 is inside-left); the problem is badges overlapping other badges.

**Placement algorithm:**

```
badges = sort by priority (top-left reading order)
bitmap = new OccupancyBitmap(viewport)

for each badge in badges:
    placed = false
    for each candidate in badge.candidates:
        if not bitmap.test(candidate.rect):
            badge.position = candidate
            bitmap.mark(candidate.rect)
            placed = true
            break
    if not placed:
        badge.position = badge.candidates[0]  // fallback to preferred
        bitmap.mark(badge.candidates[0].rect)
```

**Priority ordering.** Badges are processed in top-left reading order (same as the existing `viewportSort`). This means top-left badges get preferred positions and bottom-right badges adapt. Reading order matches the user's visual scan pattern.

**Persistent bitmap for incremental insertion.** The bitmap is not rebuilt every frame. It persists across the hint session:
- **Full layout** on `showHints()` and window resize: clear bitmap, place all badges.
- **Incremental insert** when new elements scroll into the viewport and `badgeNewlyCodeworded()` fires: run the new badge through candidate positions against the existing bitmap, mark its chosen position. No need to re-layout existing badges.
- **Clear** when hints are hidden.

This avoids rebuilding the bitmap on scroll while still giving newly-appearing badges collision awareness.

### Layer 3: Leader lines

When a badge is placed at a position other than inside-left (position 1), a thin line connects the badge to the target element's nearest edge. This maintains the visual association between badge and target.

**Visual design:**
- Width: 1px
- Color: same as the badge's category border color, at 40% opacity
- Style: solid (not dashed — dashed is harder to track visually at 1px)
- Path: straight line, one segment, no bends
- Endpoints: badge corner nearest to target, target edge midpoint nearest to badge

**Implementation:** Each badge host div gets an optional child div styled as a rotated line via CSS transforms. No SVG, no external library.

```
line.width  = distance(badge_anchor, target_anchor)
line.angle  = atan2(dy, dx)
line.style  = position:absolute; width:{len}px; height:1px;
              background:{color}; opacity:0.4;
              transform-origin:0 0; transform:rotate({angle}rad);
              top:{badge_anchor.y}; left:{badge_anchor.x};
```

The line div lives inside the badge's shadow DOM, so it's invisible to page CSS and can't be removed by hostile page scripts.

**When to show a leader:**
- Badge is at position 2-6 (any non-inside position)
- Distance from badge center to target center > 16px
- Both badge and target are visible (not filtered/hidden)

**When to hide:**
- Badge returns to position 1 on re-layout
- Badge is hidden or filtered

## Decisions

### 1. No target reservation in the bitmap

The bitmap tracks only placed badges, not target element rects. On dense UIs the targets tile the entire region — reserving their rects leaves zero free cells and every badge falls through to forced-overlap. Badges are supposed to overlap their own target (position 1 is inside-left); the engine prevents badges overlapping other badges.

Future consideration: reserving space for large non-hintable elements (video players, canvases, maps) where a badge landing on them would be confusing. But this is an optimization, not the default behavior.

### 2. No re-layout on scroll

Badges are positioned absolutely within their scroll container (`anchorParent`) and move with their targets via the compositor. The relative geometry between badges stays constant during scroll — overlaps that exist off-screen remain identical when scrolled into view. Re-layout on every scroll frame would be pure waste.

New elements scrolling into the viewport get badges via `badgeNewlyCodeworded()`. These new badges run through the candidate/bitmap system incrementally (the bitmap persists). This gives new badges collision awareness without a full re-layout.

Full re-layout triggers:
- `showHints()` (initial display or category change)
- Window resize (viewport geometry changed)
- Alphabet change (all badges rebuilt)

### 3. Snap positioning, no animation

Badges snap to their placed position immediately. No transition on position changes.

Reasoning:
- Badges already fade in via opacity (150ms). Adding position animation creates two competing visual signals.
- Displacement happens at creation time — the user never sees the badge at position 1 and then watches it slide. They see it appear at its final position directly. There's nothing to animate from.
- On full re-layout (resize), 80 badges sliding simultaneously would be visual noise worse than a clean snap.

### 4. Accept overlap at extreme density

At extreme density (50+ badges in a 200x200px region), some overlap is inevitable. The engine does not cluster, collapse, or hide badges.

Reasoning:
- BranchKit already has the right tools for density: category filtering ("go" shows links only, "set" shows inputs only) and codeword prefix filtering (typing narrows visible badges instantly). These reduce the visible set far more effectively than algorithmic declutter.
- Hiding badges makes them undiscoverable — the user wouldn't know what's behind a cluster indicator.
- The 6-candidate system handles moderate density well (20-30 badges in a region). Extreme density is rare in practice and is effectively managed by the existing filter UX.

One enhancement: when badges do overlap, later-in-reading-order badges get a slightly higher z-index so the topmost badge in any stack is the one the user encounters first when scanning top-left to bottom-right. This is cheap (just set z-index = processing order + base) and matches the user's visual scan direction.

## Performance budget

| Phase | Cost (200 labels) |
|---|---|
| Candidate generation (6 x 200) | ~1ms |
| Bitmap init (32KB zero-fill) | ~0.1ms |
| Collision test + placement (200 labels, 15 cells each, up to 6 candidates) | ~3-5ms |
| Leader line geometry (CSS transform calc) | ~1ms |
| DOM writes (position + optional line) | ~2ms |
| **Total** | **~7-9ms** |

Within the 16ms frame budget at 60fps. The bitmap approach scales with label area, not label count, so this holds for 500+ labels.

Incremental insertion (single badge) costs ~0.1ms — negligible.

## Integration with existing code

**New file: `placement.ts`**
- `OccupancyBitmap` class (mark, test, clear)
- `generateCandidates(target: Element, badgeSize: {w, h})` returns 6 candidate rects
- `placeBadges(badges: HintBadge[], targets: Element[])` runs the full placement pass
- `placeOne(badge: HintBadge, target: Element, bitmap: OccupancyBitmap)` incremental insert

**Modified: `hints.ts`**
- `HintBadge` gains a `leaderLine` child div (created lazily on first displacement)
- `updatePosition()` accepts a `candidate` rect instead of computing position internally
- `setLeader(target: DOMRect, anchor: {x, y})` shows/hides the leader line

**Modified: `content.ts`**
- `showHints()` calls `placeBadges()` after creating/updating badges, replacing the current per-badge `show()` calls
- `badgeNewlyCodeworded()` uses `placeOne()` for incremental insertion
- Resize handler calls `placeBadges()` for full re-layout
- `cacheLayout()` / `clearLayoutCache()` wrap the placement pass (already in place)
- Module-level `bitmap` variable persists across the hint session, cleared on `hideHints()`

### What this does NOT change

- Badge styling, colors, shadow DOM structure (unchanged)
- Codeword assignment, pool management (unchanged)
- Scanner, intersection tracker, element wrapper (unchanged)
- Keyboard/voice activation (unchanged — activation uses element refs, not badge positions)

## Edge cases

### Badges near viewport edges

Candidates that would place the badge partially outside the viewport are rejected (bitmap test fails for out-of-bounds cells). The badge falls through to the next candidate. If all candidates are clipped, position 1 (inside-left) is used as fallback.

### Container-relative positioning

The bitmap operates in viewport coordinates, but badges are positioned relative to their `anchorParent`. The placement engine must convert between coordinate spaces:
- Candidate rects are computed in viewport space (using `getBoundingClientRect`)
- The chosen candidate rect is converted to `anchorParent`-relative coords for the actual CSS positioning
- This conversion already exists in `updatePosition()` — the placement engine feeds it a chosen rect instead of computing one

### Filtered badges

When the user filters by codeword prefix or text match, hidden badges (via `.filtered` class) should not occupy bitmap space. On filter:
- Full re-layout with only the visible (non-filtered) badges
- Or: mark filtered badges as "ghost" in the bitmap (don't test against them, but don't mark their space either)

The simpler approach is to not re-layout on filter — filtered badges are `display: none` and visually disappear. The remaining visible badges may have better positions available, but the visual improvement is marginal and re-layout during fast typing would be jarring. Accept the sub-optimal positions until the filter is cleared, at which point `showHints()` does a full re-layout anyway.

### Shadow DOM containers

Some badges have `anchorParent` inside a shadow DOM (e.g., custom elements with shadow roots). The bitmap doesn't care — it works in viewport coordinates. The coordinate conversion in `updatePosition()` already handles shadow DOM containers.

## Testing

### Unit tests (no DOM)

**OccupancyBitmap.** Pure geometry on a `Uint8Array`. Test cases:

- `mark` + `test`: mark a rect, test overlapping rect returns true, non-overlapping returns false
- Boundary alignment: rects that don't align to 8px cell boundaries still mark/test the correct cells
- Out-of-bounds: rects partially or fully outside the viewport are clamped, not crashed
- `clear`: after clear, previously occupied cells return false
- Zero-size viewport: constructor doesn't throw

**generateCandidates.** Given a target rect and badge size, returns 6 candidate rects in priority order. Test cases:

- Positions match the documented pixel offsets (inside-left through below-far-right)
- Candidate rects have correct width/height (badge dimensions, not target dimensions)
- Target at viewport edge: candidates that would extend outside viewport are still generated (the bitmap rejects them, not the candidate generator)

**Leader line geometry.** Given badge anchor point and target anchor point, returns correct length and angle. Test cases:

- Horizontal line (same y): angle is 0
- Vertical line (same x): angle is pi/2
- Diagonal: length matches Pythagorean theorem, angle matches atan2

### Integration tests (JSDOM or real DOM)

**placeBadges end-to-end.** Create mock elements with known bounding rects, run `placeBadges`, verify:

- Non-overlapping targets: all badges get position 1 (inside-left)
- Two targets stacked vertically with badges that would collide: second badge gets position 2-6
- All candidates collide: badge falls back to position 1
- Processing order matches top-left reading order

**placeOne incremental.** After a full `placeBadges` pass, insert one new badge via `placeOne`. Verify it avoids existing occupied cells without displacing already-placed badges.

**Leader line visibility.** Badge at position 1 has no leader line. Badge at position 2+ has a leader line with correct CSS transform values.

### What not to test

- Visual appearance (colors, opacity, font) — covered by existing badge tests and manual QA
- Scroll behavior — the design explicitly avoids re-layout on scroll
- Filter interaction — the design explicitly accepts sub-optimal positions during filtering

## Future extensions

- **Adaptive candidate count.** In sparse regions, fewer candidates are needed. In dense regions, add more (8-position, 12-position). Could detect density from the bitmap's occupancy ratio per region.
- **Force-directed refinement.** After greedy placement, run 1-2 passes of repulsion between nearby badges. Amortize over 2-3 frames if needed. Low priority — greedy placement with 6 candidates should handle most cases.
- **Curved leader lines.** Replace straight lines with gentle arcs when multiple leaders would cross. Requires checking for line-line intersections. Low priority.
- **Large element reservation.** Reserve bitmap space for non-hintable large interactive surfaces (video players, canvases, maps) to prevent badges from landing on them. Opt-in, not default.
