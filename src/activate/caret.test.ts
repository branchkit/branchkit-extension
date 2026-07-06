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

  it('enterFromNormal keeps a pre-existing selection and goes to visual (Vimium parity)', () => {
    // A non-collapsed selection — no Selection.modify needed to build one.
    document.body.innerHTML = '<p>some selectable words here on the page</p>';
    const p = document.querySelector('p')!;
    const range = document.createRange();
    range.setStart(p.firstChild!, 0);
    range.setEnd(p.firstChild!, 4); // "some"
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    const onModeChange = vi.fn();
    const c = new CaretController({ onModeChange });
    c.enterFromNormal();
    expect(c.getMode()).toBe('visual');
    expect(onModeChange).toHaveBeenCalledWith('visual');
  });
});
