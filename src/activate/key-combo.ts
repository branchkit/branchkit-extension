/**
 * BranchKit Browser — keyboard combo tokens: build, serialize, parse, display.
 *
 * A combo is captured from a real keypress (`comboFromEvent`) and serialized to
 * a canonical token: modifiers in canonical order, then the key's `code`,
 * joined by '+', e.g. "ctrl+KeyF", "alt+shift+KeyH", "KeyJ". Tokens key off
 * `event.code` (layout-independent — macOS Alt mangles `event.key`). These are
 * the keymap's binding format (command-catalog.ts); the command registry
 * matches a live keypress's token against them.
 */

export interface KeyCombo {
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
  shift: boolean;
  /** Non-modifier key, normally an `event.code` like "KeyF"/"Digit1"/"Semicolon". */
  code: string;
}

export function comboFromEvent(e: KeyboardEvent): KeyCombo {
  return { ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey, shift: e.shiftKey, code: e.code };
}

export function serializeCombo(c: KeyCombo): string {
  const parts: string[] = [];
  if (c.ctrl) parts.push('ctrl');
  if (c.alt) parts.push('alt');
  if (c.meta) parts.push('meta');
  if (c.shift) parts.push('shift');
  parts.push(c.code);
  return parts.join('+');
}

export function parseCombo(spec: string): KeyCombo | null {
  if (!spec) return null;
  const parts = spec.split('+');
  const code = parts.pop();
  if (!code) return null;
  const mods = new Set(parts.map(p => p.toLowerCase()));
  return {
    ctrl: mods.has('ctrl'),
    alt: mods.has('alt'),
    meta: mods.has('meta') || mods.has('cmd'),
    shift: mods.has('shift'),
    code,
  };
}

function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  const map: Record<string, string> = {
    Semicolon: ';', Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
    BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Quote: "'",
    Backquote: '`', Space: 'Space',
  };
  if (map[code]) return map[code];
  if (code.length === 1) return code.toUpperCase();
  return code;
}

/** Human label for a stored combo, e.g. "Ctrl+F", "Alt+Shift+H". */
export function comboDisplay(spec: string): string {
  const c = parseCombo(spec);
  if (!c) return spec;
  const parts: string[] = [];
  if (c.ctrl) parts.push('Ctrl');
  if (c.alt) parts.push('Alt');
  if (c.meta) parts.push('Cmd');
  if (c.shift) parts.push('Shift');
  parts.push(keyLabel(c.code));
  return parts.join('+');
}
