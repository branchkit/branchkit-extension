/**
 * BranchKit Browser — PLUGIN_DEBUG_LOG coalescer unit tests.
 *
 * Pins the piece-A contract from notes/DESIGN_EXTENSION_LOG_RETRIEVAL.md:
 * first boot line per window forwards verbatim, excess accumulates into one
 * BK_CS_BOOT_COALESCED summary (count + top distinct URLs), summaries flush
 * on window close AND before any other tag's line (order truthfulness), and
 * non-coalesced tags pass through untouched.
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type LogCoalesce = typeof import('./log-coalesce');

const forwardPluginDebugLog = vi.fn().mockResolvedValue(undefined);

async function loadCoalescer(): Promise<LogCoalesce> {
  vi.resetModules();
  vi.doMock('../plugin/plugin-api', () => ({ forwardPluginDebugLog }));
  return await import('./log-coalesce');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const boot = (url: string) => ({ session: 's', url });

describe('forwardCoalesced', () => {
  it('forwards the first boot line verbatim and coalesces the rest of the burst', async () => {
    const { forwardCoalesced } = await loadCoalescer();

    forwardCoalesced('BK_CS_BOOT', boot('https://a.com/'), 'info');
    forwardCoalesced('BK_CS_BOOT', boot('https://a.com/'), 'info');
    forwardCoalesced('BK_CS_BOOT', boot('https://b.com/'), 'info');

    expect(forwardPluginDebugLog).toHaveBeenCalledTimes(1);
    expect(forwardPluginDebugLog).toHaveBeenCalledWith('BK_CS_BOOT', boot('https://a.com/'), 'info');

    vi.advanceTimersByTime(1000);

    expect(forwardPluginDebugLog).toHaveBeenCalledTimes(2);
    expect(forwardPluginDebugLog).toHaveBeenLastCalledWith(
      'BK_CS_BOOT_COALESCED',
      { count: 2, window_ms: 1000, urls: ['https://a.com/', 'https://b.com/'] },
      'info',
    );
  });

  it('marks repeated URLs with a count and keeps only the top three', async () => {
    const { forwardCoalesced } = await loadCoalescer();

    forwardCoalesced('BK_CS_BOOT', boot('first'), 'info'); // verbatim, opens window
    for (let i = 0; i < 5; i++) forwardCoalesced('BK_CS_BOOT', boot('https://busy.com/'), 'info');
    forwardCoalesced('BK_CS_BOOT', boot('https://twice.com/'), 'info');
    forwardCoalesced('BK_CS_BOOT', boot('https://twice.com/'), 'info');
    forwardCoalesced('BK_CS_BOOT', boot('https://once.com/'), 'info');
    forwardCoalesced('BK_CS_BOOT', boot('https://also-once.com/'), 'info');

    vi.advanceTimersByTime(1000);

    const calls = forwardPluginDebugLog.mock.calls;
    const summary = calls[calls.length - 1];
    expect(summary[0]).toBe('BK_CS_BOOT_COALESCED');
    expect(summary[1].count).toBe(9);
    expect(summary[1].urls).toHaveLength(3);
    expect(summary[1].urls[0]).toBe('https://busy.com/ (×5)');
    expect(summary[1].urls[1]).toBe('https://twice.com/ (×2)');
  });

  it('emits no summary when a window held nothing', async () => {
    const { forwardCoalesced } = await loadCoalescer();

    forwardCoalesced('BK_CS_BOOT', boot('https://a.com/'), 'info');
    vi.advanceTimersByTime(1000);

    expect(forwardPluginDebugLog).toHaveBeenCalledTimes(1);
  });

  it('starts a fresh verbatim line + window after the previous window closes', async () => {
    const { forwardCoalesced } = await loadCoalescer();

    forwardCoalesced('BK_CS_BOOT', boot('https://a.com/'), 'info');
    vi.advanceTimersByTime(1000);
    forwardCoalesced('BK_CS_BOOT', boot('https://b.com/'), 'info');

    expect(forwardPluginDebugLog).toHaveBeenCalledTimes(2);
    expect(forwardPluginDebugLog).toHaveBeenLastCalledWith('BK_CS_BOOT', boot('https://b.com/'), 'info');
  });

  it('flushes a pending summary before an expired window forwards its next verbatim line', async () => {
    const { forwardCoalesced } = await loadCoalescer();

    forwardCoalesced('BK_CS_BOOT', boot('https://a.com/'), 'info');
    forwardCoalesced('BK_CS_BOOT', boot('https://a.com/'), 'info');
    // Cross the window boundary without letting the timer run (the SW may
    // have been busy) — the next line must settle the old window first.
    vi.setSystemTime(Date.now() + 1500);
    forwardCoalesced('BK_CS_BOOT', boot('https://c.com/'), 'info');

    const tags = forwardPluginDebugLog.mock.calls.map((c) => c[0]);
    expect(tags).toEqual(['BK_CS_BOOT', 'BK_CS_BOOT_COALESCED', 'BK_CS_BOOT']);
  });

  it('flushes pending summaries before a non-coalesced tag, preserving log order', async () => {
    const { forwardCoalesced } = await loadCoalescer();

    forwardCoalesced('BK_CS_BOOT', boot('https://a.com/'), 'info');
    forwardCoalesced('BK_CS_BOOT', boot('https://a.com/'), 'info');
    forwardCoalesced('BK_GRAMMAR_REPUBLISH', { n: 1 }, 'info');

    const tags = forwardPluginDebugLog.mock.calls.map((c) => c[0]);
    expect(tags).toEqual(['BK_CS_BOOT', 'BK_CS_BOOT_COALESCED', 'BK_GRAMMAR_REPUBLISH']);
  });

  it('passes non-coalesced tags through with level and data untouched', async () => {
    const { forwardCoalesced } = await loadCoalescer();

    forwardCoalesced('BK_STALE_PAINT', { wrapper: 3 }, 'warn');

    expect(forwardPluginDebugLog).toHaveBeenCalledTimes(1);
    expect(forwardPluginDebugLog).toHaveBeenCalledWith('BK_STALE_PAINT', { wrapper: 3 }, 'warn');
  });

  it('counts lines without a url under a placeholder', async () => {
    const { forwardCoalesced } = await loadCoalescer();

    forwardCoalesced('BK_CS_BOOT', boot('https://a.com/'), 'info');
    forwardCoalesced('BK_CS_BOOT', { session: 'x' }, 'info');
    vi.advanceTimersByTime(1000);

    const calls = forwardPluginDebugLog.mock.calls;
    expect(calls[calls.length - 1][1].urls).toEqual(['(no url)']);
  });
});
