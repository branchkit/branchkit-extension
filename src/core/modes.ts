/**
 * The production ModeStack instance — ONE per frame, like the singletons in
 * core/singletons.ts (its own module because keyboard.ts must import it, and
 * singletons.ts imports keyboard.ts).
 *
 * Wave 3 C2 (notes/PLAN_MODE_HOLDER_IMPL.md): the stack is the WRITER-side
 * spine — every mode's one entry/exit implementation pushes/pops here in
 * lockstep with the flag it still sets (KeyHandler.mode, CaretController's
 * mode, find's state.active, the pick's pending, the palette frame), and the
 * real peelInner probes are installed. Readers stay where they are for now:
 * the escape cascade still consults the live flags (its decider flips to
 * peelTop at C3, when the flags die and escape-key-path.test.ts's harness —
 * frozen through C2 by the arc's gate rule — converts its module mocks to
 * stack entries), and the per-frame tag mirrors still post from their old
 * sites until C4 derives them here.
 *
 * The sink: C4 replaces this with the SW transport (frames post their stack,
 * deriveMirror computes the tag set). Until then every edge is "taken"
 * immediately — there is no far side yet; the existing mirrors are the ones
 * doing the talking.
 */

import { ModeStack, MODE_SPECS, type ModeMirrorSink } from './mode-stack';

let sink: ModeMirrorSink = { post: () => true };

/** C4 wires the SW mirror transport here. */
export function setModeMirrorSink(s: ModeMirrorSink): void {
  sink = s;
}

export const modes = new ModeStack(MODE_SPECS, { post: (edge) => sink.post(edge) });
