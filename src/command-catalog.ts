/**
 * BranchKit Browser — command catalog.
 *
 * Declarative metadata for every dispatchable action: the single source of
 * truth the keymap editor, its param controls, the `?` cheat-sheet, and
 * validation all read. Adding a command = add a catalog entry; the editor
 * and help surface pick it up automatically.
 *
 * Key tokens are canonical combo tokens (key-combo.ts `serializeCombo`):
 * layout-independent `event.code` with modifier prefixes, space-joined for
 * multi-key sequences — "shift+KeyF", "KeyJ", "KeyG KeyG", "Slash". See
 * notes/DESIGN_KEYMAP_CONFIG.md.
 */

export type ParamType = 'number' | 'enum' | 'string';

export interface ParamSchema {
  name: string;
  type: ParamType;
  /** Allowed values, for `type: 'enum'`. */
  options?: readonly string[];
  min?: number;
  max?: number;
  /** Default value, as the string the dispatcher receives. */
  default?: string;
}

export interface CommandMeta {
  id: string;
  label: string;
  group: string;
  description: string;
  /**
   * Statically bindable to a key in the editor. `false` = the action needs a
   * runtime value no static keybind can supply (a spoken/typed codeword, a
   * search query, a page selector), so it's hidden from the editor.
   */
  mappable: boolean;
  params: ParamSchema[];
}

export interface KeymapEntry {
  /** Canonical combo-token sequence (key-combo.ts `serializeCombo`). */
  keys: string;
  command: string;
  params?: Record<string, string>;
}

// Enum option lists mirror the source unions: ScrollDirection / ScrollAmount
// (activate/scroller.ts), Category (types.ts). Kept as literal arrays because
// TS type unions have no runtime form for the editor to enumerate.
const SCROLL_DIRECTIONS = ['up', 'down', 'left', 'right'] as const;
const SCROLL_AMOUNTS = ['step', 'half', 'full', 'top', 'bottom'] as const;
const HINT_CATEGORIES = ['link', 'button', 'input', 'tab', 'edit', 'view', 'tables'] as const;

export const COMMAND_CATALOG: readonly CommandMeta[] = [
  // --- Hints ---
  { id: 'show_hints', label: 'Show hints', group: 'Hints', mappable: true, params: [],
    description: 'Scan the page and paint hint badges.' },
  { id: 'show_hints_newtab', label: 'Show hints (new tab)', group: 'Hints', mappable: true, params: [],
    description: 'Show hints with the next activation armed to open in a new tab.' },
  { id: 'hide_hints', label: 'Hide hints', group: 'Hints', mappable: true, params: [],
    description: 'Remove all hint badges.' },
  { id: 'toggle_hints', label: 'Toggle hints', group: 'Hints', mappable: true, params: [],
    description: 'Show hints when hidden, hide them when shown (sticky across navigation).' },
  { id: 'activate_first_visible', label: 'Activate first hint', group: 'Hints', mappable: true, params: [],
    description: 'Activate the top-left visible hinted element.' },
  { id: 'show_hints_category', label: 'Show hints by category', group: 'Hints', mappable: true,
    description: 'Show only hints of one element category (links, buttons, inputs, …).',
    params: [{ name: 'category', type: 'enum', options: HINT_CATEGORIES, default: 'link' }] },
  { id: 'activate_hint', label: 'Activate hint by codeword', group: 'Hints', mappable: false, params: [],
    description: 'Activate the hint matching a spoken/typed codeword (runtime value — not bindable).' },

  // --- Scroll ---
  { id: 'scroll_down', label: 'Scroll down', group: 'Scroll', mappable: true, params: [],
    description: 'Scroll the page (or cycled target) down one step.' },
  { id: 'scroll_up', label: 'Scroll up', group: 'Scroll', mappable: true, params: [],
    description: 'Scroll the page (or cycled target) up one step.' },
  { id: 'scroll_half_down', label: 'Scroll half-page down', group: 'Scroll', mappable: true, params: [],
    description: 'Scroll down half a viewport.' },
  { id: 'scroll_half_up', label: 'Scroll half-page up', group: 'Scroll', mappable: true, params: [],
    description: 'Scroll up half a viewport.' },
  { id: 'scroll_top', label: 'Scroll to top', group: 'Scroll', mappable: true, params: [],
    description: 'Jump to the top of the page (or cycled target).' },
  { id: 'scroll_bottom', label: 'Scroll to bottom', group: 'Scroll', mappable: true, params: [],
    description: 'Jump to the bottom of the page (or cycled target).' },
  { id: 'scroll_left', label: 'Scroll left', group: 'Scroll', mappable: true, params: [],
    description: 'Scroll left one step.' },
  { id: 'scroll_right', label: 'Scroll right', group: 'Scroll', mappable: true, params: [],
    description: 'Scroll right one step.' },
  { id: 'cycle_scroll_target', label: 'Cycle scroll target', group: 'Scroll', mappable: true, params: [],
    description: 'Cycle which scrollable element the scroll commands act on.' },
  { id: 'scroll', label: 'Scroll (parameterized)', group: 'Scroll', mappable: true,
    description: 'Scroll in a direction by an amount, optionally repeated.',
    params: [
      { name: 'direction', type: 'enum', options: SCROLL_DIRECTIONS, default: 'down' },
      { name: 'amount', type: 'enum', options: SCROLL_AMOUNTS, default: 'step' },
      { name: 'count', type: 'number', min: 1, default: '1' },
    ] },
  { id: 'scroll_to_percent', label: 'Scroll to percent', group: 'Scroll', mappable: true,
    description: 'Scroll to a vertical position given as a percentage of the page.',
    params: [{ name: 'percent', type: 'number', min: 0, max: 100, default: '50' }] },
  { id: 'scroll_to_element', label: 'Scroll to element', group: 'Scroll', mappable: false, params: [],
    description: 'Scroll a specific element into view (runtime selector — not bindable).' },

  // --- Find ---
  { id: 'find_open', label: 'Open find', group: 'Find', mappable: true, params: [],
    description: 'Open the in-page find bar.' },
  { id: 'find_close', label: 'Close find', group: 'Find', mappable: true, params: [],
    description: 'Close the in-page find bar.' },
  { id: 'find_next', label: 'Find next', group: 'Find', mappable: true, params: [],
    description: 'Jump to the next find match.' },
  { id: 'find_previous', label: 'Find previous', group: 'Find', mappable: true, params: [],
    description: 'Jump to the previous find match.' },
  { id: 'find_immediate', label: 'Find immediately', group: 'Find', mappable: false, params: [],
    description: 'Run a find for a given query (runtime query — not bindable).' },

  // --- Tabs ---
  { id: 'next_tab', label: 'Next tab', group: 'Tabs', mappable: true, params: [],
    description: 'Switch to the next tab in the current window.' },
  { id: 'previous_tab', label: 'Previous tab', group: 'Tabs', mappable: true, params: [],
    description: 'Switch to the previous tab in the current window.' },
];

export const COMMAND_BY_ID: ReadonlyMap<string, CommandMeta> = new Map(
  COMMAND_CATALOG.map((c) => [c.id, c]),
);

// The shipping keybinds. This is the source of truth the registry is built
// from; the editor edits a copy of it. Comments show the keys as a user types
// them; the tokens are canonical combos (Shift+F → "shift+KeyF", "gg" → two
// KeyG presses, "/" → "Slash").
export const DEFAULT_KEYMAP: readonly KeymapEntry[] = [
  { keys: 'shift+KeyF', command: 'show_hints_newtab' }, // Shift+F (show, new-tab armed)
  { keys: 'ctrl+KeyF', command: 'toggle_hints' }, // Ctrl+F — show/hide (suppresses native find)
  { keys: 'KeyJ', command: 'scroll_down' },
  { keys: 'KeyK', command: 'scroll_up' },
  { keys: 'KeyD', command: 'scroll_half_down' },
  { keys: 'KeyU', command: 'scroll_half_up' },
  // Shift forms of the scroll commands. While hints are visible (always-mode),
  // bare letters are eaten by the codeword filter, so Shift is the always-mode
  // scroll form; these also fire when hints are hidden, so Shift scrolls
  // regardless of mode. `gg` (two bare g's) can't survive always-mode and has
  // no Shift sequence (Shift+G alone is bottom), so top gets its own Shift+T.
  // (Horizontal scroll has no Shift form: Shift+H/L are tabs.)
  { keys: 'shift+KeyJ', command: 'scroll_down' },
  { keys: 'shift+KeyK', command: 'scroll_up' },
  { keys: 'shift+KeyD', command: 'scroll_half_down' },
  { keys: 'shift+KeyU', command: 'scroll_half_up' },
  { keys: 'KeyG KeyG', command: 'scroll_top' }, // gg
  { keys: 'shift+KeyG', command: 'scroll_bottom' }, // G
  { keys: 'shift+KeyT', command: 'scroll_top' }, // Shift+T — always-mode top
  { keys: 'KeyH', command: 'scroll_left' },
  { keys: 'KeyL', command: 'scroll_right' },
  { keys: 'KeyC KeyS', command: 'cycle_scroll_target' }, // cs
  { keys: 'Slash', command: 'find_open' }, // /
  { keys: 'KeyN', command: 'find_next' },
  { keys: 'shift+KeyN', command: 'find_previous' }, // N
  { keys: 'shift+KeyH', command: 'previous_tab' }, // Shift+H
  { keys: 'shift+KeyL', command: 'next_tab' }, // Shift+L
];
