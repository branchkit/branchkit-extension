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
  DISPOSITIONS,
  type DispositionKey,
  COMMAND_BY_ID,
  DEFAULT_KEYMAP,
  type CommandMeta,
  type KeymapEntry,
  type ParamSchema,
  type VoicePattern,
} from './command-catalog';
import { micGlyph, keyGlyph } from '../render/mic-glyph';
import { overrideKey, validateOverridePhrase, overridesFromList, type OverrideRecord } from './command-override';
import {
  loadKeymap,
  saveKeymap,
  onKeymapChanged,
  keymapsEqual,
  isCommandCustomized,
  resetCommandIn,
  defaultBindingsFor,
} from './keymap-storage';
import { comboFromEvent, serializeCombo } from '../activate/key-combo';
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

// Every command the editor lists: key-bindable ones AND voice-only ones
// (mappable:false but spoken — the palette/hint landing verbs, caret verbs,
// escape…). mappable gates the KEY column only; the phrase is editable either
// way — "not key-bindable" and "phrase not customizable" are different roles,
// and conflating them left "here"/"stash"/"blank" with no editing surface.
const LISTED = COMMAND_CATALOG.filter((c) => c.mappable || (c.voice?.length ?? 0) > 0);
const GROUPS = [...new Set(LISTED.map((c) => c.group))];

/** " (back to J)" / " (back to unbound)" — names the state a reset returns to,
 *  so the control says what it will do rather than just that it undoes. */
function defaultKeyHint(commandId: string): string {
  const defaults = defaultBindingsFor(commandId);
  if (defaults.length === 0) return ' (back to no shortcut)';
  return ` (back to ${defaults.map((b) => displayKeys(b.keys)).join(', ')})`;
}

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

/**
 * The canonical editing place for shared words (DISPOSITIONS) — one card,
 * one row per word: what it means, the editable word, who speaks it. Every
 * other appearance of the word (member command cards, the palette table) is
 * a projection that NAVIGATES here, so renames happen where the sharing is
 * visible instead of fanning out invisibly from wherever you clicked.
 */
function renderSharedWords(): HTMLElement {
  const card = document.createElement('div');
  card.className = 'km-shared';
  card.id = 'km-shared-words';
  const head = document.createElement('div');
  head.className = 'km-group-head';
  head.textContent = 'Shared words';
  card.appendChild(head);
  const sub = document.createElement('div');
  sub.className = 'km-shared-sub';
  sub.textContent = 'One word, spoken on every surface that has the action — renaming it here renames it everywhere it appears below.';
  card.appendChild(sub);
  for (const key of Object.keys(DISPOSITIONS) as DispositionKey[]) {
    const members = sharedMembers(key);
    if (members.length === 0) continue;
    const row = document.createElement('div');
    row.className = 'km-row km-shared-row';
    row.id = `km-shared-word-${key}`;
    const label = document.createElement('span');
    label.className = 'km-row-label';
    label.textContent = `Opens ${DISPOSITIONS[key].label}`;
    row.appendChild(label);
    const phrases = document.createElement('span');
    phrases.className = 'km-voice-phrases';
    phrases.appendChild(sharedWordChip(key));
    // Added words ("go to" alongside "blank") — the default stays; each is
    // removable and fans exactly like the rename.
    for (const w of aliasWordsForDisposition(key)) {
      const item = document.createElement('span');
      item.className = 'km-voice-item';
      const chip = document.createElement('span');
      chip.className = 'km-voice-phrase km-voice-added';
      chip.textContent = `“${w}”`;
      item.appendChild(chip);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'km-voice-reset';
      remove.textContent = '×';
      remove.title = 'Remove this word — everywhere.';
      remove.addEventListener('click', () => void removeDispositionAlias(key, w));
      item.appendChild(remove);
      phrases.appendChild(item);
    }
    phrases.appendChild(sharedAliasAddButton(key));
    row.appendChild(phrases);
    const usedBy = document.createElement('span');
    usedBy.className = 'km-shared-used';
    usedBy.textContent = members.map((m) => m.meta.label).join(' · ');
    row.appendChild(usedBy);
    card.appendChild(row);
  }
  return card;
}

/** The one editable word chip. Click to edit in place; Enter saves through
 *  the fan-out, Escape/blur cancels; the shipped word resets all members. */
function sharedWordChip(key: DispositionKey): HTMLElement {
  const word = effectiveDispositionWord(key);
  const wrap = document.createElement('span');
  wrap.className = 'km-voice-item';
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'km-voice-phrase shared';
  if (word !== DISPOSITIONS[key].word) chip.classList.add('changed');
  chip.textContent = `\u201c${word}\u201d`;
  chip.title = 'Click to change the word — everywhere it is spoken.';
  chip.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = word;
    input.className = 'km-voice-phrase';
    input.style.width = `${Math.max(word.length + 2, 6)}ch`;
    input.setAttribute('aria-label', 'Shared spoken word');
    chip.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); done = true; render(); return; }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (done) return;
      void saveDispositionWord(key, input.value).then((err) => {
        if (err === null) { done = true; return; } // save re-renders
        input.setCustomValidity(err);
        input.reportValidity();
      });
    });
    input.addEventListener('blur', () => { if (!done) { done = true; render(); } });
    input.addEventListener('input', () => input.setCustomValidity(''));
  });
  wrap.appendChild(chip);
  if (word !== DISPOSITIONS[key].word) {
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'km-voice-reset';
    reset.textContent = '\u21ba';
    reset.title = `Reset to \u201c${DISPOSITIONS[key].word}\u201d — everywhere.`;
    reset.addEventListener('click', () => {
      const m = sharedMembers(key)[0];
      if (m) void resetVoicePattern(m.meta, m.vp); // fans out + re-renders
    });
    wrap.appendChild(reset);
  }
  return wrap;
}

/** Distinct added words for a shared word, across its members ("go to"
 *  alongside "blank"). Exported for the palette table's projection. */
export function aliasWordsForDisposition(key: DispositionKey): string[] {
  const words = new Set<string>();
  for (const m of sharedMembers(key)) {
    for (const a of aliases) {
      if (a.action !== m.meta.id || a.default_pattern !== m.vp.pattern) continue;
      const w = a.new_pattern.split(/\s+/).filter((t) => !t.startsWith('{')).join(' ');
      if (w) words.add(w);
    }
  }
  return [...words];
}

/** Add a second way to say a shared word ("go to" alongside "blank") — an
 *  alias fanned to every member, same one-edit contract as the rename. */
async function addDispositionAlias(key: DispositionKey, word: string): Promise<string | null> {
  const members = sharedMembers(key);
  const first = members[0];
  if (!first) return 'Unknown word.';
  const w = word.trim();
  if (w === effectiveDispositionWord(key)) return 'That is already the word.';
  if (aliasWordsForDisposition(key).includes(w)) return 'Already added.';
  const caps = first.vp.pattern.split(/\s+/).filter((t) => t.startsWith('{'));
  const candidate = [w, ...caps].join(' ');
  const invalid = validateOverridePhrase(first.vp.pattern, candidate);
  if (invalid) return invalid;
  const failures: string[] = [];
  for (const m of members) {
    const target = retargetPattern(candidate, m.vp.pattern);
    const r = await chrome.runtime.sendMessage({
      type: 'ADD_COMMAND_ALIAS',
      action: m.meta.id,
      defaultPattern: m.vp.pattern,
      newPattern: target,
    }).catch(() => ({ ok: false, error: 'Not connected to BranchKit.' }));
    if (r?.ok) aliases = [...aliases, { action: m.meta.id, default_pattern: m.vp.pattern, new_pattern: target }];
    else failures.push(r?.error || `Could not add for “${m.meta.label}”.`);
  }
  render();
  return failures[0] ?? null;
}

/** Remove an added word from every member. */
async function removeDispositionAlias(key: DispositionKey, word: string): Promise<void> {
  for (const m of sharedMembers(key)) {
    const mine = aliases.filter((a) => {
      if (a.action !== m.meta.id || a.default_pattern !== m.vp.pattern) return false;
      return a.new_pattern.split(/\s+/).filter((t) => !t.startsWith('{')).join(' ') === word;
    });
    for (const a of mine) {
      const r = await chrome.runtime.sendMessage({
        type: 'REMOVE_COMMAND_ALIAS',
        action: a.action,
        defaultPattern: a.default_pattern,
        newPattern: a.new_pattern,
      }).catch(() => ({ ok: false }));
      if (r?.ok) {
        aliases = aliases.filter((x) => !(
          x.action === a.action && x.default_pattern === a.default_pattern && x.new_pattern === a.new_pattern
        ));
      }
    }
  }
  render();
}

/** The card's "+ word" — add a second accepted word without losing the
 *  default. Same inline-input shape as the word chip's editor. */
function sharedAliasAddButton(key: DispositionKey): HTMLButtonElement {
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'km-voice-add';
  add.textContent = '+ word';
  add.title = 'Add another word that means the same thing — on every surface.';
  add.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'km-voice-phrase';
    input.placeholder = 'another word';
    input.style.width = '12ch';
    input.setAttribute('aria-label', 'Add a shared spoken word');
    add.replaceWith(input);
    input.focus();
    let done = false;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); done = true; render(); return; }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (done || input.value.trim() === '') return;
      void addDispositionAlias(key, input.value).then((err) => {
        if (err === null) { done = true; return; } // add re-renders
        input.setCustomValidity(err);
        input.reportValidity();
      });
    });
    input.addEventListener('blur', () => { if (!done) { done = true; render(); } });
    input.addEventListener('input', () => input.setCustomValidity(''));
  });
  return add;
}

/** Scroll the canonical card's row for `key` into view and flash it — the
 *  landing half of every projection's click-to-go. */
export function navigateToSharedWord(key: DispositionKey): void {
  const row = document.getElementById(`km-shared-word-${key}`);
  if (!row) return;
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row.classList.remove('km-flash');
  void (row as HTMLElement).offsetWidth; // restart the animation
  row.classList.add('km-flash');
}

// Other same-page projections of the voice customizations (the palette
// landing-spot table) re-render off this — one owner of override state
// (this module), N views. Fired from render(), which every mutation path
// already funnels through.
const voiceChangeListeners: Array<() => void> = [];
export function onVoiceCustomizationsChanged(cb: () => void): void {
  voiceChangeListeners.push(cb);
}

function render(): void {
  for (const cb of voiceChangeListeners) cb();
  keymapEl.replaceChildren();
  // Voice reset only exists when there's a BranchKit to reset against (the
  // overrides live in the actuator). Shown whenever connected — even with nothing
  // customized — so the capability is discoverable rather than appearing only
  // once you've already changed something.
  const voiceResetBtn = document.getElementById('km-reset-voice');
  if (voiceResetBtn) voiceResetBtn.hidden = !voiceConnected;
  if (voiceLoaded && !voiceConnected) {
    const note = document.createElement('div');
    note.className = 'km-voice-note';
    note.textContent = 'Voice phrases unavailable — BranchKit isn’t running. Start it to see what you can say for each command.';
    keymapEl.appendChild(note);
  }
  // The canonical shared-words card leads: the projections below it (member
  // command cards) navigate back up here.
  keymapEl.appendChild(renderSharedWords());
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
    const inGroup = LISTED.filter((c) => c.group === group)
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
  // Voice-only commands (mappable:false — the target is a runtime spoken
  // value) are listed for their EDITABLE PHRASE; the keys cell says why it's
  // empty and offers nothing to click. No keyboard glyph — there is no
  // "press this" to mark.
  if (!meta.mappable) {
    const none = document.createElement('span');
    none.className = 'km-no-shortcut';
    none.textContent = 'voice only';
    none.title = 'This command takes a spoken value (a badge word), so it has no key form.';
    keys.appendChild(none);
    row.appendChild(keys);
    if (meta.voice && meta.voice.length > 0) row.appendChild(renderVoiceRow(meta));
    return row;
  }
  keys.appendChild(keyGlyph()); // the mic's twin — "press this" beside "say this"
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

  // Per-command reset — only when this command's keys differ from what ships, so
  // its presence IS the "you changed this" signal and it's never a no-op click.
  // Staged like every other key edit: Save applies, Cancel brings the edit back.
  if (isCommandCustomized(keymap, meta.id)) {
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'km-keys-reset';
    reset.textContent = '↺';
    reset.title = `Reset “${meta.label}” to its default key${
      defaultKeyHint(meta.id)}`;
    reset.addEventListener('click', () => {
      keymap = resetCommandIn(keymap, meta.id);
      render();
    });
    keys.appendChild(reset);
  }
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
  row.appendChild(micGlyph());
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
  // Fully-shared commands add words on the Shared-words card instead — a
  // per-command add here would be exactly the drift the card exists to end.
  const allShared = (meta.voice ?? []).every((v) => v.sharedWord !== undefined);
  if (!disconnected && !allShared) phrases.appendChild(makeVoiceAddButton(meta));

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

async function removeAlias(_meta: CommandMeta, alias: OverrideRecord): Promise<void> {
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
  if (vp.sharedWord) {
    // A shared word has ONE editing place — the "Shared words" card. This
    // chip is a projection: clicking it takes you there, so the linkage is
    // learned by using it rather than discovered after an invisible fan-out.
    const key = vp.sharedWord;
    phrase.classList.add('shared');
    phrase.title = 'A shared word — rename it once under “Shared words”. Click to go there.';
    phrase.addEventListener('click', () => navigateToSharedWord(key));
    wrap.appendChild(phrase);
    return;
  }
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


// --- Shared-word fan-out (DISPOSITIONS, command-catalog.ts) ---
//
// A pattern tagged `sharedWord` speaks a vocabulary word that other surfaces
// speak too ("stash" on page badges AND palette rows — one feature across
// boundaries). The editor treats the WORD as the thing being edited: saving
// or resetting any member fans the change to every member, so the surfaces
// cannot drift apart. Overrides stay per-command on the wire (no schema
// change); the fan-out is what makes them one edit.

/** Every (command, pattern) speaking this shared word. */
function sharedMembers(key: NonNullable<VoicePattern['sharedWord']>): Array<{ meta: CommandMeta; vp: VoicePattern }> {
  const out: Array<{ meta: CommandMeta; vp: VoicePattern }> = [];
  for (const meta of COMMAND_CATALOG) {
    for (const vp of meta.voice ?? []) {
      if (vp.sharedWord === key) out.push({ meta, vp });
    }
  }
  return out;
}

/** The edited pattern re-targeted at another member: same words, the member's
 *  own capture slots swapped in positionally ({palette} → {hint+}…). */
function retargetPattern(edited: string, memberDefault: string): string {
  const memberCaps = memberDefault.split(/\s+/).filter((t) => t.startsWith('{'));
  let i = 0;
  return edited.split(/\s+/)
    .map((t) => (t.startsWith('{') ? memberCaps[i++] ?? t : t))
    .join(' ');
}

/**
 * The disposition word as the user currently speaks it — the first member's
 * effective pattern minus its capture slots. The palette settings table
 * renders and edits THIS, never its own copy.
 */
export function effectiveDispositionWord(key: DispositionKey): string {
  const m = sharedMembers(key)[0];
  if (!m) return DISPOSITIONS[key].word;
  const eff = overrides.get(overrideKey(m.meta.id, m.vp.pattern)) ?? m.vp.pattern;
  const words = eff.split(/\s+/).filter((t) => !t.startsWith('{'));
  return words.join(' ') || DISPOSITIONS[key].word;
}

/**
 * Save a disposition word from the canonical "Shared words" card: builds the
 * first member's pattern from the word, validates it, and runs the fan-out.
 * Returns null on success or a user-facing error. A word equal to the
 * shipped default resets every member instead.
 */
async function saveDispositionWord(key: DispositionKey, word: string): Promise<string | null> {
  const members = sharedMembers(key);
  if (members.length === 0) return 'Unknown word.';
  const first = members[0];
  const caps = first.vp.pattern.split(/\s+/).filter((t) => t.startsWith('{'));
  const candidate = [word.trim(), ...caps].join(' ');
  if (candidate === first.vp.pattern) {
    await resetVoicePattern(first.meta, first.vp); // fans out
    return null;
  }
  const invalid = validateOverridePhrase(first.vp.pattern, candidate);
  if (invalid) return invalid;
  const failures = await fanOutSharedSave(members, candidate);
  render();
  return failures[0] ?? null;
}


/** The fan-out core shared by in-editor edits and external projections
 *  (saveDispositionWord): write each member's re-targeted override, mirror
 *  successes into the local map, collect failures. */
async function fanOutSharedSave(
  members: Array<{ meta: CommandMeta; vp: VoicePattern }>,
  newPattern: string,
): Promise<string[]> {
  const failures: string[] = [];
  for (const m of members) {
    const target = retargetPattern(newPattern, m.vp.pattern);
    const r = await chrome.runtime.sendMessage({
      type: 'SET_COMMAND_OVERRIDE',
      action: m.meta.id,
      defaultPattern: m.vp.pattern,
      newPattern: target,
    }).catch(() => ({ ok: false, error: 'Not connected to BranchKit.' }));
    if (r?.ok) overrides.set(overrideKey(m.meta.id, m.vp.pattern), target);
    else failures.push(r?.error || `Could not save for \u201c${m.meta.label}\u201d.`);
  }
  return failures;
}

async function saveVoicePattern(meta: CommandMeta, vp: VoicePattern, newPattern: string): Promise<void> {
  // Shared word → one edit, every member. Each member gets the same words
  // re-targeted at its own capture slots. Non-shared patterns are a
  // one-member list of themselves, so both shapes take the same path.
  const members = vp.sharedWord
    ? sharedMembers(vp.sharedWord)
    : [{ meta, vp }];
  const failures = await fanOutSharedSave(members, newPattern);
  render();
  if (failures.length > 0) {
    // Reopen on the row the user edited, naming what failed — successes
    // stand (same partial-failure honesty as resetAllVoice: non-atomic,
    // REPORTED rather than claimed complete).
    const wrap = findVoiceItem(meta.id, vp.pattern);
    if (wrap) editVoicePattern(wrap, meta, vp, newPattern, failures[0]);
  }
}

/**
 * Clear every voice customization: each phrase override back to its catalog
 * default, each added phrase removed. Applies IMMEDIATELY (voice edits do), which
 * is why it's a separate control from the staged key reset.
 *
 * N calls over the lists we already hold rather than a bulk op — reset-all is a
 * rare click and a `commands.clear_overrides` op would be a cross-repo contract
 * change. The tradeoff is that it isn't atomic, so a partial failure is REPORTED
 * rather than leaving the page claiming success over surviving overrides.
 */
async function resetAllVoice(): Promise<void> {
  const btn = document.getElementById('km-reset-voice') as HTMLButtonElement | null;
  const total = overrides.size + aliases.length;
  if (total === 0) {
    showResetStatus('No voice customizations to reset.');
    return;
  }
  if (btn) btn.disabled = true;
  showResetStatus(`Resetting ${total}…`);

  // Snapshot both lists first — the handlers below mutate them as they succeed.
  const overrideKeys = [...overrides.keys()];
  const addedPhrases = [...aliases];
  let failed = 0;

  for (const key of overrideKeys) {
    const [action, defaultPattern] = key.split(String.fromCharCode(0));
    const r = await chrome.runtime.sendMessage({
      type: 'RESET_COMMAND_OVERRIDE', action, defaultPattern,
    }).catch(() => ({ ok: false }));
    if (r?.ok) overrides.delete(key);
    else failed++;
  }
  for (const a of addedPhrases) {
    const r = await chrome.runtime.sendMessage({
      type: 'REMOVE_COMMAND_ALIAS',
      action: a.action, defaultPattern: a.default_pattern, newPattern: a.new_pattern,
    }).catch(() => ({ ok: false }));
    if (r?.ok) {
      aliases = aliases.filter((x) => !(
        x.action === a.action && x.default_pattern === a.default_pattern
        && x.new_pattern === a.new_pattern
      ));
    } else failed++;
  }

  if (btn) btn.disabled = false;
  showResetStatus(
    failed === 0
      ? `Reset ${total} voice customization${total === 1 ? '' : 's'}.`
      : `${total - failed} of ${total} reset — ${failed} failed. Is BranchKit still running?`,
    failed > 0,
  );
  render();
}

/** Transient line beside the reset buttons. Errors persist; successes fade. */
function showResetStatus(message: string, isError = false): void {
  const el = document.getElementById('km-reset-status');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.hidden = false;
  if (resetStatusTimer !== null) clearTimeout(resetStatusTimer);
  if (!isError) {
    resetStatusTimer = self.setTimeout(() => { el.hidden = true; }, 4000);
  }
}
let resetStatusTimer: number | null = null;

async function resetVoicePattern(meta: CommandMeta, vp: VoicePattern): Promise<void> {
  // Same fan-out as save: resetting a shared word resets every member.
  const members = vp.sharedWord ? sharedMembers(vp.sharedWord) : [{ meta, vp }];
  for (const m of members) {
    const r = await chrome.runtime.sendMessage({
      type: 'RESET_COMMAND_OVERRIDE',
      action: m.meta.id,
      defaultPattern: m.vp.pattern,
    }).catch(() => ({ ok: false }));
    if (r?.ok) overrides.delete(overrideKey(m.meta.id, m.vp.pattern));
  }
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
  // Mark keys that differ from what ships, matching the voice phrases' .changed
  // treatment — "this isn't the default" must read the same on both halves of a
  // row. Whole-command granularity, because that's the unit the delta stores.
  if (isCommandCustomized(keymap, entry.command)) keyBtn.classList.add('changed');
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
// Cancels — restoring the previous binding — on Escape OR a click anywhere
// outside the button, so it never traps the user in "press a key" mode. A
// visible hint spells out both exits. Single-combo only — sequences keep their
// stored value (editor v1; see DESIGN_KEYMAP_CONFIG.md).
export function capture(btn: HTMLButtonElement, restore: string, onResult: (keys: string | null) => void): void {
  if (btn.classList.contains('capturing')) return; // already prompting — don't stack
  const isAdd = restore === '+ key';
  btn.textContent = 'press a key…';
  btn.classList.add('capturing');

  const hint = document.createElement('span');
  hint.className = 'km-capture-hint';
  hint.textContent = isAdd ? 'esc or click away to cancel' : 'esc or click away keeps ' + restore;
  btn.closest('.km-keys')?.appendChild(hint);

  let done = false;
  const finish = (result: string | null): void => {
    if (done) return;
    done = true;
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('pointerdown', onOutside, true);
    btn.classList.remove('capturing');
    hint.remove();
    if (result === null) btn.textContent = restore; // put the previous binding back
    onResult(result);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (/^(Control|Alt|Meta|Shift)/.test(e.code)) return; // wait for a real key
    e.preventDefault();
    e.stopPropagation();
    const bare = !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
    if (e.key === 'Escape' && bare) { finish(null); return; }
    finish(serializeCombo(comboFromEvent(e)));
  };
  // A pointer-down anywhere but this button cancels — the intuitive "click out
  // to back out." Capture phase so it beats other click handlers; the initiating
  // click already completed before this listener was added, so it won't self-fire.
  const onOutside = (e: PointerEvent): void => {
    if (e.target !== btn) finish(null);
  };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('pointerdown', onOutside, true);
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

  // "Reset all keys" STAGES the defaults into the draft (revertible via Cancel)
  // instead of persisting immediately — no confirm needed, Save applies.
  const resetBtn = document.getElementById('km-reset') as HTMLButtonElement | null;
  resetBtn?.addEventListener('click', () => {
    keymap = cloneKeymap(DEFAULT_KEYMAP);
    render();
  });

  document.getElementById('km-reset-voice')?.addEventListener('click', () => {
    void resetAllVoice();
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
