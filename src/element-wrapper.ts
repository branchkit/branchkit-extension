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

  destroy(): void {
    if (this.hint) {
      this.hint.remove();
      this.hint = null;
    }
  }
}

export class WrapperStore {
  private wrappers: ElementWrapper[] = [];

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
  }

  set(wrappers: ElementWrapper[]): void {
    this.clear();
    this.wrappers = wrappers;
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
