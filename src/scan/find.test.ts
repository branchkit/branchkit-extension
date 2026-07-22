import { describe, it, expect, beforeEach } from 'vitest';
import { findMatchRanges, findRangesFlexible, findFirstRange, buildBlockIndex } from './find';
import { entitySpan, trimSpan } from '../activate/segmenter';

function dom(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

describe('findMatchRanges', () => {
  it('finds every case-insensitive occurrence and returns matching ranges', () => {
    const root = dom('<p>Elephant element ELDER</p>');
    const ranges = findMatchRanges('el', root);
    expect(ranges).toHaveLength(3);
    for (const r of ranges) expect(r.toString().toLowerCase()).toBe('el');
  });

  it('finds multiple matches within one text node', () => {
    const root = dom('<p>aXaXa</p>');
    expect(findMatchRanges('a', root)).toHaveLength(3);
  });

  it('returns no ranges for an empty query', () => {
    const root = dom('<p>anything</p>');
    expect(findMatchRanges('', root)).toHaveLength(0);
  });

  it('skips script and style text', () => {
    const root = dom('<style>.q { color: red }</style><script>var q = 1;</script><p>q here</p>');
    const ranges = findMatchRanges('q', root);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].startContainer.parentElement?.tagName).toBe('P');
  });

  it('skips BranchKit\'s own find/hint UI', () => {
    const root = dom('<div data-branchkit-find><input></div><span data-branchkit-hint>find</span><p>find me</p>');
    const ranges = findMatchRanges('find', root);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].startContainer.parentElement?.tagName).toBe('P');
  });
});

describe('findFirstRange (caret extend-to-phrase locator)', () => {
  // happy-dom has no layout, so isMatchVisible's getClientRects fallback drops
  // every match; stub checkVisibility (the preferred path) to isolate the
  // locator logic from the visibility gate.
  const orig = (Element.prototype as { checkVisibility?: () => boolean }).checkVisibility;
  beforeEach(() => { (Element.prototype as { checkVisibility?: () => boolean }).checkVisibility = () => true; });
  afterEach(() => {
    (Element.prototype as { checkVisibility?: () => boolean }).checkVisibility = orig;
    document.body.innerHTML = '';
  });

  it('returns the first visible match Range for a phrase', () => {
    dom('<p>the quick brown fox jumps over the lazy dog</p>');
    const r = findFirstRange('brown fox');
    expect(r).not.toBeNull();
    expect(r!.toString()).toBe('brown fox');
  });

  it('matches across element boundaries (cross-node, tolerant)', () => {
    dom('<p><b>Lopo</b> (marooned)</p>');
    const r = findFirstRange('Lopo marooned');
    expect(r).not.toBeNull();
    // Cross-node tolerant match spans the bold + parenthetical.
    expect(r!.toString().toLowerCase()).toContain('lopo');
  });

  it('returns null for an empty or absent phrase', () => {
    dom('<p>nothing to see here</p>');
    expect(findFirstRange('')).toBeNull();
    expect(findFirstRange('   ')).toBeNull();
    expect(findFirstRange('absent phrase')).toBeNull();
  });
});

describe('buildBlockIndex — caret text-object substrate (word/sentence/paragraph)', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('flattens a block\'s cross-node text and round-trips DOM ⇄ flat offsets', () => {
    const root = dom('<p>The <b>quick</b> brown fox.</p>').querySelector('p')!;
    const idx = buildBlockIndex(root);
    expect(idx.text).toBe('The quick brown fox.');
    const b = root.querySelector('b')!.firstChild!; // "quick"
    const pos = idx.posOf(b, 1); // the "u" in quick
    expect(idx.text[pos!]).toBe('u');
    const r = idx.rangeFor(0, 3);
    expect(r!.toString()).toBe('The');
  });

  it('selects the whole sentence around a caret even across inline nodes (the ap/as bug)', () => {
    // A sentence split by <b>/<a> — the old single-node path clipped it at the
    // node boundary, so "as" grabbed only part. The flat index spans it.
    const root = dom('<p>First one. The <b>quick</b> brown <a href="#">fox</a> jumps. Third.</p>')
      .querySelector('p')!;
    const idx = buildBlockIndex(root);
    // Caret inside the <b> ("quick"), which is mid-sentence-2.
    const b = root.querySelector('b')!.firstChild!;
    const caret = idx.posOf(b, 2)!;
    const span = entitySpan(idx.text, 'sentence', caret);
    const r = idx.rangeFor(span.start, span.end)!;
    expect(r.toString().trim()).toBe('The quick brown fox jumps.');
  });

  it('paragraph = the whole block text, inner-trimmed', () => {
    const root = dom('<p>  Padded paragraph text.  </p>').querySelector('p')!;
    const idx = buildBlockIndex(root);
    const { start, end } = trimSpan(idx.text, 0, idx.text.length);
    expect(idx.rangeFor(start, end)!.toString()).toBe('Padded paragraph text.');
  });
});

// --- Committed pill (the voice-find affordance, 2026-06-29 review) ---
//
// happy-dom note: match VISIBILITY (isMatchVisible) is engine-dependent here,
// so these assert pill lifecycle + state, not match counts.

import { afterEach } from 'vitest';
import {
  findImmediate,
  closeFindMode,
  openFindMode,
  isFindActive,
  isFindBarOpen,
  getFindState,
} from './find';

const pill = () =>
  [...document.querySelectorAll('[data-branchkit-find]')].find(
    (el) => !el.querySelector('input'),
  ) ?? null;
const bar = () =>
  [...document.querySelectorAll('[data-branchkit-find]')].find(
    (el) => el.querySelector('input'),
  ) ?? null;

describe('committed find pill', () => {
  afterEach(() => {
    closeFindMode();
    document.body.innerHTML = '';
  });

  it('findImmediate shows a persistent pill with the query and a count element', () => {
    dom('<p>needle in a needle stack</p>');
    findImmediate('needle');
    expect(isFindActive()).toBe(true);
    expect(isFindBarOpen()).toBe(false); // read-only pill, not the input bar
    const p = pill();
    expect(p).not.toBeNull();
    expect(p!.textContent).toContain('needle');
    expect(p!.querySelector('#branchkit-find-count')).not.toBeNull();
    expect(getFindState().query).toBe('needle');
  });

  it('closeFindMode removes the pill and deactivates find', () => {
    dom('<p>needle</p>');
    findImmediate('needle');
    closeFindMode();
    expect(pill()).toBeNull();
    expect(isFindActive()).toBe(false);
  });

  it('a second findImmediate replaces the pill (single instance, new query)', () => {
    dom('<p>alpha beta</p>');
    findImmediate('alpha');
    findImmediate('beta');
    const pills = [...document.querySelectorAll('[data-branchkit-find]')]
      .filter((el) => !el.querySelector('input'));
    expect(pills).toHaveLength(1);
    expect(pills[0].textContent).toContain('beta');
    expect(getFindState().query).toBe('beta');
  });

  it('Enter in the bar commits: bar swaps to pill, find stays active', () => {
    dom('<p>target text</p>');
    openFindMode();
    const input = bar()!.querySelector('input')!;
    input.value = 'target';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(isFindBarOpen()).toBe(false);
    expect(isFindActive()).toBe(true);
    expect(pill()).not.toBeNull();
    expect(pill()!.textContent).toContain('target');
  });

  it('Enter on an empty query closes find entirely (Vimium behavior)', () => {
    dom('<p>whatever</p>');
    openFindMode();
    const input = bar()!.querySelector('input')!;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(isFindActive()).toBe(false);
    expect(pill()).toBeNull();
    expect(bar()).toBeNull();
  });

  it('openFindMode from the committed state reopens the bar seeded with the query', () => {
    dom('<p>refine me</p>');
    findImmediate('refine');
    openFindMode();
    expect(pill()).toBeNull();
    const input = bar()?.querySelector('input');
    expect(input).not.toBeNull();
    expect(input!.value).toBe('refine');
  });
});

describe('findRangesFlexible (voice: cross-node, accent + punctuation tolerant)', () => {
  it('matches a phrase spanning a bold title, a parenthesis, and a link', () => {
    // Mirrors a Wikipedia lead: bold title + parenthetical + a linked term, all
    // separate text nodes — the single-node exact matcher cannot span these.
    const root = dom(
      '<p><b>Lopo Martín</b> (marooned 21 July 1566) was an <a>Afro-Portuguese</a> maritime pilot.</p>',
    );
    const ranges = findRangesFlexible('Martin marooned 21 July 1566', root);
    expect(ranges.length).toBe(1);
    const t = ranges[0].toString();
    expect(t).toContain('Martín'); // accent folded on the query side
    expect(t).toContain('marooned'); // matched across the "(" and node boundary
  });

  it('folds accents (typed "Martin" finds "Martín")', () => {
    const root = dom('<p>Lopo Martín was a pilot.</p>');
    expect(findRangesFlexible('Martin', root)).toHaveLength(1);
  });

  it('does not match when a query word is absent', () => {
    const root = dom('<p>Lopo Martín (marooned 1566)</p>');
    expect(findRangesFlexible('Martin stranded', root)).toHaveLength(0);
  });
});

describe('findMatchRanges (exact, now cross-node)', () => {
  it('matches exact text spanning an element boundary', () => {
    const root = dom('<p>the <b>quick</b> brown fox</p>');
    const ranges = findMatchRanges('quick brown', root); // spans </b> into the next text node
    expect(ranges).toHaveLength(1);
    expect(ranges[0].toString()).toBe('quick brown');
  });

  it('matches an inline-split word across adjacent nodes (no boundary space)', () => {
    const root = dom('<p><b>cat</b><i>alog</i></p>');
    expect(findMatchRanges('catalog', root)).toHaveLength(1);
  });

  it('stays accent-sensitive (exact): "Martin" does NOT match "Martín"', () => {
    const root = dom('<p>Lopo Martín</p>');
    expect(findMatchRanges('Martin', root)).toHaveLength(0);
    expect(findMatchRanges('Martín', root)).toHaveLength(1);
  });
});
