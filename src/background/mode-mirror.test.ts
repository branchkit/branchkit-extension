/**
 * The SW-arbitrated tag mirror: a tag is held iff ANY live frame's stack
 * contains the mode that mirrors it. These pin the transport policy around
 * the pure derivation (core/derive-mirror.ts has its own table tests): which
 * plugin calls fire on which frame-stack changes, the doc-scoped fencing,
 * and the connect/focus-edge replay that replaced the 300 ms re-assert.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const calls: string[] = [];
vi.mock('../plugin/plugin-api', () => ({
  setCaretActive: async (active: boolean) => { calls.push(`caret:${active}`); },
  setFindActive: async (active: boolean) => { calls.push(`find:${active}`); },
  setVideoMode: async (active: boolean) => { calls.push(`video:${active}`); },
}));

import {
  frameStackPosted, frameStackGone, reassertMirror, __resetModeMirror,
} from './mode-mirror';

beforeEach(() => {
  __resetModeMirror();
  calls.length = 0;
});

describe('SW mode mirror (Wave 3 C4a)', () => {
  it('a SUBFRAME caret session asserts the tag — any frame counts', () => {
    frameStackPosted(7, 'doc-sub', ['caret']);
    expect(calls).toEqual(['caret:true']);
  });

  it('two frames in find yield ONE claim, and one popping does not clear', () => {
    frameStackPosted(7, 'doc-a', ['find']);
    frameStackPosted(7, 'doc-b', ['find']);
    expect(calls).toEqual(['find:true']); // the union is a set — no re-assert

    frameStackPosted(7, 'doc-a', []); // frame a back to Normal, b still in-mode
    expect(calls).toEqual(['find:true']);

    frameStackPosted(7, 'doc-b', []);
    expect(calls).toEqual(['find:true', 'find:false']);
  });

  it('an empty-stack post is an update, a dead doc is a removal — both clear when last', () => {
    frameStackPosted(3, 'doc-x', ['caret']);
    frameStackGone(3, 'doc-x');
    expect(calls).toEqual(['caret:true', 'caret:false']);
  });

  it('doc-scoped fencing: a LATE disconnect of the old document cannot clear the successor', () => {
    // The ZY-wipe class: nav replaces the doc at the same (tab, frame); the
    // old doc's liveness disconnect arrives seconds later.
    frameStackPosted(3, 'doc-old', ['find']);
    frameStackPosted(3, 'doc-new', ['find']); // successor, same tab
    calls.length = 0;

    frameStackGone(3, 'doc-old'); // late — must not clear doc-new's claim
    expect(calls).toEqual([]);
  });

  it('switching modes clears the stale claim BEFORE asserting the next', () => {
    frameStackPosted(1, 'doc', ['caret']);
    frameStackPosted(1, 'doc', ['find']);
    expect(calls).toEqual(['caret:true', 'caret:false', 'find:true']);
  });

  it('video rides the mirror (C4b) — one lifetime, `w` or spoken entry alike', () => {
    frameStackPosted(1, 'doc', ['video']);
    expect(calls).toEqual(['video:true']);
    frameStackPosted(1, 'doc', []);
    expect(calls).toEqual(['video:true', 'video:false']);
  });

  it('palette stays on its own transport — the one mirrored mode without a forwarder', () => {
    frameStackPosted(1, 'doc', ['palette']);
    expect(calls).toEqual([]);
  });

  it('non-mirrored modes (hint, range_pick) contribute nothing', () => {
    frameStackPosted(1, 'doc', ['hint', 'range_pick']);
    expect(calls).toEqual([]);
  });

  it('reassertMirror replays exactly the current derivation — the focus/connect heal', () => {
    frameStackPosted(1, 'doc-a', ['caret']);
    frameStackPosted(2, 'doc-b', ['find']);
    calls.length = 0;

    reassertMirror(); // the plugin drained on OS focus loss; replay
    expect(calls.sort()).toEqual(['caret:true', 'find:true']);

    calls.length = 0;
    frameStackPosted(1, 'doc-a', []);
    calls.length = 0;
    reassertMirror();
    expect(calls).toEqual(['find:true']); // only what the stacks still hold
  });
});
