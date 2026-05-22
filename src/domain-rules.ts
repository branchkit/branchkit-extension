/**
 * BranchKit Browser — Per-domain hint rules.
 *
 * Pure rule evaluation: pattern matching against URLs, filtering scanned
 * elements by exclude entries, querying the DOM for include entries, and
 * building a <style> element for reveal entries.
 *
 * Design: notes/DESIGN_PER_DOMAIN_HINT_RULES.md.
 */

import { ScannedElement } from './types';
import { classifyCategory } from './scanner';

// --- Types ---

export interface DomainRules {
  rules: DomainRule[];
}

export interface DomainRule {
  id: string;
  pattern: string;
  enabled: boolean;
  entries: RuleEntry[];
}

export interface RuleEntry {
  id: string;
  kind: 'exclude' | 'include' | 'reveal';
  matcher: Matcher;
  reveal?: RevealMethod;
  label?: string;
}

export type RevealMethod = 'opacity' | 'visibility' | 'display';

export type Matcher =
  | { type: 'css'; selector: string }
  | { type: 'text'; value: string; caseSensitive: boolean }
  | { type: 'class'; name: string };

/**
 * Rule pre-split into per-kind buckets and a single joined include
 * selector. Producer is `compileRule`; consumed by scan-time helpers so
 * the hot path doesn't re-filter entries on every call. Build once per
 * rule change, reuse on every doScan / MO callback.
 */
export interface CompiledRule {
  rule: DomainRule;
  excludes: readonly RuleEntry[];
  reveals: readonly RuleEntry[];
  /** Joined CSS selector for all valid include entries, or null. */
  includeSelector: string | null;
}

// --- Pattern matching ---

/**
 * Find the first enabled rule matching this URL. Patterns:
 *   *.example.com       → any subdomain (not bare host)
 *   example.com         → exact hostname
 *   example.com/path/*  → hostname + path prefix
 */
export function matchRule(url: string, rules: DomainRule[]): DomainRule | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname;
  const hostPath = host + parsed.pathname;

  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (matchesPattern(rule.pattern, host, hostPath)) return rule;
  }
  return null;
}

function matchesPattern(pattern: string, host: string, hostPath: string): boolean {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2);
    return host !== suffix && host.endsWith('.' + suffix);
  }

  const slashIdx = pattern.indexOf('/');
  if (slashIdx !== -1) {
    const patternHost = pattern.slice(0, slashIdx);
    const patternPath = pattern.slice(slashIdx);
    if (host !== patternHost) return false;
    if (patternPath.endsWith('/*')) {
      const prefix = patternPath.slice(0, -1); // keep trailing slash
      return hostPath.startsWith(host + prefix);
    }
    return hostPath === host + patternPath;
  }

  return host === pattern;
}

// --- Compile ---

/**
 * Bucket a rule's entries by kind, validate include CSS selectors, and
 * join the valid ones into a single selector string. Validating up-front
 * means the runtime `collectInclusions` can use one querySelectorAll
 * call instead of N, and a single broken selector won't kill the lot.
 */
export function compileRule(rule: DomainRule): CompiledRule {
  const excludes: RuleEntry[] = [];
  const reveals: RuleEntry[] = [];
  const includeSelectors: string[] = [];

  for (const entry of rule.entries) {
    if (entry.kind === 'exclude') {
      excludes.push(entry);
    } else if (entry.kind === 'reveal') {
      reveals.push(entry);
    } else if (entry.kind === 'include' && entry.matcher.type === 'css') {
      try {
        document.querySelector(entry.matcher.selector);
        includeSelectors.push(entry.matcher.selector);
      } catch {
        // Broken include selector — drop it. Other entries keep working.
      }
    }
  }

  return {
    rule,
    excludes,
    reveals,
    includeSelector: includeSelectors.length > 0 ? includeSelectors.join(', ') : null,
  };
}

// --- Exclusions ---

/**
 * Remove elements matching any exclude entry. Mutates `refs` and
 * `elements` in place, keeping them in sync (same indices).
 */
export function applyExclusions(
  refs: Element[],
  elements: ScannedElement[],
  excludes: readonly RuleEntry[],
): void {
  if (excludes.length === 0) return;
  for (let i = refs.length - 1; i >= 0; i--) {
    if (matchesAnyExclude(refs[i], excludes)) {
      refs.splice(i, 1);
      elements.splice(i, 1);
    }
  }
}

function matchesAnyExclude(el: Element, excludes: readonly RuleEntry[]): boolean {
  for (const entry of excludes) {
    if (matchesMatcher(el, entry.matcher)) return true;
  }
  return false;
}

function matchesMatcher(el: Element, matcher: Matcher): boolean {
  switch (matcher.type) {
    case 'css':
      try {
        return el.matches(matcher.selector);
      } catch {
        return false;
      }
    case 'text': {
      const text = el.textContent?.trim() ?? '';
      if (matcher.caseSensitive) return text === matcher.value;
      return text.toLowerCase() === matcher.value.toLowerCase();
    }
    case 'class':
      return el.classList.contains(matcher.name);
  }
}

/**
 * Single-element exclusion check. Used by MutationObserver paths so
 * freshly-inserted elements are filtered consistently with
 * `applyExclusions`.
 */
export function isExcludedByRule(el: Element, excludes: readonly RuleEntry[]): boolean {
  return matchesAnyExclude(el, excludes);
}

// --- Inclusions ---

/**
 * Query the DOM for the rule's joined include selector and return any
 * elements not already in `seen`. `root` is the document by default;
 * MutationObserver subtree callers pass the subtree root.
 */
export function collectInclusions(
  seen: Set<Element>,
  includeSelector: string | null,
  root: ParentNode = document,
): { refs: Element[]; elements: ScannedElement[] } {
  const refs: Element[] = [];
  const elements: ScannedElement[] = [];
  if (!includeSelector) return { refs, elements };

  let matches: NodeListOf<Element>;
  try {
    matches = root.querySelectorAll(includeSelector);
  } catch {
    return { refs, elements };
  }

  for (const el of matches) {
    if (seen.has(el)) continue;
    seen.add(el);
    refs.push(el);
    elements.push({
      label: el.textContent?.trim() ?? '',
      id: 0,
      category: classifyCategory(el),
      type: el.tagName.toLowerCase(),
      adapter: null,
      codeword: '',
    });
  }
  return { refs, elements };
}

// --- Reveal styles ---

/**
 * Build a `<style data-branchkit-reveal>` element from the rule's reveal
 * entries. Returns null if there are no usable reveal entries.
 *
 * v1 only emits `opacity` and `visibility` — `display` is deferred to v2
 * because reverting `display: none` can cause layout shifts.
 */
export function injectRevealStyles(reveals: readonly RuleEntry[]): HTMLStyleElement | null {
  if (reveals.length === 0) return null;

  const rules: string[] = [];
  for (const entry of reveals) {
    if (entry.matcher.type !== 'css') continue;
    const decl = revealDeclaration(entry.reveal);
    if (!decl) continue;
    rules.push(`${entry.matcher.selector} { ${decl} }`);
  }
  if (rules.length === 0) return null;

  const style = document.createElement('style');
  style.setAttribute('data-branchkit-reveal', '');
  style.textContent = rules.join('\n');
  return style;
}

function revealDeclaration(method: RevealMethod | undefined): string | null {
  switch (method) {
    case 'opacity':
      return 'opacity: 1 !important;';
    case 'visibility':
      return 'visibility: visible !important;';
    case 'display':
    default:
      // `display` deferred to v2 — reverting `display: none` causes layout shifts.
      return null;
  }
}
