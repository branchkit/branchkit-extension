/**
 * BranchKit Browser — Element wrapper and store.
 *
 * Lightweight wrapper that decouples element lifecycle from hint lifecycle.
 * Tracks viewport intersection, category, and adapter source.
 */

import { Category, ScannedElement } from '../types';
import { LabelAssignment } from '../labels/words';
import { HintBadge } from '../render/hints';
import { HintCandidate } from '../labels/allocator';

/**
 * Scroll-invariant cache of `RangoStrategy.probeFirstVisibleText`.
 *
 * The probe finds the first visible text node inside an element and reads
 * its `Range.getBoundingClientRect()`. Range rect reads always force
 * synchronous layout — the browser's Element rect cache doesn't extend to
 * Ranges — so repeating the probe on every scroll-coalesced reposition
 * dominates main-thread time on dense pages (Gmail inbox: ~1000 forced
 * layouts per scroll burst, enough to trip Firefox's unresponsive-script
 * dialog).
 *
 * What we cache: the **offset** from the element's top-left to the text's
 * top-left, plus the text rect's dimensions. Offsets are invariant under
 * scroll because both rects translate by the same scroll delta; only the
 * element's internal layout changes them. Storing offsets (not the absolute
 * rect) means we don't need to wipe the cache on every scroll.
 *
 * Invalidated by `target-mutation-tracker.ts`'s callback when the element
 * mutates. Container CSS resizes that don't mutate the DOM leave the cache
 * intact — in practice the leaf elements that host badges don't internally
 * reflow on container resize, and a subsequent mutation will re-probe if
 * the text actually moved.
 *
 * See `placement/rango.ts:probeFirstVisibleText` for the canonical compute
 * path, and `placement/rango.ts:getOrComputeProbe` for the cache read.
 */
export type TextProbeOffset =
  | { hasText: false }
  | { hasText: true; offsetX: number; offsetY: number; width: number; height: number };

export class ElementWrapper {
  element: Element;
  scanned: ScannedElement;
  hint: HintBadge | null = null;
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
  // See `TextProbeOffset` doc above. `null` = not yet computed; set on the
  // first placement that probes this wrapper, cleared on target mutation.
  cachedProbe: TextProbeOffset | null = null;

  constructor(element: Element, scanned: ScannedElement) {
    this.element = element;
    this.scanned = scanned;
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
   */
  releaseLabel(): void {
    const codeword = this.scanned.codeword;
    if (!codeword) return;
    this.scanned.codeword = '';
    this.label = null;
    // chrome.runtime.sendMessage THROWS SYNCHRONOUSLY when the extension
    // context is invalidated (orphan content script after extension reload).
    // The `.catch()` only handles async rejection — the sync throw escapes
    // and surfaces as an uncaught error from whatever observer callback
    // happened to call us. Wrap in try/catch for safety.
    try {
      chrome.runtime.sendMessage({ type: 'RELEASE_LABELS', labels: [codeword] })
        .catch(() => {/* extension context may be invalidated */});
    } catch {
      // Orphan content script post-reload. Nothing to do — label tracking
      // already cleared locally, and the orphan's SW connection is dead.
    }
  }

  destroy(): void {
    if (this.hint) {
      this.hint.remove();
      this.hint = null;
    }
  }
}

/**
 * Adapt an ElementWrapper to the allocator's polymorphic input. Reads
 * the live bounding rect at call time, so callers should compute this
 * once per allocation pass (it forces layout). `oldCodeword` carries
 * forward any existing codeword on the wrapper — currently unused by
 * the rank-and-pair allocator but reserved for a future stability
 * metric without a signature break.
 *
 * Lives here (not in allocator.ts) so the allocator stays import-free
 * of element-wrapper and a future TextTokenWrapper for
 * contenteditable hints can adapt the same way.
 */
export function wrapperToCandidate(w: ElementWrapper): HintCandidate {
  return {
    id: String(w.scanned.id),
    rect: w.element.getBoundingClientRect(),
    oldCodeword: w.scanned.codeword || undefined,
  };
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

  /**
   * Score all wrappers against a text query using Vimium's scoreLinkHint
   * algorithm. Returns wrappers with score > 0, sorted descending.
   */
  matchingText(query: string): { wrapper: ElementWrapper; score: number }[] {
    if (!query) return [];
    const lower = query.toLowerCase();
    const results: { wrapper: ElementWrapper; score: number }[] = [];
    for (const w of this.wrappers) {
      if (!w.label) continue;
      const score = scoreTextMatch(w.scanned.label, lower);
      if (score > 0) results.push({ wrapper: w, score });
    }
    results.sort((a, b) => b.score - a.score);
    return results;
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
