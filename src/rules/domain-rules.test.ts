/**
 * BranchKit Browser — Per-domain hint rules tests.
 *
 * Pins pattern matching (subdomain wildcard, exact host, host+path),
 * cascade merge across the matched set, compileRules bucketing +
 * selector validation, exclusion across CSS/text/class matchers, CSS
 * inclusions, single-element isExcludedByRule consistency, and reveal
 * stylesheet generation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  matchRules,
  compileRules,
  urlMatchesPattern,
  applyExclusions,
  collectInclusions,
  isExcludedByRule,
  injectRevealStyles,
  resolveNudgeOffset,
  type DomainRule,
  type RuleEntry,
} from './domain-rules';
import type { ScannedElement } from '../types';

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

// Compile one or more rules into the merged CompiledRule. Most tests
// pass a single rule; cascade tests pass several.
function compile(...rules: DomainRule[]): ReturnType<typeof compileRules> {
  return compileRules(rules);
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

describe('matchRules — subdomain wildcard *.example.com', () => {
  const rules = [rule({ pattern: '*.example.com' })];

  it('matches a subdomain', () => {
    expect(matchRules('https://app.example.com/foo', rules)).toEqual([rules[0]]);
  });

  it('matches a deeply nested subdomain', () => {
    expect(matchRules('https://a.b.example.com/', rules)).toEqual([rules[0]]);
  });

  it('does NOT match the bare host', () => {
    expect(matchRules('https://example.com/', rules)).toEqual([]);
  });

  it('does not match an unrelated domain that ends with the same suffix as a substring', () => {
    expect(matchRules('https://notexample.com/', rules)).toEqual([]);
    expect(matchRules('https://fakeexample.com/', rules)).toEqual([]);
  });
});

describe('matchRules — exact host example.com', () => {
  const rules = [rule({ pattern: 'example.com' })];

  it('matches the exact host', () => {
    expect(matchRules('https://example.com/', rules)).toEqual([rules[0]]);
  });

  it('does not match a subdomain', () => {
    expect(matchRules('https://app.example.com/', rules)).toEqual([]);
  });

  it('matches regardless of path', () => {
    expect(matchRules('https://example.com/deep/path?x=1', rules)).toEqual([rules[0]]);
  });
});

describe('matchRules — host + path prefix example.com/app/*', () => {
  const rules = [rule({ pattern: 'example.com/app/*' })];

  it('matches when path starts with /app/', () => {
    expect(matchRules('https://example.com/app/home', rules)).toEqual([rules[0]]);
    expect(matchRules('https://example.com/app/', rules)).toEqual([rules[0]]);
  });

  it('does not match a different path prefix', () => {
    expect(matchRules('https://example.com/api/foo', rules)).toEqual([]);
  });

  it('does not match a subdomain', () => {
    expect(matchRules('https://app.example.com/app/foo', rules)).toEqual([]);
  });
});

describe('matchRules — enabled flag and empties', () => {
  it('skips disabled rules but keeps enabled ones', () => {
    const a = rule({ id: 'a', pattern: '*.example.com', enabled: false });
    const b = rule({ id: 'b', pattern: '*.example.com' });
    expect(matchRules('https://x.example.com/', [a, b])).toEqual([b]);
  });

  it('returns empty when only a disabled rule matches', () => {
    const a = rule({ pattern: 'example.com', enabled: false });
    expect(matchRules('https://example.com/', [a])).toEqual([]);
  });

  it('returns empty when no rule matches', () => {
    expect(matchRules('https://other.com/', [rule()])).toEqual([]);
  });

  it('returns empty for an unparseable URL', () => {
    expect(matchRules('not a url', [rule()])).toEqual([]);
  });
});

describe('matchRules — cascade (general + specific both apply)', () => {
  const general = rule({ id: 'gen', pattern: '*.quickbase.com' });
  const specific = rule({ id: 'spec', pattern: 'acme.quickbase.com' });

  it('returns every matching rule in declaration order', () => {
    expect(matchRules('https://acme.quickbase.com/db', [general, specific]))
      .toEqual([general, specific]);
  });

  it('declaration order does not change membership', () => {
    expect(matchRules('https://acme.quickbase.com/db', [specific, general]))
      .toEqual([specific, general]);
  });

  it('only the general rule applies on a non-specific subdomain', () => {
    expect(matchRules('https://other.quickbase.com/db', [general, specific]))
      .toEqual([general]);
  });
});

describe('urlMatchesPattern', () => {
  it('reports a match regardless of any enabled flag', () => {
    expect(urlMatchesPattern('https://acme.quickbase.com/', '*.quickbase.com')).toBe(true);
    expect(urlMatchesPattern('https://acme.quickbase.com/', 'acme.quickbase.com')).toBe(true);
  });

  it('reports a non-match', () => {
    expect(urlMatchesPattern('https://example.com/', '*.quickbase.com')).toBe(false);
  });

  it('returns false for an unparseable URL', () => {
    expect(urlMatchesPattern('not a url', 'example.com')).toBe(false);
  });
});

describe('compileRules', () => {
  it('buckets entries by kind', () => {
    const r = rule({
      entries: [
        excludeEntry({ type: 'css', selector: 'a' }),
        includeEntry('button'),
        revealEntry('.gear', 'opacity'),
        excludeEntry({ type: 'class', name: 'bad' }),
      ],
    });
    const c = compile(r);
    expect(c.excludes).toHaveLength(2);
    expect(c.reveals).toHaveLength(1);
    expect(c.includeSelector).toBe('button');
  });

  it('joins multiple CSS includes into a single selector', () => {
    const r = rule({
      entries: [includeEntry('[data-clickable]'), includeEntry('.widget')],
    });
    expect(compile(r).includeSelector).toBe('[data-clickable], .widget');
  });

  it('drops invalid include selectors but keeps valid siblings', () => {
    const r = rule({
      entries: [includeEntry('button'), includeEntry('!!nope!!')],
    });
    expect(compile(r).includeSelector).toBe('button');
  });

  it('drops invalid exclude CSS selectors so they don\'t throw per-element at scan time', () => {
    const r = rule({
      entries: [
        excludeEntry({ type: 'css', selector: '[unclosed' }),
        excludeEntry({ type: 'css', selector: 'button.kept' }),
        excludeEntry({ type: 'class', name: 'still-here' }),
      ],
    });
    const c = compile(r);
    expect(c.excludes).toHaveLength(2);
    expect((c.excludes[0].matcher as { selector: string }).selector).toBe('button.kept');
    expect(c.excludes[1].matcher.type).toBe('class');
  });

  it('returns null includeSelector when there are no valid includes', () => {
    const r = rule({ entries: [excludeEntry({ type: 'css', selector: 'a' })] });
    expect(compile(r).includeSelector).toBeNull();
  });

  it('ignores non-CSS include matchers (v1 is CSS-only for includes)', () => {
    const r = rule({
      entries: [
        { id: rid(), kind: 'include', matcher: { type: 'text', value: 'X', caseSensitive: false } },
      ],
    });
    expect(compile(r).includeSelector).toBeNull();
  });

  it('records the matched rule set on the compiled result', () => {
    const a = rule({ id: 'a' });
    const b = rule({ id: 'b' });
    expect(compile(a, b).rules).toEqual([a, b]);
  });
});

describe('compileRules — merge across the matched set', () => {
  it('unions excludes from every rule', () => {
    const general = rule({
      id: 'gen',
      entries: [excludeEntry({ type: 'text', value: 'Delete', caseSensitive: false })],
    });
    const specific = rule({
      id: 'spec',
      entries: [excludeEntry({ type: 'css', selector: 'button.freeze-ops' })],
    });
    const c = compile(general, specific);
    expect(c.excludes).toHaveLength(2);
  });

  it('unions reveals from every rule', () => {
    const a = rule({ id: 'a', entries: [revealEntry('.gear-a', 'opacity')] });
    const b = rule({ id: 'b', entries: [revealEntry('.gear-b', 'visibility')] });
    expect(compile(a, b).reveals).toHaveLength(2);
  });

  it('joins include selectors across rules into one selector', () => {
    const a = rule({ id: 'a', entries: [includeEntry('[data-a]')] });
    const b = rule({ id: 'b', entries: [includeEntry('.widget-b')] });
    expect(compile(a, b).includeSelector).toBe('[data-a], .widget-b');
  });

  it('merge is order-independent for the resulting exclude set', () => {
    const a = rule({ id: 'a', entries: [excludeEntry({ type: 'class', name: 'x' })] });
    const b = rule({ id: 'b', entries: [excludeEntry({ type: 'class', name: 'y' })] });

    document.body.innerHTML = `<button class="x">A</button><button class="y">B</button><button>C</button>`;
    const run = (rules: DomainRule[]): string[] => {
      const refs = Array.from(document.querySelectorAll('button'));
      const elements = refs.map(() => scanned());
      applyExclusions(refs, elements, compileRules(rules).excludes);
      return refs.map(e => e.textContent || '');
    };
    expect(run([a, b])).toEqual(['C']);
    expect(run([b, a])).toEqual(['C']);
  });

  it('skips entries that are switched off (enabled: false)', () => {
    const r = rule({
      entries: [
        { ...excludeEntry({ type: 'css', selector: 'a' }), enabled: false },
        excludeEntry({ type: 'css', selector: 'b' }),
        { ...revealEntry('.gear', 'opacity'), enabled: false },
        { ...includeEntry('[data-x]'), enabled: false },
      ],
    });
    const c = compile(r);
    expect(c.excludes).toHaveLength(1);
    expect((c.excludes[0].matcher as { selector: string }).selector).toBe('b');
    expect(c.reveals).toHaveLength(0);
    expect(c.includeSelector).toBeNull();
  });

  it('treats absent or true enabled as applied', () => {
    const r = rule({
      entries: [
        excludeEntry({ type: 'css', selector: 'a' }),                    // absent → on
        { ...excludeEntry({ type: 'css', selector: 'b' }), enabled: true },
      ],
    });
    expect(compile(r).excludes).toHaveLength(2);
  });

  it('compiles an empty matched set to an inert rule', () => {
    const c = compileRules([]);
    expect(c.rules).toEqual([]);
    expect(c.excludes).toHaveLength(0);
    expect(c.reveals).toHaveLength(0);
    expect(c.includeSelector).toBeNull();
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
    const { excludes } = compile(rule({
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
    const { excludes } = compile(rule({
      entries: [excludeEntry({ type: 'text', value: 'Delete', caseSensitive: false })],
    }));

    applyExclusions(refs, elements, excludes);

    expect(refs.map(e => e.textContent)).toEqual(['Home', 'About']);
  });

  it('text matcher respects caseSensitive: true', () => {
    document.body.innerHTML = `<a>Delete</a><a>delete</a>`;
    const refs = Array.from(document.querySelectorAll('a'));
    const elements = refs.map(r => scanned(r.textContent || ''));
    const { excludes } = compile(rule({
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
    const { excludes } = compile(rule({
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
    const { excludes } = compile(rule({
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
    const { excludes } = compile(rule({
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
    const { excludes } = compile(rule({
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
    const { excludes } = compile(rule({
      entries: [excludeEntry({ type: 'css', selector: '!!not a selector!!' })],
    }));

    expect(() => applyExclusions(refs, elements, excludes)).not.toThrow();
    expect(refs).toHaveLength(1);
  });
});

describe('text matcher modes (exact vs contains)', () => {
  function textExcludes(
    value: string,
    mode: 'exact' | 'contains' | undefined,
    caseSensitive = false,
  ): RuleEntry[] {
    const matcher: RuleEntry['matcher'] = mode
      ? { type: 'text', value, caseSensitive, mode }
      : { type: 'text', value, caseSensitive };
    return [...compile(rule({ entries: [{ id: rid(), kind: 'exclude', matcher }] })).excludes];
  }

  it('contains matches a substring (case-insensitive default)', () => {
    document.body.innerHTML = `<button>Delete all items</button>`;
    const el = document.querySelector('button')!;
    expect(isExcludedByRule(el, textExcludes('delete', 'contains'))).toBe(true);
  });

  it('contains does not match when the needle is absent', () => {
    document.body.innerHTML = `<button>Save changes</button>`;
    const el = document.querySelector('button')!;
    expect(isExcludedByRule(el, textExcludes('delete', 'contains'))).toBe(false);
  });

  it('contains respects caseSensitive', () => {
    document.body.innerHTML = `<button>DELETE row</button>`;
    const el = document.querySelector('button')!;
    expect(isExcludedByRule(el, textExcludes('delete', 'contains', true))).toBe(false);
    expect(isExcludedByRule(el, textExcludes('DELETE', 'contains', true))).toBe(true);
  });

  it('exact requires the whole trimmed text to match', () => {
    document.body.innerHTML = `<button>Delete all</button><button>Delete</button>`;
    const [a, b] = document.querySelectorAll('button');
    const excludes = textExcludes('Delete', 'exact');
    expect(isExcludedByRule(a, excludes)).toBe(false);
    expect(isExcludedByRule(b, excludes)).toBe(true);
  });

  it('treats an absent mode as exact (back-compat with pre-mode rules)', () => {
    document.body.innerHTML = `<button>Delete all</button><button>Delete</button>`;
    const [a, b] = document.querySelectorAll('button');
    const excludes = textExcludes('Delete', undefined);
    expect(isExcludedByRule(a, excludes)).toBe(false);
    expect(isExcludedByRule(b, excludes)).toBe(true);
  });
});

describe('collectInclusions', () => {
  it('collects elements matching CSS include selectors', () => {
    document.body.innerHTML = `
      <div data-clickable id="a">A</div>
      <div data-clickable id="b">B</div>
      <div id="c">C</div>
    `;
    const { includeSelector } = compile(rule({
      entries: [includeEntry('[data-clickable]')],
    }));

    const out = collectInclusions(new Set(), includeSelector);

    expect(out.refs.map(e => e.id)).toEqual(['a', 'b']);
    expect(out.elements).toHaveLength(2);
    expect(out.elements[0].type).toBe('div');
  });

  it('skips elements already in the seen set', () => {
    document.body.innerHTML = `<div data-x id="a"></div><div data-x id="b"></div>`;
    const { includeSelector } = compile(rule({
      entries: [includeEntry('[data-x]')],
    }));
    const seen = new Set<Element>([document.getElementById('a')!]);

    const out = collectInclusions(seen, includeSelector);

    expect(out.refs).toHaveLength(1);
    expect(out.refs[0].id).toBe('b');
  });

  it('dedupes elements matched by multiple include selectors', () => {
    document.body.innerHTML = `<div data-x class="y" id="a"></div>`;
    const { includeSelector } = compile(rule({
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
    const { includeSelector } = compile(rule({
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
    const { excludes } = compile(rule({
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
    const { excludes } = compile(rule({
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
    const { reveals } = compile(rule({
      entries: [excludeEntry({ type: 'css', selector: 'a' })],
    }));
    expect(injectRevealStyles(reveals)).toBeNull();
  });

  it('builds an opacity rule from a reveal entry', () => {
    const { reveals } = compile(rule({
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
    const { reveals } = compile(rule({
      entries: [revealEntry('.hidden', 'visibility')],
    }));
    const style = injectRevealStyles(reveals)!;

    expect(style.textContent).toContain('.hidden');
    expect(style.textContent).toContain('visibility: visible !important');
  });

  it('omits display reveals (deferred to v2)', () => {
    const { reveals } = compile(rule({
      entries: [revealEntry('.foo', 'display')],
    }));
    expect(injectRevealStyles(reveals)).toBeNull();
  });

  it('joins multiple reveal rules with newlines', () => {
    const { reveals } = compile(rule({
      entries: [revealEntry('.a', 'opacity'), revealEntry('.b', 'visibility')],
    }));
    const style = injectRevealStyles(reveals)!;

    expect(style.textContent).toContain('.a');
    expect(style.textContent).toContain('.b');
    expect(style.textContent!.split('\n').length).toBe(2);
  });

  it('drops display entries but keeps mixed opacity/visibility ones', () => {
    const { reveals } = compile(rule({
      entries: [revealEntry('.dropped', 'display'), revealEntry('.kept', 'opacity')],
    }));
    const style = injectRevealStyles(reveals)!;

    expect(style.textContent).not.toContain('.dropped');
    expect(style.textContent).toContain('.kept');
  });
});

describe('nudge entries — compile + resolve', () => {
  function nudgeEntry(selector: string, dx: number, dy: number): RuleEntry {
    return {
      id: rid(),
      kind: 'nudge',
      matcher: { type: 'css', selector },
      nudge: { dx, dy },
    };
  }

  it('compileRules buckets nudge entries and validates CSS selectors', () => {
    const compiled = compile(rule({
      entries: [
        nudgeEntry('.sidebar a', 20, 0),
        nudgeEntry(':::garbage', 5, 5),          // invalid selector dropped
        { id: rid(), kind: 'nudge', matcher: { type: 'css', selector: '.x' } }, // no nudge payload dropped
        excludeEntry({ type: 'css', selector: '.gone' }),
      ],
    }));
    expect(compiled.nudges).toHaveLength(1);
    expect(compiled.nudges[0].nudge).toEqual({ dx: 20, dy: 0 });
    expect(compiled.excludes).toHaveLength(1);
  });

  it('disabled nudge entries are skipped', () => {
    const compiled = compile(rule({
      entries: [{ ...nudgeEntry('.a', 1, 2), enabled: false }],
    }));
    expect(compiled.nudges).toHaveLength(0);
  });

  it('resolveNudgeOffset returns the first matching entry in declaration order', () => {
    document.body.innerHTML = '<a class="row special" id="t">x</a>';
    const el = document.getElementById('t')!;
    const offset = resolveNudgeOffset(el, [
      nudgeEntry('.nomatch', 1, 1),
      nudgeEntry('.row', 10, -5),
      nudgeEntry('.special', 99, 99),  // also matches, but later
    ]);
    expect(offset).toEqual({ dx: 10, dy: -5 });
  });

  it('resolveNudgeOffset returns null when nothing matches', () => {
    document.body.innerHTML = '<a id="t">x</a>';
    expect(resolveNudgeOffset(document.getElementById('t')!, [
      nudgeEntry('.nomatch', 1, 1),
    ])).toBeNull();
  });

  it('resolveNudgeOffset supports text matchers', () => {
    document.body.innerHTML = '<button id="t">Save changes</button>';
    const entry: RuleEntry = {
      id: rid(),
      kind: 'nudge',
      matcher: { type: 'text', value: 'save', caseSensitive: false, mode: 'contains' },
      nudge: { dx: 0, dy: 14 },
    };
    expect(resolveNudgeOffset(document.getElementById('t')!, [entry]))
      .toEqual({ dx: 0, dy: 14 });
  });
});

describe('badge size override — compileRules resolution', () => {
  it('resolves to null when no matched rule sets badgeSizePx', () => {
    expect(compile(rule()).badgeSizePx).toBeNull();
    expect(compileRules([]).badgeSizePx).toBeNull();
  });

  it('picks the one rule that sets it', () => {
    const compiled = compile(rule(), rule({ id: 'r2', badgeSizePx: 18 }));
    expect(compiled.badgeSizePx).toBe(18);
  });

  it('exact-host rule beats a *. wildcard, in either declaration order', () => {
    const wild = rule({ id: 'rw', pattern: '*.quickbase.com', badgeSizePx: 10 });
    const exact = rule({ id: 're', pattern: 'data.quickbase.com', badgeSizePx: 20 });
    expect(compile(wild, exact).badgeSizePx).toBe(20);
    expect(compile(exact, wild).badgeSizePx).toBe(20);
  });

  it('host+path patterns count as exact (they beat wildcards)', () => {
    const wild = rule({ id: 'rw', pattern: '*.example.com', badgeSizePx: 10 });
    const path = rule({ id: 'rp', pattern: 'example.com/app/*', badgeSizePx: 16 });
    expect(compile(wild, path).badgeSizePx).toBe(16);
  });

  it('ties at equal specificity keep declaration order (first wins)', () => {
    const a = rule({ id: 'ra', pattern: 'example.com', badgeSizePx: 12 });
    const b = rule({ id: 'rb', pattern: 'example.com/x', badgeSizePx: 22 });
    expect(compile(a, b).badgeSizePx).toBe(12);
    const w1 = rule({ id: 'w1', pattern: '*.example.com', badgeSizePx: 9 });
    const w2 = rule({ id: 'w2', pattern: '*.example.com', badgeSizePx: 25 });
    expect(compile(w1, w2).badgeSizePx).toBe(9);
  });

  it('a wildcard override still applies when the exact rule sets no size', () => {
    const wild = rule({ id: 'rw', pattern: '*.quickbase.com', badgeSizePx: 10 });
    const exact = rule({ id: 're', pattern: 'data.quickbase.com' });
    expect(compile(exact, wild).badgeSizePx).toBe(10);
  });

  it('ignores non-finite and non-positive values', () => {
    expect(compile(rule({ badgeSizePx: NaN })).badgeSizePx).toBeNull();
    expect(compile(rule({ badgeSizePx: 0 })).badgeSizePx).toBeNull();
    expect(compile(rule({ badgeSizePx: -4 })).badgeSizePx).toBeNull();
    expect(compile(rule({ badgeSizePx: Infinity })).badgeSizePx).toBeNull();
  });
});
