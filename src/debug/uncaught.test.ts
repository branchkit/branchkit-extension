/**
 * BranchKit Browser — uncaught-error capture unit tests.
 *
 * Pins the piece-D contract from notes/DESIGN_EXTENSION_LOG_RETRIEVAL.md:
 * extension-origin filtering on CS error events (page-script errors stay
 * out), unhandledrejection capture with no filter, the visible per-boot
 * cap, and stack trimming.
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installUncaughtCapture, reportCaught, _resetUncaughtForTests } from './uncaught';

const EXT_BASE = 'chrome-extension://abcdefgh/';

const emit = vi.fn();
let uninstall: (() => void) | null = null;

function install(source: 'sw' | 'cs' = 'cs'): void {
  uninstall = installUncaughtCapture(emit, source);
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetUncaughtForTests();
  vi.stubGlobal('chrome', { runtime: { getURL: () => EXT_BASE } });
});

afterEach(() => {
  uninstall?.();
  uninstall = null;
  vi.unstubAllGlobals();
});

function fireError(filename: string, message = 'boom'): void {
  window.dispatchEvent(
    new ErrorEvent('error', { filename, message, error: new Error(message) }),
  );
}

function fireRejection(reason: unknown): void {
  // happy-dom lacks a PromiseRejectionEvent constructor; a plain Event
  // with a `reason` bolted on exercises the same listener path.
  const ev = new Event('unhandledrejection');
  (ev as unknown as { reason: unknown }).reason = reason;
  window.dispatchEvent(ev);
}

describe('installUncaughtCapture (cs)', () => {
  it('captures extension-origin errors and drops page-script errors', () => {
    install('cs');

    fireError('https://example.com/app.js', 'their bug');
    fireError(`${EXT_BASE}content.js`, 'our bug');

    expect(emit).toHaveBeenCalledTimes(1);
    const [tag, data, level] = emit.mock.calls[0];
    expect(tag).toBe('BK_UNCAUGHT');
    expect(level).toBe('error');
    expect(data.kind).toBe('error');
    expect(data.source).toBe('cs');
    expect(data.message).toBe('our bug');
    expect(data.filename).toBe(`${EXT_BASE}content.js`);
  });

  it('captures unhandled rejections without a filename filter', () => {
    install('cs');

    fireRejection(new Error('async boom'));
    fireRejection('string reason');

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[0][1].kind).toBe('unhandledrejection');
    expect(emit.mock.calls[0][1].message).toBe('async boom');
    expect(emit.mock.calls[1][1].message).toBe('string reason');
  });

  it('trims stacks to the message line plus three frames', () => {
    install('cs');

    const err = new Error('deep');
    err.stack = ['Error: deep', 'at a', 'at b', 'at c', 'at d', 'at e'].join('\n');
    fireRejection(err);

    expect(emit.mock.calls[0][1].stack).toEqual(['Error: deep', 'at a', 'at b', 'at c']);
  });

  it('caps per boot with a visible final line, then stays silent', () => {
    install('cs');

    for (let i = 0; i < 25; i++) fireRejection(new Error(`r${i}`));

    expect(emit).toHaveBeenCalledTimes(20);
    const last = emit.mock.calls[19][1];
    expect(last.capped).toBe(true);
    expect(last.cap).toBe(20);
  });

  it('installs nothing when the runtime is already gone', () => {
    vi.stubGlobal('chrome', {
      runtime: {
        getURL: () => {
          throw new Error('Extension context invalidated');
        },
      },
    });
    install('cs');
    fireRejection(new Error('boom'));
    expect(emit).not.toHaveBeenCalled();
  });
});

// --- reportCaught: the channel the message router lost ---------------------
//
// Routing content.ts's onMessage chain through a table put a try/catch around
// handlers that previously had none, so a throw stopped surfacing as an
// uncaught error and became a console.warn — invisible to `dev plog`, since
// console.* is kept out of browser.log by design.
describe('reportCaught', () => {
  it('emits a BK_UNCAUGHT line through the installed emitter', () => {
    install('cs');
    reportCaught("message handler 'BRANCHKIT_ACTION'", new Error('boom'), { phase: 'sync' });

    expect(emit).toHaveBeenCalledTimes(1);
    const [tag, data, level] = emit.mock.calls[0];
    expect(tag).toBe('BK_UNCAUGHT');
    expect(level).toBe('error');
    expect(data).toMatchObject({
      source: 'cs',
      kind: 'caught',
      where: "message handler 'BRANCHKIT_ACTION'",
      message: 'boom',
      phase: 'sync',
    });
    expect((data as { stack: string[] }).stack.length).toBeGreaterThan(0);
  });

  it('stamps the source it was installed with, so an SW throw is greppable apart', () => {
    install('sw');
    reportCaught('message handler X', new Error('boom'));
    expect(emit.mock.calls[0][1]).toMatchObject({ source: 'sw' });
  });

  it('is a no-op before install — nothing to send to yet', () => {
    reportCaught('too early', new Error('boom'));
    expect(emit).not.toHaveBeenCalled();
  });

  it('handles a non-Error throw without inventing a stack', () => {
    install('cs');
    reportCaught('handler', 'a bare string');
    expect(emit.mock.calls[0][1]).toMatchObject({ message: 'a bare string', stack: [] });
  });

  it('shares the per-boot cap with the listeners rather than opening a second path', () => {
    install('cs');
    // 19 caught reports, then the 20th is the capped marker.
    for (let i = 0; i < 25; i++) reportCaught('handler', new Error(`e${i}`));
    expect(emit).toHaveBeenCalledTimes(20);
    expect(emit.mock.calls[19][1]).toMatchObject({ capped: true });

    // And a real uncaught error after the cap is silent too — one budget, not two.
    emit.mockClear();
    window.dispatchEvent(new ErrorEvent('error', {
      message: 'later', filename: `${EXT_BASE}content.js`,
    }));
    expect(emit).not.toHaveBeenCalled();
  });
});
