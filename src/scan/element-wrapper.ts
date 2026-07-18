/**
 * BranchKit Browser — Element wrapper and store.
 *
 * Lightweight wrapper that decouples element lifecycle from hint lifecycle.
 * Tracks viewport intersection, category, and adapter source.
 */

import { Category, ScannedElement } from '../types';
import { LabelAssignment } from '../labels/words';
import type { BadgeHandle } from '../render/badge-handle';
import { labelReservoir } from '../labels/label-reservoir';

/**
 * Scroll-invariant cache of `probeAnchor`.
 *
 * The probe finds the badge's anchor inside an element — the first visible
 * text node or first icon-ish element, document order winning — and reads
 * its rect. Text reads use `Range.getBoundingClientRect()`, which always
 * forces synchronous layout — the browser's Element rect cache doesn't
 * extend to Ranges — so repeating the probe on every scroll-coalesced
 * reposition dominates main-thread time on dense pages (Gmail inbox:
 * ~1000 forced layouts per scroll burst, enough to trip Firefox's
 * unresponsive-script dialog).
 *
 * What we cache: the **offset** from the element's top-left to the anchor's
 * top-left, plus the anchor rect's dimensions. Offsets are invariant under
 * scroll because both rects translate by the same scroll delta; only the
 * element's internal layout changes them. Storing offsets (not the absolute
 * rect) means we don't need to wipe the cache on every scroll.
 *
 * Invalidated by `target-mutation-tracker.ts`'s callback when the element
 * mutates. Container CSS resizes that don't mutate the DOM leave the cache
 * intact — in practice the leaf elements that host badges don't internally
 * reflow on container resize, and a subsequent mutation will re-probe if
 * the anchor actually moved.
 *
 * See `placement/position.ts:probeAnchor` for the canonical compute
 * path, and `placement/position.ts:getOrComputeProbe` for the cache read.
 */
export type AnchorProbeOffset =
  | { kind: 'none' }
  | { kind: 'text' | 'icon'; offsetX: number; offsetY: number; width: number; height: number };

/**
 * Which discovery path created a wrapper (notes/DESIGN_FLING_WAVE.md round
 * 15+). The MO path is supposed to own steady-state discovery; every other
 * source finding fresh content is a miss the per-source snapshot section
 * exists to quantify. Stamped once by `attachWrapper`; rebinds keep the
 * original (a rebind is identity survival, not a fresh discovery).
 *
 *   mo           MO childList record → drainDiscovery walk
 *   mo_huge      huge-mutation short-circuit → coarse full-body refresh
 *   band_sweep   discovery sweep armed by a scroll ('band') settle
 *   settle_sweep discovery sweep armed by a non-scroll ('store') settle
 *   scan         full doScan (boot, storage change, activation reconcile)
 *   rescan       nav rescan's doScan (spa_nav / non-cache navigation)
 *   attr         attribute reevaluation flipped an element hintable
 *   shadow       shadow-attach signal / custom-element upgrade rediscovery
 *   attention    attention-observer enter on an unwrapped element
 *   visibility   pending-visibility promotion (CSS reveal)
 *   unknown      threading gap — should never appear; a tripwire, not a bucket
 */
export type DiscoverySource =
  | 'mo' | 'mo_huge' | 'band_sweep' | 'settle_sweep' | 'scan' | 'rescan'
  | 'attr' | 'shadow' | 'attention' | 'visibility' | 'unknown';

export class ElementWrapper {
  element: Element;
  scanned: ScannedElement;
  hint: BadgeHandle | null = null;
  label: LabelAssignment | null = null;
  isInViewport: boolean = true;
  // Limbo lifecycle (DESIGN_WRAPPER_IDENTITY_STABILITY steps 1–2).
  // `disconnectedAt` is null when the wrapper's element is still in the
  // DOM, and a monotonic timestamp once `dropDisconnectedWrappers` has
  // observed the element disconnect. The finalize sweeper detaches any
  // wrapper whose timestamp is older than LIMBO_DEADLINE_MS. `lastRect`
  // captures the element's pre-disconnect rect so the future rebind path
  // (step 3) has a position-hint tiebreaker — the codeword/hint stay
  // attached to the wrapper throughout, so badges don't flicker during
  // the limbo window.
  disconnectedAt: number | null = null;
  lastRect: DOMRect | null = null;
  // See `AnchorProbeOffset` doc above. `null` = not yet computed; set on the
  // first placement that probes this wrapper, cleared on target mutation.
  cachedProbe: AnchorProbeOffset | null = null;
  // Resolved per-domain nudge-rule offset (rules with kind 'nudge').
  // `undefined` = not yet resolved; `null` = resolved, no rule matches.
  // Matcher evaluation must not run per scroll frame, so placement resolves
  // once and caches here; cleared on target mutation (selector match can
  // change) and when the compiled rule set changes (content.ts).
  cachedRuleNudge: { dx: number; dy: number } | null | undefined = undefined;
  // The codeword this wrapper last held, retained after a viewport-leave
  // release. On re-claim the tracker asks the pool to re-grant it (if still
  // free) so an element keeps the same letter across scroll-out/scroll-back
  // instead of being re-dealt a fresh codeword. Set by the release paths;
  // never cleared (a new release just overwrites it).
  preferredCodeword: string = '';

  // True when this wrapper's codeword has been acknowledged by the native
  // plugin's grammar (i.e., voice will actually match it). Decouples the
  // visual layer (badge paints immediately on claim) from the voice layer
  // (codeword goes live after the async POST round-trip). Badges paint
  // translucent (`bk-pending` class) while this is false and snap to full
  // opacity when label-sync's ACK callback flips it. Cleared on label
  // release (clearLabel) and on alphabet change (rotateSession).
  grammarReady: boolean = false;

  // The in_strict_viewport flag value last pushed to the plugin (or
  // undefined if never pushed). Lets `reconcileStrictViewport` queue a
  // re-push iff the wrapper's current strict-viewport status diverges
  // from what the plugin's _strict collection currently reflects. Set by
  // `stampStrictViewport` after the corresponding postBatch.
  lastSentStrictViewport: boolean | undefined = undefined;

  // EFFECTIVE occlusion (notes/DESIGN_HINT_OCCLUSION_FILTERING.md): the OR of the
  // two input signals below, recomputed by `applyOcclusion`. Drives the two
  // consumers — the badge is visually hidden (setOccluded), and strict-viewport
  // forces in_strict_viewport=false so voice can't match a target the user can't
  // see. Both inputs default false, so this is false unless a flag is on.
  occluded: boolean = false;
  // Input A — `overlayCovered`: the elementFromPoint hit-test found the target
  // covered by another (hit-testable) element. Set by `reconcileOcclusion`
  // (settle-debounced); gated by bkOcclusion.
  overlayCovered: boolean = false;
  // Input B — `clipped`: an IntersectionObserver rooted at the target's scroll
  // container reports the target scrolled out of that container (clipped).
  // Compositor-driven, continuous, flicker-free. Set by the clip-observer; gated
  // by bkClipObserver.
  clipped: boolean = false;

  // CSS-invisible target (visibility:hidden / opacity:0 / display:none — the
  // `isVisible()` predicate). Written wherever a badge's paint decision is made
  // from that predicate: the paint sites (showBadges, badgeNewlyCodeworded) and
  // the visibility recheck, all `cssHidden = !isVisible(el)`. A hover-reveal
  // action bar (QuickBase WidgetActions) or an autohidden player control is in
  // the DOM with geometry but visually absent; the badge isn't painted, and
  // strict-viewport forces in_strict_viewport=false so voice can't match a hint
  // the user can't see — same rule as `occluded`, applied to CSS-hidden targets.
  // Distinct from `occluded` (a visible target covered by something on top).
  cssHidden: boolean = false;

  // Stage timestamps (performance.now ms) for the paint-latency
  // decomposition (notes/DESIGN_PAINT_THE_BAND.md): where does the time go
  // between a row appearing in the DOM and its badge painting? Stamped once
  // each, first pass through the stage; the debug snapshot reports
  // stage-delta percentiles over recently-shown wrappers (paint_latency in
  // snapshotExtras), so one Ctrl+Alt+A after a fling attributes the lag to
  // discovery→band, band→claim, or claim→paint.
  tAttached: number = performance.now();
  tInBand: number | null = null;
  tClaimed: number | null = null;
  tFirstShown: number | null = null;
  // When this wrapper's element was first SIGHTED: the MutationObserver's
  // dom-seen stamp when one resolves (the element or an added-subtree
  // ancestor was MO-reported), else tAttached — set by attachWrapper on
  // EVERY path, so no wrapper is invisible to the latency percentiles
  // (round 15's survivorship bias: 41% of shown wrappers carried no stamp
  // and silently dropped out of every dom_seen percentile). `domSeenByMo`
  // says which case this is; for a non-MO-source wrapper WITH a real stamp,
  // tAttached - tDomSeen is the MO-path miss window itself.
  tDomSeen: number | null = null;
  domSeenByMo: boolean = false;
  // Was the element inside the STRICT viewport when attachWrapper stamped it
  // (notes/DESIGN_FLING_WAVE.md round 21)? Discriminates the two readings of
  // a big dom_seen→attached gap that per-source aggregates conflate: TRUE
  // means the element sat in view while ineligible (a held-back reveal — the
  // residual worth chasing); FALSE means scroll-ahead content that attached
  // the moment scrolling made it eligible (correct behavior, not latency).
  inViewportAtAttach: boolean = false;
  // Which discovery path created this wrapper — see DiscoverySource above.
  discoverySource: DiscoverySource = 'unknown';
  // First grammar ACK. tFirstShown - tGrammarReady is the show-vs-voice
  // sequencing: NEGATIVE means the badge painted before voice was ready
  // (the designed order — visible translucent window); POSITIVE means the
  // show lagged the whole voice round-trip (zero translucency, the
  // sequencing inversion reported on production 2026-07-03).
  tGrammarReady: number | null = null;
  // First time the build pass declined to paint this wrapper because the
  // target was CSS-invisible (skeleton row / fade-in). tFirstShown -
  // tBuildGated is how long the built badge waited for the reveal path.
  tBuildGated: number | null = null;

  constructor(element: Element, scanned: ScannedElement) {
    this.element = element;
    this.scanned = scanned;
  }

  /**
   * Mark this wrapper as voice-ready: flip the grammarReady flag and,
   * if its badge is currently visible (with the bk-pending class), tell
   * the badge to clear the class and transition to full opacity.
   *
   * Two call sites: label-sync.syncNow's batch ACK loop (IO claim path)
   * and content.ts:processScanBatch (scan path). Both need both effects;
   * extracting the helper keeps them from drifting apart.
   */
  markGrammarReady(): void {
    this.grammarReady = true;
    this.tGrammarReady ??= performance.now();
    if (this.hint?.isVisible) this.hint.clearPending();
  }

  get category(): Category {
    return this.scanned.category;
  }

  get adapter(): string | null {
    return this.scanned.adapter;
  }

  /**
   * Release this wrapper's pool codeword (if any) back to the per-tab pool
   * and clear it locally. Idempotent: pool's RELEASE_LABELS handler
   * silently ignores codewords it doesn't currently track.
   *
   * Routes through the local reservoir (which unshifts to its `free` AND
   * fires RELEASE_LABELS to the SW). Going direct to chrome.runtime would
   * skip the reservoir, leaving its refill-dedup blind: when the SW later
   * recycles this codeword into a CLAIM_LABELS response, PR 5's
   * `seen = new Set(this.free)` check can't catch it because the codeword
   * was never in `this.free` while the wrapper held it. That handed the
   * same codeword to two wrappers (QuickBase 2026-06-05 — six attach
   * events for "fine kind" in 93ms, same scan; batch.go saw adds=['fine kind']
   * deletes=['fine kind'] in the same batch).
   */
  releaseLabel(): void {
    const codeword = this.scanned.codeword;
    if (!codeword) return;
    this.scanned.codeword = '';
    this.label = null;
    labelReservoir.release([codeword]);
  }

  destroy(): void {
    if (this.hint) {
      this.hint.remove();
      this.hint = null;
    }
  }
}

export class WrapperStore {
  private wrappers: ElementWrapper[] = [];
  // Reverse index from element → wrapper. Sprint B's MutationObserver
  // performs frequent point lookups (e.g. removedNodes → which wrappers go
  // away?), and a Map sidesteps the O(n) `find(...)` in the hot path.
  private byElement: Map<Element, ElementWrapper> = new Map();

  get all(): ElementWrapper[] {
    return this.wrappers;
  }

  get count(): number {
    return this.wrappers.length;
  }

  clear(): void {
    // Release codewords back to the pool *before* destroying badges.
    // destroy() only tears down the visual element; without
    // releaseLabel(), every wrapper's claimed codeword stays "assigned"
    // server-side until tab close. The release path is the only thing
    // that frees them.
    for (const w of this.wrappers) {
      w.releaseLabel();
      w.destroy();
    }
    this.wrappers = [];
    this.byElement.clear();
  }

  set(wrappers: ElementWrapper[]): void {
    this.clear();
    this.wrappers = wrappers;
    for (const w of wrappers) this.byElement.set(w.element, w);
  }

  /** Add a single wrapper. No-op if a wrapper already exists for the element. */
  addWrapper(w: ElementWrapper): void {
    if (this.byElement.has(w.element)) return;
    this.wrappers.push(w);
    this.byElement.set(w.element, w);
  }

  /**
   * Repoint the byElement index so `wrapper` is now looked up by `newEl`
   * instead of `oldEl`. The wrapper's own `.element` field is updated by
   * the caller (it sequences the rebind alongside observer + registry
   * + badge changes). The wrappers array is unchanged — wrapper identity
   * is stable across rebind.
   */
  rebindElement(oldEl: Element, newEl: Element, wrapper: ElementWrapper): void {
    this.byElement.delete(oldEl);
    this.byElement.set(newEl, wrapper);
  }

  /** Look up the wrapper for an element, if any. */
  findWrapperFor(el: Element): ElementWrapper | undefined {
    return this.byElement.get(el);
  }

  /**
   * Remove the wrapper for an element. Releases any pool codeword and
   * destroys the badge. Returns the removed wrapper, or `undefined` if no
   * wrapper existed for that element.
   */
  removeWrapperByElement(el: Element): ElementWrapper | undefined {
    const w = this.byElement.get(el);
    if (!w) return undefined;
    this.byElement.delete(el);
    const idx = this.wrappers.indexOf(w);
    if (idx >= 0) this.wrappers.splice(idx, 1);
    w.releaseLabel();
    w.destroy();
    return w;
  }

  byCategory(category: Category): ElementWrapper[] {
    return this.wrappers.filter(w => w.category === category);
  }

  byLabel(word: string): ElementWrapper | undefined {
    return this.wrappers.find(w =>
      w.label && w.label.words[0] === word
    );
  }

  byLabelPair(word1: string, word2: string): ElementWrapper | undefined {
    return this.wrappers.find(w =>
      w.label && w.label.words.length === 2 &&
      w.label.words[0] === word1 && w.label.words[1] === word2
    );
  }

  /**
   * Resolve a full codeword string ("arch" or "zone arch") to its
   * wrapper. Whitespace-tolerant. Returns undefined for empty input,
   * unknown codewords, or codewords with more than two words.
   */
  byCodeword(codeword: string): ElementWrapper | undefined {
    const words = codeword.trim().split(/\s+/).filter(w => w.length > 0);
    if (words.length === 1) return this.byLabel(words[0]);
    if (words.length === 2) return this.byLabelPair(words[0], words[1]);
    return undefined;
  }

  /** Find wrapper matching a prefix string (for keyboard filtering) */
  matchingPrefix(prefix: string): ElementWrapper[] {
    const lower = prefix.toLowerCase();
    return this.wrappers.filter(w => {
      if (!w.label) return false;
      const firstWord = w.label.words[0];
      return firstWord.startsWith(lower);
    });
  }

  /** Find wrapper by letter prefix (for keyboard filtering) */
  matchingLetterPrefix(prefix: string): ElementWrapper[] {
    const lower = prefix.toLowerCase();
    return this.wrappers.filter(w => {
      if (!w.label) return false;
      return w.label.letter.toLowerCase().startsWith(lower);
    });
  }
}

/**
 * Mark a wrapper as having lost its DOM element. The wrapper stays in
 * the store with its codeword and badge intact; the rebind path swaps
 * in a fingerprint-equivalent replacement element if one appears
 * before LIMBO_DEADLINE_MS, otherwise the finalize sweeper detaches.
 *
 * `lastRect` is maintained separately — IntersectionTracker writes the
 * latest IO `boundingClientRect` to it on every entry, and
 * `dropDisconnectedWrappers` seeds it from the layout cache as a
 * fallback before calling this. By the time we're in limbo, lastRect
 * already reflects the element's pre-disconnect position.
 *
 * Idempotent: subsequent disconnects on the same wrapper don't reset
 * the timer.
 */
export function enterLimbo(w: ElementWrapper, now: number): void {
  if (w.disconnectedAt !== null) return;
  w.disconnectedAt = now;
}

/** True if the wrapper has been in limbo for at least `deadlineMs`. */
export function isLimboExpired(
  w: ElementWrapper,
  now: number,
  deadlineMs: number,
): boolean {
  return w.disconnectedAt !== null && now - w.disconnectedAt >= deadlineMs;
}

/**
 * Vimium's scoreLinkHint scoring: tokenize the label on non-word chars,
 * weight whole-word match 8 (first token) / 4 (later), prefix-of-word
 * 6 (first) / 2 (later), substring 1.
 */
export function scoreTextMatch(label: string, query: string): number {
  if (!label) return 0;
  const lower = label.toLowerCase();
  if (!lower.includes(query)) return 0;

  const tokens = lower.split(/\W+/).filter(t => t.length > 0);
  if (tokens.length === 0) return 1;

  let best = 1; // substring match baseline
  for (let i = 0; i < tokens.length; i++) {
    const isFirst = i === 0;
    if (tokens[i] === query) {
      best = Math.max(best, isFirst ? 8 : 4);
    } else if (tokens[i].startsWith(query)) {
      best = Math.max(best, isFirst ? 6 : 2);
    }
  }
  return best;
}
