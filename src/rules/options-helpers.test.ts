import { describe, it, expect } from 'vitest';
import { suggestPattern, isValidSelector, validatePattern, reorderRules } from './options-helpers';

describe('reorderRules', () => {
  const ids = (arr: { id: string }[]) => arr.map(r => r.id);
  const list = () => [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('moves an item down (before a later target)', () => {
    expect(ids(reorderRules(list(), 'a', 'c'))).toEqual(['b', 'a', 'c']);
  });

  it('moves an item up (before an earlier target)', () => {
    expect(ids(reorderRules(list(), 'c', 'a'))).toEqual(['c', 'a', 'b']);
  });

  it('swaps adjacent items', () => {
    expect(ids(reorderRules([{ id: 'a' }, { id: 'b' }], 'b', 'a'))).toEqual(['b', 'a']);
  });

  it('is a no-op when dragged === target', () => {
    expect(ids(reorderRules(list(), 'b', 'b'))).toEqual(['a', 'b', 'c']);
  });

  it('is a no-op when the dragged id is missing', () => {
    expect(ids(reorderRules(list(), 'zzz', 'b'))).toEqual(['a', 'b', 'c']);
  });

  it('appends when the target id is missing', () => {
    expect(ids(reorderRules(list(), 'a', 'zzz'))).toEqual(['b', 'c', 'a']);
  });

  it('does not mutate the input array', () => {
    const original = list();
    reorderRules(original, 'a', 'c');
    expect(ids(original)).toEqual(['a', 'b', 'c']);
  });
});

describe('suggestPattern', () => {
  it('uses wildcard for subdomain hosts', () => {
    expect(suggestPattern('https://app.example.com/anything')).toBe('*.example.com');
  });

  it('uses wildcard for deeply nested subdomains', () => {
    expect(suggestPattern('https://a.b.c.example.com/')).toBe('*.example.com');
  });

  it('uses exact match for two-label hosts', () => {
    expect(suggestPattern('https://example.com/')).toBe('example.com');
  });

  it('uses exact match for IPv4', () => {
    expect(suggestPattern('http://127.0.0.1:8080/')).toBe('127.0.0.1');
  });

  it('returns null for chrome:// URLs', () => {
    expect(suggestPattern('chrome://settings/')).toBeNull();
  });

  it('returns null for unparseable input', () => {
    expect(suggestPattern('not a url')).toBeNull();
  });
});

describe('isValidSelector', () => {
  it('accepts a simple tag selector', () => {
    expect(isValidSelector('button')).toBe(true);
  });

  it('accepts a class+attribute selector', () => {
    expect(isValidSelector('a.deleteBtn[aria-label="Delete"]')).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(isValidSelector('')).toBe(false);
  });

  it('rejects whitespace-only input', () => {
    expect(isValidSelector('   ')).toBe(false);
  });

  it('rejects malformed selectors', () => {
    expect(isValidSelector('!!nope!!')).toBe(false);
    expect(isValidSelector('[unclosed')).toBe(false);
  });
});

describe('validatePattern', () => {
  it('accepts wildcard subdomain', () => {
    expect(validatePattern('*.example.com')).toBeNull();
  });

  it('accepts exact host', () => {
    expect(validatePattern('example.com')).toBeNull();
  });

  it('accepts host + path prefix', () => {
    expect(validatePattern('example.com/app/*')).toBeNull();
  });

  it('accepts host + exact path', () => {
    expect(validatePattern('example.com/exact/path')).toBeNull();
  });

  it('rejects empty input', () => {
    expect(validatePattern('')).toMatch(/required/);
  });

  it('rejects whitespace in pattern', () => {
    expect(validatePattern('example .com')).toMatch(/spaces/);
  });

  it('rejects an embedded wildcard (only leading "*." is allowed)', () => {
    expect(validatePattern('foo.*.com')).toMatch(/leading/);
  });

  it('rejects a bare wildcard', () => {
    expect(validatePattern('*.')).toMatch(/Wildcard/);
  });

  it('rejects a hostless input', () => {
    expect(validatePattern('com')).toMatch(/valid domain/);
  });

  it('rejects a path with a non-trailing wildcard', () => {
    expect(validatePattern('example.com/*/foo')).toMatch(/end/);
  });
});
