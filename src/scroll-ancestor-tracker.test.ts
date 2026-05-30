import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  onScrollAncestor,
  trackScrollAncestor,
  untrackScrollAncestor,
  __testing,
} from './scroll-ancestor-tracker';

beforeEach(() => {
  __testing.reset();
});

function el(): HTMLElement {
  return document.createElement('div');
}

describe('registration', () => {
  it('adds one container on first target, drops it with the last', () => {
    const c = el();
    const t1 = el();
    const t2 = el();
    expect(__testing.containerCount()).toBe(0);
    trackScrollAncestor(c, t1);
    trackScrollAncestor(c, t2);
    expect(__testing.containerCount()).toBe(1);
    expect(__testing.targetCount(c)).toBe(2);
    untrackScrollAncestor(c, t1);
    expect(__testing.containerCount()).toBe(1);
    expect(__testing.targetCount(c)).toBe(1);
    untrackScrollAncestor(c, t2);
    expect(__testing.containerCount()).toBe(0);
  });

  it('tracks containers independently', () => {
    const a = el();
    const b = el();
    trackScrollAncestor(a, el());
    trackScrollAncestor(b, el());
    expect(__testing.containerCount()).toBe(2);
  });

  it('untrack of an unknown target is a no-op', () => {
    const c = el();
    untrackScrollAncestor(c, el());
    expect(__testing.containerCount()).toBe(0);
  });

  it('attaches and detaches a real scroll listener on the container', () => {
    const c = el();
    const add = vi.spyOn(c, 'addEventListener');
    const remove = vi.spyOn(c, 'removeEventListener');
    const t = el();
    trackScrollAncestor(c, t);
    expect(add).toHaveBeenCalledWith('scroll', expect.any(Function), { passive: true });
    untrackScrollAncestor(c, t);
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

describe('callback batching', () => {
  it('hands the scrolled container\'s targets to the callback', () => {
    const cb = vi.fn();
    onScrollAncestor(cb);
    const c = el();
    const t1 = el();
    const t2 = el();
    trackScrollAncestor(c, t1);
    trackScrollAncestor(c, t2);
    __testing.simulateScroll(c);
    __testing.flushNow();
    expect(cb).toHaveBeenCalledTimes(1);
    const batch = new Set(cb.mock.calls[0][0]);
    expect(batch).toEqual(new Set([t1, t2]));
  });

  it('coalesces multiple scrolls in one frame into a single batch', () => {
    const cb = vi.fn();
    onScrollAncestor(cb);
    const a = el();
    const b = el();
    const ta = el();
    const tb = el();
    trackScrollAncestor(a, ta);
    trackScrollAncestor(b, tb);
    __testing.simulateScroll(a);
    __testing.simulateScroll(b);
    __testing.simulateScroll(a);
    __testing.flushNow();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(new Set(cb.mock.calls[0][0])).toEqual(new Set([ta, tb]));
  });

  it('does not fire after the container is fully untracked', () => {
    const cb = vi.fn();
    onScrollAncestor(cb);
    const c = el();
    const t = el();
    trackScrollAncestor(c, t);
    untrackScrollAncestor(c, t);
    __testing.simulateScroll(c); // listener was removed; schedule never runs
    __testing.flushNow();
    expect(cb).not.toHaveBeenCalled();
  });

  it('does nothing when no callback is registered', () => {
    const c = el();
    trackScrollAncestor(c, el());
    __testing.simulateScroll(c);
    __testing.flushNow();
  });
});
