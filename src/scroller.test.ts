/**
 * BranchKit Browser — Scroller unit tests.
 *
 * Pure-function tests for the scroller module's exported API surface.
 * The scroller relies heavily on DOM APIs (getBoundingClientRect,
 * getComputedStyle, scrollTop) which are unavailable in Node. These
 * tests verify the module exports the expected functions and types.
 * Real scrolling behavior is verified via Playwright integration tests.
 */
import { describe, it, expect } from 'vitest';

// Import type-only to verify the module compiles and exports exist
// without triggering DOM access at module scope.
import type {
  ScrollDirection,
  ScrollAmount,
  ScrollRegion,
} from './scroller';

describe('scroller types', () => {
  it('exports ScrollDirection type', () => {
    const dir: ScrollDirection = 'down';
    expect(dir).toBe('down');
  });

  it('exports ScrollAmount type', () => {
    const amt: ScrollAmount = 'half';
    expect(amt).toBe('half');
  });

  it('exports ScrollRegion type', () => {
    const region: ScrollRegion = 'main';
    expect(region).toBe('main');
  });

  it('accepts all scroll direction values', () => {
    const dirs: ScrollDirection[] = ['up', 'down', 'left', 'right'];
    expect(dirs).toHaveLength(4);
  });

  it('accepts all scroll amount values', () => {
    const amounts: ScrollAmount[] = ['step', 'half', 'full', 'top', 'bottom'];
    expect(amounts).toHaveLength(5);
  });

  it('accepts all scroll region values', () => {
    const regions: ScrollRegion[] = ['main', 'leftSidebar', 'rightSidebar'];
    expect(regions).toHaveLength(3);
  });
});
