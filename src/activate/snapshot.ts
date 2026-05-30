/**
 * BranchKit Browser — Pre-phrase codeword snapshot.
 *
 * When the user starts speaking a voice command (signaled by the voice
 * plugin's verb-prefix action — show_hints_go / show_hints_set /
 * show_hints_tables), the frame freezes its current codeword → wrapper
 * map. When the action that follows the verb lands (e.g. click on
 * "arch"), the codeword is resolved against this frozen map first —
 * not the live one — so a page mutation between speech-start and
 * action-arrival doesn't redirect the click to a different element.
 *
 * Bridges the user's mental model ("when I started speaking, 'arch'
 * was THIS thing") to the action dispatch even when the DOM has moved
 * on. Snapshot is per-frame; voice routing already targets the right
 * frame via the per-tab pool's `assigned` map.
 *
 * Design: notes/DESIGN_BROWSER_HINT_ALLOCATOR.md section 3.C, ported from
 * Cursorless's HatTokenMapImpl (lib-engine/src/core/HatTokenMapImpl.ts:136-157).
 */

import { ElementWrapper } from '../scan/element-wrapper';

/**
 * 5 seconds is a balance: long enough to absorb realistic two-step
 * voice phrases ("go arch and click bake") and slow networks pushing
 * the recognizer; short enough that an aged snapshot doesn't shadow
 * legitimate live state if the user pauses mid-thought and then
 * returns later. Cursorless uses 60s; their utterances are longer
 * and code edits less destructive than DOM rerenders.
 */
export const SNAPSHOT_TTL_MS = 5000;

export interface CodewordSnapshot {
  readonly byCodeword: ReadonlyMap<string, ElementWrapper>;
  readonly takenAt: number;
}

/**
 * Capture the current codeword → wrapper map. Wrappers without a
 * codeword (alphabet not loaded, pool exhausted, just released) are
 * skipped — they wouldn't be voice-addressable anyway.
 *
 * `now` is injected so tests can drive time deterministically without
 * patching Date or performance.
 */
export function takeSnapshot(
  wrappers: Iterable<ElementWrapper>,
  now: number,
): CodewordSnapshot {
  const byCodeword = new Map<string, ElementWrapper>();
  for (const w of wrappers) {
    const cw = w.scanned.codeword;
    if (cw) byCodeword.set(cw, w);
  }
  return { byCodeword, takenAt: now };
}

/**
 * Resolve a codeword against a snapshot. Returns the wrapper iff:
 *   - The snapshot exists.
 *   - It hasn't aged past SNAPSHOT_TTL_MS.
 *   - The codeword was in it at capture time.
 *   - The wrapper's element is still in the DOM.
 *
 * Caller falls through to the live store on undefined.
 */
export function resolveFromSnapshot(
  snapshot: CodewordSnapshot | null,
  codeword: string,
  now: number,
): ElementWrapper | undefined {
  if (!snapshot) return undefined;
  if (now - snapshot.takenAt > SNAPSHOT_TTL_MS) return undefined;
  const w = snapshot.byCodeword.get(codeword);
  if (!w) return undefined;
  if (!w.element.isConnected) return undefined;
  return w;
}

/**
 * True when the snapshot is absent or aged past TTL. Callers use
 * this to decide whether to take a fresh snapshot before dispatching
 * an action.
 */
export function isStale(snapshot: CodewordSnapshot | null, now: number): boolean {
  if (!snapshot) return true;
  return now - snapshot.takenAt > SNAPSHOT_TTL_MS;
}
