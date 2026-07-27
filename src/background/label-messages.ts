/**
 * BranchKit Browser — per-tab label pool and codeword-memory messages.
 *
 * Lifted out of background.ts's message chain
 * (notes/DESIGN_ENTRY_POINT_TOPOLOGY.md). The pool arbitration itself lives in
 * labels/label-pool.ts; this module is the wire edge — which sender is allowed
 * to mutate, and what a malformed or untrusted request answers.
 *
 * Two rules run through everything here:
 *
 * **The sender is authoritative, never the payload.** tabId and frameId come
 * off the sender because a content script doesn't know either, and because a
 * frame holding a stale copy of a codeword another frame won must not be able
 * to free the winner's assignment.
 *
 * **A refusal answers empty; it never rejects.** Every failure path resolves a
 * well-formed empty answer. That is not defensive padding — for CONFIRM_LABELS
 * specifically, answering `rejected` strips wrappers, so a transient error MUST
 * come back as "nothing rejected" and let a later confirm re-arbitrate.
 */

import {
  claimLabels, confirmLabels, releaseLabels, senderMayMutatePool, auditLabels,
} from '../labels/label-pool';
import { rememberCodewords, recallCodewords } from '../labels/codeword-memory';
import { forwardDebugLog } from '../plugin/plugin-api';
import type { MessageHandler, MessageSender } from './message-router';

/** Tab + frame off the sender, or null when this isn't a content script. */
function frameOf(sender: MessageSender): { tabId: number; frameId: number } | null {
  const tabId = sender.tab?.id;
  const frameId = sender.frameId;
  if (typeof tabId !== 'number' || typeof frameId !== 'number') return null;
  return { tabId, frameId };
}

function hasDocId(message: any): boolean {
  return typeof message.doc_id === 'string' && message.doc_id.length > 0;
}

export const labelMessageHandlers: Record<string, MessageHandler> = {
  /**
   * Only trust messages from a content script in a tab — popup / offscreen
   * don't have a tab context and wouldn't be claiming labels.
   */
  CLAIM_LABELS: (message, sender) => {
    const frame = frameOf(sender);
    if (!frame) return { labels: [] };
    // Prerender deny (DESIGN_PRERENDER_POOL_POISONING.md L1): a provisional
    // frame id must never enter the pool. Empty grant; the CS's level-triggered
    // claims retry after activation as the real frame 0.
    if (!senderMayMutatePool(sender)) {
      void forwardDebugLog('pool.prerender_claim_denied', { tab_id: frame.tabId, frame_id: frame.frameId });
      return { labels: [] };
    }
    if (!hasDocId(message)) return { labels: [] };
    return claimLabels(frame.tabId, message.doc_id, frame.frameId, message.count, message.preferred)
      .then((labels) => ({ labels }))
      .catch((err) => {
        console.warn('[BranchKit SW] CLAIM_LABELS error:', err);
        return { labels: [] };
      });
  },

  /**
   * Frame-scoped: only the owning frame's release frees a codeword. The
   * sender's frameId is authoritative (not message payload) — a frame with a
   * stale local copy of a codeword another frame won must not free the winner's
   * assignment. See releaseLabels.
   */
  RELEASE_LABELS: (message, sender) => {
    const tabId = sender.tab?.id;
    if (typeof tabId !== 'number' || typeof message.doc_id !== 'string') return;
    releaseLabels(tabId, message.doc_id, message.labels).catch((err) => {
      console.warn('[BranchKit SW] RELEASE_LABELS error:', err);
    });
  },

  /**
   * Sent by the content script's reservoir after `claim()` actually hands
   * codewords to wrappers. An arbitrated EXCHANGE (review bug #5): promotes
   * reserved → assigned, directly acquires from free (the released-then-
   * locally-reclaimed case the old fire-and-forget silently dropped), and
   * answers `rejected` for codewords another document won so the sender drops
   * them. Unconfirmed reserved labels remain NOT routable — under sealed
   * pull-resolution that means REFUSED (no_such_hint), which is deliberate:
   * it's what kept iframe reservoirs holding unused codewords from capturing
   * activations meant for a sibling's wrapper (the QuickBase `fine jury`
   * failure 2026-06-05T17:18:37), and the refusal now reports instead of
   * misrouting. See docs/completed/DESIGN_ELEMENT_IDENTITY_REGISTRY.md.
   */
  CONFIRM_LABELS: (message, sender) => {
    const frame = frameOf(sender);
    if (!frame || !Array.isArray(message.labels)) return { rejected: [] };
    // Prerender deny (DESIGN_PRERENDER_POOL_POISONING.md L1): nothing to
    // arbitrate — a prerender sender was never granted. Accept-nothing (an
    // empty rejected list) rather than reject: rejecting strips wrappers.
    if (!senderMayMutatePool(sender)) return { rejected: [] };
    if (!hasDocId(message)) return { rejected: [] };
    return confirmLabels(frame.tabId, message.doc_id, frame.frameId, message.labels)
      .catch((err) => {
        console.warn('[BranchKit SW] CONFIRM_LABELS error:', err);
        // Transient error: don't reject — rejecting nukes wrappers; the
        // codewords stay locally held and a later confirm re-arbitrates.
        return { rejected: [] };
      });
  },

  /**
   * Read-only painted-vs-routable tripwire (debug/pool-audit.ts, dev builds).
   * Pure read — outside the reservoir's single-sender MUTATION invariant, so it
   * deliberately does NOT gate on senderMayMutatePool.
   */
  POOL_AUDIT: (message, sender) => {
    const tabId = sender.tab?.id;
    const empty = () => ({ unroutable: [], foreign: [] });
    if (typeof tabId !== 'number' || typeof message.doc_id !== 'string' || !Array.isArray(message.labels)) {
      return empty();
    }
    return auditLabels(tabId, message.doc_id, message.labels).catch(empty);
  },

  /**
   * Regime B (DESIGN_CODEWORD_STABILITY): persist this frame's
   * fingerprint→codeword pairs so a fresh content script after a full-document
   * reload can reclaim the same codewords. Separate from the LabelStack (not
   * pool-mutating), so no single-sender concern.
   */
  REMEMBER_CODEWORDS: (message, sender) => {
    const frame = frameOf(sender);
    if (!frame || !Array.isArray(message.entries)) return;
    rememberCodewords(frame.tabId, frame.frameId, message.entries).catch((err) => {
      console.warn('[BranchKit SW] REMEMBER_CODEWORDS error:', err);
    });
  },

  /**
   * A fresh content script (post Regime-B reload) asks for this frame's
   * remembered fingerprint→codeword entries so it can seed preferredCodeword.
   */
  RECALL_CODEWORDS: (_message, sender) => {
    const frame = frameOf(sender);
    if (!frame) return { entries: [] };
    return recallCodewords(frame.tabId, frame.frameId)
      .then((entries) => ({ entries }))
      .catch(() => ({ entries: [] }));
  },
};
