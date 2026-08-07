/**
 * The shared bottom-right overlay stack.
 *
 * The point of the module is that co-anchored corner overlays compose by layout
 * instead of overlapping — so these assert the container is a single shared,
 * bottom-anchored flex column, that members carry their corner-outward `order`,
 * and that it reaps itself when the last member leaves (no empty fixed scaffold
 * left on the page) and self-heals if the DOM is wiped under it.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  mountInStack,
  reapStackIfEmpty,
  purgeOrphanedOverlayStacks,
  _stackForTesting,
  _resetOverlayStackForTesting,
} from './overlay-stack';

afterEach(() => {
  _resetOverlayStackForTesting();
  document.body.innerHTML = '';
});

const host = () => document.querySelector('[data-branchkit-overlay-stack]') as HTMLElement | null;

describe('overlay-stack', () => {
  it('mounts members into one shared bottom-anchored flex column', () => {
    const a = document.createElement('div');
    const b = document.createElement('div');
    mountInStack(a, 'mode');
    mountInStack(b, 'toast');

    const h = host();
    expect(h).not.toBeNull();
    expect(a.parentElement).toBe(h);
    expect(b.parentElement).toBe(h);
    expect(document.querySelectorAll('[data-branchkit-overlay-stack]').length).toBe(1);
    expect(h!.style.position).toBe('fixed');
    expect(h!.style.bottom).toBe('12px');
    expect(h!.style.right).toBe('12px');
    expect(h!.style.flexDirection).toBe('column');
  });

  it('orders members corner-outward: find nearest, then mode, then toast', () => {
    const find = document.createElement('div');
    const mode = document.createElement('div');
    const toast = document.createElement('div');
    mountInStack(find, 'find');
    mountInStack(mode, 'mode');
    mountInStack(toast, 'toast');
    // Higher CSS order = lower in a column = nearer the pinned corner.
    expect(Number(find.style.order)).toBeGreaterThan(Number(mode.style.order));
    expect(Number(mode.style.order)).toBeGreaterThan(Number(toast.style.order));
  });

  it('re-enables pointer events on members (the scaffold itself is click-through)', () => {
    const a = document.createElement('div');
    mountInStack(a, 'mode');
    expect(host()!.style.pointerEvents).toBe('none');
    expect(a.style.pointerEvents).toBe('auto');
  });

  it('reaps the host once the last member is removed', () => {
    const a = document.createElement('div');
    mountInStack(a, 'mode');
    expect(host()).not.toBeNull();
    a.remove();
    reapStackIfEmpty();
    expect(host()).toBeNull();
  });

  it('keeps the host while any member remains', () => {
    const a = document.createElement('div');
    const b = document.createElement('div');
    mountInStack(a, 'mode');
    mountInStack(b, 'toast');
    a.remove();
    reapStackIfEmpty();
    expect(host()).not.toBeNull();
  });

  it('self-heals into a fresh host if the DOM is wiped under it', () => {
    const a = document.createElement('div');
    mountInStack(a, 'mode');
    const first = host();
    document.body.innerHTML = ''; // detaches the stale host
    const b = document.createElement('div');
    mountInStack(b, 'toast');
    expect(host()).not.toBeNull();
    expect(host()).not.toBe(first);
    expect(b.parentElement).toBe(host());
  });

  it('purges orphaned hosts left by a predecessor script', () => {
    // A stranded host from a "previous script", with no module memory of it.
    const orphan = document.createElement('div');
    orphan.setAttribute('data-branchkit-overlay-stack', '');
    document.body.appendChild(orphan);
    purgeOrphanedOverlayStacks();
    expect(host()).toBeNull();
  });
});
