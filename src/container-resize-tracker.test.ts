import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  onContainerResize,
  trackContainerResize,
  untrackContainerResize,
  __testing,
} from './container-resize-tracker';

beforeEach(() => {
  __testing.reset();
});

function el(): HTMLElement {
  return document.createElement('div');
}

describe('refcount', () => {
  it('counts up on track and down on untrack', () => {
    const a = el();
    expect(__testing.getRefCount(a)).toBe(0);
    trackContainerResize(a);
    expect(__testing.getRefCount(a)).toBe(1);
    trackContainerResize(a);
    expect(__testing.getRefCount(a)).toBe(2);
    untrackContainerResize(a);
    expect(__testing.getRefCount(a)).toBe(1);
    untrackContainerResize(a);
    expect(__testing.getRefCount(a)).toBe(0);
  });

  it('untrack below zero is a no-op', () => {
    const a = el();
    untrackContainerResize(a);
    expect(__testing.getRefCount(a)).toBe(0);
  });

  it('tracks containers independently', () => {
    const a = el();
    const b = el();
    trackContainerResize(a);
    trackContainerResize(a);
    trackContainerResize(b);
    expect(__testing.getRefCount(a)).toBe(2);
    expect(__testing.getRefCount(b)).toBe(1);
    untrackContainerResize(a);
    expect(__testing.getRefCount(a)).toBe(1);
    expect(__testing.getRefCount(b)).toBe(1);
  });
});

describe('callback firing', () => {
  it('skips the initial fire per target', () => {
    const cb = vi.fn();
    onContainerResize(cb);
    const a = el();
    trackContainerResize(a);
    __testing.simulateResize([a]);
    expect(cb).not.toHaveBeenCalled();
  });

  it('fires on subsequent resizes', () => {
    const cb = vi.fn();
    onContainerResize(cb);
    const a = el();
    trackContainerResize(a);
    __testing.simulateResize([a]);
    __testing.simulateResize([a]);
    expect(cb).toHaveBeenCalledTimes(1);
    __testing.simulateResize([a]);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('fires once per entry batch even when multiple targets resize', () => {
    const cb = vi.fn();
    onContainerResize(cb);
    const a = el();
    const b = el();
    trackContainerResize(a);
    trackContainerResize(b);
    __testing.simulateResize([a, b]);
    __testing.simulateResize([a, b]);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('resets first-fire memory after full untrack so re-register skips again', () => {
    const cb = vi.fn();
    onContainerResize(cb);
    const a = el();
    trackContainerResize(a);
    __testing.simulateResize([a]);
    __testing.simulateResize([a]);
    expect(cb).toHaveBeenCalledTimes(1);

    untrackContainerResize(a);
    trackContainerResize(a);
    __testing.simulateResize([a]);
    expect(cb).toHaveBeenCalledTimes(1);
    __testing.simulateResize([a]);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('does nothing when no callback is registered', () => {
    const a = el();
    trackContainerResize(a);
    __testing.simulateResize([a]);
    __testing.simulateResize([a]);
  });
});
