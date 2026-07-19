import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  findMediaVideo,
  mediaPlayPause,
  mediaMute,
  mediaSpeed,
  mediaSeek,
  mediaRestart,
  resolveVideoModeKey,
} from './media';

// happy-dom's <video> has no layout and no real playback, so both halves of
// the target predicate are stubbed per element: rect (size floor) and the
// playing triple (paused/currentTime/readyState).
interface VideoSpec {
  w: number;
  h: number;
  playing?: boolean;
  currentTime?: number;
  duration?: number;
  rate?: number;
  muted?: boolean;
}

function addVideo(spec: VideoSpec): HTMLVideoElement {
  const v = document.createElement('video');
  v.getBoundingClientRect = () =>
    ({ width: spec.w, height: spec.h, top: 0, left: 0, right: spec.w, bottom: spec.h, x: 0, y: 0 } as DOMRect);
  const playing = spec.playing ?? false;
  Object.defineProperty(v, 'paused', { configurable: true, get: () => !playing });
  Object.defineProperty(v, 'readyState', { configurable: true, get: () => (playing ? 4 : 0) });
  Object.defineProperty(v, 'duration', {
    configurable: true,
    get: () => spec.duration ?? NaN,
  });
  // currentTime/playbackRate/muted are plain writable state in jsdom-land.
  let time = spec.currentTime ?? (playing ? 5 : 0);
  Object.defineProperty(v, 'currentTime', {
    configurable: true,
    get: () => time,
    set: (t: number) => { time = t; },
  });
  let rate = spec.rate ?? 1;
  Object.defineProperty(v, 'playbackRate', {
    configurable: true,
    get: () => rate,
    set: (r: number) => { rate = r; },
  });
  v.muted = spec.muted ?? false;
  document.body.appendChild(v);
  return v;
}

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('findMediaVideo', () => {
  it('returns null with no videos', () => {
    expect(findMediaVideo()).toBeNull();
  });

  it('ignores videos under the size floor (thumbnails, PiP minis)', () => {
    addVideo({ w: 120, h: 90, playing: true });
    expect(findMediaVideo()).toBeNull();
  });

  it('picks the largest large video when none is playing (play targets it)', () => {
    addVideo({ w: 300, h: 200 });
    const big = addVideo({ w: 900, h: 500 });
    expect(findMediaVideo()).toBe(big);
  });

  it('prefers a playing video over a larger paused one', () => {
    addVideo({ w: 1200, h: 700 });
    const playing = addVideo({ w: 400, h: 300, playing: true, currentTime: 12 });
    expect(findMediaVideo()).toBe(playing);
  });

  it('breaks playing ties on area', () => {
    addVideo({ w: 300, h: 250, playing: true, currentTime: 3 });
    const big = addVideo({ w: 800, h: 450, playing: true, currentTime: 3 });
    expect(findMediaVideo()).toBe(big);
  });

  it('does not treat a cued-but-unstarted video as playing', () => {
    // paused=false but currentTime=0 → not "actively playing" (the shared
    // gate predicate), so a larger paused-at-timestamp video still loses to
    // nothing — this one is picked only via the paused fallback.
    const v = document.createElement('video');
    v.getBoundingClientRect = () =>
      ({ width: 640, height: 360, top: 0, left: 0, right: 640, bottom: 360, x: 0, y: 0 } as DOMRect);
    Object.defineProperty(v, 'paused', { configurable: true, get: () => false });
    Object.defineProperty(v, 'readyState', { configurable: true, get: () => 4 });
    Object.defineProperty(v, 'currentTime', { configurable: true, get: () => 0 });
    document.body.appendChild(v);
    expect(findMediaVideo()).toBe(v); // found — but via the paused fallback…
    const playing = addVideo({ w: 320, h: 240, playing: true, currentTime: 8 });
    expect(findMediaVideo()).toBe(playing); // …so a real player beats it.
  });
});

describe('media executors', () => {
  it('pause pauses a playing video and play-op is a no-op on it', () => {
    const v = addVideo({ w: 800, h: 450, playing: true, currentTime: 30 });
    let paused = false;
    v.pause = () => { paused = true; };
    mediaPlayPause('pause');
    expect(paused).toBe(true);
  });

  it('play falls back to click() when play() rejects (no user activation)', async () => {
    const v = addVideo({ w: 800, h: 450 });
    let clicked = false;
    v.play = () => Promise.reject(new Error('NotAllowedError'));
    v.click = () => { clicked = true; };
    mediaPlayPause('play');
    await Promise.resolve(); // let the rejection handler run
    await Promise.resolve();
    expect(clicked).toBe(true);
  });

  it('mute ops set/toggle muted', () => {
    const v = addVideo({ w: 800, h: 450, playing: true, currentTime: 3 });
    mediaMute('mute');
    expect(v.muted).toBe(true);
    mediaMute('toggle');
    expect(v.muted).toBe(false);
    mediaMute('unmute');
    expect(v.muted).toBe(false);
  });

  it('speed steps by 0.25, clamps, and normal resets', () => {
    const v = addVideo({ w: 800, h: 450, playing: true, currentTime: 3, rate: 2.9 });
    mediaSpeed('faster');
    expect(v.playbackRate).toBe(3); // clamped
    mediaSpeed('normal');
    expect(v.playbackRate).toBe(1);
    mediaSpeed('slower');
    expect(v.playbackRate).toBe(0.75);
  });

  it('seek moves currentTime, clamping to [0, duration]', () => {
    const v = addVideo({ w: 800, h: 450, playing: true, currentTime: 8, duration: 100 });
    mediaSeek('back', 10);
    expect(v.currentTime).toBe(0); // lower clamp
    mediaSeek('ahead', 250);
    expect(v.currentTime).toBe(100); // upper clamp
  });

  it('seek upper clamp is open on live streams (Infinity duration)', () => {
    const v = addVideo({ w: 800, h: 450, playing: true, currentTime: 50, duration: Infinity });
    mediaSeek('ahead', 30);
    expect(v.currentTime).toBe(80);
  });

  it('seek rejects non-positive and non-finite amounts', () => {
    const v = addVideo({ w: 800, h: 450, playing: true, currentTime: 50, duration: 100 });
    mediaSeek('ahead', NaN);
    mediaSeek('ahead', -5);
    expect(v.currentTime).toBe(50);
  });

  it('restart returns to zero', () => {
    const v = addVideo({ w: 800, h: 450, playing: true, currentTime: 42 });
    mediaRestart();
    expect(v.currentTime).toBe(0);
  });

  it('executors no-op with no large video in the frame', () => {
    addVideo({ w: 100, h: 80, playing: true, currentTime: 3 }); // under floor
    expect(() => {
      mediaPlayPause('toggle');
      mediaMute('toggle');
      mediaSpeed('faster');
      mediaSeek('ahead', 10);
      mediaRestart();
    }).not.toThrow();
  });
});

describe('resolveVideoModeKey', () => {
  const key = (code: string, opts: { key?: string; shiftKey?: boolean } = {}): KeyboardEvent =>
    new KeyboardEvent('keydown', { code, key: opts.key ?? '', shiftKey: opts.shiftKey ?? false });

  it('maps the YouTube mnemonics to media commands', () => {
    expect(resolveVideoModeKey(key('KeyK'))).toEqual(
      { kind: 'dispatch', action: 'media_play_pause', params: { op: 'toggle' } });
    expect(resolveVideoModeKey(key('Space'))).toEqual(
      { kind: 'dispatch', action: 'media_play_pause', params: { op: 'toggle' } });
    expect(resolveVideoModeKey(key('KeyJ'))).toEqual(
      { kind: 'dispatch', action: 'media_seek', params: { direction: 'back', seconds: '10' } });
    expect(resolveVideoModeKey(key('KeyL'))).toEqual(
      { kind: 'dispatch', action: 'media_seek', params: { direction: 'ahead', seconds: '10' } });
    expect(resolveVideoModeKey(key('ArrowLeft'))).toEqual(
      { kind: 'dispatch', action: 'media_seek', params: { direction: 'back', seconds: '5' } });
    expect(resolveVideoModeKey(key('ArrowRight'))).toEqual(
      { kind: 'dispatch', action: 'media_seek', params: { direction: 'ahead', seconds: '5' } });
    expect(resolveVideoModeKey(key('KeyM'))).toEqual(
      { kind: 'dispatch', action: 'media_mute', params: { op: 'toggle' } });
    expect(resolveVideoModeKey(key('Comma', { shiftKey: true }))).toEqual(
      { kind: 'dispatch', action: 'media_speed', params: { op: 'slower' } });
    expect(resolveVideoModeKey(key('Period', { shiftKey: true }))).toEqual(
      { kind: 'dispatch', action: 'media_speed', params: { op: 'faster' } });
    expect(resolveVideoModeKey(key('Digit0'))).toEqual(
      { kind: 'dispatch', action: 'media_restart' });
  });

  it('exits on Escape and q', () => {
    expect(resolveVideoModeKey(key('Escape', { key: 'Escape' }))).toEqual({ kind: 'exit' });
    expect(resolveVideoModeKey(key('KeyQ'))).toEqual({ kind: 'exit' });
  });

  it('consumes unbound keys (modal capture — no fall-through to Normal binds)', () => {
    expect(resolveVideoModeKey(key('KeyF'))).toEqual({ kind: 'consume' });
    expect(resolveVideoModeKey(key('KeyT'))).toEqual({ kind: 'consume' });
    expect(resolveVideoModeKey(key('KeyK', { shiftKey: true }))).toEqual({ kind: 'consume' });
  });
});
