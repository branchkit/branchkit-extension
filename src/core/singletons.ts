import { ActionDispatcher, CommandRegistry } from '../dispatcher';
import { KeyHandler } from '../activate/keyboard';

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
