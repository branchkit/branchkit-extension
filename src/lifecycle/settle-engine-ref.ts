/**
 * The one reference to the live SettleEngine.
 *
 * The engine is constructed in `content.ts` and cannot move: two of its
 * collaborators are content-local functions (the discovery walk, the deferred
 * nav rescan), which `settle-deps.ts` already records. But modules that need to
 * *ask for a pass* should not have to be handed the instance by the entry
 * point, and that injection is what left four callback seams uninvertible.
 *
 * **Why a module and not `pageSession.engine`.** That field was the obvious
 * home and is where sources already read it. It is unreachable from the two
 * modules that need it: `labels/label-sync` and `labels/label-reservoir` cannot
 * import `lifecycle/page-session`, because page-session reaches label-sync
 * twice over — directly for `getSessionId`, and through
 * `core/wrapper-lifecycle`, which imports the put queue structurally. Breaking
 * that is untangling the label stage, not inverting a seam.
 *
 * So the storage moved here and `pageSession.engine` became an accessor over
 * it. There is still exactly ONE reference — this one. A second copy assigned
 * alongside the first would be the two-artifacts-in-sync shape, where the only
 * question a reader can ask ("which of these is current?") has no good answer.
 *
 * This file must stay a true leaf: type-only import, no runtime dependency,
 * importable from anywhere. That is the whole reason it works.
 */

import type { SettleEngine } from './settle-engine';

let engine: SettleEngine | null = null;

/** Publish the engine. Called once by content.ts at construction, before
 *  `pageSession.start()` — sources may fire as soon as they exist. */
export function setSettleEngine(e: SettleEngine): void {
  engine = e;
}

/**
 * The live engine, or `null` before content.ts has constructed one.
 *
 * Nullable on purpose rather than throwing. Unit tests exercise these modules
 * with no engine at all, and "no engine yet" is a real runtime state during
 * boot — a module asking for a convergence pass before one can run should
 * no-op, not take the frame down. Callers read it as `getSettleEngine()?.…`.
 */
export function getSettleEngine(): SettleEngine | null {
  return engine;
}

/** Test-only reset. */
export function _clearSettleEngineForTesting(): void {
  engine = null;
}
