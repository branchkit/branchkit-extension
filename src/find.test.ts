import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handlePostFindKey, isPostFindActive } from './find';

function makeKey(key: string, extra: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...extra,
  } as unknown as KeyboardEvent;
}

describe('handlePostFindKey', () => {
  it('returns false when PostFindMode is not active', () => {
    const result = handlePostFindKey(makeKey('n'));
    expect(result).toBe(false);
  });

  // PostFindMode activation requires window.find() and Selection API,
  // which happy-dom doesn't support. The activation path is tested via
  // Playwright integration tests. Here we test the key dispatch logic
  // by verifying the exported function's contract.

  it('passes through non-n keys when PostFindMode is inactive', () => {
    const e = makeKey('a');
    const result = handlePostFindKey(e);
    expect(result).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
});
