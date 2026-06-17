/**
 * BranchKit Browser — keyboard-shortcuts editor (options page).
 *
 * GUI over the keymap: each row is a command dropdown (grouped by catalog
 * group, self-documenting via descriptions) + a key-capture button + any
 * schema-driven param controls. Persists through keymap-storage; the content
 * script rebuilds its command registry live on change. Mirrors the
 * domain-rules editor's vanilla-JS / template-clone / debounced-save shape.
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
import { displayKeys, alwaysModeNote, duplicateKeys } from './keymap-edit-helpers';

let keymap: KeymapEntry[] = [];
let suppressEcho = false;

let keymapEl: HTMLDivElement;
let rowTpl: HTMLTemplateElement;

const MAPPABLE = COMMAND_CATALOG.filter((c) => c.mappable);
const GROUPS = [...new Set(MAPPABLE.map((c) => c.group))];
// First mappable command, used as the default for a freshly-added row.
const FIRST_COMMAND = MAPPABLE[0]?.id ?? '';

function save(): void {
  suppressEcho = true;
  saveKeymap(keymap);
}

function render(): void {
  keymapEl.replaceChildren();
  if (keymap.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No shortcuts. Add one, or reset to the defaults.';
    keymapEl.appendChild(empty);
    return;
  }
  const dupes = duplicateKeys(keymap);
  keymap.forEach((entry, i) => keymapEl.appendChild(renderRow(entry, i, dupes)));
}

function renderRow(entry: KeymapEntry, index: number, dupes: Set<string>): HTMLElement {
  const node = rowTpl.content.firstElementChild!.cloneNode(true) as HTMLElement;

  // Command dropdown, grouped by catalog group.
  const select = node.querySelector('.km-command-select') as HTMLSelectElement;
  for (const group of GROUPS) {
    const og = document.createElement('optgroup');
    og.label = group;
    for (const cmd of MAPPABLE.filter((c) => c.group === group)) {
      const opt = document.createElement('option');
      opt.value = cmd.id;
      opt.textContent = cmd.label;
      opt.title = cmd.description;
      og.appendChild(opt);
    }
    select.appendChild(og);
  }
  select.value = entry.command;
  const descEl = node.querySelector('.km-desc') as HTMLElement;
  const syncDesc = (): void => {
    descEl.textContent = COMMAND_BY_ID.get(entry.command)?.description ?? '';
  };
  syncDesc();
  select.addEventListener('change', () => {
    entry.command = select.value;
    entry.params = undefined; // params belong to the old command; start fresh
    save();
    render(); // param controls + description change with the command
  });

  // Key capture.
  const captureBtn = node.querySelector('.km-capture') as HTMLButtonElement;
  renderKeyButton(captureBtn, entry);
  captureBtn.addEventListener('click', () => beginCapture(captureBtn, entry));

  // Schema-driven param controls.
  const paramsEl = node.querySelector('.km-params') as HTMLElement;
  renderParams(paramsEl, entry);

  // Always-mode note + conflict marker.
  const note = node.querySelector('.km-warn') as HTMLElement;
  const messages: string[] = [];
  const amNote = alwaysModeNote(entry.keys);
  if (amNote) messages.push(amNote);
  if (dupes.has(entry.keys)) messages.push(`"${displayKeys(entry.keys)}" is bound to more than one command.`);
  if (messages.length > 0) {
    note.textContent = '⚠';
    note.title = messages.join('\n');
    note.classList.toggle('conflict', dupes.has(entry.keys));
  }

  const del = node.querySelector('.km-delete') as HTMLButtonElement;
  del.addEventListener('click', () => {
    keymap = keymap.filter((_, i) => i !== index);
    save();
    render();
  });

  return node;
}

function renderKeyButton(btn: HTMLButtonElement, entry: KeymapEntry): void {
  btn.textContent = entry.keys ? displayKeys(entry.keys) : 'Set key…';
}

// One-shot key capture: the next real (non-modifier) keypress becomes the
// binding. Bare Escape cancels. Single-combo only — sequences keep their
// stored value (editor v1; see DESIGN_KEYMAP_CONFIG.md).
function beginCapture(btn: HTMLButtonElement, entry: KeymapEntry): void {
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
      renderKeyButton(btn, entry); // cancel — keep prior binding
      return;
    }
    entry.keys = serializeCombo(comboFromEvent(e));
    save();
    render();
  };
  window.addEventListener('keydown', onKey, true);
}

function renderParams(container: HTMLElement, entry: KeymapEntry): void {
  container.replaceChildren();
  const meta = COMMAND_BY_ID.get(entry.command);
  if (!meta || meta.params.length === 0) return;
  for (const schema of meta.params) {
    container.appendChild(renderParamControl(schema, entry));
  }
}

function renderParamControl(schema: ParamSchema, entry: KeymapEntry): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'km-param';
  wrap.textContent = `${schema.name} `;
  const current = entry.params?.[schema.name] ?? schema.default ?? '';

  const setParam = (value: string): void => {
    const params = { ...(entry.params ?? {}) };
    params[schema.name] = value;
    entry.params = params;
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

function addShortcut(): void {
  keymap = [...keymap, { keys: '', command: FIRST_COMMAND }];
  save();
  render();
  // Drop straight into key capture for the new row.
  const last = keymapEl.querySelector('.km-row:last-child .km-capture');
  if (last instanceof HTMLButtonElement) last.click();
}

export async function initKeymapEditor(): Promise<void> {
  keymapEl = document.getElementById('keymap') as HTMLDivElement;
  rowTpl = document.getElementById('keymap-row-template') as HTMLTemplateElement;
  if (!keymapEl || !rowTpl) return; // section absent (older options.html)

  keymap = await loadKeymap();
  render();

  const addBtn = document.getElementById('km-add') as HTMLButtonElement | null;
  addBtn?.addEventListener('click', addShortcut);

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
