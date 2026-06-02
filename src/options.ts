/**
 * BranchKit Browser — Options page logic.
 *
 * Vanilla JS cross-site rule editor. Pattern editing with live
 * "matches current tab" indicator, all matcher types (CSS / text /
 * class), and a per-rule tab-picker for codeword resolve. Storage
 * and message-passing go through ./domain-rules-storage and ./rule-ui.
 */

import type {
  DomainRule,
  Matcher,
  RuleEntry,
  RevealMethod,
} from './rules/domain-rules';
import { matchRule } from './rules/domain-rules';
import {
  loadDomainRules,
  saveDomainRules,
  onDomainRulesChanged,
  rulesEqual,
} from './rules/domain-rules-storage';
import {
  suggestPattern,
  isValidSelector,
  validatePattern,
} from './rules/options-helpers';
import {
  KIND_META,
  matcherSummary,
  resolveCodewordFromTab,
  renderResolvePreview,
  setFeedbackError,
  clearFeedback,
} from './rules/rule-ui';
import {
  type BadgeSettings,
  DEFAULT_BADGE_SETTINGS,
  loadBadgeSettings,
  saveBadgeSettings,
  resetBadgeSettings,
  onBadgeSettingsChanged,
} from './badge-settings-storage';

// --- State ---

let rules: DomainRule[] = [];
let activeTabUrl: string | null = null;
const PATTERN_SAVE_DEBOUNCE_MS = 350;
const patternSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

const rulesEl = document.getElementById('rules') as HTMLDivElement;
const ruleTpl = document.getElementById('rule-template') as HTMLTemplateElement;
const entryTpl = document.getElementById('entry-template') as HTMLTemplateElement;

// --- Storage ---

async function load(): Promise<void> {
  rules = await loadDomainRules();
}

function save(): void {
  saveDomainRules(rules);
}

async function getActiveTabUrl(): Promise<string | null> {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      resolve(tabs[0]?.url ?? null);
    });
  });
}

function uuid(): string {
  return crypto.randomUUID();
}

// --- Rendering ---

function render(): void {
  rulesEl.replaceChildren();
  if (rules.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No rules yet. Add one to customize hints for a site.';
    rulesEl.appendChild(empty);
    return;
  }
  for (const rule of rules) {
    rulesEl.appendChild(renderRule(rule));
  }
}

function renderRule(rule: DomainRule): HTMLElement {
  const node = ruleTpl.content.firstElementChild!.cloneNode(true) as HTMLElement;
  node.dataset.ruleId = rule.id;
  if (!rule.enabled) node.classList.add('disabled');

  const patternInput = node.querySelector('.pattern-input') as HTMLInputElement;
  patternInput.value = rule.pattern;
  patternInput.addEventListener('input', () => onPatternInput(rule, patternInput, node));
  patternInput.addEventListener('blur', () => flushPatternSave(rule));

  const toggle = node.querySelector('.toggle') as HTMLInputElement;
  toggle.checked = rule.enabled;
  toggle.addEventListener('change', () => {
    rule.enabled = toggle.checked;
    node.classList.toggle('disabled', !rule.enabled);
    save();
    updateMatchDot(rule, node);
  });

  const deleteBtn = node.querySelector('.delete') as HTMLButtonElement;
  deleteBtn.addEventListener('click', () => {
    if (!confirm(`Delete rule "${rule.pattern || '(blank)'}"?`)) return;
    const pendingSave = patternSaveTimers.get(rule.id);
    if (pendingSave) {
      clearTimeout(pendingSave);
      patternSaveTimers.delete(rule.id);
    }
    rules = rules.filter(r => r.id !== rule.id);
    save();
    render();
  });

  const entriesEl = node.querySelector('.entries') as HTMLElement;
  renderEntries(rule, entriesEl);

  wireAddEntry(rule, node);
  wireResolvePanel(rule, node);
  updateMatchDot(rule, node);
  validatePatternUI(rule, patternInput, node);

  return node;
}

function renderEntries(rule: DomainRule, container: HTMLElement): void {
  container.replaceChildren();
  if (rule.entries.length === 0) {
    container.classList.add('empty');
    container.textContent = 'No entries — add one below.';
    return;
  }
  container.classList.remove('empty');
  for (const entry of rule.entries) {
    container.appendChild(renderEntry(rule, entry));
  }
}

function renderEntry(rule: DomainRule, entry: RuleEntry): HTMLElement {
  const node = entryTpl.content.firstElementChild!.cloneNode(true) as HTMLElement;

  const kindEl = node.querySelector('.entry-kind') as HTMLElement;
  kindEl.classList.add(entry.kind);
  kindEl.textContent = KIND_META[entry.kind].glyph;
  kindEl.title = entry.kind;

  const desc = node.querySelector('.entry-desc') as HTMLElement;
  if (entry.label) {
    const labelSpan = document.createElement('span');
    labelSpan.className = 'label-text';
    labelSpan.textContent = entry.label + ' —';
    desc.appendChild(labelSpan);
  }
  desc.appendChild(document.createTextNode(matcherSummary(entry.matcher)));
  if (entry.kind === 'reveal' && entry.reveal) {
    desc.appendChild(document.createTextNode(` (${entry.reveal})`));
  }

  const del = node.querySelector('.delete-entry') as HTMLButtonElement;
  del.addEventListener('click', () => {
    rule.entries = rule.entries.filter(e => e.id !== entry.id);
    save();
    const wrapper = del.closest('.rule')!;
    const entriesEl = wrapper.querySelector('.entries') as HTMLElement;
    renderEntries(rule, entriesEl);
  });

  return node;
}

// --- Pattern editing ---

function onPatternInput(rule: DomainRule, input: HTMLInputElement, ruleNode: HTMLElement): void {
  rule.pattern = input.value;
  validatePatternUI(rule, input, ruleNode);
  updateMatchDot(rule, ruleNode);

  const existing = patternSaveTimers.get(rule.id);
  if (existing) clearTimeout(existing);
  patternSaveTimers.set(
    rule.id,
    setTimeout(() => {
      patternSaveTimers.delete(rule.id);
      save();
    }, PATTERN_SAVE_DEBOUNCE_MS),
  );
}

function flushPatternSave(rule: DomainRule): void {
  const t = patternSaveTimers.get(rule.id);
  if (!t) return;
  clearTimeout(t);
  patternSaveTimers.delete(rule.id);
  save();
}

function validatePatternUI(rule: DomainRule, input: HTMLInputElement, ruleNode: HTMLElement): void {
  const err = validatePattern(rule.pattern);
  const errEl = ruleNode.querySelector('.pattern-error') as HTMLElement;
  if (err) {
    input.classList.add('invalid');
    errEl.textContent = err;
  } else {
    input.classList.remove('invalid');
    errEl.textContent = '';
  }
}

function updateMatchDot(rule: DomainRule, ruleNode: HTMLElement): void {
  const dot = ruleNode.querySelector('.match-dot') as HTMLElement;
  if (!activeTabUrl) {
    dot.classList.remove('match');
    dot.title = 'No active tab';
    return;
  }
  const matched = matchRule(activeTabUrl, [rule]) !== null;
  dot.classList.toggle('match', matched);
  dot.title = matched ? 'Matches the current tab' : 'Does not match the current tab';
}

// --- Add entry ---

function wireAddEntry(rule: DomainRule, ruleNode: HTMLElement): void {
  const kindSelect = ruleNode.querySelector('.kind-select') as HTMLSelectElement;
  const matcherTypeSelect = ruleNode.querySelector('.matcher-type') as HTMLSelectElement;
  const matcherTypeLabel = ruleNode.querySelector('.matcher-type-label') as HTMLElement;
  const revealMethodLabel = ruleNode.querySelector('.reveal-method-label') as HTMLElement;
  const revealMethodSelect = ruleNode.querySelector('.reveal-method') as HTMLSelectElement;
  const matcherInput = ruleNode.querySelector('input.matcher') as HTMLInputElement;
  const labelInput = ruleNode.querySelector('input.entry-label') as HTMLInputElement;
  const matcherErr = ruleNode.querySelector('.matcher-error') as HTMLElement;
  const addBtn = ruleNode.querySelector('.add-entry-btn') as HTMLButtonElement;

  function syncKindUI(): void {
    const kind = kindSelect.value as RuleEntry['kind'];
    if (kind === 'exclude') {
      matcherTypeLabel.hidden = false;
      revealMethodLabel.hidden = true;
      matcherInput.placeholder = matcherTypeSelect.value === 'css'
        ? 'button.gear'
        : matcherTypeSelect.value === 'text' ? 'Delete' : 'gear-icon';
    } else if (kind === 'include') {
      // Includes are CSS-only in v1.
      matcherTypeLabel.hidden = true;
      revealMethodLabel.hidden = true;
      matcherInput.placeholder = '[data-clickable]';
    } else {
      matcherTypeLabel.hidden = true;
      revealMethodLabel.hidden = false;
      matcherInput.placeholder = 'button.settings-button';
    }
  }
  kindSelect.addEventListener('change', syncKindUI);
  matcherTypeSelect.addEventListener('change', syncKindUI);
  syncKindUI();

  matcherInput.addEventListener('input', () => {
    matcherInput.classList.remove('invalid');
    matcherErr.textContent = '';
  });

  addBtn.addEventListener('click', () => {
    const kind = kindSelect.value as RuleEntry['kind'];
    const value = matcherInput.value.trim();
    if (!value) {
      matcherInput.classList.add('invalid');
      matcherErr.textContent = 'Matcher value is required.';
      return;
    }

    let matcher: Matcher;
    if (kind === 'exclude') {
      const matcherType = matcherTypeSelect.value as Matcher['type'];
      if (matcherType === 'css') {
        if (!isValidSelector(value)) {
          matcherInput.classList.add('invalid');
          matcherErr.textContent = 'Invalid CSS selector.';
          return;
        }
        matcher = { type: 'css', selector: value };
      } else if (matcherType === 'text') {
        matcher = { type: 'text', value, caseSensitive: false };
      } else {
        matcher = { type: 'class', name: value.replace(/^\./, '') };
      }
    } else {
      // include + reveal are CSS-only.
      if (!isValidSelector(value)) {
        matcherInput.classList.add('invalid');
        matcherErr.textContent = 'Invalid CSS selector.';
        return;
      }
      matcher = { type: 'css', selector: value };
    }

    const entry: RuleEntry = {
      id: uuid(),
      kind,
      matcher,
      label: labelInput.value.trim() || undefined,
    };
    if (kind === 'reveal') {
      entry.reveal = revealMethodSelect.value as RevealMethod;
    }

    rule.entries.push(entry);
    save();
    matcherInput.value = '';
    labelInput.value = '';
    matcherErr.textContent = '';
    const entriesEl = ruleNode.querySelector('.entries') as HTMLElement;
    renderEntries(rule, entriesEl);
  });
}

// --- Resolve panel ---

function wireResolvePanel(rule: DomainRule, ruleNode: HTMLElement): void {
  const details = ruleNode.querySelector('.resolve-panel') as HTMLDetailsElement;
  const tabSelect = ruleNode.querySelector('.resolve-tab') as HTMLSelectElement;
  const codewordInput = ruleNode.querySelector('.resolve-codeword') as HTMLInputElement;
  const resolveBtn = ruleNode.querySelector('.resolve-btn') as HTMLButtonElement;
  const result = ruleNode.querySelector('.resolve-result') as HTMLElement;

  async function populateTabs(): Promise<void> {
    const tabs = await chrome.tabs.query({});
    const eligible = tabs.filter(t =>
      typeof t.id === 'number' &&
      t.url &&
      (t.url.startsWith('http://') || t.url.startsWith('https://')),
    );
    // Prefer tabs whose URL matches this rule's pattern. They sort first.
    const matched: chrome.tabs.Tab[] = [];
    const others: chrome.tabs.Tab[] = [];
    for (const tab of eligible) {
      if (rule.pattern && matchRule(tab.url!, [{ ...rule, enabled: true }])) {
        matched.push(tab);
      } else {
        others.push(tab);
      }
    }
    const previous = tabSelect.value;
    tabSelect.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '— Select tab —';
    tabSelect.appendChild(placeholder);
    for (const tab of [...matched, ...others]) {
      const opt = document.createElement('option');
      opt.value = String(tab.id);
      const label = tab.title?.trim() || tab.url!;
      const host = (() => { try { return new URL(tab.url!).host; } catch { return ''; } })();
      opt.textContent = host ? `${label.slice(0, 60)} — ${host}` : label.slice(0, 80);
      tabSelect.appendChild(opt);
    }
    if (previous && [...matched, ...others].some(t => String(t.id) === previous)) {
      tabSelect.value = previous;
    } else if (matched.length > 0) {
      tabSelect.value = String(matched[0].id);
    }
  }

  details.addEventListener('toggle', () => {
    if (details.open) {
      populateTabs();
      codewordInput.focus();
    }
  });

  resolveBtn.addEventListener('click', async () => {
    const tabId = parseInt(tabSelect.value, 10);
    const codeword = codewordInput.value.trim();
    if (!tabId) {
      setFeedbackError(result, 'Pick a tab first.');
      return;
    }
    if (!codeword) {
      setFeedbackError(result, 'Enter a hint codeword.');
      return;
    }
    clearFeedback(result);
    result.textContent = 'Resolving…';
    resolveBtn.disabled = true;
    const response = await resolveCodewordFromTab(tabId, codeword);
    resolveBtn.disabled = false;
    if (!response.ok) {
      setFeedbackError(result, response.reason);
      return;
    }
    const matcherTypeSelect = ruleNode.querySelector('.matcher-type') as HTMLSelectElement;
    const matcherInput = ruleNode.querySelector('input.matcher') as HTMLInputElement;
    matcherTypeSelect.value = 'css';
    matcherTypeSelect.dispatchEvent(new Event('change'));
    matcherInput.value = response.selector;
    matcherInput.classList.remove('invalid');
    matcherInput.focus();
    renderResolvePreview(result, response, { includeSelector: true });
  });
}

// --- Add rule ---

function addRule(pattern: string): void {
  const rule: DomainRule = {
    id: uuid(),
    pattern,
    enabled: true,
    entries: [],
  };
  rules = [rule, ...rules];
  save();
  render();
  const node = rulesEl.querySelector(`[data-rule-id="${rule.id}"] .pattern-input`);
  if (node instanceof HTMLInputElement) {
    node.focus();
    node.select();
  }
}

// --- Init ---

async function init(): Promise<void> {
  activeTabUrl = await getActiveTabUrl();
  await load();
  render();

  const addCurrent = document.getElementById('add-current') as HTMLButtonElement;
  const addBlank = document.getElementById('add-blank') as HTMLButtonElement;

  if (!activeTabUrl || !suggestPattern(activeTabUrl)) {
    addCurrent.disabled = true;
    addCurrent.title = 'Open this page from a regular http(s) tab to use this shortcut.';
  }

  addCurrent.addEventListener('click', () => {
    if (!activeTabUrl) return;
    const suggestion = suggestPattern(activeTabUrl);
    if (!suggestion) return;
    addRule(suggestion);
  });

  addBlank.addEventListener('click', () => addRule(''));

  onDomainRulesChanged((incoming) => {
    if (rulesEqual(incoming, rules)) return;
    rules = incoming;
    render();
  });

  await initBadgeSettings();
}

// --- Badge appearance ---

const BADGE_FIELDS: Array<keyof BadgeSettings> = [
  'scale', 'fontMin', 'fontMax',
  'nudgeXSmall', 'nudgeYSmall',
  'nudgeXMed', 'nudgeYMed',
  'nudgeXLarge', 'nudgeYLarge',
];

const BADGE_SAVE_DEBOUNCE_MS = 250;
let badgeSaveTimer: ReturnType<typeof setTimeout> | null = null;
let suppressBadgeChangeEcho = false;

function readBadgeForm(): BadgeSettings {
  const out = { ...DEFAULT_BADGE_SETTINGS };
  for (const key of BADGE_FIELDS) {
    const el = document.getElementById(`bs-${key}`) as HTMLInputElement | null;
    if (!el) continue;
    const v = parseFloat(el.value);
    if (Number.isFinite(v)) (out as Record<string, number>)[key] = v;
  }
  return out;
}

function writeBadgeForm(s: BadgeSettings): void {
  for (const key of BADGE_FIELDS) {
    const el = document.getElementById(`bs-${key}`) as HTMLInputElement | null;
    if (!el) continue;
    el.value = String(s[key]);
  }
  updateBadgePreview(s);
}

function updateBadgePreview(s: BadgeSettings): void {
  const badge = document.getElementById('bs-preview-badge') as HTMLSpanElement | null;
  const text = document.getElementById('bs-preview-text') as HTMLSpanElement | null;
  if (!badge || !text) return;
  // Preview pegs to a 14px target — the "small font" bucket — to match
  // what the user sees on body text. computeBadgeFontSize applies the
  // scale × 14, then clamps to [fontMin, fontMax].
  const targetFont = 14;
  const scaled = Math.round(targetFont * s.scale);
  const badgeFont = Math.min(Math.max(scaled, s.fontMin), s.fontMax);
  badge.style.fontSize = `${badgeFont}px`;
  // Use the small-font nudge ratios for the preview.
  const badgeW = badge.offsetWidth || 16;
  const badgeH = badge.offsetHeight || 14;
  const offsetX = badgeW * (1 - s.nudgeXSmall);
  const offsetY = badgeH * (1 - s.nudgeYSmall);
  badge.style.left = `${-offsetX}px`;
  badge.style.top = `${-offsetY}px`;
}

async function initBadgeSettings(): Promise<void> {
  const current = await loadBadgeSettings();
  writeBadgeForm(current);

  for (const key of BADGE_FIELDS) {
    const el = document.getElementById(`bs-${key}`) as HTMLInputElement | null;
    if (!el) continue;
    el.addEventListener('input', () => {
      const next = readBadgeForm();
      updateBadgePreview(next);
      if (badgeSaveTimer) clearTimeout(badgeSaveTimer);
      badgeSaveTimer = setTimeout(() => {
        suppressBadgeChangeEcho = true;
        saveBadgeSettings(next);
      }, BADGE_SAVE_DEBOUNCE_MS);
    });
  }

  const resetBtn = document.getElementById('bs-reset') as HTMLButtonElement | null;
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      resetBadgeSettings();
      writeBadgeForm(DEFAULT_BADGE_SETTINGS);
    });
  }

  onBadgeSettingsChanged((incoming) => {
    if (suppressBadgeChangeEcho) {
      // Skip echo of our own save — keeps the form from clobbering an
      // in-flight edit the user is still typing.
      suppressBadgeChangeEcho = false;
      return;
    }
    writeBadgeForm(incoming);
  });
}

init();
