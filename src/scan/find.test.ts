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
