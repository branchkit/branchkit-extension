import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CaretController } from './caret';
import { findImmediate, closeFindMode, isFindActive, setFindCallbacks } from '../scan/find';

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

describe('CaretController — remembers the caret position across exits', () => {
  it('re-enters at the last anchor, not a fresh first-node anchor', () => {
    // Stub Selection.modify (happy-dom lacks it; applyKind paints the 1-char
    // caret with it). The remembered-position round-trip is the point.
    const sel = window.getSelection()!;
    const proto = Object.getPrototypeOf(sel) as { modify?: unknown };
    const origModify = proto.modify;
    proto.modify = () => {};
    try {
      document.body.innerHTML = '<p>the quick brown fox jumps over the lazy dog today</p>';
      const p = document.querySelector('p')!.firstChild!;
      // A caret-like selection well into the text (offset 20), not at the start.
      const r = document.createRange();
      r.setStart(p, 20);
      r.setEnd(p, 21);
      sel.removeAllRanges();
      sel.addRange(r);

      const c = new CaretController({ onModeChange: vi.fn() });
      c.enterFromNormal();        // visual/caret over the spot at offset 20
      c.exit();                   // remembers anchor = offset 20
      expect(c.isActive()).toBe(false);

      c.enter('caret');           // re-enter → should restore offset 20
      expect(window.getSelection()!.anchorOffset).toBe(20);
    } finally {
      proto.modify = origModify;
    }
  });

  it('does not restore a remembered node that has since detached (SPA churn)', () => {
    const sel = window.getSelection()!;
    const proto = Object.getPrototypeOf(sel) as { modify?: unknown };
    const origModify = proto.modify;
    proto.modify = () => {};
    try {
      document.body.innerHTML = '<p>the quick brown fox jumps over the lazy dog today</p>';
      const stale = document.querySelector('p')!.firstChild!;
      const r = document.createRange();
      r.setStart(stale, 20);
      r.setEnd(stale, 21);
      sel.removeAllRanges();
      sel.addRange(r);
      const c = new CaretController({ onModeChange: vi.fn() });
      c.enterFromNormal();
      c.exit(); // remembers the <p> text node

      // Replace the DOM — the remembered node detaches. Re-entry must not throw
      // and must NOT seed the selection at the stale node.
      document.body.innerHTML = '<p>a completely different replacement paragraph</p>';
      expect(() => c.enter('caret')).not.toThrow();
      expect(window.getSelection()!.anchorNode).not.toBe(stale);
    } finally {
      proto.modify = origModify;
    }
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

describe('CaretController — voice whole-entity select (aw/as/ap twin)', () => {
  it('"select sentence" grabs the whole sentence around the caret', () => {
    document.body.innerHTML =
      '<p>First one here. The quick brown fox jumps over. Third sentence.</p>';
    const node = document.querySelector('p')!.firstChild!;
    const mid = node.textContent!.indexOf('brown') + 2; // caret mid-sentence-2
    const sel = window.getSelection()!;
    const r = document.createRange();
    r.setStart(node, mid);
    r.setEnd(node, mid + 1);
    sel.removeAllRanges();
    sel.addRange(r);

    const c = new CaretController({ onModeChange: vi.fn() });
    c.enterFromNormal(); // visual — no Selection.modify
    c.applyVoice({ op: 'select', granularity: 'sentence' });
    expect(window.getSelection()!.toString().trim()).toBe('The quick brown fox jumps over.');
  });

  it('"select word" grabs just the word (inner-trimmed)', () => {
    document.body.innerHTML = '<p>alpha bravo charlie delta echo</p>';
    const node = document.querySelector('p')!.firstChild!;
    const mid = node.textContent!.indexOf('charlie') + 3;
    const sel = window.getSelection()!;
    const r = document.createRange();
    r.setStart(node, mid);
    r.setEnd(node, mid + 1);
    sel.removeAllRanges();
    sel.addRange(r);

    const c = new CaretController({ onModeChange: vi.fn() });
    c.enterFromNormal();
    c.applyVoice({ op: 'select', granularity: 'word' });
    expect(window.getSelection()!.toString()).toBe('charlie');
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

  // Escape undoes the ACTION, not one internal layer of it. A phrase command
  // creates the caret and the selection together from nothing, and peeling them
  // one at a time parked the user in a caret mode they never entered and had no
  // prior position in (field report 2026-07-26).
  it('a phrase-created selection leaves in ONE escape', () => {
    document.body.innerHTML = '<p>the quick brown fox jumps over the lazy dog</p>';
    const c = new CaretController({ onModeChange: vi.fn() });
    c.extendToPhrase('brown fox');
    expect(c.getMode()).toBe('visual');

    c.escape();
    expect(c.isActive()).toBe(false);
  });

  // ...but a session the USER built still peels: the caret they were sitting on
  // is a real place to go back to, so the first escape collapses to it.
  // collapseToCaret goes through Selection.modify, which happy-dom lacks.
  function withModifyStub(body: () => void): void {
    const proto = Object.getPrototypeOf(window.getSelection()!) as { modify?: unknown };
    const orig = proto.modify;
    proto.modify = () => {};
    try { body(); } finally { proto.modify = orig; }
  }

  function userSelection(): CaretController {
    const p = document.querySelector('p')!.firstChild!;
    const sel = window.getSelection()!;
    const range = document.createRange();
    range.setStart(p, 4);
    range.setEnd(p, 9);
    sel.removeAllRanges();
    sel.addRange(range);
    const c = new CaretController({ onModeChange: vi.fn() });
    c.enterFromNormal();          // the user chose this
    c.extendToPhrase('lazy');     // extending THEIR session
    return c;
  }

  it('a user-entered selection still collapses to its caret first', () => {
    document.body.innerHTML = '<p>the quick brown fox jumps over the lazy dog</p>';
    withModifyStub(() => {
      const c = userSelection();
      c.escape();
      expect(c.isActive()).toBe(true);   // collapsed to the caret, still in
      c.escape();
      expect(c.isActive()).toBe(false);  // and out
    });
  });

  // The floor is per-session, not sticky: after a phrase session exits, a
  // session the user opens next behaves like their own again.
  it('the escape floor resets when the session ends', () => {
    document.body.innerHTML = '<p>the quick brown fox jumps over the lazy dog</p>';
    withModifyStub(() => {
      const c = new CaretController({ onModeChange: vi.fn() });
      c.extendToPhrase('brown fox');
      c.escape();                   // one-shot exit, floor was 'normal'
      expect(c.isActive()).toBe(false);

      const same = userSelection();
      same.escape();
      expect(same.isActive()).toBe(true);  // theirs again — collapses, not exits
    });
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

      // escape() rather than handleKey('Escape'): the escape cascade owns the
      // key now and calls straight in here, so this is the real entry point for
      // BOTH the Escape key and the spoken "escape"/"over". A case in
      // handleKey would be a second path (activate/escape-cascade.ts).

      // 1st Escape: peel SEARCH — find cleared, but the selection + visual stay.
      c.escape();
      expect(isFindActive()).toBe(false);
      expect(c.getMode()).toBe('visual');
      expect(sel.isCollapsed).toBe(false);

      // 2nd Escape: peel VISUAL — collapse back to the caret.
      c.escape();
      expect(c.getMode()).toBe('caret');
      expect(c.isActive()).toBe(true);

      // 3rd Escape: peel CARET — exit to Normal.
      c.escape();
      expect(c.isActive()).toBe(false);
    } finally {
      proto.modify = origModify;
    }
  });
});

// The find the caret session was entered FROM is the user's, not the session's.
// Field report 2026-07-26: `/quick` Enter, `v`, `y` — the yank's exit tore down
// a find that pre-dated the selection entirely (pill, highlights, n/N, the
// FIND_ACTIVE mirror), because exit() closed find unconditionally.
describe('CaretController — a find that pre-dates the session survives it', () => {
  afterEach(() => { closeFindMode(); setFindCallbacks({}); });
  const key = (k: string) => ({ key: k, preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as KeyboardEvent);

  function committedFind(): { deactivations: number } {
    document.body.innerHTML = '<p>alpha beta gamma delta epsilon omega</p>';
    const counts = { deactivations: 0 };
    setFindCallbacks({ onDeactivate: () => { counts.deactivations += 1; } });
    findImmediate('gamma');
    expect(isFindActive()).toBe(true);
    return counts;
  }

  it('yanking out of a promoted find match leaves the find session intact', () => {
    const counts = committedFind();
    const c = new CaretController({ onModeChange: vi.fn() });
    expect(c.enterFromFind()).toBe(true); // `v` with no live selection
    c.handleKey(key('y'));                // yank → exit
    expect(c.isActive()).toBe(false);
    expect(isFindActive()).toBe(true);
    // The FIND_ACTIVE {active:false} post rides onDeactivate — it must not fire.
    expect(counts.deactivations).toBe(0);
  });

  it('exit() from a session entered over a find leaves it alone', () => {
    const counts = committedFind();
    const c = new CaretController({ onModeChange: vi.fn() });
    c.enterFromFind();
    c.exit();
    expect(isFindActive()).toBe(true);
    expect(counts.deactivations).toBe(0);
  });

  // Peel by which layer is NEWER. Here find is the older layer, so the first
  // escape takes the selection — the reverse of the search-on-top flow above.
  it('escape peels the selection first when find is the older layer', () => {
    const proto = Object.getPrototypeOf(window.getSelection()!) as { modify?: unknown };
    const origModify = proto.modify;
    proto.modify = () => {};
    try {
      const counts = committedFind();
      const c = new CaretController({ onModeChange: vi.fn() });
      c.enterFromFind();
      expect(c.getMode()).toBe('visual');

      c.escape();                        // visual → caret; find untouched
      expect(isFindActive()).toBe(true);
      expect(c.getMode()).toBe('caret');

      c.escape();                        // caret → Normal; find STILL untouched
      expect(c.isActive()).toBe(false);
      expect(isFindActive()).toBe(true);
      expect(counts.deactivations).toBe(0);
    } finally {
      proto.modify = origModify;
    }
  });

  // A caret session that STARTED over a find, then started its own second find
  // (`/`) — the newer one is the session's to close.
  it('a find opened DURING the session is still closed by exit', () => {
    document.body.innerHTML = '<p>alpha beta gamma delta epsilon omega</p>';
    const p = document.querySelector('p')!.firstChild!;
    const sel = window.getSelection()!;
    const r = document.createRange();
    r.setStart(p, 0);
    r.setEnd(p, 5);
    sel.removeAllRanges();
    sel.addRange(r);
    const c = new CaretController({ onModeChange: vi.fn() });
    c.enterFromNormal();  // no find underneath
    findImmediate('gamma');
    c.exit();
    expect(isFindActive()).toBe(false);
  });

  // The floor is per-session like entryFloor: a session opened after the
  // find-entered one behaves like its own again.
  it('the find floor resets when the session ends', () => {
    committedFind();
    const c = new CaretController({ onModeChange: vi.fn() });
    c.enterFromFind();
    c.exit();
    expect(isFindActive()).toBe(true);

    // Same controller, fresh session over the (still live) find's match — but
    // now started by a second, session-owned find.
    closeFindMode();
    const p = document.querySelector('p')!.firstChild!;
    const sel = window.getSelection()!;
    const r = document.createRange();
    r.setStart(p, 0);
    r.setEnd(p, 5);
    sel.removeAllRanges();
    sel.addRange(r);
    c.enterFromNormal();
    findImmediate('delta');
    c.exit();
    expect(isFindActive()).toBe(false);
  });
});
