/**
 * BranchKit Extension — Action dispatcher and command registry.
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
  keys: string;       // e.g. "f", "gg", "F", "Escape"
  action: string;
  params?: Record<string, string>;
}

export class CommandRegistry {
  private commands: CommandEntry[] = [];

  add(entry: CommandEntry): void {
    this.commands.push(entry);
  }

  /**
   * Match a key sequence against registered commands.
   * Returns 'exact' match, 'partial' (prefix of longer sequence), or 'none'.
   */
  match(sequence: string): { result: 'exact' | 'partial' | 'none'; entry?: CommandEntry } {
    let hasPartial = false;

    for (const cmd of this.commands) {
      if (cmd.keys === sequence) {
        return { result: 'exact', entry: cmd };
      }
      if (cmd.keys.startsWith(sequence) && cmd.keys.length > sequence.length) {
        hasPartial = true;
      }
    }

    return { result: hasPartial ? 'partial' : 'none' };
  }
}
