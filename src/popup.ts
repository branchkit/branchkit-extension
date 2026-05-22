/**
 * BranchKit Browser — Popup.
 *
 * Two surfaces in one popup:
 *   1. Existing global settings (status, hints visibility, label mode).
 *   2. Per-site rule editor (matched against the active tab's URL).
 *
 * The popup is the "fix THIS site" surface — options.html is for
 * cross-site browsing. CSS matchers only here; text/class matchers
 * stay in the options page where there's room for the UI to breathe.
 */

import {
  matchRule,
  type DomainRule,
  type DomainRules,
  type Matcher,
  type RuleEntry,
  type RevealMethod,
} from './domain-rules';
import { suggestPattern, isValidSelector } from './options-helpers';
import type { ResolveHintResponse } from './types';

// --- State ---

let activeTab: chrome.tabs.Tab | null = null;
let rules: DomainRule[] = [];

// --- Global settings (existing) ---

async function checkStatus(): Promise<void> {
  const dot = document.getElementById('dot')!;
  const text = document.getElementById('status-text')!;

  try {
    const resp = await chrome.runtime.sendMessage({ type: 'GET_HEALTH' });
    if (resp?.branchkit) {
      dot.className = 'dot connected';
      text.textContent = 'Connected to BranchKit';
    } else {
      dot.className = 'dot disconnected';
      text.textContent = 'BranchKit not detected';
    }
  } catch {
    dot.className = 'dot disconnected';
    text.textContent = 'Extension error';
  }
}

function initSyncedSelect(id: string, storageKey: string): void {
  const select = document.getElementById(id) as HTMLSelectElement;
  chrome.storage.sync.get(storageKey, (result) => {
    if (result[storageKey]) select.value = result[storageKey];
  });
  select.addEventListener('change', () => {
    chrome.storage.sync.set({ [storageKey]: select.value });
  });
}

function initOptionsLink(): void {
  const btn = document.getElementById('open-options');
  if (!btn) return;
  btn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });
}

// --- Per-site rules ---

async function loadRules(): Promise<void> {
  const result = await chrome.storage.sync.get('domainRules');
  const stored = result.domainRules as DomainRules | undefined;
  rules = stored?.rules ?? [];
}

function saveRules(): void {
  const data: DomainRules = { rules };
  chrome.storage.sync.set({ domainRules: data });
}

function activeHost(): string {
  if (!activeTab?.url) return '';
  try { return new URL(activeTab.url).host; } catch { return ''; }
}

function activeRule(): DomainRule | null {
  if (!activeTab?.url) return null;
  return matchRule(activeTab.url, rules);
}

function render(): void {
  const hostEl = document.getElementById('rules-host')!;
  const bodyEl = document.getElementById('rules-body')!;
  const host = activeHost();

  if (!host) {
    hostEl.textContent = 'this page';
    bodyEl.replaceChildren(noRuleNode('Rules apply to http(s) sites only.'));
    return;
  }
  hostEl.textContent = host;

  const rule = activeRule();
  if (!rule) {
    bodyEl.replaceChildren(noRuleNode());
    return;
  }
  bodyEl.replaceChildren(renderRuleCard(rule));
}

function noRuleNode(message?: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'no-rule';

  if (message) {
    wrap.textContent = message;
    return wrap;
  }

  const suggested = activeTab?.url ? suggestPattern(activeTab.url) : null;
  if (!suggested) {
    wrap.textContent = 'No rule for this site.';
    return wrap;
  }

  wrap.append('No rule for this site.');
  const sugLine = document.createElement('div');
  sugLine.className = 'suggested';
  sugLine.textContent = suggested;
  wrap.appendChild(sugLine);

  const btn = document.createElement('button');
  btn.textContent = `+ Create rule for ${suggested}`;
  btn.addEventListener('click', () => {
    const fresh: DomainRule = {
      id: crypto.randomUUID(),
      pattern: suggested,
      enabled: true,
      entries: [],
    };
    rules = [fresh, ...rules];
    saveRules();
    render();
  });
  wrap.appendChild(btn);
  return wrap;
}

function renderRuleCard(rule: DomainRule): HTMLElement {
  const card = document.createElement('div');
  card.className = 'rule-card';
  if (!rule.enabled) card.classList.add('disabled');

  const headerRow = document.createElement('div');
  headerRow.className = 'rule-row';

  const pattern = document.createElement('span');
  pattern.className = 'rule-pattern';
  pattern.textContent = rule.pattern;
  pattern.title = rule.pattern;
  headerRow.appendChild(pattern);

  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.checked = rule.enabled;
  toggle.title = 'Enable/disable rule';
  toggle.addEventListener('change', () => {
    rule.enabled = toggle.checked;
    saveRules();
    card.classList.toggle('disabled', !rule.enabled);
  });
  headerRow.appendChild(toggle);

  card.appendChild(headerRow);

  const entriesEl = document.createElement('div');
  entriesEl.className = 'entries-list';
  renderEntries(rule, entriesEl);
  card.appendChild(entriesEl);

  card.appendChild(renderAddEntry(rule, entriesEl));
  return card;
}

function renderEntries(rule: DomainRule, container: HTMLElement): void {
  container.replaceChildren();
  for (const entry of rule.entries) {
    container.appendChild(renderEntry(rule, entry, container));
  }
}

function renderEntry(rule: DomainRule, entry: RuleEntry, entriesEl: HTMLElement): HTMLElement {
  const node = document.createElement('div');
  node.className = 'entry';

  const kind = document.createElement('span');
  kind.className = `entry-kind ${entry.kind}`;
  kind.textContent = entry.kind === 'exclude' ? '–'
                    : entry.kind === 'include' ? '+'
                    : '◉';
  kind.title = entry.kind + (entry.reveal ? ` (${entry.reveal})` : '');
  node.appendChild(kind);

  const text = document.createElement('span');
  text.className = 'entry-text';
  const summary = matcherSummary(entry.matcher);
  text.textContent = entry.label ? `${entry.label} — ${summary}` : summary;
  text.title = summary;
  node.appendChild(text);

  const remove = document.createElement('button');
  remove.className = 'entry-remove';
  remove.textContent = '×';
  remove.title = 'Remove entry';
  remove.addEventListener('click', () => {
    rule.entries = rule.entries.filter(e => e.id !== entry.id);
    saveRules();
    renderEntries(rule, entriesEl);
  });
  node.appendChild(remove);

  return node;
}

function matcherSummary(matcher: Matcher): string {
  switch (matcher.type) {
    case 'css':   return matcher.selector;
    case 'text':  return `text="${matcher.value}"`;
    case 'class': return `.${matcher.name}`;
  }
}

function renderAddEntry(rule: DomainRule, entriesEl: HTMLElement): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'add-entry';

  // Row 1: kind picker + reveal method + matcher input + Add
  const row1 = document.createElement('div');
  row1.className = 'add-entry-row';

  const kindSelect = document.createElement('select');
  kindSelect.title = 'Entry kind';
  for (const [val, lbl] of [['exclude', 'Exclude'], ['include', 'Include'], ['reveal', 'Reveal']] as const) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = lbl;
    kindSelect.appendChild(opt);
  }
  row1.appendChild(kindSelect);

  const revealSelect = document.createElement('select');
  revealSelect.title = 'Reveal method';
  revealSelect.hidden = true;
  for (const [val, lbl] of [['opacity', 'Opacity'], ['visibility', 'Visibility']] as const) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = lbl;
    revealSelect.appendChild(opt);
  }
  row1.appendChild(revealSelect);

  const matcherInput = document.createElement('input');
  matcherInput.type = 'text';
  matcherInput.className = 'matcher';
  matcherInput.placeholder = 'CSS selector';
  matcherInput.spellcheck = false;
  row1.appendChild(matcherInput);

  const addBtn = document.createElement('button');
  addBtn.className = 'primary';
  addBtn.textContent = 'Add';
  row1.appendChild(addBtn);

  wrap.appendChild(row1);

  // Row 2: resolve from active tab
  const row2 = document.createElement('div');
  row2.className = 'add-entry-row resolve-row';
  const resolveLabel = document.createElement('label');
  resolveLabel.textContent = 'Pick:';
  row2.appendChild(resolveLabel);

  const codewordInput = document.createElement('input');
  codewordInput.type = 'text';
  codewordInput.className = 'codeword';
  codewordInput.placeholder = 'hint codeword';
  codewordInput.spellcheck = false;
  row2.appendChild(codewordInput);

  const resolveBtn = document.createElement('button');
  resolveBtn.className = 'secondary';
  resolveBtn.textContent = 'Resolve';
  row2.appendChild(resolveBtn);

  wrap.appendChild(row2);

  const feedback = document.createElement('div');
  feedback.className = 'feedback';
  wrap.appendChild(feedback);

  kindSelect.addEventListener('change', () => {
    revealSelect.hidden = kindSelect.value !== 'reveal';
  });

  matcherInput.addEventListener('input', () => {
    matcherInput.classList.remove('invalid');
    feedback.classList.remove('error');
    feedback.textContent = '';
  });

  addBtn.addEventListener('click', () => {
    const selector = matcherInput.value.trim();
    if (!selector) {
      matcherInput.classList.add('invalid');
      setError(feedback, 'Selector is required.');
      return;
    }
    if (!isValidSelector(selector)) {
      matcherInput.classList.add('invalid');
      setError(feedback, 'Invalid CSS selector.');
      return;
    }
    const kind = kindSelect.value as RuleEntry['kind'];
    const entry: RuleEntry = {
      id: crypto.randomUUID(),
      kind,
      matcher: { type: 'css', selector },
    };
    if (kind === 'reveal') {
      entry.reveal = revealSelect.value as RevealMethod;
    }
    rule.entries.push(entry);
    saveRules();
    matcherInput.value = '';
    feedback.textContent = '';
    renderEntries(rule, entriesEl);
  });

  resolveBtn.addEventListener('click', async () => {
    const codeword = codewordInput.value.trim();
    if (!codeword) {
      setError(feedback, 'Type a hint codeword first.');
      return;
    }
    if (!activeTab?.id) {
      setError(feedback, 'No active tab.');
      return;
    }
    feedback.classList.remove('error');
    feedback.textContent = 'Resolving…';
    resolveBtn.disabled = true;
    let response: ResolveHintResponse;
    try {
      response = await chrome.runtime.sendMessage({
        type: 'RESOLVE_HINT_FROM_TAB',
        tabId: activeTab.id,
        codeword,
      });
    } catch (err) {
      response = { ok: false, reason: String((err as Error)?.message ?? err) };
    }
    resolveBtn.disabled = false;
    if (!response.ok) {
      setError(feedback, response.reason);
      return;
    }
    matcherInput.value = response.selector;
    matcherInput.classList.remove('invalid');
    codewordInput.value = '';
    feedback.classList.remove('error');
    feedback.innerHTML = '';
    feedback.append('Matched ');
    const tag = document.createElement('code');
    tag.textContent = `<${response.tagName}>`;
    feedback.appendChild(tag);
    if (response.accessibleName) {
      feedback.append(` "${response.accessibleName}"`);
    }
    matcherInput.focus();
  });

  return wrap;
}

function setError(el: HTMLElement, msg: string): void {
  el.classList.add('error');
  el.textContent = msg;
}

// --- Init ---

async function init(): Promise<void> {
  checkStatus();
  initSyncedSelect('hint-visibility', 'hintVisibility');
  initSyncedSelect('hint-mode', 'badgeDisplayMode');
  initOptionsLink();

  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  activeTab = tab ?? null;
  await loadRules();
  render();
}

init();
