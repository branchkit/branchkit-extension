import { ActionDispatcher, CommandRegistry } from '../dispatcher';
import { KeyHandler } from '../activate/keyboard';
import { TargetRectStore } from '../observe/target-rect-store';

/**
 * Stable, construct-once runtime singletons, promoted out of content.ts module
 * scope (Tier 0 of notes/DESIGN_EXTENSION_RESTRUCTURE.md) so extracted
 * source/reaction modules can import them directly. Each is a const reference
 * that is never reassigned; their only lifecycle interaction is
 * disconnect-on-teardown, owned by PageSession.
 */
export const dispatcher = new ActionDispatcher();
export const registry = new CommandRegistry();
export const keyHandler = new KeyHandler(registry, dispatcher);

// Phase 3 shadow rect cache, populated by the attention IO's onRect. No
// production read path consumes it yet; buildPerfSnapshot samples its drift
// against live rects to gauge whether a cutover would be correct.
export const targetRectStore = new TargetRectStore();
