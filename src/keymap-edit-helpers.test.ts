import { describe, it, expect } from 'vitest';
import {
  displayKeys,
  worksInAlwaysMode,
  alwaysModeNote,
  duplicateKeys,
} from './keymap-edit-helpers';

describe('displayKeys', () => {
  it('renders single combos', () => {
    expect(displayKeys('shift+KeyH')).toBe('Shift+H');
    expect(displayKeys('ctrl+KeyF')).toBe('Ctrl+F');
    expect(displayKeys('KeyJ')).toBe('J');
    expect(displayKeys('Slash')).toBe('/');
  });

  it('renders multi-key sequences token-by-token', () => {
    expect(displayKeys('KeyG KeyG')).toBe('G G');
    expect(displayKeys('KeyC KeyS')).toBe('C S');
  });
});

describe('worksInAlwaysMode', () => {
  it('accepts real-modifier chords', () => {
    expect(worksInAlwaysMode('ctrl+KeyF')).toBe(true);
    expect(worksInAlwaysMode('alt+KeyK')).toBe(true);
    expect(worksInAlwaysMode('meta+KeyP')).toBe(true);
    expect(worksInAlwaysMode('ctrl+shift+KeyK')).toBe(true);
  });

  it('accepts Shift+letter', () => {
    expect(worksInAlwaysMode('shift+KeyJ')).toBe(true);
    expect(worksInAlwaysMode('shift+KeyH')).toBe(true);
  });

  it('rejects bare keys (codeword-shadowed)', () => {
    expect(worksInAlwaysMode('KeyJ')).toBe(false);
    expect(worksInAlwaysMode('Slash')).toBe(false);
  });

  it('rejects Shift+non-letter (not routed to commands in always-mode)', () => {
    expect(worksInAlwaysMode('shift+Slash')).toBe(false);
  });

  it('rejects sequences (2nd key eaten by the codeword filter)', () => {
    expect(worksInAlwaysMode('KeyG KeyG')).toBe(false);
    expect(worksInAlwaysMode('shift+KeyG KeyG')).toBe(false);
  });
});

describe('alwaysModeNote', () => {
  it('is null for always-mode-capable binds', () => {
    expect(alwaysModeNote('shift+KeyJ')).toBeNull();
    expect(alwaysModeNote('ctrl+KeyF')).toBeNull();
  });

  it('returns guidance for bare keys and sequences', () => {
    expect(alwaysModeNote('KeyJ')).toMatch(/hidden/i);
    expect(alwaysModeNote('KeyG KeyG')).toMatch(/hidden/i);
  });
});

describe('duplicateKeys', () => {
  it('finds keys bound by more than one entry', () => {
    const dupes = duplicateKeys([
      { keys: 'KeyJ', command: 'scroll_down' },
      { keys: 'KeyJ', command: 'scroll_up' },
      { keys: 'KeyK', command: 'scroll_up' },
    ]);
    expect(dupes).toEqual(new Set(['KeyJ']));
  });

  it('is empty when all keys are distinct', () => {
    expect(duplicateKeys([
      { keys: 'KeyJ', command: 'scroll_down' },
      { keys: 'shift+KeyJ', command: 'scroll_down' },
    ])).toEqual(new Set());
  });
});
