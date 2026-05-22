import { describe, it, expect } from 'vitest';
import { suggestPattern, isValidSelector, validatePattern } from './options-helpers';

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
