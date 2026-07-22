import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CaretController } from './caret';
import { findImmediate, closeFindMode, isFindActive } from '../scan/find';

// The Selection-movement path (Selection.modify) isn't implemented in happy-dom,
// so grow/shrink granularity is verified in a real browser. Here we cover the
// controller's state machine + the find→selection promotion paths, which use
// addRange/extend (both supported by happy-dom), not Selection.modify.

// happy-dom has no layout → isMatchVisible's getClientRects fallback drops every
// find match; stub checkVisibility (the preferred path) so the phrase locator
// resolves. Restored after each test.
const origCheckVis = (Element.prototype as { checkVisibility?: () => boolean }).checkVisibility;
beforeEach(() => { (Element.prototype as { checkVisibility?: () => boolean }).checkVisibility = () => true; });
afterEach(() => {
  (Element.prototype as { checkVisibility?: () => boolean }).checkVisibility = origCheckVis;
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

describe('CaretController — inner/around text-object prefixes', () => {
  function enterVisualOnSelection(): CaretController {
    document.body.innerHTML = '<p>some selectable words here on the page</p>';
    const p = document.querySelector('p')!.firstChild!;
    const sel = window.getSelection()!;
    const range = document.createRange();
    range.setStart(p, 0);
    range.setEnd(p, 4);
    sel.removeAllRanges();
    sel.addRange(range);
    const c = new CaretController({ onModeChange: vi.fn() });
    c.enterFromNormal();
    return c;
  }
  const key = (k: string) => ({ key: k, preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as KeyboardEvent);

  it('arms and swallows the `i` prefix without leaking the key or throwing', () => {
    const c = enterVisualOnSelection();
    // `i` (inner) arms the text-object prefix — captured, mode intact, no
    // Selection.modify yet (that only fires on the entity key w/s/p).
    expect(c.handleKey(key('i'))).toBe(true);
    expect(c.isActive()).toBe(true);
    // A non-entity key clears the prefix and is still swallowed by the mode.
    expect(c.handleKey(key('z'))).toBe(true);
    expect(c.isActive()).toBe(true);
  });

  it('arms the `a` prefix the same way', () => {
    const c = enterVisualOnSelection();
    expect(c.handleKey(key('a'))).toBe(true);
    expect(c.isActive()).toBe(true);
  });
});

describe('CaretController — extend to phrase (Phase B)', () => {
  it('selects the found phrase when there is no live anchor, entering visual', () => {
    document.body.innerHTML = '<p>the quick brown fox jumps over the lazy dog</p>';
    const onModeChange = vi.fn();
    const c = new CaretController({ onModeChange });
    c.extendToPhrase('brown fox');
    expect(c.getMode()).toBe('visual');
    expect(onModeChange).toHaveBeenCalledWith('visual');
    expect(window.getSelection()!.toString()).toBe('brown fox');
  });

  it('keeps the anchor and extends the focus to the phrase when a selection exists', () => {
    document.body.innerHTML = '<p>the quick brown fox jumps over the lazy dog</p>';
    const p = document.querySelector('p')!.firstChild!;
    const sel = window.getSelection()!;
    const range = document.createRange();
    range.setStart(p, 4); // "quick..."
    range.setEnd(p, 9);   // selects "quick"
    sel.removeAllRanges();
    sel.addRange(range);

    const c = new CaretController({ onModeChange: vi.fn() });
    c.enterFromNormal(); // visual over "quick"
    c.extendToPhrase('lazy'); // extend focus forward to "lazy"
    const text = window.getSelection()!.toString();
    expect(text.startsWith('quick')).toBe(true);
    expect(text.includes('lazy')).toBe(true);
  });

  it('does nothing but toast when the phrase is absent (no mode change)', () => {
    document.body.innerHTML = '<p>nothing relevant here</p>';
    const onModeChange = vi.fn();
    const c = new CaretController({ onModeChange });
    c.extendToPhrase('absent words');
    expect(c.isActive()).toBe(false);
    expect(onModeChange).not.toHaveBeenCalled();
  });
});

describe('CaretController — find → selection handoff (Phase B)', () => {
  afterEach(() => closeFindMode());
  const key = (k: string) => ({ key: k, preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as KeyboardEvent);

  it('enterFromFind returns false when there is no active find match', () => {
    document.body.innerHTML = '<p>some page text without a search</p>';
    const c = new CaretController({ onModeChange: vi.fn() });
    expect(c.enterFromFind()).toBe(false);
    expect(c.isActive()).toBe(false);
  });

  it('extends from the caret anchor to the searched match, not from the match', () => {
    document.body.innerHTML = '<p>alpha beta gamma delta epsilon</p>';
    const p = document.querySelector('p')!.firstChild!;
    const sel = window.getSelection()!;
    const r = document.createRange(); // a caret-like 1-char selection at the start
    r.setStart(p, 0);
    r.setEnd(p, 1);
    sel.removeAllRanges();
    sel.addRange(r);

    const c = new CaretController({ onModeChange: vi.fn() });
    c.enterFromNormal(); // visual over "a" — no Selection.modify needed
    c.handleKey(key('/')); // saves the anchor (offset 0) + opens find
    findImmediate('delta'); // sets the current match well AHEAD of the caret
    c.extendToCurrentMatch();

    // Selection runs from the caret (start) THROUGH the match — not just the
    // match forward (the reported "everything after the searched word" bug).
    expect(window.getSelection()!.toString()).toBe('alpha beta gamma delta');
  });

  it('exit clears an active find (no lingering pill needing a second Escape)', () => {
    document.body.innerHTML = '<p>alpha beta gamma delta</p>';
    const p = document.querySelector('p')!.firstChild!;
    const sel = window.getSelection()!;
    const r = document.createRange();
    r.setStart(p, 0);
    r.setEnd(p, 5);
    sel.removeAllRanges();
    sel.addRange(r);
    const c = new CaretController({ onModeChange: vi.fn() });
    c.enterFromNormal(); // visual — no Selection.modify
    findImmediate('gamma');
    expect(isFindActive()).toBe(true);
    c.exit();
    expect(isFindActive()).toBe(false);
    expect(c.isActive()).toBe(false);
  });

  it('Escape peels the layers in order: search → visual → caret → Normal', () => {
    // happy-dom lacks Selection.modify (used to repaint the 1-char caret on the
    // visual→caret collapse); stub it so the collapse path runs. The peel ORDER
    // is the point.
    const sel = window.getSelection()!;
    const proto = Object.getPrototypeOf(sel) as { modify?: unknown };
    const origModify = proto.modify;
    proto.modify = () => {};
    try {
      document.body.innerHTML = '<p>alpha beta gamma delta</p>';
      const p = document.querySelector('p')!.firstChild!;
      const r = document.createRange();
      r.setStart(p, 0);
      r.setEnd(p, 5); // a visual selection "alpha"
      sel.removeAllRanges();
      sel.addRange(r);
      const c = new CaretController({ onModeChange: vi.fn() });
      c.enterFromNormal(); // visual layer
      findImmediate('gamma'); // search layer on top
      expect(isFindActive()).toBe(true);

      // 1st Escape: peel SEARCH — find cleared, but the selection + visual stay.
      c.handleKey(key('Escape'));
      expect(isFindActive()).toBe(false);
      expect(c.getMode()).toBe('visual');
      expect(sel.isCollapsed).toBe(false);

      // 2nd Escape: peel VISUAL — collapse back to the caret.
      c.handleKey(key('Escape'));
      expect(c.getMode()).toBe('caret');
      expect(c.isActive()).toBe(true);

      // 3rd Escape: peel CARET — exit to Normal.
      c.handleKey(key('Escape'));
      expect(c.isActive()).toBe(false);
    } finally {
      proto.modify = origModify;
    }
  });
});
