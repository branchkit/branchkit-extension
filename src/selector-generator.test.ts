import { describe, it, expect, beforeEach } from 'vitest';
import {
  BLACKLIST,
  isProbablyStable,
  matchesBlacklist,
  generateSelector,
} from './selector-generator';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('BLACKLIST', () => {
  it('filters out data-hint attributes', () => {
    expect(BLACKLIST.some(re => re.test('data-hint'))).toBe(true);
  });

  it('filters out data-branchkit attributes', () => {
    expect(BLACKLIST.some(re => re.test('data-branchkit'))).toBe(true);
    expect(BLACKLIST.some(re => re.test('data-branchkit-hint'))).toBe(true);
  });

  it('filters out href', () => {
    expect(BLACKLIST.some(re => re.test('href'))).toBe(true);
  });

  it('filters out numeric IDs (e.g. #issue-123)', () => {
    expect(matchesBlacklist('#issue-123')).toBe(true);
    expect(matchesBlacklist('#comment-9876')).toBe(true);
  });

  it('filters out hex hash suffixes (Tailwind JIT, CSS modules)', () => {
    expect(matchesBlacklist('btn-abc123')).toBe(true);
    expect(matchesBlacklist('tw-bg-a1b2c3')).toBe(true);
  });

  it('filters out multi-segment hashes (Emotion, styled-components)', () => {
    expect(matchesBlacklist('css-abcde-fghij')).toBe(true);
  });

  it('filters out CSS Modules pattern (paint_abc123)', () => {
    expect(matchesBlacklist('paint_abc123def')).toBe(true);
  });

  it('does not filter stable semantic classes', () => {
    expect(matchesBlacklist('btn-primary')).toBe(false);
    expect(matchesBlacklist('nav-item')).toBe(false);
  });
});

describe('isProbablyStable', () => {
  it('accepts hyphen-separated semantic classes', () => {
    expect(isProbablyStable('btn-primary')).toBe(true);
    expect(isProbablyStable('nav-item')).toBe(true);
    expect(isProbablyStable('text-lg')).toBe(true);
    expect(isProbablyStable('card-body-inner')).toBe(true);
  });

  it('rejects single words without hyphens', () => {
    expect(isProbablyStable('primary')).toBe(false);
  });

  it('rejects classes with numbers', () => {
    expect(isProbablyStable('col-12')).toBe(false);
  });

  it('rejects too many segments', () => {
    expect(isProbablyStable('a-b-c-d-e')).toBe(false);
  });
});

describe('generateSelector', () => {
  it('uses ID when available and unique', () => {
    document.body.innerHTML = `<button id="submit-btn">Go</button>`;
    const el = document.querySelector('#submit-btn')!;
    expect(generateSelector(el)).toBe('#submit-btn');
  });

  it('skips blacklisted IDs', () => {
    document.body.innerHTML = `<button id="#issue-123">Go</button>`;
    const el = document.querySelector('button')!;
    const sel = generateSelector(el);
    expect(sel).not.toContain('#issue-123');
  });

  it('uses data-testid when available', () => {
    document.body.innerHTML = `<button data-testid="save-btn">Save</button>`;
    const el = document.querySelector('[data-testid]')!;
    expect(generateSelector(el)).toBe('[data-testid="save-btn"]');
  });

  it('round-trips: querySelector(generateSelector(el)) === el', () => {
    document.body.innerHTML = `
      <div>
        <button class="btn-primary">First</button>
        <button class="btn-secondary">Second</button>
      </div>
    `;
    const btns = document.querySelectorAll('button');
    for (const btn of btns) {
      const sel = generateSelector(btn);
      expect(document.querySelector(sel)).toBe(btn);
    }
  });

  it('produces tag-prefixed selectors with stable classes', () => {
    document.body.innerHTML = `<button class="btn-primary">Go</button>`;
    const el = document.querySelector('button')!;
    const sel = generateSelector(el);
    expect(sel).toMatch(/^button\./);
  });

  it('falls back to nth-of-type', () => {
    document.body.innerHTML = `
      <div>
        <span>A</span>
        <span>B</span>
        <span>C</span>
      </div>
    `;
    const second = document.querySelectorAll('span')[1];
    const sel = generateSelector(second);
    expect(sel).toContain('nth-of-type');
    expect(document.querySelector(sel)).toBe(second);
  });

  it('uses ancestor ID + nth-of-type', () => {
    document.body.innerHTML = `
      <div id="toolbar">
        <button>A</button>
        <button>B</button>
      </div>
    `;
    const second = document.querySelectorAll('button')[1];
    const sel = generateSelector(second);
    expect(sel).toContain('#toolbar');
    expect(document.querySelector(sel)).toBe(second);
  });

  it('uses aria-label for unique identification', () => {
    document.body.innerHTML = `
      <button aria-label="Close">X</button>
      <button>Save</button>
    `;
    const close = document.querySelector('[aria-label]')!;
    const sel = generateSelector(close);
    expect(sel).toContain('aria-label');
    expect(document.querySelector(sel)).toBe(close);
  });

  it('handles elements with no distinguishing features', () => {
    document.body.innerHTML = `<span>Lone</span>`;
    const el = document.querySelector('span')!;
    const sel = generateSelector(el);
    expect(document.querySelector(sel)).toBe(el);
  });
});
