import { describe, it, expect, vi, afterEach } from 'vitest';
import { CaretController } from './caret';

// The Selection-movement path (Selection.modify) isn't implemented in jsdom, so
// it's verified in a real browser. Here we cover the controller's state machine:
// inactive handling and the "no selectable text" abort, neither of which touches
// Selection.modify.

afterEach(() => {
  document.body.innerHTML = '';
});

describe('CaretController — control flow', () => {
  it('is inactive until entered, and swallows nothing while inactive', () => {
    const c = new CaretController({ onModeChange: vi.fn() });
    expect(c.isActive()).toBe(false);
    expect(c.getMode()).toBeNull();
    const e = { key: 'j', preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as KeyboardEvent;
    expect(c.handleKey(e)).toBe(false);
  });

  it('aborts entry (stays inactive, no mode change) when the page has no big text node', () => {
    document.body.innerHTML = '<button>hi</button>'; // no ≥50-char text node
    const onModeChange = vi.fn();
    const c = new CaretController({ onModeChange });
    c.enter('caret');
    expect(c.isActive()).toBe(false);
    expect(onModeChange).not.toHaveBeenCalled();
  });
});
