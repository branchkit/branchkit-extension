import { WrapperStore } from '../scan/element-wrapper';

/**
 * The single source of truth for this frame's hintable elements.
 *
 * Promoted out of content.ts module scope (Tier 0 of
 * notes/DESIGN_EXTENSION_RESTRUCTURE.md) so sources and reactions import the
 * same instance instead of reaching into the monolith. The observable delta
 * emitter that breaks the lifecycle/grammar/render cycle lands on this module
 * in Tier 2.
 */
export const store = new WrapperStore();
