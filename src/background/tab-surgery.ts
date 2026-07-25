/**
 * BranchKit Browser — tab-surgery primitives (service-worker side).
 *
 * Three voice-independent window/tab operations the browser plugin drives
 * over SSE for its tab-to-desk orchestration (plugin notes/DESIGN_TAB_TO_DESK.md):
 *
 *   query_windows              → inventory of this browser's normal windows
 *                                with bounds (the plugin frame-correlates
 *                                them against CG windows)
 *   move_active_tab_to_window  → tabs.move into a target window, optionally
 *                                activating it (the "merge" case)
 *   pop_active_tab             → windows.create({tabId}) at given bounds
 *                                (the "new window" case; the plugin then
 *                                sends that window to the target desktop)
 *
 * Every action carries a request_id and gets exactly one POST /surgery/result
 * reply — the first plugin→extension request/response on this transport.
 * Pure mechanism: no desk knowledge lives here, and nothing fires without a
 * plugin request, so standalone (no-plugin) behavior is untouched.
 */

import { postSurgeryResult } from '../plugin/plugin-api';

interface SurgeryWindowReport {
  window_id: number;
  left: number;
  top: number;
  width: number;
  height: number;
  state: string;
  active_tab_title: string;
}

// Actions this module claims off the SSE stream.
export const SURGERY_ACTIONS: ReadonlySet<string> = new Set([
  'query_windows',
  'move_active_tab_to_window',
  'pop_active_tab',
]);

function reportWindow(w: chrome.windows.Window): SurgeryWindowReport {
  const activeTab = w.tabs?.find((t) => t.active);
  return {
    window_id: w.id ?? -1,
    left: w.left ?? 0,
    top: w.top ?? 0,
    width: w.width ?? 0,
    height: w.height ?? 0,
    state: w.state ?? 'normal',
    active_tab_title: activeTab?.title ?? '',
  };
}

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function queryWindows(requestId: string): Promise<void> {
  const wins = await chrome.windows.getAll({ populate: true });
  const windows = wins.filter((w) => w.type === 'normal').map(reportWindow);
  await postSurgeryResult({ request_id: requestId, ok: true, windows });
}

async function moveActiveTabToWindow(requestId: string, windowId: number, activate: boolean): Promise<void> {
  const tab = await activeTab();
  if (tab?.id == null) {
    await postSurgeryResult({ request_id: requestId, ok: false, error: 'no active tab' });
    return;
  }
  const wasPinned = !!tab.pinned;
  await chrome.tabs.move(tab.id, { windowId, index: -1 });
  // Cross-window moves unpin in both browsers; restore the user's state.
  if (wasPinned) await chrome.tabs.update(tab.id, { pinned: true });
  if (activate) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(windowId, { focused: true });
  }
  await postSurgeryResult({ request_id: requestId, ok: true });
}

async function popActiveTab(
  requestId: string,
  bounds: { left?: number; top?: number; width?: number; height?: number },
): Promise<void> {
  const tab = await activeTab();
  if (tab?.id == null) {
    await postSurgeryResult({ request_id: requestId, ok: false, error: 'no active tab' });
    return;
  }
  const win = await chrome.windows.create({ tabId: tab.id, focused: true, ...bounds });
  await postSurgeryResult({ request_id: requestId, ok: true, window: reportWindow(win) });
}

// Entry point from the SSE routing switch. Always replies — an exception
// becomes an ok:false reply so the plugin's waiter fails fast instead of
// sitting out its timeout.
export function handleSurgeryAction(action: string, params: Record<string, string> | undefined): void {
  const requestId = params?.request_id ?? '';
  if (!requestId) {
    console.warn('[BranchKit BG] surgery action without request_id:', action);
    return;
  }
  const num = (key: string): number | undefined => {
    const v = parseInt(params?.[key] ?? '', 10);
    return Number.isFinite(v) ? v : undefined;
  };
  void (async () => {
    try {
      if (action === 'query_windows') {
        await queryWindows(requestId);
      } else if (action === 'move_active_tab_to_window') {
        const windowId = num('window_id');
        if (windowId === undefined) throw new Error('missing window_id');
        await moveActiveTabToWindow(requestId, windowId, params?.activate === 'true');
      } else if (action === 'pop_active_tab') {
        await popActiveTab(requestId, {
          left: num('left'), top: num('top'), width: num('width'), height: num('height'),
        });
      }
    } catch (e) {
      console.warn('[BranchKit BG] surgery action failed:', action, e);
      await postSurgeryResult({ request_id: requestId, ok: false, error: String(e) }).catch(() => {});
    }
  })();
}
