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
  DEFAULT_KEYMAP,
  type CommandMeta,
  type KeymapEntry,
  type ParamSchema,
  type VoicePattern,
} from './command-catalog';
import { overrideKey, validateOverridePhrase, overridesFromList, type OverrideRecord } from './command-override';
import {
  loadKeymap,
  saveKeymap,
  onKeymapChanged,
  keymapsEqual,
} from './keymap-storage';
import { comboFromEvent, serializeCombo } from './activate/key-combo';
import { displayKeys, duplicateKeys } from './keymap-edit-helpers';
import { nativeOverride, detectOS, detectBrowser } from './browser-shortcuts';

const OS = detectOS();
const BROWSER = detectBrowser();

// Keybinding edits are STAGED: `keymap` is the working draft the UI mutates;
// `savedKeymap` is the last-persisted baseline. Nothing hits storage until the
// user clicks Save; Cancel reverts the draft to the baseline (so a fumbled
// rebind can't silently clobber the previous binding). Voice edits keep their
// own per-edit Enter/Escape commit — they apply live for testing.
let keymap: KeymapEntry[] = [];
let savedKeymap: KeymapEntry[] = [];
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
// User-added spoken forms (the "+ voice" free list), as flat records
// {action(=command id), default_pattern, new_pattern}. Filtered per command
// at render time.
let aliases: OverrideRecord[] = [];

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

/** Deep-clone a keymap so the draft and baseline never share entry/param
 * objects (edits mutate entries in place). */
export function cloneKeymap(k: readonly KeymapEntry[]): KeymapEntry[] {
  return k.map((e) => ({ ...e, ...(e.params ? { params: { ...e.params } } : {}) }));
}

/** True when the draft differs from the last-saved baseline. */
function isDirty(): boolean {
  return !keymapsEqual(keymap, savedKeymap);
}

/** Persist the draft and make it the new baseline. */
function commitKeymap(): void {
  suppressEcho = true;
  saveKeymap(keymap);
  savedKeymap = cloneKeymap(keymap);
  updateSaveBar();
}

/** Show/hide the sticky Save/Cancel bar based on the dirty state. */
function updateSaveBar(): void {
  const bar = document.getElementById('km-savebar');
  if (bar) bar.hidden = !isDirty();
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
  updateSaveBar();
}

// One command = one dense row: label (left, description in its tooltip), then
// the key pills + an inline add, then the voice phrase. No per-command box —
// the group's rows read as a table under the accent section header.
function renderCommand(meta: CommandMeta, dupes: Set<string>): HTMLElement {
  const row = document.createElement('div');
  row.className = 'km-row';
  row.dataset.command = meta.id; // for async add-alias error reopen
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
  // Unbound is a valid, permanent state — the command still exists (and stays
  // voice-reachable). Show a calm "no shortcut" so it reads as optional, not
  // removed; commands are never deletable (they come from the catalog).
  if (entries.length === 0) {
    const none = document.createElement('span');
    none.className = 'km-no-shortcut';
    none.textContent = 'no shortcut';
    keys.appendChild(none);
  }
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
      render(); // stages into the draft; Save/Cancel bar reflects it
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
  // Each phrase is a self-contained chip (no "/" separators — those strand at
  // line-wraps). Chips read cleanly however the row wraps, like the key pills.
  for (const vp of meta.voice ?? []) {
    phrases.appendChild(renderVoicePattern(meta, vp, disconnected));
  }

  // User-added extra spoken forms (aliases) — each removable, like a keybind.
  for (const a of aliasesForCommand(meta.id)) {
    phrases.appendChild(renderAliasPhrase(meta, a, disconnected));
  }

  // "+ voice" — the free-list add, mirroring the keys' "+ key". Only when
  // connected (the phrase is stored in the actuator through the plugin).
  if (!disconnected) phrases.appendChild(makeVoiceAddButton(meta));

  row.appendChild(phrases);
  return row;
}

// The dashed "+ voice" button. Extracted so the inline editor can restore it in
// place on cancel (a local swap, not a full re-render — a re-render mid-click
// would destroy the element the next click is headed for).
function makeVoiceAddButton(meta: CommandMeta): HTMLButtonElement {
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'km-voice-add';
  add.textContent = '+ voice';
  add.title = `Add another way to say “${meta.label}”`;
  add.addEventListener('click', () => addAliasEditor(add, meta));
  return add;
}

/** The user's added phrases for a command, in stored order. */
function aliasesForCommand(commandId: string): OverrideRecord[] {
  return aliases.filter((a) => a.action === commandId);
}

/** The base pattern a "+ voice" add clones — the command's primary spoken form
 * (its params are what the added phrase inherits; a per-phrase picker is a
 * later nicety for multi-pattern commands). */
function primaryPattern(meta: CommandMeta): string | null {
  return meta.voice?.[0]?.pattern ?? null;
}

// An added phrase: a removable chip (the free-list analog of a key pill).
function renderAliasPhrase(meta: CommandMeta, alias: OverrideRecord, disconnected: boolean): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'km-voice-item';

  const phrase = document.createElement('span');
  phrase.className = 'km-voice-phrase km-voice-added';
  phrase.textContent = alias.new_pattern;
  wrap.appendChild(phrase);

  if (!disconnected) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'km-voice-reset';
    remove.textContent = '×';
    remove.title = 'Remove this phrase';
    remove.addEventListener('click', () => void removeAlias(meta, alias));
    wrap.appendChild(remove);
  }
  return wrap;
}

// Inline input to add a new spoken form. Validated against the command's
// primary phrase so the added phrase keeps the same placeholders (params ride
// along from the base). Dismisses on blur/Escape, saves on Enter.
function addAliasEditor(addBtn: HTMLElement, meta: CommandMeta, initialValue = '', initialError?: string): void {
  const base = primaryPattern(meta);
  if (base === null) return;
  openInlineEditor({
    base,
    initial: initialValue,
    placeholder: 'another way to say it',
    ariaLabel: `Add a spoken phrase for ${meta.label}`,
    initialError,
    mount: (editor) => addBtn.replaceWith(editor),
    restore: (editor) => editor.replaceWith(makeVoiceAddButton(meta)),
    commit: (value) => void saveAlias(meta, base, value),
  });
}

async function saveAlias(meta: CommandMeta, base: string, newPattern: string): Promise<void> {
  const r = await chrome.runtime.sendMessage({
    type: 'ADD_COMMAND_ALIAS',
    action: meta.id,
    defaultPattern: base,
    newPattern,
  }).catch(() => ({ ok: false, error: 'Not connected to BranchKit.' }));

  if (r?.ok) {
    aliases = [...aliases, { action: meta.id, default_pattern: base, new_pattern: newPattern }];
    render();
    return;
  }
  // Server rejected it (rare — the client mirror catches most). Reopen the add
  // editor with the attempted value + message.
  render();
  const addBtn = findVoiceAddButton(meta.id);
  if (addBtn) addAliasEditor(addBtn, meta, newPattern, r?.error || 'Could not add the phrase.');
}

async function removeAlias(meta: CommandMeta, alias: OverrideRecord): Promise<void> {
  const r = await chrome.runtime.sendMessage({
    type: 'REMOVE_COMMAND_ALIAS',
    action: alias.action,
    defaultPattern: alias.default_pattern,
    newPattern: alias.new_pattern,
  }).catch(() => ({ ok: false }));
  if (r?.ok) {
    aliases = aliases.filter((a) => !(
      a.action === alias.action && a.default_pattern === alias.default_pattern && a.new_pattern === alias.new_pattern
    ));
  }
  render();
}

// Locate a freshly-rendered "+ voice" button so an async add error can reopen it.
function findVoiceAddButton(commandId: string): HTMLElement | null {
  return keymapEl.querySelector<HTMLElement>(`.km-row[data-command="${CSS.escape(commandId)}"] .km-voice-add`);
}

// One spoken form: the effective phrase (override or default) as a button that
// opens an inline editor, plus a reset control when overridden.
function renderVoicePattern(meta: CommandMeta, vp: VoicePattern, disconnected: boolean): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'km-voice-item';
  wrap.dataset.key = meta.id + ' ' + vp.pattern; // for async save-error reopen
  fillVoicePatternItem(wrap, meta, vp, disconnected);
  return wrap;
}

// Populate a voice-item wrapper with the phrase button (+ reset when
// overridden). Shared by initial render and the editor's cancel-restore, so a
// cancel repaints just this item rather than the whole list.
function fillVoicePatternItem(wrap: HTMLElement, meta: CommandMeta, vp: VoicePattern, disconnected = false): void {
  wrap.replaceChildren();
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
}

// Swap the phrase button for an inline text input. Dismisses on blur/Escape,
// saves on Enter (Enter on an invalid phrase keeps the editor open to fix).
function editVoicePattern(
  wrap: HTMLElement,
  meta: CommandMeta,
  vp: VoicePattern,
  initialValue?: string,
  initialError?: string,
): void {
  const effective = initialValue ?? overrides.get(overrideKey(meta.id, vp.pattern)) ?? vp.pattern;
  openInlineEditor({
    base: vp.pattern,
    initial: effective,
    selectAll: true,
    ariaLabel: 'Spoken phrase',
    initialError,
    mount: (editor) => wrap.replaceChildren(editor),
    restore: () => fillVoicePatternItem(wrap, meta, vp),
    // Typing exactly what's already shown is not a change — just close.
    isNoChange: (value) => value === effective,
    commit: (value) => {
      if (value === vp.pattern) {
        // Reverted to the default: drop any existing override.
        if (overrides.has(overrideKey(meta.id, vp.pattern))) void resetVoicePattern(meta, vp);
        else fillVoicePatternItem(wrap, meta, vp);
      } else {
        void saveVoicePattern(meta, vp, value);
      }
    },
  });
}

/** A well-behaved inline text editor for a spoken phrase, shared by the
 * override (edit) and alias (add) flows. Handles focus, live validation, and
 * the three exits every inline field needs but the first cut lacked:
 *   - Enter  → commit if valid + non-empty + changed (invalid keeps it open),
 *   - Escape → cancel,
 *   - blur   → cancel (click-away dismisses; the field never lingers).
 * `restore` repaints the item locally on cancel (no full re-render, which would
 * race the click that dismissed it). A `done` latch keeps the async commit from
 * double-firing with the blur it triggers. */
export interface InlineEditorSpec {
  base: string;                        // pattern the new phrase must match placeholders of
  initial: string;
  ariaLabel: string;
  placeholder?: string;
  selectAll?: boolean;
  initialError?: string;
  mount: (editor: HTMLElement) => void;
  restore: (editor: HTMLElement) => void;
  isNoChange?: (value: string) => boolean;
  commit: (value: string) => void;     // gets a validated, non-empty, changed value
}

export function openInlineEditor(spec: InlineEditorSpec): void {
  const editor = document.createElement('span');
  editor.className = 'km-voice-edit';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'km-voice-input';
  input.value = spec.initial;
  input.spellcheck = false;
  if (spec.placeholder) input.placeholder = spec.placeholder;
  input.setAttribute('aria-label', spec.ariaLabel);

  const err = document.createElement('span');
  err.className = 'km-voice-err';

  const hint = document.createElement('span');
  hint.className = 'km-voice-hint';
  hint.textContent = '↵ save · esc cancel';

  let done = false;
  const validate = (): string | null => {
    const value = input.value.trim();
    const msg = value === '' ? null : validateOverridePhrase(spec.base, value);
    err.textContent = msg ?? '';
    input.classList.toggle('invalid', msg !== null);
    return msg;
  };
  const cancel = (): void => { if (done) return; done = true; spec.restore(editor); };
  const commit = (value: string): void => { if (done) return; done = true; spec.commit(value); };

  input.addEventListener('input', validate);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const value = input.value.trim();
      if (value === '') { cancel(); return; }
      if (validate() !== null) return; // invalid → stay open so the user can fix it
      if (spec.isNoChange?.(value)) { cancel(); return; }
      commit(value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  });
  // Click-away discards the in-progress edit and closes — the field never
  // lingers highlighted. (Enter, which commits, latches `done` first.)
  input.addEventListener('blur', () => cancel());

  editor.appendChild(input);
  editor.appendChild(err);
  editor.appendChild(hint);
  spec.mount(editor);
  input.focus();
  if (spec.selectAll) input.select();
  if (spec.initialError) { err.textContent = spec.initialError; input.classList.add('invalid'); }
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
      render(); // staged — Cancel restores the previous binding
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
    render(); // staged — Cancel brings the key back
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
    updateSaveBar(); // stage without a full re-render (keep the field focused)
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
  savedKeymap = cloneKeymap(keymap);
  wireSaveBar();
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
    .then((r: { overrides?: OverrideRecord[] } | undefined) => {
      overrides = overridesFromList(r?.overrides ?? []);
      render();
    })
    .catch(() => {});

  // Load user-added spoken forms (aliases) so they render + can be removed.
  void chrome.runtime.sendMessage({ type: 'GET_COMMAND_ALIASES' })
    .then((r: { aliases?: OverrideRecord[] } | undefined) => {
      aliases = r?.aliases ?? [];
      render();
    })
    .catch(() => {});

  // "Reset to defaults" now STAGES the defaults into the draft (revertible via
  // Cancel) instead of persisting immediately — no confirm needed, Save applies.
  const resetBtn = document.getElementById('km-reset') as HTMLButtonElement | null;
  resetBtn?.addEventListener('click', () => {
    keymap = cloneKeymap(DEFAULT_KEYMAP);
    render();
  });

  onKeymapChanged((incoming) => {
    if (suppressEcho) {
      suppressEcho = false;
      return; // our own save
    }
    if (keymapsEqual(incoming, savedKeymap)) return; // no change to the baseline
    // Another options tab (or instance) saved. Track the new baseline; adopt it
    // as the draft only when we have no local edits, so an in-progress edit
    // isn't clobbered — Cancel then reverts to the newest saved state.
    const hadEdits = isDirty();
    savedKeymap = cloneKeymap(incoming);
    if (!hadEdits) keymap = cloneKeymap(incoming);
    render();
  });
}

// Wire the sticky Save/Cancel bar (present in options.html; absent in older
// markup, in which case staging still works — just without the bar).
function wireSaveBar(): void {
  document.getElementById('km-save')?.addEventListener('click', () => {
    commitKeymap();
    render();
  });
  document.getElementById('km-discard')?.addEventListener('click', () => {
    keymap = cloneKeymap(savedKeymap);
    render();
  });
}
