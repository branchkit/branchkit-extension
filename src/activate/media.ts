/**
 * BranchKit Browser — media commands (notes/DESIGN_VIDEO_MEDIA_COMMANDS.md).
 *
 * Voice/keyboard control of the playing state that badges can't reach: the
 * video-overlay gate suppresses badges over an actively-playing video
 * (Firefox WebRender race), and sites auto-hide their player controls during
 * playback anyway. So the transport verbs are implemented on the HTML5
 * <video> element API directly — one generic implementation, no per-site
 * adapters. Works while controls are hidden, and on sites whose UI never
 * exposes the control at all (speed on TikTok). Site chrome (quality menus,
 * next-video, theater mode) stays with hints: say "pause", the gate lifts,
 * the controls pin, badges paint.
 *
 * Frame model: voice actions without a hint codeword broadcast to every
 * frame in the tab, and this executor no-ops in frames with no large video —
 * so a YouTube embed (video inside an iframe, top frame video-less) works
 * with zero routing logic. The keyboard layer is frame-local (key events
 * land in the focused frame); voice is the tab-wide modality.
 */

import { isActivelyPlaying, MIN_VIDEO_DIM } from '../render/video-overlay';
import { flashToast } from '../render/toast';

export type PlayPauseOp = 'toggle' | 'play' | 'pause';
export type MuteOp = 'toggle' | 'mute' | 'unmute';
export type SpeedOp = 'faster' | 'slower' | 'normal';
export type SeekDirection = 'ahead' | 'back';

const SPEED_STEP = 0.25;
const SPEED_MIN = 0.25;
const SPEED_MAX = 3;

/** Area of a "large player" candidate; 0 disqualifies (thumbnail/PiP floor,
 *  same MIN_VIDEO_DIM as the overlay gate). */
function candidateArea(v: HTMLVideoElement): number {
  const r = v.getBoundingClientRect();
  if (r.width < MIN_VIDEO_DIM || r.height < MIN_VIDEO_DIM) return 0;
  return r.width * r.height;
}

/**
 * The media element the commands drive. Candidates are large videos (same
 * floor as the overlay gate — the suppression predicate and the command
 * target can never disagree) plus `<audio>` elements holding a source
 * (Spotify web, SoundCloud, podcast players — identical element API, wider
 * net). Selection: playing beats paused, video beats audio at equal playing
 * state, area breaks video ties — so "pause" grabs the thing making noise,
 * and `play` still works on the paused player you're looking at. Null when
 * the frame has no candidate (the command no-ops; another frame may act).
 */
export function findMediaElement(): HTMLMediaElement | null {
  let best: HTMLMediaElement | null = null;
  let bestScore = -1;
  let bestArea = -1;
  const consider = (el: HTMLMediaElement, area: number): void => {
    const playing = isActivelyPlaying(el);
    const score = (playing ? 2 : 0) + (el instanceof HTMLVideoElement ? 1 : 0);
    if (score > bestScore || (score === bestScore && area > bestArea)) {
      best = el;
      bestScore = score;
      bestArea = area;
    }
  };
  for (const v of document.querySelectorAll('video')) {
    const area = candidateArea(v);
    if (area === 0) continue;
    consider(v, area);
  }
  for (const a of document.querySelectorAll('audio')) {
    // A source-less audio element is inert scaffolding, not a player.
    if (!a.currentSrc && a.readyState === 0) continue;
    consider(a, 0);
  }
  return best;
}

export function mediaPlayPause(op: PlayPauseOp): void {
  const v = findMediaElement();
  if (!v) return;
  const wantPlay = op === 'play' || (op === 'toggle' && v.paused);
  if (wantPlay) {
    // A content-script dispatch carries no user activation, so play() can
    // reject under autoplay policy (rare on a video the user started —
    // the site already holds playback permission). Fall back to the
    // click-to-toggle convention YouTube/TikTok follow.
    v.play().catch(() => v.click());
  } else if (!v.paused) {
    v.pause();
  }
}

export function mediaMute(op: MuteOp): void {
  const v = findMediaElement();
  if (!v) return;
  v.muted = op === 'toggle' ? !v.muted : op === 'mute';
  flashToast(v.muted ? 'Muted' : 'Sound on');
}

export function mediaSpeed(op: SpeedOp): void {
  const v = findMediaElement();
  if (!v) return;
  const rate =
    op === 'normal'
      ? 1
      : clamp(v.playbackRate + (op === 'faster' ? SPEED_STEP : -SPEED_STEP), SPEED_MIN, SPEED_MAX);
  v.playbackRate = rate;
  // Speed has no visible page effect at small steps — confirm like copy_url.
  flashToast(`Speed ${formatRate(rate)}×`);
}

export function mediaSeek(direction: SeekDirection, seconds: number): void {
  const v = findMediaElement();
  if (!v || !Number.isFinite(seconds) || seconds <= 0) return;
  const delta = direction === 'back' ? -seconds : seconds;
  // duration is NaN before metadata and Infinity on live streams — in both
  // cases only the lower clamp applies.
  const max = Number.isFinite(v.duration) ? v.duration : Number.POSITIVE_INFINITY;
  v.currentTime = clamp(v.currentTime + delta, 0, max);
}

export function mediaRestart(): void {
  const v = findMediaElement();
  if (!v) return;
  v.currentTime = 0;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** "1.5", "0.75", "1" — no trailing zeros, matches player-UI convention. */
function formatRate(rate: number): string {
  return String(Math.round(rate * 100) / 100);
}

// ---------------------------------------------------------------------------
// Video layer (keyboard): YouTube's own mnemonics mapped to the commands
// above, so a billion users' muscle memory works on every site. Entered via
// the `video_mode` command (default `w`); Escape or `q` exits. Pure resolver
// so the key table is unit-testable apart from the KeyHandler wiring.
// ---------------------------------------------------------------------------

export type VideoKeyResolution =
  | { kind: 'dispatch'; action: string; params?: Record<string, string> }
  | { kind: 'exit' }
  | { kind: 'consume' };

/**
 * Resolve one keydown inside the video layer. The layer is a modal capture
 * (like hint/caret): every bare key is consumed — an unbound key no-ops
 * rather than falling through to a Normal bind or the page. Real-modifier
 * chords never reach this (KeyHandler routes them to the registry first).
 */
export function resolveVideoModeKey(e: KeyboardEvent): VideoKeyResolution {
  // KeyW makes the entry key a toggle — press w to enter, w again to leave
  // (the mode-key convention users expect); Escape and q also exit.
  if (e.key === 'Escape' || e.code === 'KeyQ' || e.code === 'KeyW') return { kind: 'exit' };
  if (e.shiftKey) {
    // < and > — YouTube's speed keys.
    if (e.code === 'Comma') return { kind: 'dispatch', action: 'media_speed', params: { op: 'slower' } };
    if (e.code === 'Period') return { kind: 'dispatch', action: 'media_speed', params: { op: 'faster' } };
    return { kind: 'consume' };
  }
  switch (e.code) {
    case 'KeyK':
    case 'Space':
      return { kind: 'dispatch', action: 'media_play_pause', params: { op: 'toggle' } };
    case 'KeyJ':
      return { kind: 'dispatch', action: 'media_seek', params: { direction: 'back', seconds: '10' } };
    case 'KeyL':
      return { kind: 'dispatch', action: 'media_seek', params: { direction: 'ahead', seconds: '10' } };
    case 'ArrowLeft':
      return { kind: 'dispatch', action: 'media_seek', params: { direction: 'back', seconds: '5' } };
    case 'ArrowRight':
      return { kind: 'dispatch', action: 'media_seek', params: { direction: 'ahead', seconds: '5' } };
    case 'KeyM':
      return { kind: 'dispatch', action: 'media_mute', params: { op: 'toggle' } };
    case 'Digit0':
      return { kind: 'dispatch', action: 'media_restart' };
    default:
      return { kind: 'consume' };
  }
}
