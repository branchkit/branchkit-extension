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
  /**
   * Voice-context gate for the command's spoken forms. 'palette' = only
   * matchable while the command palette is open (the plugin gates on its
   * exclusive palette tag and clears it at match time). Absent = the plugin's
   * default app-active gate. A semantic, not a tag name — tags stay
   * plugin-owned, same contract as retainsHints.
   */
  voiceContext?: 'palette';
}

export interface KeymapEntry {
  /** Canonical combo-token sequence (key-combo.ts `serializeCombo`). */
  keys: string;
  command: string;
  params?: Record<string, string>;
}

// Enum option lists mirror the source unions: ScrollDirection / ScrollAmount
// (activate/scroller.ts). Kept as literal arrays because TS type unions have
// no runtime form for the editor to enumerate.
const SCROLL_DIRECTIONS = ['up', 'down', 'left', 'right'] as const;
const SCROLL_AMOUNTS = ['step', 'half', 'full', 'top', 'bottom'] as const;

export const COMMAND_CATALOG: readonly CommandMeta[] = [
  // --- Hints ---
  // Show/hide are subsumed by toggle_hints (Ctrl+S) + hint_mode (f) + the
  // capital-letter new-tab affordance, so the discrete verbs were dropped
  // 2026-07-05 rather than lingering as unbound, voiceless editor clutter.
  { id: 'toggle_hints', label: 'Toggle hints', group: 'Hints', mappable: true, params: [],
    description: 'Show hints when hidden, hide them when shown (sticky across navigation).',
    voice: [{ pattern: 'toggle' }] },
  // `f` — enter hint mode: hints (always visible for voice) become keyboard-
  // typeable here, and only here. See notes/DESIGN_KEYBOARD_MODES.md.
  { id: 'hint_mode', label: 'Type a hint', group: 'Hints', mappable: true, params: [],
    description: 'Make the painted hints keyboard-typeable — then type a codeword to activate it. Esc exits.' },
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
  // Pass-through: hand the keyboard to the site so its own shortcuts work.
  // Keyboard-only (voice is unaffected by keyboard modes), so no `voice`.
  { id: 'insert_mode', label: 'Pass keys to the page', group: 'Navigation', mappable: true, params: [],
    description: 'Hand every keypress to the site until you press Escape — for pages with their own keyboard shortcuts (Gmail, GitHub, web apps, games).' },
  { id: 'pass_next_key', label: 'Pass next key to the page', group: 'Navigation', mappable: true, params: [],
    description: 'Send just the next keystroke straight to the site, then resume BranchKit shortcuts.' },

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
  // Positional "tab {number}" voice was retired 2026-07-05: voice tab-
  // addressing is markers-only (one language — see DESIGN_TAB_MARKERS.md),
  // and "tab" is now the tab-palette trigger. Kept keyboard-mappable.
  { id: 'goto_tab', label: 'Go to tab N', group: 'Tabs', mappable: true,
    description: 'Switch to the Nth tab in the current window (1-based, clamped).',
    params: [{ name: 'index', type: 'number', min: 1, default: '1' }] },
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
  // "tab <codeword>" — the flat, always-live path, so it resolves in one breath
  // (the tab palette, bare "tab", is the paused/browse path). {browser_tabs}
  // matches both the stable mark shown on the strip AND a distinctive title/
  // site word, so "tab huge" and "tab github" both work. ("switch to <tab>" was
  // dropped 2026-07-05 — one verb for tabs.)
  { id: 'switch_to_tab', label: 'Switch to tab by codeword', group: 'Tabs', mappable: false, params: [],
    description: 'Switch to an open tab — say "tab" then its codeword (or a distinctive word from its title or site).',
    voice: [{ pattern: 'tab {browser_tabs}', params: { tab_id: '{browser_tabs}' } }] },

  // --- Help ---
  { id: 'toggle_help', label: 'Keyboard help', group: 'Help', mappable: true, params: [],
    description: 'Show or hide this keyboard command reference.',
    voice: [{ pattern: 'help' }] },
  // Layer 2 of notes/DESIGN_TAB_NAVIGATION.md: an extension-served iframe
  // overlay searching pluggable sources (open tabs MRU-first, this catalog).
  // A real-modifier chord by design — it must open in every mode, mid-hint
  // and inside text fields (the Ctrl+S precedent).
  { id: 'toggle_palette', label: 'Command palette', group: 'Help', mappable: true, params: [],
    description: 'Search open tabs and every command in one overlay.',
    voice: [{ pattern: 'palette' }] },
  // The same overlay scoped to open tabs — the keyboard + voice way to switch
  // tabs by codeword or fuzzy title (see notes/DESIGN_TAB_MARKERS.md). Bare
  // `T` in Normal mode (Vimium-C's tab-search key); voice "tab".
  { id: 'toggle_tab_palette', label: 'Tab palette', group: 'Tabs', mappable: true, params: [],
    description: 'Switch tabs — search by title or codeword in the palette overlay.',
    voice: [{ pattern: 'tab' }] },
  // Palette voice selection (voice half of Layer 2): every palette row shows
  // an alphabet codeword badge; the spoken codeword resolves to the row_id
  // through the browser_palette collection (as_named_entities, value=row_id),
  // and the background maps row_id back to the row's dispatch. Gated on the
  // plugin's exclusive palette tag via voiceContext — while the palette is
  // open, page-hint captures are suppressed, so these badges can reuse the
  // hint alphabet without ambiguity.
  { id: 'palette_select', label: 'Select palette row', group: 'Help', mappable: false, params: [],
    description: 'Activate a palette row by speaking its codeword badge.',
    voice: [{ pattern: '{browser_palette}', params: { row_id: '{browser_palette}' } }],
    voiceContext: 'palette' },
  // Same word as hint-hide, disambiguated by context: palette open = only
  // this one is eligible (exclusive tag); palette closed = only the hint one.
  { id: 'palette_dismiss', label: 'Dismiss palette', group: 'Help', mappable: false, params: [],
    description: 'Close the command palette without selecting.',
    voice: [{ pattern: 'hide' }],
    voiceContext: 'palette' },
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
  /** CommandMeta.voiceContext — the registrar swaps the app-active gate for
   * the named context's tag (and clears it at match time). */
  context?: string;
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
        context: c.voiceContext,
      });
    }
  }
  return out;
}

// The shipping keybinds — Vimium/Vimium-C parity, now that Normal mode owns
// the alphabet (notes/DESIGN_KEYBOARD_MODES.md). Bare letters are keybinds;
// hints are typed only after `f` (hint mode); text fields (Insert) yield;
// real-modifier chords (Ctrl+K/Ctrl+T) fire in every mode. Tokens are
// canonical combos (key-combo.ts); comments show the keys as pressed. All
// user-customizable in the keymap editor.
export const DEFAULT_KEYMAP: readonly KeymapEntry[] = [
  // Hints
  { keys: 'KeyF', command: 'hint_mode' },        // f — enter hint mode (Vimium f)
  { keys: 'ctrl+KeyS', command: 'toggle_hints' },// Ctrl+S — show/hide the always-badges (works in fields)
  // Scroll (Vimium j/k/h/l, d/u, gg/G)
  { keys: 'KeyJ', command: 'scroll_down' },
  { keys: 'KeyK', command: 'scroll_up' },
  { keys: 'KeyH', command: 'scroll_left' },
  { keys: 'KeyL', command: 'scroll_right' },
  { keys: 'KeyD', command: 'scroll_half_down' },
  { keys: 'KeyU', command: 'scroll_half_up' },
  { keys: 'KeyG KeyG', command: 'scroll_top' },  // gg
  { keys: 'shift+KeyG', command: 'scroll_bottom' }, // G
  { keys: 'KeyC KeyS', command: 'cycle_scroll_target' }, // cs
  // Find (Vimium / n N)
  { keys: 'Slash', command: 'find_open' },       // /
  { keys: 'KeyN', command: 'find_next' },         // n
  { keys: 'shift+KeyN', command: 'find_previous' }, // N
  // Navigation (Vimium H/L history, r reload, gi focus input)
  { keys: 'shift+KeyH', command: 'history_back' },    // H
  { keys: 'shift+KeyL', command: 'history_forward' }, // L
  { keys: 'KeyR', command: 'refresh' },               // r
  { keys: 'KeyG KeyI', command: 'focus_input' },      // gi
  { keys: 'KeyI', command: 'insert_mode' },           // i — pass keys to the page
  // Tabs (Vimium t/x/X, gt/gT, yt, ^)
  { keys: 'KeyT', command: 'new_tab' },               // t
  { keys: 'KeyX', command: 'close_tab' },             // x
  { keys: 'shift+KeyX', command: 'restore_tab' },     // X — undo close
  { keys: 'KeyG KeyT', command: 'next_tab' },         // gt
  { keys: 'KeyG shift+KeyT', command: 'previous_tab' }, // gT
  { keys: 'KeyY KeyT', command: 'duplicate_tab' },    // yt
  { keys: 'shift+Digit6', command: 'last_active_tab' }, // ^ (Vimium)
  { keys: 'KeyG Digit0', command: 'first_tab' },      // g0
  { keys: 'KeyG shift+Digit4', command: 'last_tab' }, // g$
  { keys: 'shift+Comma', command: 'move_tab_left' },  // < (Vimium <<)
  { keys: 'shift+Period', command: 'move_tab_right' },// > (Vimium >>)
  { keys: 'shift+KeyP', command: 'pin_tab' },         // P
  { keys: 'shift+KeyM', command: 'mute_tab' },        // M
  // Palette / tab palette
  { keys: 'ctrl+KeyK', command: 'toggle_palette' },   // Ctrl+K — full palette (works everywhere)
  { keys: 'shift+KeyT', command: 'toggle_tab_palette' }, // T — tab palette (Vimium-C's tab-search key)
  // Help
  { keys: 'shift+Slash', command: 'toggle_help' },    // ?
];
