/**
 * BranchKit Browser — keyboard combo parsing, validation, matching, display.
 *
 * The show/hide-hints toggle is a user-chosen combo captured from a real
 * keypress and stored as a string. It MUST carry a Ctrl/Alt/Meta modifier:
 * in always-visible mode every bare key (and Shift+key) is consumed as a
 * codeword filter letter — the keydown handler only exempts ctrl/alt/meta —
 * and bare specials (Escape, Tab, Enter, `/`) are native-reserved. So the
 * only conflict-free keyspace is "real-modifier chords", which is the single
 * guardrail enforced by `isComboAllowed`.
 *
 * Stored format: modifiers in canonical order then the key's `code`, joined by
 * '+', e.g. "ctrl+KeyF", "alt+shift+KeyH". Matching keys off `event.code`
 * (layout-independent — macOS Alt mangles `event.key`). Legacy values like
 * "ctrl+f" (single-letter key token) still match via an `event.key` fallback.
 */

export const DEFAULT_HIDE_KEY = 'ctrl+KeyF';

export interface KeyCombo {
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
  shift: boolean;
  /** Non-modifier key, normally an `event.code` like "KeyF"/"Digit1"/"Semicolon". */
  code: string;
}

const MODIFIER_CODE = /^(Control|Alt|Meta|Shift)/;

export function comboFromEvent(e: KeyboardEvent): KeyCombo {
  return { ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey, shift: e.shiftKey, code: e.code };
}

/**
 * The denylist guardrail: a toggle combo must include a real modifier
 * (Ctrl/Alt/Meta) and a non-modifier key. Shift-only and bare keys are
 * rejected — they collide with codeword typing or native shortcuts.
 */
export function isComboAllowed(c: KeyCombo): boolean {
  if (!(c.ctrl || c.alt || c.meta)) return false;
  if (!c.code || MODIFIER_CODE.test(c.code)) return false;
  return true;
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

/** Does a real keypress match a stored combo spec? Exact-modifier match. */
export function matchesCombo(e: KeyboardEvent, spec: string): boolean {
  const c = parseCombo(spec);
  if (!c) return false;
  if (e.ctrlKey !== c.ctrl || e.altKey !== c.alt || e.metaKey !== c.meta || e.shiftKey !== c.shift) {
    return false;
  }
  if (e.code === c.code) return true;
  // Legacy single-letter token (old "ctrl+f"): fall back to event.key.
  if (c.code.length === 1 && e.key.toLowerCase() === c.code.toLowerCase()) return true;
  return false;
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
