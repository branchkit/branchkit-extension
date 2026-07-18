import { ElementWrapper } from '../scan/element-wrapper';
import { getCachedRect, getCachedStyle } from '../layout-cache';
import { computePlacement, Nudge } from './compute';
import { type BadgeSettings, DEFAULT_BADGE_SETTINGS } from '../badge-settings-storage';
import { type RuleEntry, resolveNudgeOffset } from '../rules/domain-rules';

// Per-domain nudge-rule entries for this frame (kind 'nudge' bucket of the
// compiled rule set). Set by content.ts whenever the matched rules change;
// placement resolves each wrapper's offset against these once and caches it
// on the wrapper (see ElementWrapper.cachedRuleNudge).
let ruleNudges: readonly RuleEntry[] = [];

export function setRuleNudges(entries: readonly RuleEntry[]): void {
  ruleNudges = entries;
}

export type AnchorKind = 'text' | 'icon';
export type AnchorProbe = { kind: AnchorKind; rect: DOMRect } | { kind: 'none' };

// Rango's icon heuristics: small enough and square-ish enough to read as a
// leading glyph rather than a content image.
const ICON_MAX_PX = 100;
const ICON_MAX_ASPECT = 1.5;

function iconAnchorRect(el: Element): DOMRect | null {
  const r = getCachedRect(el);
  if (r.width < 3 || r.height < 3) return null;
  if (r.width > ICON_MAX_PX || r.height > ICON_MAX_PX) return null;
  if (Math.max(r.width, r.height) / Math.min(r.width, r.height) >= ICON_MAX_ASPECT) return null;
  return r;
}

function isPossibleIcon(el: Element): boolean {
  const tag = el.localName;
  if (tag === 'svg' || tag === 'img') return true;
  // Font icons: <i> with ::before glyph content. Pseudo styles aren't in the
  // layout cache; the live read is bounded to <i> tags seen before the first
  // text node. (Ligature icon fonts carry their glyph as a text child and are
  // caught by the text branch, which is the right rect for them anyway.)
  if (tag === 'i') {
    const before = getComputedStyle(el, '::before');
    return before.content !== 'none' && before.content !== 'normal';
  }
  // Childless background-image/mask-image sprites.
  if (el.childNodes.length === 0) {
    const style = getCachedStyle(el);
    if (style.backgroundImage && style.backgroundImage !== 'none') return true;
    if (style.maskImage && style.maskImage !== 'none') return true;
  }
  return false;
}

/**
 * Resolve the badge's anchor inside a hintable target: the first visible
 * text node OR the first icon-ish element, whichever comes first in
 * document order (Rango's reference-element rule — a sidebar row's leading
 * svg beats the span that follows it, so the badge rail aligns on the
 * icons and stays off the words). Text reads use
 * `Range.getBoundingClientRect()`, which forces synchronous layout (the
 * Element rect cache doesn't extend to Ranges) — prefer
 * `getOrComputeProbe(wrapper)` from the hot placement path; this raw
 * function is exported for tests and callers without a wrapper.
 */
export function probeAnchor(element: Element): AnchorProbe {
  const walker = document.createTreeWalker(
    element, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node instanceof Element) {
      // Interior svg nodes: the outermost <svg> either anchors as an icon
      // or the whole graphic is passed over — never anchor to a <path>.
      if (node instanceof SVGElement && node.ownerSVGElement) continue;
      if (isPossibleIcon(node)) {
        const r = iconAnchorRect(node);
        if (r) return { kind: 'icon', rect: r };
      }
      continue;
    }
    const textNode = node as Text;
    if (!textNode.textContent || textNode.textContent.trim().length === 0) continue;
    const parent = textNode.parentElement;
    if (parent) {
      const pr = getCachedRect(parent);
      if (pr.width < 3 && pr.height < 3) continue;
    }
    const text = textNode.textContent;
    const start = text.search(/\S/);
    if (start < 0) continue;
    const range = document.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, start + 1);
    const rect = range.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return { kind: 'text', rect };
  }
  return { kind: 'none' };
}

/**
 * Read the wrapper's cached probe — or compute and store one on first call.
 *
 * The cache stores scroll-invariant offsets from the element rect (see
 * `ElementWrapper.cachedProbe`), so we can reconstruct the absolute viewport
 * rect by reading the current element rect (cheap, Element-rect cache covers
 * it) and adding the offset. Subsequent scrolls reuse the cached offset; no
 * Range rect reads on the scroll path.
 *
 * Invalidation is the caller's responsibility — see `invalidateProbe`. The
 * target-mutation-tracker wires this in `content.ts`.
 */
export function getOrComputeProbe(w: ElementWrapper): AnchorProbe {
  if (w.cachedProbe !== null) {
    if (w.cachedProbe.kind === 'none') return { kind: 'none' };
    const el = getCachedRect(w.element);
    const { kind, offsetX, offsetY, width, height } = w.cachedProbe;
    return { kind, rect: new DOMRect(el.left + offsetX, el.top + offsetY, width, height) };
  }
  const probe = probeAnchor(w.element);
  if (probe.kind === 'none') {
    w.cachedProbe = { kind: 'none' };
    return probe;
  }
  // The probe's `range.getBoundingClientRect()` is a LIVE read that forced a
  // synchronous layout. Measure the element rect LIVE here too, in that same
  // flushed frame — NOT via `getCachedRect`, whose snapshot was taken by
  // `cacheLayout()` before this read pass. On a quiescent page the two agree;
  // but when the page reflows between `cacheLayout()` and this probe (YouTube
  // scroll-back virtualization re-laying-out rows), a cached element rect
  // mixed with a live text rect bakes the reflow delta into `offsetY`. That
  // delta then rides the anchor host's `calc(anchor(top) + Δpx)` and strands
  // the badge ~200px off its (correctly-bound) target — the bug this guards.
  const elLive = w.element.getBoundingClientRect();
  const offsetX = probe.rect.left - elLive.left;
  const offsetY = probe.rect.top - elLive.top;
  w.cachedProbe = {
    kind: probe.kind,
    offsetX,
    offsetY,
    width: probe.rect.width,
    height: probe.rect.height,
  };
  // Return the rect reconstructed on the pass-consistent cached element rect,
  // matching the cached-hit branch above. This keeps the candidate,
  // `computePlacement`'s `elementRect`, and `updatePosition`'s anchor-offset
  // bake all on one basis, so the baked offset is the intended overhang and
  // can't absorb a reflow delta even if `cacheLayout`'s snapshot is stale —
  // `anchor()` re-resolves the live target at render time regardless.
  const elCached = getCachedRect(w.element);
  return {
    kind: probe.kind,
    rect: new DOMRect(elCached.left + offsetX, elCached.top + offsetY, probe.rect.width, probe.rect.height),
  };
}

/**
 * Clear a wrapper's cached probe. Call when the element mutates, so the
 * next placement re-probes against the fresh internal layout.
 */
export function invalidateProbe(w: ElementWrapper): void {
  w.cachedProbe = null;
  // Same signal — the element changed, so a nudge rule's selector may now
  // match differently.
  w.cachedRuleNudge = undefined;
}

// Live nudge state — initialized from DEFAULT_BADGE_SETTINGS and overwritten
// by the content-script bootstrap once storage has been read. Mutable refs
// so settings changes propagate without re-wiring callers.
let nudgeXSmall = DEFAULT_BADGE_SETTINGS.nudgeXSmall;
let nudgeYSmall = DEFAULT_BADGE_SETTINGS.nudgeYSmall;
let nudgeXMed = DEFAULT_BADGE_SETTINGS.nudgeXMed;
let nudgeYMed = DEFAULT_BADGE_SETTINGS.nudgeYMed;
let nudgeXLarge = DEFAULT_BADGE_SETTINGS.nudgeXLarge;
let nudgeYLarge = DEFAULT_BADGE_SETTINGS.nudgeYLarge;

export function setNudgesFromSettings(s: BadgeSettings): void {
  nudgeXSmall = s.nudgeXSmall;
  nudgeYSmall = s.nudgeYSmall;
  nudgeXMed = s.nudgeXMed;
  nudgeYMed = s.nudgeYMed;
  nudgeXLarge = s.nudgeXLarge;
  nudgeYLarge = s.nudgeYLarge;
}

function getNudge(
  element: Element,
  anchor: AnchorKind | 'none',
  anchorRect?: { width: number; height: number },
): Nudge {
  // Icon-led targets (a sidebar row's leading svg before its text): Rango's
  // posture — small glyphs get the ratio overhang (badge mostly above-left,
  // corner overlap; their non-Text default is 0.3/0.5), big icon boxes host
  // the badge fully inside. We use the user's small-bucket ratios so the
  // Overlap sliders govern icon badges too. NOT the icon-only {1, 0.2}
  // posture below — that's tuned for dense icon clusters with no text,
  // where a left overhang lands on the neighboring control; an icon-led
  // row's top-left gutter is free space.
  if (anchor === 'icon') {
    if (anchorRect && anchorRect.width > 30 && anchorRect.height > 30) {
      return { x: 1, y: 1 };
    }
    return { x: nudgeXSmall, y: nudgeYSmall };
  }
  const rect = getCachedRect(element);
  if (anchor === 'none') {
    // Large icon-only elements (icon-only buttons big enough to host the
    // badge inside): place hint at the target's top-left INSIDE the element.
    // Matches Rango's "nudge=1" branch.
    if (rect.width > 30 && rect.height > 30) {
      return { x: 1, y: 1 };
    }
    // SMALL icon-only targets (round 36, y tuned 36c): no left overhang —
    // the ratio overhang exists to keep the badge off a text target's
    // glyphs; an icon has none, and in dense action clusters (QuickBase's
    // pencil/eye: 18px icons, 4px apart) a badge hanging 70% past the
    // left edge lands ON the neighboring control. Left edges aligned,
    // with ~20% of the badge overlapping the icon's top (user-tuned,
    // 2026-07-05): the slight overlap reads as ATTACHED to the icon,
    // where fully-above read as floating between rows.
    return { x: 1, y: 0.2 };
  }

  // Everything else — Rango-style ratio nudge per font-size bucket.
  // Badge sits at the target's top-left with a fractional overhang
  // up-and-left; the remainder of the badge sits ON the text. Bigger
  // fonts can host more of the badge inside without occluding glyphs,
  // so the ratios slide toward 1.
  const style = getCachedStyle(element);
  const fontSize = parseInt(style.fontSize, 10);
  if (fontSize < 15) return { x: nudgeXSmall, y: nudgeYSmall };
  if (fontSize < 20) return { x: nudgeXMed, y: nudgeYMed };
  return { x: nudgeXLarge, y: nudgeYLarge };
}

export function placeBadges(wrappers: ElementWrapper[]): void {
  // Read pass: probe text positions for all elements before any writes.
  // Cached per-wrapper (see `ElementWrapper.cachedProbe`) so scroll-only
  // repositions don't re-walk text nodes or re-read Range rects.
  const probes = wrappers.map((w) => getOrComputeProbe(w));

  // Write pass: position all badges using pre-collected probes. Z-index is
  // not placement's job — HintBadge.refine() computes it once per badge,
  // cached per anchorParent.
  for (let i = 0; i < wrappers.length; i++) {
    const w = wrappers[i];
    if (!w.hint) continue;
    positionAtTopLeft(w, probes[i]);
    w.hint.hideLeader();
  }
}

export function placeOne(wrapper: ElementWrapper): void {
  if (!wrapper.hint) return;
  positionAtTopLeft(wrapper);
  wrapper.hint.hideLeader();
}

function positionAtTopLeft(w: ElementWrapper, probe?: AnchorProbe): void {
  if (!w.hint) return;
  if (!probe) probe = getOrComputeProbe(w);

  // Gather half: all DOM reads. The ratio-offset decision lives in the pure
  // computePlacement. Hosts are body-mounted and follow the live target every
  // reconcile pass, so no container space-clamp or sticky/fixed bound applies —
  // see the sticky-clamp sub-question in
  // notes/completed/DESIGN_HINT_POSITIONING_REARCH.md.
  const targetRect = probe.kind !== 'none' ? probe.rect : getCachedRect(w.element);
  const nudge = getNudge(w.element, probe.kind, probe.kind !== 'none' ? probe.rect : undefined);
  const result = computePlacement({
    targetRect,
    badgeSize: w.hint.badgeSize,
    nudge,
  });
  // Per-domain nudge rules: a user-authored pixel offset for elements whose
  // computed position collides with page content. Applied last so it
  // composes with (never fights) anchor choice and ratio nudges. Resolved
  // once per wrapper against the rule matchers, then cached.
  if (w.cachedRuleNudge === undefined) {
    w.cachedRuleNudge = ruleNudges.length > 0
      ? resolveNudgeOffset(w.element, ruleNudges)
      : null;
  }
  if (w.cachedRuleNudge) {
    result.x += w.cachedRuleNudge.dx;
    result.y += w.cachedRuleNudge.dy;
  }
  // Top-edge fallbacks RETIRED (2026-07-15). Round 36b flipped a
  // first-visible-row icon's badge fully below when fully-above poked past
  // the clipping scroller (badge cut off mid-letters); a brief overlap
  // variant followed. Both failed the same way in practice: position is
  // derived at placement time but followed by pure scroll translation
  // between passes, so the fallback offset STUCK to rows long after they
  // left the edge — on Gmail, whole bands of rows wore the fallback
  // (below-badges clustered ambiguously with the next row's pair; overlap
  // badges covered their icons mid-list). A momentarily-clipped badge at
  // the literal top edge is the least-bad state: it sits where badges
  // always sit (consistent grammar), it enters the viewport with its row
  // like everything else, and voice is unaffected (codeword eligibility
  // tracks the TARGET's visibility, not the badge's). The edge case is
  // handled where it CAN'T stick: HintBadge.reconcileRead applies a
  // write-time top-edge clamp per pass (same shape as its off-screen
  // clamp) — see the QuickBase header-band case in hints.ts. Placement
  // itself stays edge-unaware by design.
  w.hint.updatePosition({ x: result.x, y: result.y });
}
