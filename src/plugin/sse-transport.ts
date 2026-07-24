/**
 * BranchKit Browser — SSE transport (service-worker side).
 *
 * Owns the plugin event-stream lifecycle for both engines: Chrome (offscreen
 * document holding the EventSource, health reported back over runtime
 * messages) and Firefox (direct EventSource in the SW). Also owns the pieces
 * that are inseparable from the stream's lifecycle: the reconnect backoff
 * ladder, the voice-pause intent (notes/DESIGN_VOICE_PAUSE.md), and the
 * connection-state paint (toolbar badge + content-facing storage mirror).
 *
 * What it deliberately does NOT own: what a connect *means* (the heal work —
 * focus handshake, reference hydrate, rescan, grammar republish) and what an
 * event *does* (action routing). Those are behavior, injected once via
 * initSSETransport hooks and living with their features — the transport is a
 * pipe with a health policy. Extracted from background.ts per
 * notes/DESIGN_RESTRUCTURE_ROUND3.md (round-3 lift; June section-4 item).
 */

import { discoverPlugin, getPluginPort, getPluginToken, setVoicePaused } from './actuator-client';
import { bgState, connId } from '../background/state';
import { SSEBackoff } from '../background/sse-backoff';

export interface SSETransportHooks {
  /** Fires when creds exist, just before the stream is (re)opened — the
   * connect-time feature pushes (command contribution, media presence). */
  onPreConnect(): void;
  /** The connect-edge heal work. Runs on EVERY connected event, after the
   * transport's own bookkeeping (flags, badge, mirror, backoff reset). */
  onConnectedEdge(): void;
  /** An `action` event arrived on the stream (Firefox direct path only —
   * Chrome's offscreen events route through the runtime message listener). */
  onEvent(data: unknown): void;
  /** An `alphabet` event arrived on the stream (Firefox direct path only). */
  onAlphabet(words: string[]): void;
}

let hooks: SSETransportHooks = {
  onPreConnect: () => {},
  onConnectedEdge: () => {},
  onEvent: () => {},
  onAlphabet: () => {},
};

export function initSSETransport(h: SSETransportHooks): void {
  hooks = h;
}

// --- Feature Detection ---

const hasOffscreenAPI = typeof chrome !== 'undefined' && !!chrome.offscreen;

// --- State ---

// Firefox direct SSE (no offscreen document needed)
let directSSE: EventSource | null = null;
// URL of the EventSource `directSSE` currently points at — the
// already-connecting guard in connectDirectSSE compares against it so a
// redundant connect with unchanged creds keeps the in-flight socket.
let directSSEUrl: string | null = null;

// SSE reconnect backoff state. Shared by Chrome (offscreen→HEALTH_STATUS)
// and Firefox (direct EventSource) paths. Policy (ladder + stable-connection
// reset) lives in SSEBackoff; only the timer lives here.
let sseRetryTimer: ReturnType<typeof setTimeout> | null = null;
const sseBackoff = new SSEBackoff();

// Voice-pause intent (notes/DESIGN_VOICE_PAUSE.md). A standing user choice to
// stop the browser engaging voice while keeping hints + keyboard live —
// persisted in chrome.storage.local (per-machine, like the alphabet + mirror),
// sticky until explicitly un-paused. The SW's authoritative copy; loaded at
// init() before any auto-connect decision. Every auto-connect entry point
// (init, the connection-check alarm, permissions.onAdded) and the retry ladder
// respect it; the actuator-client transport gate (setVoicePaused) enforces it
// for outbound traffic. Distinct from the transient branchkitConnected: paused
// is intent, connected is reality, and paused implies not-connected.
const VOICE_PAUSED_KEY = 'voicePaused';
let voicePaused = false;

export function isVoicePaused(): boolean {
  return voicePaused;
}

// --- Retry ladder ---

function clearSSERetryTimer(): void {
  if (sseRetryTimer) {
    clearTimeout(sseRetryTimer);
    sseRetryTimer = null;
  }
}

export function scheduleSSERetry(): void {
  // Never chase a reconnect the user paused — the single defensive choke for
  // the retry ladder, so a stray disconnect event can't re-arm it.
  if (voicePaused) return;
  if (sseRetryTimer) return;
  sseRetryTimer = setTimeout(async () => {
    sseRetryTimer = null;
    const found = await discoverPlugin();
    if (found) {
      // Discovery success is NOT connection success — the flag flips (and
      // the connect-edge work runs) only on the stream's real `connected`
      // signal via onSSEConnected. If the SSE never comes up, a
      // HEALTH_STATUS(false) / onerror / alarm probe re-arms the retry.
      connectSSE();
    } else {
      scheduleSSERetry();
    }
  }, sseBackoff.nextDelayMs(Date.now()));
}

// --- Connection-state paint ---

// Ambient connection state on the toolbar icon (piece A1 of
// notes/DESIGN_EXTENSION_CONNECTION_HEALTH.md). State, not error: connected
// shows a quiet dot; standalone shows NO badge at all — running without
// BranchKit is a first-class mode, and the extension can't distinguish
// "standalone by choice" from "host vanished" (the side that can — the
// plugin — owns that nudge). Driven from the same transitions that flip
// branchkitConnected, so there's no new state to maintain; the calls are
// idempotent and the badge itself persists across SW idle-restarts.
function updateConnectionBadge(connected: boolean): void {
  try {
    void chrome.action.setBadgeText({ text: connected ? '•' : '' });
    if (connected) {
      void chrome.action.setBadgeBackgroundColor({ color: '#2e7d32' });
    }
  } catch {
    // chrome.action unavailable (shouldn't happen in MV3) — badge is cosmetic.
  }
}

// The connected→down flip shared by the stream drop (onSSEDisconnected) and a
// deliberate pause (pauseVoice). Flag + toolbar badge + the content-facing
// paint mirror, kept together so the mirror write can't be forgotten on one
// path. Does NOT arm the retry ladder — that's the caller's call (the drop
// re-arms; pause must not).
function markConnectionDown(): void {
  bgState.branchkitConnected = false;
  updateConnectionBadge(false);
  void chrome.storage.local.set({ branchkitConnected: false });
}

// --- Connect / disconnect edges ---

// The one honest connect signal: the SSE stream's `connected` event, via
// Chrome's offscreen HEALTH_STATUS(true) or Firefox's direct EventSource.
// Runs on EVERY connected event, not just flag edges — a `connected` means a
// NEW stream was established, so the host/plugin may have restarted and the
// grammar heal is warranted. Edge-gating on branchkitConnected is what masked
// the b7399f5 healer: reconnect paths used to set the flag optimistically
// before the stream was up, so the "edge" never fired. The heal work itself
// (focus handshake, hydrate, rescan, republish, tab publish) is the
// onConnectedEdge hook — behavior, not transport.
// See notes/DESIGN_SSE_RESILIENCE.md (1).
export function onSSEConnected(): void {
  // Paused wins over a stray connect. Pause tears the stream down and stops
  // the retry ladder, but a superseded offscreen instance could still emit one
  // late HEALTH_STATUS(true); honoring it would re-open voice the user paused.
  if (voicePaused) return;
  bgState.branchkitConnected = true;
  updateConnectionBadge(true);
  // Mirror for content scripts (UI chrome — see plugin/connection-mirror.ts).
  void chrome.storage.local.set({ branchkitConnected: true });
  sseBackoff.onConnected(Date.now());
  clearSSERetryTimer();
  hooks.onConnectedEdge();
}

export function onSSEDisconnected(): void {
  markConnectionDown();
  scheduleSSERetry();
}

// --- SSE Connection (browser-adaptive) ---

/** Connect to the plugin's SSE stream using the best available method. */
export function connectSSE(): void {
  const port = getPluginPort();
  const token = getPluginToken();
  if (!port || !token) return;

  // The plugin's HTTP server is up once we have a port+token — fire the
  // connect-time feature pushes (command contribution, media presence).
  hooks.onPreConnect();

  if (hasOffscreenAPI) {
    // Chrome: delegate to offscreen document
    ensureOffscreen().then(() => notifyOffscreenConnect());
  } else {
    // Firefox: open EventSource directly in background script
    connectDirectSSE(port, token);
  }
}

// --- Chrome: Offscreen Document ---

export async function ensureOffscreen(): Promise<void> {
  if (!hasOffscreenAPI) return;
  try {
    const exists = await chrome.offscreen.hasDocument();
    if (!exists) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: [chrome.offscreen.Reason.BLOBS],
        justification: 'Maintain SSE connection to BranchKit actuator',
      });
    }
  } catch {
    // May fail if already creating
  }
}

// Tell offscreen doc to connect (or reconnect) with current plugin info
function notifyOffscreenConnect(): void {
  const port = getPluginPort();
  const token = getPluginToken();
  if (!port || !token) return;
  chrome.runtime.sendMessage({
    type: 'CONNECT_SSE',
    port,
    token,
    connId,
  }).catch(() => {});
}

// Close whichever SSE this engine holds. Chrome delegates to the offscreen
// document (which owns the EventSource); Firefox holds it directly. Closing
// via close() fires no onerror, so no HEALTH_STATUS(false) bounces back — the
// caller (pauseVoice) flips the connection-down state itself.
function teardownSSE(): void {
  if (hasOffscreenAPI) {
    chrome.runtime.sendMessage({ type: 'DISCONNECT_SSE' }).catch(() => {});
  } else if (directSSE) {
    directSSE.close();
    directSSE = null;
    directSSEUrl = null;
  }
}

// --- Voice pause (notes/DESIGN_VOICE_PAUSE.md) ---

// Enter the paused state: a standing choice to stop engaging voice. Tears the
// stream down, gates outbound transport, flips the connection-down paint
// mirror, and — crucially — does NOT arm the retry ladder. Sticky: persisted
// so an SW restart (init) honors it instead of auto-connecting.
export async function pauseVoice(): Promise<void> {
  voicePaused = true;
  setVoicePaused(true);        // gate outbound transport + drop cached creds
  clearSSERetryTimer();
  teardownSSE();
  markConnectionDown();        // flag + badge + mirror false (no retry)
  await chrome.storage.local.set({ [VOICE_PAUSED_KEY]: true });
}

// Leave the paused state and resume the normal boot path: discover, and either
// bring the stream up or arm the retry ladder if the host isn't there yet.
export async function resumeVoice(): Promise<void> {
  voicePaused = false;
  setVoicePaused(false);
  await chrome.storage.local.set({ [VOICE_PAUSED_KEY]: false });
  const found = await discoverPlugin();
  if (found) connectSSE();
  else scheduleSSERetry();
}

// Voice-pause intent (sticky across SW restart). Called from init() BEFORE any
// auto-connect decision; the caller honors the returned flag by skipping
// discovery/connect entirely. Syncs the transport gate and the content-facing
// mirror so a wake in the paused state presents identically to the pause
// action — opaque badges, no grammar traffic — without a flicker of connection.
export async function restoreVoicePaused(): Promise<boolean> {
  const paused = await chrome.storage.local.get(VOICE_PAUSED_KEY);
  voicePaused = paused[VOICE_PAUSED_KEY] === true;
  setVoicePaused(voicePaused);
  if (voicePaused) {
    // Close any stream that survived a pre-restart connection into this wake
    // (the offscreen document can outlive the SW). No-op if none exists — we
    // don't spin up an offscreen doc just to tear nothing down.
    teardownSSE();
    markConnectionDown();
  }
  return voicePaused;
}

// --- Firefox: Direct SSE in background script ---

function connectDirectSSE(port: number, token: string): void {
  // conn_id identifies this connection; the plugin binds it to the OS-focused
  // bundle via the focus handshake so dispatch/rescan target only the focused
  // browser and a spoken command doesn't also fire in a background browser.
  const url = `http://127.0.0.1:${port}/events?token=${token}&conn_id=${encodeURIComponent(connId)}`;

  // Already-connecting guard (DESIGN_SSE_RESILIENCE.md's deliberately-open
  // item, closed 2026-07-04). connectSSE() fires un-awaited from several
  // sites (retry ladder, init, postGrammarBatch's fresh-creds path); this
  // path used to close and reopen the EventSource unconditionally, so a
  // burst landing while the prior socket was still CONNECTING churned
  // connect/disconnect under one conn_id and could abort onSSEConnected's
  // heal (rescan + grammar republish) mid-flight. Chrome is immune — the
  // offscreen document serializes CONNECT_SSE. Keep the existing socket iff
  // it targets the same creds and isn't CLOSED; changed creds (host restart
  // minted a new port/token) still tear down and reconnect.
  if (directSSE && directSSEUrl === url && directSSE.readyState !== EventSource.CLOSED) {
    return;
  }
  if (directSSE) {
    directSSE.close();
    directSSE = null;
  }

  directSSEUrl = url;
  directSSE = new EventSource(url);

  directSSE.addEventListener('connected', () => {
    console.log('[BranchKit BG] SSE connected (direct)');
    // Same connect-edge work as Chrome's HEALTH_STATUS(true). Firefox
    // previously did a partial inline version (focus + hydrate only), which
    // meant no rescan, no host-restart grammar heal, and no backoff
    // bookkeeping on this engine.
    onSSEConnected();
  });

  directSSE.addEventListener('action', (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data);
      hooks.onEvent(data);
    } catch (err) {
      console.error('[BranchKit BG] SSE parse error:', err);
    }
  });

  directSSE.addEventListener('alphabet', (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data);
      if (Array.isArray(data?.words)) {
        hooks.onAlphabet(data.words);
      }
    } catch (err) {
      console.error('[BranchKit BG] alphabet parse error:', err);
    }
  });

  directSSE.onerror = () => {
    console.warn('[BranchKit BG] SSE disconnected (direct)');
    if (directSSE) {
      directSSE.close();
      directSSE = null;
    }
    onSSEDisconnected();
  };
}

// --- Connection health check (the 30s safety-net alarm body) ---

// Probes the actual stream state rather than trusting branchkitConnected —
// the offscreen document (or its EventSource) can die without a
// HEALTH_STATUS(false) ever reaching the SW, and a stale `true` used to
// disable this net entirely. That silent-drop window is what let stale creds
// wedge every POST (review 2026-06-29). Worst-case detection latency for a
// silent drop is one alarm period. notes/DESIGN_SSE_RESILIENCE.md (4).
export async function runConnectionCheck(): Promise<void> {
  // Paused: the safety net's whole job is keeping a connection alive, so it
  // has nothing to do. No probe, no retry.
  if (voicePaused) return;
  if (hasOffscreenAPI) {
    await ensureOffscreen();
    if (bgState.branchkitConnected && !(await probeOffscreenSSE())) {
      onSSEDisconnected();
    }
  } else if (
    bgState.branchkitConnected &&
    (!directSSE || directSSE.readyState !== EventSource.OPEN)
  ) {
    onSSEDisconnected();
  }

  // Kick off retry loop if not connected and no retry is pending
  if (!bgState.branchkitConnected) {
    scheduleSSERetry();
  }
}

// Ask the offscreen document whether its EventSource is actually OPEN.
// No response (offscreen gone, message dropped) counts as dead. A probe can
// catch a mid-reconnect stream in CONNECTING and trigger one redundant
// retry cycle; that self-corrects and connects are rare.
async function probeOffscreenSSE(): Promise<boolean> {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'SSE_STATUS' });
    return resp?.connected === true;
  } catch {
    return false;
  }
}
