import { describe, it, expect } from 'vitest';
import {
  COMMAND_CATALOG,
  COMMAND_BY_ID,
  DEFAULT_KEYMAP,
  type CommandMeta,
} from './command-catalog';

// The full set of actions registered via dispatcher.register in content.ts.
// Mirrored here as a drift guard: a new dispatcher action without a catalog
// entry (or vice-versa) fails this test, prompting the catalog update.
const REGISTERED_ACTIONS = [
  'show_hints', 'show_hints_newtab', 'hide_hints', 'toggle_hints',
  'activate_first_visible', 'activate_hint', 'show_hints_category',
  'scroll_down', 'scroll_up', 'scroll_half_down', 'scroll_half_up',
  'scroll_full_down', 'scroll_full_up',
  'scroll_top', 'scroll_bottom', 'scroll_left', 'scroll_right',
  'cycle_scroll_target', 'scroll', 'scroll_to_percent', 'scroll_to_element',
  'find_open', 'find_close', 'find_next', 'find_previous', 'find_immediate',
  'history_back', 'history_forward', 'refresh', 'focus_input',
  'next_tab', 'previous_tab', 'first_tab', 'last_tab', 'goto_tab', 'last_active_tab',
  'new_tab', 'close_tab', 'restore_tab', 'duplicate_tab', 'pin_tab', 'mute_tab',
  'move_tab_left', 'move_tab_right',
  'toggle_help',
] as const;

// Voice-only commands dispatched entirely in the background (SSE intercept),
// with no content-dispatcher registration: no keyboard form exists because
// the value is a runtime spoken word.
const VOICE_ONLY_BACKGROUND = ['switch_to_tab'] as const;

// Voice-only commands handled inline in content's BRANCHKIT_ACTION listener
// (the activate family shares plain activate's resolution path there), with
// no content-dispatcher registration: the target is a runtime spoken codeword.
const VOICE_ONLY_CONTENT = ['activate_hint_newtab', 'activate_hint_background'] as const;

const NOT_MAPPABLE = new Set([
  'activate_hint', 'find_immediate', 'scroll_to_element', 'scroll',
  ...VOICE_ONLY_BACKGROUND,
  ...VOICE_ONLY_CONTENT,
]);

describe('command catalog', () => {
  it('has a unique id per entry', () => {
    const ids = COMMAND_CATALOG.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers exactly the registered actions plus voice-only background commands', () => {
    const ids = new Set(COMMAND_CATALOG.map((c) => c.id));
    expect(ids).toEqual(new Set([...REGISTERED_ACTIONS, ...VOICE_ONLY_BACKGROUND, ...VOICE_ONLY_CONTENT]));
  });

  it('marks runtime-value actions as not mappable, everything else mappable', () => {
    for (const c of COMMAND_CATALOG) {
      expect(c.mappable).toBe(!NOT_MAPPABLE.has(c.id));
    }
  });

  it('gives every entry a non-empty label, group, and description', () => {
    for (const c of COMMAND_CATALOG) {
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.group.length).toBeGreaterThan(0);
      expect(c.description.length).toBeGreaterThan(0);
    }
  });

  it('builds COMMAND_BY_ID over every entry', () => {
    expect(COMMAND_BY_ID.size).toBe(COMMAND_CATALOG.length);
    for (const c of COMMAND_CATALOG) {
      expect(COMMAND_BY_ID.get(c.id)).toBe(c);
    }
  });
});

describe('command catalog — param schemas', () => {
  const allParams = COMMAND_CATALOG.flatMap((c: CommandMeta) => c.params);

  it('gives enum params a non-empty options list and a valid default', () => {
    for (const c of COMMAND_CATALOG) {
      for (const p of c.params) {
        if (p.type !== 'enum') continue;
        expect(p.options && p.options.length).toBeGreaterThan(0);
        if (p.default !== undefined) {
          expect(p.options).toContain(p.default);
        }
      }
    }
  });

  it('gives number params sane bounds and an in-range default', () => {
    for (const c of COMMAND_CATALOG) {
      for (const p of c.params) {
        if (p.type !== 'number') continue;
        if (p.min !== undefined && p.max !== undefined) {
          expect(p.min).toBeLessThanOrEqual(p.max);
        }
        if (p.default !== undefined) {
          const n = Number(p.default);
          expect(Number.isFinite(n)).toBe(true);
          if (p.min !== undefined) expect(n).toBeGreaterThanOrEqual(p.min);
          if (p.max !== undefined) expect(n).toBeLessThanOrEqual(p.max);
        }
      }
    }
  });

  it('only enum params carry options', () => {
    for (const p of allParams) {
      if (p.options) expect(p.type).toBe('enum');
    }
  });
});

describe('command catalog — voice patterns', () => {
  const withVoice = COMMAND_CATALOG.filter((c) => c.voice && c.voice.length > 0);

  it('gives every voice pattern a non-empty pattern string', () => {
    for (const c of withVoice) {
      for (const v of c.voice!) {
        expect(v.pattern.trim().length, `${c.id}`).toBeGreaterThan(0);
      }
    }
  });

  it('only references captures ({number}/{text}) that appear in the pattern', () => {
    for (const c of withVoice) {
      for (const v of c.voice!) {
        const captures = new Set(v.pattern.match(/\{(\w+)\}/g) ?? []);
        for (const val of Object.values(v.params ?? {})) {
          const m = val.match(/^\{(\w+)\}$/);
          if (m) expect(captures.has(val), `${c.id}: param ${val}`).toBe(true);
        }
      }
    }
  });

  it('attaches voice only to hint / scroll / find / navigation / tab commands this phase', () => {
    const allowed = new Set(['Hints', 'Scroll', 'Find', 'Navigation', 'Tabs']);
    for (const c of withVoice) {
      expect(allowed.has(c.group), `${c.id} in ${c.group}`).toBe(true);
    }
  });
});

describe('default keymap', () => {
  it('binds only mappable, known commands', () => {
    for (const entry of DEFAULT_KEYMAP) {
      const meta = COMMAND_BY_ID.get(entry.command);
      expect(meta, `unknown command ${entry.command}`).toBeDefined();
      expect(meta!.mappable, `${entry.command} is not mappable`).toBe(true);
    }
  });

  it('has no duplicate key bindings', () => {
    const keys = DEFAULT_KEYMAP.map((e) => e.keys);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('matches the shipping bindings in canonical combo tokens', () => {
    // Locks the defaults (and their token format) against accidental drift.
    expect(DEFAULT_KEYMAP).toEqual([
      { keys: 'ctrl+KeyS', command: 'toggle_hints' },
      { keys: 'shift+KeyJ', command: 'scroll_down' },
      { keys: 'shift+KeyK', command: 'scroll_up' },
      { keys: 'shift+KeyD', command: 'scroll_half_down' },
      { keys: 'shift+KeyU', command: 'scroll_half_up' },
      { keys: 'shift+KeyT', command: 'scroll_top' },
      { keys: 'shift+KeyG', command: 'scroll_bottom' },
      { keys: 'KeyH', command: 'scroll_left' },
      { keys: 'KeyL', command: 'scroll_right' },
      { keys: 'KeyC KeyS', command: 'cycle_scroll_target' },
      { keys: 'Slash', command: 'find_open' },
      { keys: 'KeyN', command: 'find_next' },
      { keys: 'shift+KeyN', command: 'find_previous' },
      { keys: 'shift+KeyH', command: 'previous_tab' },
      { keys: 'shift+KeyL', command: 'next_tab' },
      { keys: 'shift+Slash', command: 'toggle_help' },
      { keys: 'shift+KeyI', command: 'focus_input' },
      { keys: 'shift+KeyO', command: 'new_tab' },
      { keys: 'shift+KeyX', command: 'close_tab' },
      { keys: 'shift+KeyZ', command: 'restore_tab' },
      { keys: 'shift+KeyY', command: 'duplicate_tab' },
      { keys: 'shift+KeyP', command: 'pin_tab' },
      { keys: 'shift+KeyM', command: 'mute_tab' },
      { keys: 'shift+Digit1', command: 'first_tab' },
      { keys: 'shift+Digit9', command: 'last_tab' },
      { keys: 'shift+Digit6', command: 'last_active_tab' },
      { keys: 'shift+Comma', command: 'move_tab_left' },
      { keys: 'shift+Period', command: 'move_tab_right' },
    ]);
  });
});
