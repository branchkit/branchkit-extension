import { describe, it, expect, vi } from 'vitest';
import {
  comboFromEvent,
  isComboAllowed,
  serializeCombo,
  parseCombo,
  matchesCombo,
  comboDisplay,
  DEFAULT_HIDE_KEY,
} from './key-combo';

function makeKey(code: string, key: string, mods: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    code,
    key,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...mods,
  } as unknown as KeyboardEvent;
}

describe('isComboAllowed — the modifier guardrail', () => {
  it('accepts a Ctrl chord', () => {
    expect(isComboAllowed(comboFromEvent(makeKey('KeyF', 'f', { ctrlKey: true })))).toBe(true);
  });
  it('accepts Alt and Meta chords', () => {
    expect(isComboAllowed(comboFromEvent(makeKey('KeyH', 'h', { altKey: true })))).toBe(true);
    expect(isComboAllowed(comboFromEvent(makeKey('KeyK', 'k', { metaKey: true })))).toBe(true);
  });
  it('rejects a bare key', () => {
    expect(isComboAllowed(comboFromEvent(makeKey('KeyF', 'f')))).toBe(false);
  });
  it('rejects a Shift-only combo (still a typing key)', () => {
    expect(isComboAllowed(comboFromEvent(makeKey('KeyF', 'F', { shiftKey: true })))).toBe(false);
  });
  it('rejects bare Escape', () => {
    expect(isComboAllowed(comboFromEvent(makeKey('Escape', 'Escape')))).toBe(false);
  });
  it('rejects a lone modifier (no real key)', () => {
    expect(isComboAllowed(comboFromEvent(makeKey('ControlLeft', 'Control', { ctrlKey: true })))).toBe(false);
  });
});

describe('serialize / parse round-trip', () => {
  it('serializes modifiers in canonical order + code', () => {
    const c = comboFromEvent(makeKey('KeyH', 'h', { altKey: true, shiftKey: true }));
    expect(serializeCombo(c)).toBe('alt+shift+KeyH');
  });
  it('parses back to the same flags', () => {
    const c = parseCombo('ctrl+alt+KeyF')!;
    expect(c).toMatchObject({ ctrl: true, alt: true, meta: false, shift: false, code: 'KeyF' });
  });
  it('accepts cmd as an alias for meta', () => {
    expect(parseCombo('cmd+KeyK')!.meta).toBe(true);
  });
});

describe('matchesCombo', () => {
  it('matches an exact chord', () => {
    expect(matchesCombo(makeKey('KeyF', 'f', { ctrlKey: true }), 'ctrl+KeyF')).toBe(true);
  });
  it('rejects when a modifier differs', () => {
    // spec is ctrl+f; pressing ctrl+shift+f must not match.
    expect(matchesCombo(makeKey('KeyF', 'F', { ctrlKey: true, shiftKey: true }), 'ctrl+KeyF')).toBe(false);
  });
  it('rejects when the key differs', () => {
    expect(matchesCombo(makeKey('KeyG', 'g', { ctrlKey: true }), 'ctrl+KeyF')).toBe(false);
  });
  it('matches the legacy single-letter spec via event.key', () => {
    expect(matchesCombo(makeKey('KeyF', 'f', { ctrlKey: true }), 'ctrl+f')).toBe(true);
  });
  it('default is Ctrl+F', () => {
    expect(matchesCombo(makeKey('KeyF', 'f', { ctrlKey: true }), DEFAULT_HIDE_KEY)).toBe(true);
  });
});

describe('comboDisplay', () => {
  it('renders a human label', () => {
    expect(comboDisplay('ctrl+KeyF')).toBe('Ctrl+F');
    expect(comboDisplay('alt+shift+KeyH')).toBe('Alt+Shift+H');
    expect(comboDisplay('meta+Semicolon')).toBe('Cmd+;');
  });
  it('renders the legacy single-letter spec', () => {
    expect(comboDisplay('ctrl+f')).toBe('Ctrl+F');
  });
});
