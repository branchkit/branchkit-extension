import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  setTransformTriggerEnabled,
  isTransformTriggerEnabled,
  onTransformAncestorMutation,
  trackTransformAncestor,
  untrackTransformAncestor,
  __testing,
} from './transform-ancestor-tracker';

describe('transform-ancestor-tracker', () => {
  beforeEach(() => {
    __testing.reset();
    document.body.innerHTML = '';
  });

  it('gate defaults off and toggles', () => {
    expect(isTransformTriggerEnabled()).toBe(false);
    setTransformTriggerEnabled(true);
    expect(isTransformTriggerEnabled()).toBe(true);
  });

  it('refcounts shared ancestors: observe once, unobserve on last release', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);

    trackTransformAncestor(el); // badge A
    trackTransformAncestor(el); // badge B, same canvas viewport
    expect(__testing.getRefCount(el)).toBe(2);

    untrackTransformAncestor(el); // A leaves
    expect(__testing.getRefCount(el)).toBe(1); // still tracked for B

    untrackTransformAncestor(el); // B leaves
    expect(__testing.getRefCount(el)).toBe(0);
  });

  it('fires the wired callback on a mutation', () => {
    const cb = vi.fn();
    onTransformAncestorMutation(cb);
    __testing.fire();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('untracking one of many ancestors keeps the others observed', () => {
    const a = document.createElement('div');
    const b = document.createElement('div');
    document.body.append(a, b);
    trackTransformAncestor(a);
    trackTransformAncestor(b);
    untrackTransformAncestor(a);
    expect(__testing.getRefCount(a)).toBe(0);
    expect(__testing.getRefCount(b)).toBe(1);
  });
});
