import { describe, it, expect, beforeEach } from 'vitest';
import {
  trackHostAttributes,
  untrackHostAttributes,
  __testing,
} from './host-attribute-tracker';

beforeEach(() => {
  __testing.reset();
  document.body.innerHTML = '';
});

function mkHost(): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('data-branchkit-hint', 'true');
  el.style.cssText = 'display:contents;';
  document.body.appendChild(el);
  return el;
}

describe('reconcile', () => {
  it('restores data-branchkit-hint when stripped', () => {
    const host = mkHost();
    host.removeAttribute('data-branchkit-hint');
    __testing.reconcile(host, 'data-branchkit-hint');
    expect(host.getAttribute('data-branchkit-hint')).toBe('true');
  });

  it('restores data-branchkit-hint when changed to wrong value', () => {
    const host = mkHost();
    host.setAttribute('data-branchkit-hint', 'tampered');
    __testing.reconcile(host, 'data-branchkit-hint');
    expect(host.getAttribute('data-branchkit-hint')).toBe('true');
  });

  it('restores display:contents when style is cleared', () => {
    const host = mkHost();
    host.style.cssText = '';
    __testing.reconcile(host, 'style');
    expect(host.style.display).toBe('contents');
  });

  it('strips unrecognized attributes', () => {
    const host = mkHost();
    host.setAttribute('data-page-added', 'foo');
    __testing.reconcile(host, 'data-page-added');
    expect(host.hasAttribute('data-page-added')).toBe(false);
  });

  it('leaves data-branchkit-hint alone if already correct', () => {
    const host = mkHost();
    __testing.reconcile(host, 'data-branchkit-hint');
    expect(host.getAttribute('data-branchkit-hint')).toBe('true');
  });
});

describe('track / untrack', () => {
  it('tracks a host once', () => {
    const host = mkHost();
    trackHostAttributes(host);
    expect(__testing.isTracked(host)).toBe(true);
    expect(__testing.trackedCount()).toBe(1);
  });

  it('tracking the same host twice is a no-op', () => {
    const host = mkHost();
    trackHostAttributes(host);
    trackHostAttributes(host);
    expect(__testing.trackedCount()).toBe(1);
  });

  it('untrack disconnects and removes from registry', () => {
    const host = mkHost();
    trackHostAttributes(host);
    untrackHostAttributes(host);
    expect(__testing.isTracked(host)).toBe(false);
  });

  it('untrack of an unknown host is a no-op', () => {
    const host = mkHost();
    untrackHostAttributes(host);
    expect(__testing.trackedCount()).toBe(0);
  });
});

describe('observation', () => {
  it('restores data-branchkit-hint after page strip', async () => {
    const host = mkHost();
    trackHostAttributes(host);

    host.removeAttribute('data-branchkit-hint');
    await Promise.resolve();
    await Promise.resolve();

    expect(host.getAttribute('data-branchkit-hint')).toBe('true');
  });

  it('strips a page-added attribute', async () => {
    const host = mkHost();
    trackHostAttributes(host);

    host.setAttribute('data-page-added', 'bad');
    await Promise.resolve();
    await Promise.resolve();

    expect(host.hasAttribute('data-page-added')).toBe(false);
  });

  it('does nothing after untrack', async () => {
    const host = mkHost();
    trackHostAttributes(host);
    untrackHostAttributes(host);

    host.setAttribute('data-page-added', 'bad');
    await Promise.resolve();
    await Promise.resolve();

    expect(host.hasAttribute('data-page-added')).toBe(true);
  });
});
