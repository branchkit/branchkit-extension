/**
 * BranchKit Browser — voice-selection grammar (pure).
 *
 * The whole adjustable-selection feature reduces to ONE primitive:
 * `Selection.modify(alter, direction, granularity)` (see
 * notes/DESIGN_VOICE_SELECTION_BOUNDS.md). This module owns the pure decision
 * layer that maps a spoken command — verb × granularity × direction × count —
 * onto that primitive's arguments, with zero DOM access so it's unit-testable
 * (jsdom / happy-dom don't implement Selection.modify).
 *
 * Direction state is the fragile part the research flags: `Selection.direction`
 * is unreliable, so the caret controller tracks the *growth direction* (which
 * way the focus has been moving away from the anchor) explicitly and threads it
 * in here. "extend word" continues in that direction; "shrink word" pulls the
 * focus back toward the anchor (the opposite); "flip" swaps the ends and thus
 * inverts it.
 */

export type Direction = 'forward' | 'backward';
/** The spoken granularities. `lineboundary` is the "to end/start of line" form. */
export type SelectGranularity = 'word' | 'sentence' | 'line' | 'paragraph' | 'lineboundary';
export type SelectVerb = 'extend' | 'shrink';

/** Native `Selection.modify` granularity tokens. */
export type NativeGranularity =
  | 'character' | 'word' | 'line' | 'lineboundary' | 'sentence' | 'paragraph';

export interface ModifyPlan {
  /** Always 'extend' — voice selection always grows/shrinks a visual range from
   *  a fixed anchor; caret-move is a keyboard-only concern. */
  alter: 'extend';
  direction: Direction;
  granularity: NativeGranularity;
  /** Times to repeat the modify (>= 1). */
  count: number;
}

export const opposite = (d: Direction): Direction =>
  d === 'forward' ? 'backward' : 'forward';

/** The spoken granularity → native `Selection.modify` granularity. Identity for
 *  every token today (they share names), but kept explicit so a future spoken
 *  alias maps in one place. */
export function nativeGranularity(g: SelectGranularity): NativeGranularity {
  return g;
}

/**
 * Map a spoken selection command onto a `Selection.modify` call.
 *
 * - **extend**: grow the selection. With an explicit spoken direction ("extend
 *   back word") use it; otherwise continue in the current growth direction so
 *   repeated "extend word" keeps pushing the same end outward.
 * - **shrink**: pull the moving end back toward the anchor — the opposite of the
 *   growth direction. (Raw `Selection.modify` has no "shrink"; it's an extend in
 *   the reverse direction, which is why the tracked growth direction matters.)
 */
export function planModify(
  verb: SelectVerb,
  granularity: SelectGranularity,
  spokenDirection: Direction | undefined,
  count: number,
  growthDir: Direction,
): ModifyPlan {
  const direction: Direction =
    verb === 'shrink' ? opposite(growthDir) : (spokenDirection ?? growthDir);
  return {
    alter: 'extend',
    direction,
    granularity: nativeGranularity(granularity),
    count: Number.isFinite(count) && count >= 1 ? Math.floor(count) : 1,
  };
}

/**
 * The growth direction AFTER applying a command, given the one before. Extending
 * with an explicit direction re-aims growth that way (so a later bare "extend"
 * continues it); a bare extend or a shrink leaves it; "flip" inverts it. Pure so
 * the controller's direction state machine is testable without a live Selection.
 */
export function nextGrowthDir(
  verb: SelectVerb | 'flip',
  spokenDirection: Direction | undefined,
  growthDir: Direction,
): Direction {
  if (verb === 'flip') return opposite(growthDir);
  if (verb === 'extend' && spokenDirection) return spokenDirection;
  return growthDir;
}
