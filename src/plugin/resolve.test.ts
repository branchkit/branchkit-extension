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
import type { ScannedElement } from '../types';

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

describe('resolveHintLocally — WYSIWYG codeword matching', () => {
  // "cape glad" → letter "cg", first-word "cape g", word "cape glad".

  it('resolves the letter form the badge shows in letter mode', () => {
    document.body.innerHTML = `<button id="del">Delete</button>`;
    const store = storeWith(document.getElementById('del')!, 'cape glad');
    const res = resolveHintLocally(store, 'cg', 'letter');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.tagName).toBe('button');
  });

  it('resolves the first-word form in first-word mode', () => {
    document.body.innerHTML = `<button id="x">X</button>`;
    const store = storeWith(document.getElementById('x')!, 'cape glad');
    expect(resolveHintLocally(store, 'cape g', 'first-word').ok).toBe(true);
  });

  it('still resolves the spoken word pair even in letter mode (type what you say)', () => {
    document.body.innerHTML = `<button id="x">X</button>`;
    const store = storeWith(document.getElementById('x')!, 'cape glad', {
      words: ['cape', 'glad'], letter: 'cg', isSingle: false,
    });
    expect(resolveHintLocally(store, 'cape glad', 'letter').ok).toBe(true);
  });

  it('tolerates spacing and case in the typed letters', () => {
    document.body.innerHTML = `<button id="x">X</button>`;
    const store = storeWith(document.getElementById('x')!, 'cape glad');
    expect(resolveHintLocally(store, ' C G ', 'letter').ok).toBe(true);
  });

  it('does not match the letter form against the wrong mode', () => {
    // In word mode the badge shows "cape glad"; typing "cg" should miss.
    document.body.innerHTML = `<button id="x">X</button>`;
    const store = storeWith(document.getElementById('x')!, 'cape glad');
    expect(resolveHintLocally(store, 'cg', 'word').ok).toBe(false);
  });

  it('fails clearly when no badge matches', () => {
    document.body.innerHTML = `<button id="x">X</button>`;
    const store = storeWith(document.getElementById('x')!, 'cape glad');
    const res = resolveHintLocally(store, 'zz', 'letter');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/not visible/i);
  });

  it('reports when the matched element has left the DOM', () => {
    const el = document.createElement('button');  // never appended → not connected
    const store = storeWith(el, 'cape glad');
    const res = resolveHintLocally(store, 'cg', 'letter');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/no longer in the DOM/i);
  });
});
