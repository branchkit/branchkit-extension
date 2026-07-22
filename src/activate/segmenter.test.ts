import { describe, it, expect } from 'vitest';
import {
  segmentStops, nextStop, lineBoundary, applyFieldModify,
  readFieldRange, writeFieldRange, nativeModifyWasInert, segmenterAvailable,
  entitySpan, trimSpan,
} from './segmenter';

const SENTENCES = 'Hello world. Second one! Third?';

describe('segmentStops', () => {
  it('always includes the string ends', () => {
    const stops = segmentStops('', 'word');
    expect(stops).toEqual([0]);
    const s2 = segmentStops('abc', 'word');
    expect(s2[0]).toBe(0);
    expect(s2[s2.length - 1]).toBe(3);
  });

  it('breaks sentences at their starts (Intl.Segmenter sentence)', () => {
    const stops = segmentStops(SENTENCES, 'sentence');
    // "Hello world. " ends at 13; "Second one! " ends at 25.
    expect(stops).toContain(13);
    expect(stops).toContain(25);
  });

  it('word stops fall on word starts and ends', () => {
    const stops = segmentStops('foo bar', 'word');
    // "foo" 0..3, "bar" 4..7
    expect(stops).toEqual([0, 3, 4, 7]);
  });

  it('line stops surround each newline', () => {
    expect(segmentStops('a\nbb\nc', 'line')).toEqual([0, 1, 2, 4, 5, 6]);
  });

  it('paragraph stops surround blank-line gaps', () => {
    const text = 'para one\n\npara two';
    const stops = segmentStops(text, 'paragraph');
    expect(stops).toContain(8);  // gap start (after "para one")
    expect(stops).toContain(10); // gap end (before "para two")
  });
});

describe('nextStop — moving by a granularity', () => {
  it('advances forward one word at a time', () => {
    // 'foo bar baz' stops: 0,3,4,7,8,11
    const t = 'foo bar baz';
    expect(nextStop(t, 'word', 0, 'forward', 1)).toBe(3);
    expect(nextStop(t, 'word', 0, 'forward', 2)).toBe(4);
    expect(nextStop(t, 'word', 3, 'backward', 1)).toBe(0);
  });

  it('clamps at the ends', () => {
    const t = 'foo bar';
    expect(nextStop(t, 'word', 6, 'forward', 5)).toBe(t.length);
    expect(nextStop(t, 'word', 1, 'backward', 5)).toBe(0);
  });

  it('walks forward by sentence', () => {
    expect(nextStop(SENTENCES, 'sentence', 0, 'forward', 1)).toBe(13);
    expect(nextStop(SENTENCES, 'sentence', 0, 'forward', 2)).toBe(25);
  });
});

describe('lineBoundary', () => {
  const t = 'first line\nsecond line\nthird';
  it('finds the end of the current line going forward', () => {
    expect(lineBoundary(t, 3, 'forward')).toBe(10); // the first \n
  });
  it('finds the start of the current line going backward', () => {
    expect(lineBoundary(t, 15, 'backward')).toBe(11); // char after the first \n
  });
  it('clamps to string ends with no newline', () => {
    expect(lineBoundary('one line', 3, 'forward')).toBe(8);
    expect(lineBoundary('one line', 3, 'backward')).toBe(0);
  });
});

describe('applyFieldModify — editable-field selection', () => {
  it('extends the focus forward by a word, anchor fixed', () => {
    const r = applyFieldModify('foo bar baz', { anchor: 0, focus: 0 }, {
      alter: 'extend', direction: 'forward', granularity: 'word', count: 1,
    });
    expect(r).toEqual({ anchor: 0, focus: 3 });
  });

  it('shrink (extend backward) pulls the focus toward the anchor', () => {
    const r = applyFieldModify('foo bar baz', { anchor: 0, focus: 7 }, {
      alter: 'extend', direction: 'backward', granularity: 'word', count: 1,
    });
    expect(r.anchor).toBe(0);
    expect(r.focus).toBe(4);
  });

  it('lineboundary extends to end of the line', () => {
    const r = applyFieldModify('one\ntwo', { anchor: 0, focus: 0 }, {
      alter: 'extend', direction: 'forward', granularity: 'lineboundary', count: 1,
    });
    expect(r.focus).toBe(3);
  });

  it('character moves one char per count', () => {
    const r = applyFieldModify('abcdef', { anchor: 2, focus: 2 }, {
      alter: 'extend', direction: 'forward', granularity: 'character', count: 3,
    });
    expect(r.focus).toBe(5);
  });
});

describe('field range read/write round-trip', () => {
  function fakeInput(): HTMLInputElement {
    // Minimal stand-in — happy-dom inputs support selection APIs.
    const el = document.createElement('input');
    el.value = 'foo bar baz';
    document.body.appendChild(el);
    return el;
  }

  it('reads forward and backward selections as anchor/focus', () => {
    const el = fakeInput();
    el.setSelectionRange(0, 3, 'forward');
    expect(readFieldRange(el)).toEqual({ anchor: 0, focus: 3 });
    el.setSelectionRange(0, 3, 'backward');
    expect(readFieldRange(el)).toEqual({ anchor: 3, focus: 0 });
    el.remove();
  });

  it('writes an anchor/focus range back with the right direction', () => {
    const el = fakeInput();
    writeFieldRange(el, { anchor: 4, focus: 0 });
    expect(el.selectionStart).toBe(0);
    expect(el.selectionEnd).toBe(4);
    expect(el.selectionDirection).toBe('backward');
    el.remove();
  });
});

describe('nativeModifyWasInert — when to use the Segmenter fallback', () => {
  it('is false when the selection length changed', () => {
    expect(nativeModifyWasInert('sentence', 5, 9)).toBe(false);
  });
  it('is true for a Firefox-missing granularity that did not move', () => {
    expect(nativeModifyWasInert('sentence', 5, 5)).toBe(true);
    expect(nativeModifyWasInert('paragraph', 5, 5)).toBe(true);
    expect(nativeModifyWasInert('lineboundary', 5, 5)).toBe(true);
  });
  it('is false for a universally-supported granularity (a real boundary)', () => {
    expect(nativeModifyWasInert('word', 5, 5)).toBe(false);
    expect(nativeModifyWasInert('line', 5, 5)).toBe(false);
    expect(nativeModifyWasInert('character', 5, 5)).toBe(false);
  });
});

describe('entitySpan — whole word/sentence around the caret', () => {
  const S = 'Hello world. The quick brown fox jumps. Third sentence here.';

  it('selects the whole sentence with the caret anywhere inside it', () => {
    // Caret in the MIDDLE of the second sentence ("quick").
    const mid = S.indexOf('quick') + 2;
    const span = entitySpan(S, 'sentence', mid);
    expect(S.slice(span.start, span.end).trim()).toBe('The quick brown fox jumps.');
  });

  it('selects the first sentence from a caret near its start', () => {
    const span = entitySpan(S, 'sentence', 2);
    expect(S.slice(span.start, span.end).trim()).toBe('Hello world.');
  });

  it('selects the whole word with the caret in the middle of it', () => {
    const t = 'foo bar baz';
    const span = entitySpan(t, 'word', 5); // inside "bar"
    expect(t.slice(span.start, span.end)).toBe('bar');
  });

  it('picks the preceding word when the caret is on a space', () => {
    const t = 'foo bar baz';
    const span = entitySpan(t, 'word', 3); // the space after "foo"
    expect(t.slice(span.start, span.end)).toBe('foo');
  });

  it('handles the caret at the very end of the text', () => {
    const t = 'foo bar';
    const span = entitySpan(t, 'word', t.length);
    expect(t.slice(span.start, span.end)).toBe('bar');
  });
});

describe('trimSpan — inner (whitespace-trimmed) variant', () => {
  it('drops leading and trailing whitespace', () => {
    const t = '  hello world  ';
    expect(trimSpan(t, 0, t.length)).toEqual({ start: 2, end: 13 });
  });
  it('leaves an already-tight span unchanged', () => {
    const t = 'abc';
    expect(trimSpan(t, 0, 3)).toEqual({ start: 0, end: 3 });
  });
  it('trims a trailing newline (paragraph copy)', () => {
    const t = 'a paragraph\n';
    expect(trimSpan(t, 0, t.length)).toEqual({ start: 0, end: 11 });
  });
});

describe('segmenterAvailable', () => {
  it('reports Intl.Segmenter presence (true on this runtime)', () => {
    expect(segmenterAvailable()).toBe(true);
  });
});
