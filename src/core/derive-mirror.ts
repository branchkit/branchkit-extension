/**
 * The mirror derivation — a tag is held iff ANY frame's mode stack contains a
 * mode that mirrors it. Pure functions, zero chrome imports, zero reads of
 * mode-stack state: everything arrives as arguments, so the service worker's
 * own job reduces to transport (collect frame snapshots, call these, forward
 * the diff to the plugin). Wave 3's C4 does that wiring; nothing imports this
 * yet. Design: notes/DESIGN_MODE_STACK_AND_CODEWORD_HOLDERS.md, "The mirror
 * is derived, and arbitrated in the service worker".
 *
 * Why the SW and not the frames: the content script is per-frame and today
 * each frame decides for itself whether to speak — caret said top-frame-only
 * (so a subframe caret session, which resolveSelectTo deliberately creates,
 * set no tag and "copy that" was dead), find said every-frame (so two
 * subframes fought over a single-slot FindConnID). Deriving over ALL frames'
 * stacks makes both bugs unrepresentable: a subframe's caret asserts the tag
 * because the union does not care which frame holds the mode, and two frames
 * in find yield one claim because the output is a set. Popping one frame
 * while another is still in-mode keeps the tag for the same reason — the
 * union is still non-empty.
 *
 * This is the extension-side counterpart of the plugin's Go table test (Wave
 * 1 A1): the plugin asserts its tag machines retry a failed Delete; this
 * asserts the tag set they are asked to hold is derived right.
 */

import type { ModeId, ModeSpec } from './mode-stack';

/** The SW keys frames however its transport does (tabId:frameId strings,
 *  numeric frame ids in tests) — the derivation only unions the values. */
export type FrameId = string | number;

export interface TagAssertion {
  tag: string;
  exclusive: boolean;
}

/**
 * The tag assertion set for a set of frame stacks. Deterministic order (spec
 * table order) so equal inputs yield identical arrays — callers may compare
 * or serialize without sorting. A mode with a null mirror contributes
 * nothing; an unregistered mode id in a snapshot contributes nothing rather
 * than throwing, because a snapshot from a stale frame (an old content script
 * mid-teardown posting one last time) must not wedge the arbitration.
 */
export function deriveMirror(
  frameStacks: ReadonlyMap<FrameId, readonly ModeId[]>,
  specs: readonly ModeSpec[],
): TagAssertion[] {
  const present = new Set<ModeId>();
  for (const stack of frameStacks.values()) {
    for (const id of stack) present.add(id);
  }
  const out: TagAssertion[] = [];
  for (const s of specs) {
    if (s.mirror && present.has(s.id)) {
      out.push({ tag: s.mirror.tag, exclusive: s.mirror.exclusive });
    }
  }
  return out;
}

export interface MirrorDiff {
  asserts: TagAssertion[];
  clears: TagAssertion[];
}

/**
 * The edge between two derived assertion sets — what the SW actually forwards
 * to the plugin. Keyed by tag: an assertion present in both sets is no edge
 * even if derived from different frames (frame A popped, frame B still
 * in-mode: same tag, no traffic). Clears carry the PREVIOUS assertion's shape
 * so the forwarder knows whether it is releasing an exclusive claim.
 */
export function diffMirror(
  prev: readonly TagAssertion[],
  next: readonly TagAssertion[],
): MirrorDiff {
  const prevTags = new Set(prev.map((a) => a.tag));
  const nextTags = new Set(next.map((a) => a.tag));
  return {
    asserts: next.filter((a) => !prevTags.has(a.tag)),
    clears: prev.filter((a) => !nextTags.has(a.tag)),
  };
}
