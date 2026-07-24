/**
 * BranchKit Browser — typed plugin API surface (service-worker side).
 *
 * One home for the SW's typed calls onto the browser plugin's HTTP endpoints,
 * lifted out of background.ts (notes/DESIGN_RESTRUCTURE_ROUND3.md). Each is a
 * thin, best-effort wrapper over actuator-client's transport primitives; the
 * one substantial member is postGrammarBatch, which also owns the SW's
 * letter-token <-> spoken-codeword translation at the plugin boundary.
 *
 * actuator-client stays pure transport (discovery, creds, authed POST);
 * this module is what the endpoints MEAN. Callers own when to fire them.
 */

import { DispatchResult, GrammarBatchRequest, GrammarBatchResponse } from '../types';
import { tokenToSpokenCodeword, spokenCodewordToToken } from '../labels/words';
import { ensureConnected, postToPlugin, getPluginPort, getPluginToken } from './actuator-client';
import { connectSSE } from './sse-transport';
import { bgState, connId } from '../background/state';

// Forward a content-script dispatch outcome to the plugin's POST
// /dispatch-result. Best-effort; the plugin can survive missing reports.
export async function forwardDispatchResult(result: DispatchResult): Promise<void> {
  if (!(await ensureConnected())) return;
  await postToPlugin('/dispatch-result', result);
}

export async function forwardDebugLog(tag: string, data: unknown): Promise<void> {
  if (!(await ensureConnected())) return;
  await postToPlugin('/debug-log', { tag, data });
}

// Sibling of forwardDebugLog. Pumps the content script's perf snapshot
// to the plugin's /perf-report endpoint, which appends to a JSONL trail
// for offline analysis. See plugins/browser/src/perf_report.go and
// src/content.ts (search PERF_REPORT). Diagnostic-only, no retry.
export async function forwardPerfReport(payload: { url: string; tab_id: number; browser: string; snapshot: unknown }): Promise<void> {
  if (!(await ensureConnected())) return;
  await postToPlugin('/perf-report', payload);
}

// Sibling of forwardDebugLog that targets the per-plugin debug log
// channel (plugin-logs/browser.log) instead of the shared actuator.log.
// Use for plugin-internal diagnostic chatter that doesn't belong
// interleaved with the actuator's cross-cutting coordination lines —
// see docs/completed/DESIGN_PLUGIN_LOGGING.md and DESIGN_PLUGIN_LOG_LEVELS.md.
//
// `level` is one of trace/debug/info/warn/error. Defaults to "debug"
// for callers that haven't migrated to v2's per-level emit. The
// underlying plugin endpoint also defaults missing/unknown levels to
// "debug" so the wire surface is robust to extension-side typos.
export async function forwardPluginDebugLog(
  tag: string,
  data: unknown,
  level: string = 'debug',
): Promise<void> {
  if (!(await ensureConnected())) return;
  await postToPlugin('/plugin-debug-log', { tag, data, level });
}

// Tell the plugin to end a hint session. Two scopes:
//   - tab-wide: omit `frameId`. Plugin Deletes every frame's tracked
//     codewords for this tab and clears the hints tag. Used on tab
//     switch / tab close / navigation — the user can't be addressing
//     a stale tab's hints anymore.
//   - frame-scoped: pass `frameId`. Plugin Deletes only that frame's
//     codewords; hints tag stays held if other frames in the tab are
//     still live. Used on iframe removal / cross-document nav / bfcache
//     evict via the frame-liveness Port's onDisconnect — siblings in
//     the same tab may still be live.
//
// Both scopes are part of the Option B C7 cleanup story
// (notes/DESIGN_HINT_PIPELINE_RESYNC.md). The tab-wide call replaces
// the implicit "stop pushing" cleanup the old whole-grammar path did
// via diffPrefixesToDelete.
export async function forwardHintsSessionEnd(reason: string, tabId: number, frameId?: number): Promise<void> {
  if (!(await ensureConnected())) return;
  // conn_id scopes the cleanup to THIS browser's frame sessions — tab ids
  // are browser-local and can collide across connected browsers, and the
  // plugin's session keys are conn-scoped (storm-arc last mile).
  const body: { conn_id: string; reason: string; tab_id: number; frame_id?: number } =
    { conn_id: connId, reason, tab_id: tabId };
  if (typeof frameId === 'number') body.frame_id = frameId;
  await postToPlugin('/hints/session_end', body);
}

// Tell the plugin to pre-arm the hints tag for an imminent hints-eligible
// session on `tabId`. Triggered on tab activation in always-mode: the plugin
// fires its eager-arm bridge (same one used for browser app focus) so the
// codeword-vs-alphabet disambiguator is in place before the new tab's
// grammar push arrives. If grammar doesn't arrive within the eager-arm
// timeout (2s), the plugin auto-clears.
export async function forwardHintsSessionStart(reason: string, tabId: number): Promise<void> {
  if (!(await ensureConnected())) return;
  await postToPlugin('/hints/session_start', { reason, tab_id: tabId });
}

// Per-batch grammar push (Option B). The content script's batched
// doScan sends one of these per 10-20 elements; the SW stamps
// tab_id + frame_id from sender and POSTs to /grammar/batch. Plugin
// runs the per-element Puts and returns a succeeded/failed split
// the content script uses to paint or releaseLabel each element.
//
// Failure modes (return value):
//  - Plugin unreachable → empty succeeded, every element failed
//    with reason "transport". Lets the content script unwind the
//    batch cleanly instead of mismatched state.
export async function postGrammarBatch(
  tabId: number,
  frameId: number,
  request: Omit<GrammarBatchRequest, 'tab_id' | 'frame_id'>,
): Promise<GrammarBatchResponse> {
  if (!getPluginPort() || !getPluginToken()) {
    // ensureConnected (not raw discoverPlugin): single-flight + negative
    // cache, so a burst of batches against a down host can't each fire a
    // discovery fetch + connectSSE cycle.
    const found = await ensureConnected();
    if (!found) return transportFailure(request);
    // Fresh creds (cold start, or a cred-clear after the old host died) —
    // bring the SSE up too. The connected flag flips on the stream's real
    // signal, not here.
    connectSSE();
  }

  // Voice overlay translation (outbound): the content script speaks in letter
  // tokens ("c g"); the plugin's grammar speaks in codewords ("cape glad").
  // Translate every element + queued delete here so the plugin is unchanged.
  // With no overlay loaded this is identity (letters pass through).
  const translatedElements = request.elements.map(e => ({
    ...e,
    codeword: tokenToSpokenCodeword(e.codeword),
  }));
  const translatedDeletes = request.delete_codewords?.map(tokenToSpokenCodeword);

  // Stamp the connection nonce here, not in the content script. The plugin's
  // cross-browser focus gate keys off the connId↔bundle binding (established
  // by the focus handshake) to accept grammar only from the OS-focused
  // browser. tab_id/frame_id come from the message sender.
  const fullRequest: GrammarBatchRequest = {
    ...request,
    elements: translatedElements,
    ...(translatedDeletes ? { delete_codewords: translatedDeletes } : {}),
    tab_id: tabId,
    frame_id: frameId,
    conn_id: connId,
  };
  const r = await postToPlugin('/grammar/batch', fullRequest);
  if (!r || !r.ok) return transportFailure(request);
  try {
    const resp = await r.json() as GrammarBatchResponse;
    // Translate the response's codewords back to letter tokens so the content
    // script — which only knows letters — matches them against its wrappers.
    return {
      ...resp,
      succeeded: (resp.succeeded ?? []).map(spokenCodewordToToken),
      failed: (resp.failed ?? []).map(f => ({ ...f, codeword: spokenCodewordToToken(f.codeword) })),
    };
  } catch {
    return transportFailure(request);
  }
}

export function transportFailure(
  request: Omit<GrammarBatchRequest, 'tab_id' | 'frame_id'>,
): GrammarBatchResponse {
  return {
    result: 'error',
    succeeded: [],
    failed: request.elements.map(e => ({ codeword: e.codeword, reason: 'transport' })),
  };
}

// Tell the plugin this browser's connection just gained (or lost) OS focus.
// The plugin binds connId to the OS-focused bundle on a focused:true claim;
// identity comes from the OS, this only says "which connection is focused now."
// Best-effort: a dropped focus POST self-heals on the next focus transition.
export async function postFocus(focused: boolean): Promise<void> {
  // Bail-on-miss (no discovery): focus claims only matter when already connected.
  await postToPlugin('/focus', { conn_id: connId, focused });
}

// Tell the plugin which tab is active in this browser's window. Distinct from
// postFocus: this carries no focus claim and never affects the plugin's
// connection→bundle binding — it only updates the focused-tab signal the
// per-source grammar projection (Option B) keys off. The plugin accepts it
// only from the connection it currently treats as the focused browser, so
// sending it from a background window is harmless. Best-effort.
export async function postActiveTab(tabId: number | null): Promise<void> {
  if (tabId == null) return;
  // Bail-on-miss (no discovery): never affects the connection→bundle binding.
  await postToPlugin('/active-tab', { conn_id: connId, tab_id: tabId });
}

// Claim focus at SSE-connect time if a window of this browser is currently the
// OS-focused window. Covers cold start: the browser is already frontmost when
// its extension connects, so no onFocusChanged fires to trigger the handshake.
export async function assertFocusIfFocused(): Promise<void> {
  try {
    const win = await chrome.windows.getLastFocused();
    if (win.focused && win.type === 'normal') {
      void postFocus(true);
      void postActiveTab(bgState.cachedActiveTabId);
    }
  } catch {
    // window query unavailable; onFocusChanged covers subsequent transitions
  }
}
