import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { firehoseStep, _resetFirehoseForTests } from './firehose';

let sent: Array<{ step: string; size: number }>;

beforeEach(() => {
  sent = [];
  vi.useFakeTimers();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      sendMessage: vi.fn((msg: { data: { step: string; size: number } }) => {
        sent.push({ step: msg.data.step, size: msg.data.size });
        return Promise.resolve();
      }),
    },
  };
  _resetFirehoseForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('firehoseStep rate limiter', () => {
  it('passes steps under the per-second cap and respects size thresholds', () => {
    firehoseStep('a', 5);
    firehoseStep('b', 5, 10); // below threshold — not sent, not counted
    firehoseStep('c', 15, 10);
    expect(sent.map(s => s.step)).toEqual(['a', 'c']);
  });

  it('drops over-cap steps and emits ONE counted summary when the window reopens', () => {
    for (let i = 0; i < 40; i++) firehoseStep('burst', 1);
    expect(sent).toHaveLength(25); // cap
    // Reopen the window and send one more — the summary rides in first.
    vi.advanceTimersByTime(1100);
    firehoseStep('after', 1);
    const summary = sent.find(s => s.step === 'firehose:dropped');
    expect(summary?.size).toBe(15);
    expect(sent[sent.length - 1].step).toBe('after');
  });
});
