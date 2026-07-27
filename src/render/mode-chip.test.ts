/**
 * The mode chip, and its refused-keystroke pulse.
 *
 * The pulse exists because refusing a keystroke silently reads as a fault: a
 * letter no codeword starts with is deliberately dropped (keyboard.ts
 * handleHintKey — taking it would blank every hint), and with no trace of the
 * drop the next Escape unsays nothing and leaves the mode instead, which looks
 * like a stray key ejecting you (field, 2026-07-27).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('../plugin/connection-mirror', () => ({ isBranchKitConnected: () => false }));

import { setModeChip, flashModeChipRefusal, _resetModeChipForTesting } from './mode-chip';

const chipEl = (): HTMLElement | null => {
  const host = document.querySelector('[data-branchkit-mode-chip]');
  return (host?.shadowRoot?.querySelector('.chip') as HTMLElement | null) ?? null;
};

afterEach(() => {
  _resetModeChipForTesting();
});

describe('setModeChip', () => {
  it('shows a chip for hint mode and none for normal', () => {
    setModeChip('hint');
    expect(chipEl()).not.toBeNull();
    setModeChip('normal');
    expect(chipEl()).toBeNull();
  });
});

describe('flashModeChipRefusal', () => {
  it('marks the chip so the refusal is visible', () => {
    setModeChip('hint');
    expect(chipEl()?.classList.contains('refused')).toBe(false);
    flashModeChipRefusal();
    expect(chipEl()?.classList.contains('refused')).toBe(true);
  });

  it('re-arms for a SECOND refusal — two wrong letters both report', () => {
    // The class is already applied after the first, so a naive add() would be
    // a no-op and the second refusal would pass unremarked. Typing several
    // wrong letters in a row is exactly when the feedback is needed most.
    setModeChip('hint');
    flashModeChipRefusal();
    const first = chipEl();
    flashModeChipRefusal();
    expect(chipEl()).toBe(first);                          // same element, not a rebuild
    expect(chipEl()?.classList.contains('refused')).toBe(true);
  });

  it('is a no-op with no chip up, rather than throwing', () => {
    setModeChip('normal');
    expect(() => flashModeChipRefusal()).not.toThrow();
  });

  it('does not survive a mode change — the chip is rebuilt clean', () => {
    setModeChip('hint');
    flashModeChipRefusal();
    setModeChip('caret');
    expect(chipEl()?.classList.contains('refused')).toBe(false);
  });
});
