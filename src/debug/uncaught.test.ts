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
import { installUncaughtCapture, _resetUncaughtForTests } from './uncaught';

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
