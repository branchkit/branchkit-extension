/**
 * BranchKit Browser — hint-diagnostics snapshot forwarding (SW side).
 *
 * Lifted out of background.ts when the ceiling ratchet fired on its own
 * author (2026-07-24 — the pool-snapshot attach tipped the monolith over
 * its line ceiling; per DESIGN_RESTRUCTURE_ROUND3.md the answer is a
 * feature module, not a raised ceiling).
 */

import type { MessageHandler } from './message-router';
import { ensureConnected, postToPlugin, getActuatorJson } from '../plugin/actuator-client';
import { buildReconcileReport, type ReconcileWrapper, type ReconcileReport, type MatchableView } from '../debug/reconcile';
import { poolSnapshot } from '../labels/label-pool';

// Hint-diagnostics snapshot (Phase 2b). Content script fires a
// DEBUG_SNAPSHOT message with the structured payload it built (per
// docs/completed/DESIGN_HINT_DIAGNOSTICS.md §2). We:
//
//   1. POST the JSON to /debug-snapshot (plugin writes snapshot.json).
//   2. captureVisibleTab on the sender's tab.windowId. §2.5(d) — using
//      sender.tab.windowId rather than the currently-focused-tab id
//      avoids the race where the user has switched tabs between
//      pressing Ctrl+Alt+A and the SW handling the message.
//   3. POST the PNG (or capture error) to /debug-snapshot/screenshot
//      so the plugin can attach it / patch screenshot_error per §2.5(e).
//
// Best-effort end to end: any failure logs to the console and abandons
// the snapshot. The plugin endpoint either succeeded (snapshot.json on
// disk) or didn't; partial state is OK because /debug-snapshot/screenshot
// is keyed by snapshot_id and the plugin tolerates missing follow-ups.
export async function handleDebugSnapshot(
  payload: unknown,
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  // Snapshots can be triggered at any time — including before plugin
  // discovery has run. Auto-discover before bailing.
  if (!(await ensureConnected())) {
    console.warn('[branchkit] debug snapshot: plugin not discovered');
    return;
  }
  const snapshotId =
    typeof payload === 'object' && payload !== null && 'snapshot_id' in payload
      ? String((payload as { snapshot_id: unknown }).snapshot_id)
      : '';
  if (!snapshotId) {
    console.warn('[branchkit] debug snapshot: missing snapshot_id');
    return;
  }

  // Layer-2 painted/matchable reconcile (one-shot, demand-driven). Fetches the
  // actuator's matchable view and joins it with the painted set already in
  // `payload`, attaching a classified report so it lands in snapshot.json and
  // the SW log. Non-fatal: a failed fetch must not block the snapshot. Runs
  // only here, on the debug-snapshot trigger — zero steady-state cost.
  try {
    const matchable = await getActuatorJson('/inspector/matchable');
    const snap = payload as { wrappers?: ReconcileWrapper[]; reconcile?: ReconcileReport };
    const report = buildReconcileReport(snap.wrappers ?? [], matchable as MatchableView | null);
    snap.reconcile = report;
    console.log('[branchkit] painted/matchable reconcile:', report.verdict.join(' | '), report);
  } catch (e) {
    console.warn('[branchkit] reconcile failed (non-fatal):', e);
  }

  // Attach the SW pool's view for this tab — the routing truth the CS
  // cannot see. Joined against the CS's painted set, this is the whole
  // painted-vs-routable diagnosis in one file (no SW-console spelunking).
  try {
    const senderTab = sender.tab?.id;
    if (typeof senderTab === 'number') {
      (payload as { sw_pool?: unknown }).sw_pool = await poolSnapshot(senderTab);
    }
  } catch {
    // diagnostic-only; never block the snapshot
  }

  // Step 1: structured-state POST.
  const res = await postToPlugin('/debug-snapshot', payload);
  if (!res) {
    console.warn('[branchkit] debug-snapshot POST exception');
    return;
  }
  if (!res.ok) {
    console.warn(`[branchkit] debug-snapshot POST failed: HTTP ${res.status}`);
    return;
  }

  // Step 2: captureVisibleTab on the sender's window. Per §2.5(d), use
  // sender.tab.windowId (not the focused-window default) to avoid
  // capturing a different tab if the user has switched focus since
  // pressing Ctrl+Alt+A. If windowId is unavailable (rare — message
  // came from a context without a tab), record an error rather than
  // letting Chrome silently fall back.
  const windowId = sender.tab?.windowId;
  let pngBase64 = '';
  let captured = false;
  let captureError = '';
  if (windowId === undefined) {
    captureError = 'sender.tab.windowId unavailable';
  } else {
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
      const match = /^data:image\/png;base64,(.+)$/.exec(dataUrl);
      if (match) {
        pngBase64 = match[1];
        captured = true;
      } else {
        captureError = `unexpected dataUrl shape: ${dataUrl.slice(0, 40)}`;
      }
    } catch (e) {
      captureError = e instanceof Error ? e.message : String(e);
    }
  }

  // Step 3: screenshot follow-up. Exactly one of png_base64 / error.
  const body: Record<string, string> = { snapshot_id: snapshotId };
  if (captured) body.png_base64 = pngBase64;
  else body.error = captureError || 'unknown';
  await postToPlugin('/debug-snapshot/screenshot', body);
}

/** Message handler owned by this module (notes/DESIGN_ENTRY_POINT_TOPOLOGY.md). */
export const debugSnapshotMessageHandlers: Record<string, MessageHandler> = {
  DEBUG_SNAPSHOT: (message, sender) => {
    if (!message.payload) return;
    void handleDebugSnapshot(message.payload, sender);
  },
};
