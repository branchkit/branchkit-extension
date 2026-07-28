/**
 * BranchKit Browser — media command binding tests.
 *
 * Seven bindings that had no test while they were inline in content.ts. What
 * is pinned is which verb each command reaches and how it reads its params —
 * every one has a default that only shows up when the voice plugin sends the
 * bare command. media.ts's own behaviour is covered in media.test.ts.
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type MediaCommands = typeof import('./media-commands');

type Handler = (params: Record<string, string>) => void;
const registered = new Map<string, Handler>();
const dispatcher = { register: (a: string, fn: Handler) => { registered.set(a, fn); } };
const keyHandler = { enterVideoMode: vi.fn(), exitVideoMode: vi.fn() };

const calls: string[] = [];
const mediaPlayPause = vi.fn((op: unknown) => { calls.push(`playPause(${op})`); });
const mediaMute = vi.fn((op: unknown) => { calls.push(`mute(${op})`); });
const mediaSpeed = vi.fn((op: unknown) => { calls.push(`speed(${op})`); });
const mediaSeek = vi.fn((d: unknown, s: unknown) => { calls.push(`seek(${d},${s})`); });
const mediaRestart = vi.fn(() => { calls.push('restart()'); });

async function load(): Promise<MediaCommands> {
  vi.resetModules();
  vi.doMock('../core/singletons', () => ({ dispatcher, keyHandler }));
  vi.doMock('./media', () => ({
    mediaPlayPause, mediaMute, mediaSpeed, mediaSeek, mediaRestart,
  }));
  const m = await import('./media-commands');
  m.registerMediaCommands();
  return m;
}

const run = (action: string, params: Record<string, string> = {}) => {
  const h = registered.get(action);
  if (!h) throw new Error(`${action} was never registered`);
  h(params);
};

beforeEach(() => {
  registered.clear();
  calls.length = 0;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.doUnmock('../core/singletons');
  vi.doUnmock('./media');
});

describe('registration', () => {
  it('registers every media and video command content.ts used to hold', async () => {
    await load();
    expect([...registered.keys()].sort()).toEqual([
      'media_mute', 'media_play_pause', 'media_restart', 'media_seek',
      'media_speed', 'video_exit', 'video_mode',
    ]);
  });

  it('registers nothing at import time', async () => {
    vi.resetModules();
    vi.doMock('../core/singletons', () => ({ dispatcher, keyHandler }));
    vi.doMock('./media', () => ({ mediaPlayPause, mediaMute, mediaSpeed, mediaSeek, mediaRestart }));
    await import('./media-commands');
    expect(registered.size).toBe(0);
  });
});

describe('the video layer', () => {
  it('enters and exits video mode through the key handler, not the media verbs', async () => {
    await load();
    run('video_mode');
    expect(keyHandler.enterVideoMode).toHaveBeenCalledTimes(1);
    expect(keyHandler.exitVideoMode).not.toHaveBeenCalled();

    run('video_exit');
    expect(keyHandler.exitVideoMode).toHaveBeenCalledTimes(1);
    // The mode is a keyboard layer; entering it must not touch playback.
    expect(calls).toEqual([]);
  });
});

describe('transport verbs and their defaults', () => {
  it('play_pause toggles by default and honours an explicit op', async () => {
    await load();
    run('media_play_pause');
    run('media_play_pause', { op: 'play' });
    run('media_play_pause', { op: 'pause' });
    expect(calls).toEqual(['playPause(toggle)', 'playPause(play)', 'playPause(pause)']);
  });

  it('mute toggles by default and honours an explicit op', async () => {
    await load();
    run('media_mute');
    run('media_mute', { op: 'unmute' });
    expect(calls).toEqual(['mute(toggle)', 'mute(unmute)']);
  });

  it('speed defaults to faster — NOT to toggle like the other two', async () => {
    await load();
    run('media_speed');
    run('media_speed', { op: 'normal' });
    expect(calls).toEqual(['speed(faster)', 'speed(normal)']);
  });

  it('an empty op string falls back to the default rather than reaching the verb', async () => {
    await load();
    run('media_play_pause', { op: '' });
    run('media_mute', { op: '' });
    run('media_speed', { op: '' });
    expect(calls).toEqual(['playPause(toggle)', 'mute(toggle)', 'speed(faster)']);
  });

  it('restart takes no params', async () => {
    await load();
    run('media_restart', { op: 'ignored' });
    expect(calls).toEqual(['restart()']);
  });
});

describe('seek', () => {
  it('goes ahead 10s by default', async () => {
    await load();
    run('media_seek');
    expect(calls).toEqual(['seek(ahead,10)']);
  });

  it('goes back only on the exact literal "back"', async () => {
    await load();
    run('media_seek', { direction: 'back' });
    run('media_seek', { direction: 'ahead' });
    // Anything else is forward. A truthiness check on `direction` would send
    // these two backwards instead.
    run('media_seek', { direction: 'backwards' });
    run('media_seek', { direction: 'rewind' });
    expect(calls).toEqual(['seek(back,10)', 'seek(ahead,10)', 'seek(ahead,10)', 'seek(ahead,10)']);
  });

  it('takes a seconds param, and falls back to 10 when it is missing or empty', async () => {
    await load();
    run('media_seek', { seconds: '30' });
    run('media_seek', { direction: 'back', seconds: '5' });
    run('media_seek', { seconds: '' });
    expect(calls).toEqual(['seek(ahead,30)', 'seek(back,5)', 'seek(ahead,10)']);
  });
});
