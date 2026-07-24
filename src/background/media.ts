/**
 * BranchKit Browser — background media control (service-worker side).
 *
 * notes/DESIGN_VIDEO_MEDIA_COMMANDS.md, background-media arc. Three signal
 * sources compose into one "controllable media exists" union, mirrored to the
 * plugin's non-exclusive media_active tag (the gate on the media voice
 * commands and the spoken "video" mode — deliberately NOT behind browser
 * focus, so a background video pauses from any app):
 *
 *   1. Frame presence reports (observe/video-presence.ts, visible tabs
 *      only): 2s change-only ticks; the SW ORs a tab's frames.
 *   2. The audible-tab registry: chrome.tabs.onUpdated's `audible` flag —
 *      the browser's own speaker-icon tracking. Hidden-tab-safe,
 *      throttle-proof, and it needs no content script.
 *   3. The resume memory: the last tab a media command controlled. A
 *      background-pause makes nothing audible; without this, "play" would
 *      go deaf. Held until that tab closes or full-navigates.
 *
 * Posts to the plugin are deliberately redundant on every relevant edge
 * (report, audible change, tab switch, window focus, reconnect) — the
 * plugin drops per-conn slots on disconnect, and redundant idempotent
 * posts are what make that safe (the palette-clear philosophy: err on
 * firing redundantly). Lifted out of background.ts
 * (notes/DESIGN_RESTRUCTURE_ROUND3.md); initMedia() registers the audible
 * listener + seed so wiring stays explicit.
 */

import { ensureConnected, postToPlugin } from '../plugin/actuator-client';
import { bgState, connId } from './state';

const videoPresenceByTab = new Map<number, Map<number, boolean>>();
// tabId → performance-agnostic activation stamp (monotonic counter — most
// recently became audible wins the multi-playing routing tiebreak).
const audibleTabs = new Map<number, number>();
let audibleStamp = 0;
let lastControlledTab: number | null = null;
// Tracks chrome.windows.onFocusChanged so routing can prefer the focused
// tab's media only when the browser actually has OS focus.
let browserWindowFocused = true;

export function setBrowserWindowFocused(focused: boolean): void {
  browserWindowFocused = focused;
}

function tabHasVideo(tabId: number | null): boolean {
  if (tabId === null) return false;
  const frames = videoPresenceByTab.get(tabId);
  if (!frames) return false;
  for (const present of frames.values()) if (present) return true;
  return false;
}

function mediaControllable(): boolean {
  return (
    tabHasVideo(bgState.cachedActiveTabId) ||
    audibleTabs.size > 0 ||
    lastControlledTab !== null
  );
}

export async function syncMediaActive(): Promise<void> {
  if (!(await ensureConnected())) return;
  await postToPlugin('/media-active', {
    conn_id: connId,
    active: mediaControllable(),
  });
}

// A frame's large-video presence changed (VIDEO_PRESENCE message). Update the
// tab's frame map and re-mirror the active tab's OR to the plugin (cheap
// no-op post when the change is in a background tab).
export function setVideoPresence(tabId: number, frameId: number, present: boolean): void {
  let frames = videoPresenceByTab.get(tabId);
  if (!frames) {
    frames = new Map();
    videoPresenceByTab.set(tabId, frames);
  }
  frames.set(frameId, present);
  void syncMediaActive();
}

// Full document load (webNavigation.onCommitted, top frame): the old page's
// frames (and their media-presence reports) are gone; drop the tab's frame
// map so a stale `true` can't outlive the page, and release the resume
// memory if it pointed here (the media it remembered no longer exists). The
// new page's reporters re-populate within one tick. SPA navs keep frames
// alive, so their entries stay valid.
export function clearTabMediaOnNav(tabId: number): void {
  const dropped = videoPresenceByTab.delete(tabId);
  const wasResume = lastControlledTab === tabId;
  if (wasResume) lastControlledTab = null;
  if (dropped || wasResume) void syncMediaActive();
}

// Tab closed: drop every media signal it held and re-assert the union.
export function clearTabMediaOnClose(tabId: number): void {
  videoPresenceByTab.delete(tabId);
  audibleTabs.delete(tabId);
  if (lastControlledTab === tabId) lastControlledTab = null;
  void syncMediaActive();
}

export const MEDIA_ACTIONS = new Set([
  'media_play_pause', 'media_mute', 'media_speed', 'media_seek', 'media_restart',
]);

/**
 * Which tab should a media verb drive? Fixed priority (design note):
 * (1) the focused tab's media when the browser is frontmost — control what
 * you see; (2) the most recently audible tab — else what you hear (the
 * single-audible case is this rule's n=1 form); (3) the resume memory, so
 * pause → work → "play" round-trips with nothing audible.
 */
export function resolveMediaTargetTab(): number | null {
  if (browserWindowFocused && tabHasVideo(bgState.cachedActiveTabId)) {
    return bgState.cachedActiveTabId;
  }
  let best: number | null = null;
  let bestStamp = -1;
  for (const [tabId, stamp] of audibleTabs) {
    if (stamp > bestStamp) { best = tabId; bestStamp = stamp; }
  }
  if (best !== null) return best;
  return lastControlledTab;
}

export function sendMediaActionToTab(tabId: number, payload: any): void {
  lastControlledTab = tabId;
  // All frames — the per-frame no-op executor handles iframe embeds.
  chrome.tabs.sendMessage(tabId, { type: 'BRANCHKIT_ACTION', payload }).catch((e: Error) => {
    console.warn('[BranchKit BG] media dispatch failed:', e.message);
  });
  // The target may now be controllable only via resume memory — re-assert.
  void syncMediaActive();
}

/** "pause everything" / "mute everything": fan the verb out to every
 *  audible tab — the shut-up intent. Deliberately audible-only (no
 *  paused-media sweep) and deliberately no "faster everything". */
export function handleMediaAllAction(action: string): void {
  const op = action === 'media_pause_all'
    ? { action: 'media_play_pause', params: { op: 'pause' } }
    : { action: 'media_mute', params: { op: 'mute' } };
  for (const tabId of audibleTabs.keys()) {
    lastControlledTab = tabId;
    chrome.tabs.sendMessage(tabId, {
      type: 'BRANCHKIT_ACTION',
      payload: { action: op.action, params: op.params },
    }).catch(() => {/* tab may be closing */});
  }
  void syncMediaActive();
}

// Registers the audible-flag listener and seeds the registry — tabs already
// making sound when the worker wakes must count without waiting for an
// audible transition. Called once from background.ts.
export function initMedia(): void {
  void chrome.tabs.query({ audible: true }).then((tabs) => {
    for (const t of tabs) {
      if (t.id != null && !audibleTabs.has(t.id)) audibleTabs.set(t.id, ++audibleStamp);
    }
    if (tabs.length) void syncMediaActive();
  }).catch(() => {});

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (typeof changeInfo.audible !== 'boolean') return;
    if (changeInfo.audible) {
      audibleTabs.set(tabId, ++audibleStamp);
    } else {
      audibleTabs.delete(tabId);
    }
    void syncMediaActive();
  });
}
