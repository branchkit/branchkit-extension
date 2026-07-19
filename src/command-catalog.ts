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
   * exclusive palette tag and clears it at match time). 'caret' = only matchable
   * while caret/visual selection is active (the plugin gates on its exclusive
   * caret tag, held while the extension's caret mode is active — does NOT clear
   * at match, since caret persists across many selection commands). Absent = the
   * plugin's default app-active gate. A semantic, not a tag name — tags stay
   * plugin-owned, same contract as retainsHints.
   */
  voiceContext?: 'palette' | 'caret';
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
  // Show/hide are subsumed by toggle_hints (Shift+F) + hint_mode (f) + the
  // capital-letter new-tab affordance, so the discrete verbs were dropped
  // 2026-07-05 rather than lingering as unbound, voiceless editor clutter.
  { id: 'toggle_hints', label: 'Toggle badges', group: 'Badges', mappable: true, params: [],
    description: 'Show badges when hidden, hide them when shown. In Always mode the hide is momentary — the next page repaints them.',
    voice: [{ pattern: 'toggle' }] },
  // `f` — enter badge-typing mode: badges (always visible for voice) become
  // keyboard-typeable here, and only here. See notes/DESIGN_KEYBOARD_MODES.md.
  { id: 'hint_mode', label: 'Type a badge', group: 'Badges', mappable: true, params: [],
    description: 'Make the painted badges keyboard-typeable — then type a letter to activate one. Esc exits.' },
  { id: 'activate_hint', label: 'Activate badge by letter or word', group: 'Badges', mappable: false, params: [],
    description: 'Activate the badge matching a spoken word or typed letter (runtime value — not bindable).' },
  // blank / stash — the voice twins of the typed-capital new-tab affordance,
  // which spoken codewords can't express (no capitals in speech). Verbs match
  // the Rango convention; choice rationale in
  // notes/DESIGN_MULTI_TARGET_COMMANDS.md (phase 1).
  { id: 'activate_hint_newtab', label: 'Open badge in new tab', group: 'Badges', mappable: false, params: [],
    description: 'Open the badge’s link in a new focused tab.',
    voice: [{ pattern: 'blank {hint}' }] },
  // {hint+} = one or more hint codewords in a single breath ("stash huge gap
  // arch same" opens both) — the plugin expands it to its repeated capture
  // macro and delivers the ordered target list; the SW fans it out per target.
  { id: 'activate_hint_background', label: 'Open badges in background tabs', group: 'Badges', mappable: false, params: [],
    description: 'Open one or more badge links in background tabs; badges stay up for the next command.',
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

  // --- Zoom (Vimium zi/zo/z0) — chrome.tabs zoom, handled in the background ---
  { id: 'zoom_in', label: 'Zoom in', group: 'Zoom', mappable: true, params: [],
    description: 'Make the page bigger (10% per step, up to 500%).',
    voice: [{ pattern: 'zoom in' }] },
  { id: 'zoom_out', label: 'Zoom out', group: 'Zoom', mappable: true, params: [],
    description: 'Make the page smaller (10% per step, down to 25%).',
    voice: [{ pattern: 'zoom out' }] },
  { id: 'zoom_reset', label: 'Reset zoom', group: 'Zoom', mappable: true, params: [],
    description: 'Return the page to its default zoom (100%).',
    voice: [{ pattern: 'reset zoom' }, { pattern: 'actual size' }] },

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
  { id: 'go_next', label: 'Next page', group: 'Navigation', mappable: true, params: [],
    description: 'Follow the page’s "next" link (rel=next, or a link labelled Next/Newer/›) — paginated results, docs, galleries.',
    voice: [{ pattern: 'next page' }] },
  { id: 'go_previous', label: 'Previous page', group: 'Navigation', mappable: true, params: [],
    description: 'Follow the page’s "previous" link (rel=prev, or a link labelled Previous/Older/‹).',
    voice: [{ pattern: 'previous page' }] },
  { id: 'copy_url', label: 'Copy page URL', group: 'Navigation', mappable: true, params: [],
    description: 'Copy this page’s address to the clipboard.',
    voice: [{ pattern: 'copy url' }, { pattern: 'copy page url' }, { pattern: 'copy address' }] },
  { id: 'go_up', label: 'URL up one level', group: 'Navigation', mappable: true, params: [],
    description: 'Climb one level in the address — drop the #anchor, then the ?query, then the last path segment.',
    voice: [{ pattern: 'go up' }, { pattern: 'up level' }] },
  { id: 'go_root', label: 'URL to site root', group: 'Navigation', mappable: true, params: [],
    description: 'Jump to the site root (the domain’s home).',
    voice: [{ pattern: 'site root' }, { pattern: 'go to root' }] },
  // Keyboard-only hint action (Vimium yf): enter hint mode, then a codeword
  // copies that link’s URL instead of following it. Voice yank would need a
  // contributed hint verb — deferred.
  { id: 'yank_hint', label: 'Copy a link (badge)', group: 'Badges', mappable: true, params: [],
    description: 'Enter badge-typing mode, then type a letter to copy that link’s URL instead of opening it.' },
  // Hint action modes (Vimium): pick a badge, do X instead of clicking. Both
  // keyboard (arm + type a letter) and voice (say the verb + the codeword). See
  // notes/DESIGN_HINT_ACTION_MODES.md.
  { id: 'focus_hint', label: 'Focus a badge', group: 'Badges', mappable: true, params: [],
    description: 'Focus a badge’s element without activating it — a form field to type in, or any element. Say "focus" then its codeword, or press the key then type a letter.',
    voice: [{ pattern: 'focus {hint}' }] },
  { id: 'copytext_hint', label: 'Copy a badge’s text', group: 'Badges', mappable: true, params: [],
    description: 'Copy a badge’s visible text (not its URL). Say "copy text" then its codeword, or press the key then type a letter.',
    voice: [{ pattern: 'copy text {hint}' }] },
  // retainsHints: hover doesn't follow/clear — badges stay up so the user can
  // chain a command on whatever the hover exposed. Voice contributed here (not
  // plugin-side) so every badge verb lives in one place (was the phase-3b
  // split-contribution cleanup; notes/DESIGN_HINT_ACTION_MODES.md).
  { id: 'hover_hint', label: 'Hover a badge', group: 'Badges', mappable: true, params: [],
    description: 'Hover a badge’s element to reveal menus or controls without clicking it. Say "hover" then its codeword, or press the key then type a letter.',
    voice: [{ pattern: 'hover {hint}' }],
    retainsHints: true },
  { id: 'caret_hint', label: 'Select from a badge', group: 'Badges', mappable: true, params: [],
    description: 'Start a text selection at a badge’s element — say "select" then its codeword (or press the key then type a letter), then drive the selection by keyboard (hjkl/y) or voice ("select word" / "copy that").',
    voice: [{ pattern: 'select {hint}' }] },

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

  // --- Marks (Vimium m / `) ---
  // Two-step: the command arms capture, the NEXT key names the mark (a wildcard
  // no static keybind can express), so no voice and no params. See
  // notes/DESIGN_MARKS_AND_CARET.md. Keyboard-only for now — free-letter voice
  // capture against the closed grammar is a deferred follow-up.
  { id: 'mark_set', label: 'Set mark', group: 'Marks', mappable: true, params: [],
    description: 'Set a mark at the current scroll position — press m then a letter. Shift+letter sets a global mark you can jump to from any tab.' },
  { id: 'mark_jump', label: 'Jump to mark', group: 'Marks', mappable: true, params: [],
    description: 'Jump to a mark — press ` then its letter (Shift+letter for a global mark). Press ` twice to return to where you were before the last jump.' },

  // --- Selection (Vimium v / V — caret & visual mode) ---
  // A keyboard text caret over page content, ending in a yank (copy). The
  // movement keys (hjkl/w/b/e/0/$/gg/G) are owned by the caret handler, not the
  // registry — they shadow the Normal-mode binds by design. Keyboard-only;
  // coarse voice selection ("select word") is a deferred follow-up. See
  // notes/DESIGN_MARKS_AND_CARET.md (Part 2).
  { id: 'caret_mode', label: 'Caret / visual mode', group: 'Selection', mappable: true, params: [],
    description: 'Place a text caret on the page — move with hjkl/w/b, press v to start selecting, y to copy the selection. Esc exits.' },
  { id: 'visual_line_mode', label: 'Visual line mode', group: 'Selection', mappable: true, params: [],
    description: 'Start a line-wise selection at the caret — j/k extend by whole lines, y copies. Esc exits.' },
  // Voice-driven caret/visual selection — the spoken twin of the movement keys,
  // so "voice for everything" covers selecting + copying by voice. Voice-only
  // (movement keys are the keyboard form). Gated on the caret mode via
  // voiceContext:'caret' — the plugin holds an exclusive caret tag while the
  // extension's caret mode is active (POST /caret), so these are eligible ONLY
  // while selecting, mirroring the keyboard's modal capture. See
  // notes/DESIGN_HINT_ACTION_MODES.md.
  { id: 'caret_voice', label: 'Voice caret control', group: 'Selection', mappable: false,
    description: 'While the caret/visual selection is active, extend it by voice — "select word", "select line", "select to end" — then "copy that". "stop selecting" exits.',
    params: [{ name: 'op', type: 'enum', options: ['word', 'line', 'sentence', 'end', 'start', 'copy', 'exit'], default: 'word' }],
    voiceContext: 'caret',
    voice: [
      { pattern: 'select word', params: { op: 'word' } },
      { pattern: 'select line', params: { op: 'line' } },
      { pattern: 'select sentence', params: { op: 'sentence' } },
      { pattern: 'select to end', params: { op: 'end' } },
      { pattern: 'select to start', params: { op: 'start' } },
      { pattern: 'copy selection', params: { op: 'copy' } },
      { pattern: 'copy that', params: { op: 'copy' } },
      { pattern: 'stop selecting', params: { op: 'exit' } },
    ] },

  // --- Media (notes/DESIGN_VIDEO_MEDIA_COMMANDS.md) ---
  // Transport verbs on the HTML5 <video> element API — generic across every
  // site, working while the video-overlay gate suppresses badges and while
  // site controls are auto-hidden. Voice phrases are deliberately the words
  // a person says at a TV (guessability IS the discoverability mechanism);
  // the video layer's keys (k/j/l/m/</>/0, taught by the mode chip) are
  // YouTube's own, remapped to these commands so the muscle memory works on
  // any site. Seek phrases avoid bare "back"/"next" (history/find own them).
  { id: 'video_mode', label: 'Video control mode', group: 'Media', mappable: true, params: [],
    description: 'Enter the video key layer — k/Space play-pause, j/l seek 10s, arrows 5s, m mute, < > speed, 0 restart. YouTube\'s keys, working on any site\'s video. Esc or q exits.' },
  { id: 'media_play_pause', label: 'Play / pause video', group: 'Media', mappable: true,
    description: 'Pause or resume the page\'s video — the largest one playing (any site, works while player controls are hidden).',
    params: [{ name: 'op', type: 'enum', options: ['toggle', 'play', 'pause'], default: 'toggle' }],
    voice: [
      { pattern: 'pause', params: { op: 'pause' } },
      { pattern: 'play', params: { op: 'play' } },
    ] },
  { id: 'media_mute', label: 'Mute video', group: 'Media', mappable: true,
    description: 'Mute or unmute the page\'s video (the video itself, not the tab).',
    params: [{ name: 'op', type: 'enum', options: ['toggle', 'mute', 'unmute'], default: 'toggle' }],
    voice: [
      { pattern: 'mute', params: { op: 'mute' } },
      { pattern: 'unmute', params: { op: 'unmute' } },
    ] },
  { id: 'media_speed', label: 'Video speed', group: 'Media', mappable: true,
    description: 'Change playback speed in 0.25× steps (works even on sites without a speed control).',
    params: [{ name: 'op', type: 'enum', options: ['faster', 'slower', 'normal'], default: 'faster' }],
    voice: [
      { pattern: 'faster', params: { op: 'faster' } },
      { pattern: 'slower', params: { op: 'slower' } },
      { pattern: 'normal speed', params: { op: 'normal' } },
    ] },
  { id: 'media_seek', label: 'Skip in video', group: 'Media', mappable: true,
    description: 'Jump ahead or back in the playing video; say a number for exact seconds ("skip back 30").',
    params: [
      { name: 'direction', type: 'enum', options: ['ahead', 'back'], default: 'ahead' },
      { name: 'seconds', type: 'number', min: 1, max: 600, default: '10' },
    ],
    voice: [
      { pattern: 'skip ahead', params: { direction: 'ahead' } },
      { pattern: 'skip back', params: { direction: 'back' } },
      { pattern: 'skip ahead {number}', params: { direction: 'ahead', seconds: '{number}' } },
      { pattern: 'skip back {number}', params: { direction: 'back', seconds: '{number}' } },
    ] },
  { id: 'media_restart', label: 'Restart video', group: 'Media', mappable: true, params: [],
    description: 'Jump the playing video back to the beginning.',
    voice: [{ pattern: 'restart video' }] },

  // --- Help ---
  { id: 'toggle_help', label: 'Keyboard help', group: 'Help', mappable: true, params: [],
    description: 'Show or hide this keyboard command reference.',
    voice: [{ pattern: 'help' }] },
  // Layer 2 of notes/DESIGN_TAB_NAVIGATION.md: an extension-served iframe
  // overlay searching pluggable sources (open tabs MRU-first, this catalog).
  // A real-modifier chord by design — it must open in every mode, mid-hint
  // and inside text fields (the Ctrl+K/Ctrl+T-fire-in-fields path).
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
  { keys: 'shift+KeyF', command: 'toggle_hints' },// Shift+F — show/hide badges (momentary in always mode); f re-shows + types
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
  // Zoom (Vimium zi/zo/z0)
  { keys: 'KeyZ KeyI', command: 'zoom_in' },      // zi
  { keys: 'KeyZ KeyO', command: 'zoom_out' },     // zo
  { keys: 'KeyZ Digit0', command: 'zoom_reset' }, // z0
  // Navigation (Vimium H/L history, r reload, gi focus input)
  { keys: 'shift+KeyH', command: 'history_back' },    // H
  { keys: 'shift+KeyL', command: 'history_forward' }, // L
  { keys: 'KeyR', command: 'refresh' },               // r
  { keys: 'KeyG KeyI', command: 'focus_input' },      // gi
  { keys: 'KeyI', command: 'insert_mode' },           // i — pass keys to the page
  { keys: 'Backslash', command: 'pass_next_key' },    // \ — pass just the next key
  { keys: 'BracketRight BracketRight', command: 'go_next' },     // ]]
  { keys: 'BracketLeft BracketLeft', command: 'go_previous' },   // [[
  { keys: 'KeyY KeyY', command: 'copy_url' },          // yy
  { keys: 'KeyY KeyF', command: 'yank_hint' },         // yf — copy a link's URL
  { keys: 'KeyY KeyC', command: 'copytext_hint' },     // yc — copy a badge's text
  { keys: 'KeyG KeyF', command: 'focus_hint' },        // gf — focus a badge (frame-nav dropped)
  { keys: 'KeyG KeyH', command: 'hover_hint' },        // gh — hover a badge
  { keys: 'KeyG KeyV', command: 'caret_hint' },        // gv — select from a badge
  { keys: 'KeyG KeyU', command: 'go_up' },             // gu
  { keys: 'KeyG shift+KeyU', command: 'go_root' },     // gU
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
  // Marks (Vimium m / `) — the next key names the mark
  { keys: 'KeyM', command: 'mark_set' },              // m — set mark
  { keys: 'Backquote', command: 'mark_jump' },        // ` — jump to mark
  // Selection (Vimium v / V — caret & visual mode)
  { keys: 'KeyV', command: 'caret_mode' },            // v — caret mode
  { keys: 'shift+KeyV', command: 'visual_line_mode' },// V — visual line mode
  // Media (notes/DESIGN_VIDEO_MEDIA_COMMANDS.md)
  { keys: 'KeyW', command: 'video_mode' },            // w — "watch": video key layer
  // Palette / tab palette
  { keys: 'ctrl+KeyK', command: 'toggle_palette' },   // Ctrl+K — full palette (works everywhere)
  { keys: 'shift+KeyT', command: 'toggle_tab_palette' }, // T — tab palette (Vimium-C's tab-search key)
  // Help
  { keys: 'shift+Slash', command: 'toggle_help' },    // ?
];
