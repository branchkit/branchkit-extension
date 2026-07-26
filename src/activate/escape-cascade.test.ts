import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The cascade is the ONE declaration of what escape peels and in what order,
// for both the Escape key and the spoken "escape"/"over". These assert the
// order itself, and — the point of the exercise — that the two inputs run the
// same list rather than two lists kept in sync by a comment.

let pickPending = false;
const cancelled: string[] = [];
vi.mock('./range-disambiguation', () => ({
  isRangePickPending: () => pickPending,
  cancelRangePick: (r: string) => { cancelled.push(r); pickPending = false; },
}));

let caretActive = false;
const caretEscapes: number[] = [];
vi.mock('./selection-commands', () => ({
  caret: {
    isActive: () => caretActive,
    escape: () => { caretEscapes.push(1); caretActive = false; },
  },
}));

let findBarOpen = false;
const findClosed: number[] = [];
vi.mock('../scan/find', () => ({
  isFindBarOpen: () => findBarOpen,
  closeFindMode: () => { findClosed.push(1); findBarOpen = false; },
}));

let hintLayer: 'hint_prefix' | 'hint_mode' | null = null;
const hintPeels: string[] = [];
vi.mock('../core/singletons', () => ({
  keyHandler: {
    escapeHintLayer: () => {
      if (!hintLayer) return null;
      const peeled = hintLayer;
      hintPeels.push(peeled);
      // Mirror the real two-stage unwind: prefix first, then the mode.
      hintLayer = peeled === 'hint_prefix' ? 'hint_mode' : null;
      return peeled;
    },
  },
}));

import { runEscapeCascade } from './escape-cascade';

beforeEach(() => {
  pickPending = false;
  caretActive = false;
  findBarOpen = false;
  hintLayer = null;
  cancelled.length = 0;
  caretEscapes.length = 0;
  findClosed.length = 0;
  hintPeels.length = 0;
});
afterEach(() => vi.clearAllMocks());

describe('escape cascade', () => {
  it('peels nothing and says so when nothing is open', () => {
    expect(runEscapeCascade('test')).toBe('');
  });

  it('peels exactly ONE layer per invocation', () => {
    pickPending = true;
    caretActive = true;
    findBarOpen = true;

    expect(runEscapeCascade('test')).toBe('range_pick');
    expect(caretEscapes).toHaveLength(0);
    expect(findClosed).toHaveLength(0);
  });

  it('runs the declared order: pick → hint prefix → hint mode → selection → find', () => {
    pickPending = true;
    hintLayer = 'hint_prefix';
    caretActive = true;
    findBarOpen = true;

    const peeled: string[] = [];
    for (let i = 0; i < 6; i++) peeled.push(runEscapeCascade('test'));
    expect(peeled).toEqual([
      'range_pick', 'hint_prefix', 'hint_mode', 'selection', 'find', '',
    ]);
  });

  it('a question awaiting an answer outranks a mode you are also in', () => {
    // A pick captures the keyboard, so both are true at once. The pick wins:
    // escaping the mode while its question stayed open would strand it.
    pickPending = true;
    hintLayer = 'hint_mode';
    expect(runEscapeCascade('test')).toBe('range_pick');
    expect(hintPeels).toHaveLength(0);
  });

  it('reports the reason to the layer that consumed it', () => {
    pickPending = true;
    runEscapeCascade('key_escape');
    expect(cancelled).toEqual(['key_escape']);
  });

  // The regression that motivated single-sourcing: the key exited hint mode via
  // its own handler while the spoken cascade peeled nothing, because hint mode
  // was only ever in the key's list.
  it('peels hint mode — the layer the spoken path used to miss', () => {
    hintLayer = 'hint_mode';
    expect(runEscapeCascade('voice_escape')).toBe('hint_mode');
    expect(hintPeels).toEqual(['hint_mode']);
  });
});
