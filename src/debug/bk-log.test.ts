/**
 * BranchKit Browser — bkLog correlation-context unit tests.
 *
 * Pins piece C of notes/DESIGN_EXTENSION_LOG_RETRIEVAL.md: a dispatch-scoped
 * tr_ set via setLogCorrelation rides into every bkLog payload emitted in the
 * same synchronous body, an explicit correlationId in the data wins, and the
 * context self-clears at the next microtask boundary.
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type BkLog = typeof import('./bk-log');

const sendMessage = vi.fn().mockResolvedValue(undefined);

async function loadBkLog(): Promise<BkLog> {
  vi.resetModules();
  return await import('./bk-log');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const sentData = (n: number) => sendMessage.mock.calls[n][0].data;

describe('bkLog correlation context', () => {
  it('attaches the scoped tr_ to object payloads and fills empty ones', async () => {
    const { bkLog, setLogCorrelation } = await loadBkLog();

    setLogCorrelation('tr_abc123');
    bkLog('BK_TEST', { n: 1 });
    bkLog('BK_TEST_EMPTY');

    expect(sentData(0)).toEqual({ n: 1, correlationId: 'tr_abc123' });
    expect(sentData(1)).toEqual({ correlationId: 'tr_abc123' });
  });

  it('lets an explicit correlationId in the payload win', async () => {
    const { bkLog, setLogCorrelation } = await loadBkLog();

    setLogCorrelation('tr_scoped');
    bkLog('BK_TEST', { correlationId: 'tr_explicit' });

    expect(sentData(0)).toEqual({ correlationId: 'tr_explicit' });
  });

  it('leaves non-object payloads untouched', async () => {
    const { bkLog, setLogCorrelation } = await loadBkLog();

    setLogCorrelation('tr_abc123');
    bkLog('BK_TEST', 'a string');
    bkLog('BK_TEST', [1, 2]);

    expect(sentData(0)).toBe('a string');
    expect(sentData(1)).toEqual([1, 2]);
  });

  it('self-clears at the next microtask boundary', async () => {
    const { bkLog, setLogCorrelation } = await loadBkLog();

    setLogCorrelation('tr_abc123');
    bkLog('BK_SYNC', { n: 1 });
    await Promise.resolve(); // cross the microtask boundary
    bkLog('BK_LATER', { n: 2 });

    expect(sentData(0)).toEqual({ n: 1, correlationId: 'tr_abc123' });
    expect(sentData(1)).toEqual({ n: 2 });
  });

  it('emits without a correlation when none was set', async () => {
    const { bkLog } = await loadBkLog();

    bkLog('BK_TEST', { n: 1 });

    expect(sentData(0)).toEqual({ n: 1 });
  });
});
