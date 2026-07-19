/**
 * BranchKit Browser — media-presence reporter
 * (notes/DESIGN_VIDEO_MEDIA_COMMANDS.md, background-media arc).
 *
 * Tells the background whether THIS FRAME currently holds controllable
 * media: a large video (≥ MIN_VIDEO_DIM both dims — the same floor the
 * overlay gate and the media executors use, so "gated", "targetable", and
 * "present" can never disagree) or an `<audio>` element holding a source
 * (web music players). The background ORs the reports across a tab's
 * frames, folds in the audible-tab registry and the resume memory, and
 * mirrors the union to the browser plugin's media_active tag — the gate on
 * the media voice commands and the spoken "video" discovery mode.
 *
 * Cadence: a 2s session-resource interval — pauses on hidden tabs (their
 * media state is covered by the browser's audible flag, which needs no
 * content script), dies with the session. Cost on media-less pages is two
 * empty querySelectorAlls per tick; rects are read only when a video
 * exists. Reports fire on CHANGE only; the background owns redundancy (it
 * re-posts to the plugin on tab/window focus edges, so a dropped report
 * self-heals within one tick).
 */

import { MIN_VIDEO_DIM } from '../render/video-overlay';
import type { SessionResources } from '../lifecycle/session-resources';

/** Any controllable media in this frame's document (playing or not —
 *  presence gates eligibility, and `play` must be offerable on paused
 *  media). */
export function frameHasMedia(): boolean {
  for (const v of document.querySelectorAll('video')) {
    const r = v.getBoundingClientRect();
    if (r.width >= MIN_VIDEO_DIM && r.height >= MIN_VIDEO_DIM) return true;
  }
  for (const a of document.querySelectorAll('audio')) {
    if (a.currentSrc || a.readyState > 0) return true;
  }
  return false;
}

export function startVideoPresenceReporter(resources: SessionResources): void {
  let last: boolean | null = null;
  resources.interval(() => {
    const present = frameHasMedia();
    if (present === last) return;
    last = present;
    try {
      void chrome.runtime
        .sendMessage({ type: 'VIDEO_PRESENCE', present })
        .catch(() => {/* SW asleep or context invalidated — next change retries */});
    } catch {
      /* extension context invalidated */
    }
  }, 2000);
}
