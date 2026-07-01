/**
 * BranchKit Browser — shadow-attach-signal unit tests.
 *
 * Pins the signal/consume contract drainDiscovery relies on: with no live
 * signal the deep check never runs (storm-path cost unchanged); with one, a
 * skipped root containing a shadow-hosted hintable forces the walk and
 * consumes the signal; signals expire after the TTL.
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  noteDisconnectedShadowAttach,
  consumeShadowAttachSignal,
  _resetShadowAttachSignalForTests,
} from './shadow-attach-signal';

function shadowHintableRoot(): Element {
  const root = document.createElement('div');
  const host = document.createElement('div');
  root.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  const a = document.createElement('a');
  a.href = '#';
  shadow.appendChild(a);
  return root;
}

beforeEach(() => {
  _resetShadowAttachSignalForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('consumeShadowAttachSignal', () => {
  it('no live signal — false, no DOM work', () => {
    expect(consumeShadowAttachSignal(shadowHintableRoot())).toBe(false);
  });

  it('live signal + shadow-hosted hintable — true, signal consumed', () => {
    noteDisconnectedShadowAttach();
    const root = shadowHintableRoot();
    expect(consumeShadowAttachSignal(root)).toBe(true);
    // Consumed — a second identical root no longer matches.
    expect(consumeShadowAttachSignal(shadowHintableRoot())).toBe(false);
  });

  it('live signal but root has nothing hintable (even through shadow) — false, signal kept', () => {
    noteDisconnectedShadowAttach();
    const dull = document.createElement('div');
    dull.attachShadow({ mode: 'open' }).appendChild(document.createElement('span'));
    expect(consumeShadowAttachSignal(dull)).toBe(false);
    // Signal survives for the root that actually carries the host.
    expect(consumeShadowAttachSignal(shadowHintableRoot())).toBe(true);
  });

  it('light-DOM hintable also satisfies the deep check', () => {
    noteDisconnectedShadowAttach();
    const root = document.createElement('div');
    const a = document.createElement('a');
    a.href = '#';
    root.appendChild(a);
    expect(consumeShadowAttachSignal(root)).toBe(true);
  });

  it('one signal per hit — two attaches cover two roots', () => {
    noteDisconnectedShadowAttach();
    noteDisconnectedShadowAttach();
    expect(consumeShadowAttachSignal(shadowHintableRoot())).toBe(true);
    expect(consumeShadowAttachSignal(shadowHintableRoot())).toBe(true);
    expect(consumeShadowAttachSignal(shadowHintableRoot())).toBe(false);
  });

  it('signals expire after the TTL (host created but never inserted)', () => {
    // The module stamps with performance.now(); freeze it around the calls.
    const t0 = 1_000_000;
    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(t0);
    noteDisconnectedShadowAttach();
    nowSpy.mockReturnValue(t0 + 31_000);
    expect(consumeShadowAttachSignal(shadowHintableRoot())).toBe(false);
    nowSpy.mockRestore();
  });
});
