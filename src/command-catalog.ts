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

/**
 * A spoken form of a command, owned by the extension. When BranchKit is present
 * the extension contributes these up to the browser plugin (the registrar), so
 * voice phrases live in ONE place with the command's keybind and action — never
 * read back from the plugin. See notes/DESIGN_COMMAND_CONTRIBUTION.md.
 */
export interface VoicePattern {
  /**
   * Spoken slot sequence: space-separated literal words plus `{number}` /
   * `{text}` captures (e.g. "scroll down", "scroll down {number}", "find {text}").
   * `{hint}` is the compound hint codeword (prefix + suffix words); `{hint+}`
   * is one-or-more of them, delivered as an ordered target list. The browser
   * plugin expands both into its capture shapes and attaches the hint context
   * gating, so the extension never names collections or platform tags.
   */
  pattern: string;
  /**
   * Action params this phrase binds. Values may reference a capture by name
   * ("{number}" / "{text}"). Omitted = the command's bare action.
   */
  params?: Record<string, string>;
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
  /**
   * Optional spoken forms. Contributed to the browser plugin when BranchKit is
   * connected; also what the voice panel renders. Absent = no voice phrase.
   */
  voice?: readonly VoicePattern[];
  /**
   * For `{hint}` commands only: the command leaves hints painted and live for
   * the next utterance (e.g. stash opens a background tab — focus never moves,
   * the gather continues). The plugin maps this to hint-tag lifecycle: absent
   * means the command ends the hint interaction the way plain activation does.
   */
  retainsHints?: boolean;
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
    description: 'Scan the page and paint hint badges.',
    voice: [{ pattern: 'show' }] },
  { id: 'show_hints_newtab', label: 'Show hints (new tab)', group: 'Hints', mappable: true, params: [],
    description: 'Show hints with the next activation armed to open in a new tab.' },
  { id: 'hide_hints', label: 'Hide hints', group: 'Hints', mappable: true, params: [],
    description: 'Remove all hint badges.',
    voice: [{ pattern: 'hide' }] },
  { id: 'toggle_hints', label: 'Toggle hints', group: 'Hints', mappable: true, params: [],
    description: 'Show hints when hidden, hide them when shown (sticky across navigation).' },
  { id: 'activate_first_visible', label: 'Activate first hint', group: 'Hints', mappable: true, params: [],
    description: 'Activate the top-left visible hinted element.' },
  { id: 'show_hints_category', label: 'Show hints by category', group: 'Hints', mappable: true,
    description: 'Show only hints of one element category (links, buttons, inputs, …).',
    params: [{ name: 'category', type: 'enum', options: HINT_CATEGORIES, default: 'link' }] },
  { id: 'activate_hint', label: 'Activate hint by codeword', group: 'Hints', mappable: false, params: [],
    description: 'Activate the hint matching a spoken/typed codeword (runtime value — not bindable).' },
  // blank / stash — the voice twins of the typed-capital new-tab affordance,
  // which spoken codewords can't express (no capitals in speech). Verbs match
  // the Rango convention; choice rationale in
  // notes/DESIGN_MULTI_TARGET_COMMANDS.md (phase 1).
  { id: 'activate_hint_newtab', label: 'Open hint in new tab', group: 'Hints', mappable: false, params: [],
    description: 'Open the hinted link in a new focused tab.',
    voice: [{ pattern: 'blank {hint}' }] },
  // {hint+} = one or more hint codewords in a single breath ("stash huge gap
  // arch same" opens both) — the plugin expands it to its repeated capture
  // macro and delivers the ordered target list; the SW fans it out per target.
  { id: 'activate_hint_background', label: 'Open hints in background tabs', group: 'Hints', mappable: false, params: [],
    description: 'Open one or more hinted links in background tabs; hints stay up for the next command.',
    voice: [{ pattern: 'stash {hint+}' }],
    retainsHints: true },

  // --- Scroll ---
  { id: 'scroll_down', label: 'Scroll down', group: 'Scroll', mappable: true, params: [],
    description: 'Scroll the page (or cycled target) down one step (or N steps).',
    voice: [
      { pattern: 'scroll down' },
      { pattern: 'scroll down {number}', params: { count: '{number}' } },
    ] },
  { id: 'scroll_up', label: 'Scroll up', group: 'Scroll', mappable: true, params: [],
    description: 'Scroll the page (or cycled target) up one step (or N steps).',
    voice: [
      { pattern: 'scroll up' },
      { pattern: 'scroll up {number}', params: { count: '{number}' } },
    ] },
  { id: 'scroll_half_down', label: 'Scroll half-page down', group: 'Scroll', mappable: true, params: [],
    description: 'Scroll down half a viewport.',
    voice: [{ pattern: 'page down' }] },
  { id: 'scroll_half_up', label: 'Scroll half-page up', group: 'Scroll', mappable: true, params: [],
    description: 'Scroll up half a viewport.',
    voice: [{ pattern: 'page up' }] },
  { id: 'scroll_full_down', label: 'Scroll full-page down', group: 'Scroll', mappable: true, params: [],
    description: 'Scroll down a full viewport.',
    voice: [{ pattern: 'full page down' }] },
  { id: 'scroll_full_up', label: 'Scroll full-page up', group: 'Scroll', mappable: true, params: [],
    description: 'Scroll up a full viewport.',
    voice: [{ pattern: 'full page up' }] },
  { id: 'scroll_top', label: 'Scroll to top', group: 'Scroll', mappable: true, params: [],
    description: 'Jump to the top of the page (or cycled target).',
    voice: [{ pattern: 'top' }, { pattern: 'scroll top' }, { pattern: 'scroll to top' }] },
  { id: 'scroll_bottom', label: 'Scroll to bottom', group: 'Scroll', mappable: true, params: [],
    description: 'Jump to the bottom of the page (or cycled target).',
    voice: [{ pattern: 'bottom' }, { pattern: 'scroll bottom' }, { pattern: 'scroll to bottom' }] },
  { id: 'scroll_left', label: 'Scroll left', group: 'Scroll', mappable: true, params: [],
    description: 'Scroll left one step.',
    voice: [{ pattern: 'scroll left' }] },
  { id: 'scroll_right', label: 'Scroll right', group: 'Scroll', mappable: true, params: [],
    description: 'Scroll right one step.',
    voice: [{ pattern: 'scroll right' }] },
  { id: 'cycle_scroll_target', label: 'Cycle scroll target', group: 'Scroll', mappable: true, params: [],
    description: 'Cycle which scrollable element the scroll commands act on.' },
  // The generic parameterized scroll: a runtime action (direction/amount/count/
  // region), not a sensible single-key bind — hidden from the editor like
  // scroll_to_element. Its directional/count phrases now live on the discrete
  // cards above; region (sidebar/main) scrolling is implemented (scrollRegion)
  // but not currently voiced — re-add a voice entry here to bring it back.
  { id: 'scroll', label: 'Scroll (parameterized)', group: 'Scroll', mappable: false,
    description: 'Scroll in a direction by an amount, optionally repeated or region-scoped (runtime — not bindable).',
    params: [
      { name: 'direction', type: 'enum', options: SCROLL_DIRECTIONS, default: 'down' },
      { name: 'amount', type: 'enum', options: SCROLL_AMOUNTS, default: 'step' },
      { name: 'count', type: 'number', min: 1, default: '1' },
    ] },
  { id: 'scroll_to_percent', label: 'Scroll to percent', group: 'Scroll', mappable: true,
    description: 'Scroll to a vertical position given as a percentage of the page.',
    params: [{ name: 'percent', type: 'number', min: 0, max: 100, default: '50' }],
    voice: [{ pattern: 'scroll halfway', params: { percent: '50' } }] },
  { id: 'scroll_to_element', label: 'Scroll to element', group: 'Scroll', mappable: false, params: [],
    description: 'Scroll a specific element into view (runtime selector — not bindable).' },

  // --- Find ---
  { id: 'find_open', label: 'Open find', group: 'Find', mappable: true, params: [],
    description: 'Open the in-page find bar.' },
  { id: 'find_close', label: 'Close find', group: 'Find', mappable: true, params: [],
    description: 'Close find and clear the match highlights.',
    voice: [{ pattern: 'close find' }] },
  { id: 'find_next', label: 'Find next', group: 'Find', mappable: true, params: [],
    description: 'Jump to the next find match.',
    voice: [{ pattern: 'next' }] },
  { id: 'find_previous', label: 'Find previous', group: 'Find', mappable: true, params: [],
    description: 'Jump to the previous find match.',
    voice: [{ pattern: 'previous' }] },
  { id: 'find_immediate', label: 'Find immediately', group: 'Find', mappable: false, params: [],
    // No voice pattern: the closed command engine can only hear words already
    // in its union, so "find {text}" never did real find-in-page. A future
    // page-word index ("find <word:page_words>") would re-target this action.
    description: 'Run a find for a given query (runtime query — not bindable).' },

  // --- Navigation ---
  { id: 'history_back', label: 'Go back', group: 'Navigation', mappable: true, params: [],
    description: 'Step back through page history (full stack, including voice-navigated SPA entries).',
    voice: [{ pattern: 'go back' }] },
  { id: 'history_forward', label: 'Go forward', group: 'Navigation', mappable: true, params: [],
    description: 'Step forward through page history (full stack).',
    voice: [{ pattern: 'go forward' }] },
  { id: 'refresh', label: 'Reload page', group: 'Navigation', mappable: true, params: [],
    description: 'Reload the current page.',
    voice: [{ pattern: 'refresh' }, { pattern: 'reload' }] },
  { id: 'focus_input', label: 'Focus first input', group: 'Navigation', mappable: true, params: [],
    description: 'Focus the first text field on the page; Tab / Shift+Tab then cycle between fields.',
    voice: [{ pattern: 'focus input' }, { pattern: 'focus first input' }] },

  // --- Tabs ---
  // All tab verbs share one background handler (handleTabAction): keyboard
  // dispatches TAB_ACTION from content, voice is intercepted in the background
  // SSE path so the verbs work even on pages with no content script.
  { id: 'next_tab', label: 'Next tab', group: 'Tabs', mappable: true, params: [],
    description: 'Switch to the next tab in the current window.',
    voice: [{ pattern: 'next tab' }] },
  { id: 'previous_tab', label: 'Previous tab', group: 'Tabs', mappable: true, params: [],
    description: 'Switch to the previous tab in the current window.',
    voice: [{ pattern: 'previous tab' }] },
  { id: 'new_tab', label: 'New tab', group: 'Tabs', mappable: true, params: [],
    description: 'Open a new tab.',
    voice: [{ pattern: 'new tab' }] },
  { id: 'close_tab', label: 'Close tab', group: 'Tabs', mappable: true, params: [],
    description: 'Close the current tab.',
    voice: [{ pattern: 'close tab' }] },
  { id: 'restore_tab', label: 'Reopen closed tab', group: 'Tabs', mappable: true, params: [],
    description: 'Reopen the most recently closed tab or window.',
    voice: [{ pattern: 'reopen tab' }, { pattern: 'restore tab' }] },
  { id: 'duplicate_tab', label: 'Duplicate tab', group: 'Tabs', mappable: true, params: [],
    description: 'Duplicate the current tab.',
    voice: [{ pattern: 'duplicate tab' }] },
  { id: 'pin_tab', label: 'Pin/unpin tab', group: 'Tabs', mappable: true, params: [],
    description: 'Toggle whether the current tab is pinned.',
    voice: [{ pattern: 'pin tab' }, { pattern: 'unpin tab' }] },
  { id: 'mute_tab', label: 'Mute/unmute tab', group: 'Tabs', mappable: true, params: [],
    description: 'Toggle whether the current tab is muted.',
    voice: [{ pattern: 'mute tab' }, { pattern: 'unmute tab' }] },
  { id: 'first_tab', label: 'First tab', group: 'Tabs', mappable: true, params: [],
    description: 'Switch to the leftmost tab in the current window.',
    voice: [{ pattern: 'first tab' }] },
  { id: 'last_tab', label: 'Last tab', group: 'Tabs', mappable: true, params: [],
    description: 'Switch to the rightmost tab in the current window.',
    voice: [{ pattern: 'last tab' }] },
  { id: 'goto_tab', label: 'Go to tab N', group: 'Tabs', mappable: true,
    description: 'Switch to the Nth tab in the current window (1-based, clamped).',
    params: [{ name: 'index', type: 'number', min: 1, default: '1' }],
    voice: [{ pattern: 'tab {number}', params: { index: '{number}' } }] },
  { id: 'move_tab_left', label: 'Move tab left', group: 'Tabs', mappable: true, params: [],
    description: 'Move the current tab one position to the left.',
    voice: [{ pattern: 'move tab left' }] },
  { id: 'move_tab_right', label: 'Move tab right', group: 'Tabs', mappable: true, params: [],
    description: 'Move the current tab one position to the right.',
    voice: [{ pattern: 'move tab right' }] },
  { id: 'last_active_tab', label: 'Previously active tab', group: 'Tabs', mappable: true, params: [],
    description: 'Toggle back to the tab you were on before this one (any window).',
    voice: [{ pattern: 'swap tab' }] },
  // Voice-only (Layer 3 of DESIGN_TAB_NAVIGATION.md): the capture collection
  // is the open-tab set the background publishes to the plugin
  // (background/tab-collection.ts) — spoken title/domain words resolve to a
  // tab_id through the matcher, no overlay. Not keyboard-bindable: the value
  // is a runtime spoken word (the palette is the keyboard analog, Layer 2).
  { id: 'switch_to_tab', label: 'Switch to tab by name', group: 'Tabs', mappable: false, params: [],
    description: 'Switch to an open tab by speaking a distinctive word from its title or site.',
    voice: [{ pattern: 'switch to {browser_tabs}', params: { tab_id: '{browser_tabs}' } }] },

  // --- Help ---
  { id: 'toggle_help', label: 'Keyboard help', group: 'Help', mappable: true, params: [],
    description: 'Show or hide this keyboard command reference.' },
];

export const COMMAND_BY_ID: ReadonlyMap<string, CommandMeta> = new Map(
  COMMAND_CATALOG.map((c) => [c.id, c]),
);

/**
 * One spoken form contributed to the browser plugin: a bare action id (the
 * plugin prefixes it with its own id), the spoken pattern, the bound params,
 * and the catalog group as a display category. The plugin owns the context gate
 * (RequiresTags) — the extension never names a platform tag.
 */
export interface CommandContribution {
  action: string;
  pattern: string;
  params?: Record<string, string>;
  category: string;
  /** The command's "what it does" text — already authored per command in the
   * catalog; forwarded so the platform can show it (HUD subtitle, command
   * editor, calibration detail). */
  description: string;
  /** CommandMeta.retainsHints, forwarded for `{hint}` patterns. */
  retains_hints?: boolean;
}

/** Flatten the catalog's voice patterns into the plugin contribution payload. */
export function buildCommandContributions(): CommandContribution[] {
  const out: CommandContribution[] = [];
  for (const c of COMMAND_CATALOG) {
    if (!c.voice) continue;
    for (const v of c.voice) {
      out.push({
        action: c.id, pattern: v.pattern, params: v.params, category: c.group,
        description: c.description, retains_hints: c.retainsHints,
      });
    }
  }
  return out;
}

// The shipping keybinds — one binding per command, preferring the form that
// works in every mode. While hints are visible (always-mode) bare letters are
// codeword input, so a Shift/modifier chord is the always-mode form and is
// strictly more robust than the bare key (which only fires with hints hidden);
// we ship the robust one. The editor groups bindings under each command and
// auto-tags context, so a user can ADD a bare key (e.g. plain J) as a
// hidden-only convenience — it's just opt-in rather than a default.
//
// A few commands have no always-mode form and stay bare/hidden-only: horizontal
// scroll (Shift+H/L are tabs), the `cs` sequence, `/` find, and find-next.
// Comments show the keys as typed; tokens are canonical combos.
export const DEFAULT_KEYMAP: readonly KeymapEntry[] = [
  { keys: 'ctrl+KeyS', command: 'toggle_hints' }, // Ctrl+S — show/hide (leaves Ctrl+F find free)
  { keys: 'shift+KeyJ', command: 'scroll_down' },
  { keys: 'shift+KeyK', command: 'scroll_up' },
  { keys: 'shift+KeyD', command: 'scroll_half_down' },
  { keys: 'shift+KeyU', command: 'scroll_half_up' },
  { keys: 'shift+KeyT', command: 'scroll_top' }, // Shift+T (gg has no always-mode form)
  { keys: 'shift+KeyG', command: 'scroll_bottom' }, // Shift+G
  { keys: 'KeyH', command: 'scroll_left' }, // hidden-only (Shift+H is previous-tab)
  { keys: 'KeyL', command: 'scroll_right' }, // hidden-only (Shift+L is next-tab)
  { keys: 'KeyC KeyS', command: 'cycle_scroll_target' }, // cs — hidden-only
  { keys: 'Slash', command: 'find_open' }, // / — hidden-only
  { keys: 'KeyN', command: 'find_next' }, // hidden-only
  { keys: 'shift+KeyN', command: 'find_previous' }, // Shift+N
  { keys: 'shift+KeyH', command: 'previous_tab' }, // Shift+H
  { keys: 'shift+KeyL', command: 'next_tab' }, // Shift+L
  { keys: 'shift+Slash', command: 'toggle_help' }, // ? — keyboard command reference
  { keys: 'shift+KeyI', command: 'focus_input' }, // Shift+I — focus first input (works in always-mode)
  { keys: 'shift+KeyO', command: 'new_tab' }, // Shift+O — open a new tab
  { keys: 'shift+KeyX', command: 'close_tab' }, // Shift+X (Vimium x)
  { keys: 'shift+KeyZ', command: 'restore_tab' }, // Shift+Z — undo the close
  { keys: 'shift+KeyY', command: 'duplicate_tab' }, // Shift+Y (Vimium yt)
  { keys: 'shift+KeyP', command: 'pin_tab' }, // Shift+P
  { keys: 'shift+KeyM', command: 'mute_tab' }, // Shift+M
  { keys: 'shift+Digit1', command: 'first_tab' }, // Shift+1
  { keys: 'shift+Digit9', command: 'last_tab' }, // Shift+9 (browser Cmd/Ctrl+9 convention)
  { keys: 'shift+Digit6', command: 'last_active_tab' }, // Shift+6 = ^ (Vimium ^)
  { keys: 'shift+Comma', command: 'move_tab_left' }, // Shift+, = < (Vimium <<)
  { keys: 'shift+Period', command: 'move_tab_right' }, // Shift+. = > (Vimium >>)
];
