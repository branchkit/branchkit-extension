/**
 * BranchKit Browser — Options page logic.
 *
 * Vanilla JS cross-site rule editor: pattern editing, all matcher types
 * (CSS / text / class), and a per-rule tab-picker for codeword resolve.
 * Current-site affordances live in the popup — this page opens as its own
 * tab, so it has no meaningful "current site" of its own. Storage and
 * message-passing go through ./domain-rules-storage and ./rule-ui.
 */

import type {
  DomainRule,
  Matcher,
  RuleEntry,
  RevealMethod,
  TextMatchMode,
} from './rules/domain-rules';
import { urlMatchesPattern } from './rules/domain-rules';
import {
  loadDomainRules,
  saveDomainRules,
  onDomainRulesChanged,
  rulesEqual,
} from './rules/domain-rules-storage';
import {
  isValidSelector,
  validatePattern,
  reorderRules,
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
  onBadgeSettingsChanged,
} from './badge-settings-storage';
import { initKeymapEditor } from './keymap-options';
import { loadKeyboardRules, saveKeyboardRules, type KeyboardRule } from './keyboard-rules';

// --- State ---

let rules: DomainRule[] = [];
let draggedRuleId: string | null = null;
let draggedEntry: { ruleId: string; entryId: string } | null = null;
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

function uuid(): string {
  return crypto.randomUUID();
}

// --- Rendering ---

function render(): void {
  rulesEl.replaceChildren();
  if (rules.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No rules yet. Add one to customize badges for a site.';
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

  wireDragReorder(rule, node);

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
  validatePatternUI(rule, patternInput, node);

  return node;
}

// Drag-and-drop reordering. The handle is the draggable element; any rule
// card is a drop target ("drop before this rule"). Order is organizational
// only — the cascade merges every matching rule regardless of position.
function wireDragReorder(rule: DomainRule, node: HTMLElement): void {
  const handle = node.querySelector('.drag-handle') as HTMLElement;

  handle.addEventListener('dragstart', (e) => {
    draggedRuleId = rule.id;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', rule.id);  // Firefox needs data to start a drag
      e.dataTransfer.setDragImage(node, 12, 12);
    }
    node.classList.add('dragging');
  });

  handle.addEventListener('dragend', () => {
    draggedRuleId = null;
    clearDragMarkers();
  });

  node.addEventListener('dragover', (e) => {
    if (!draggedRuleId || draggedRuleId === rule.id) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    for (const el of rulesEl.querySelectorAll('.drag-over')) {
      if (el !== node) el.classList.remove('drag-over');
    }
    node.classList.add('drag-over');
  });

  node.addEventListener('drop', (e) => {
    e.preventDefault();
    const dragged = draggedRuleId;
    draggedRuleId = null;
    clearDragMarkers();
    if (!dragged || dragged === rule.id) return;
    rules = reorderRules(rules, dragged, rule.id);
    save();
    render();
  });
}

function clearDragMarkers(): void {
  for (const el of rulesEl.querySelectorAll('.rule.drag-over, .rule.dragging')) {
    el.classList.remove('drag-over', 'dragging');
  }
}

// Drag-and-drop reordering of entries WITHIN a rule. Mirrors wireDragReorder
// but scoped per-rule: a drag started in one card can only drop in that same
// card's entry list. Order is organizational only, same as rule order.
function wireEntryDragReorder(rule: DomainRule, entry: RuleEntry, node: HTMLElement): void {
  const handle = node.querySelector('.entry-drag') as HTMLElement;

  handle.addEventListener('dragstart', (e) => {
    draggedEntry = { ruleId: rule.id, entryId: entry.id };
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', entry.id);  // Firefox needs data to start a drag
      e.dataTransfer.setDragImage(node, 12, 8);
    }
    node.classList.add('dragging');
  });

  handle.addEventListener('dragend', () => {
    draggedEntry = null;
    clearEntryDragMarkers();
  });

  const sameRuleTarget = (): boolean =>
    !!draggedEntry && draggedEntry.ruleId === rule.id && draggedEntry.entryId !== entry.id;

  node.addEventListener('dragover', (e) => {
    if (!sameRuleTarget()) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const container = node.parentElement;
    if (container) {
      for (const el of container.querySelectorAll('.drag-over')) {
        if (el !== node) el.classList.remove('drag-over');
      }
    }
    node.classList.add('drag-over');
  });

  node.addEventListener('drop', (e) => {
    if (!sameRuleTarget()) return;
    e.preventDefault();
    const draggedId = draggedEntry!.entryId;
    draggedEntry = null;
    clearEntryDragMarkers();
    rule.entries = reorderRules(rule.entries, draggedId, entry.id);
    save();
    const entriesEl = node.closest('.rule')!.querySelector('.entries') as HTMLElement;
    renderEntries(rule, entriesEl);
  });
}

function clearEntryDragMarkers(): void {
  for (const el of rulesEl.querySelectorAll('.entry.drag-over, .entry.dragging')) {
    el.classList.remove('drag-over', 'dragging');
  }
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
  if (entry.enabled === false) node.classList.add('entry-off');

  wireEntryDragReorder(rule, entry, node);

  const toggle = node.querySelector('.entry-toggle') as HTMLInputElement;
  toggle.checked = entry.enabled !== false;
  toggle.addEventListener('change', () => {
    entry.enabled = toggle.checked;
    save();
    node.classList.toggle('entry-off', !toggle.checked);
  });

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

  const editBtn = node.querySelector('.edit-entry') as HTMLButtonElement;
  editBtn.addEventListener('click', () => {
    const ruleNode = node.closest('.rule') as HTMLElement;
    beginEdit(rule, entry, ruleNode, node);
  });

  const del = node.querySelector('.delete-entry') as HTMLButtonElement;
  del.addEventListener('click', () => {
    if (editSession?.entryId === entry.id) clearEdit();
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

// --- Entry editing ---

interface EditSession { ruleId: string; entryId: string; }
let editSession: EditSession | null = null;

// Pull an existing entry back into its rule's add-entry form for in-place
// editing. Reuses the form's change-driven show/hide by dispatching a
// synthetic `change` after setting the controls, so we don't duplicate
// syncKindUI's logic.
function beginEdit(
  rule: DomainRule,
  entry: RuleEntry,
  ruleNode: HTMLElement,
  entryRow: HTMLElement,
): void {
  clearEdit();
  editSession = { ruleId: rule.id, entryId: entry.id };

  const kindSelect = ruleNode.querySelector('.kind-select') as HTMLSelectElement;
  const matcherTypeSelect = ruleNode.querySelector('.matcher-type') as HTMLSelectElement;
  const matchModeSelect = ruleNode.querySelector('.match-mode') as HTMLSelectElement;
  const revealMethodSelect = ruleNode.querySelector('.reveal-method') as HTMLSelectElement;
  const matcherInput = ruleNode.querySelector('input.matcher') as HTMLInputElement;
  const labelInput = ruleNode.querySelector('input.entry-label') as HTMLInputElement;
  const addBtn = ruleNode.querySelector('.add-entry-btn') as HTMLButtonElement;
  const cancelBtn = ruleNode.querySelector('.cancel-edit-btn') as HTMLButtonElement;

  const m = entry.matcher;
  kindSelect.value = entry.kind;
  if (entry.kind === 'exclude') matcherTypeSelect.value = m.type;
  matcherInput.value = m.type === 'css' ? m.selector : m.type === 'text' ? m.value : m.name;
  labelInput.value = entry.label ?? '';
  if (entry.kind === 'reveal') revealMethodSelect.value = entry.reveal ?? 'opacity';
  if (m.type === 'text') matchModeSelect.value = m.mode ?? 'exact';
  kindSelect.dispatchEvent(new Event('change'));  // re-run the form's show/hide

  addBtn.textContent = 'Save changes';
  cancelBtn.hidden = false;
  entryRow.classList.add('editing');
  matcherInput.focus();
}

// Leave edit mode and restore every rule's form to its default "Add" state.
// Resetting all forms (not just the active one) keeps this simple — only one
// entry is ever edited at a time.
function clearEdit(): void {
  editSession = null;
  for (const e of document.querySelectorAll('.entry.editing')) e.classList.remove('editing');
  for (const b of document.querySelectorAll('.add-entry-btn')) (b as HTMLElement).textContent = 'Add';
  for (const b of document.querySelectorAll('.cancel-edit-btn')) (b as HTMLButtonElement).hidden = true;
}

// --- Add entry ---

function wireAddEntry(rule: DomainRule, ruleNode: HTMLElement): void {
  const kindSelect = ruleNode.querySelector('.kind-select') as HTMLSelectElement;
  const matcherTypeSelect = ruleNode.querySelector('.matcher-type') as HTMLSelectElement;
  const matcherTypeLabel = ruleNode.querySelector('.matcher-type-label') as HTMLElement;
  const matchModeLabel = ruleNode.querySelector('.match-mode-label') as HTMLElement;
  const matchModeSelect = ruleNode.querySelector('.match-mode') as HTMLSelectElement;
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
      matchModeLabel.hidden = matcherTypeSelect.value !== 'text';
      revealMethodLabel.hidden = true;
      matcherInput.placeholder = matcherTypeSelect.value === 'css'
        ? 'button.gear'
        : matcherTypeSelect.value === 'text' ? 'Delete' : 'gear-icon';
    } else if (kind === 'include') {
      // Includes are CSS-only in v1.
      matcherTypeLabel.hidden = true;
      matchModeLabel.hidden = true;
      revealMethodLabel.hidden = true;
      matcherInput.placeholder = '[data-clickable]';
    } else {
      matcherTypeLabel.hidden = true;
      matchModeLabel.hidden = true;
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
        matcher = {
          type: 'text',
          value,
          caseSensitive: false,
          mode: matchModeSelect.value as TextMatchMode,
        };
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

    if (editSession && editSession.ruleId === rule.id) {
      const idx = rule.entries.findIndex(e => e.id === editSession!.entryId);
      if (idx >= 0) {
        entry.id = rule.entries[idx].id;            // keep identity
        entry.enabled = rule.entries[idx].enabled;  // keep on/off state
        rule.entries[idx] = entry;
      } else {
        rule.entries.push(entry);  // edited entry was removed meanwhile
      }
      clearEdit();
    } else {
      rule.entries.push(entry);
    }
    save();
    matcherInput.value = '';
    labelInput.value = '';
    matcherErr.textContent = '';
    const entriesEl = ruleNode.querySelector('.entries') as HTMLElement;
    renderEntries(rule, entriesEl);
  });

  const cancelBtn = ruleNode.querySelector('.cancel-edit-btn') as HTMLButtonElement;
  cancelBtn.addEventListener('click', () => {
    clearEdit();
    matcherInput.value = '';
    labelInput.value = '';
    matcherErr.textContent = '';
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
      if (rule.pattern && urlMatchesPattern(tab.url!, rule.pattern)) {
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
      setFeedbackError(result, 'Enter the badge label.');
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
  await load();
  render();

  // A blank-pattern rule the user types the pattern into — the cross-site
  // authoring path. Per-site creation lives in the popup, which has an actual
  // current site; this page opens as its own tab and has none.
  const addRuleBtn = document.getElementById('add-rule') as HTMLButtonElement;
  addRuleBtn.addEventListener('click', () => addRule(''));

  onDomainRulesChanged((incoming) => {
    if (rulesEqual(incoming, rules)) return;
    rules = incoming;
    render();
  });

  await initBadgeSettings();
  await initKeymapEditor();
  await initKeyboardRules();
  initSideNav();
}

// --- Key rules (per-site keyboard pass-through / disable) ---

async function initKeyboardRules(): Promise<void> {
  const container = document.getElementById('keyboard-rules');
  const addBtn = document.getElementById('add-keyboard-rule');
  if (!container) return;

  let rules: KeyboardRule[] = await loadKeyboardRules();
  const persist = (): void => { void saveKeyboardRules(rules); };

  const renderRow = (rule: KeyboardRule, index: number): HTMLElement => {
    const row = document.createElement('div');
    row.className = 'kb-rule';

    const pattern = document.createElement('input');
    pattern.type = 'text';
    pattern.className = 'kb-pattern';
    pattern.placeholder = '*.example.com';
    pattern.spellcheck = false;
    pattern.value = rule.pattern;
    pattern.setAttribute('aria-label', 'URL pattern');
    pattern.addEventListener('input', () => { rule.pattern = pattern.value.trim(); persist(); });

    const passInput = document.createElement('input');
    passInput.type = 'text';
    passInput.className = 'kb-pass';
    passInput.placeholder = 'pass keys, e.g. jke#';
    passInput.spellcheck = false;
    passInput.value = rule.passKeys ?? '';
    passInput.disabled = !!rule.off;
    passInput.setAttribute('aria-label', 'Keys to pass to the site');
    passInput.addEventListener('input', () => {
      const keys = Array.from(passInput.value).filter((c) => c.trim() !== '').join('');
      if (keys) rule.passKeys = keys; else delete rule.passKeys;
      persist();
    });

    const offLabel = document.createElement('label');
    offLabel.className = 'kb-off';
    const off = document.createElement('input');
    off.type = 'checkbox';
    off.checked = !!rule.off;
    off.addEventListener('change', () => {
      if (off.checked) rule.off = true; else delete rule.off;
      passInput.disabled = off.checked; // "off" passes everything — per-key is moot
      persist();
    });
    offLabel.append(off, document.createTextNode(' Disable all'));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'kb-del danger';
    del.textContent = 'Delete';
    del.addEventListener('click', () => { rules.splice(index, 1); persist(); render(); });

    row.append(pattern, offLabel, passInput, del);
    return row;
  };

  const render = (): void => {
    container.replaceChildren();
    if (rules.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'kb-empty';
      empty.textContent =
        'No keyboard rules. Add one to disable BranchKit’s shortcuts, or pass specific keys, on sites matching a pattern.';
      container.appendChild(empty);
      return;
    }
    rules.forEach((rule, i) => container.appendChild(renderRow(rule, i)));
  };

  addBtn?.addEventListener('click', () => {
    rules.push({ pattern: '' });
    render();
    // Focus the new row's pattern field.
    const last = container.querySelector<HTMLInputElement>('.kb-rule:last-child .kb-pattern');
    last?.focus();
  });

  render();
}

// Sticky section nav: highlight the link whose section is currently at the top.
// Anchor clicks scroll natively (scroll-behavior: smooth + .sec scroll-margin).
function initSideNav(): void {
  const nav = document.getElementById('side-nav');
  if (!nav) return;
  const links = Array.from(nav.querySelectorAll<HTMLAnchorElement>('.side-link'));
  const sections = links
    .map((l) => document.querySelector<HTMLElement>(l.getAttribute('href') ?? ''))
    .filter((el): el is HTMLElement => el !== null);
  if (sections.length === 0) return;

  const setActive = (id: string): void => {
    for (const l of links) l.classList.toggle('active', l.getAttribute('href') === '#' + id);
  };

  let ticking = false;
  const update = (): void => {
    ticking = false;
    // At (or within a hair of) the page bottom, the last section wins — a short
    // final section (e.g. Badge appearance) can't scroll its heading up to the
    // trigger line, so the heading test alone would leave the previous section lit.
    const atBottom =
      window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
    let active = sections[sections.length - 1];
    if (!atBottom) {
      // Otherwise: the last section whose heading has crossed the top line.
      active = sections[0];
      for (const s of sections) {
        if (s.getBoundingClientRect().top <= 80) active = s;
      }
    }
    setActive(active.id);
  };
  update();
  window.addEventListener('scroll', () => {
    if (!ticking) { ticking = true; requestAnimationFrame(update); }
  }, { passive: true });
}

// --- Badge appearance ---

// Advanced number inputs bind 1:1 to storage keys. The primary controls
// (size, overlap X/Y) are derived views over the same BadgeSettings —
// size quotes the badge font at a nominal 14px target, overlap moves all
// three nudge buckets together.
const BADGE_ADV_FIELDS: Array<keyof BadgeSettings> = [
  'fontMin', 'fontMax',
  'nudgeXSmall', 'nudgeYSmall',
  'nudgeXMed', 'nudgeYMed',
  'nudgeXLarge', 'nudgeYLarge',
];

const BADGE_PRESETS: Record<string, BadgeSettings> = {
  subtle: { ...DEFAULT_BADGE_SETTINGS, scale: 0.65, fontMin: 7, fontMax: 10 },
  default: { ...DEFAULT_BADGE_SETTINGS },
  prominent: { ...DEFAULT_BADGE_SETTINGS, scale: 1.0, fontMin: 10, fontMax: 20 },
};

const BADGE_NORMAL_TEXT_PX = 14;
const BADGE_SAVE_DEBOUNCE_MS = 250;
let badgeSaveTimer: ReturnType<typeof setTimeout> | null = null;
let suppressBadgeChangeEcho = false;
// Single source of truth for the form; every control mutates this and
// re-syncs the others (skipping the control being edited, so typing in a
// number box isn't clobbered mid-keystroke).
let badgeCurrent: BadgeSettings = { ...DEFAULT_BADGE_SETTINGS };

function clamp01(v: number): number {
  return Math.min(Math.max(v, 0), 1);
}

function setBadgeInput(id: string, value: number, except?: HTMLElement): void {
  const el = document.getElementById(id) as HTMLInputElement | null;
  if (!el || el === except) return;
  // Trim float noise from overlap-delta arithmetic (0.30000000000000004).
  el.value = String(Math.round(value * 1000) / 1000);
}

function syncBadgeControls(except?: HTMLElement): void {
  const s = badgeCurrent;
  const sizePx = Math.round(s.scale * BADGE_NORMAL_TEXT_PX * 2) / 2;
  setBadgeInput('bs-size', sizePx, except);
  setBadgeInput('bs-size-num', sizePx, except);
  setBadgeInput('bs-overlapX', s.nudgeXSmall, except);
  setBadgeInput('bs-overlapX-num', s.nudgeXSmall, except);
  setBadgeInput('bs-overlapY', s.nudgeYSmall, except);
  setBadgeInput('bs-overlapY-num', s.nudgeYSmall, except);
  for (const key of BADGE_ADV_FIELDS) setBadgeInput(`bs-${key}`, s[key], except);
  updateBadgePreview(s);
}

function scheduleBadgeSave(): void {
  if (badgeSaveTimer) clearTimeout(badgeSaveTimer);
  badgeSaveTimer = setTimeout(() => {
    suppressBadgeChangeEcho = true;
    saveBadgeSettings(badgeCurrent);
  }, BADGE_SAVE_DEBOUNCE_MS);
}

// One preview sample per nudge bucket, pegged to a representative target
// font (bucket thresholds: <15px small, <20px medium, ≥20px large — see
// placement/position.ts getNudge). Mirrors computeBadgeFontSize:
// round(target × scale) clamped to [fontMin, fontMax].
const PREVIEW_BUCKETS: Array<{
  key: string;
  targetFont: number;
  nudgeX: keyof BadgeSettings;
  nudgeY: keyof BadgeSettings;
}> = [
  { key: 'small', targetFont: 14, nudgeX: 'nudgeXSmall', nudgeY: 'nudgeYSmall' },
  { key: 'med', targetFont: 18, nudgeX: 'nudgeXMed', nudgeY: 'nudgeYMed' },
  { key: 'large', targetFont: 24, nudgeX: 'nudgeXLarge', nudgeY: 'nudgeYLarge' },
];

function updateBadgePreview(s: BadgeSettings): void {
  const lines: string[] = [];
  for (const bucket of PREVIEW_BUCKETS) {
    const badge = document.getElementById(`bs-preview-badge-${bucket.key}`) as HTMLSpanElement | null;
    if (!badge) continue;
    const scaled = Math.round(bucket.targetFont * s.scale);
    const badgeFont = Math.min(Math.max(scaled, s.fontMin), s.fontMax);
    badge.style.fontSize = `${badgeFont}px`;
    const badgeW = badge.offsetWidth || 16;
    const badgeH = badge.offsetHeight || 14;
    badge.style.left = `${-(badgeW * (1 - s[bucket.nudgeX]))}px`;
    badge.style.top = `${-(badgeH * (1 - s[bucket.nudgeY]))}px`;
    // Flag when the clamp — not the scale — decided the size, so a scale
    // change that visibly does nothing explains itself.
    const clamp = scaled < s.fontMin ? ' (min)' : scaled > s.fontMax ? ' (max)' : '';
    lines.push(`${bucket.targetFont}px text → ${badgeFont}px badge${clamp}`);
  }
  const readout = document.getElementById('bs-preview-readout');
  if (readout) readout.textContent = lines.join('\n');
}

function bindBadgeControl(ids: string[], apply: (v: number) => void): void {
  for (const id of ids) {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (!el) continue;
    el.addEventListener('input', () => {
      const v = parseFloat(el.value);
      if (!Number.isFinite(v)) return;
      apply(v);
      syncBadgeControls(el);
      scheduleBadgeSave();
    });
  }
}

async function initBadgeSettings(): Promise<void> {
  badgeCurrent = await loadBadgeSettings();
  syncBadgeControls();

  bindBadgeControl(['bs-size', 'bs-size-num'], (v) => {
    badgeCurrent.scale = Math.round((v / BADGE_NORMAL_TEXT_PX) * 1000) / 1000;
    // The clamp yields to the primary control — otherwise a narrow stored
    // clamp (e.g. the retired [10,12] defaults still in storage.sync)
    // silently caps the slider and it feels dead again.
    badgeCurrent.fontMax = Math.max(badgeCurrent.fontMax, Math.ceil(v));
    badgeCurrent.fontMin = Math.min(badgeCurrent.fontMin, Math.floor(v));
  });
  // Overlap sliders shift all three buckets by the same delta, preserving
  // whatever relative offsets are currently set (defaults or advanced
  // edits). The small bucket is the slider's readback position.
  bindBadgeControl(['bs-overlapX', 'bs-overlapX-num'], (v) => {
    const d = v - badgeCurrent.nudgeXSmall;
    badgeCurrent.nudgeXSmall = clamp01(v);
    badgeCurrent.nudgeXMed = clamp01(badgeCurrent.nudgeXMed + d);
    badgeCurrent.nudgeXLarge = clamp01(badgeCurrent.nudgeXLarge + d);
  });
  bindBadgeControl(['bs-overlapY', 'bs-overlapY-num'], (v) => {
    const d = v - badgeCurrent.nudgeYSmall;
    badgeCurrent.nudgeYSmall = clamp01(v);
    badgeCurrent.nudgeYMed = clamp01(badgeCurrent.nudgeYMed + d);
    badgeCurrent.nudgeYLarge = clamp01(badgeCurrent.nudgeYLarge + d);
  });
  for (const key of BADGE_ADV_FIELDS) {
    bindBadgeControl([`bs-${key}`], (v) => {
      badgeCurrent[key] = v;
    });
  }

  for (const btn of document.querySelectorAll<HTMLButtonElement>('.bs-preset')) {
    btn.addEventListener('click', () => {
      const preset = BADGE_PRESETS[btn.dataset.preset ?? ''];
      if (!preset) return;
      badgeCurrent = { ...preset };
      syncBadgeControls();
      scheduleBadgeSave();
    });
  }

  onBadgeSettingsChanged((incoming) => {
    if (suppressBadgeChangeEcho) {
      // Skip echo of our own save — keeps the form from clobbering an
      // in-flight edit the user is still typing.
      suppressBadgeChangeEcho = false;
      return;
    }
    badgeCurrent = incoming;
    syncBadgeControls();
  });
}

init();
