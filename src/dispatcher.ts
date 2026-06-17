/**
 * BranchKit Browser — Action dispatcher and command registry.
 *
 * All user-facing actions go through ActionDispatcher.
 * Input modalities (voice, keyboard) produce action objects.
 */

export type ActionHandler = (params: Record<string, string>) => void;

export class ActionDispatcher {
  private handlers = new Map<string, ActionHandler>();

  register(action: string, handler: ActionHandler): void {
    this.handlers.set(action, handler);
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
