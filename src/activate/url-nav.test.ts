import { describe, it, expect } from 'vitest';
import { urlUp, urlRoot } from './url-nav';

describe('urlUp', () => {
  it('strips the hash first', () => {
    expect(urlUp('https://x.test/a/b#sec')).toBe('https://x.test/a/b');
  });

  it('then strips the query', () => {
    expect(urlUp('https://x.test/a/b?q=1')).toBe('https://x.test/a/b');
  });

  it('then climbs one path segment', () => {
    expect(urlUp('https://x.test/a/b/c')).toBe('https://x.test/a/b/');
    expect(urlUp('https://x.test/a/b/c/')).toBe('https://x.test/a/b/'); // trailing slash ignored
  });

  it('climbs from a single segment to root', () => {
    expect(urlUp('https://x.test/a')).toBe('https://x.test/');
  });

  it('returns null at the root path', () => {
    expect(urlUp('https://x.test/')).toBeNull();
    expect(urlUp('https://x.test')).toBeNull();
  });

  it('returns null for an unparseable URL', () => {
    expect(urlUp('not a url')).toBeNull();
  });
});

describe('urlRoot', () => {
  it('jumps to scheme://host/', () => {
    expect(urlRoot('https://x.test/a/b/c?q=1#s')).toBe('https://x.test/');
  });

  it('preserves a non-default port', () => {
    expect(urlRoot('http://x.test:8080/deep/path')).toBe('http://x.test:8080/');
  });

  it('returns null when already at the root', () => {
    expect(urlRoot('https://x.test/')).toBeNull();
  });
});
