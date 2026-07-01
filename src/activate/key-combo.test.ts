import { describe, it, expect, vi } from 'vitest';
import {
  comboFromEvent,
  serializeCombo,
  parseCombo,
  canonicalizeKeys,
  comboDisplay,
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

describe('canonicalizeKeys', () => {
  it('normalizes cmd to meta and modifier order', () => {
    expect(canonicalizeKeys('cmd+KeyX')).toBe('meta+KeyX');
    expect(canonicalizeKeys('shift+ctrl+KeyA')).toBe('ctrl+shift+KeyA');
  });

  it('canonicalizes each combo of a chord sequence independently', () => {
    expect(canonicalizeKeys('KeyC KeyS')).toBe('KeyC KeyS');
    expect(canonicalizeKeys('cmd+KeyK  cmd+KeyS')).toBe('meta+KeyK meta+KeyS');
  });

  it('is idempotent and passes canonical specs through unchanged', () => {
    expect(canonicalizeKeys('ctrl+KeyF')).toBe('ctrl+KeyF');
    expect(canonicalizeKeys(canonicalizeKeys('cmd+KeyX'))).toBe('meta+KeyX');
  });
});
