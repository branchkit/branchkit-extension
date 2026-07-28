/**
 * BranchKit Browser — Action dispatcher and command registry.
 *
 * All user-facing actions go through ActionDispatcher.
 * Input modalities (voice, keyboard) produce action objects.
 */

export type ActionHandler = (params: Record<string, string>) => void;

export class ActionDispatcher {
  private handlers = new Map<string, ActionHandler>();

  /**
   * Bind an action id to its handler.
   *
   * Duplicate registration throws rather than silently overwriting. This used
   * to be a bare `set`, which was survivable only because all 44 registrations
   * sat in one contiguous block of content.ts where a collision was visible on
   * sight. They now live in eleven feature modules
   * (notes/DESIGN_ENTRY_POINT_TOPOLOGY.md phase 3b), and a silent overwrite
   * there resolves by the order the entry point happens to call the
   * registrars — a property nobody edits deliberately. Verified: inserting one
   * collision left all nine lints, tsc and the full suite green while the
   * command it shadowed was dead.
   *
   * Re-registering the IDENTICAL function is a no-op, so composing twice is
   * safe. Same contract as `registerMessageHandlers` in core/message-router.ts.
   */
  register(action: string, handler: ActionHandler): void {
    const existing = this.handlers.get(action);
    if (existing && existing !== handler) {
      throw new Error(`[BranchKit] duplicate handler for action '${action}'`);
    }
    this.handlers.set(action, handler);
  }

  /** The registered action ids, sorted. Diagnostics, tests, and lint D. */
  registeredActions(): string[] {
    return [...this.handlers.keys()].sort();
  }

  /**
   * Test seam. Production registers once at boot and never clears.
   *
   * Needed because the `register*Commands()` registrars build fresh closures
   * on every call, so they are NOT idempotent under the duplicate check above —
   * a test that re-registers per case has to clear first. Same seam as
   * `resetMessageHandlers` in core/message-router.ts, and for the same reason.
   */
  _resetForTesting(): void {
    this.handlers.clear();
  }

  dispatch(action: string, params: Record<string, string> = {}): void {
    const handler = this.handlers.get(action);
    if (handler) {
      handler(params);
    } else {
      console.warn(`[BranchKit] No handler for action: ${action}`);
    }
  }
}

export interface CommandEntry {
  // Canonical combo-token sequence (key-combo.ts serializeCombo), tokens
  // space-joined for multi-key sequences. E.g. "KeyJ", "shift+KeyG",
  // "ctrl+KeyF", "Slash", "KeyG KeyG".
  keys: string;
  action: string;
  params?: Record<string, string>;
}

export class CommandRegistry {
  private commands: CommandEntry[] = [];

  add(entry: CommandEntry): void {
    this.commands.push(entry);
  }

  /** Replace the entire binding set — the keymap is the source of truth, so
   *  a config change rebuilds the registry rather than mutating in place.
   *  Entries (params included) are copied so later edits to the source keymap
   *  don't leak into the live registry. */
  replaceAll(entries: readonly CommandEntry[]): void {
    this.commands = entries.map((e) => ({
      keys: e.keys,
      action: e.action,
      params: e.params ? { ...e.params } : undefined,
    }));
  }

  /**
   * Match a combo-token sequence against registered commands. Compares on
   * token boundaries (split on space), so "KeyG" is a prefix of "KeyG KeyG"
   * but NOT of "shift+KeyG". Returns 'exact', 'partial' (prefix of a longer
   * binding), or 'none'.
   */
  match(sequence: string): { result: 'exact' | 'partial' | 'none'; entry?: CommandEntry } {
    const seq = sequence.split(' ');
    let hasPartial = false;

    for (const cmd of this.commands) {
      const tokens = cmd.keys.split(' ');
      if (tokens.length === seq.length && tokens.every((t, i) => t === seq[i])) {
        return { result: 'exact', entry: cmd };
      }
      if (tokens.length > seq.length && seq.every((t, i) => t === tokens[i])) {
        hasPartial = true;
      }
    }

    return { result: hasPartial ? 'partial' : 'none' };
  }
}
