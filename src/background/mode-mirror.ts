/**
 * The SW-arbitrated tag mirror (Wave 3 C4a) — a plugin tag is held iff ANY
 * live frame's mode stack contains the mode that mirrors it.
 *
 * Frames post their stack snapshot on every mirrored-mode edge (the ModeStack
 * sink in content.ts); this module is the transport around the pure
 * derivation in core/derive-mirror.ts. It replaces the per-frame
 * CARET_ACTIVE / FIND_ACTIVE posts and their hand-kept guards: the per-frame
 * edge dedupe (`caretActivePushed`), the every-frame-vs-top-frame decisions
 * that produced the subframe-caret and two-frame-find bugs, and the 300 ms
 * window-focus re-assert timer — re-assertion is now a derivation replay on
 * the connect/focus edges, not a race against the plugin's drain.
 *
 * Frame identity is DOCUMENT-scoped (`tabId:docId`), never `tabId:frameId`:
 * a liveness disconnect can arrive seconds after a navigation (seen 4.5 s on
 * Firefox), by which time the successor document owns the frame slot — a
 * frame-keyed clear would wipe the successor's live mode, the exact fenced
 * class of the 2026-07-24 ZY grammar wipe. The stale doc's late post cannot
 * resurrect either: its key is dead, its stack replaces nothing.
 *
 * Scope: caret, find and (since C4b) video — video's tag became a pure
 * mirror of the extension's one video-layer lifetime, its matcher-written
 * hold-scoped form deleted plugin-side. Palette stays on its own path (rows
 * + tag publish atomically via PALETTE_CLOSED); see FORWARDERS.
 *
 * Failure model: the plugin POSTs are best-effort, same as the posts they
 * replace — the plugin drains its tags on SSE disconnect and OS focus loss,
 * and `reassertMirror` (called on the connect and focus edges) replays the
 * CURRENT derivation, so a drained or dropped assert heals on the next edge
 * instead of via a per-frame timer.
 */

import type { MessageHandler } from './message-router';
import { forwardCoalesced } from './log-coalesce';
import { deriveMirror, diffMirror, type TagAssertion, type FrameId } from '../core/derive-mirror';
import { MODE_SPECS, type ModeId } from '../core/mode-stack';
import { setCaretActive, setFindActive, setVideoMode } from '../plugin/plugin-api';

// The derived forwarders. Keyed by tag — the spec table names the tags, this
// names the transport for each. Palette is deliberately absent: its plugin
// state is rows + tag published atomically by its own host path
// (background/palette.ts) — the spec's mirror entry records the decision, the
// transport stays where the rows are.
const FORWARDERS: Record<string, (active: boolean) => Promise<void>> = {
  'plugin.browser.caret': setCaretActive,
  'plugin.browser.find': setFindActive,
  'plugin.browser.video_mode': setVideoMode,
};

/** Live frames' stacks, keyed `tabId:docId` (see header). */
const frameStacks = new Map<FrameId, readonly ModeId[]>();

/** What the derivation last asserted — the diff base. */
let asserted: TagAssertion[] = [];

/** A frame posted its stack (every mirrored-mode edge). An empty stack is a
 *  real update, not a removal — the frame is alive, just in Normal. */
export function frameStackPosted(tabId: number, docId: string, stack: readonly ModeId[]): void {
  frameStacks.set(`${tabId}:${docId}`, stack);
  drainMirror();
}

/** The document died (liveness Port disconnect). Doc-scoped by construction:
 *  a successor at the same (tab, frame) has a different docId. */
export function frameStackGone(tabId: number, docId: string): void {
  if (frameStacks.delete(`${tabId}:${docId}`)) drainMirror();
}

/** Replay the current derivation — the connect-edge / focus-edge heal. The
 *  plugin drains tags on SSE disconnect and OS focus loss; this re-asserts
 *  what the stacks still hold (and only that), replacing the old per-frame
 *  300 ms re-assert timer. */
export function reassertMirror(): void {
  for (const a of asserted) void FORWARDERS[a.tag]?.(true);
}

function drainMirror(): void {
  const next = deriveMirror(frameStacks, MODE_SPECS).filter((a) => a.tag in FORWARDERS);
  const { asserts, clears } = diffMirror(asserted, next);
  asserted = next;
  // Clears first: withdrawing a stale exclusive claim before asserting the
  // next keeps the plugin's exclusive filtering from briefly holding two.
  for (const c of clears) void FORWARDERS[c.tag]?.(false);
  for (const a of asserts) void FORWARDERS[a.tag]?.(true);
}

/** Test-only. */
export function __resetModeMirror(): void {
  frameStacks.clear();
  asserted = [];
}

/**
 * Message handler owned by this module (notes/DESIGN_ENTRY_POINT_TOPOLOGY.md).
 *
 * A frame's mode-stack edge; the caret/find tags are DERIVED across all live
 * frames here (this replaced CARET_ACTIVE/FIND_ACTIVE).
 */
export const modeMirrorMessageHandlers: Record<string, MessageHandler> = {
  MODE_STACK: (message, sender) => {
    const tabId = sender.tab?.id;
    // Receipt breadcrumb (Firefox find-tag hunt, 2026-07-26): edges are
    // user-action-rare, and every later drop point now logs — so a silent
    // missing tag localizes to whichever line is absent.
    forwardCoalesced('BK_MODE_STACK_RX', {
      tab: tabId ?? null, docId: String(message.docId).slice(0, 8), stack: message.stack,
    }, 'info');
    if (typeof tabId === 'number') frameStackPosted(tabId, message.docId, message.stack as ModeId[]);
  },
};
