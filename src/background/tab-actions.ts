/**
 * BranchKit Browser — tab and zoom verb handlers (service-worker side).
 *
 * One handler per verb family, shared by both entry points: the content
 * dispatcher's TAB_ACTION / ZOOM_ACTION messages (keyboard) and the SSE
 * action intercept (voice — handled in the background so the verbs work even
 * when the active page has no content script, e.g. a chrome:// page).
 * Lifted out of background.ts (notes/DESIGN_RESTRUCTURE_ROUND3.md).
 */

import { TabAction, ZoomAction } from '../types';
import { cycleTabIndex } from './tab-nav';
import { loadMru, previousCandidates } from './tab-mru';
import { scheduleTabPublish } from './tab-collection';
import { bgState } from './state';

// Voice → tab verb intercept: catalog command id → TabAction. The ids are the
// same ones the content dispatcher registers for the keyboard path; this map
// is what lets the background claim them off the SSE stream first.
export const TAB_ACTION_BY_ID: Readonly<Record<string, TabAction>> = {
  next_tab: 'next', previous_tab: 'previous', new_tab: 'new', close_tab: 'close',
  restore_tab: 'restore', duplicate_tab: 'duplicate', pin_tab: 'pin', mute_tab: 'mute',
  first_tab: 'first', last_tab: 'last', goto_tab: 'goto',
  move_tab_left: 'move_left', move_tab_right: 'move_right', last_active_tab: 'last_active',
};

// Voice → zoom verb intercept: catalog command id → ZoomAction, mirroring
// TAB_ACTION_BY_ID. Lets the background claim these off the SSE stream.
export const ZOOM_ACTION_BY_ID: Readonly<Record<string, ZoomAction>> = {
  zoom_in: 'in', zoom_out: 'out', zoom_reset: 'reset',
};

// The one cross-window tab jump: focus the tab's window, then activate the
// tab. Shared by the last_active verb, "tab <codeword>" (switchToTabById),
// and the palette's switch_tab dispatch — cross-window by design in all
// three. Returns false instead of throwing on a stale/closed id so each
// caller keeps its own miss policy (try the next MRU candidate, refresh the
// tab collection, or silently no-op).
export async function focusWindowAndActivateTab(tabId: number): Promise<boolean> {
  try {
    const t = await chrome.tabs.get(tabId);
    await chrome.windows.update(t.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
    return true;
  } catch {
    return false;
  }
}

// Tab verbs (notes/DESIGN_TAB_NAVIGATION.md, "Tab verbs"). `index` is goto's
// 1-based tab position.
export async function handleTabAction(action: TabAction, index?: number): Promise<void> {
  if (action === 'new') {
    await chrome.tabs.create({});
    return;
  }
  if (action === 'restore') {
    // Most recently closed tab or window (browser Cmd/Ctrl+Shift+T).
    // Needs the `sessions` permission.
    try { await chrome.sessions.restore(); } catch { /* nothing to restore */ }
    return;
  }
  if (action === 'last_active') {
    // Walk the MRU stack for the newest still-existing tab that isn't the
    // current one; closed tabs stay in the stack, so skip the dead ids.
    for (const id of previousCandidates(await loadMru(), bgState.cachedActiveTabId)) {
      if (await focusWindowAndActivateTab(id)) return;
      // tab gone — try the next candidate
    }
    return;
  }

  const tabs = await chrome.tabs.query({ currentWindow: true });
  const activeIdx = tabs.findIndex((t) => t.active);
  const active = tabs[activeIdx];
  if (activeIdx < 0 || active?.id == null) return;

  switch (action) {
    case 'next':
    case 'previous': {
      if (tabs.length < 2) return;
      const target = tabs[cycleTabIndex(activeIdx, tabs.length, action)];
      if (target?.id != null) await chrome.tabs.update(target.id, { active: true });
      return;
    }
    case 'close':
      await chrome.tabs.remove(active.id);
      return;
    case 'duplicate':
      await chrome.tabs.duplicate(active.id);
      return;
    case 'pin':
      await chrome.tabs.update(active.id, { pinned: !active.pinned });
      return;
    case 'mute':
      await chrome.tabs.update(active.id, { muted: !active.mutedInfo?.muted });
      return;
    case 'first':
    case 'last':
    case 'goto': {
      const pos = action === 'first' ? 1 : action === 'last' ? tabs.length : index ?? 1;
      const target = tabs[Math.min(Math.max(pos, 1), tabs.length) - 1];
      if (target?.id != null && !target.active) await chrome.tabs.update(target.id, { active: true });
      return;
    }
    case 'move_left':
    case 'move_right': {
      const to = Math.min(Math.max(activeIdx + (action === 'move_right' ? 1 : -1), 0), tabs.length - 1);
      if (to !== activeIdx) await chrome.tabs.move(active.id, { index: to });
      return;
    }
  }
}

// Page zoom (Vimium zi/zo/z0). chrome.tabs.getZoom/setZoom act per-tab, so —
// like the tab verbs — this runs in the background for both keyboard (ZOOM_ACTION
// message) and voice (SSE intercept). Steps by 10% within Chrome's own 25%–500%
// bounds; `reset` (setZoom 0) returns to the tab's default factor.
const ZOOM_STEP = 0.1;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 5;

export async function handleZoomAction(action: ZoomAction): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id == null) return;
  try {
    if (action === 'reset') {
      await chrome.tabs.setZoom(tab.id, 0);
      return;
    }
    const current = await chrome.tabs.getZoom(tab.id);
    const next = action === 'in' ? current + ZOOM_STEP : current - ZOOM_STEP;
    await chrome.tabs.setZoom(tab.id, Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next)));
  } catch {
    // Zoom is disallowed on some pages (e.g. the New Tab Page, PDF viewer) —
    // a silent no-op there matches Chrome's own behaviour.
  }
}

// Voice "tab <codeword>": the matched collection entry's tab_id arrives as an
// action param (the browser_tabs collection's value_field). A stale id (tab
// closed since the last publish) just refreshes the collection so the dead
// entry drops.
export async function switchToTabById(tabId: number): Promise<void> {
  if (!(await focusWindowAndActivateTab(tabId))) {
    scheduleTabPublish();
  }
}
