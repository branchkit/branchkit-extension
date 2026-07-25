import { describe, it, expect } from 'vitest';
import {
  displayKeys,
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
