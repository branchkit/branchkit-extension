/**
 * BranchKit Browser — post-batch isConnected sweep tests.
 *
 * Verifies the RED item 5 mitigation from
 * notes/DESIGN_HINT_PIPELINE_RESYNC.md: when an element disconnects
 * from the DOM between batch yield and Put response, the sweep must
 * (a) queue the codeword for plugin Delete and (b) detach the wrapper
 * locally so its badge doesn't paint.
 *
 * The sweep is exposed from content.ts purely so this test can drive
 * it with stub predicates — production code uses the default
 * `el.isConnected` reader.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ElementWrapper } from './element-wrapper';
import { ScannedElement } from './types';
import { sweepDisconnectedAfterBatch } from './batch-sweep';

function fakeElement(id: number): Element {
  return { tagName: 'BUTTON', __id: id } as unknown as Element;
}

function fakeScanned(codeword = 'arch bake'): ScannedElement {
  return {
    label: 'btn', id: 0, category: 'button', type: 'button', adapter: null, codeword,
  };
}

beforeEach(() => {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { sendMessage: vi.fn().mockResolvedValue(undefined) },
  };
});

describe('sweepDisconnectedAfterBatch', () => {
  it('queues codewords for disconnected wrappers and detaches them', () => {
    const el1 = fakeElement(1);
    const el2 = fakeElement(2);
    const w1 = new ElementWrapper(el1, fakeScanned('arch bake'));
    const w2 = new ElementWrapper(el2, fakeScanned('arch check'));

    const queue: string[] = [];
    const detached: Element[] = [];
    // el2 is disconnected; el1 still in DOM.
    const isConnected = (el: Element) => el === el1;

    const swept = sweepDisconnectedAfterBatch(
      [w1, w2],
      isConnected,
      queue,
      (el) => { detached.push(el); },
    );

    expect(swept).toBe(1);
    expect(queue).toEqual(['arch check']);
    expect(detached).toEqual([el2]);
  });

  it('returns 0 and touches nothing when every wrapper still in DOM', () => {
    const wrappers = [
      new ElementWrapper(fakeElement(1), fakeScanned('arch bake')),
      new ElementWrapper(fakeElement(2), fakeScanned('arch check')),
    ];
    const queue: string[] = [];
    const detached: Element[] = [];
    const swept = sweepDisconnectedAfterBatch(
      wrappers, () => true, queue, (el) => { detached.push(el); },
    );
    expect(swept).toBe(0);
    expect(queue).toEqual([]);
    expect(detached).toEqual([]);
  });

  it('skips wrappers without a codeword (pool exhausted)', () => {
    const el = fakeElement(1);
    const w = new ElementWrapper(el, fakeScanned(''));
    const queue: string[] = [];
    const detached: Element[] = [];

    const swept = sweepDisconnectedAfterBatch(
      [w], () => false, queue, (el) => { detached.push(el); },
    );
    // No codeword → not actionable; sweep skips it even though disconnected.
    expect(swept).toBe(0);
    expect(queue).toEqual([]);
    expect(detached).toEqual([]);
  });

  it('queues every disconnected wrapper in order (preserves codeword order)', () => {
    const wrappers = [
      new ElementWrapper(fakeElement(1), fakeScanned('arch alpha')),
      new ElementWrapper(fakeElement(2), fakeScanned('arch bravo')),
      new ElementWrapper(fakeElement(3), fakeScanned('arch charlie')),
    ];
    const queue: string[] = [];
    const swept = sweepDisconnectedAfterBatch(
      wrappers, () => false, queue, () => {},
    );
    expect(swept).toBe(3);
    expect(queue).toEqual(['arch alpha', 'arch bravo', 'arch charlie']);
  });

  it('appends to an existing queue rather than replacing it', () => {
    const queue = ['prior delete'];
    const w = new ElementWrapper(fakeElement(1), fakeScanned('arch bake'));
    sweepDisconnectedAfterBatch([w], () => false, queue, () => {});
    expect(queue).toEqual(['prior delete', 'arch bake']);
  });
});
