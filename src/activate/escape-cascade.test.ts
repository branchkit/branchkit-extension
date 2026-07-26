import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The cascade is the ONE declaration of what escape peels and in what order,
// for both the Escape key and the spoken "escape"/"over". These assert the
// order ITSELF, with every collaborator mocked and the cascade called directly.
//
// They do NOT prove the two inputs run the same list — this file used to claim
// that and it never could, because every case here calls runEscapeCascade() and
// the key reaches it through content.ts's keydown listener. All four ways the
// two had actually diverged lived in that gap and survived a commit that
// claimed to have closed it. escape-key-path.test.ts drives the real key path
// and is where the parity claim belongs; keep it that way.

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

// The SESSION predicate, not the bar's presence: the cascade peels a committed
// find (highlights + pill, bar already closed) exactly as it peels the box.
let findActive = false;
const findClosed: number[] = [];
vi.mock('../scan/find', () => ({
  isFindActive: () => findActive,
  closeFindMode: () => { findClosed.push(1); findActive = false; },
}));

let hintLayer: 'hint_prefix' | 'hint_mode' | null = null;
let videoMode = false;
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
    isVideoMode: () => videoMode,
    exitVideoMode: () => { videoMode = false; },
  },
}));

import { runEscapeCascade } from './escape-cascade';

beforeEach(() => {
  pickPending = false;
  caretActive = false;
  findActive = false;
  hintLayer = null;
  videoMode = false;
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
    findActive = true;

    expect(runEscapeCascade('test')).toBe('range_pick');
    expect(caretEscapes).toHaveLength(0);
    expect(findClosed).toHaveLength(0);
  });

  it('runs the declared order: pick → hint prefix → hint mode → selection → video → find', () => {
    pickPending = true;
    hintLayer = 'hint_prefix';
    caretActive = true;
    videoMode = true;
    findActive = true;

    const peeled: string[] = [];
    for (let i = 0; i < 7; i++) peeled.push(runEscapeCascade('test'));
    expect(peeled).toEqual([
      'range_pick', 'hint_prefix', 'hint_mode', 'selection', 'video', 'find', '',
    ]);
  });

  // The `w` layer is sticky and the plugin's video tag is hold-scoped, so no
  // plugin round trip can peel it — the cascade is the only thing that can.
  it('peels the video layer with nothing else open', () => {
    videoMode = true;
    expect(runEscapeCascade('voice_escape')).toBe('video');
    expect(videoMode).toBe(false);
  });

  // The find layer asked isFindBarOpen() — false the moment Enter commits — so
  // the spoken "over" could not dismiss a committed find at all.
  it('peels a committed find (no bar on screen, session still active)', () => {
    findActive = true;
    expect(runEscapeCascade('voice_escape')).toBe('find');
    expect(findClosed).toHaveLength(1);
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
