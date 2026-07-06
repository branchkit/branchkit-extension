/**
 * BranchKit Browser — Keyboard handler.
 *
 * Modes: normal, insert, hint.
 * In hint mode, typed characters filter badges by word prefix.
 * Insert mode detection from DESIGN doc section 7.
 */

import { ActionDispatcher, CommandRegistry } from '../dispatcher';
import { comboFromEvent, serializeCombo } from './key-combo';

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
  // Set when a capital letter is typed mid-codeword — the "aA" affordance:
  // finishing a codeword with a capital opens the pick in a new tab. Read by
  // the content-side filter callback on the unique match; reset whenever the
  // codeword / hint mode resets.
  private newTabArmed: boolean = false;
  private registry: CommandRegistry;
  private dispatcher: ActionDispatcher;
  private onFilterChange: ((prefix: string) => void) | null = null;
  // Notified whenever the mode changes (normal ↔ hint), so the mode indicator
  // chip can reflect it. Set by content.ts.
  private onModeChange: ((mode: KeyMode) => void) | null = null;
  // Fired when the user presses Escape (no typed prefix) to leave hint mode.
  // Content decides whether to also hide the badges: manual visibility
  // dismisses them, always-visible keeps them. Set by content.ts.
  private onHintEscape: (() => void) | null = null;
  // Whether at least one codeword starts with a given prefix. Used to reject a
  // codeword keystroke that matches nothing — otherwise the filter hides every
  // badge until Escape. Set by content.ts; null means accept any char.
  private matchPredicate: ((prefix: string) => boolean) | null = null;
  // Explicit "pass keys to the page" state (Vimium's insert mode): every key
  // reaches the page until Escape. Distinct from the automatic field-focus
  // insert (`isInsertMode`) so it works anywhere, e.g. sites with their own
  // bare-key shortcuts (Gmail, GitHub, games). See notes/DESIGN_PASS_THROUGH.md.
  private forcedInsert = false;
  // Persistent per-site form of the above — keybinds off on this host, managed
  // from the popup. Both hand every key to the page.
  private excluded = false;
  // One-shot: hand exactly the next keystroke to the page (Vimium passNextKey).
  private passNextArmed = false;

  constructor(registry: CommandRegistry, dispatcher: ActionDispatcher) {
    this.registry = registry;
    this.dispatcher = dispatcher;
  }

  setFilterCallback(cb: (prefix: string) => void): void {
    this.onFilterChange = cb;
  }

  setModeChangeCallback(cb: (mode: KeyMode) => void): void {
    this.onModeChange = cb;
  }

  setHintEscapeCallback(cb: () => void): void {
    this.onHintEscape = cb;
  }

  setMatchPredicate(fn: (prefix: string) => boolean): void {
    this.matchPredicate = fn;
  }

  getMode(): KeyMode {
    if (this.mode === 'hint') return 'hint';
    return (this.forcedInsert || this.excluded) ? 'insert' : 'normal';
  }

  /** Enter explicit pass-through (insert) mode — every key reaches the page
   *  until Escape. Idempotent. */
  enterInsertMode(): void {
    if (this.forcedInsert) return;
    this.forcedInsert = true;
    this.onModeChange?.(this.getMode());
  }

  /** Leave explicit pass-through mode. */
  exitInsertMode(): void {
    if (!this.forcedInsert) return;
    this.forcedInsert = false;
    this.onModeChange?.(this.getMode());
  }

  /** Toggle explicit pass-through mode. */
  toggleInsertMode(): void {
    if (this.forcedInsert) this.exitInsertMode();
    else this.enterInsertMode();
  }

  /** Arm a one-shot: the next keystroke is handed to the page, then normal
   *  handling resumes (Vimium passNextKey). */
  armPassNextKey(): void {
    this.passNextArmed = true;
  }

  /** Per-site exclusion: when set, keybinds are off and every key reaches the
   *  page (toggled from the popup for the current host). */
  setExcluded(v: boolean): void {
    if (this.excluded === v) return;
    this.excluded = v;
    this.onModeChange?.(this.getMode());
  }

  isExcluded(): boolean {
    return this.excluded;
  }

  enterHintMode(): void {
    this.mode = 'hint';
    this.filterText = '';
    this.newTabArmed = false;
    this.onModeChange?.('hint');
  }

  exitHintMode(): void {
    const was = this.mode;
    this.mode = 'normal';
    this.filterText = '';
    this.sequence = '';
    this.newTabArmed = false;
    if (was !== 'normal') this.onModeChange?.('normal');
  }

  /** True when a capital was typed mid-codeword — the current pick should open
   *  in a new tab. Read by the content-side filter callback on a unique match. */
  isNewTabArmed(): boolean {
    return this.newTabArmed;
  }

  handleKeyDown(e: KeyboardEvent): boolean {
    // passNextKey: hand exactly the next keystroke to the page, then resume.
    if (this.passNextArmed) {
      this.passNextArmed = false;
      this.onModeChange?.(this.getMode());
      return false;
    }

    // Explicit pass-through (insert toggle) or per-site exclusion: EVERY key
    // reaches the page — checked before the chord path so even Ctrl/Cmd combos
    // go to the site. Escape leaves an explicit toggle; on an excluded site
    // Escape just reaches the page (exclusion is toggled from the popup).
    if (this.mode !== 'hint' && (this.forcedInsert || this.excluded)) {
      if (e.key === 'Escape' && this.forcedInsert) {
        this.exitInsertMode();
        e.preventDefault();
        e.stopPropagation();
        return true;
      }
      return false;
    }

    // A real-modifier combo (Ctrl/Alt/Meta) is never codeword / filter / text
    // input, so route it straight to the command registry — checked BEFORE the
    // insert-mode yield so a bound chord fires even while typing in a field.
    // That's required for the hide chord (default Ctrl+S): it must toggle hints
    // AND suppress the browser's native shortcut while focused in a search box.
    // Unbound chords return 'none' and fall through, so Ctrl+A / Cmd+C stay even
    // in fields. Shift alone is NOT a real modifier here — Shift+letter is a
    // normal binding token (handled below / by the registry). The dev-snapshot
    // chord (Ctrl+Alt+A) is intercepted upstream in content.ts before this runs.
    if (e.ctrlKey || e.altKey || e.metaKey) {
      return this.handleNormalKey(e);
    }

    // Insert (focused in an editable field): NORMAL-mode keybinds must NOT
    // hijack a search box, so bare/Shift keys pass through to the field.
    // Escape is the exception — it blurs the field (Vimium behavior), so an
    // autofocused input on page load doesn't trap the keyboard: press Escape,
    // you're back in Normal mode and `f`/keybinds work. `hint` mode always
    // intercepts (it was entered explicitly).
    if (this.mode !== 'hint' && isInsertMode()) {
      if (e.key === 'Escape') {
        const el = document.activeElement;
        if (el instanceof HTMLElement) el.blur();
        e.preventDefault();
        e.stopPropagation();
        return true;
      }
      return false;
    }

    // Hint mode ONLY (entered via `f`): letters filter/activate the painted
    // hints. Hints stay always-VISIBLE for voice, but they're only TYPEABLE
    // here — everywhere else the alphabet belongs to Normal-mode keybinds.
    // See notes/DESIGN_KEYBOARD_MODES.md.
    if (this.mode === 'hint') {
      return this.handleHintKey(e);
    }

    // Normal mode (the default, even with hints painted): bare letters and
    // sequences are keybinds.
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
        this.onFilterChange?.('');
        return true;
      }
      // No typed prefix → leave hint mode. Whether the badges also HIDE is a
      // visibility decision, made in content via onHintEscape: manual
      // visibility dismisses the summoned hints; always-visible keeps them
      // painted (they exist for voice regardless of keyboard mode). handleHintKey
      // only runs in hint mode now, so this always exits it — no `hide_hints`
      // dispatch here.
      e.preventDefault();
      e.stopPropagation();
      this.exitHintMode();
      this.onHintEscape?.();
      return true;
    }

    if (e.key === 'Backspace') {
      e.preventDefault();
      e.stopPropagation();
      if (this.filterText.length > 0) {
        this.filterText = this.filterText.slice(0, -1);
        if (this.filterText.length === 0) this.newTabArmed = false;
        this.onFilterChange?.(this.filterText);
      }
      return true;
    }

    // `/` opens find-in-page (Vimium-style: a visible query bar that highlights
    // text matches and steps through them with Enter / Shift+Enter — it never
    // clicks a link). It used to enter a hint-text-filter that auto-activated a
    // unique match, a footgun with no on-screen affordance.
    if (e.key === '/') {
      e.preventDefault();
      e.stopPropagation();
      this.dispatcher.dispatch('find_open');
      return true;
    }

    // Codeword mode: single letter characters for filtering. A capital here is
    // necessarily mid-codeword (a capital first keypress is diverted to commands
    // by handleKeyDown), so it arms "open this pick in a new tab" — the user's
    // "aA" affordance.
    if (e.key.length === 1 && /[a-zA-Z]/.test(e.key)) {
      e.preventDefault();
      e.stopPropagation();
      const next = this.filterText + e.key.toLowerCase();
      // No-op a keystroke that no codeword starts with — otherwise the filter
      // matches nothing and every hint vanishes until Escape. A stray key while
      // hints are up should do nothing, not blank the screen. (No predicate set
      // → accept any char, preserving the old behavior for tests/manual mode.)
      if (this.matchPredicate && !this.matchPredicate(next)) {
        return true;
      }
      this.filterText = next;
      if (e.shiftKey) this.newTabArmed = true;
      this.onFilterChange?.(this.filterText);
      return true;
    }

    return false;
  }

  private handleNormalKey(e: KeyboardEvent): boolean {
    const key = keyToString(e);
    // Combo tokens are space-joined into a sequence ("KeyG KeyG"), so the
    // registry can compare on token boundaries.
    this.sequence = this.sequence ? `${this.sequence} ${key}` : key;

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

// Canonical combo token for a keypress (layout-independent, via event.code):
// "KeyJ", "shift+KeyG", "ctrl+KeyF", "Slash". This is the token the registry's
// bindings are written in, so a key event and a binding compare directly.
function keyToString(e: KeyboardEvent): string {
  return serializeCombo(comboFromEvent(e));
}
