import { describe, it, expect, afterEach } from 'vitest';
import {
  findBadgeContainer,
  findLimitParent,
  resolveContainer,
  resolveBadgeContext,
  HintBadge,
} from './hints';
import { __testing as containerTracker } from './container-resize-tracker';
import { __testing as targetTracker } from './target-mutation-tracker';
import { __testing as hostTracker } from './host-attribute-tracker';

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

  it('returns relative when offsetParent is null (closed-shadow production path)', () => {
    // In production, the badge shadow is closed, so outer.offsetParent
    // returns null. We default to relative positioning (Rango pattern)
    // so the outer's DOM position drives its visual position — works
    // correctly inside overflow-scrolling ancestors (Gmail mail list,
    // Slack chat panels) where absolute positioning would anchor the
    // outer to a non-scrolling containing block.
    const root = mount('<div id="parent"><button id="btn">click</button></div>');
    const btn = root.querySelector('#btn')!;
    const host = document.createElement('div');
    host.style.display = 'contents';
    const outer = document.createElement('div');
    host.attachShadow({ mode: 'open' }).appendChild(outer);

    const ctx = resolveBadgeContext(btn, host, outer);
    expect(ctx.positionMode).toBe('relative');
  });
});

describe('HintBadge.retarget', () => {
  // Step 4 of DESIGN_WRAPPER_IDENTITY_STABILITY. Verifies the badge
  // swaps target + anchor + per-target observers atomically, and that
  // the host element (and its observer) survives unchanged.

  const label = { letter: 'a', words: ['arch'], isSingle: true };

  afterEach(() => {
    containerTracker.reset();
    targetTracker.reset();
    hostTracker.reset();
  });

  it('moves the host into the new target’s container and re-tracks observers', () => {
    const root = mount(
      '<div id="oldContainer"><button id="oldBtn">click</button></div>' +
      '<div id="newContainer"><button id="newBtn">click</button></div>'
    );
    const oldBtn = root.querySelector('#oldBtn')!;
    const newBtn = root.querySelector('#newBtn')!;
    const oldContainer = root.querySelector('#oldContainer')!;
    const newContainer = root.querySelector('#newContainer')!;

    const badge = new HintBadge(oldBtn, label, 'button', 'word');
    expect(badge.anchorParent).toBe(oldContainer);
    expect(oldContainer.contains(badge.host)).toBe(true);
    expect(containerTracker.getRefCount(oldContainer)).toBe(1);
    expect(targetTracker.isTracked(oldBtn)).toBe(true);
    expect(targetTracker.isTracked(newBtn)).toBe(false);
    // Host attribute tracker observes the badge host — must survive
    // unchanged across retarget.
    expect(hostTracker.isTracked(badge.host)).toBe(true);

    badge.retarget(newBtn);

    expect(badge.anchorParent).toBe(newContainer);
    expect(newContainer.contains(badge.host)).toBe(true);
    expect(oldContainer.contains(badge.host)).toBe(false);

    // Container tracker: refcount transferred from old to new.
    expect(containerTracker.getRefCount(oldContainer)).toBe(0);
    expect(containerTracker.getRefCount(newContainer)).toBe(1);

    // Target tracker: old detached, new attached.
    expect(targetTracker.isTracked(oldBtn)).toBe(false);
    expect(targetTracker.isTracked(newBtn)).toBe(true);

    // Host attribute tracker still on the same host — not torn down.
    expect(hostTracker.isTracked(badge.host)).toBe(true);
  });

  it('remove() after retarget unsubscribes the new anchor + target, not the old', () => {
    const root = mount(
      '<div id="oldContainer"><button id="oldBtn">click</button></div>' +
      '<div id="newContainer"><button id="newBtn">click</button></div>'
    );
    const oldBtn = root.querySelector('#oldBtn')!;
    const newBtn = root.querySelector('#newBtn')!;
    const newContainer = root.querySelector('#newContainer')!;

    const badge = new HintBadge(oldBtn, label, 'button', 'word');
    badge.retarget(newBtn);
    badge.remove();

    expect(containerTracker.getRefCount(newContainer)).toBe(0);
    expect(targetTracker.isTracked(newBtn)).toBe(false);
    expect(hostTracker.isTracked(badge.host)).toBe(false);
  });
});
