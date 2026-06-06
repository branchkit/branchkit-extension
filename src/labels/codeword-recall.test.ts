/**
 * BranchKit Browser — codeword-recall (read path) unit tests.
 *
 * Mocks the RECALL_CODEWORDS round-trip and exercises the confidence ladder:
 * single fingerprint match → its codeword, multiple → nearest-by-rect within
 * threshold, none/ambiguous → null, and the not-loaded guard.
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { Fingerprint } from '../scan/registry';
import { REBIND_DISTANCE_THRESHOLD_PX } from './rebind';
import type { CodewordMemoryEntry, Rect } from './codeword-memory';
import {
  loadRecall,
  isRecallLoaded,
  resolvePreferredCodeword,
  _resetForTests,
} from './codeword-recall';

function mockRecall(entries: CodewordMemoryEntry[] | (() => never)): void {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      async sendMessage() {
        if (typeof entries === 'function') entries();
        return { entries };
      },
    },
  };
}

function fp(over: Partial<Fingerprint> = {}): Fingerprint {
  return { role: 'link', name: '', tag: 'a', text: 'Home', href: '/home', ...over };
}

function rect(x: number, y: number): Rect {
  return { x, y, w: 20, h: 20 };
}

describe('codeword-recall', () => {
  beforeEach(() => _resetForTests());

  it('returns null and is not loaded before loadRecall', () => {
    expect(isRecallLoaded()).toBe(false);
    expect(resolvePreferredCodeword(fp(), null)).toBeNull();
  });

  it('resolves a unique fingerprint match to its codeword', async () => {
    mockRecall([{ fp: fp({ text: 'Issues' }), codeword: 'gust harp', rect: null }]);
    await loadRecall();
    expect(isRecallLoaded()).toBe(true);
    expect(resolvePreferredCodeword(fp({ text: 'Issues' }), null)).toBe('gust harp');
  });

  it('returns null when no fingerprint matches', async () => {
    mockRecall([{ fp: fp({ text: 'Issues' }), codeword: 'gust harp', rect: null }]);
    await loadRecall();
    expect(resolvePreferredCodeword(fp({ text: 'Pull requests' }), null)).toBeNull();
  });

  it('disambiguates multiple matches by nearest rect within threshold', async () => {
    const shared = fp({ text: 'Edit', href: '/edit' });
    mockRecall([
      { fp: shared, codeword: 'air ink', rect: rect(0, 0) },
      { fp: shared, codeword: 'bat cap', rect: rect(0, 500) },
    ]);
    await loadRecall();
    // Query near the second entry.
    const near = rect(5, 490); // within 50px of (0,500)
    expect(resolvePreferredCodeword(shared, near)).toBe('bat cap');
  });

  it('refuses an ambiguous match beyond the position threshold', async () => {
    const shared = fp({ text: 'Edit', href: '/edit' });
    mockRecall([
      { fp: shared, codeword: 'air ink', rect: rect(0, 0) },
      { fp: shared, codeword: 'bat cap', rect: rect(0, 500) },
    ]);
    await loadRecall();
    const farFromBoth = rect(0, 250); // >threshold from both
    expect(resolvePreferredCodeword(shared, farFromBoth)).toBeNull();
    expect(REBIND_DISTANCE_THRESHOLD_PX).toBeLessThan(250);
  });

  it('refuses an ambiguous match when the query has no rect', async () => {
    const shared = fp({ text: 'Edit', href: '/edit' });
    mockRecall([
      { fp: shared, codeword: 'air ink', rect: rect(0, 0) },
      { fp: shared, codeword: 'bat cap', rect: rect(0, 500) },
    ]);
    await loadRecall();
    expect(resolvePreferredCodeword(shared, null)).toBeNull();
  });

  it('loads empty (and stops returning null-for-unloaded) when the SW is unreachable', async () => {
    mockRecall(() => { throw new Error('SW asleep'); });
    await loadRecall();
    expect(isRecallLoaded()).toBe(true); // loaded, just empty
    expect(resolvePreferredCodeword(fp(), null)).toBeNull();
  });
});
