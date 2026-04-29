/**
 * BranchKit Browser — Element wrapper and store.
 *
 * Lightweight wrapper that decouples element lifecycle from hint lifecycle.
 * Tracks viewport intersection, category, and adapter source.
 */

import { Category, ScannedElement } from './types';
import { LabelAssignment } from './words';
import { HintBadge } from './hints';

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
    for (const w of this.wrappers) {
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
    const upper = prefix.toUpperCase();
    return this.wrappers.filter(w => {
      if (!w.label) return false;
      return w.label.letter.startsWith(upper);
    });
  }
}
