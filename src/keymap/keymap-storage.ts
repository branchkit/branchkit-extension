/**
 * BranchKit Browser — Keymap persistence.
 *
 * One source of truth for the `chrome.storage.sync.keymap` key. The stored value
 * is a PER-COMMAND DELTA on top of the shipping `DEFAULT_KEYMAP`, not a snapshot
 * of the effective map:
 *
 *   { [commandId]: KeymapBinding[] }   // the command's COMPLETE key list
 *
 *   - command absent  → its DEFAULT_KEYMAP bindings apply
 *   - command present → wholesale replacement of that command's bindings
 *   - []              → explicitly unbound, and it stays unbound
 *
 * Storing a delta is what makes "reset this command to its default" possible at
 * all (a snapshot can't tell a default from an edit), and it's the same shape the
 * voice-phrase override layer already uses — see
 * notes/DESIGN_CUSTOMIZATION_LAYERS.md.
 *
 * Consumers (content.ts's registry, palette-page, the help overlay) still take a
 * flat `KeymapEntry[]`: `loadKeymap()` derives the effective map internally, so
 * the delta stays private to this module. Only the editor needs the delta-aware
 * exports, and only for granular reset + the changed-vs-default mark.
 */

import { DEFAULT_KEYMAP, COMMAND_BY_ID, type KeymapEntry } from './command-catalog';
import { canonicalizeKeys } from '../activate/key-combo';

const STORAGE_KEY = 'keymap';

/**
 * Where the pre-delta array is stashed when migrated. Converting synced storage
 * is the one step git can't undo — reverting the code would leave the new object
 * shape unreadable by the old loader, which silently fell back to defaults. The
 * stash makes the conversion reversible. TRANSITIONAL: deleted with
 * `migrateSnapshot`.
 */
const LEGACY_BACKUP_KEY = 'keymap_pre_delta_backup';

/** One binding in the delta. `command` is the map key, so it isn't stored here. */
export interface KeymapBinding {
  /** Canonical combo-token sequence (key-combo.ts `serializeCombo`). */
  keys: string;
  params?: Record<string, string>;
}

/** commandId → its complete key list. Absent = use the catalog defaults. */
export type KeymapDelta = Record<string, KeymapBinding[]>;

/** The command ids of `DEFAULT_KEYMAP`, in first-appearance order. */
const DEFAULT_COMMAND_ORDER: readonly string[] = [
  ...new Set(DEFAULT_KEYMAP.map((e) => e.command)),
];

function bindingOf(entry: KeymapEntry | KeymapBinding): KeymapBinding {
  const hasParams = entry.params && Object.keys(entry.params).length > 0;
  return {
    // Canonical form (cmd→meta, modifier order) so string comparisons — the
    // changed-vs-default check, the echo skip — see one shape.
    keys: canonicalizeKeys(entry.keys),
    ...(hasParams ? { params: { ...entry.params } } : {}),
  };
}

/** A command's shipping bindings, in `DEFAULT_KEYMAP` order. */
export function defaultBindingsFor(commandId: string): KeymapBinding[] {
  return DEFAULT_KEYMAP.filter((e) => e.command === commandId).map(bindingOf);
}

/** Structural equality of two binding lists (order-sensitive, like the registry). */
function bindingsEqual(a: readonly KeymapBinding[], b: readonly KeymapBinding[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Drop delta entries that don't name a known, bindable command, and bindings
 * that lack a key — defends the registry against malformed or cross-version
 * stored data. An empty list is preserved: it means "deliberately unbound".
 */
export function sanitizeDelta(delta: KeymapDelta): KeymapDelta {
  const out: KeymapDelta = {};
  for (const [command, bindings] of Object.entries(delta ?? {})) {
    const meta = COMMAND_BY_ID.get(command);
    if (!meta || !meta.mappable) continue;
    if (!Array.isArray(bindings)) continue;
    out[command] = bindings
      .filter((b) => b && typeof b.keys === 'string' && b.keys.length > 0)
      .map(bindingOf);
  }
  return out;
}

/**
 * The effective keymap: `DEFAULT_KEYMAP`'s command order with each command's
 * delta bindings substituted in place, then any delta-only command appended.
 *
 * Substituting in place matters — the registry matches first-wins with a partial
 * timeout for sequences, so preserving relative order keeps routing identical
 * for every command the user hasn't customized.
 */
export function effectiveKeymap(delta: KeymapDelta): KeymapEntry[] {
  const clean = sanitizeDelta(delta);
  const out: KeymapEntry[] = [];
  const emit = (command: string, bindings: readonly KeymapBinding[]): void => {
    for (const b of bindings) out.push({ ...bindingOf(b), command });
  };
  for (const command of DEFAULT_COMMAND_ORDER) {
    emit(command, clean[command] ?? defaultBindingsFor(command));
  }
  for (const command of Object.keys(clean)) {
    if (!DEFAULT_COMMAND_ORDER.includes(command)) emit(command, clean[command]);
  }
  return out;
}

/**
 * Derive the delta from a full effective keymap — the inverse of
 * `effectiveKeymap`, used so the editor can keep handing us a flat draft.
 *
 * A command whose bindings equal its defaults gets NO entry (so editing back to
 * the default clears the customization on its own). A command with defaults that
 * the effective map doesn't bind at all becomes `[]` — the effective map is
 * complete, so absence means the user removed it.
 */
export function deltaFromEffective(entries: readonly KeymapEntry[]): KeymapDelta {
  const grouped = new Map<string, KeymapBinding[]>();
  for (const e of entries) {
    if (!e || typeof e.keys !== 'string' || e.keys.length === 0) continue;
    if (typeof e.command !== 'string') continue;
    const meta = COMMAND_BY_ID.get(e.command);
    if (!meta || !meta.mappable) continue;
    const list = grouped.get(e.command);
    if (list) list.push(bindingOf(e));
    else grouped.set(e.command, [bindingOf(e)]);
  }
  const out: KeymapDelta = {};
  for (const [command, bindings] of grouped) {
    if (!bindingsEqual(bindings, defaultBindingsFor(command))) out[command] = bindings;
  }
  // A default-bearing command the effective map omits was deliberately unbound.
  for (const command of DEFAULT_COMMAND_ORDER) {
    if (!grouped.has(command)) out[command] = [];
  }
  return out;
}

/** One command's bindings within a full effective keymap, in order. */
export function bindingsForCommand(
  entries: readonly KeymapEntry[],
  commandId: string,
): KeymapBinding[] {
  return entries.filter((e) => e.command === commandId).map(bindingOf);
}

/**
 * True when a command's bindings in an effective keymap differ from what ships —
 * drives the changed mark and whether a per-command reset renders at all.
 *
 * Takes the effective map rather than a delta because the editor's draft is a
 * flat list; keeping the comparison here means the binding-equality rules
 * (canonical combos, params, order) live in exactly one module.
 */
export function isCommandCustomized(
  entries: readonly KeymapEntry[],
  commandId: string,
): boolean {
  return !bindingsEqual(bindingsForCommand(entries, commandId), defaultBindingsFor(commandId));
}

/**
 * A full effective keymap with one command restored to its shipping bindings.
 * Pure — the editor stages the result behind Save/Cancel.
 *
 * Substitutes in place rather than round-tripping through the delta, which would
 * renormalize the whole list's order and mark the draft dirty on nothing but
 * reordering. A command that was fully unbound gets its defaults appended (the
 * editor groups by command when rendering, so position isn't user-visible).
 */
export function resetCommandIn(
  entries: readonly KeymapEntry[],
  commandId: string,
): KeymapEntry[] {
  const restored = defaultBindingsFor(commandId).map((b) => ({ ...b, command: commandId }));
  const out: KeymapEntry[] = [];
  let inserted = false;
  for (const e of entries) {
    if (e.command === commandId) {
      if (!inserted) { out.push(...restored); inserted = true; }
      continue;
    }
    out.push({ ...e, ...(e.params ? { params: { ...e.params } } : {}) });
  }
  if (!inserted) out.push(...restored);
  return out;
}

/**
 * One-shot migration of the pre-delta format (a flat snapshot of the full
 * effective map). Contract: the effective map does not change across it —
 *
 *   effectiveKeymap(migrateSnapshot(s)) === mergeNewDefaults(sanitizeSnapshot(s))
 *
 * so it computes the old effective map with the old rules and diffs that against
 * the defaults. Faithful by construction, including the awkward case where the
 * old backfill left a command unbound because its default key was occupied.
 *
 * TRANSITIONAL — deleted, along with the two private helpers below, once it has
 * run. See notes/DESIGN_CUSTOMIZATION_LAYERS.md.
 */
export function migrateSnapshot(stored: readonly KeymapEntry[]): KeymapDelta {
  return deltaFromEffective(mergeNewDefaults(sanitizeSnapshot(stored)));
}

/** Pre-delta sanitize: same rules, on the flat snapshot shape. (Transitional.) */
function sanitizeSnapshot(entries: readonly KeymapEntry[]): KeymapEntry[] {
  const out: KeymapEntry[] = [];
  for (const e of entries) {
    if (!e || typeof e.keys !== 'string' || e.keys.length === 0) continue;
    if (typeof e.command !== 'string') continue;
    const meta = COMMAND_BY_ID.get(e.command);
    if (!meta || !meta.mappable) continue;
    out.push({ ...bindingOf(e), command: e.command });
  }
  return out;
}

/**
 * Pre-delta backfill: a default whose command the snapshot doesn't bind AND
 * whose key is free. The heuristic the delta format replaces — kept only so the
 * migration can reproduce the old effective map exactly. (Transitional.)
 */
function mergeNewDefaults(stored: readonly KeymapEntry[]): KeymapEntry[] {
  const boundCommands = new Set(stored.map((e) => e.command));
  const usedKeys = new Set(stored.map((e) => e.keys));
  const out = stored.map((e) => ({ ...e }));
  for (const d of DEFAULT_KEYMAP) {
    if (boundCommands.has(d.command) || usedKeys.has(d.keys)) continue;
    out.push({ ...d });
  }
  return out;
}

/** Read the stored value, migrating the legacy array form. Never throws. */
function readDelta(stored: unknown): KeymapDelta | null {
  if (Array.isArray(stored)) return migrateSnapshot(stored as KeymapEntry[]);
  if (stored && typeof stored === 'object') return sanitizeDelta(stored as KeymapDelta);
  return null;
}

/** The user's delta. Empty object when nothing is stored. */
export async function loadKeymapDelta(): Promise<KeymapDelta> {
  const result = await chrome.storage.sync.get(STORAGE_KEY);
  const stored = result[STORAGE_KEY];
  if (Array.isArray(stored)) {
    // Legacy snapshot: convert and rewrite so the old shape is read exactly once,
    // stashing the original alongside it (see LEGACY_BACKUP_KEY).
    const delta = migrateSnapshot(stored as KeymapEntry[]);
    chrome.storage.sync.set({ [STORAGE_KEY]: delta, [LEGACY_BACKUP_KEY]: stored });
    return delta;
  }
  return readDelta(stored) ?? {};
}

/** The effective keymap — what the registry and every read-only surface want. */
export async function loadKeymap(): Promise<KeymapEntry[]> {
  return effectiveKeymap(await loadKeymapDelta());
}

/**
 * Drop entries that match the shipping bindings — so "edit it back to the
 * default" clears the customization (and its changed mark + reset control) on its
 * own, rather than persisting an identical copy that reads as a user change.
 * Mirrors the voice editor, where typing the default phrase drops the override.
 */
function normalizeDelta(delta: KeymapDelta): KeymapDelta {
  const clean = sanitizeDelta(delta);
  const out: KeymapDelta = {};
  for (const [command, bindings] of Object.entries(clean)) {
    if (!bindingsEqual(bindings, defaultBindingsFor(command))) out[command] = bindings;
  }
  return out;
}

export function saveKeymapDelta(delta: KeymapDelta): void {
  chrome.storage.sync.set({ [STORAGE_KEY]: normalizeDelta(delta) });
}

/** Persist a full effective keymap by diffing it against the defaults. */
export function saveKeymap(entries: readonly KeymapEntry[]): void {
  saveKeymapDelta(deltaFromEffective(entries));
}

/** Drop every key customization, restoring the shipping keymap. */
export function resetKeymap(): void {
  chrome.storage.sync.remove(STORAGE_KEY);
}

/**
 * Subscribe to changes in the `keymap` key, delivering the effective keymap.
 * Fires on writes from this context and from other contexts (other tabs / synced
 * browsers). Callers that want to skip self-originated echoes compare via
 * `keymapsEqual` before reacting.
 */
export function onKeymapChanged(cb: (entries: KeymapEntry[]) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>): void => {
    if (!changes[STORAGE_KEY]) return;
    cb(effectiveKeymap(readDelta(changes[STORAGE_KEY].newValue) ?? {}));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/** Structural equality, for skipping self-originated storage echoes. */
export function keymapsEqual(a: readonly KeymapEntry[], b: readonly KeymapEntry[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
