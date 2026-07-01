/**
 * SSE backoff policy tests — the stable-connection reset rule from
 * notes/DESIGN_SSE_RESILIENCE.md (2).
 */

import { describe, it, expect } from 'vitest';
import { SSEBackoff } from './sse-backoff';

describe('SSEBackoff', () => {
  it('escalates 1s → 2s → 4s → … and caps', () => {
    const b = new SSEBackoff(30_000, 30_000);
    const delays = Array.from({ length: 7 }, () => b.nextDelayMs(0));
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  it('resets to 1s after a stable connection', () => {
    const b = new SSEBackoff(30_000, 30_000);
    b.nextDelayMs(0);            // 1s
    b.nextDelayMs(0);            // 2s — ladder is climbing
    b.onConnected(10_000);
    // Held 45s before the next drop — stable, ladder resets.
    expect(b.nextDelayMs(55_000)).toBe(1000);
  });

  it('keeps escalating across crash-loop cycles (the 1s-hammer bug)', () => {
    const b = new SSEBackoff(30_000, 30_000);
    // Host connects then drops after ~5s, repeatedly. Pre-fix, each connect
    // edge reset the ladder and discovery ran every ~1s forever.
    let now = 0;
    const delays: number[] = [];
    for (let cycle = 0; cycle < 6; cycle++) {
      b.onConnected(now);
      now += 5_000;              // drops well inside the stability window
      delays.push(b.nextDelayMs(now));
      now += delays[delays.length - 1];
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
  });

  it('a stable stretch inside a flap sequence re-arms the fast ladder', () => {
    const b = new SSEBackoff(30_000, 30_000);
    b.nextDelayMs(0);
    b.nextDelayMs(0);
    b.nextDelayMs(0);            // ladder at 8s next
    b.onConnected(100_000);
    expect(b.nextDelayMs(105_000)).toBe(8000);  // 5s hold: not stable
    b.onConnected(200_000);
    expect(b.nextDelayMs(240_000)).toBe(1000);  // 40s hold: stable, reset
  });

  it('multiple retries between connects never see the stale connect stamp', () => {
    const b = new SSEBackoff(30_000, 30_000);
    b.onConnected(0);
    expect(b.nextDelayMs(60_000)).toBe(1000);   // stable → reset
    // Same drop, further retries: the old connectedAt must not re-reset.
    expect(b.nextDelayMs(120_000)).toBe(2000);
    expect(b.nextDelayMs(180_000)).toBe(4000);
  });
});
