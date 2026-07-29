/**
 * BranchKit Browser — keyboard-mode command binding tests.
 *
 * Two bindings that were inline in content.ts and untested. Small, but the
 * pair is easy to swap and the symptom of swapping them is subtle: insert
 * mode holds the keyboard until Escape, pass-next-key releases it after
 * exactly one key.
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type KeyboardCommands = typeof import('./keyboard-commands');

type Handler = (params: Record<string, string>) => void;
const registered = new Map<string, Handler>();
const dispatcher = { register: (a: string, fn: Handler) => { registered.set(a, fn); } };
const keyHandler = {
  enterInsertMode: vi.fn(), armPassNextKey: vi.fn(),
  armHintAction: vi.fn((_a: string) => {}), enterHintMode: vi.fn(),
};

async function load(): Promise<KeyboardCommands> {
  vi.resetModules();
  vi.doMock('../core/singletons', () => ({ dispatcher, keyHandler }));
  const m = await import('./keyboard-commands');
  m.registerKeyboardCommands();
  return m;
}

beforeEach(() => { registered.clear(); vi.clearAllMocks(); });
afterEach(() => { vi.doUnmock('../core/singletons'); });

describe('registerKeyboardCommands', () => {
  it('registers every keyboard-mode command', async () => {
    await load();
    expect([...registered.keys()].sort()).toEqual([
      'caret_hint', 'copytext_hint', 'focus_hint', 'hover_hint', 'insert_mode',
      'pass_next_key', 'yank_hint',
    ]);
  });

  it('registers nothing at import time', async () => {
    vi.resetModules();
    vi.doMock('../core/singletons', () => ({ dispatcher, keyHandler }));
    await import('./keyboard-commands');
    expect(registered.size).toBe(0);
  });

  it('insert_mode enters insert mode and does not arm the one-shot', async () => {
    await load();
    registered.get('insert_mode')!({});
    expect(keyHandler.enterInsertMode).toHaveBeenCalledTimes(1);
    // Arming here would release the keyboard after one key instead of holding
    // it until Escape — the two are easy to cross-wire and hard to tell apart
    // from a single call.
    expect(keyHandler.armPassNextKey).not.toHaveBeenCalled();
  });

  it('pass_next_key arms the one-shot and does not enter insert mode', async () => {
    await load();
    registered.get('pass_next_key')!({});
    expect(keyHandler.armPassNextKey).toHaveBeenCalledTimes(1);
    expect(keyHandler.enterInsertMode).not.toHaveBeenCalled();
  });
});

describe('the hint-action arms', () => {
  it('each command arms its OWN action and enters hint mode', async () => {
    await load();
    for (const [command, action] of [
      ['yank_hint', 'yank'], ['focus_hint', 'focus'], ['copytext_hint', 'copytext'],
      ['hover_hint', 'hover'], ['caret_hint', 'caret'],
    ] as const) {
      keyHandler.armHintAction.mockClear();
      keyHandler.enterHintMode.mockClear();
      registered.get(command)!({});
      expect(keyHandler.armHintAction, command).toHaveBeenCalledWith(action);
      expect(keyHandler.enterHintMode, command).toHaveBeenCalledTimes(1);
    }
  });

  it('arms BEFORE entering — the mode must not open unarmed', async () => {
    await load();
    const order: string[] = [];
    keyHandler.armHintAction.mockImplementation(() => { order.push('arm'); });
    keyHandler.enterHintMode.mockImplementation(() => { order.push('enter'); });
    try {
      registered.get('yank_hint')!({});
      // Entering first leaves a window where a fast codeword resolves against
      // an unarmed mode and follows the link instead of yanking it.
      expect(order).toEqual(['arm', 'enter']);
    } finally {
      keyHandler.armHintAction.mockImplementation(() => {});
      keyHandler.enterHintMode.mockImplementation(() => {});
    }
  });

  it('the shared helper does not leak one command\'s action into the next', async () => {
    await load();
    registered.get('yank_hint')!({});
    registered.get('caret_hint')!({});
    // A helper that captured `action` once at module scope would arm 'yank'
    // both times — the closure-per-command is the whole point of armHint.
    expect(keyHandler.armHintAction.mock.calls.map((c) => c[0])).toEqual(['yank', 'caret']);
  });

  it('the pass-through commands do NOT enter hint mode', async () => {
    await load();
    registered.get('insert_mode')!({});
    registered.get('pass_next_key')!({});
    expect(keyHandler.enterHintMode).not.toHaveBeenCalled();
    expect(keyHandler.armHintAction).not.toHaveBeenCalled();
  });
});
