/**
 * BranchKit Browser — video-presence reporter
 * (notes/DESIGN_VIDEO_MEDIA_COMMANDS.md, step 3).
 *
 * Tells the background whether THIS FRAME currently holds a large video
 * (≥ MIN_VIDEO_DIM both dims — the same floor the overlay gate and the media
 * executors use, so "gated", "targetable", and "present" can never disagree).
 * The background ORs the reports across a tab's frames and mirrors the
 * focused tab's answer to the browser plugin, which holds the non-exclusive
 * video_present tag gating the media voice commands and the spoken "video"
 * discovery mode.
 *
 * Cadence: a 2s session-resource interval — pauses on hidden tabs (a hidden
 * tab's presence is irrelevant until refocus, and the interval resumes with
 * the tab), dies with the session. Cost on video-less pages is one empty
 * querySelectorAll per tick; rects are read only when a candidate exists.
 * Reports fire on CHANGE only; the background owns redundancy (it re-posts
 * to the plugin on tab/window focus edges, so a dropped report self-heals
 * within one tick).
 */

import { MIN_VIDEO_DIM } from '../render/video-overlay';
import type { SessionResources } from '../lifecycle/session-resources';

/** Any large video in this frame's document (playing or not — presence gates
 *  eligibility, and `play` must be offerable on a paused video). */
export function frameHasLargeVideo(): boolean {
  for (const v of document.querySelectorAll('video')) {
    const r = v.getBoundingClientRect();
    if (r.width >= MIN_VIDEO_DIM && r.height >= MIN_VIDEO_DIM) return true;
  }
  return false;
}

export function startVideoPresenceReporter(resources: SessionResources): void {
  let last: boolean | null = null;
  resources.interval(() => {
    const present = frameHasLargeVideo();
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
