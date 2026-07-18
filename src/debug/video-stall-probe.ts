/**
 * Video-stall probe (Shorts freeze investigation, 2026-07-18).
 *
 * The user-reported freeze signature is a SINGLE video element's pipeline
 * dying — currentTime keeps advancing (audio plays on) while
 * getVideoPlaybackQuality().totalVideoFrames goes flat — with the page, the
 * CS, and the next short all healthy. The 5s PERF_REPORT cadence is too
 * coarse to correlate the stall moment with extension activity, so this
 * probe firehoses the exact transition:
 *
 *   video_stall:start            — frames went flat under an advancing clock
 *   video_stall:end:<n>s         — frames resumed after n seconds
 *
 * Sampling is 1Hz on the active <video>, reads only media state (no layout),
 * and registers through session resources so it pauses with hidden tabs and
 * dies with the session. Events are transition-only — a stalled video emits
 * exactly one start (and one end if it recovers), not one event per second.
 */

import { firehoseStep } from './firehose';
import type { SessionResources } from '../lifecycle/session-resources';

interface Sample {
  v: HTMLVideoElement;
  ct: number;
  frames: number;
}

export function startVideoStallProbe(resources: SessionResources): void {
  if (window.top !== window) return; // top frame only

  let last: Sample | null = null;
  let stalledSince: number | null = null;

  resources.interval(() => {
    let v: HTMLVideoElement | null = null;
    for (const cand of document.querySelectorAll('video')) {
      if (!cand.paused && cand.currentTime > 0) { v = cand; break; }
    }
    if (!v || typeof v.getVideoPlaybackQuality !== 'function') {
      last = null;
      stalledSince = null;
      return;
    }
    const frames = v.getVideoPlaybackQuality().totalVideoFrames;
    const ct = v.currentTime;

    if (last && last.v === v) {
      const clockAdvanced = ct - last.ct > 0.5;
      const framesFlat = frames === last.frames && frames > 0;
      if (clockAdvanced && framesFlat) {
        if (stalledSince === null) {
          stalledSince = performance.now();
          firehoseStep('video_stall:start', 1);
        }
      } else if (stalledSince !== null && frames > last.frames) {
        const secs = Math.round((performance.now() - stalledSince) / 1000);
        stalledSince = null;
        firehoseStep(`video_stall:end:${secs}s`, 1);
      }
    } else {
      // New/changed element: previous stall (if any) ended by replacement.
      if (stalledSince !== null) {
        const secs = Math.round((performance.now() - stalledSince) / 1000);
        stalledSince = null;
        firehoseStep(`video_stall:gone:${secs}s`, 1);
      }
    }
    last = { v, ct, frames };
  }, 1000);
}
