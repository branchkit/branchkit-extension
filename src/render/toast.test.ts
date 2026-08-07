/**
 * The ephemeral toast, and its stacking behavior.
 *
 * A toast used to replace whatever toast was up; now it joins the shared overlay
 * stack so several can coexist, the newest lands nearest the corner, a burst is
 * capped, and each self-dismisses on its own timer (reaping the stack when the
 * last one goes).
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flashToast, _resetToastForTesting } from './toast';
import { _stackForTesting, _resetOverlayStackForTesting } from './overlay-stack';

const toasts = (): HTMLElement[] =>
  [...(_stackForTesting()?.querySelectorAll('[data-branchkit-toast]') ?? [])] as HTMLElement[];

const textOf = (el: HTMLElement): string =>
  el.shadowRoot?.querySelector('.toast')?.textContent ?? '';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  _resetToastForTesting();
  _resetOverlayStackForTesting();
  vi.useRealTimers();
});

describe('flashToast', () => {
  it('stacks multiple toasts instead of replacing the previous one', () => {
    flashToast('Copied link');
    flashToast('Moved tab');
    expect(toasts().map(textOf)).toEqual(['Copied link', 'Moved tab']);
  });

  it('appends the newest last, so it renders nearest the pinned corner', () => {
    flashToast('older');
    flashToast('newer');
    const els = toasts();
    expect(textOf(els[els.length - 1])).toBe('newer');
  });

  it('caps the stack, evicting the oldest when a burst overflows', () => {
    flashToast('one');
    flashToast('two');
    flashToast('three');
    flashToast('four'); // over the cap of 3
    const shown = toasts().map(textOf);
    expect(shown).toHaveLength(3);
    expect(shown).not.toContain('one'); // oldest evicted
    expect(shown).toEqual(['two', 'three', 'four']);
  });

  it('self-dismisses after its ttl and reaps the empty stack', () => {
    flashToast('bye', 1000);
    expect(toasts()).toHaveLength(1);
    vi.advanceTimersByTime(1001);
    expect(toasts()).toHaveLength(0);
    // Nothing left in the corner: the stack host is gone, not left empty.
    expect(_stackForTesting()).toBeNull();
  });

  it('dismisses each toast on its own timer, not all at once', () => {
    flashToast('first', 1000);
    vi.advanceTimersByTime(400);
    flashToast('second', 1000);
    vi.advanceTimersByTime(601); // first hits 1001, second only 601
    expect(toasts().map(textOf)).toEqual(['second']);
  });
});
