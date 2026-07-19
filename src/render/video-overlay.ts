/**
 * Video-overlay gate (Shorts freeze amplification, 2026-07-18).
 *
 * Firefox's WebRender has a known race in video compositor-surface
 * management (bugzilla 1989948 class): the video's presentation freezes
 * (audio continues, decode healthy) while only externally-dirtied regions
 * repaint. The bug is Mozilla's — measured with the extension fully
 * disabled — but overlay layers stacked on the video surface and churned at
 * every SPA advance re-roll the race constantly: always-mode froze ~1-in-2
 * Shorts vs ~1-in-35 with no hosts built vs rare with the extension off.
 *
 * The gate stops the dice-rolling: a badge whose target sits mostly inside
 * an actively-playing large video does not paint while that video plays.
 * Suppression only — no displacement (edge-fallback placement was retired
 * 2026-06 for re-derivation stickiness; do not re-raise it here). Codewords
 * stay live, so on-video controls remain voice-actionable. Everything beside
 * the video (action rail, nav, comments) is untouched.
 *
 * Cost profile: zero on video-less pages (one cached querySelectorAll per
 * 250ms window, early-out on empty). The race is Firefox-only, so the
 * default is ON iff Firefox (content.ts boot read); on Chrome the gate
 * would be pure accessibility cost (notes/DESIGN_VIDEO_MEDIA_COMMANDS.md).
 * `bkVideoOverlayGate` storage flag overrides in both directions, mirrored
 * to `data-bk-video-overlay-gate` on documentElement for the trail.
 */

let enabled = true;

export function setVideoOverlayGateEnabled(on: boolean): void {
  enabled = on;
}

export function isVideoOverlayGateEnabled(): boolean {
  return enabled;
}

interface RectsCache {
  rects: DOMRect[];
  at: number;
}

let cache: RectsCache | null = null;
const CACHE_TTL_MS = 250;
// "Large player" floor — excludes thumbnails, PiP minis, hover previews.
const MIN_VIDEO_DIM = 200;
// A target must be MOSTLY on the video to be suppressed; edge-adjacent
// controls (action rail) keep their badges.
const OVERLAP_FRACTION = 0.5;

/** Viewport rects of actively-playing large videos, cached ~250ms. */
export function playingVideoRects(): DOMRect[] {
  const now = performance.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.rects;
  const rects: DOMRect[] = [];
  for (const v of document.querySelectorAll('video')) {
    if (v.paused || v.currentTime === 0 || v.readyState < 2) continue;
    const r = v.getBoundingClientRect();
    if (r.width >= MIN_VIDEO_DIM && r.height >= MIN_VIDEO_DIM) rects.push(r);
  }
  cache = { rects, at: now };
  return rects;
}

/** Test-only: reset the rects cache between cases. */
export function _resetVideoOverlayCacheForTests(): void {
  cache = null;
}

/** Is this element's rect mostly inside an actively-playing large video? */
export function targetOverVideo(el: Element): boolean {
  if (!enabled) return false;
  const vids = playingVideoRects();
  if (vids.length === 0) return false;
  const r = el.getBoundingClientRect();
  const area = r.width * r.height;
  if (area <= 0) return false;
  for (const v of vids) {
    const ix = Math.min(r.right, v.right) - Math.max(r.left, v.left);
    const iy = Math.min(r.bottom, v.bottom) - Math.max(r.top, v.top);
    if (ix > 0 && iy > 0 && (ix * iy) / area > OVERLAP_FRACTION) return true;
  }
  return false;
}
