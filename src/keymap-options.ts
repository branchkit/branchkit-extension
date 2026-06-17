/**
 * BranchKit Browser — keyboard-shortcuts editor (options page).
 *
 * Command-centric: every bindable command is a card grouped by catalog group,
 * with all of its keys listed together (so e.g. "Scroll down" shows Shift+J and
 * a user-added plain J side by side). Each key auto-tags its context — "always"
 * (fires with hints shown or hidden) vs "hints hidden" (bare keys are codeword
 * input while hints are visible) — derived from the key, not chosen. Persists
 * through keymap-storage; the content script rebuilds its registry live.
 */

import {
  COMMAND_CATALOG,
  COMMAND_BY_ID,
  type CommandMeta,
  type KeymapEntry,
  type ParamSchema,
} from './command-catalog';
import {
  loadKeymap,
  saveKeymap,
  resetKeymap,
  onKeymapChanged,
  keymapsEqual,
} from './keymap-storage';
import { comboFromEvent, serializeCombo } from './activate/key-combo';
import { displayKeys, worksInAlwaysMode, duplicateKeys } from './keymap-edit-helpers';
import { nativeOverride, detectOS, detectBrowser } from './browser-shortcuts';

const OS = detectOS();
const BROWSER = detectBrowser();

let keymap: KeymapEntry[] = [];
let suppressEcho = false;

let keymapEl: HTMLDivElement;
let cmdTpl: HTMLTemplateElement;
let bindingTpl: HTMLTemplateElement;

const MAPPABLE = COMMAND_CATALOG.filter((c) => c.mappable);
const GROUPS = [...new Set(MAPPABLE.map((c) => c.group))];

function save(): void {
  suppressEcho = true;
  saveKeymap(keymap);
}

function render(): void {
  keymapEl.replaceChildren();
  const dupes = duplicateKeys(keymap);
  for (const group of GROUPS) {
    const head = document.createElement('div');
    head.className = 'km-group-head';
    head.textContent = group;
    keymapEl.appendChild(head);
    for (const cmd of MAPPABLE.filter((c) => c.group === group)) {
      keymapEl.appendChild(renderCommand(cmd, dupes));
    }
  }
}

function renderCommand(meta: CommandMeta, dupes: Set<string>): HTMLElement {
  const node = cmdTpl.content.firstElementChild!.cloneNode(true) as HTMLElement;
  (node.querySelector('.km-cmd-label') as HTMLElement).textContent = meta.label;
  (node.querySelector('.km-cmd-desc') as HTMLElement).textContent = meta.description;

  const addBtn = node.querySelector('.km-add-key') as HTMLButtonElement;
  addBtn.addEventListener('click', () => {
    capture(addBtn, '+ Add key', (keys) => {
      if (!keys) return;
      keymap = [...keymap, { keys, command: meta.id }];
      save();
      render();
    });
  });

  const bindingsEl = node.querySelector('.km-bindings') as HTMLElement;
  const entries = keymap.filter((e) => e.command === meta.id);
  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'km-empty-binding';
    empty.textContent = 'No key bound';
    bindingsEl.appendChild(empty);
  } else {
    for (const entry of entries) bindingsEl.appendChild(renderBinding(entry, dupes));
  }
  return node;
}

function renderBinding(entry: KeymapEntry, dupes: Set<string>): HTMLElement {
  const node = bindingTpl.content.firstElementChild!.cloneNode(true) as HTMLElement;

  const keyBtn = node.querySelector('.km-key') as HTMLButtonElement;
  keyBtn.textContent = displayKeys(entry.keys);
  keyBtn.addEventListener('click', () => {
    capture(keyBtn, displayKeys(entry.keys), (keys) => {
      if (!keys) return;
      entry.keys = keys;
      save();
      render();
    });
  });

  const ctx = node.querySelector('.km-context') as HTMLElement;
  if (worksInAlwaysMode(entry.keys)) {
    ctx.textContent = 'always';
    ctx.classList.add('always');
    ctx.title = 'Works whether hints are shown or hidden.';
  } else {
    ctx.textContent = 'hints hidden';
    ctx.title = 'Only fires when hints are hidden — bare keys type hint codewords while hints are visible.';
  }

  const warn = node.querySelector('.km-warn') as HTMLElement;
  const messages: string[] = [];
  const override = nativeOverride(entry.keys, OS, BROWSER);
  if (override) messages.push(`Overrides the browser's "${override}" shortcut.`);
  if (dupes.has(entry.keys)) {
    messages.push(`"${displayKeys(entry.keys)}" is bound to more than one command.`);
    warn.classList.add('conflict');
  }
  if (messages.length > 0) {
    warn.textContent = '⚠';
    warn.title = messages.join('\n');
  }

  renderParams(node.querySelector('.km-binding-params') as HTMLElement, entry);

  const remove = node.querySelector('.km-remove') as HTMLButtonElement;
  remove.addEventListener('click', () => {
    keymap = keymap.filter((e) => e !== entry);
    save();
    render();
  });
  return node;
}

// One-shot key capture: the next real (non-modifier) keypress becomes the key.
// Bare Escape cancels (onResult(null)). Single-combo only — sequences keep
// their stored value (editor v1; see DESIGN_KEYMAP_CONFIG.md).
function capture(btn: HTMLButtonElement, restore: string, onResult: (keys: string | null) => void): void {
  btn.textContent = 'Press a key…';
  btn.classList.add('capturing');
  const onKey = (e: KeyboardEvent): void => {
    if (/^(Control|Alt|Meta|Shift)/.test(e.code)) return; // wait for a real key
    e.preventDefault();
    e.stopPropagation();
    window.removeEventListener('keydown', onKey, true);
    btn.classList.remove('capturing');
    const bare = !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
    if (e.key === 'Escape' && bare) {
      btn.textContent = restore;
      onResult(null);
      return;
    }
    onResult(serializeCombo(comboFromEvent(e)));
  };
  window.addEventListener('keydown', onKey, true);
}

function renderParams(container: HTMLElement, entry: KeymapEntry): void {
  container.replaceChildren();
  const meta = COMMAND_BY_ID.get(entry.command);
  if (!meta) return;
  for (const schema of meta.params) container.appendChild(renderParamControl(schema, entry));
}

function renderParamControl(schema: ParamSchema, entry: KeymapEntry): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'km-param';
  wrap.textContent = `${schema.name} `;
  const current = entry.params?.[schema.name] ?? schema.default ?? '';

  const setParam = (value: string): void => {
    entry.params = { ...(entry.params ?? {}), [schema.name]: value };
    save();
  };

  if (schema.type === 'enum') {
    const sel = document.createElement('select');
    for (const opt of schema.options ?? []) {
      const o = document.createElement('option');
      o.value = opt;
      o.textContent = opt;
      sel.appendChild(o);
    }
    sel.value = current;
    sel.addEventListener('change', () => setParam(sel.value));
    wrap.appendChild(sel);
  } else {
    const input = document.createElement('input');
    input.type = schema.type === 'number' ? 'number' : 'text';
    if (schema.min !== undefined) input.min = String(schema.min);
    if (schema.max !== undefined) input.max = String(schema.max);
    input.value = current;
    input.addEventListener('input', () => setParam(input.value));
    wrap.appendChild(input);
  }
  return wrap;
}

export async function initKeymapEditor(): Promise<void> {
  keymapEl = document.getElementById('keymap') as HTMLDivElement;
  cmdTpl = document.getElementById('keymap-command-template') as HTMLTemplateElement;
  bindingTpl = document.getElementById('keymap-binding-template') as HTMLTemplateElement;
  if (!keymapEl || !cmdTpl || !bindingTpl) return; // section absent (older options.html)

  keymap = await loadKeymap();
  render();

  const resetBtn = document.getElementById('km-reset') as HTMLButtonElement | null;
  resetBtn?.addEventListener('click', async () => {
    if (!confirm('Reset all keyboard shortcuts to the defaults?')) return;
    resetKeymap();
    keymap = await loadKeymap();
    render();
  });

  onKeymapChanged((incoming) => {
    if (suppressEcho) {
      suppressEcho = false;
      return; // our own save
    }
    if (keymapsEqual(incoming, keymap)) return;
    keymap = incoming;
    render();
  });
}
