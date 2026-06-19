import { describe, it, expect, afterEach } from 'vitest';
import { buildHelpModel, buildAlphabetModel } from './help-overlay';
import type { CommandMeta, KeymapEntry } from '../command-catalog';
import { setAlphabet, clearAlphabet } from '../labels/words';

function cmd(id: string, group: string, label = id, description = 'd'): CommandMeta {
  return { id, label, group, description, mappable: true, params: [] };
}

describe('buildHelpModel', () => {
  it('groups bound commands by catalog group, preserving catalog order', () => {
    const catalog = [cmd('a', 'Scroll'), cmd('b', 'Find'), cmd('c', 'Scroll')];
    const keymap: KeymapEntry[] = [
      { keys: 'shift+KeyJ', command: 'a' },
      { keys: 'Slash', command: 'b' },
      { keys: 'KeyL', command: 'c' },
    ];
    const model = buildHelpModel(catalog, keymap);
    expect(model.map((g) => g.group)).toEqual(['Scroll', 'Find']);
    expect(model[0].rows.map((r) => r.label)).toEqual(['a', 'c']);
  });

  it('omits commands with no binding', () => {
    const catalog = [cmd('a', 'Scroll'), cmd('runtime', 'Hints')];
    const model = buildHelpModel(catalog, [{ keys: 'shift+KeyJ', command: 'a' }]);
    expect(model).toHaveLength(1);
    expect(model[0].rows).toHaveLength(1);
    expect(model[0].rows[0].label).toBe('a');
  });

  it('shows every binding of a command, formatted for display', () => {
    const catalog = [cmd('scroll_left', 'Scroll')];
    const keymap: KeymapEntry[] = [
      { keys: 'KeyH', command: 'scroll_left' },
      { keys: 'shift+KeyA', command: 'scroll_left' },
    ];
    const model = buildHelpModel(catalog, keymap);
    expect(model[0].rows[0].keys).toEqual(['H', 'Shift+A']);
  });

  it('formats space-joined key sequences and punctuation', () => {
    const catalog = [cmd('cyc', 'Scroll'), cmd('help', 'Help')];
    const keymap: KeymapEntry[] = [
      { keys: 'KeyC KeyS', command: 'cyc' },
      { keys: 'shift+Slash', command: 'help' },
    ];
    const model = buildHelpModel(catalog, keymap);
    expect(model[0].rows[0].keys).toEqual(['C S']);
    expect(model[1].rows[0].keys).toEqual(['Shift+/']);
  });
});

describe('buildAlphabetModel', () => {
  afterEach(() => clearAlphabet());

  it('reports not-loaded with 26 entries before an alphabet is set', () => {
    clearAlphabet();
    const m = buildAlphabetModel();
    expect(m.loaded).toBe(false);
    expect(m.entries).toHaveLength(26);
    expect(m.entries[0].letter).toBe('a');
  });

  it('maps each letter to its spoken word once loaded', () => {
    const words = Array.from({ length: 26 }, (_, i) => `w${i}`);
    setAlphabet(words);
    const m = buildAlphabetModel();
    expect(m.loaded).toBe(true);
    expect(m.entries[0]).toEqual({ letter: 'a', word: 'w0' });
    expect(m.entries[25]).toEqual({ letter: 'z', word: 'w25' });
  });
});
