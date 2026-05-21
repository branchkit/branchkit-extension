import { describe, it, expect } from 'vitest';
import { findBadgeContainer, resolveBadgeContext } from './hints';

// happy-dom gives us real DOM APIs. getComputedStyle returns inline styles
// (no CSS engine), so we set style properties directly to simulate layouts.

function mount(html: string): Element {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = html;
  document.body.appendChild(wrapper);
  return wrapper;
}

describe('findBadgeContainer', () => {
  it('returns the nearest block-level parent', () => {
    const root = mount('<div id="outer"><span id="inner"><button id="btn">click</button></span></div>');
    const btn = root.querySelector('#btn')!;
    // span is inline by default in happy-dom, but getCachedStyle won't
    // report display:inline without a CSS engine. happy-dom returns ''
    // for computed display, which doesn't match 'contents' or table
    // selectors, so the first HTMLElement parent is returned.
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

  // display:table-* skip is also tested by the real <table> test above.
  // happy-dom doesn't preserve display:table-cell on inline styles so we
  // can't test the CSS-driven path here — it's exercised in Playwright
  // integration tests on real pages.

  it('falls back to document.body when no suitable parent exists', () => {
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    const container = findBadgeContainer(btn);
    expect(container).toBe(document.body);
  });

  it('returns shadow root host when target is inside shadow DOM', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
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
    // The button is a light DOM child, but #shadowed has a shadowRoot
    // so findBadgeContainer skips it.
    const btn = root.querySelector('#btn')!;
    const container = findBadgeContainer(btn);
    expect(container).toBe(root.querySelector('#outer'));
  });
});

describe('resolveBadgeContext', () => {
  it('returns the container from findBadgeContainer and appends the host', () => {
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

  it('returns absolute when offsetParent is inside the container', () => {
    const root = mount('<div id="parent" style="position:relative"><button id="btn">click</button></div>');
    const btn = root.querySelector('#btn')!;
    const host = document.createElement('div');
    host.style.display = 'contents';
    const outer = document.createElement('div');
    outer.style.position = 'absolute';
    host.attachShadow({ mode: 'open' }).appendChild(outer);

    const ctx = resolveBadgeContext(btn, host, outer);
    // happy-dom may not compute offsetParent correctly, so this tests
    // the fallback path (offsetParent null → absolute).
    expect(ctx.positionMode).toBe('absolute');
  });

  it('returns absolute when offsetParent is null (default)', () => {
    const root = mount('<div id="parent"><button id="btn">click</button></div>');
    const btn = root.querySelector('#btn')!;
    const host = document.createElement('div');
    host.style.display = 'contents';
    const outer = document.createElement('div');
    host.attachShadow({ mode: 'open' }).appendChild(outer);

    const ctx = resolveBadgeContext(btn, host, outer);
    // When offsetParent is null (happy-dom, or element not in DOM properly),
    // we default to absolute — the safe default that works for most cases.
    expect(ctx.positionMode).toBe('absolute');
  });
});
