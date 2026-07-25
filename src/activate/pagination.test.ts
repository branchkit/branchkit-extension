import { describe, it, expect } from 'vitest';
import { findPageLink } from './pagination';

function doc(html: string): Document {
  return new DOMParser().parseFromString(`<!DOCTYPE html><html><body>${html}</body></html>`, 'text/html');
}

describe('findPageLink', () => {
  it('prefers an explicit rel=next / rel=prev anchor', () => {
    const d = doc('<a rel="next" href="https://x.test/p2">whatever</a><a href="https://x.test/nope">next</a>');
    expect(findPageLink(d, 'next')).toBe('https://x.test/p2');
  });

  it('honors <link rel=prev>', () => {
    const d = doc('<link rel="prev" href="https://x.test/p1">');
    expect(findPageLink(d, 'prev')).toBe('https://x.test/p1');
  });

  it('falls back to a link whose text matches (exact beats substring)', () => {
    const d = doc(
      '<a href="https://x.test/other">go to the next section anchor</a>' +
      '<a href="https://x.test/p2">Next</a>',
    );
    expect(findPageLink(d, 'next')).toBe('https://x.test/p2');
  });

  it('matches aria-label and icon-only pagers', () => {
    const d = doc('<a href="https://x.test/p3" aria-label="Next page">›</a>');
    expect(findPageLink(d, 'next')).toBe('https://x.test/p3');
  });

  it('matches previous / older phrasings', () => {
    const d = doc('<a href="https://x.test/p1">Older posts</a>');
    expect(findPageLink(d, 'prev')).toBe('https://x.test/p1');
  });

  it('returns null when nothing looks like pagination', () => {
    const d = doc('<a href="https://x.test/about">About us</a><a href="https://x.test/x">Contact</a>');
    expect(findPageLink(d, 'next')).toBeNull();
  });

  it('does not confuse next and prev', () => {
    const d = doc('<a rel="prev" href="https://x.test/p1">Prev</a>');
    expect(findPageLink(d, 'next')).toBeNull();
  });
});
