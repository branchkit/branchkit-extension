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

describe('hint mode entry/exit', () => {
  it('enterHintMode sets mode to hint', () => {
    handler.enterHintMode();
    expect(handler.getMode()).toBe('hint');
  });

  it('exitHintMode resets to normal', () => {
    handler.enterHintMode();
    handler.exitHintMode();
    expect(handler.getMode()).toBe('normal');
  });

  it('exitHintMode resets filterByText flag', () => {
    handler.enterHintMode();
    handler.handleKeyDown(makeKey('/'));
    expect(handler.isFilteringByText()).toBe(true);
    handler.exitHintMode();
    expect(handler.isFilteringByText()).toBe(false);
  });
});

describe('hint mode — codeword filtering', () => {
  it('letter keys in hint mode append to filter and fire callback', () => {
    const cb = vi.fn();
    handler.setFilterCallback(cb);
    handler.enterHintMode();

    handler.handleKeyDown(makeKey('a'));
    expect(cb).toHaveBeenCalledWith('a', false);

    handler.handleKeyDown(makeKey('B'));
    expect(cb).toHaveBeenCalledWith('ab', false);
  });

  it('backspace in codeword mode removes last char', () => {
    const cb = vi.fn();
    handler.setFilterCallback(cb);
    handler.enterHintMode();

    handler.handleKeyDown(makeKey('a'));
    handler.handleKeyDown(makeKey('b'));
    handler.handleKeyDown(makeKey('Backspace'));
    expect(cb).toHaveBeenLastCalledWith('a', false);
  });

  it('escape exits hint mode', () => {
    handler.enterHintMode();
    handler.handleKeyDown(makeKey('Escape'));
    expect(handler.getMode()).toBe('normal');
    expect(dispatchSpy).toHaveBeenCalledWith('hide_hints');
  });

  it('escape with a typed prefix cancels just the prefix and stays in hint mode', () => {
    const cb = vi.fn();
    handler.setFilterCallback(cb);
    handler.enterHintMode();
    handler.handleKeyDown(makeKey('a'));
    handler.handleKeyDown(makeKey('x'));

    const result = handler.handleKeyDown(makeKey('Escape'));
    expect(result).toBe(true);
    expect(cb).toHaveBeenLastCalledWith('', false); // prefix cleared
    expect(handler.getMode()).toBe('hint'); // did NOT exit
    expect(dispatchSpy).not.toHaveBeenCalledWith('hide_hints');

    // A second Escape (no prefix in progress) hides + exits.
    handler.handleKeyDown(makeKey('Escape'));
    expect(handler.getMode()).toBe('normal');
    expect(dispatchSpy).toHaveBeenCalledWith('hide_hints');
  });
});

describe('new-tab casing (capital mid-codeword)', () => {
  it('arms new-tab when a capital is typed mid-codeword', () => {
    handler.setHintsVisible(() => true);
    handler.handleKeyDown(makeKey('a')); // start codeword (lowercase)
    expect(handler.isNewTabArmed()).toBe(false);
    handler.handleKeyDown(makeKey('A', { shiftKey: true })); // capital, mid-codeword
    expect(handler.isNewTabArmed()).toBe(true);
  });

  it('does not arm for an all-lowercase codeword', () => {
    handler.setHintsVisible(() => true);
    handler.handleKeyDown(makeKey('a'));
    handler.handleKeyDown(makeKey('b'));
    expect(handler.isNewTabArmed()).toBe(false);
  });

  it('disarms on exitHintMode (after a pick)', () => {
    handler.setHintsVisible(() => true);
    handler.handleKeyDown(makeKey('a'));
    handler.handleKeyDown(makeKey('A', { shiftKey: true }));
    expect(handler.isNewTabArmed()).toBe(true);
    handler.exitHintMode();
    expect(handler.isNewTabArmed()).toBe(false);
  });

  it('disarms when the prefix is cleared with Escape', () => {
    handler.setHintsVisible(() => true);
    handler.handleKeyDown(makeKey('a'));
    handler.handleKeyDown(makeKey('A', { shiftKey: true }));
    expect(handler.isNewTabArmed()).toBe(true);
    handler.handleKeyDown(makeKey('Escape')); // clears the prefix
    expect(handler.isNewTabArmed()).toBe(false);
  });

  it('disarms when backspaced all the way to empty', () => {
    handler.setHintsVisible(() => true);
    handler.handleKeyDown(makeKey('a'));
    handler.handleKeyDown(makeKey('A', { shiftKey: true }));
    handler.handleKeyDown(makeKey('Backspace'));
    handler.handleKeyDown(makeKey('Backspace'));
    expect(handler.isNewTabArmed()).toBe(false);
  });
});

describe('hint mode — text filter', () => {
  it('/ in hint mode switches to text filter mode', () => {
    const cb = vi.fn();
    handler.setFilterCallback(cb);
    handler.enterHintMode();

    handler.handleKeyDown(makeKey('/'));
    expect(handler.isFilteringByText()).toBe(true);
    expect(cb).toHaveBeenCalledWith('', true);
  });

  it('letters in text filter mode append to filterText with byText=true', () => {
    const cb = vi.fn();
    handler.setFilterCallback(cb);
    handler.enterHintMode();
    handler.handleKeyDown(makeKey('/'));

    handler.handleKeyDown(makeKey('s'));
    expect(cb).toHaveBeenCalledWith('s', true);

    handler.handleKeyDown(makeKey('e'));
    expect(cb).toHaveBeenCalledWith('se', true);
  });

  it('digits and spaces work in text filter mode', () => {
    const cb = vi.fn();
    handler.setFilterCallback(cb);
    handler.enterHintMode();
    handler.handleKeyDown(makeKey('/'));

    handler.handleKeyDown(makeKey('1'));
    expect(cb).toHaveBeenCalledWith('1', true);

    handler.handleKeyDown(makeKey(' '));
    expect(cb).toHaveBeenCalledWith('1 ', true);
  });

  it('backspace in text filter mode removes last char', () => {
    const cb = vi.fn();
    handler.setFilterCallback(cb);
    handler.enterHintMode();
    handler.handleKeyDown(makeKey('/'));
    handler.handleKeyDown(makeKey('a'));
    handler.handleKeyDown(makeKey('b'));

    handler.handleKeyDown(makeKey('Backspace'));
    expect(cb).toHaveBeenLastCalledWith('a', true);
  });

  it('backspace on empty text filter exits back to codeword mode', () => {
    const cb = vi.fn();
    handler.setFilterCallback(cb);
    handler.enterHintMode();
    handler.handleKeyDown(makeKey('/'));

    handler.handleKeyDown(makeKey('Backspace'));
    expect(handler.isFilteringByText()).toBe(false);
    expect(cb).toHaveBeenLastCalledWith('', false);
  });

  it('escape exits hint mode from text filter sub-mode', () => {
    handler.enterHintMode();
    handler.handleKeyDown(makeKey('/'));
    handler.handleKeyDown(makeKey('Escape'));
    expect(handler.getMode()).toBe('normal');
  });
});

describe('hint mode — enter', () => {
  it('enter dispatches activate_first_visible', () => {
    handler.enterHintMode();
    handler.handleKeyDown(makeKey('Enter'));
    expect(dispatchSpy).toHaveBeenCalledWith('activate_first_visible');
  });
});

describe('passive typing — hints visible without entering hint mode (f)', () => {
  it('letters filter when hints are visible, without enterHintMode', () => {
    const cb = vi.fn();
    handler.setFilterCallback(cb);
    handler.setHintsVisible(() => true);

    const result = handler.handleKeyDown(makeKey('a'));
    expect(result).toBe(true);
    expect(handler.getMode()).toBe('normal'); // never entered explicit hint mode
    expect(cb).toHaveBeenCalledWith('a', false);
  });

  it('a letter filters instead of firing its nav keybind when hints are visible', () => {
    registry.add({ keys: 'KeyJ', action: 'scroll_down' });
    const cb = vi.fn();
    handler.setFilterCallback(cb);
    handler.setHintsVisible(() => true);

    const result = handler.handleKeyDown(makeKey('j'));
    expect(result).toBe(true);
    expect(cb).toHaveBeenCalledWith('j', false);
    expect(dispatchSpy).not.toHaveBeenCalledWith('scroll_down', {});
  });

  it('Escape stays native under passive typing when no prefix is in progress', () => {
    handler.setHintsVisible(() => true);
    const result = handler.handleKeyDown(makeKey('Escape'));
    expect(result).toBe(false);
    expect(dispatchSpy).not.toHaveBeenCalledWith('hide_hints');
  });

  it('Shift+letter (no codeword started) routes to commands, not the codeword filter', () => {
    registry.add({ keys: 'shift+KeyG', action: 'scroll_bottom' });
    const cb = vi.fn();
    handler.setFilterCallback(cb);
    handler.setHintsVisible(() => true);

    const result = handler.handleKeyDown(makeKey('G', { shiftKey: true }));
    expect(result).toBe(true);
    expect(dispatchSpy).toHaveBeenCalledWith('scroll_bottom', {});
    expect(cb).not.toHaveBeenCalled(); // did NOT enter the codeword filter
  });

  it('Shift+J scrolls in always-mode (bare j is codeword input here)', () => {
    // The always-mode scroll form: a Shift duplicate of the bare scroll bind,
    // since bare j types a codeword while hints are painted.
    registry.add({ keys: 'shift+KeyJ', action: 'scroll_down' });
    const cb = vi.fn();
    handler.setFilterCallback(cb);
    handler.setHintsVisible(() => true);

    const result = handler.handleKeyDown(makeKey('J', { shiftKey: true }));
    expect(result).toBe(true);
    expect(dispatchSpy).toHaveBeenCalledWith('scroll_down', {});
    expect(cb).not.toHaveBeenCalled(); // did NOT enter the codeword filter
  });

  it('an unbound Shift+letter falls through (passes to other extensions) in always-mode', () => {
    const cb = vi.fn();
    handler.setFilterCallback(cb);
    handler.setHintsVisible(() => true);

    // No BranchKit command on 'H' → falls through (reaches Vimium-C etc.).
    const result = handler.handleKeyDown(makeKey('H', { shiftKey: true }));
    expect(result).toBe(false);
    expect(cb).not.toHaveBeenCalled();
  });

  it('lowercase letters still type codewords when hints are visible', () => {
    registry.add({ keys: 'KeyJ', action: 'scroll_down' });
    const cb = vi.fn();
    handler.setFilterCallback(cb);
    handler.setHintsVisible(() => true);

    handler.handleKeyDown(makeKey('j')); // lowercase
    expect(cb).toHaveBeenCalledWith('j', false);
    expect(dispatchSpy).not.toHaveBeenCalledWith('scroll_down', {});
  });

  it('a Shift+letter MID-codeword stays with the hint filter (reserved for new-tab casing)', () => {
    registry.add({ keys: 'shift+KeyA', action: 'some_cmd' });
    const cb = vi.fn();
    handler.setFilterCallback(cb);
    handler.setHintsVisible(() => true);

    handler.handleKeyDown(makeKey('a')); // start a codeword → filterText "a"
    expect(cb).toHaveBeenLastCalledWith('a', false);
    handler.handleKeyDown(makeKey('A', { shiftKey: true })); // capital mid-codeword
    expect(cb).toHaveBeenLastCalledWith('aa', false); // stayed in the filter (lowercased)
    expect(dispatchSpy).not.toHaveBeenCalledWith('some_cmd', {}); // did NOT divert to the command
  });

  it('in the text-filter (/) search, Shift+letters are query text, not commands', () => {
    registry.add({ keys: 'shift+KeyG', action: 'scroll_bottom' });
    const cb = vi.fn();
    handler.setFilterCallback(cb);
    handler.enterHintMode();
    handler.handleKeyDown(makeKey('/')); // enter text-filter search
    handler.handleKeyDown(makeKey('G', { shiftKey: true }));

    expect(cb).toHaveBeenLastCalledWith('g', true); // query text, not a command
    expect(dispatchSpy).not.toHaveBeenCalledWith('scroll_bottom', {});
  });

  it('Escape cancels an in-progress typed prefix under passive typing (the user case)', () => {
    const cb = vi.fn();
    handler.setFilterCallback(cb);
    handler.setHintsVisible(() => true);
    handler.handleKeyDown(makeKey('a')); // first letter of a hint
    handler.handleKeyDown(makeKey('x')); // wrong key

    const result = handler.handleKeyDown(makeKey('Escape'));
    expect(result).toBe(true); // consumed, not native
    expect(cb).toHaveBeenLastCalledWith('', false); // prefix reset
    expect(dispatchSpy).not.toHaveBeenCalledWith('hide_hints'); // hints stay visible

    // After cancel, a fresh letter starts a new hint cleanly.
    handler.handleKeyDown(makeKey('b'));
    expect(cb).toHaveBeenLastCalledWith('b', false);
  });

  it('passive typing yields to editable fields (insert mode passes through)', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    const cb = vi.fn();
    handler.setFilterCallback(cb);
    handler.setHintsVisible(() => true);

    const result = handler.handleKeyDown(makeKey('a'));
    expect(result).toBe(false);
    expect(cb).not.toHaveBeenCalled();
    input.remove();
  });
});

describe('normal mode — command sequences', () => {
  it('exact match dispatches action', () => {
    registry.add({ keys: 'KeyF', action: 'show_hints' });
    const result = handler.handleKeyDown(makeKey('f'));
    expect(result).toBe(true);
    expect(dispatchSpy).toHaveBeenCalledWith('show_hints', {});
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
    registry.add({ keys: 'KeyF', action: 'show_hints' });
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

  it('Ctrl+T (unbound) falls through even with other binds present', () => {
    registry.add({ keys: 'KeyJ', action: 'scroll_down' });
    const result = handler.handleKeyDown(makeKey('t', { ctrlKey: true }));
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

  it('a bound modifier combo fires even while hints are visible', () => {
    registry.add({ keys: 'ctrl+KeyK', action: 'do_thing' });
    handler.setHintsVisible(() => true);
    const result = handler.handleKeyDown(makeKey('k', { ctrlKey: true }));
    expect(result).toBe(true);
    expect(dispatchSpy).toHaveBeenCalledWith('do_thing', {});
  });

  it('a modifier combo yields to an editable field (does not hijack typing)', () => {
    registry.add({ keys: 'ctrl+KeyK', action: 'do_thing' });
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    const result = handler.handleKeyDown(makeKey('k', { ctrlKey: true }));
    expect(result).toBe(false);
    expect(dispatchSpy).not.toHaveBeenCalled();
    input.remove();
  });
});
