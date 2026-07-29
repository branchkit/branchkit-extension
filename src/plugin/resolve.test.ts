/**
 * BranchKit Browser — codeword resolver tests.
 *
 * Pins the WYSIWYG matching: a typed codeword resolves whether the user
 * typed the displayed badge form (letter / first-word) for the active
 * mode or the canonical spoken word pair.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resolveHintLocally } from './resolve';
import { WrapperStore, ElementWrapper } from '../scan/element-wrapper';
import { setAlphabet, type LabelAssignment } from '../labels/words';
import type { ScannedElement, ResolveHintResponse } from '../types';

const ALPHABET = [
  'arch', 'bake', 'cape', 'dune', 'elm', 'frog', 'glad', 'half', 'iron', 'jake',
  'kind', 'lime', 'make', 'none', 'own', 'plan', 'quick', 'rain', 'song', 'take',
  'under', 'voice', 'work', 'xray', 'yoga', 'zoo',
];

function scanned(codeword: string): ScannedElement {
  return { label: '', id: 0, category: 'button', type: 'button', adapter: null, codeword };
}

function storeWith(el: Element, codeword: string, label?: LabelAssignment): WrapperStore {
  const store = new WrapperStore();
  const w = new ElementWrapper(el, scanned(codeword));
  if (label) w.label = label;
  store.addWrapper(w);
  return store;
}

beforeEach(() => {
  setAlphabet(ALPHABET);
  document.body.innerHTML = '';
});

describe('resolveHintLocally — WYSIWYG hint matching', () => {
  // Token "c g" → letter "cg"; with the voice overlay loaded the spoken form
  // is "cape glad" (word mode) / "cape g" (first-word mode).

  it('resolves the letter form the badge shows in letter mode', () => {
    document.body.innerHTML = `<button id="del">Delete</button>`;
    const store = storeWith(document.getElementById('del')!, 'c g');
    const res = resolveHintLocally(store, 'cg', 'letter');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.tagName).toBe('button');
  });

  it('resolves the spoken word pair in word mode', () => {
    document.body.innerHTML = `<button id="x">X</button>`;
    const store = storeWith(document.getElementById('x')!, 'c g');
    expect(resolveHintLocally(store, 'cape glad', 'word').ok).toBe(true);
  });

  it('resolves the first-word form in expand mode', () => {
    document.body.innerHTML = `<button id="x">X</button>`;
    const store = storeWith(document.getElementById('x')!, 'c g');
    expect(resolveHintLocally(store, 'cape g', 'expand').ok).toBe(true);
  });

  it('resolves a letter token directly via byCodeword', () => {
    document.body.innerHTML = `<button id="x">X</button>`;
    const store = storeWith(document.getElementById('x')!, 'c g', {
      words: ['c', 'g'], letter: 'cg', isSingle: false,
    });
    expect(resolveHintLocally(store, 'c g', 'letter').ok).toBe(true);
  });

  it('tolerates spacing and case in the typed letters', () => {
    document.body.innerHTML = `<button id="x">X</button>`;
    const store = storeWith(document.getElementById('x')!, 'c g');
    expect(resolveHintLocally(store, ' C G ', 'letter').ok).toBe(true);
  });

  it('does not match the letter form against the wrong mode', () => {
    // In word mode the badge shows "cape glad"; typing "cg" should miss.
    document.body.innerHTML = `<button id="x">X</button>`;
    const store = storeWith(document.getElementById('x')!, 'c g');
    expect(resolveHintLocally(store, 'cg', 'word').ok).toBe(false);
  });

  it('fails clearly when no badge matches', () => {
    document.body.innerHTML = `<button id="x">X</button>`;
    const store = storeWith(document.getElementById('x')!, 'c g');
    const res = resolveHintLocally(store, 'zz', 'letter');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/not visible/i);
  });

  it('reports when the matched element has left the DOM', () => {
    const el = document.createElement('button');  // never appended → not connected
    const store = storeWith(el, 'c g');
    const res = resolveHintLocally(store, 'cg', 'letter');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/no longer in the DOM/i);
  });
});

describe('hintResolveMessageHandlers', () => {
  it('resolves against the LIVE page store, not a store the caller passes', async () => {
    const { store } = await import('../core/store');
    const { hintResolveMessageHandlers } = await import('./resolve');
    setAlphabet(ALPHABET);
    document.body.innerHTML = `<button id="del">Delete</button>`;
    const el = document.getElementById('del')!;
    const w = new ElementWrapper(el, scanned('c g'));
    store.addWrapper(w);
    try {
      const answer = hintResolveMessageHandlers.RESOLVE_HINT(
        { type: 'RESOLVE_HINT', codeword: 'cg' }, {} as never,
      ) as ResolveHintResponse;
      // The whole point of the handler: the options page sends a codeword and
      // gets the live page's answer. Binding an empty store would answer
      // found:false forever, with every unit test still green.
      expect(answer.ok).toBe(true);
      expect(answer.ok && answer.selector).toBeTruthy();
    } finally {
      store.removeWrapperByElement(el);
      el.remove();
    }
  });

  it('answers not-ok for a codeword nothing on the page holds', async () => {
    const { store } = await import('../core/store');
    const { hintResolveMessageHandlers } = await import('./resolve');
    setAlphabet(ALPHABET);
    document.body.innerHTML = `<button id="del">Delete</button>`;
    const el = document.getElementById('del')!;
    // A RESOLVABLE wrapper has to be present, or a handler that ignored the
    // codeword entirely would answer not-ok here for the wrong reason and
    // this test would pass against it.
    const w = new ElementWrapper(el, scanned('c g'));
    store.addWrapper(w);
    try {
      const answer = hintResolveMessageHandlers.RESOLVE_HINT(
        { type: 'RESOLVE_HINT', codeword: 'zz' }, {} as never,
      ) as ResolveHintResponse;
      expect(answer.ok).toBe(false);
    } finally {
      store.removeWrapperByElement(el);
    }
  });
});
