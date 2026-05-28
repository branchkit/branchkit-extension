import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  isAllOwn,
  onTargetMutation,
  trackTargetMutations,
  untrackTargetMutations,
  __testing,
} from './target-mutation-tracker';

beforeEach(() => {
  __testing.reset();
  document.body.innerHTML = '';
});

function mkTarget(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

function mkHintHost(): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('data-branchkit-hint', 'true');
  return el;
}

describe('isAllOwn', () => {
  it('treats data-branchkit-hint attribute targets as own', () => {
    const host = mkHintHost();
    const record = {
      type: 'attributes',
      target: host,
      addedNodes: [] as unknown as NodeList,
      removedNodes: [] as unknown as NodeList,
      attributeName: 'style',
      attributeNamespace: null,
      oldValue: null,
      nextSibling: null,
      previousSibling: null,
    } as MutationRecord;
    expect(isAllOwn([record])).toBe(true);
  });

  it('treats non-hint attribute targets as foreign', () => {
    const target = mkTarget();
    const record = {
      type: 'attributes',
      target,
      addedNodes: [] as unknown as NodeList,
      removedNodes: [] as unknown as NodeList,
      attributeName: 'class',
      attributeNamespace: null,
      oldValue: null,
      nextSibling: null,
      previousSibling: null,
    } as MutationRecord;
    expect(isAllOwn([record])).toBe(false);
  });

  it('is foreign if even one added/removed node is not a hint host', () => {
    const host = mkHintHost();
    const target = mkTarget();
    const fragment = document.createDocumentFragment();
    fragment.appendChild(host);
    fragment.appendChild(target);
    const record = {
      type: 'childList',
      target: document.body,
      addedNodes: fragment.childNodes,
      removedNodes: [] as unknown as NodeList,
      attributeName: null,
      attributeNamespace: null,
      oldValue: null,
      nextSibling: null,
      previousSibling: null,
    } as MutationRecord;
    expect(isAllOwn([record])).toBe(false);
  });
});

describe('track / untrack', () => {
  it('tracks a target once and reports count', () => {
    const a = mkTarget();
    expect(__testing.trackedCount()).toBe(0);
    trackTargetMutations(a);
    expect(__testing.isTracked(a)).toBe(true);
    expect(__testing.trackedCount()).toBe(1);
  });

  it('tracking the same target twice is a no-op', () => {
    const a = mkTarget();
    trackTargetMutations(a);
    trackTargetMutations(a);
    expect(__testing.trackedCount()).toBe(1);
  });

  it('untrack disconnects and removes from registry', () => {
    const a = mkTarget();
    trackTargetMutations(a);
    untrackTargetMutations(a);
    expect(__testing.isTracked(a)).toBe(false);
    expect(__testing.trackedCount()).toBe(0);
  });

  it('untrack of an unknown target is a no-op', () => {
    const a = mkTarget();
    untrackTargetMutations(a);
    expect(__testing.trackedCount()).toBe(0);
  });
});

describe('callback firing', () => {
  it('fires the callback when a tracked target gets a foreign class change', async () => {
    const cb = vi.fn();
    onTargetMutation(cb);
    const a = mkTarget();
    trackTargetMutations(a);

    a.className = 'changed';

    // MutationObserver delivers via microtask.
    await Promise.resolve();
    await Promise.resolve();

    expect(cb).toHaveBeenCalledWith(a);
  });

  it('fires when a child is added to the tracked subtree', async () => {
    const cb = vi.fn();
    onTargetMutation(cb);
    const a = mkTarget();
    trackTargetMutations(a);

    const child = document.createElement('span');
    a.appendChild(child);

    await Promise.resolve();
    await Promise.resolve();

    expect(cb).toHaveBeenCalledWith(a);
  });

  it('does not fire after untrack', async () => {
    const cb = vi.fn();
    onTargetMutation(cb);
    const a = mkTarget();
    trackTargetMutations(a);
    untrackTargetMutations(a);

    a.className = 'changed';
    await Promise.resolve();
    await Promise.resolve();

    expect(cb).not.toHaveBeenCalled();
  });
});
