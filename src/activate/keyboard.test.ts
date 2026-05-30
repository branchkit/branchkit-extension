import { describe, it, expect, beforeEach, vi } from 'vitest';
import { KeyHandler } from './keyboard';
import { ActionDispatcher, CommandRegistry } from '../dispatcher';

function makeKey(key: string, extra: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key,
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

describe('normal mode — command sequences', () => {
  it('exact match dispatches action', () => {
    registry.add({ keys: 'f', action: 'show_hints' });
    const result = handler.handleKeyDown(makeKey('f'));
    expect(result).toBe(true);
    expect(dispatchSpy).toHaveBeenCalledWith('show_hints', {});
  });

  it('partial match waits for more keys', () => {
    registry.add({ keys: 'gg', action: 'scroll_top' });
    const result = handler.handleKeyDown(makeKey('g'));
    expect(result).toBe(true);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('multi-key sequence dispatches on completion', () => {
    registry.add({ keys: 'gg', action: 'scroll_top' });
    handler.handleKeyDown(makeKey('g'));
    handler.handleKeyDown(makeKey('g'));
    expect(dispatchSpy).toHaveBeenCalledWith('scroll_top', {});
  });

  it('no match resets sequence', () => {
    registry.add({ keys: 'f', action: 'show_hints' });
    const result = handler.handleKeyDown(makeKey('x'));
    expect(result).toBe(false);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('modifier combos pass through', () => {
    registry.add({ keys: 'c', action: 'some_action' });
    const result = handler.handleKeyDown(makeKey('c', { metaKey: true }));
    expect(result).toBe(false);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });
});
