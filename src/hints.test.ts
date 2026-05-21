import { describe, it, expect, afterEach } from 'vitest';
import { findBadgeContainer, findLimitParent, resolveContainer, resolveBadgeContext } from './hints';

// happy-dom gives us real DOM APIs. getComputedStyle returns inline styles
// (no CSS engine), so we set style properties directly to simulate layouts.

const mounted: Element[] = [];

function mount(html: string): Element {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = html;
  document.body.appendChild(wrapper);
  mounted.push(wrapper);
  return wrapper;
}

afterEach(() => {
  for (const el of mounted) el.remove();
  mounted.length = 0;
});

describe('findBadgeContainer', () => {
  it('returns the nearest block-level parent', () => {
    const root = mount('<div id="outer"><span id="inner"><button id="btn">click</button></span></div>');
    const btn = root.querySelector('#btn')!;
    const container = findBadgeContainer(btn);
    expect(container).toBe(root.querySelector('#inner'));
  });

  it('skips display:contents elements', () => {
    const root = mount('<div id="outer"><div id="contents" style="display:contents"><button id="btn">click</button></div></div>');
    const btn = root.querySelector('#btn')!;
    const container = findBadgeContainer(btn);
    expect(container).toBe(root.querySelector('#outer'));
  });

  it('skips table internal elements up to the table', () => {
    const root = mount('<div id="wrapper"><table><tbody><tr><td><button id="btn">click</button></td></tr></tbody></table></div>');
    const btn = root.querySelector('#btn')!;
    const container = findBadgeContainer(btn);
    expect(container).toBe(root.querySelector('#wrapper'));
  });

  it('returns div inside td when no table-structural skip applies', () => {
    const root = mount('<div id="wrapper"><table><tbody><tr><td><div id="cell-content"><button id="btn">click</button></div></td></tr></tbody></table></div>');
    const btn = root.querySelector('#btn')!;
    const container = findBadgeContainer(btn);
    expect(container).toBe(root.querySelector('#cell-content'));
  });

  it('falls back to document.body when no suitable parent exists', () => {
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    mounted.push(btn);
    const container = findBadgeContainer(btn);
    expect(container).toBe(document.body);
  });

  it('returns shadow root host when target is inside shadow DOM', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    mounted.push(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const btn = document.createElement('button');
    shadow.appendChild(btn);

    const container = findBadgeContainer(btn);
    expect(container).toBe(host);
  });

  it('skips elements that have a shadowRoot attached', () => {
    const root = mount('<div id="outer"><div id="shadowed"><button id="btn">click</button></div></div>');
    const shadowed = root.querySelector('#shadowed') as HTMLElement;
    shadowed.attachShadow({ mode: 'open' });
    const btn = root.querySelector('#btn')!;
    const container = findBadgeContainer(btn);
    expect(container).toBe(root.querySelector('#outer'));
  });
});

describe('findLimitParent', () => {
  it('returns body when no scroll/fixed/sticky/transform ancestor exists', () => {
    const root = mount('<div id="outer"><button id="btn">click</button></div>');
    const btn = root.querySelector('#btn')!;
    expect(findLimitParent(btn)).toBe(document.body);
  });

  it('returns fixed-position ancestor', () => {
    const root = mount('<div id="fixed" style="position:fixed"><button id="btn">click</button></div>');
    const btn = root.querySelector('#btn')!;
    expect(findLimitParent(btn)).toBe(root.querySelector('#fixed'));
  });

  it('returns sticky-position ancestor', () => {
    const root = mount('<div id="sticky" style="position:sticky"><button id="btn">click</button></div>');
    const btn = root.querySelector('#btn')!;
    expect(findLimitParent(btn)).toBe(root.querySelector('#sticky'));
  });

  it('returns transform ancestor', () => {
    const root = mount('<div id="transformed" style="transform:translateX(0)"><button id="btn">click</button></div>');
    const btn = root.querySelector('#btn')!;
    expect(findLimitParent(btn)).toBe(root.querySelector('#transformed'));
  });
});

describe('resolveContainer', () => {
  it('returns findBadgeContainer result when no clip ancestor', () => {
    const root = mount('<div id="parent"><button id="btn">click</button></div>');
    const btn = root.querySelector('#btn')!;
    expect(resolveContainer(btn)).toBe(root.querySelector('#parent'));
  });

  it('escapes clipping div inside td to the td', () => {
    // Simulate div.column-... with overflow:hidden inside td (QuickBase pattern).
    // In happy-dom, getBoundingClientRect returns zero rects, so space.left = 0 < 15.
    // resolveContainer should escape to td (the clip div's parent).
    const root = mount(
      '<div id="wrapper"><table><tbody><tr>' +
      '<td id="cell"><div id="clipdiv" style="overflow-x:hidden;overflow-y:hidden"><button id="btn">click</button></div></td>' +
      '</tr></tbody></table></div>'
    );
    const btn = root.querySelector('#btn')!;
    const container = resolveContainer(btn);
    expect(container).toBe(root.querySelector('#cell'));
  });

  it('does not escape past limitParent', () => {
    const root = mount(
      '<div id="above">' +
      '<div id="scroll" style="position:fixed">' +
      '<table><tbody><tr>' +
      '<td><div id="clipdiv" style="overflow-x:hidden;overflow-y:hidden"><button id="btn">click</button></div></td>' +
      '</tr></tbody></table>' +
      '</div></div>'
    );
    const btn = root.querySelector('#btn')!;
    const container = resolveContainer(btn);
    // Should escape the clip div but stop at or inside #scroll (the limitParent).
    const scroll = root.querySelector('#scroll')!;
    expect(scroll.contains(container)).toBe(true);
  });
});

describe('resolveBadgeContext', () => {
  it('returns the container and appends the host', () => {
    const root = mount('<div id="parent"><button id="btn">click</button></div>');
    const btn = root.querySelector('#btn')!;
    const host = document.createElement('div');
    host.style.display = 'contents';
    const outer = document.createElement('div');
    host.attachShadow({ mode: 'open' }).appendChild(outer);

    const ctx = resolveBadgeContext(btn, host, outer);
    expect(ctx.container).toBe(root.querySelector('#parent'));
    expect(ctx.container.contains(host)).toBe(true);
  });

  it('returns absolute when offsetParent is null (default)', () => {
    const root = mount('<div id="parent"><button id="btn">click</button></div>');
    const btn = root.querySelector('#btn')!;
    const host = document.createElement('div');
    host.style.display = 'contents';
    const outer = document.createElement('div');
    host.attachShadow({ mode: 'open' }).appendChild(outer);

    const ctx = resolveBadgeContext(btn, host, outer);
    expect(ctx.positionMode).toBe('absolute');
  });
});
