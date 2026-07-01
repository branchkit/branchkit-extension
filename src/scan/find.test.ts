import { describe, it, expect } from 'vitest';
import { findMatchRanges } from './find';

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
