/**
 * BranchKit Browser — Per-domain hint rules tests.
 *
 * Pins pattern matching (subdomain wildcard, exact host, host+path),
 * compileRule bucketing + selector validation, exclusion across
 * CSS/text/class matchers, CSS inclusions, single-element
 * isExcludedByRule consistency, and reveal stylesheet generation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  matchRule,
  compileRule,
  applyExclusions,
  collectInclusions,
  isExcludedByRule,
  injectRevealStyles,
  type DomainRule,
  type RuleEntry,
} from './domain-rules';
import type { ScannedElement } from './types';

let nextId = 0;
function rid(): string {
  return `e${++nextId}`;
}

function rule(overrides: Partial<DomainRule> = {}): DomainRule {
  return {
    id: 'r1',
    pattern: 'example.com',
    enabled: true,
    entries: [],
    ...overrides,
  };
}

function excludeEntry(matcher: RuleEntry['matcher']): RuleEntry {
  return { id: rid(), kind: 'exclude', matcher };
}

function includeEntry(selector: string): RuleEntry {
  return { id: rid(), kind: 'include', matcher: { type: 'css', selector } };
}

function revealEntry(
  selector: string,
  method: 'opacity' | 'visibility' | 'display',
): RuleEntry {
  return {
    id: rid(),
    kind: 'reveal',
    matcher: { type: 'css', selector },
    reveal: method,
  };
}

function scanned(label = 'x'): ScannedElement {
  return {
    label,
    id: 0,
    category: 'button',
    type: 'button',
    adapter: null,
    codeword: '',
  };
}

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('matchRule — subdomain wildcard *.example.com', () => {
  const rules = [rule({ pattern: '*.example.com' })];

  it('matches a subdomain', () => {
    expect(matchRule('https://app.example.com/foo', rules)).toBe(rules[0]);
  });

  it('matches a deeply nested subdomain', () => {
    expect(matchRule('https://a.b.example.com/', rules)).toBe(rules[0]);
  });

  it('does NOT match the bare host', () => {
    expect(matchRule('https://example.com/', rules)).toBeNull();
  });

  it('does not match an unrelated domain that ends with the same suffix as a substring', () => {
    expect(matchRule('https://notexample.com/', rules)).toBeNull();
    expect(matchRule('https://fakeexample.com/', rules)).toBeNull();
  });
});

describe('matchRule — exact host example.com', () => {
  const rules = [rule({ pattern: 'example.com' })];

  it('matches the exact host', () => {
    expect(matchRule('https://example.com/', rules)).toBe(rules[0]);
  });

  it('does not match a subdomain', () => {
    expect(matchRule('https://app.example.com/', rules)).toBeNull();
  });

  it('matches regardless of path', () => {
    expect(matchRule('https://example.com/deep/path?x=1', rules)).toBe(rules[0]);
  });
});

describe('matchRule — host + path prefix example.com/app/*', () => {
  const rules = [rule({ pattern: 'example.com/app/*' })];

  it('matches when path starts with /app/', () => {
    expect(matchRule('https://example.com/app/home', rules)).toBe(rules[0]);
    expect(matchRule('https://example.com/app/', rules)).toBe(rules[0]);
  });

  it('does not match a different path prefix', () => {
    expect(matchRule('https://example.com/api/foo', rules)).toBeNull();
  });

  it('does not match a subdomain', () => {
    expect(matchRule('https://app.example.com/app/foo', rules)).toBeNull();
  });
});

describe('matchRule — rule ordering and enabled flag', () => {
  it('returns the first enabled match', () => {
    const a = rule({ id: 'a', pattern: '*.example.com', enabled: false });
    const b = rule({ id: 'b', pattern: '*.example.com' });
    expect(matchRule('https://x.example.com/', [a, b])).toBe(b);
  });

  it('skips disabled rules', () => {
    const a = rule({ pattern: 'example.com', enabled: false });
    expect(matchRule('https://example.com/', [a])).toBeNull();
  });

  it('returns null when no rule matches', () => {
    expect(matchRule('https://other.com/', [rule()])).toBeNull();
  });

  it('returns null for an unparseable URL', () => {
    expect(matchRule('not a url', [rule()])).toBeNull();
  });
});

describe('compileRule', () => {
  it('buckets entries by kind', () => {
    const r = rule({
      entries: [
        excludeEntry({ type: 'css', selector: 'a' }),
        includeEntry('button'),
        revealEntry('.gear', 'opacity'),
        excludeEntry({ type: 'class', name: 'bad' }),
      ],
    });
    const c = compileRule(r);
    expect(c.excludes).toHaveLength(2);
    expect(c.reveals).toHaveLength(1);
    expect(c.includeSelector).toBe('button');
  });

  it('joins multiple CSS includes into a single selector', () => {
    const r = rule({
      entries: [includeEntry('[data-clickable]'), includeEntry('.widget')],
    });
    expect(compileRule(r).includeSelector).toBe('[data-clickable], .widget');
  });

  it('drops invalid include selectors but keeps valid siblings', () => {
    const r = rule({
      entries: [includeEntry('button'), includeEntry('!!nope!!')],
    });
    expect(compileRule(r).includeSelector).toBe('button');
  });

  it('drops invalid exclude CSS selectors so they don\'t throw per-element at scan time', () => {
    const r = rule({
      entries: [
        excludeEntry({ type: 'css', selector: '[unclosed' }),
        excludeEntry({ type: 'css', selector: 'button.kept' }),
        excludeEntry({ type: 'class', name: 'still-here' }),
      ],
    });
    const c = compileRule(r);
    expect(c.excludes).toHaveLength(2);
    expect((c.excludes[0].matcher as { selector: string }).selector).toBe('button.kept');
    expect(c.excludes[1].matcher.type).toBe('class');
  });

  it('returns null includeSelector when there are no valid includes', () => {
    const r = rule({ entries: [excludeEntry({ type: 'css', selector: 'a' })] });
    expect(compileRule(r).includeSelector).toBeNull();
  });

  it('ignores non-CSS include matchers (v1 is CSS-only for includes)', () => {
    const r = rule({
      entries: [
        { id: rid(), kind: 'include', matcher: { type: 'text', value: 'X', caseSensitive: false } },
      ],
    });
    expect(compileRule(r).includeSelector).toBeNull();
  });
});

describe('applyExclusions', () => {
  it('removes elements matching a CSS exclude', () => {
    document.body.innerHTML = `
      <button id="keep">Keep</button>
      <button class="drop">Drop</button>
      <button id="keep2">Keep2</button>
    `;
    const refs = Array.from(document.querySelectorAll('button'));
    const elements = refs.map(r => scanned(r.textContent || ''));
    const { excludes } = compileRule(rule({
      entries: [excludeEntry({ type: 'css', selector: 'button.drop' })],
    }));

    applyExclusions(refs, elements, excludes);

    expect(refs.map(e => e.id || e.className)).toEqual(['keep', 'keep2']);
    expect(elements).toHaveLength(2);
  });

  it('removes elements matching a text matcher (case-insensitive by default)', () => {
    document.body.innerHTML = `
      <a>Home</a>
      <a>delete</a>
      <a>About</a>
    `;
    const refs = Array.from(document.querySelectorAll('a'));
    const elements = refs.map(r => scanned(r.textContent || ''));
    const { excludes } = compileRule(rule({
      entries: [excludeEntry({ type: 'text', value: 'Delete', caseSensitive: false })],
    }));

    applyExclusions(refs, elements, excludes);

    expect(refs.map(e => e.textContent)).toEqual(['Home', 'About']);
  });

  it('text matcher respects caseSensitive: true', () => {
    document.body.innerHTML = `<a>Delete</a><a>delete</a>`;
    const refs = Array.from(document.querySelectorAll('a'));
    const elements = refs.map(r => scanned(r.textContent || ''));
    const { excludes } = compileRule(rule({
      entries: [excludeEntry({ type: 'text', value: 'Delete', caseSensitive: true })],
    }));

    applyExclusions(refs, elements, excludes);

    expect(refs.map(e => e.textContent)).toEqual(['delete']);
  });

  it('removes elements matching a class matcher', () => {
    document.body.innerHTML = `
      <button class="primary">A</button>
      <button class="danger primary">B</button>
      <button class="secondary">C</button>
    `;
    const refs = Array.from(document.querySelectorAll('button'));
    const elements = refs.map(r => scanned(r.textContent || ''));
    const { excludes } = compileRule(rule({
      entries: [excludeEntry({ type: 'class', name: 'danger' })],
    }));

    applyExclusions(refs, elements, excludes);

    expect(refs.map(e => e.textContent)).toEqual(['A', 'C']);
  });

  it('keeps refs and elements arrays in sync at the same indices', () => {
    document.body.innerHTML = `<a>a</a><a class="x">b</a><a>c</a>`;
    const refs = Array.from(document.querySelectorAll('a'));
    const elements: ScannedElement[] = [
      scanned('elem-a'),
      scanned('elem-b'),
      scanned('elem-c'),
    ];
    const { excludes } = compileRule(rule({
      entries: [excludeEntry({ type: 'css', selector: 'a.x' })],
    }));

    applyExclusions(refs, elements, excludes);

    expect(refs).toHaveLength(2);
    expect(elements).toHaveLength(2);
    expect(elements[0].label).toBe('elem-a');
    expect(elements[1].label).toBe('elem-c');
    expect(refs[0].textContent).toBe('a');
    expect(refs[1].textContent).toBe('c');
  });

  it('combines multiple exclude entries with OR semantics', () => {
    document.body.innerHTML = `
      <button class="drop">A</button>
      <button>Delete</button>
      <button>Keep</button>
    `;
    const refs = Array.from(document.querySelectorAll('button'));
    const elements = refs.map(r => scanned(r.textContent || ''));
    const { excludes } = compileRule(rule({
      entries: [
        excludeEntry({ type: 'class', name: 'drop' }),
        excludeEntry({ type: 'text', value: 'Delete', caseSensitive: false }),
      ],
    }));

    applyExclusions(refs, elements, excludes);

    expect(refs.map(e => e.textContent)).toEqual(['Keep']);
  });

  it('no-op when excludes is empty', () => {
    document.body.innerHTML = `<button>A</button>`;
    const refs = Array.from(document.querySelectorAll('button'));
    const elements = refs.map(() => scanned('a'));
    const { excludes } = compileRule(rule({
      entries: [includeEntry('button'), revealEntry('button', 'opacity')],
    }));

    applyExclusions(refs, elements, excludes);

    expect(refs).toHaveLength(1);
    expect(elements).toHaveLength(1);
  });

  it('silently skips invalid CSS selectors', () => {
    document.body.innerHTML = `<button>A</button>`;
    const refs = Array.from(document.querySelectorAll('button'));
    const elements = refs.map(() => scanned('a'));
    const { excludes } = compileRule(rule({
      entries: [excludeEntry({ type: 'css', selector: '!!not a selector!!' })],
    }));

    expect(() => applyExclusions(refs, elements, excludes)).not.toThrow();
    expect(refs).toHaveLength(1);
  });
});

describe('collectInclusions', () => {
  it('collects elements matching CSS include selectors', () => {
    document.body.innerHTML = `
      <div data-clickable id="a">A</div>
      <div data-clickable id="b">B</div>
      <div id="c">C</div>
    `;
    const { includeSelector } = compileRule(rule({
      entries: [includeEntry('[data-clickable]')],
    }));

    const out = collectInclusions(new Set(), includeSelector);

    expect(out.refs.map(e => e.id)).toEqual(['a', 'b']);
    expect(out.elements).toHaveLength(2);
    expect(out.elements[0].type).toBe('div');
  });

  it('skips elements already in the seen set', () => {
    document.body.innerHTML = `<div data-x id="a"></div><div data-x id="b"></div>`;
    const { includeSelector } = compileRule(rule({
      entries: [includeEntry('[data-x]')],
    }));
    const seen = new Set<Element>([document.getElementById('a')!]);

    const out = collectInclusions(seen, includeSelector);

    expect(out.refs).toHaveLength(1);
    expect(out.refs[0].id).toBe('b');
  });

  it('dedupes elements matched by multiple include selectors', () => {
    document.body.innerHTML = `<div data-x class="y" id="a"></div>`;
    const { includeSelector } = compileRule(rule({
      entries: [includeEntry('[data-x]'), includeEntry('.y')],
    }));

    const out = collectInclusions(new Set(), includeSelector);

    expect(out.refs).toHaveLength(1);
    expect(out.refs[0].id).toBe('a');
  });

  it('returns empty when includeSelector is null', () => {
    document.body.innerHTML = `<div>A</div>`;
    const out = collectInclusions(new Set(), null);
    expect(out.refs).toHaveLength(0);
  });

  it('classifies included elements by category', () => {
    document.body.innerHTML = `
      <a data-link href="#">link</a>
      <input data-field type="text" />
    `;
    const { includeSelector } = compileRule(rule({
      entries: [includeEntry('[data-link]'), includeEntry('[data-field]')],
    }));

    const out = collectInclusions(new Set(), includeSelector);

    const categories = out.elements.map(e => e.category).sort();
    expect(categories).toEqual(['input', 'link']);
  });
});

describe('isExcludedByRule', () => {
  it('agrees with applyExclusions for each matcher type', () => {
    document.body.innerHTML = `
      <button class="primary" id="a">Save</button>
      <button class="danger" id="b">Delete</button>
      <button id="c">Other</button>
    `;
    const { excludes } = compileRule(rule({
      entries: [
        excludeEntry({ type: 'class', name: 'danger' }),
        excludeEntry({ type: 'text', value: 'Save', caseSensitive: false }),
      ],
    }));

    const a = document.getElementById('a')!;
    const b = document.getElementById('b')!;
    const c = document.getElementById('c')!;

    expect(isExcludedByRule(a, excludes)).toBe(true);  // text matches "Save"
    expect(isExcludedByRule(b, excludes)).toBe(true);  // class matches "danger"
    expect(isExcludedByRule(c, excludes)).toBe(false);

    const refs = [a, b, c];
    const elements = refs.map(() => scanned());
    applyExclusions(refs, elements, excludes);
    expect(refs).toEqual([c]);
  });

  it('returns false when no entries match', () => {
    document.body.innerHTML = `<button>X</button>`;
    const { excludes } = compileRule(rule({
      entries: [excludeEntry({ type: 'css', selector: 'a' })],
    }));
    expect(isExcludedByRule(document.querySelector('button')!, excludes)).toBe(false);
  });

  it('returns false when excludes is empty', () => {
    document.body.innerHTML = `<button>X</button>`;
    expect(isExcludedByRule(document.querySelector('button')!, [])).toBe(false);
  });
});

describe('injectRevealStyles', () => {
  it('returns null when no reveal entries', () => {
    const { reveals } = compileRule(rule({
      entries: [excludeEntry({ type: 'css', selector: 'a' })],
    }));
    expect(injectRevealStyles(reveals)).toBeNull();
  });

  it('builds an opacity rule from a reveal entry', () => {
    const { reveals } = compileRule(rule({
      entries: [revealEntry('button.gear', 'opacity')],
    }));
    const style = injectRevealStyles(reveals)!;

    expect(style).not.toBeNull();
    expect(style.tagName).toBe('STYLE');
    expect(style.hasAttribute('data-branchkit-reveal')).toBe(true);
    expect(style.textContent).toContain('button.gear');
    expect(style.textContent).toContain('opacity: 1 !important');
  });

  it('builds a visibility rule from a reveal entry', () => {
    const { reveals } = compileRule(rule({
      entries: [revealEntry('.hidden', 'visibility')],
    }));
    const style = injectRevealStyles(reveals)!;

    expect(style.textContent).toContain('.hidden');
    expect(style.textContent).toContain('visibility: visible !important');
  });

  it('omits display reveals (deferred to v2)', () => {
    const { reveals } = compileRule(rule({
      entries: [revealEntry('.foo', 'display')],
    }));
    expect(injectRevealStyles(reveals)).toBeNull();
  });

  it('joins multiple reveal rules with newlines', () => {
    const { reveals } = compileRule(rule({
      entries: [revealEntry('.a', 'opacity'), revealEntry('.b', 'visibility')],
    }));
    const style = injectRevealStyles(reveals)!;

    expect(style.textContent).toContain('.a');
    expect(style.textContent).toContain('.b');
    expect(style.textContent!.split('\n').length).toBe(2);
  });

  it('drops display entries but keeps mixed opacity/visibility ones', () => {
    const { reveals } = compileRule(rule({
      entries: [revealEntry('.dropped', 'display'), revealEntry('.kept', 'opacity')],
    }));
    const style = injectRevealStyles(reveals)!;

    expect(style.textContent).not.toContain('.dropped');
    expect(style.textContent).toContain('.kept');
  });
});
