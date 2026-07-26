import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The cascade derives the escape order from the mode stack — last pushed,
// first peeled, intra-mode transients first (Wave 3 C3). These assert the
// derivation and the per-mode exit effects with the effect modules mocked and
// the cascade called directly, over the REAL stack singleton.
//
// They do NOT prove the two inputs run the same derivation — every case here
// calls runEscapeCascade() and the key reaches it through content.ts's keydown
// listener. escape-key-path.test.ts drives the real key path and is where the
// parity claim belongs; keep it that way.

const cancelled: string[] = [];
vi.mock('./range-disambiguation', () => ({
  cancelRangePick: (r: string) => { cancelled.push(r); },
}));

const caretExits: number[] = [];
vi.mock('./selection-commands', () => ({
  caret: {
    exit: () => { caretExits.push(1); },
  },
}));

const findClosed: number[] = [];
vi.mock('../scan/find', () => ({
  closeFindMode: () => { findClosed.push(1); modes.pop('find'); },
}));

const hintPeels: string[] = [];
const videoExits: number[] = [];
vi.mock('../core/singletons', () => ({
  keyHandler: {
    escapeHintMode: () => { hintPeels.push('hint_mode'); },
    exitVideoMode: () => { videoExits.push(1); },
  },
}));

import { runEscapeCascade } from './escape-cascade';
import { modes } from '../core/modes';
import { setInnerTransientProbe, clearInnerTransientProbes } from '../core/mode-stack';

// Hint's typed prefix, as the probe models it: peels once, then the mode has
// no transient left (production: KeyHandler.peelHintPrefix).
let hintPrefix = false;
function installHintProbe(): void {
  setInnerTransientProbe('hint', () => {
    if (!hintPrefix) return null;
    hintPrefix = false;
    hintPeels.push('hint_prefix');
    return 'hint_prefix';
  });
}

beforeEach(() => {
  modes.reset();
  clearInnerTransientProbes();
  hintPrefix = false;
  cancelled.length = 0;
  caretExits.length = 0;
  findClosed.length = 0;
  hintPeels.length = 0;
  videoExits.length = 0;
});
afterEach(() => vi.clearAllMocks());

describe('escape cascade (derived from the mode stack)', () => {
  it('peels nothing and says so when nothing is open', () => {
    expect(runEscapeCascade('test')).toBe('');
  });

  it('peels exactly ONE layer per invocation — the newest', () => {
    modes.push('find');
    modes.push('caret');
    modes.push('range_pick');

    expect(runEscapeCascade('test')).toBe('range_pick');
    expect(caretExits).toHaveLength(0);
    expect(findClosed).toHaveLength(0);
  });

  it('the full tower unwinds in reverse entry order, transients first', () => {
    // Entered oldest to newest: a committed find, the video layer, a caret
    // session, hint mode with a typed prefix, and a pick armed over it all
    // (arming re-enters hint mode and pushes itself last, so this IS the
    // production shape of "a pick outranks everything").
    installHintProbe();
    modes.push('find');
    modes.push('video');
    modes.push('caret');
    modes.push('hint');
    hintPrefix = true;
    modes.push('range_pick');

    const peeled: string[] = [];
    for (let i = 0; i < 7; i++) peeled.push(runEscapeCascade('test'));
    expect(peeled).toEqual([
      'range_pick', 'hint_prefix', 'hint_mode', 'selection', 'video', 'find', '',
    ]);
  });

  // The `w` layer is sticky and the plugin's video tag is hold-scoped, so no
  // plugin round trip can peel it — the cascade is the only thing that can.
  it('peels the video layer with nothing else open', () => {
    modes.push('video');
    expect(runEscapeCascade('voice_escape')).toBe('video');
    expect(videoExits).toHaveLength(1);
    expect(modes.has('video')).toBe(false);
  });

  it('peels a committed find (no bar on screen, session still active)', () => {
    modes.push('find');
    expect(runEscapeCascade('voice_escape')).toBe('find');
    expect(findClosed).toHaveLength(1);
  });

  it('a question awaiting an answer outranks the mode it entered from', () => {
    // Arming a pick enters hint mode and then pushes itself — newest by
    // construction. Escaping the mode while its question stayed open would
    // strand it; temporal order makes the pick peel first without a rank.
    modes.push('hint');
    modes.push('range_pick');
    expect(runEscapeCascade('test')).toBe('range_pick');
    expect(hintPeels).toHaveLength(0);
    expect(modes.has('hint')).toBe(true);
  });

  it('a layer opened OVER a pending pick peels first — temporal, not ranked', () => {
    // The one place the old fixed rank and temporal order disagree, decided
    // by the design's resolved question 1: a voice command that genuinely
    // opens a new layer over a pick lands above it and peels first.
    modes.push('range_pick');
    modes.push('hint');
    expect(runEscapeCascade('test')).toBe('hint_mode');
    expect(cancelled).toHaveLength(0);
    expect(modes.has('range_pick')).toBe(true);
  });

  it('reports the reason to the layer that consumed it', () => {
    modes.push('range_pick');
    runEscapeCascade('key_escape');
    expect(cancelled).toEqual(['key_escape']);
  });

  it('peels hint mode — the layer the spoken path used to miss', () => {
    modes.push('hint');
    expect(runEscapeCascade('voice_escape')).toBe('hint_mode');
    expect(hintPeels).toEqual(['hint_mode']);
  });

  it('the typed prefix peels before the mode, and the entry stays put', () => {
    installHintProbe();
    modes.push('hint');
    hintPrefix = true;
    expect(runEscapeCascade('test')).toBe('hint_prefix');
    expect(modes.has('hint')).toBe(true);
    expect(runEscapeCascade('test')).toBe('hint_mode');
    expect(modes.has('hint')).toBe(false);
  });

  it('caret\'s staged unwind reports as the selection layer', () => {
    setInnerTransientProbe('caret', () => {
      clearInnerTransientProbes(); // one stage, then only the exit remains
      return 'visual';
    });
    modes.push('caret');
    expect(runEscapeCascade('test')).toBe('selection'); // the collapse stage
    expect(caretExits).toHaveLength(0);
    expect(modes.has('caret')).toBe(true);
    expect(runEscapeCascade('test')).toBe('selection'); // the exit
    expect(caretExits).toHaveLength(1);
    expect(modes.has('caret')).toBe(false);
  });
});
