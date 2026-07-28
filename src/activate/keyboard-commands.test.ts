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
const keyHandler = { enterInsertMode: vi.fn(), armPassNextKey: vi.fn() };

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
  it('registers both keyboard-mode commands', async () => {
    await load();
    expect([...registered.keys()].sort()).toEqual(['insert_mode', 'pass_next_key']);
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
