import { describe, it, expect, afterEach } from 'vitest';
import { findScrollableAncestor, findScrollableAncestors, findClippingScroller, isScrollTimelineSupported } from './scroll-accel';

// happy-dom gives real DOM APIs but does no layout: scrollHeight/clientHeight are
// always 0 and getComputedStyle returns inline styles only. So we stub the
// scroll metrics per element and set overflow-y inline to simulate a scroller.

const mounted: Element[] = [];
const stubbed: Element[] = [];

function mount(html: string): Element {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = html;
  document.body.appendChild(wrapper);
  mounted.push(wrapper);
  return wrapper;
}

/** Make `el` look like (or unlike) a live vertical scroller. */
function setScroller(
  el: Element,
  opts: { overflowY?: string; scrollHeight?: number; clientHeight?: number },
): void {
  if (opts.overflowY !== undefined) (el as HTMLElement).style.overflowY = opts.overflowY;
  if (opts.scrollHeight !== undefined) {
    Object.defineProperty(el, 'scrollHeight', { value: opts.scrollHeight, configurable: true });
    stubbed.push(el);
  }
  if (opts.clientHeight !== undefined) {
    Object.defineProperty(el, 'clientHeight', { value: opts.clientHeight, configurable: true });
    stubbed.push(el);
  }
}

afterEach(() => {
  for (const el of mounted) el.remove();
  mounted.length = 0;
  for (const el of stubbed) {
    delete (el as unknown as Record<string, unknown>).scrollHeight;
    delete (el as unknown as Record<string, unknown>).clientHeight;
  }
  stubbed.length = 0;
});

describe('findScrollableAncestor', () => {
  it('returns the nearest ancestor with overflow-y:auto that overflows', () => {
    const root = mount('<div id="scroller"><div id="mid"><button id="btn">x</button></div></div>');
    const scroller = root.querySelector('#scroller')!;
    setScroller(scroller, { overflowY: 'auto', scrollHeight: 1000, clientHeight: 400 });

    const btn = root.querySelector('#btn')!;
    expect(findScrollableAncestor(btn)).toBe(scroller);
  });

  it('recognizes overflow-y:scroll', () => {
    const root = mount('<div id="scroller"><button id="btn">x</button></div>');
    const scroller = root.querySelector('#scroller')!;
    setScroller(scroller, { overflowY: 'scroll', scrollHeight: 800, clientHeight: 200 });

    const btn = root.querySelector('#btn')!;
    expect(findScrollableAncestor(btn)).toBe(scroller);
  });

  it('ignores overflow-y:visible/hidden even when content overflows', () => {
    const root = mount('<div id="hidden"><button id="btn">x</button></div>');
    const hidden = root.querySelector('#hidden')!;
    setScroller(hidden, { overflowY: 'hidden', scrollHeight: 1000, clientHeight: 100 });

    const btn = root.querySelector('#btn')!;
    expect(findScrollableAncestor(btn)).toBeNull();
  });

  it('ignores an overflow-y:auto ancestor that is not currently overflowing', () => {
    const root = mount('<div id="maybe"><button id="btn">x</button></div>');
    const maybe = root.querySelector('#maybe')!;
    // overflow-y:auto but content fits → nothing to ride.
    setScroller(maybe, { overflowY: 'auto', scrollHeight: 300, clientHeight: 300 });

    const btn = root.querySelector('#btn')!;
    expect(findScrollableAncestor(btn)).toBeNull();
  });

  it('returns the NEAREST scroller when scrollers are nested', () => {
    const root = mount(
      '<div id="outer"><div id="inner"><button id="btn">x</button></div></div>',
    );
    const outer = root.querySelector('#outer')!;
    const inner = root.querySelector('#inner')!;
    setScroller(outer, { overflowY: 'auto', scrollHeight: 2000, clientHeight: 500 });
    setScroller(inner, { overflowY: 'scroll', scrollHeight: 1000, clientHeight: 300 });

    const btn = root.querySelector('#btn')!;
    expect(findScrollableAncestor(btn)).toBe(inner);
  });

  it('excludes documentElement and body even if they overflow', () => {
    const root = mount('<div id="plain"><button id="btn">x</button></div>');
    setScroller(document.documentElement, { overflowY: 'auto', scrollHeight: 5000, clientHeight: 800 });
    setScroller(document.body, { overflowY: 'auto', scrollHeight: 5000, clientHeight: 800 });

    const btn = root.querySelector('#btn')!;
    expect(findScrollableAncestor(btn)).toBeNull();
  });

  it('returns null when there is no scrollable ancestor', () => {
    const root = mount('<div id="a"><div id="b"><button id="btn">x</button></div></div>');
    const btn = root.querySelector('#btn')!;
    expect(findScrollableAncestor(btn)).toBeNull();
  });

  it('does not treat the element itself as its scrollable ancestor', () => {
    const root = mount('<div id="self"><button id="btn">x</button></div>');
    // The element passed in IS a scroller, but we only want ANCESTORS.
    const self = root.querySelector('#self')!;
    setScroller(self, { overflowY: 'auto', scrollHeight: 1000, clientHeight: 100 });

    expect(findScrollableAncestor(self)).toBeNull();
  });

  it('pierces shadow boundaries to find a scroller above the shadow host', () => {
    const root = mount('<div id="scroller"></div>');
    const scroller = root.querySelector('#scroller')! as HTMLElement;
    setScroller(scroller, { overflowY: 'auto', scrollHeight: 1200, clientHeight: 300 });

    const shadowHost = document.createElement('div');
    scroller.appendChild(shadowHost);
    const shadow = shadowHost.attachShadow({ mode: 'open' });
    const btn = document.createElement('button');
    shadow.appendChild(btn);

    expect(findScrollableAncestor(btn)).toBe(scroller);
  });
});

describe('findScrollableAncestors (chain)', () => {
  it('returns all scroller ancestors innermost-first', () => {
    const root = mount('<div id="outer"><div id="mid"><div id="inner"><button id="btn">x</button></div></div></div>');
    const outer = root.querySelector('#outer')!;
    const inner = root.querySelector('#inner')!;
    setScroller(outer, { overflowY: 'auto', scrollHeight: 2000, clientHeight: 500 });
    setScroller(inner, { overflowY: 'scroll', scrollHeight: 1000, clientHeight: 300 });
    const btn = root.querySelector('#btn')!;
    expect(findScrollableAncestors(btn)).toEqual([inner, outer]);
  });

  it('returns a single-element array for one scroller', () => {
    const root = mount('<div id="s"><button id="btn">x</button></div>');
    const s = root.querySelector('#s')!;
    setScroller(s, { overflowY: 'auto', scrollHeight: 1000, clientHeight: 300 });
    expect(findScrollableAncestors(root.querySelector('#btn')!)).toEqual([s]);
  });

  it('returns empty when there is no scroller', () => {
    const root = mount('<div id="a"><button id="btn">x</button></div>');
    expect(findScrollableAncestors(root.querySelector('#btn')!)).toEqual([]);
  });

  it('excludes documentElement/body from the chain', () => {
    const root = mount('<div id="s"><button id="btn">x</button></div>');
    const s = root.querySelector('#s')!;
    setScroller(s, { overflowY: 'auto', scrollHeight: 1000, clientHeight: 300 });
    setScroller(document.body, { overflowY: 'auto', scrollHeight: 5000, clientHeight: 800 });
    expect(findScrollableAncestors(root.querySelector('#btn')!)).toEqual([s]);
  });
});

describe('findClippingScroller', () => {
  it('returns the scroller for a normal (non-fixed) descendant', () => {
    const root = mount('<div id="scroller"><div id="mid"><button id="btn">x</button></div></div>');
    const scroller = root.querySelector('#scroller')!;
    setScroller(scroller, { overflowY: 'auto', scrollHeight: 1000, clientHeight: 400 });
    expect(findClippingScroller(root.querySelector('#btn')!)).toBe(scroller);
  });

  it('returns null when a position:fixed element sits between target and scroller', () => {
    // The QuickBase shape: a fixed popup nested inside the sidebar's scroll
    // container. Ancestor overflow does not clip a fixed element, so no scroller
    // clips the menu item — clip-detection must not root an IO at the scroller.
    const root = mount(
      '<div id="scroller"><div id="popup"><a id="item">Structure</a></div></div>',
    );
    const scroller = root.querySelector('#scroller')!;
    setScroller(scroller, { overflowY: 'auto', scrollHeight: 1000, clientHeight: 400 });
    (root.querySelector('#popup') as HTMLElement).style.position = 'fixed';
    expect(findClippingScroller(root.querySelector('#item')!)).toBeNull();
  });

  it('returns null when the target itself is position:fixed', () => {
    const root = mount('<div id="scroller"><button id="btn">x</button></div>');
    const scroller = root.querySelector('#scroller')!;
    setScroller(scroller, { overflowY: 'auto', scrollHeight: 1000, clientHeight: 400 });
    (root.querySelector('#btn') as HTMLElement).style.position = 'fixed';
    expect(findClippingScroller(root.querySelector('#btn')!)).toBeNull();
  });

  it('still clips a non-fixed target nested below a fixed sibling subtree', () => {
    // A fixed element elsewhere in the scroller must not disable clipping for a
    // normal target that really is in the scroller's flow.
    const root = mount(
      '<div id="scroller"><div id="fixed">f</div><button id="btn">x</button></div>',
    );
    const scroller = root.querySelector('#scroller')!;
    setScroller(scroller, { overflowY: 'auto', scrollHeight: 1000, clientHeight: 400 });
    (root.querySelector('#fixed') as HTMLElement).style.position = 'fixed';
    expect(findClippingScroller(root.querySelector('#btn')!)).toBe(scroller);
  });
});

describe('isScrollTimelineSupported', () => {
  it('reflects the presence of the global ScrollTimeline constructor', () => {
    const present = typeof (globalThis as { ScrollTimeline?: unknown }).ScrollTimeline !== 'undefined';
    expect(isScrollTimelineSupported()).toBe(present);
  });
});
