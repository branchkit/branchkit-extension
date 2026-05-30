/**
 * BranchKit Browser — Domain rules persistence.
 *
 * One source of truth for the `chrome.storage.sync.domainRules` key.
 * Content script, popup, and options page all use these helpers
 * instead of hand-rolling get/set against the literal key.
 */

import type { DomainRule, DomainRules } from './domain-rules';

const STORAGE_KEY = 'domainRules';

export async function loadDomainRules(): Promise<DomainRule[]> {
  const result = await chrome.storage.sync.get(STORAGE_KEY);
  const stored = result[STORAGE_KEY] as DomainRules | undefined;
  return stored?.rules ?? [];
}

export function saveDomainRules(rules: DomainRule[]): void {
  const data: DomainRules = { rules };
  chrome.storage.sync.set({ [STORAGE_KEY]: data });
}

/**
 * Subscribe to changes in the `domainRules` storage key. The callback
 * fires on writes from this script and from other contexts (other tabs,
 * other browsers via sync). Callers that want to skip self-originated
 * echoes compare via `rulesEqual` before reacting.
 */
export function onDomainRulesChanged(cb: (rules: DomainRule[]) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>): void => {
    if (!changes[STORAGE_KEY]) return;
    const next = changes[STORAGE_KEY].newValue as DomainRules | undefined;
    cb(next?.rules ?? []);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/**
 * Structural equality on a single rule (or null). JSON-based — cheap
 * for small payloads; key order is stable across writes because we
 * always construct rule objects via the same field order.
 */
export function ruleEqual(a: DomainRule | null, b: DomainRule | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Structural equality on a list of rules. */
export function rulesEqual(a: DomainRule[], b: DomainRule[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
