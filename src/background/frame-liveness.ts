/**
 * BranchKit Browser — per-frame liveness Ports (SW side).
 *
 * Moved verbatim from background.ts (Wave 3 C4a landing; the monolith had no
 * headroom and this block is a self-contained unit): each content-script
 * context opens one Port at startup, and its lifetime IS the frame-death
 * signal every doc-scoped cleanup keys off.
 */

import type { MessageHandler } from '../core/message-router';
import { markDocLive, markDocGone, isDocPortLive as isLive } from '../core/doc-liveness';
import { releaseDocument } from '../labels/label-pool';
import { clearCodewordMemory } from '../labels/codeword-memory';
import { forwardHintsSessionEnd } from '../plugin/plugin-api';
import { frameStackGone } from './mode-mirror';

// Per-frame liveness via long-lived Port. Each content-script context opens
// one Port at startup; when the context dies (iframe removed, navigation,
// tab closed, bfcache evict) Chrome closes the Port and onDisconnect fires
// here. Three cleanups run on disconnect: the per-tab label pool
// (`releaseFrame`), the browser plugin's per-frame hint session
// (`forwardHintsSessionEnd`), and the frame's fingerprint->codeword memory
// (`clearCodewordMemory`). Without them, dead frames' state leaks — label
// codewords until the next tab close, hint-session per-prefix contributions
// until the plugin's 30s TTL backstop fires, codeword-memory keys forever.
// See docs/completed/DESIGN_BROWSER_FRAME_POOL_EXHAUSTION.md for the
// label-pool half.
//
// The Port carries no messages — its lifetime IS the signal. Service worker
// idle-termination is a known small leak window (frames that die while the
// SW is asleep don't get cleaned by either path); the browser plugin's TTL
// backstop catches its share. The label pool's dead-TAB share is reclaimed
// by the periodic sweep in background.ts (sweepDeadTabState); dead FRAMES inside a
// still-open tab remain the accepted v1 gap.
const LIVENESS_PORT_NAME = 'frame-liveness';

// DocIds with a currently-live liveness Port, SW's-eye view. Probe surface
// for the bfcache-port open question (notes/DESIGN_ORPHAN_PAINT.md layer 2):
// a CS whose port object looks open while its doc is absent here is the
// silently-dead channel. SW restart wipes it with the rest of module state —
// correct: after a restart nothing is tracked until CSs reconnect. Read by
// LIVENESS_QUERY only; ratify as fix input or remove with layer 3.


/** Register the Port listener. Called once from background.ts boot. */
export function initFrameLiveness(): void {
  chrome.runtime.onConnect.addListener((port) => {
  if (!port.name.startsWith(`${LIVENESS_PORT_NAME}:`)) return;
  // The port name carries the document's pool-ownership identity
  // (DESIGN_DOCUMENT_SCOPED_POOL_OWNERSHIP.md) — available atomically at
  // connect, so the disconnect cleanup below can be document-scoped with no
  // handshake race.
  const docId = port.name.slice(LIVENESS_PORT_NAME.length + 1);
  const tabId = port.sender?.tab?.id;
  const frameId = port.sender?.frameId;
  if (typeof tabId !== 'number' || typeof frameId !== 'number' || docId.length === 0) return;
  // Tell the content script its own frameId. Content has no API to
  // discover this on its own and uses it to detect misrouted activate
  // actions (id minted in frame A, dispatched into frame B by SW
  // routing drift). Sent on connect because it never changes for the
  // lifetime of this Port.
  try {
    port.postMessage({ type: 'FRAME_ID', frameId });
  } catch {
    // Port may already be closing; harmless.
  }
  markDocLive(docId);
  port.onDisconnect.addListener(() => {
    markDocGone(docId);
    // Doc-scoped, BOTH halves: this document frees only ITS labels and
    // ends only ITS grammar session — never a successor's at the same
    // (tab, frame) key (they share frame 0; they do not share a docId).
    // The grammar half matters when this disconnect is delivered LATE
    // (seen 4.5s after a Firefox navigation): by then the successor
    // document's batches occupy the frame session, and an unfenced end
    // destroyed 262 live codewords while the successor's delta-sync
    // shadow still believed them committed — painted badges, voice-dead
    // (the 2026-07-24 wikipedia ZY repro).
    releaseDocument(tabId, docId).catch(() => {});
    forwardHintsSessionEnd('frame_liveness_disconnect', tabId, frameId, docId).catch(() => {});
    // Evict this dead frame's fingerprint->codeword memory (chrome.storage.session).
    // The per-frame keys were previously only cleared on TAB close
    // (clearCodewordMemory(tabId)); the frame-scoped clear had no caller, so an
    // iframe-churny long-lived tab accumulated dead-frame keys indefinitely
    // (long-session-perf: codewordMemory accumulator). Frame death is the
    // eviction point — siblings' memory is untouched (frame-scoped key).
    clearCodewordMemory(tabId, frameId).catch(() => {});
    // Doc-scoped like the releases above: a LATE disconnect can't clear a successor's modes.
    frameStackGone(tabId, docId);
  });
});
}

/** Read-only probe: does the SW hold a LIVE liveness Port for this doc?
 *  (LIVENESS_QUERY — the bfcache-port probe surface.) */
export function isDocPortLive(docId: string): boolean {
  return isLive(docId);
}

/**
 * Message handler owned by this module (notes/DESIGN_ENTRY_POINT_TOPOLOGY.md).
 * Read-only: does the SW hold a LIVE liveness Port for this doc? Layer-2 probe
 * of the bfcache-port question (debug/bfcache-probe.ts, dev builds).
 */
export const frameLivenessMessageHandlers: Record<string, MessageHandler> = {
  LIVENESS_QUERY: (message) => ({
    tracked: typeof message.doc_id === 'string' && isDocPortLive(message.doc_id),
  }),
};
