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
import { documentInstanceId } from '../labels/document-identity';
import type { Message } from '../types';

/**
 * The SW mirror transport, defaulted here rather than injected from content.ts:
 * posting a frame's mode edge to the service worker is what this mirror IS, and
 * the entry point had no say in it beyond spelling out the sendMessage.
 *
 * A throw means the extension context was invalidated (an orphaned content
 * script), which is a real "not delivered" and must report false, not throw on.
 */
let sink: ModeMirrorSink = {
  post: (edge) => {
    try {
      chrome.runtime.sendMessage({
        type: 'MODE_STACK', docId: documentInstanceId, stack: [...edge.stack],
      } as Message).catch(() => {});
      return true;
    } catch {
      return false;
    }
  },
};

/** Test seam: substitute a recording sink. Production uses the default above. */
export function setModeMirrorSink(s: ModeMirrorSink): void {
  sink = s;
}

export const modes = new ModeStack(MODE_SPECS, { post: (edge) => sink.post(edge) });
