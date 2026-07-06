import { describe, it, expect } from 'vitest';
import {
  baseUrl,
  localMarkKey,
  globalMarkKey,
  isPrevPositionRegister,
  isMarkChar,
  marksToHash,
  PREV_POSITION_REGISTERS,
} from './marks';

describe('baseUrl', () => {
  it('strips the hash', () => {
    expect(baseUrl('https://x.com/a?b=1#frag')).toBe('https://x.com/a?b=1');
  });
  it('leaves a hashless URL unchanged', () => {
    expect(baseUrl('https://x.com/a')).toBe('https://x.com/a');
  });
});

describe('mark keys', () => {
  it('local key is per base-URL + letter, hash-insensitive', () => {
    expect(localMarkKey('https://x.com/a#top', 'q')).toBe('mark:local:https://x.com/a:q');
    // Same page, different anchor → same key (the hash lives in the value).
    expect(localMarkKey('https://x.com/a#bottom', 'q')).toBe(localMarkKey('https://x.com/a#top', 'q'));
  });
  it('global key is letter-only', () => {
    expect(globalMarkKey('A')).toBe('mark:global:A');
  });
});

describe('previous-position registers', () => {
  it('recognizes ` and \'', () => {
    expect(PREV_POSITION_REGISTERS).toEqual(['`', "'"]);
    expect(isPrevPositionRegister('`')).toBe(true);
    expect(isPrevPositionRegister("'")).toBe(true);
    expect(isPrevPositionRegister('a')).toBe(false);
  });
});

describe('isMarkChar', () => {
  it('accepts single printables', () => {
    expect(isMarkChar('a')).toBe(true);
    expect(isMarkChar('A')).toBe(true);
    expect(isMarkChar('`')).toBe(true);
  });
  it('rejects modifier / control key names and space', () => {
    expect(isMarkChar('Shift')).toBe(false);
    expect(isMarkChar('Enter')).toBe(false);
    expect(isMarkChar(' ')).toBe(false);
  });
});

describe('marksToHash', () => {
  it('true only for a hash with no scroll offset', () => {
    expect(marksToHash({ scrollX: 0, scrollY: 0, hash: '#sec' })).toBe(true);
    expect(marksToHash({ scrollX: 0, scrollY: 0, hash: '' })).toBe(false);
    expect(marksToHash({ scrollX: 0, scrollY: 400, hash: '#sec' })).toBe(false);
  });
});
