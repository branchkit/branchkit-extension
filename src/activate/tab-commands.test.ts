/**
 * BranchKit Browser — tab and zoom command binding tests.
 *
 * Seventeen bindings that had no test while they were two loops in content.ts.
 * What is pinned is the wire: which action each command name forwards, and the
 * index rule that only `goto_tab` exercises.
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type TabCommands = typeof import('./tab-commands');

type Handler = (params: Record<string, string>) => void;
const registered = new Map<string, Handler>();
const dispatcher = { register: (a: string, fn: Handler) => { registered.set(a, fn); } };

let sent: Array<Record<string, unknown>>;
let sendResult: () => Promise<unknown>;

async function load(): Promise<TabCommands> {
  vi.resetModules();
  vi.doMock('../core/singletons', () => ({ dispatcher }));
  const m = await import('./tab-commands');
  m.registerTabCommands();
  return m;
}

const run = (action: string, params: Record<string, string> = {}) => {
  const h = registered.get(action);
  if (!h) throw new Error(`${action} was never registered`);
  h(params);
};

beforeEach(() => {
  registered.clear();
  sent = [];
  sendResult = () => Promise.resolve();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { sendMessage: (m: Record<string, unknown>) => { sent.push(m); return sendResult(); } },
  };
});

afterEach(() => { vi.doUnmock('../core/singletons'); });

describe('registration', () => {
  it('registers all fourteen tab verbs and all three zoom verbs', async () => {
    await load();
    expect([...registered.keys()].sort()).toEqual([
      'close_tab', 'duplicate_tab', 'first_tab', 'goto_tab', 'last_active_tab',
      'last_tab', 'move_tab_left', 'move_tab_right', 'mute_tab', 'new_tab',
      'next_tab', 'pin_tab', 'previous_tab', 'restore_tab', 'zoom_in',
      'zoom_out', 'zoom_reset',
    ]);
  });

  it('registers nothing at import time', async () => {
    vi.resetModules();
    vi.doMock('../core/singletons', () => ({ dispatcher }));
    await import('./tab-commands');
    expect(registered.size).toBe(0);
  });
});

describe('the tab verbs', () => {
  it('maps every command name to its own action', async () => {
    await load();
    for (const c of ['next_tab', 'previous_tab', 'first_tab', 'last_tab', 'goto_tab',
      'last_active_tab', 'new_tab', 'close_tab', 'restore_tab', 'duplicate_tab',
      'pin_tab', 'mute_tab', 'move_tab_left', 'move_tab_right']) run(c);
    expect(sent.map((m) => m.action)).toEqual([
      'next', 'previous', 'first', 'last', 'goto', 'last_active', 'new', 'close',
      'restore', 'duplicate', 'pin', 'mute', 'move_left', 'move_right',
    ]);
    expect(sent.every((m) => m.type === 'TAB_ACTION')).toBe(true);
  });

  it('carries a numeric index when one is given', async () => {
    await load();
    run('goto_tab', { index: '3' });
    expect(sent).toEqual([{ type: 'TAB_ACTION', action: 'goto', index: 3 }]);
  });

  it('OMITS the index field entirely when it is absent or unparseable', async () => {
    await load();
    run('goto_tab');
    run('goto_tab', { index: '' });
    run('goto_tab', { index: 'seven' });
    for (const m of sent) {
      // Not `index: undefined`, not `index: NaN` — absent. NaN JSON-serialises
      // to null and reaches the SW as a real value it would have to defend
      // against; `'index' in m` is what tells those apart.
      expect('index' in m).toBe(false);
      expect(m).toEqual({ type: 'TAB_ACTION', action: 'goto' });
    }
  });

  it('keeps index 0 rather than treating it as absent', async () => {
    await load();
    run('goto_tab', { index: '0' });
    // A truthiness guard instead of Number.isFinite would drop this one.
    expect(sent).toEqual([{ type: 'TAB_ACTION', action: 'goto', index: 0 }]);
  });
});

describe('the zoom verbs', () => {
  it('maps each to its own action and never carries an index', async () => {
    await load();
    run('zoom_in', { index: '4' });
    run('zoom_out');
    run('zoom_reset');
    expect(sent).toEqual([
      { type: 'ZOOM_ACTION', action: 'in' },
      { type: 'ZOOM_ACTION', action: 'out' },
      { type: 'ZOOM_ACTION', action: 'reset' },
    ]);
  });
});

describe('a dead extension context', () => {
  it('swallows the rejected send rather than surfacing an unhandled rejection', async () => {
    await load();
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown) => { unhandled.push(r); };
    process.on('unhandledRejection', onUnhandled);
    try {
      sendResult = () => Promise.reject(new Error('Extension context invalidated'));
      run('next_tab');
      run('zoom_in');
      expect(sent).toHaveLength(2);
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
