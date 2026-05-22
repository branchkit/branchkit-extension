/**
 * BranchKit Browser — Options page logic.
 *
 * Vanilla JS over the chrome.storage.sync `domainRules` key. Renders the
 * rule list from the markup in options.html, wires up add/edit/delete,
 * and keeps the "matches current tab" indicator live.
 *
 * Codeword resolution (picking an element via voice handle in a tab and
 * pasting the resulting selector here) is deferred to step 5 of the
 * design doc — this v1 uses manual selector/text/class entry only.
 */

import type {
  DomainRule,
  DomainRules,
  Matcher,
  RuleEntry,
  RevealMethod,
} from './domain-rules';
import { matchRule } from './domain-rules';
import {
  suggestPattern,
  isValidSelector,
  validatePattern,
} from './options-helpers';
import type { ResolveHintResponse } from './types';

// --- State ---

let rules: DomainRule[] = [];
let activeTabUrl: string | null = null;
const PATTERN_SAVE_DEBOUNCE_MS = 350;
const patternSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

const rulesEl = document.getElementById('rules') as HTMLDivElement;
const ruleTpl = document.getElementById('rule-template') as HTMLTemplateElement;
const entryTpl = document.getElementById('entry-template') as HTMLTemplateElement;

// --- Storage ---

function load(): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.sync.get('domainRules', (result) => {
      const stored = result.domainRules as DomainRules | undefined;
      rules = stored?.rules ?? [];
      resolve();
    });
  });
}

function save(): void {
  const data: DomainRules = { rules };
  chrome.storage.sync.set({ domainRules: data });
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
  kindEl.textContent = entry.kind === 'exclude' ? '–'
                    : entry.kind === 'include' ? '+'
                    : '◉';
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

function matcherSummary(matcher: Matcher): string {
  switch (matcher.type) {
    case 'css':   return matcher.selector;
    case 'text':  return `text="${matcher.value}"${matcher.caseSensitive ? '' : ' (case-insensitive)'}`;
    case 'class': return `.${matcher.name}`;
  }
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
    result.classList.remove('error');
    if (!tabId) {
      result.classList.add('error');
      result.textContent = 'Pick a tab first.';
      return;
    }
    if (!codeword) {
      result.classList.add('error');
      result.textContent = 'Enter a hint codeword.';
      return;
    }
    result.textContent = 'Resolving…';
    resolveBtn.disabled = true;
    let response: ResolveHintResponse;
    try {
      response = await chrome.runtime.sendMessage({
        type: 'RESOLVE_HINT_FROM_TAB',
        tabId,
        codeword,
      });
    } catch (err) {
      response = { ok: false, reason: String((err as Error)?.message ?? err) };
    }
    resolveBtn.disabled = false;
    if (!response.ok) {
      result.classList.add('error');
      result.textContent = response.reason;
      return;
    }
    const matcherTypeSelect = ruleNode.querySelector('.matcher-type') as HTMLSelectElement;
    const matcherInput = ruleNode.querySelector('input.matcher') as HTMLInputElement;
    matcherTypeSelect.value = 'css';
    matcherTypeSelect.dispatchEvent(new Event('change'));
    matcherInput.value = response.selector;
    matcherInput.classList.remove('invalid');
    matcherInput.focus();

    result.innerHTML = '';
    result.appendChild(document.createTextNode('Matched '));
    const code = document.createElement('code');
    code.textContent = `<${response.tagName}>`;
    result.appendChild(code);
    if (response.accessibleName) {
      result.appendChild(document.createTextNode(` "${response.accessibleName}"`));
    }
    result.appendChild(document.createTextNode(' → '));
    const sel = document.createElement('code');
    sel.textContent = response.selector;
    result.appendChild(sel);
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

  chrome.storage.onChanged.addListener((changes) => {
    if (!changes.domainRules) return;
    const stored = changes.domainRules.newValue as DomainRules | undefined;
    // Skip if the change originated from us (rules already in sync).
    const incoming = stored?.rules ?? [];
    if (JSON.stringify(incoming) === JSON.stringify(rules)) return;
    rules = incoming;
    render();
  });
}

init();
