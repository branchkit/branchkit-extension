/**
 * BranchKit Extension — Keyboard handler.
 *
 * Modes: normal, insert, hint.
 * In hint mode, typed characters filter badges by word prefix.
 * Insert mode detection from DESIGN doc §7.
 */

import { ActionDispatcher, CommandRegistry } from './dispatcher';

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
  private registry: CommandRegistry;
  private dispatcher: ActionDispatcher;
  private onFilterChange: ((prefix: string) => void) | null = null;

  constructor(registry: CommandRegistry, dispatcher: ActionDispatcher) {
    this.registry = registry;
    this.dispatcher = dispatcher;
  }

  setFilterCallback(cb: (prefix: string) => void): void {
    this.onFilterChange = cb;
  }

  getMode(): KeyMode {
    return this.mode;
  }

  enterHintMode(): void {
    this.mode = 'hint';
    this.filterText = '';
  }

  exitHintMode(): void {
    this.mode = 'normal';
    this.filterText = '';
    this.sequence = '';
  }

  handleKeyDown(e: KeyboardEvent): boolean {
    // Always let modifier combos through (Cmd+C, Ctrl+V, etc.)
    if (e.metaKey || e.ctrlKey || e.altKey) return false;

    // Insert mode: pass through
    if (this.mode !== 'hint' && isInsertMode()) return false;

    // Hint mode
    if (this.mode === 'hint') {
      return this.handleHintKey(e);
    }

    // Normal mode
    return this.handleNormalKey(e);
  }

  private handleHintKey(e: KeyboardEvent): boolean {
    if (e.key === 'Escape') {
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
        this.onFilterChange?.(this.filterText);
      }
      return true;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      this.dispatcher.dispatch('activate_first_visible');
      return true;
    }

    // Single letter characters for filtering
    if (e.key.length === 1 && /[a-zA-Z]/.test(e.key)) {
      e.preventDefault();
      e.stopPropagation();
      this.filterText += e.key.toLowerCase();
      this.onFilterChange?.(this.filterText);
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
