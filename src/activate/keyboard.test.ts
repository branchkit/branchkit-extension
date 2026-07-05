import { describe, it, expect, beforeEach, vi } from 'vitest';
import { KeyHandler } from './keyboard';
import { ActionDispatcher, CommandRegistry } from '../dispatcher';

// Derive a plausible `event.code` from a `key` char, so synthetic events carry
// the layout-independent code the registry now matches on. Real browsers always
// set `code`; jsdom KeyboardEvent does not for hand-built keys.
function codeFor(key: string): string {
  if (/^[a-zA-Z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  const map: Record<string, string> = { '/': 'Slash', ' ': 'Space', '.': 'Period', ',': 'Comma' };
  return map[key] ?? key; // Escape / Enter / Backspace are read off e.key anyway
}

function makeKey(key: string, extra: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key,
    code: codeFor(key),
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...extra,
  } as unknown as KeyboardEvent;
}

let registry: CommandRegistry;
let dispatcher: ActionDispatcher;
let handler: KeyHandler;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let dispatchSpy: any;

beforeEach(() => {
  registry = new CommandRegistry();
  dispatcher = new ActionDispatcher();
  dispatchSpy = vi.fn();
  (dispatcher as any).dispatch = dispatchSpy;
  handler = new KeyHandler(registry, dispatcher);
});

// The keyboard is Normal by default (notes/DESIGN_KEYBOARD_MODES.md). Hints
// stay always-VISIBLE for voice, but letters only filter them in the explicit
// hint mode entered by `f`. Everywhere else the alphabet is Normal-mode
// keybinds.

describe('hint mode entry/exit', () => {
  it('enterHintMode sets mode to hint and fires the mode callback', () => {
    const modeCb = vi.fn();
    handler.setModeChangeCallback(modeCb);
    handler.enterHintMode();
    expect(handler.getMode()).toBe('hint');
    expect(modeCb).toHaveBeenCalledWith('hint');
  });

  it('exitHintMode resets to normal and fires the mode callback', () => {
    const modeCb = vi.fn();
    handler.setModeChangeCallback(modeCb);
    handler.enterHintMode();
    handler.exitHintMode();
    expect(handler.getMode()).toBe('normal');
    expect(modeCb).toHaveBeenLastCalledWith('normal');
  });

  it('exitHintMode from normal does not re-fire the callback', () => {
    const modeCb = vi.fn();
    handler.setModeChangeCallback(modeCb);
    handler.exitHintMode();
    expect(modeCb).not.toHaveBeenCalled();
  });
});

describe('hint mode — codeword filtering', () => {
  it('letter keys in hint mode append to filter and fire callback', () => {
    const cb = vi.fn();
    handler.setFilterCallback(cb);
    handler.enterHintMode();

    handler.handleKeyDown(makeKey('a'));
    expect(cb).toHaveBeenCalledWith('a');

    handler.handleKeyDown(makeKey('B'));
    expect(cb).toHaveBeenCalledWith('ab');
  });

  it('backspace in codeword mode removes last char', () => {
    const cb = vi.fn();
    handler.setFilterCallback(cb);
    handler.enterHintMode();

    handler.handleKeyDown(makeKey('a'));
    handler.handleKeyDown(makeKey('b'));
    handler.handleKeyDown(makeKey('Backspace'));
    expect(cb).toHaveBeenLastCalledWith('a');
  });

  it('enter dispatches activate_first_visible', () => {
    handler.enterHintMode();
    handler.handleKeyDown(makeKey('Enter'));
    expect(dispatchSpy).toHaveBeenCalledWith('activate_first_visible');
  });

  it('/ dispatches find_open (find-in-page), not a hint filter', () => {
    const cb = vi.fn();
    handler.setFilterCallback(cb);
    handler.enterHintMode();
    const result = handler.handleKeyDown(makeKey('/'));
    expect(result).toBe(true);
    expect(dispatchSpy).toHaveBeenCalledWith('find_open');
    expect(cb).not.toHaveBeenCalled();
  });

  it('escape exits hint mode (no prefix) and fires the escape callback', () => {
    // The badges do NOT hide from the KeyHandler — that's a content-side
    // visibility decision (always-visible keeps them; manual dismisses). We
    // just exit the mode and notify.
    const escapeCb = vi.fn();
    handler.setHintEscapeCallback(escapeCb);
    handler.enterHintMode();
    handler.handleKeyDown(makeKey('Escape'));
    expect(handler.getMode()).toBe('normal');
    expect(escapeCb).toHaveBeenCalled();
    expect(dispatchSpy).not.toHaveBeenCalledWith('hide_hints');
  });

  it('escape with a typed prefix cancels just the prefix and stays in hint mode', () => {
    const cb = vi.fn();
    handler.setFilterCallback(cb);
    handler.enterHintMode();
    handler.handleKeyDown(makeKey('a'));
    handler.handleKeyDown(makeKey('x'));

    const result = handler.handleKeyDown(makeKey('Escape'));
    expect(result).toBe(true);
    expect(cb).toHaveBeenLastCalledWith(''); // prefix cleared
    expect(handler.getMode()).toBe('hint'); // did NOT exit

    // A second Escape (no prefix in progress) exits to normal.
    handler.handleKeyDown(makeKey('Escape'));
    expect(handler.getMode()).toBe('normal');
  });

  it('intercepts inside an editable field (hint mode wins over insert)', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    const cb = vi.fn();
    handler.setFilterCallback(cb);
    handler.enterHintMode();

    const result = handler.handleKeyDown(makeKey('a'));
    expect(result).toBe(true);
    expect(cb).toHaveBeenCalledWith('a');
    input.remove();
  });
});

describe('new-tab casing (capital mid-codeword)', () => {
  it('arms new-tab when a capital is typed mid-codeword', () => {
    handler.enterHintMode();
    handler.handleKeyDown(makeKey('a')); // start codeword (lowercase)
    expect(handler.isNewTabArmed()).toBe(false);
    handler.handleKeyDown(makeKey('A', { shiftKey: true })); // capital, mid-codeword
    expect(handler.isNewTabArmed()).toBe(true);
  });

  it('does not arm for an all-lowercase codeword', () => {
    handler.enterHintMode();
    handler.handleKeyDown(makeKey('a'));
    handler.handleKeyDown(makeKey('b'));
    expect(handler.isNewTabArmed()).toBe(false);
  });

  it('disarms on exitHintMode (after a pick)', () => {
    handler.enterHintMode();
    handler.handleKeyDown(makeKey('a'));
    handler.handleKeyDown(makeKey('A', { shiftKey: true }));
    expect(handler.isNewTabArmed()).toBe(true);
    handler.exitHintMode();
    expect(handler.isNewTabArmed()).toBe(false);
  });

  it('disarms when the prefix is cleared with Escape', () => {
    handler.enterHintMode();
    handler.handleKeyDown(makeKey('a'));
    handler.handleKeyDown(makeKey('A', { shiftKey: true }));
    expect(handler.isNewTabArmed()).toBe(true);
    handler.handleKeyDown(makeKey('Escape')); // clears the prefix
    expect(handler.isNewTabArmed()).toBe(false);
  });
});

describe('codeword filter — match predicate (no blank-on-nonmatch)', () => {
  it('no-ops a first letter no codeword starts with (hints stay put)', () => {
    const cb = vi.fn();
    handler.setFilterCallback(cb);
    handler.enterHintMode();
    handler.setMatchPredicate((p) => p.startsWith('a')); // only "a…" codewords exist

    const result = handler.handleKeyDown(makeKey('k')); // no "k…" codeword
    expect(result).toBe(true); // consumed (doesn't fall through to the page)
    expect(cb).not.toHaveBeenCalled(); // filter NOT applied → nothing hidden
  });

  it('accepts a matching first letter and filters', () => {
    const cb = vi.fn();
    handler.setFilterCallback(cb);
    handler.enterHintMode();
    handler.setMatchPredicate((p) => p.startsWith('a'));

    handler.handleKeyDown(makeKey('a'));
    expect(cb).toHaveBeenCalledWith('a');
  });

  it('does not extend the prefix into a non-matching codeword', () => {
    const cb = vi.fn();
    handler.setFilterCallback(cb);
    handler.enterHintMode();
    handler.setMatchPredicate((p) => p === 'a' || p === 'ai');

    handler.handleKeyDown(makeKey('a'));
    expect(cb).toHaveBeenLastCalledWith('a');
    handler.handleKeyDown(makeKey('z')); // "az" matches nothing → no-op
    expect(cb).toHaveBeenLastCalledWith('a');
    handler.handleKeyDown(makeKey('i')); // "ai" matches
    expect(cb).toHaveBeenLastCalledWith('ai');
  });
});

describe('normal mode — bare letters are keybinds, even with hints painted', () => {
  it('a bare letter fires its keybind instead of filtering hints', () => {
    registry.add({ keys: 'KeyJ', action: 'scroll_down' });
    const cb = vi.fn();
    handler.setFilterCallback(cb);

    const result = handler.handleKeyDown(makeKey('j'));
    expect(result).toBe(true);
    expect(dispatchSpy).toHaveBeenCalledWith('scroll_down', {});
    expect(cb).not.toHaveBeenCalled(); // NOT a hint filter
    expect(handler.getMode()).toBe('normal');
  });

  it('an unbound bare letter falls through (reaches the page / other extensions)', () => {
    const cb = vi.fn();
    handler.setFilterCallback(cb);
    const result = handler.handleKeyDown(makeKey('z')); // nothing bound
    expect(result).toBe(false);
    expect(cb).not.toHaveBeenCalled();
  });

  it('yields to editable fields (Normal-mode keybinds do not hijack a search box)', () => {
    registry.add({ keys: 'KeyJ', action: 'scroll_down' });
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    const result = handler.handleKeyDown(makeKey('j'));
    expect(result).toBe(false);
    expect(dispatchSpy).not.toHaveBeenCalled();
    input.remove();
  });
});

describe('normal mode — command sequences', () => {
  it('exact match dispatches action', () => {
    registry.add({ keys: 'KeyF', action: 'hint_mode' });
    const result = handler.handleKeyDown(makeKey('f'));
    expect(result).toBe(true);
    expect(dispatchSpy).toHaveBeenCalledWith('hint_mode', {});
  });

  it('partial match waits for more keys', () => {
    registry.add({ keys: 'KeyG KeyG', action: 'scroll_top' });
    const result = handler.handleKeyDown(makeKey('g'));
    expect(result).toBe(true);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('multi-key sequence dispatches on completion', () => {
    registry.add({ keys: 'KeyG KeyG', action: 'scroll_top' });
    handler.handleKeyDown(makeKey('g'));
    handler.handleKeyDown(makeKey('g'));
    expect(dispatchSpy).toHaveBeenCalledWith('scroll_top', {});
  });

  it('no match resets sequence', () => {
    registry.add({ keys: 'KeyF', action: 'hint_mode' });
    const result = handler.handleKeyDown(makeKey('x'));
    expect(result).toBe(false);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('an unbound modifier combo passes through (native shortcut / other extension)', () => {
    registry.add({ keys: 'KeyC', action: 'some_action' }); // bare c, not Meta+C
    const result = handler.handleKeyDown(makeKey('c', { metaKey: true }));
    expect(result).toBe(false);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });
});

describe('normal mode — modifier-combo commands', () => {
  it('a bound modifier combo dispatches', () => {
    registry.add({ keys: 'ctrl+shift+KeyK', action: 'next_tab' });
    const result = handler.handleKeyDown(makeKey('k', { ctrlKey: true, shiftKey: true }));
    expect(result).toBe(true);
    expect(dispatchSpy).toHaveBeenCalledWith('next_tab', {});
  });

  it('a bound Shift+letter dispatches its command', () => {
    registry.add({ keys: 'shift+KeyG', action: 'scroll_bottom' });
    const result = handler.handleKeyDown(makeKey('G', { shiftKey: true }));
    expect(result).toBe(true);
    expect(dispatchSpy).toHaveBeenCalledWith('scroll_bottom', {});
  });

  it('a bound modifier combo fires even inside an editable field', () => {
    // Required for the palette / hide chords (Ctrl+K, Ctrl+S): they must fire
    // (and suppress the native shortcut) while focused in a search box.
    registry.add({ keys: 'ctrl+KeyK', action: 'do_thing' });
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    const result = handler.handleKeyDown(makeKey('k', { ctrlKey: true }));
    expect(result).toBe(true);
    expect(dispatchSpy).toHaveBeenCalledWith('do_thing', {});
    input.remove();
  });

  it('an unbound modifier combo in a field falls through (native shortcut)', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    const result = handler.handleKeyDown(makeKey('a', { ctrlKey: true })); // Ctrl+A select-all
    expect(result).toBe(false);
    expect(dispatchSpy).not.toHaveBeenCalled();
    input.remove();
  });
});
