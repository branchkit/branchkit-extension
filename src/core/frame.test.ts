/**
 * BranchKit Browser — top-frame predicate tests.
 *
 * Small, but the value of this module is that the answer is read at CALL time
 * rather than cached at import — that is what makes every gate built on it
 * testable without a module reload, and it is the property a "tidy-up" to a
 * module-scope const would silently remove.
 *
 * Run: npm test
 */

import { describe, it, expect, afterEach } from 'vitest';
import { inTopFrame } from './frame';

const asFrame = (top: boolean) =>
  Object.defineProperty(window, 'top', {
    configurable: true, get: () => (top ? window : ({} as Window)),
  });

afterEach(() => asFrame(true));

describe('inTopFrame', () => {
  it('is true in the top frame and false in a subframe', () => {
    asFrame(true);
    expect(inTopFrame()).toBe(true);
    asFrame(false);
    expect(inTopFrame()).toBe(false);
  });

  it('re-reads on every call, so one import can observe both', () => {
    // A module-scope `const isTopFrame = window === window.top` would freeze
    // the first answer here and this would fail on the second flip.
    asFrame(false);
    expect(inTopFrame()).toBe(false);
    asFrame(true);
    expect(inTopFrame()).toBe(true);
    asFrame(false);
    expect(inTopFrame()).toBe(false);
  });
});
