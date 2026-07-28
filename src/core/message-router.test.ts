/**
 * BranchKit Browser — message-router unit tests.
 *
 * Pins the response contract every extracted handler now rides on: which return
 * shape keeps Chrome's channel open, that a sync answer never claims to be
 * async, that a rejection closes the channel instead of hanging the sender, and
 * that two modules can't quietly claim the same message type.
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  registerMessageHandlers,
  resetMessageHandlers,
  registeredMessageTypes,
  routeMessage,
  setMessageGuard,
  type MessageSender,
} from './message-router';
import { installUncaughtCapture, _resetUncaughtForTests } from '../debug/uncaught';

const sender = { tab: { id: 7 }, frameId: 0 } as unknown as MessageSender;

beforeEach(() => {
  resetMessageHandlers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('response discipline', () => {
  it('undefined means fire-and-forget: no response, channel closes', () => {
    const seen: unknown[] = [];
    registerMessageHandlers({ PING: (m) => { seen.push(m); } });
    const respond = vi.fn();

    expect(routeMessage({ type: 'PING', n: 1 }, sender, respond)).toBe(false);
    expect(respond).not.toHaveBeenCalled();
    expect(seen).toEqual([{ type: 'PING', n: 1 }]);
  });

  it('a value responds synchronously and still closes the channel', () => {
    registerMessageHandlers({ GET: () => ({ ok: true }) });
    const respond = vi.fn();

    // false is correct here: the response already went out. Returning true
    // would leave Chrome holding a channel nobody will ever write to.
    expect(routeMessage({ type: 'GET' }, sender, respond)).toBe(false);
    expect(respond).toHaveBeenCalledWith({ ok: true });
  });

  it('a promise keeps the channel open and responds when it settles', async () => {
    let release!: (v: unknown) => void;
    registerMessageHandlers({ SLOW: () => new Promise((r) => { release = r; }) });
    const respond = vi.fn();

    expect(routeMessage({ type: 'SLOW' }, sender, respond)).toBe(true);
    expect(respond).not.toHaveBeenCalled();

    release({ letters: 'ab' });
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith({ letters: 'ab' }));
  });

  it('falsy sync values still count as a response (0, null, empty string)', () => {
    registerMessageHandlers({
      ZERO: () => 0,
      NULL: () => null,
      EMPTY: () => '',
    });

    for (const [type, expected] of [['ZERO', 0], ['NULL', null], ['EMPTY', '']] as const) {
      const respond = vi.fn();
      expect(routeMessage({ type }, sender, respond)).toBe(false);
      expect(respond).toHaveBeenCalledWith(expected);
    }
  });

  it('passes the sender through — most handlers key off sender.tab.id', () => {
    const seen: MessageSender[] = [];
    registerMessageHandlers({ WHO: (_m, s) => { seen.push(s); } });

    routeMessage({ type: 'WHO' }, sender, vi.fn());
    expect(seen[0]).toBe(sender);
  });
});

describe('failure modes close the channel rather than hang the sender', () => {
  it('a synchronous throw does not keep the channel open', () => {
    registerMessageHandlers({ BOOM: () => { throw new Error('nope'); } });
    const respond = vi.fn();

    expect(routeMessage({ type: 'BOOM' }, sender, respond)).toBe(false);
    expect(respond).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it('a rejected promise responds undefined instead of leaving the sender awaiting', async () => {
    registerMessageHandlers({ FAIL: () => Promise.reject(new Error('transport')) });
    const respond = vi.fn();

    expect(routeMessage({ type: 'FAIL' }, sender, respond)).toBe(true);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith(undefined));
    expect(console.warn).toHaveBeenCalled();
  });

  it('a handler that throws does not prevent later messages routing', () => {
    registerMessageHandlers({
      BOOM: () => { throw new Error('nope'); },
      FINE: () => ({ ok: true }),
    });

    routeMessage({ type: 'BOOM' }, sender, vi.fn());
    const respond = vi.fn();
    routeMessage({ type: 'FINE' }, sender, respond);
    expect(respond).toHaveBeenCalledWith({ ok: true });
  });
});

describe('unmatched traffic', () => {
  it('an unregistered type is ignored, matching the old chain fall-through', () => {
    registerMessageHandlers({ KNOWN: () => ({ ok: true }) });
    const respond = vi.fn();

    expect(routeMessage({ type: 'SOMEONE_ELSES' }, sender, respond)).toBe(false);
    expect(respond).not.toHaveBeenCalled();
  });

  it('a message with no string type is ignored and never throws', () => {
    registerMessageHandlers({ KNOWN: () => ({ ok: true }) });

    for (const message of [undefined, null, 'string', 42, {}, { type: 9 }, { type: null }]) {
      const respond = vi.fn();
      expect(routeMessage(message, sender, respond)).toBe(false);
      expect(respond).not.toHaveBeenCalled();
    }
  });
});

describe('the context guard', () => {
  it('stops every handler while it refuses, and lets them run again when it does not', () => {
    let alive = false;
    const seen: string[] = [];
    registerMessageHandlers({ ACT: () => { seen.push('act'); return { ok: true }; } });
    setMessageGuard(() => alive);

    const blocked = vi.fn();
    expect(routeMessage({ type: 'ACT' }, sender, blocked)).toBe(false);
    expect(seen).toEqual([]);
    expect(blocked).not.toHaveBeenCalled();

    // The positive counterpart: without it, an inert handler reads the same.
    alive = true;
    const allowed = vi.fn();
    expect(routeMessage({ type: 'ACT' }, sender, allowed)).toBe(false);
    expect(seen).toEqual(['act']);
    expect(allowed).toHaveBeenCalledWith({ ok: true });
  });

  it('runs on unregistered types too, so a refusing context can count what it ignored', () => {
    // The content script's orphan gauge counts every message a torn-down
    // context saw, not just the ones it had a handler for.
    const asked: string[] = [];
    setMessageGuard(() => { asked.push('checked'); return false; });
    registerMessageHandlers({ KNOWN: () => 1 });

    routeMessage({ type: 'SOMEONE_ELSES' }, sender, vi.fn());
    routeMessage({ type: 'KNOWN' }, sender, vi.fn());
    expect(asked).toEqual(['checked', 'checked']);
  });

  it('routes normally with no guard installed — the service worker never sets one', () => {
    registerMessageHandlers({ ACT: () => ({ ok: true }) });
    const respond = vi.fn();
    routeMessage({ type: 'ACT' }, sender, respond);
    expect(respond).toHaveBeenCalledWith({ ok: true });
  });

  it('a promise handler behind a refusing guard never keeps the channel open', () => {
    registerMessageHandlers({ SLOW: () => new Promise(() => {}) });
    setMessageGuard(() => false);
    // Returning true here would leave the sender awaiting a dead context
    // forever — the exact hang the router exists to make unexpressible.
    expect(routeMessage({ type: 'SLOW' }, sender, vi.fn())).toBe(false);
  });
});

describe('registration', () => {
  it('rejects two different handlers claiming one type', () => {
    registerMessageHandlers({ DUP: () => 1 });
    expect(() => registerMessageHandlers({ DUP: () => 2 })).toThrow(/duplicate message handler for 'DUP'/);
  });

  it('re-registering the identical handler is a no-op, so composing twice is safe', () => {
    const handler = () => 1;
    registerMessageHandlers({ SAME: handler });
    expect(() => registerMessageHandlers({ SAME: handler })).not.toThrow();
    expect(registeredMessageTypes()).toEqual(['SAME']);
  });

  it('reports its registered types sorted', () => {
    registerMessageHandlers({ B: () => 1, A: () => 1 });
    registerMessageHandlers({ C: () => 1 });
    expect(registeredMessageTypes()).toEqual(['A', 'B', 'C']);
  });
});

// --- The BK_UNCAUGHT channel the catch would otherwise close ---------------
//
// Before content.ts's chain became this table, a synchronous throw in a handler
// escaped the listener and installUncaughtCapture turned it into a BK_UNCAUGHT
// line in browser.log carrying the dispatch's tr_. The catch below is right —
// it closes the channel instead of hanging the sender — but console.* is kept
// out of browser.log by design, so without this the extension's largest
// handler could fail with no telemetry at all.
describe('errors still reach browser.log', () => {
  it('reports a synchronous throw as BK_UNCAUGHT, naming the message type', () => {
    const emit = vi.fn();
    _resetUncaughtForTests();
    vi.stubGlobal('chrome', { runtime: { getURL: () => 'chrome-extension://abc/' } });
    const uninstall = installUncaughtCapture(emit, 'cs');
    try {
      registerMessageHandlers({ BRANCHKIT_ACTION: () => { throw new Error('boom'); } });
      routeMessage({ type: 'BRANCHKIT_ACTION' }, sender, vi.fn());

      expect(emit).toHaveBeenCalledTimes(1);
      const [tag, data] = emit.mock.calls[0];
      expect(tag).toBe('BK_UNCAUGHT');
      expect(data).toMatchObject({
        kind: 'caught',
        where: "message handler 'BRANCHKIT_ACTION'",
        message: 'boom',
        phase: 'sync',
      });
    } finally {
      uninstall();
      vi.unstubAllGlobals();
      _resetUncaughtForTests();
    }
  });

  it('reports a rejected promise too, tagged async', async () => {
    const emit = vi.fn();
    _resetUncaughtForTests();
    vi.stubGlobal('chrome', { runtime: { getURL: () => 'chrome-extension://abc/' } });
    const uninstall = installUncaughtCapture(emit, 'cs');
    try {
      registerMessageHandlers({ SLOW: () => Promise.reject(new Error('transport')) });
      const respond = vi.fn();
      expect(routeMessage({ type: 'SLOW' }, sender, respond)).toBe(true);
      await vi.waitFor(() => expect(respond).toHaveBeenCalledWith(undefined));

      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit.mock.calls[0][1]).toMatchObject({ phase: 'async', message: 'transport' });
    } finally {
      uninstall();
      vi.unstubAllGlobals();
      _resetUncaughtForTests();
    }
  });

  it('a handler that returns normally reports nothing', () => {
    const emit = vi.fn();
    _resetUncaughtForTests();
    vi.stubGlobal('chrome', { runtime: { getURL: () => 'chrome-extension://abc/' } });
    const uninstall = installUncaughtCapture(emit, 'cs');
    try {
      registerMessageHandlers({ FINE: () => ({ ok: true }) });
      routeMessage({ type: 'FINE' }, sender, vi.fn());
      expect(emit).not.toHaveBeenCalled();
    } finally {
      uninstall();
      vi.unstubAllGlobals();
      _resetUncaughtForTests();
    }
  });
});
