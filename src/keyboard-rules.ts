/**
 * Per-site keyboard rules — pattern-based, the input-routing companion to the
 * element-level domain (hint) rules. Each rule targets a URL pattern
 * (`*.wikipedia.org`, `mail.google.com`) and carries:
 *   - `off`: disable ALL of BranchKit's keys on match (hand the keyboard to the
 *     page), and/or
 *   - `passKeys`: pass just these characters to the page while the rest of
 *     BranchKit's binds keep working (the Gmail case — `jke#`).
 * Voice is always unaffected.
 *
 * Reuses the domain-rule glob matcher (`urlMatchesPattern`), so patterns behave
 * exactly like hint rules. The effective policy for a page is the UNION of all
 * matching rules. Managed from the popup (quick, current-site) and the options
 * page (full, per-pattern). See notes/DESIGN_PASS_THROUGH.md.
 */

import { urlMatchesPattern } from './rules/domain-rules';

export interface KeyboardRule {
  pattern: string;
  off?: boolean;
  /** Characters to hand to the page (each character is one key, matched on
   *  `event.key`). Stored raw; spaces are ignored when applied. */
  passKeys?: string;
}

const KEY = 'keyboardRules';
const OLD_EXCLUSIONS = 'keyExclusions';
const OLD_PASSTHROUGH = 'keyPassthrough';

function normalizeRules(v: unknown): KeyboardRule[] {
  if (!Array.isArray(v)) return [];
  const out: KeyboardRule[] = [];
  for (const r of v) {
    if (!r || typeof r !== 'object') continue;
    const rec = r as Record<string, unknown>;
    if (typeof rec.pattern !== 'string' || !rec.pattern) continue;
    const rule: KeyboardRule = { pattern: rec.pattern };
    if (rec.off === true) rule.off = true;
    if (typeof rec.passKeys === 'string' && rec.passKeys) rule.passKeys = rec.passKeys;
    if (rule.off || rule.passKeys) out.push(rule); // drop empty rules
  }
  return out;
}

/** One-time conversion of the earlier exact-host model into pattern rules. */
function migrateOld(exclusions: unknown, passthrough: unknown): KeyboardRule[] {
  const byPattern = new Map<string, KeyboardRule>();
  if (Array.isArray(exclusions)) {
    for (const h of exclusions) {
      if (typeof h === 'string' && h) byPattern.set(h, { ...(byPattern.get(h) ?? { pattern: h }), off: true });
    }
  }
  if (passthrough && typeof passthrough === 'object') {
    for (const [h, chars] of Object.entries(passthrough as Record<string, unknown>)) {
      if (!h) continue;
      const keys = Array.isArray(chars) ? chars.filter((c) => typeof c === 'string').join('') : '';
      if (!keys) continue;
      byPattern.set(h, { ...(byPattern.get(h) ?? { pattern: h }), passKeys: keys });
    }
  }
  return Array.from(byPattern.values());
}

export async function loadKeyboardRules(): Promise<KeyboardRule[]> {
  if (typeof chrome === 'undefined' || !chrome.storage?.sync) return [];
  const r = await chrome.storage.sync.get([KEY, OLD_EXCLUSIONS, OLD_PASSTHROUGH]);
  if (Array.isArray(r[KEY])) return normalizeRules(r[KEY]);
  const migrated = migrateOld(r[OLD_EXCLUSIONS], r[OLD_PASSTHROUGH]);
  if (migrated.length) {
    await chrome.storage.sync.set({ [KEY]: migrated });
    await chrome.storage.sync.remove([OLD_EXCLUSIONS, OLD_PASSTHROUGH]);
  }
  return migrated;
}

export async function saveKeyboardRules(rules: KeyboardRule[]): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.sync) return;
  await chrome.storage.sync.set({ [KEY]: normalizeRules(rules) });
}

function safeMatch(url: string, pattern: string): boolean {
  try { return urlMatchesPattern(url, pattern); } catch { return false; }
}

/** Effective keyboard policy for a page URL: the union of matching rules. */
export async function getSiteKeyState(url: string): Promise<{ excluded: boolean; passKeys: string[] }> {
  const matching = (await loadKeyboardRules()).filter((r) => safeMatch(url, r.pattern));
  const excluded = matching.some((r) => r.off);
  const chars = new Set<string>();
  for (const r of matching) for (const c of r.passKeys ?? '') if (c.trim() !== '') chars.add(c);
  return { excluded, passKeys: Array.from(chars) };
}

// --- Popup convenience: the rule for a single pattern (the current site) ---

export async function getRuleForPattern(pattern: string): Promise<KeyboardRule | null> {
  if (!pattern) return null;
  return (await loadKeyboardRules()).find((r) => r.pattern === pattern) ?? null;
}

async function upsertRule(pattern: string, mut: (r: KeyboardRule) => void): Promise<void> {
  if (!pattern) return;
  const rules = await loadKeyboardRules();
  let rule = rules.find((r) => r.pattern === pattern);
  if (!rule) { rule = { pattern }; rules.push(rule); }
  mut(rule);
  await saveKeyboardRules(rules); // saveKeyboardRules drops now-empty rules
}

export async function setRuleOff(pattern: string, off: boolean): Promise<void> {
  await upsertRule(pattern, (r) => { if (off) r.off = true; else delete r.off; });
}

export async function setRulePassKeys(pattern: string, keys: string): Promise<void> {
  const clean = Array.from(keys).filter((c) => c.trim() !== '').join('');
  await upsertRule(pattern, (r) => { if (clean) r.passKeys = clean; else delete r.passKeys; });
}

/** Subscribe to any change in the keyboard rules. Returns an unsubscribe. */
export function onSiteKeysChanged(cb: () => void): () => void {
  if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) return () => {};
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ): void => {
    if (area === 'sync' && (changes[KEY] || changes[OLD_EXCLUSIONS] || changes[OLD_PASSTHROUGH])) cb();
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
