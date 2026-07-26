/**
 * deriveMirror / diffMirror table tests — the extension-side counterpart of
 * the plugin's Go tag table test (Wave 1 A1). The cases come from the design
 * review's own findings (notes/DESIGN_MODE_STACK_AND_CODEWORD_HOLDERS.md):
 * each row below is a bug the per-frame speak-for-yourself guards produced,
 * made unrepresentable by deriving the tag set over ALL frames' stacks.
 * Run over the REAL MODE_SPECS table, so the tags asserted here are the tags
 * the plugin actually declares.
 */

import { describe, it, expect } from 'vitest';
import { MODE_SPECS, type ModeId } from './mode-stack';
import { deriveMirror, diffMirror, type FrameId, type TagAssertion } from './derive-mirror';

function frames(entries: Record<string, readonly ModeId[]>): ReadonlyMap<FrameId, readonly ModeId[]> {
  return new Map(Object.entries(entries));
}

const tags = (a: TagAssertion[]) => a.map((t) => t.tag);

describe('deriveMirror', () => {
  it('the empty map yields the empty set', () => {
    expect(deriveMirror(new Map(), MODE_SPECS)).toEqual([]);
  });

  it('a frame with an empty stack yields the empty set', () => {
    expect(deriveMirror(frames({ 'tab1:0': [] }), MODE_SPECS)).toEqual([]);
  });

  it('a SUBFRAME-only caret stack asserts the tag (finding #5 unrepresentable)', () => {
    // resolveSelectTo deliberately creates subframe caret sessions; the old
    // top-frame-only guard left them tagless and "copy that" dead. The
    // derivation has no notion of which frame is the top one.
    const out = deriveMirror(frames({ 'tab1:0': [], 'tab1:7': ['caret'] }), MODE_SPECS);
    expect(out).toEqual([{ tag: 'plugin.browser.caret', exclusive: true }]);
  });

  it('two frames in find yield ONE claim', () => {
    // The every-frame speakers used to fight over the single-slot FindConnID;
    // a set-valued derivation cannot emit the same tag twice.
    const out = deriveMirror(frames({ 'tab1:0': ['find'], 'tab1:3': ['find', 'caret'] }), MODE_SPECS);
    expect(tags(out)).toEqual(['plugin.browser.caret', 'plugin.browser.find']);
    expect(tags(out).filter((t) => t === 'plugin.browser.find')).toHaveLength(1);
  });

  it('modes with a null mirror contribute nothing', () => {
    // hint (grammar-owned tag, resolved question 2) and range_pick (payload
    // projection, resolved question 1) are extension-only by decision.
    expect(deriveMirror(frames({ 'tab1:0': ['hint', 'range_pick'] }), MODE_SPECS)).toEqual([]);
  });

  it('an unregistered mode id in a stale snapshot is ignored, not fatal', () => {
    const out = deriveMirror(
      frames({ 'tab1:0': ['retired_mode' as ModeId, 'video'] }), MODE_SPECS,
    );
    expect(tags(out)).toEqual(['plugin.browser.video_mode']);
  });

  it('output order is the spec table order regardless of frame order', () => {
    const a = deriveMirror(frames({ f1: ['video'], f2: ['caret'], f3: ['find'] }), MODE_SPECS);
    const b = deriveMirror(frames({ f9: ['find', 'caret', 'video'] }), MODE_SPECS);
    expect(a).toEqual(b);
    expect(tags(a)).toEqual(['plugin.browser.caret', 'plugin.browser.find', 'plugin.browser.video_mode']);
  });
});

describe('diffMirror', () => {
  it('popping one frame while another is still in-mode keeps the tag (no edge)', () => {
    const prev = deriveMirror(frames({ f1: ['find'], f2: ['find'] }), MODE_SPECS);
    const next = deriveMirror(frames({ f2: ['find'] }), MODE_SPECS);
    expect(diffMirror(prev, next)).toEqual({ asserts: [], clears: [] });
  });

  it('the last frame leaving the mode clears the tag', () => {
    const prev = deriveMirror(frames({ f2: ['find'] }), MODE_SPECS);
    const next = deriveMirror(new Map(), MODE_SPECS);
    expect(diffMirror(prev, next)).toEqual({
      asserts: [],
      clears: [{ tag: 'plugin.browser.find', exclusive: false }],
    });
  });

  it('the first frame entering a mode asserts the tag', () => {
    const prev = deriveMirror(new Map(), MODE_SPECS);
    const next = deriveMirror(frames({ f1: ['caret'] }), MODE_SPECS);
    expect(diffMirror(prev, next)).toEqual({
      asserts: [{ tag: 'plugin.browser.caret', exclusive: true }],
      clears: [],
    });
  });

  it('a mode swap in one transition carries both edges', () => {
    // Frame leaves caret and opens the palette in one snapshot hop: the diff
    // must clear one exclusive claim and assert the other, in one result —
    // the forwarder never sees an intermediate both-held state.
    const prev = deriveMirror(frames({ f1: ['caret'] }), MODE_SPECS);
    const next = deriveMirror(frames({ f1: ['palette'] }), MODE_SPECS);
    expect(diffMirror(prev, next)).toEqual({
      asserts: [{ tag: 'plugin.browser.palette', exclusive: true }],
      clears: [{ tag: 'plugin.browser.caret', exclusive: true }],
    });
  });

  it('identical sets are no traffic at all', () => {
    const set = deriveMirror(frames({ f1: ['caret', 'find'] }), MODE_SPECS);
    expect(diffMirror(set, set)).toEqual({ asserts: [], clears: [] });
  });
});
