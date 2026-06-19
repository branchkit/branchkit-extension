import { describe, it, expect } from 'vitest';
import { collectTextInputs } from './focus-input';

function dom(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

// jsdom has no layout, so bypass the visibility predicate.
const all = () => true;

describe('collectTextInputs', () => {
  it('collects text inputs, textareas and contenteditable in DOM order', () => {
    const root = dom(
      '<input id="a"><textarea id="b"></textarea><div contenteditable="true" id="c">x</div>',
    );
    expect(collectTextInputs(root, all).map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('excludes non-text input types', () => {
    const root = dom(
      '<input type="text" id="t"><input type="checkbox" id="x"><input type="button" id="y"><input type="hidden" id="z">',
    );
    expect(collectTextInputs(root, all).map((e) => e.id)).toEqual(['t']);
  });

  it('excludes disabled and readonly fields', () => {
    const root = dom(
      '<input id="ok"><input id="dis" disabled><input id="ro" readonly><textarea id="tdis" disabled></textarea>',
    );
    expect(collectTextInputs(root, all).map((e) => e.id)).toEqual(['ok']);
  });

  it('orders positive tabindex first (ascending), then DOM order', () => {
    const root = dom(
      '<input id="d"><input id="a" tabindex="1"><input id="c"><input id="b" tabindex="2">',
    );
    expect(collectTextInputs(root, all).map((e) => e.id)).toEqual(['a', 'b', 'd', 'c']);
  });

  it('honors the visibility predicate', () => {
    const root = dom('<input id="vis"><input id="hid">');
    const visible = collectTextInputs(root, (el) => el.id === 'vis');
    expect(visible.map((e) => e.id)).toEqual(['vis']);
  });
});
