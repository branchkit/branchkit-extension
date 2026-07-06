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
  type VoicePattern,
} from './command-catalog';
import { overrideKey, validateOverridePhrase } from './command-override';
import {
  loadKeymap,
  saveKeymap,
  resetKeymap,
  onKeymapChanged,
  keymapsEqual,
} from './keymap-storage';
import { comboFromEvent, serializeCombo } from './activate/key-combo';
import { displayKeys, duplicateKeys } from './keymap-edit-helpers';
import { nativeOverride, detectOS, detectBrowser } from './browser-shortcuts';

const OS = detectOS();
const BROWSER = detectBrowser();

let keymap: KeymapEntry[] = [];
let suppressEcho = false;
// Voice phrases come from the command catalog (the extension owns them). The
// only runtime signal is whether BranchKit is connected, which gates the
// not-connected note; `voiceLoaded` avoids flashing it before the probe lands.
let voiceConnected = false;
let voiceLoaded = false;
// User phrase overrides, keyed by overrideKey(command id, default pattern) →
// the replacement phrase. Loaded from the actuator via the plugin; the editor
// is the only writer. See notes/DESIGN_COMMAND_PHRASE_OVERRIDES.md.
let overrides = new Map<string, string>();

let keymapEl: HTMLDivElement;

const MAPPABLE = COMMAND_CATALOG.filter((c) => c.mappable);
const GROUPS = [...new Set(MAPPABLE.map((c) => c.group))];

// Mic glyph preceding a voice phrase, matching the ? help overlay so the two
// keyboard surfaces present spoken forms identically. Inline SVG (static, no
// page input) — copied from render/help-overlay.ts's MIC_SVG.
const MIC_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="9" y="2" width="6" height="12" rx="3"/>' +
  '<path d="M5 11a7 7 0 0 0 14 0"/><line x1="12" y1="18" x2="12" y2="22"/></svg>';

function save(): void {
  suppressEcho = true;
  saveKeymap(keymap);
}

function render(): void {
  keymapEl.replaceChildren();
  if (voiceLoaded && !voiceConnected) {
    const note = document.createElement('div');
    note.className = 'km-voice-note';
    note.textContent = 'Voice phrases unavailable — BranchKit isn’t running. Start it to see what you can say for each command.';
    keymapEl.appendChild(note);
  }
  const dupes = duplicateKeys(keymap);
  const isBound = (c: CommandMeta): boolean => keymap.some((e) => e.command === c.id);
  for (const group of GROUPS) {
    const head = document.createElement('div');
    head.className = 'km-group-head';
    head.textContent = group;
    keymapEl.appendChild(head);
    // Bound commands first, then the unbound (optional) ones — a stable sort so
    // catalog order holds within each partition. Keeps "No key bound" cards from
    // dominating the top of a group (e.g. Hints' show/hide verbs sit below the
    // bound Ctrl+S toggle + f hint-mode).
    const inGroup = MAPPABLE.filter((c) => c.group === group)
      .sort((a, b) => Number(isBound(b)) - Number(isBound(a)));
    for (const cmd of inGroup) {
      keymapEl.appendChild(renderCommand(cmd, dupes));
    }
  }
}

// One command = one dense row: label (left, description in its tooltip), then
// the key pills + an inline add, then the voice phrase. No per-command box —
// the group's rows read as a table under the accent section header.
function renderCommand(meta: CommandMeta, dupes: Set<string>): HTMLElement {
  const row = document.createElement('div');
  row.className = 'km-row';
  const entries = keymap.filter((e) => e.command === meta.id);
  // Recede unbound (optional) commands so bound ones lead the eye.
  if (entries.length === 0) row.classList.add('unbound');

  const label = document.createElement('span');
  label.className = 'km-row-label';
  label.textContent = meta.label;
  label.title = meta.description; // description → tooltip keeps the row single-line
  row.appendChild(label);

  const keys = document.createElement('div');
  keys.className = 'km-keys';
  for (const entry of entries) keys.appendChild(renderBinding(entry, dupes));

  // Inline add-key — a dashed pill sitting right after the existing keys, where
  // the eye already is (not a far-corner button).
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'km-addkey';
  add.textContent = '+ key';
  add.title = `Add a key for “${meta.label}”`;
  add.addEventListener('click', () => {
    capture(add, '+ key', (k) => {
      if (!k) return;
      keymap = [...keymap, { keys: k, command: meta.id }];
      save();
      render();
    });
  });
  keys.appendChild(add);
  row.appendChild(keys);

  // Voice phrase on the same row — "or say this" beside "press this". Read-only
  // (phrases are extension-owned), grayed when BranchKit voice is disconnected.
  if (meta.voice && meta.voice.length > 0) row.appendChild(renderVoiceRow(meta));
  return row;
}

// The mic-glyphed voice phrase(s). Each phrase is editable when BranchKit is
// connected: click to change what you say, with a "changed" mark + reset when a
// user override is active. Grayed + read-only when voice is disconnected (the
// override lives in the actuator, reached through the plugin). Mirrors the ?
// help overlay's voice styling so "say this" reads the same on both surfaces.
function renderVoiceRow(meta: CommandMeta): HTMLElement {
  const row = document.createElement('div');
  row.className = 'km-row-voice';
  const disconnected = voiceLoaded && !voiceConnected;
  if (disconnected) {
    row.classList.add('disconnected');
    row.title = 'Connect BranchKit to use voice commands.';
  }
  row.innerHTML = MIC_SVG;
  const phrases = document.createElement('span');
  phrases.className = 'km-voice-phrases';
  const vps = meta.voice ?? [];
  vps.forEach((vp, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'km-voice-sep';
      sep.textContent = '/';
      phrases.appendChild(sep);
    }
    phrases.appendChild(renderVoicePattern(meta, vp, disconnected));
  });
  row.appendChild(phrases);
  return row;
}

// One spoken form: the effective phrase (override or default) as a button that
// opens an inline editor, plus a reset control when overridden.
function renderVoicePattern(meta: CommandMeta, vp: VoicePattern, disconnected: boolean): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'km-voice-item';
  wrap.dataset.key = meta.id + ' ' + vp.pattern; // for async save-error reopen

  const custom = overrides.get(overrideKey(meta.id, vp.pattern));
  const effective = custom ?? vp.pattern;

  const phrase = document.createElement('button');
  phrase.type = 'button';
  phrase.className = 'km-voice-phrase';
  if (custom !== undefined) phrase.classList.add('changed');
  phrase.textContent = effective;
  if (disconnected) {
    phrase.disabled = true;
  } else {
    phrase.title = 'Click to change what you say';
    phrase.addEventListener('click', () => editVoicePattern(wrap, meta, vp));
  }
  wrap.appendChild(phrase);

  if (custom !== undefined && !disconnected) {
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'km-voice-reset';
    reset.textContent = '↺';
    reset.title = 'Reset to the default phrase';
    reset.addEventListener('click', () => void resetVoicePattern(meta, vp));
    wrap.appendChild(reset);
  }
  return wrap;
}

// Swap the phrase button for an inline text input with live validation.
function editVoicePattern(
  wrap: HTMLElement,
  meta: CommandMeta,
  vp: VoicePattern,
  initialValue?: string,
  initialError?: string,
): void {
  const effective = initialValue ?? overrides.get(overrideKey(meta.id, vp.pattern)) ?? vp.pattern;

  const editor = document.createElement('span');
  editor.className = 'km-voice-edit';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'km-voice-input';
  input.value = effective;
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Spoken phrase');

  const err = document.createElement('span');
  err.className = 'km-voice-err';

  const validate = (): string | null => {
    const msg = validateOverridePhrase(vp.pattern, input.value);
    err.textContent = msg ?? '';
    input.classList.toggle('invalid', msg !== null);
    return msg;
  };

  const commit = (): void => {
    if (validate() !== null) return; // stay in the editor on invalid input
    const value = input.value.trim();
    if (value === vp.pattern) {
      // Reverted to the default: drop any existing override.
      if (overrides.has(overrideKey(meta.id, vp.pattern))) void resetVoicePattern(meta, vp);
      else render();
      return;
    }
    void saveVoicePattern(meta, vp, value);
  };

  input.addEventListener('input', validate);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); render(); }
  });

  editor.appendChild(input);
  editor.appendChild(err);
  wrap.replaceChildren(editor);
  input.focus();
  input.select();
  if (initialError) { err.textContent = initialError; input.classList.add('invalid'); }
  else validate();
}

async function saveVoicePattern(meta: CommandMeta, vp: VoicePattern, newPattern: string): Promise<void> {
  const r = await chrome.runtime.sendMessage({
    type: 'SET_COMMAND_OVERRIDE',
    action: meta.id,
    defaultPattern: vp.pattern,
    newPattern,
  }).catch(() => ({ ok: false, error: 'Not connected to BranchKit.' }));

  if (r?.ok) {
    overrides.set(overrideKey(meta.id, vp.pattern), newPattern);
    render();
    return;
  }
  // Server rejected it (rare — the client mirror catches most). Reopen the
  // editor on the same row with the attempted value and the server's message.
  render();
  const wrap = findVoiceItem(meta.id, vp.pattern);
  if (wrap) editVoicePattern(wrap, meta, vp, newPattern, r?.error || 'Could not save the phrase.');
}

async function resetVoicePattern(meta: CommandMeta, vp: VoicePattern): Promise<void> {
  const r = await chrome.runtime.sendMessage({
    type: 'RESET_COMMAND_OVERRIDE',
    action: meta.id,
    defaultPattern: vp.pattern,
  }).catch(() => ({ ok: false }));
  if (r?.ok) overrides.delete(overrideKey(meta.id, vp.pattern));
  render();
}

// Locate a freshly-rendered voice item so an async save error can reopen it.
function findVoiceItem(commandId: string, pattern: string): HTMLElement | null {
  const key = commandId + ' ' + pattern;
  return keymapEl.querySelector<HTMLElement>(`.km-voice-item[data-key="${CSS.escape(key)}"]`);
}

// One binding = a key pill with the remove ✕ attached to the key it removes
// (not stranded on the far right), plus any conflict warning + params.
function renderBinding(entry: KeymapEntry, dupes: Set<string>): HTMLElement {
  const group = document.createElement('span');
  group.className = 'km-bind-group';

  const pill = document.createElement('span');
  pill.className = 'km-bind';

  const keyBtn = document.createElement('button');
  keyBtn.type = 'button';
  keyBtn.className = 'km-keycap';
  keyBtn.textContent = displayKeys(entry.keys);
  keyBtn.title = 'Click to rebind';
  keyBtn.addEventListener('click', () => {
    capture(keyBtn, displayKeys(entry.keys), (k) => {
      if (!k) return;
      entry.keys = k;
      save();
      render();
    });
  });
  pill.appendChild(keyBtn);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'km-keycap-remove';
  remove.textContent = '×';
  remove.title = `Remove ${displayKeys(entry.keys)}`;
  remove.addEventListener('click', () => {
    keymap = keymap.filter((e) => e !== entry);
    save();
    render();
  });
  pill.appendChild(remove);
  group.appendChild(pill);

  // Conflict / native-override warning, right beside the pill it concerns.
  const messages: string[] = [];
  const override = nativeOverride(entry.keys, OS, BROWSER);
  if (override) messages.push(`Overrides the browser's "${override}" shortcut.`);
  const conflict = dupes.has(entry.keys);
  if (conflict) messages.push(`"${displayKeys(entry.keys)}" is bound to more than one command.`);
  if (messages.length > 0) {
    const warn = document.createElement('span');
    warn.className = conflict ? 'km-warn conflict' : 'km-warn';
    warn.textContent = '⚠';
    warn.title = messages.join('\n');
    group.appendChild(warn);
  }

  // Params (e.g. goto_tab's index) inline after the key.
  const params = document.createElement('span');
  params.className = 'km-binding-params';
  renderParams(params, entry);
  if (params.children.length > 0) group.appendChild(params);

  return group;
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
  if (!keymapEl) return; // section absent (older options.html)

  keymap = await loadKeymap();
  render();

  // Voice phrases render synchronously from the catalog; only probe BranchKit's
  // connection state so the not-connected note appears when voice is inactive.
  void chrome.runtime.sendMessage({ type: 'GET_VOICE_STATUS' })
    .then((r: { connected?: boolean } | undefined) => {
      voiceConnected = r?.connected ?? false;
      voiceLoaded = true;
      render();
    })
    .catch(() => {
      voiceLoaded = true;
      render();
    });

  // Load any existing phrase overrides so changed rows prefill + mark. Best
  // effort — absent (disconnected) just means no overrides shown.
  void chrome.runtime.sendMessage({ type: 'GET_COMMAND_OVERRIDES' })
    .then((r: { overrides?: Array<{ action: string; default_pattern: string; new_pattern: string }> } | undefined) => {
      overrides = new Map((r?.overrides ?? []).map((o) => [overrideKey(o.action, o.default_pattern), o.new_pattern]));
      render();
    })
    .catch(() => {});

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
