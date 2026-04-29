/**
 * BranchKit Browser — Pre-phrase snapshot unit tests.
 *
 * Pure-function tests. Wrappers are built with a tiny fake DOM-node
 * shape exposing just the `isConnected` property the snapshot
 * resolver checks; ElementWrapper itself is constructed normally so
 * the production code path runs unchanged.
 *
 * Run: npm test
 */

import { describe, it, expect } from 'vitest';
import { ElementWrapper } from './element-wrapper';
import { ScannedElement } from './types';
import {
  takeSnapshot,
  resolveFromSnapshot,
  isStale,
  SNAPSHOT_TTL_MS,
} from './snapshot';

function fakeElement(connected = true): Element {
  return { isConnected: connected, tagName: 'BUTTON' } as unknown as Element;
}

function fakeScanned(codeword: string): ScannedElement {
  return {
    label: 'click me',
    selector: `button.${codeword}`,
    category: 'button',
    type: 'button',
    adapter: null,
    codeword,
  };
}

function makeWrapper(codeword: string, connected = true): ElementWrapper {
  return new ElementWrapper(fakeElement(connected), fakeScanned(codeword));
}

describe('takeSnapshot', () => {
  it('captures every wrapper that has a codeword', () => {
    const wrappers = [
      makeWrapper('arch'),
      makeWrapper('bake'),
      makeWrapper('rain arch'),
    ];
    const snap = takeSnapshot(wrappers, 1000);
    expect(snap.byCodeword.size).toBe(3);
    expect(snap.byCodeword.get('arch')).toBe(wrappers[0]);
    expect(snap.byCodeword.get('bake')).toBe(wrappers[1]);
    expect(snap.byCodeword.get('rain arch')).toBe(wrappers[2]);
    expect(snap.takenAt).toBe(1000);
  });

  it('skips wrappers without a codeword (alphabet not loaded / pool exhausted)', () => {
    const wrappers = [
      makeWrapper('arch'),
      makeWrapper(''),       // pool exhausted
      makeWrapper('bake'),
    ];
    const snap = takeSnapshot(wrappers, 0);
    expect(snap.byCodeword.size).toBe(2);
    expect(snap.byCodeword.has('')).toBe(false);
  });

  it('handles an empty wrapper list', () => {
    const snap = takeSnapshot([], 500);
    expect(snap.byCodeword.size).toBe(0);
    expect(snap.takenAt).toBe(500);
  });

  it('on duplicate codewords, last write wins (defensive — should not happen in practice)', () => {
    const wrappers = [makeWrapper('arch'), makeWrapper('arch')];
    const snap = takeSnapshot(wrappers, 0);
    expect(snap.byCodeword.size).toBe(1);
    expect(snap.byCodeword.get('arch')).toBe(wrappers[1]);
  });
});

describe('resolveFromSnapshot', () => {
  it('returns the captured wrapper when fresh and codeword matches', () => {
    const w = makeWrapper('arch');
    const snap = takeSnapshot([w], 1000);
    expect(resolveFromSnapshot(snap, 'arch', 1000)).toBe(w);
    expect(resolveFromSnapshot(snap, 'arch', 1000 + SNAPSHOT_TTL_MS - 1)).toBe(w);
  });

  it('returns undefined for null snapshot', () => {
    expect(resolveFromSnapshot(null, 'arch', 0)).toBeUndefined();
  });

  it('returns undefined for an unknown codeword', () => {
    const snap = takeSnapshot([makeWrapper('arch')], 0);
    expect(resolveFromSnapshot(snap, 'bake', 0)).toBeUndefined();
  });

  it('returns undefined past TTL', () => {
    const w = makeWrapper('arch');
    const snap = takeSnapshot([w], 0);
    expect(resolveFromSnapshot(snap, 'arch', SNAPSHOT_TTL_MS + 1)).toBeUndefined();
  });

  it('returns undefined exactly at TTL boundary + 1ms (strictly greater than TTL)', () => {
    // TTL is inclusive of the boundary: `now - takenAt > TTL` means the
    // snapshot is fresh exactly AT the TTL boundary, stale only past it.
    const w = makeWrapper('arch');
    const snap = takeSnapshot([w], 0);
    expect(resolveFromSnapshot(snap, 'arch', SNAPSHOT_TTL_MS)).toBe(w);
    expect(resolveFromSnapshot(snap, 'arch', SNAPSHOT_TTL_MS + 1)).toBeUndefined();
  });

  it('returns undefined if the wrapper element has detached from the DOM', () => {
    // The element being on the snapshot doesn't guarantee it still
    // exists when the user finishes speaking. Common case: a React
    // re-render replaced the subtree mid-utterance.
    const w = makeWrapper('arch', /* connected = */ false);
    const snap = takeSnapshot([w], 0);
    expect(resolveFromSnapshot(snap, 'arch', 100)).toBeUndefined();
  });

  it('returns the wrapper if connected at resolve time, even if it was disconnected before snapshot', () => {
    // Realistic: the wrapper might be mounted but tracked in the store
    // before its element is in the live DOM. We only care about
    // connectedness at resolution time, not snapshot time.
    const w = makeWrapper('arch', false);
    const snap = takeSnapshot([w], 0);
    // Reconnect.
    (w.element as unknown as { isConnected: boolean }).isConnected = true;
    expect(resolveFromSnapshot(snap, 'arch', 100)).toBe(w);
  });
});

describe('isStale', () => {
  it('treats null snapshot as stale', () => {
    expect(isStale(null, 0)).toBe(true);
  });

  it('treats a fresh snapshot as not stale', () => {
    const snap = takeSnapshot([], 0);
    expect(isStale(snap, SNAPSHOT_TTL_MS)).toBe(false);
  });

  it('treats an aged snapshot as stale', () => {
    const snap = takeSnapshot([], 0);
    expect(isStale(snap, SNAPSHOT_TTL_MS + 1)).toBe(true);
  });
});
