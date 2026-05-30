/**
 * BranchKit Browser — activateElement delegation classification tests.
 *
 * Pins the ActivationResult contract — every code path returns the correct
 * `target` (the element actually clicked/focused) and `delegation` tag.
 * Phase 1 of the hint-diagnostics design (BK_ACTIVATE_PATH) depends on
 * this classification being correct.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { activateElement } from './event-sequence';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('activateElement delegation classification', () => {
  it('returns delegation=none + target=self when given a bare button', () => {
    const btn = document.createElement('button');
    document.body.appendChild(btn);

    const r = activateElement(btn);

    expect(r.delegation).toBe('none');
    expect(r.target).toBe(btn);
  });

  it('returns delegation=none + target=self when given a bare anchor', () => {
    // Anchor === closest('a') means no upward delegation occurred. The
    // click still goes to the anchor (native .click() for navigation),
    // but the delegation tag stays "none" — there was no wrapper-vs-
    // clicked split.
    const a = document.createElement('a');
    a.href = '#x';
    document.body.appendChild(a);

    const r = activateElement(a);

    expect(r.delegation).toBe('none');
    expect(r.target).toBe(a);
  });

  it('returns delegation=anchor + target=ancestor when given an element nested in an anchor', () => {
    // The QuickBase-style failure mode: registered element is a nested
    // icon/span, but activateElement climbs to the surrounding row anchor.
    // The diagnostic tag flags this so we can tell "wrapper points at X,
    // click landed on Y" from one log line.
    const a = document.createElement('a');
    a.href = '#row-12';
    const span = document.createElement('span');
    span.textContent = 'edit';
    a.appendChild(span);
    document.body.appendChild(a);

    const r = activateElement(span);

    expect(r.delegation).toBe('anchor');
    expect(r.target).toBe(a);
    expect(r.target).not.toBe(span);
  });

  it('returns delegation=file-picker for file inputs', () => {
    const input = document.createElement('input');
    input.type = 'file';
    document.body.appendChild(input);

    const r = activateElement(input);

    expect(r.delegation).toBe('file-picker');
    expect(r.target).toBe(input);
  });

  it('returns delegation=select for select elements', () => {
    const sel = document.createElement('select');
    document.body.appendChild(sel);

    const r = activateElement(sel);

    expect(r.delegation).toBe('select');
    expect(r.target).toBe(sel);
  });

  it('returns delegation=none for input elements that are not file', () => {
    // Text inputs are activated by content.ts via .focus() directly —
    // they don't reach activateElement in production, but if they do
    // the delegation tag should still be sane.
    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);

    const r = activateElement(input);

    expect(r.delegation).toBe('none');
    expect(r.target).toBe(input);
  });
});
