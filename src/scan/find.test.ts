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

import { afterEach, vi } from 'vitest';
import {
  findImmediate,
  closeFindMode,
  purgeOrphanedFindPaint,
  openFindMode,
  isFindActive,
  isFindBarOpen,
  isFindBarFocused,
  getFindState,
  setFindCallbacks,
  clearFindPaint,
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

// Box-as-input (2026-07-26): dictation ends the query the way Enter does for
// typing.
//
// These drive the input the way the REAL wire does, because the first cut of
// this suite did not and that is precisely how the bug shipped: it fabricated
// an `insertFromPaste` event on the belief that dictation arrives as a
// synthesised Cmd+V, and the search then silently never committed in the field.
// Dictation reaches the box via `input.type_text` → enigo `fast_text`, which
// posts ONE CGEvent per 20-character chunk — so the browser fires a single
// `input` event carrying the whole chunk in `data`. Typing is one character per
// event and can never do that. Both are modelled literally below.
describe('find bar: dictation commits, typing waits for Enter', () => {
  function barInput(): HTMLInputElement {
    const el = document.querySelector('input[placeholder="Find in page..."]');
    if (!(el instanceof HTMLInputElement)) throw new Error('find bar input not found');
    return el;
  }
  /** One insert event carrying `data`, as the browser emits it. */
  function insert(data: string, inputType = 'insertText'): void {
    const el = barInput();
    el.value += data;
    el.dispatchEvent(new InputEvent('input', { inputType, data, bubbles: true }));
  }
  /** A human at the keyboard: one character per event. */
  const type = (text: string) => { for (const ch of text) insert(ch); };
  /** enigo chunks at 20 chars; each chunk is one event. */
  const dictate = (text: string) => {
    for (let i = 0; i < text.length; i += 20) insert(text.slice(i, i + 20));
  };
  /** Commit swaps the bar for the pill — the bar input going away IS the tell. */
  const committed = () => document.querySelector('input[placeholder="Find in page..."]') === null;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<p>alpha beta alpha</p>';
  });
  afterEach(() => { closeFindMode(); vi.useRealTimers(); });

  it('typing does not commit', () => {
    openFindMode();
    type('alpha');
    vi.runAllTimers();
    expect(committed()).toBe(false);
  });

  it('a dictated insert commits', () => {
    openFindMode();
    dictate('alpha');
    vi.runAllTimers();
    expect(committed()).toBe(true);
  });

  it('a dictated phrase longer than one chunk commits ONCE, after the last chunk', () => {
    // The failure this guards: committing on the first chunk tears the bar down
    // mid-insert, and the rest of the phrase is typed at the page instead.
    openFindMode();
    const phrase = 'the quick brown fox jumps over it';  // 33 chars → 2 chunks
    dictate(phrase);
    expect(committed()).toBe(false);   // still open between chunks
    vi.runAllTimers();
    expect(committed()).toBe(true);
    expect(getFindState().query).toBe(phrase);
  });

  it('typing after a dictated insert cancels the commit — the user is still editing', () => {
    openFindMode();
    dictate('alpha');
    type('x');
    vi.runAllTimers();
    expect(committed()).toBe(false);
  });

  it('an empty dictation does not commit', () => {
    // A dictation that produced nothing must leave the box open, not commit an
    // empty query and drop the user into a pill with no matches.
    openFindMode();
    insert('   ');
    vi.runAllTimers();
    expect(committed()).toBe(false);
  });

  it('closing the bar drops a pending dictated commit', () => {
    openFindMode();
    dictate('alpha');
    closeFindMode();
    expect(() => vi.runAllTimers()).not.toThrow();
    expect(isFindActive()).toBe(false);
  });
});

// The box collects a phrase for whatever the caller means to do with it. In
// `find` that phrase becomes a result set you move around in; in the
// phrase-targeting modes it is handed to a command and the session ends.
describe('find bar: phrase-targeting modes', () => {
  const phrases: Array<[string, string]> = [];
  function barInput(): HTMLInputElement {
    const el = document.querySelector('input[placeholder$="..."]');
    if (!(el instanceof HTMLInputElement)) throw new Error('box input not found');
    return el;
  }
  const dictate = (text: string) => {
    const el = barInput();
    for (let i = 0; i < text.length; i += 20) {
      const chunk = text.slice(i, i + 20);
      el.value += chunk;
      el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: chunk, bubbles: true }));
    }
  };

  // Two things jsdom lacks that these cases depend on:
  //
  //   - every Range reports zero client rects, so find's visibility filter drops
  //     every match and the box looks match-less whatever the query;
  //   - there is no CSS Custom Highlight API, so highlightApi() returns null and
  //     painting is a silent no-op. Guarding on `CSS.highlights` instead of
  //     stubbing it makes every paint assertion below vacuously pass — which is
  //     how a test proves nothing while looking green.
  //
  // Both are stubbed so the assertions are real.
  let restoreEnv: () => void;
  const highlights = () =>
    (globalThis as unknown as { CSS: { highlights: Map<string, unknown> } }).CSS.highlights;

  beforeEach(() => {
    vi.useFakeTimers();
    phrases.length = 0;
    document.body.innerHTML = '<p>alpha beta alpha</p>';

    const originalRects = Range.prototype.getClientRects;
    Range.prototype.getClientRects = () => [{}] as unknown as DOMRectList;

    const g = globalThis as unknown as {
      CSS: { highlights?: Map<string, unknown> };
      Highlight?: unknown;
    };
    const priorReg = g.CSS?.highlights;
    const priorCtor = g.Highlight;
    class FakeHighlight {
      priority = 0;
      ranges: Range[];
      constructor(...ranges: Range[]) { this.ranges = ranges; }
    }
    g.CSS = { ...(g.CSS ?? {}), highlights: new Map() };
    g.Highlight = FakeHighlight;

    restoreEnv = () => {
      Range.prototype.getClientRects = originalRects;
      g.CSS.highlights = priorReg;
      g.Highlight = priorCtor;
    };
    setFindCallbacks({ onPhrase: (mode, query) => phrases.push([mode, query]) });
  });
  afterEach(() => { closeFindMode(); setFindCallbacks({}); restoreEnv(); vi.useRealTimers(); });

  it('labels the box for what the phrase is for', () => {
    openFindMode('highlight');
    expect(barInput().placeholder).toBe('Highlight phrase...');
    closeFindMode();
    openFindMode('extend');
    expect(barInput().placeholder).toBe('Extend selection to...');
  });

  it('hands the phrase over and ends the session — no pill, no highlights left', () => {
    openFindMode('highlight');
    dictate('alpha');
    vi.runAllTimers();
    expect(phrases).toEqual([['highlight', 'alpha']]);
    // The consumer owns the page from here; find's own paint must not sit under it.
    expect(isFindActive()).toBe(false);
    expect(document.querySelector('[data-branchkit-find]')).toBeNull();
  });

  it('a search commit does NOT fire onPhrase, and vice versa', () => {
    let commits = 0;
    setFindCallbacks({ onCommit: () => { commits++; }, onPhrase: (m, q) => phrases.push([m, q]) });
    openFindMode('find');
    dictate('alpha');
    vi.runAllTimers();
    expect(commits).toBe(1);
    expect(phrases).toEqual([]);
  });

  it('with no match the box STAYS OPEN with its text selected, so the retry replaces it', () => {
    // Dictation types at the cursor: without selecting, a second attempt would
    // append to the failed one rather than replace it.
    openFindMode('highlight');
    dictate('nonexistent');
    vi.runAllTimers();
    expect(phrases).toEqual([]);
    expect(isFindActive()).toBe(true);
    const el = barInput();
    expect(el.selectionStart).toBe(0);
    expect(el.selectionEnd).toBe('nonexistent'.length);
  });

  it('the match paint SURVIVES the commit — the consumer owns it from there', () => {
    // Clearing it at commit put the pick chips over unmarked text and flashed a
    // single-match selection from highlighted to bare. The matches ARE the
    // candidates; whoever answers the question calls clearFindPaint.
    openFindMode('highlight');
    dictate('alpha');
    vi.runAllTimers();
    expect(phrases).toHaveLength(1);
    expect(highlights().has('branchkit-phrase')).toBe(true);

    clearFindPaint();
    expect(highlights().has('branchkit-phrase')).toBe(false);
  });

  it('a search commit keeps its own paint too, and still marks the current match', () => {
    setFindCallbacks({});
    openFindMode('find');
    dictate('alpha');
    vi.runAllTimers();
    expect(highlights().has('branchkit-find')).toBe(true);
    // `current` is a find concept — n/N navigation — so it exists here...
    expect(highlights().has('branchkit-find-current')).toBe(true);
  });

  it('phrase targeting paints under its OWN name, with no current match', () => {
    // Separate registry name, separate colour: yellow means "search match", and
    // these are about to become a selection. No current match either — every
    // candidate is equally pickable until you choose, and a brighter one reads
    // as already chosen once the chips are up.
    openFindMode('highlight');
    dictate('alph');   // matches, but don't commit — paint is live while typing
    expect(highlights().has('branchkit-phrase')).toBe(true);
    expect(highlights().has('branchkit-find')).toBe(false);
    expect(highlights().has('branchkit-find-current')).toBe(false);
  });

  it('switching find -> highlight does not leave the find paint behind', () => {
    openFindMode('find');
    dictate('alpha');
    vi.runAllTimers();
    expect(highlights().has('branchkit-find')).toBe(true);
    openFindMode('highlight');
    dictate('alph');
    expect(highlights().has('branchkit-find')).toBe(false);
    expect(highlights().has('branchkit-phrase')).toBe(true);
  });

  it('reopening in a different mode replaces the session rather than inheriting it', () => {
    openFindMode('find');
    dictate('alpha');
    vi.runAllTimers();               // committed find: pill up, query retained
    openFindMode('highlight');
    expect(getFindState().mode).toBe('highlight');
    expect(getFindState().query).toBe('');
    expect(barInput().value).toBe('');
  });
});

// Voice find (findImmediate) is the OTHER entry point into the box's state, and
// it used to declare only `active`. The mode a previous session left behind then
// decided how a voice find painted and what it fired — the two failures below.
describe('voice find declares its own mode', () => {
  const commits: number[] = [];
  const phrases: Array<[string, string]> = [];
  function barInput(): HTMLInputElement {
    const el = document.querySelector('input[placeholder$="..."]');
    if (!(el instanceof HTMLInputElement)) throw new Error('box input not found');
    return el;
  }
  const dictate = (text: string) => {
    const el = barInput();
    for (let i = 0; i < text.length; i += 20) {
      const chunk = text.slice(i, i + 20);
      el.value += chunk;
      el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: chunk, bubbles: true }));
    }
  };
  // Same two happy-dom gaps the phrase-targeting suite documents: no layout (so
  // every match is filtered as invisible) and no CSS Custom Highlight API (so
  // every paint assertion would pass vacuously). Both stubbed.
  let restoreEnv: () => void;
  const highlights = () =>
    (globalThis as unknown as { CSS: { highlights: Map<string, unknown> } }).CSS.highlights;

  beforeEach(() => {
    vi.useFakeTimers();
    commits.length = 0;
    phrases.length = 0;
    document.body.innerHTML = '<p>alpha beta alpha</p>';
    const originalRects = Range.prototype.getClientRects;
    Range.prototype.getClientRects = () => [{}] as unknown as DOMRectList;
    const g = globalThis as unknown as {
      CSS: { highlights?: Map<string, unknown> };
      Highlight?: unknown;
    };
    const priorReg = g.CSS?.highlights;
    const priorCtor = g.Highlight;
    class FakeHighlight {
      priority = 0;
      ranges: Range[];
      constructor(...ranges: Range[]) { this.ranges = ranges; }
    }
    g.CSS = { ...(g.CSS ?? {}), highlights: new Map() };
    g.Highlight = FakeHighlight;
    restoreEnv = () => {
      Range.prototype.getClientRects = originalRects;
      g.CSS.highlights = priorReg;
      g.Highlight = priorCtor;
    };
    setFindCallbacks({
      onCommit: () => commits.push(1),
      onPhrase: (mode, query) => phrases.push([mode, query]),
    });
  });
  afterEach(() => { closeFindMode(); setFindCallbacks({}); restoreEnv(); vi.useRealTimers(); });

  it('a voice find AFTER a highlight session paints find yellow, not the phrase wash', () => {
    // The highlight session ends without resetting the mode, so the next voice
    // find inherited `highlight`: blue wash, no current match — while the pill
    // still showed "/" and n/N navigated an unmarked "current".
    openFindMode('highlight');
    dictate('alpha');
    vi.runAllTimers();
    expect(phrases).toHaveLength(1);
    expect(isFindActive()).toBe(false);

    findImmediate('beta');
    expect(getFindState().mode).toBe('find');
    expect(highlights().has('branchkit-find')).toBe(true);
    expect(highlights().has('branchkit-find-current')).toBe(true);
    expect(highlights().has('branchkit-phrase')).toBe(false);
  });

  it('a voice find landing in an OPEN phrase box does not arm search badges', () => {
    // Model B hybrid: "highlight" opens the box, then "search <phrase>" fills it.
    // The box is still collecting a phrase for a selection command — a codeword
    // there means "select this one" (the range pick owns it), so the search-badge
    // arming that hangs off onCommit must not fire.
    openFindMode('highlight');
    findImmediate('alpha');
    expect(commits).toEqual([]);
    expect(phrases).toEqual([]);
    // The box keeps its own mode: still a phrase box, still painted as one.
    expect(getFindState().mode).toBe('highlight');
    expect(highlights().has('branchkit-phrase')).toBe(true);
    expect(highlights().has('branchkit-find')).toBe(false);
    expect(isFindBarOpen()).toBe(true);
    expect(barInput().value).toBe('alpha');
  });

  it('a plain voice find still arms search badges', () => {
    findImmediate('alpha');
    expect(commits).toEqual([1]);
    expect(getFindState().mode).toBe('find');
  });
});

// The box's own keydown listener is fed DIRECTLY by the focused input:
// content.ts returns early while the bar holds focus, so the page handler's
// keyCode-229 filter never sees these events. Without its own guard the box
// committed and tore itself down mid-composition.
//
// Escape needs the same guard for the same reason and did not have it: an IME
// Escape means "cancel this composition", and closing the session on it threw
// away the whole query because a half-typed candidate was abandoned.
describe('find bar: text-commit sentinel (IME / OS text injection)', () => {
  const barInput = () => document.querySelector('input[placeholder="Find in page..."]');
  const committed = () => barInput() === null;
  function press(init: KeyboardEventInit): void {
    const el = barInput();
    el?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
  }
  function setQuery(value: string): void {
    const el = barInput() as HTMLInputElement;
    el.value = value;
    el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: value, bubbles: true }));
  }

  beforeEach(() => { vi.useFakeTimers(); document.body.innerHTML = '<p>alpha beta</p>'; });
  afterEach(() => { closeFindMode(); vi.useRealTimers(); });

  it('an Enter carrying keyCode 229 does not commit', () => {
    openFindMode();
    const el = barInput() as HTMLInputElement;
    el.value = 'alph';
    press({ key: 'Enter', keyCode: 229 });
    expect(committed()).toBe(false);
  });

  it('an Enter while composing does not commit', () => {
    openFindMode();
    const el = barInput() as HTMLInputElement;
    el.value = 'alph';
    press({ key: 'Enter', isComposing: true });
    expect(committed()).toBe(false);
  });

  it('a real Enter still commits', () => {
    openFindMode();
    setQuery('alpha');
    press({ key: 'Enter' });
    expect(committed()).toBe(true);
  });

  it('an Escape carrying keyCode 229 cancels the composition, not the search', () => {
    openFindMode();
    setQuery('alpha');
    press({ key: 'Escape', keyCode: 229 });
    expect(isFindActive()).toBe(true);
    expect(getFindState().query).toBe('alpha');
  });

  it('an Escape while composing does not close the box', () => {
    openFindMode();
    setQuery('alpha');
    press({ key: 'Escape', isComposing: true });
    expect(isFindActive()).toBe(true);
  });

  it('a real Escape still closes', () => {
    openFindMode();
    setQuery('alpha');
    press({ key: 'Escape' });
    expect(isFindActive()).toBe(false);
  });
});

// A box that has stopped holding the keyboard has stopped having a claim on it.
// The page keydown gate yields to a FOCUSED bar; when it yielded to a merely
// PRESENT one, clicking the page with the bar open killed every BranchKit key
// at once — hint mode, find navigation, the focus-input cycler, the snapshot
// chord and Escape itself — with no visible cause and no key that recovered it.
// Two halves: the bar closes when focus leaves, and the predicate the gate asks
// is focus, so the window before/without a blur is inert rather than fatal.
describe('find bar: focus is the claim on the keyboard', () => {
  afterEach(() => { closeFindMode(); document.body.innerHTML = ''; });

  it('the bar reports focused while it holds the keyboard', () => {
    document.body.innerHTML = '<p>alpha</p>';
    openFindMode();
    expect(isFindBarOpen()).toBe(true);
    expect(isFindBarFocused()).toBe(true);
  });

  it('focus leaving the box closes the session', () => {
    document.body.innerHTML = '<p>alpha</p><input id="elsewhere">';
    openFindMode();
    document.querySelector<HTMLInputElement>('#elsewhere')!.focus();
    expect(isFindBarOpen()).toBe(false);
    expect(isFindActive()).toBe(false);
  });

  it('a present but unfocused bar reports unfocused', () => {
    // createFindBar's focus() does not land when the document itself is not
    // focused, and no blur follows a focus that never happened.
    document.body.innerHTML = '<p>alpha</p>';
    openFindMode();
    (document.activeElement as HTMLElement).blur();
    expect(isFindBarFocused()).toBe(false);
  });

  it('committing does not trip the blur close', () => {
    // commitFind removes a FOCUSED input; if the blur close were still hooked
    // at that moment it would end the session the commit exists to keep alive.
    document.body.innerHTML = '<p>alpha beta alpha</p>';
    openFindMode();
    const el = document.querySelector('input[placeholder="Find in page..."]') as HTMLInputElement;
    el.value = 'alpha';
    el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: 'alpha', bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(isFindBarOpen()).toBe(false);  // bar swapped for the pill
    expect(isFindActive()).toBe(true);    // ...and the session survived
  });
});

// macOS autocorrect replaces a word with `insertReplacementText` — an insert the
// user never asked for, arriving mid-typing. It used to satisfy the dictation
// predicate and commit the search out from under them.
describe('find bar: autocorrect does not commit', () => {
  const barInput = () => document.querySelector('input[placeholder="Find in page..."]') as HTMLInputElement | null;
  const committed = () => barInput() === null;

  beforeEach(() => { vi.useFakeTimers(); document.body.innerHTML = '<p>alpha beta</p>'; });
  afterEach(() => { closeFindMode(); vi.useRealTimers(); });

  it('the input opts out of autocorrect/autocapitalize/spellcheck', () => {
    openFindMode();
    const el = barInput()!;
    expect(el.getAttribute('autocorrect')).toBe('off');
    expect(el.getAttribute('autocapitalize')).toBe('off');
    expect(el.getAttribute('spellcheck')).toBe('false');
    expect(el.getAttribute('autocomplete')).toBe('off');
  });

  it('an autocorrect-shaped insertReplacementText does not auto-commit', () => {
    openFindMode();
    const el = barInput()!;
    // Typing: one character per event, as a human keyboard emits.
    for (const ch of 'alpga') {
      el.value += ch;
      el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: ch, bubbles: true }));
    }
    // The OS swaps the word in one go.
    el.value = 'alpha';
    el.dispatchEvent(new InputEvent('input', { inputType: 'insertReplacementText', data: 'alpha', bubbles: true }));
    vi.runAllTimers();
    expect(committed()).toBe(false);
    expect(barInput()!.value).toBe('alpha');
  });
});

// Highlights live in the document-scoped CSS.highlights registry, not the DOM,
// so a torn-down content script's yellow keeps painting with nobody owning it —
// an extension reload mid-session left stale highlights on the page until the
// tab was reloaded (field report 2026-07-26). The badge-host sweep can't reach
// them; this can.
describe('purgeOrphanedFindPaint', () => {
  beforeEach(() => { document.body.innerHTML = '<p>alpha beta alpha</p>'; });

  it('clears a predecessor\'s highlights, bar and injected style', () => {
    openFindMode();
    findImmediate('alpha');
    // Simulate the reload: the module keeps no memory across a real one, so
    // purge must work from the document alone.
    purgeOrphanedFindPaint();

    const reg = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;
    if (reg) {
      expect(reg.has('branchkit-find')).toBe(false);
      expect(reg.has('branchkit-find-current')).toBe(false);
    }
    expect(document.querySelector('[data-branchkit-find]')).toBeNull();
    expect(document.querySelector('[data-branchkit-find-style]')).toBeNull();
  });

  it('is safe with no session at all — it runs at every content-script boot', () => {
    expect(() => purgeOrphanedFindPaint()).not.toThrow();
  });
});

// --- Wave 3 C2: the mode stack rides the find session's lifetime -----------

import { modes } from '../core/modes';

describe('the mode stack rides the find session (Wave 3 C2)', () => {
  beforeEach(() => {
    modes.reset();
    closeFindMode();
    document.body.innerHTML = '<p>a needle in a needle stack</p>';
  });
  afterEach(() => closeFindMode());

  it('opening the bar pushes; ending the session pops', () => {
    openFindMode();
    expect(modes.has('find')).toBe(true);
    closeFindMode();
    expect(modes.has('find')).toBe(false);
  });

  it('a committed voice find is the same one session', () => {
    findImmediate('needle');
    expect(modes.has('find')).toBe(true);
    expect(modes.depth()).toBe(1);
    // Refining it (`/` reopens the bar seeded) joins the session, never nests.
    openFindMode();
    expect(modes.depth()).toBe(1);
    closeFindMode();
    expect(modes.has('find')).toBe(false);
  });

  it('replacing the session (different intent) lands back at one entry', () => {
    openFindMode('find');
    openFindMode('highlight'); // close-then-reopen under the hood
    expect(modes.depth()).toBe(1);
    expect(modes.has('find')).toBe(true);
  });

  it('the reachable stacking (find, then video) peels temporally — the cascade\'s order, derived', async () => {
    // Commit a search, press `w`: the one stacking genuinely reachable by
    // keyboard. The cascade's declared order peels video first; the stack
    // reaches the same answer from temporal order alone, which is what lets
    // C3 make peelTop the decider.
    const { keyHandler } = await import('../core/singletons');
    findImmediate('needle');
    keyHandler.enterVideoMode();
    expect(modes.ids()).toEqual(['find', 'video']);

    expect(modes.peelTop('t')).toMatchObject({ peeled: 'mode', id: 'video' });
    expect(modes.peelTop('t')).toMatchObject({ peeled: 'mode', id: 'find' });

    // C2 boundary: peelTop popped entries, not flags — unwind them here.
    keyHandler.exitVideoMode();
  });
});
