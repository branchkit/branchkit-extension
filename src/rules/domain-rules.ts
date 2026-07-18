/**
 * BranchKit Browser — Per-domain hint rules.
 *
 * Pure rule evaluation: pattern matching against URLs, filtering scanned
 * elements by exclude entries, querying the DOM for include entries, and
 * building a <style> element for reveal entries.
 *
 * Design: notes/completed/DESIGN_PER_DOMAIN_HINT_RULES.md.
 */

import { ScannedElement } from '../types';
import { classifyCategory } from '../scan/scanner';

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
  kind: 'exclude' | 'include' | 'reveal' | 'nudge';
  matcher: Matcher;
  reveal?: RevealMethod;
  /** Pixel offset applied to matched elements' badges after placement.
   *  Present iff kind === 'nudge'. */
  nudge?: NudgeOffset;
  label?: string;
  /** Absent or true = applied. false = kept in the rule but not applied. */
  enabled?: boolean;
}

export interface NudgeOffset {
  dx: number;
  dy: number;
}

export type RevealMethod = 'opacity' | 'visibility' | 'display';

export type Matcher =
  | { type: 'css'; selector: string }
  | { type: 'text'; value: string; caseSensitive: boolean; mode?: TextMatchMode }
  | { type: 'class'; name: string };

/**
 * How a text matcher compares against an element's trimmed text.
 * `contains` (substring) is the UI default for new entries — real
 * Delete/Save buttons often carry icon text or whitespace that exact
 * equality would miss. Absent `mode` is treated as `exact` so any rule
 * authored before this field existed keeps its original behavior.
 */
export type TextMatchMode = 'exact' | 'contains';

/**
 * The matched rule set pre-split into per-kind buckets and a single
 * joined include selector. Producer is `compileRules`; consumed by
 * scan-time helpers so the hot path doesn't re-filter entries on every
 * call. Build once per rule change, reuse on every doScan / MO callback.
 *
 * Holds the UNION of every rule matching the frame's URL — see
 * "Cascade Semantics" in the design doc.
 */
export interface CompiledRule {
  /** The matched rules, in declaration order. Used only for change detection. */
  rules: DomainRule[];
  excludes: readonly RuleEntry[];
  reveals: readonly RuleEntry[];
  nudges: readonly RuleEntry[];
  /** Joined CSS selector for all valid include entries, or null. */
  includeSelector: string | null;
}

// --- Pattern matching ---

/**
 * Every enabled rule matching this URL, in declaration order. Patterns:
 *   *.example.com       → any subdomain (not bare host)
 *   example.com         → exact hostname
 *   example.com/path/*  → hostname + path prefix
 *
 * Multiple rules can match (e.g. a general `*.quickbase.com` and a
 * specific `acme.quickbase.com`); the caller merges them via
 * `compileRules`. See "Cascade Semantics" in the design doc.
 */
export function matchRules(url: string, rules: DomainRule[]): DomainRule[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  const host = parsed.hostname;
  const hostPath = host + parsed.pathname;

  const matched: DomainRule[] = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (matchesPattern(rule.pattern, host, hostPath)) matched.push(rule);
  }
  return matched;
}

/**
 * Does a single pattern match this URL? Ignores the enabled flag — the
 * options page uses it to light up the "matches current tab" indicator
 * on every rule row, enabled or not.
 */
export function urlMatchesPattern(url: string, pattern: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return matchesPattern(pattern, parsed.hostname, parsed.hostname + parsed.pathname);
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
 * Merge the matched rule set into one CompiledRule: bucket every rule's
 * entries by kind, validate CSS selectors, and join the valid include
 * selectors into a single string. Validating up-front lets
 * `collectInclusions` use one querySelectorAll instead of N and keeps
 * invalid exclude/include selectors from throwing on every element
 * checked.
 *
 * The merge is a pure union (excludes/reveals concatenate, includes
 * join) — order-independent, no precedence to resolve. Passing a single
 * rule is just the one-element case.
 */
export function compileRules(matched: DomainRule[]): CompiledRule {
  const excludes: RuleEntry[] = [];
  const reveals: RuleEntry[] = [];
  const nudges: RuleEntry[] = [];
  const includeSelectors: string[] = [];

  for (const rule of matched) {
    for (const entry of rule.entries) {
      if (entry.enabled === false) continue;  // kept but switched off
      if (entry.kind === 'exclude') {
        if (entry.matcher.type === 'css' && !isValidCSSSelector(entry.matcher.selector)) continue;
        excludes.push(entry);
      } else if (entry.kind === 'reveal') {
        reveals.push(entry);
      } else if (entry.kind === 'nudge') {
        if (!entry.nudge) continue;
        if (entry.matcher.type === 'css' && !isValidCSSSelector(entry.matcher.selector)) continue;
        nudges.push(entry);
      } else if (entry.kind === 'include' && entry.matcher.type === 'css') {
        if (isValidCSSSelector(entry.matcher.selector)) {
          includeSelectors.push(entry.matcher.selector);
        }
      }
    }
  }

  return {
    rules: matched,
    excludes,
    reveals,
    nudges,
    includeSelector: includeSelectors.length > 0 ? includeSelectors.join(', ') : null,
  };
}

function isValidCSSSelector(selector: string): boolean {
  try {
    document.querySelector(selector);
    return true;
  } catch {
    return false;
  }
}

// --- Exclusions ---

/**
 * Remove elements matching any exclude entry. Mutates `refs` and
 * `elements` in place, keeping them in sync (same indices).
 *
 * Safe to call on a per-batch slice (10-20 elements) — the function is
 * array-shape-agnostic. The per-batch doScan path (Option B, see
 * notes/DESIGN_HINT_PIPELINE_RESYNC.md item 15) calls this on every
 * scanInBatches yield rather than running it across the whole scan.
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
      const contains = matcher.mode === 'contains';
      if (matcher.caseSensitive) {
        return contains ? text.includes(matcher.value) : text === matcher.value;
      }
      const haystack = text.toLowerCase();
      const needle = matcher.value.toLowerCase();
      return contains ? haystack.includes(needle) : haystack === needle;
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

// --- Nudges ---

/**
 * Resolve the badge position offset for an element from the rule's nudge
 * entries. First matching entry in declaration order wins — nudges are
 * site-specific point fixes, so stacking them would be surprising.
 * Returns null when nothing matches. Callers cache the result per wrapper
 * (see ElementWrapper.cachedRuleNudge) — this must not run per scroll frame.
 */
export function resolveNudgeOffset(
  el: Element,
  nudges: readonly RuleEntry[],
): NudgeOffset | null {
  for (const entry of nudges) {
    if (entry.nudge && matchesMatcher(el, entry.matcher)) return entry.nudge;
  }
  return null;
}

// --- Inclusions ---

/**
 * Query the DOM for the rule's joined include selector and return any
 * elements not already in `seen`. `root` is the document by default;
 * MutationObserver subtree callers pass the subtree root.
 *
 * Per-batch doScan callers (Option B) call this **once per scan**, not
 * per batch — N querySelectorAll calls across batches would be wasteful
 * (item 15). The returned refs are then fed into `scanInBatches`'s
 * `initialSeen` so the regular walk doesn't rediscover them.
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
