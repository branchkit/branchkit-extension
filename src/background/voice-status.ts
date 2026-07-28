/**
 * BranchKit Browser — connection health and voice-pause messages.
 *
 * The popup's readout and toggle, plus the offscreen document's health
 * reports. Lifted out of background.ts's message chain
 * (notes/DESIGN_ENTRY_POINT_TOPOLOGY.md).
 *
 * The stream lifecycle itself (backoff ladder, pause intent, offscreen/direct
 * split) lives in plugin/sse-transport.ts — this module only carries what a
 * report or a toggle MEANS to the rest of the SW.
 */

import { bgState } from './state';
import {
  onSSEConnected, onSSEDisconnected, pauseVoice, resumeVoice, isVoicePaused,
} from '../plugin/sse-transport';
import { ensureConnected } from '../plugin/actuator-client';
import type { MessageHandler } from '../core/message-router';

/** The popup renders three distinct states off this shape. */
function healthSnapshot(): { branchkit: boolean; paused: boolean } {
  return { branchkit: bgState.branchkitConnected, paused: isVoicePaused() };
}

export const voiceStatusMessageHandlers: Record<string, MessageHandler> = {
  /**
   * The full connect/disconnect work runs on every report, not on flag edges —
   * edge-gating masked the reconnect healer (the reconnect paths used to set
   * the flag optimistically before the stream was up), and a down report while
   * already-marked-down still needs a retry armed ("discovery succeeded but the
   * SSE never came up"). scheduleSSERetry is idempotent while a timer is
   * pending. notes/DESIGN_SSE_RESILIENCE.md.
   */
  HEALTH_STATUS: (message) => {
    if (message.branchkit) onSSEConnected();
    else onSSEDisconnected();
  },

  /**
   * Three states the popup renders distinctly: connected, paused-by-choice, and
   * not-detected. `paused` lets it show "Voice paused" instead of inferring
   * "not detected" while the host may well be running.
   */
  GET_HEALTH: () => healthSnapshot(),

  /**
   * Popup toggle. Awaits the lifecycle so the response reflects the settled
   * state (the popup re-reads status right after) — and answers the same
   * snapshot either way, because a failed pause still has a truthful current
   * state to report.
   */
  SET_VOICE_PAUSED: (message) => {
    const fn = message.paused ? pauseVoice : resumeVoice;
    return fn().then(healthSnapshot, healthSnapshot);
  },

  /**
   * The keymap editor sources voice phrases from its own catalog now; it only
   * needs to know whether BranchKit is connected (for the not-connected note).
   */
  GET_VOICE_STATUS: () =>
    ensureConnected()
      .then((connected) => ({ connected }))
      .catch(() => ({ connected: false })),
};
