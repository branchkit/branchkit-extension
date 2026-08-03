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
const insertExits: number[] = [];
// Forced insert, as the epilogue reads it (production: KeyHandler.forcedInsert).
// Outer bindings are safe here for the same reason the arrays are: only
// written when a test calls into them, never at import.
let forcedInsert = false;
// setEscapeHook is called at escape-cascade's IMPORT now, so the fake has to
// answer it — and capturing what it was handed is what lets the registration
// itself be asserted below rather than merely assumed.
//
// The capture lives INSIDE the factory on purpose. ESM hoists the
// `import './escape-cascade'` below above every top-level let/const in this
// file, so an outer binding written at import time is a TDZ error (it was —
// "Cannot access 'installedEscapeHook' before initialization"). The sibling
// arrays get away with being outer because they are only written when a test
// calls into them, never at import.
vi.mock('../core/singletons', () => {
  let escapeHook: (() => string) | null = null;
  return {
    keyHandler: {
      escapeHintMode: () => { hintPeels.push('hint_mode'); },
      exitVideoMode: () => { videoExits.push(1); },
      isForcedInsert: () => forcedInsert,
      exitInsertMode: () => { forcedInsert = false; insertExits.push(1); },
      setEscapeHook: (cb: () => string) => { escapeHook = cb; },
      _installedEscapeHook: () => escapeHook,
    },
  };
});

import { runEscapeCascade } from './escape-cascade';
import { keyHandler } from '../core/singletons';
import { modes } from '../core/modes';

/** What escape-cascade handed setEscapeHook at import (see the fake above). */
const installedEscapeHook = (): (() => string) | null =>
  (keyHandler as unknown as { _installedEscapeHook(): (() => string) | null })._installedEscapeHook();
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
  forcedInsert = false;
  cancelled.length = 0;
  caretExits.length = 0;
  findClosed.length = 0;
  hintPeels.length = 0;
  videoExits.length = 0;
  insertExits.length = 0;
});
afterEach(() => vi.clearAllMocks());

// The wiring, not the derivation. This used to be a content.ts line, and while
// it was, nothing could see it: escape-key-path.test.ts must REPLACE the hook
// with a recorder to read the peeled layer back, so it is green whether or not
// anything registers one in production. Here the fake singleton captures the
// registration instead of overwriting it, which is the only place the two
// implementations differ.
describe('the Escape key wiring belongs to this module', () => {
  it('registers a hook at import that runs this cascade, naming the key input', () => {
    const hook = installedEscapeHook();
    expect(hook).toBeTypeOf('function');

    modes.push('video');
    expect(hook!()).toBe('video');   // the real cascade ran, not a stub
    expect(videoExits).toEqual([1]); // and its exit effect fired

    // The reason string is the hook's, and it is what tells a peeled layer
    // which input unwound it — 'key_escape' vs the spoken 'voice_escape'.
    modes.push('range_pick');
    hook!();
    expect(cancelled).toEqual(['key_escape']);
  });
});

describe('escape cascade (derived from the mode stack)', () => {
  it('peels nothing and says so when nothing is open', () => {
    expect(runEscapeCascade('test')).toBe('');
  });

  // The epilogue: forced insert ("pass all") is voice-enterable, so the
  // cascade exits it — but only once the stack has nothing left to peel,
  // preserving the layers-first order of the old keyboard-only branch.
  it('exits forced insert as the epilogue, when the stack is empty', () => {
    forcedInsert = true;
    expect(runEscapeCascade('test')).toBe('insert');
    expect(insertExits).toEqual([1]);
    // Consumed: the next escape has nothing left.
    expect(runEscapeCascade('test')).toBe('');
  });

  it('a layer peels first; forced insert survives to the next escape', () => {
    forcedInsert = true;
    modes.push('video');
    expect(runEscapeCascade('test')).toBe('video');
    expect(insertExits).toHaveLength(0);
    expect(runEscapeCascade('test')).toBe('insert');
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
