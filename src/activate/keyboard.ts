/**
 * BranchKit Browser — Keyboard handler.
 *
 * Modes: normal, insert, hint.
 * In hint mode, typed characters filter badges by word prefix.
 * Insert mode detection from DESIGN doc section 7.
 */

import { ActionDispatcher, CommandRegistry } from '../dispatcher';

export type KeyMode = 'normal' | 'insert' | 'hint';

/** Check if user is focused on an editable field. */
function isInsertMode(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    // Allow interception for non-text inputs
    if (['button', 'submit', 'reset', 'checkbox', 'radio', 'range'].includes(type)) return false;
    return true;
  }
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if ((el as HTMLElement).isContentEditable) return true;
  if (el.getAttribute('role') === 'textbox') return true;
  return false;
}

export class KeyHandler {
  private mode: KeyMode = 'normal';
  private sequence: string = '';
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private filterText: string = '';
  private filterByText: boolean = false;
  // Set when a capital letter is typed mid-codeword — the "aA" affordance:
  // finishing a codeword with a capital opens the pick in a new tab. Read by
  // the content-side filter callback on the unique match; reset whenever the
  // codeword / hint mode resets.
  private newTabArmed: boolean = false;
  private registry: CommandRegistry;
  private dispatcher: ActionDispatcher;
  private onFilterChange: ((prefix: string, byText: boolean) => void) | null = null;
  // Whether hints are currently painted. When true, typed letters filter
  // badges even without the explicit `f`-entered hint mode — so always-visible
  // hints are keyboard-reachable without first pressing `f`. Set by content.ts.
  private hintsVisible: () => boolean = () => false;

  constructor(registry: CommandRegistry, dispatcher: ActionDispatcher) {
    this.registry = registry;
    this.dispatcher = dispatcher;
  }

  setFilterCallback(cb: (prefix: string, byText: boolean) => void): void {
    this.onFilterChange = cb;
  }

  setHintsVisible(fn: () => boolean): void {
    this.hintsVisible = fn;
  }

  isFilteringByText(): boolean {
    return this.filterByText;
  }

  getMode(): KeyMode {
    return this.mode;
  }

  enterHintMode(): void {
    this.mode = 'hint';
    this.filterText = '';
    this.filterByText = false;
    this.newTabArmed = false;
  }

  exitHintMode(): void {
    this.mode = 'normal';
    this.filterText = '';
    this.filterByText = false;
    this.sequence = '';
    this.newTabArmed = false;
  }

  /** True when a capital was typed mid-codeword — the current pick should open
   *  in a new tab. Read by the content-side filter callback on a unique match. */
  isNewTabArmed(): boolean {
    return this.newTabArmed;
  }

  handleKeyDown(e: KeyboardEvent): boolean {
    // Always let modifier combos through (Cmd+C, Ctrl+V, etc.)
    if (e.metaKey || e.ctrlKey || e.altKey) return false;

    // Insert mode: pass through. Only the explicitly-entered `hint` mode (the
    // user pressed `f`) intercepts inside an editable field; passive typing
    // driven by always-visible hints must NOT hijack keystrokes meant for a
    // search box.
    if (this.mode !== 'hint' && isInsertMode()) return false;

    // Hints are typeable in explicit hint mode OR whenever hints are painted
    // (always-mode, no `f` needed). Routing within, in priority order:
    if (this.mode === 'hint' || this.hintsVisible()) {
      // 1. Text/search sub-mode (the `/` filter): every printable key —
      //    capitals included — is query text, never a command or codeword.
      if (this.filterByText) {
        return this.handleHintKey(e);
      }
      // 2. A Shift+letter with NO codeword in progress is a command "outlier":
      //    route it to the command path so uppercase keybinds work in
      //    always-mode — BranchKit's own (F/G/N) match there, and unbound ones
      //    (e.g. Vimium-C's H/L) fall through to other extensions. (Shift makes
      //    `e.key` the capital, so the registry distinguishes "H" from "h";
      //    Ctrl/Alt/Meta can't, which is why they bypass entirely above.) A
      //    Shift+letter *mid*-codeword is deliberately NOT diverted — it stays
      //    with the hint filter, reserved for the capital-means-new-tab idea.
      if (
        this.filterText.length === 0 &&
        e.shiftKey &&
        e.key.length === 1 &&
        /[a-zA-Z]/.test(e.key)
      ) {
        return this.handleNormalKey(e);
      }
      // 3. Lowercase / control keys / mid-codeword keys → codeword filter.
      return this.handleHintKey(e);
    }

    // Normal mode
    return this.handleNormalKey(e);
  }

  private handleHintKey(e: KeyboardEvent): boolean {
    if (e.key === 'Escape') {
      // Two-stage Escape. If hint letters have been typed, Escape cancels just
      // the typed prefix — back to no-prefix — so a mistyped hint can be
      // abandoned and a different one started, without hiding the (always-
      // visible) hints or exiting hint mode. Keeps the current filter sub-mode
      // (codeword vs text). This is the first stage, regardless of mode.
      if (this.filterText.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        this.filterText = '';
        this.newTabArmed = false;
        this.onFilterChange?.('', this.filterByText);
        return true;
      }
      // No typed prefix. Only the explicitly-entered hint mode treats Escape as
      // "hide hints". Under passive always-visible typing, Escape stays native
      // (close a dropdown/dialog, cancel find) — hiding is the configurable chord
      // handled in content.ts instead.
      if (this.mode !== 'hint') return false;
      e.preventDefault();
      e.stopPropagation();
      this.dispatcher.dispatch('hide_hints');
      this.exitHintMode();
      return true;
    }

    if (e.key === 'Backspace') {
      e.preventDefault();
      e.stopPropagation();
      if (this.filterText.length > 0) {
        this.filterText = this.filterText.slice(0, -1);
        if (this.filterText.length === 0) this.newTabArmed = false;
        this.onFilterChange?.(this.filterText, this.filterByText);
      } else if (this.filterByText) {
        this.filterByText = false;
        this.onFilterChange?.('', false);
      }
      return true;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      this.dispatcher.dispatch('activate_first_visible');
      return true;
    }

    // `/` in hint mode switches to text filter
    if (e.key === '/' && !this.filterByText) {
      e.preventDefault();
      e.stopPropagation();
      this.filterByText = true;
      this.filterText = '';
      this.onFilterChange?.('', true);
      return true;
    }

    // In text filter mode, accept any printable character (including spaces, digits)
    if (this.filterByText && e.key.length === 1) {
      e.preventDefault();
      e.stopPropagation();
      this.filterText += e.key.toLowerCase();
      this.onFilterChange?.(this.filterText, true);
      return true;
    }

    // Codeword mode: single letter characters for filtering. A capital here is
    // necessarily mid-codeword (a capital first keypress is diverted to commands
    // by handleKeyDown), so it arms "open this pick in a new tab" — the user's
    // "aA" affordance.
    if (e.key.length === 1 && /[a-zA-Z]/.test(e.key)) {
      e.preventDefault();
      e.stopPropagation();
      this.filterText += e.key.toLowerCase();
      if (e.shiftKey) this.newTabArmed = true;
      this.onFilterChange?.(this.filterText, false);
      return true;
    }

    return false;
  }

  private handleNormalKey(e: KeyboardEvent): boolean {
    const key = keyToString(e);
    this.sequence += key;

    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }

    const match = this.registry.match(this.sequence);

    if (match.result === 'exact' && match.entry) {
      e.preventDefault();
      e.stopPropagation();
      this.dispatcher.dispatch(match.entry.action, match.entry.params || {});
      this.sequence = '';
      return true;
    }

    if (match.result === 'partial') {
      e.preventDefault();
      e.stopPropagation();
      this.timeout = setTimeout(() => {
        this.sequence = '';
      }, 500);
      return true;
    }

    // No match
    this.sequence = '';
    return false;
  }
}

function keyToString(e: KeyboardEvent): string {
  if (e.key.length === 1) return e.key;
  return e.key; // "Escape", "Enter", etc.
}
