/**
 * BranchKit Browser — Element wrapper and store.
 *
 * Lightweight wrapper that decouples element lifecycle from hint lifecycle.
 * Tracks viewport intersection, category, and adapter source.
 */

import { Category, ScannedElement } from './types';
import { LabelAssignment } from './words';
import { HintBadge } from './hints';
import { HintCandidate } from './allocator';

export class ElementWrapper {
  element: Element;
  scanned: ScannedElement;
  hint: HintBadge | null = null;
  label: LabelAssignment | null = null;
  isInViewport: boolean = true;

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
    chrome.runtime.sendMessage({ type: 'RELEASE_LABELS', labels: [codeword] })
      .catch(() => {/* extension context may be invalidated */});
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
    id: w.scanned.selector,
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
