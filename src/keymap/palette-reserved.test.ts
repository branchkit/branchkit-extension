import { describe, it, expect } from 'vitest';
import { DEFAULT_KEYMAP } from './command-catalog';
import { derivePaletteNav, navKeyToken } from './palette-reserved';

const nav = (keys: string, command: string) => derivePaletteNav([{ keys, command }]);

describe('derivePaletteNav — reserved letters', () => {
  it('reserves exactly d/g/j/k/u from the shipping keymap', () => {
    const { reserved } = derivePaletteNav(DEFAULT_KEYMAP);
    expect([...reserved].sort()).toEqual(['d', 'g', 'j', 'k', 'u']);
  });

  it('reserves nothing for a user who navigates with the arrow keys', () => {
    const { reserved, bindings } = derivePaletteNav([
      { keys: 'ArrowDown', command: 'scroll_down' },
      { keys: 'ArrowUp', command: 'scroll_up' },
    ]);
    expect(reserved.size).toBe(0);
    expect(bindings.size).toBe(0);
  });

  it('reserves through Shift, because the mark consumer lowercases', () => {
    expect([...nav('shift+KeyG', 'scroll_bottom').reserved]).toEqual(['g']);
  });

  it('reserves EVERY step of a sequence — the first press is eaten as a mark', () => {
    expect([...nav('KeyG KeyT', 'scroll_top').reserved].sort()).toEqual(['g', 't']);
  });

  it('reserves nothing for Ctrl/Meta/Alt chords, which never reach the mark path', () => {
    expect(nav('ctrl+KeyD', 'scroll_half_down').reserved.size).toBe(0);
    expect(nav('meta+KeyJ', 'scroll_down').reserved.size).toBe(0);
    expect(nav('alt+KeyK', 'scroll_up').reserved.size).toBe(0);
  });

  it('ignores commands outside the vertical family, so h/l stay label letters', () => {
    const { reserved } = derivePaletteNav(DEFAULT_KEYMAP);
    expect(reserved.has('h')).toBe(false);
    expect(reserved.has('l')).toBe(false);
  });

  it('ignores non-family bindings entirely (zoom keeps its letters)', () => {
    expect(nav('KeyZ KeyI', 'zoom_in').reserved.size).toBe(0);
  });

  it('reserves a mixed sequence\'s typeable steps only', () => {
    // `g` is eaten as a mark before ctrl+t could ever arrive, so it must be
    // reserved even though the sequence can never complete in the palette.
    expect([...nav('KeyG ctrl+KeyT', 'scroll_top').reserved]).toEqual(['g']);
  });
});

describe('derivePaletteNav — dispatch table', () => {
  it('maps the shipping keymap to palette intents', () => {
    const { bindings } = derivePaletteNav(DEFAULT_KEYMAP);
    expect(bindings.get('j')).toBe('next');
    expect(bindings.get('k')).toBe('prev');
    expect(bindings.get('d')).toBe('pageNext');
    expect(bindings.get('u')).toBe('pagePrev');
    expect(bindings.get('g')).toBe('first');
    expect(bindings.get('shift+g')).toBe('last');
  });

  it('dispatches a sequence on its FIRST step — gg is idempotent, so no timeout', () => {
    const { bindings } = nav('KeyG KeyG', 'scroll_top');
    expect(bindings.get('g')).toBe('first');
    expect(bindings.size).toBe(1);
  });

  it('keeps g and shift+g distinct', () => {
    const { bindings } = derivePaletteNav([
      { keys: 'KeyG KeyG', command: 'scroll_top' },
      { keys: 'shift+KeyG', command: 'scroll_bottom' },
    ]);
    expect(bindings.get('g')).toBe('first');
    expect(bindings.get('shift+g')).toBe('last');
  });

  it('first binding wins when two family commands claim one token', () => {
    const { bindings } = derivePaletteNav([
      { keys: 'KeyJ', command: 'scroll_down' },
      { keys: 'KeyJ', command: 'scroll_half_down' },
    ]);
    expect(bindings.get('j')).toBe('next');
  });

  it('does not attach dispatch to a non-typeable first step', () => {
    const { bindings } = nav('ctrl+KeyG KeyG', 'scroll_top');
    expect(bindings.size).toBe(0);
  });
});

describe('navKeyToken', () => {
  it('normalizes a live keypress the way the table was built', () => {
    // Shift+G arrives as e.key === 'G'.
    expect(navKeyToken('G', true)).toBe('shift+g');
    expect(navKeyToken('g', false)).toBe('g');
  });
});
