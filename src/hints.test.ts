import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import {
  findBadgeContainer,
  findLimitParent,
  resolveContainer,
  resolveBadgeContext,
  HintBadge,
  anchorOffsetCss,
  __testing as hintsTesting,
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

  it('mounts inside table cells (td) so badges scroll with table-scrolling apps', () => {
    // Required for Gmail-style mail lists where the table scrolls
    // inside a static outer wrapper. Mounting in the wrapper instead
    // of the cell would anchor the badge OUTSIDE the scrolling content.
    // Tested by snapshot evidence from Gmail (outer.vpY stuck at the
    // wrapper's bottom edge regardless of internal scroll).
    const root = mount('<div id="wrapper"><table><tbody><tr><td id="cell"><button id="btn">click</button></td></tr></tbody></table></div>');
    const btn = root.querySelector('#btn')!;
    const container = findBadgeContainer(btn);
    expect(container).toBe(root.querySelector('#cell'));
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

  // These assert the nesting (Firefox) path: host lives inside the target's
  // container. happy-dom's CSS.supports lies (returns true), so pin the mode.
  beforeEach(() => {
    hintsTesting.setAnchorSupport(false);
  });

  afterEach(() => {
    hintsTesting.setAnchorSupport(null);
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

describe('HintBadge anchor mode (CSS Anchor Positioning fast-path)', () => {
  // When the engine supports anchor positioning the host is body-mounted and
  // pinned to the target via an `anchor-name`, not nested in the container.

  const label = { letter: 'a', words: ['arch'], isSingle: true };

  beforeEach(() => {
    hintsTesting.setAnchorSupport(true);
  });

  afterEach(() => {
    hintsTesting.setAnchorSupport(null);
    containerTracker.reset();
    targetTracker.reset();
    hostTracker.reset();
  });

  it('mounts the host at document.body and writes anchor-name on the target', () => {
    const root = mount('<div id="container"><button id="btn">click</button></div>');
    const btn = root.querySelector('#btn')! as HTMLElement;

    const badge = new HintBadge(btn, label, 'button', 'word');

    // Host is body-mounted, not nested in the container.
    expect(badge.host.parentElement).toBe(document.body);
    expect(root.querySelector('#container')!.contains(badge.host)).toBe(false);
    // Target carries a unique anchor-name; host references it.
    const name = btn.style.getPropertyValue('anchor-name');
    expect(name).toMatch(/^--bk-\d+$/);
    expect(badge.host.style.getPropertyValue('position-anchor')).toBe(name);
    expect(badge.host.style.position).toBe('absolute');
    // anchorParent is still resolved for placement clamping.
    expect(badge.anchorParent).toBe(root.querySelector('#container'));

    badge.remove();
  });

  it('moves the anchor-name to the new target on retarget, reusing the name', () => {
    const root = mount(
      '<div id="c1"><button id="b1">click</button></div>' +
      '<div id="c2"><button id="b2">click</button></div>'
    );
    const b1 = root.querySelector('#b1')! as HTMLElement;
    const b2 = root.querySelector('#b2')! as HTMLElement;

    const badge = new HintBadge(b1, label, 'button', 'word');
    const name = b1.style.getPropertyValue('anchor-name');
    expect(name).toMatch(/^--bk-\d+$/);

    badge.retarget(b2);

    expect(b1.style.getPropertyValue('anchor-name')).toBe('');
    expect(b2.style.getPropertyValue('anchor-name')).toBe(name);
    // Host stays body-mounted; position-anchor unchanged.
    expect(badge.host.parentElement).toBe(document.body);
    expect(badge.host.style.getPropertyValue('position-anchor')).toBe(name);
    expect(badge.anchorParent).toBe(root.querySelector('#c2'));

    badge.remove();
  });

  it('clears the anchor-name from the target on remove', () => {
    const root = mount('<div id="container"><button id="btn">click</button></div>');
    const btn = root.querySelector('#btn')! as HTMLElement;

    const badge = new HintBadge(btn, label, 'button', 'word');
    expect(btn.style.getPropertyValue('anchor-name')).toMatch(/^--bk-\d+$/);

    badge.remove();

    expect(btn.style.getPropertyValue('anchor-name')).toBe('');
    expect(badge.host.parentElement).toBeNull();
  });

  it('bakes the placement offset into an anchor() calc relative to the target rect', () => {
    // Pure conversion: candidate is absolute viewport; the offset is from the
    // target's element rect (scroll-invariant — both move together on scroll).
    // (happy-dom's CSS parser rejects calc(anchor(...)) on style.left, so the
    // string write is exercised in the real browser; the math is unit-tested
    // here against the exported helper.)
    expect(anchorOffsetCss({ x: 15, y: -8 }, { left: 0, top: 0 }))
      .toEqual({ left: 'calc(anchor(left) + 15px)', top: 'calc(anchor(top) + -8px)' });
    expect(anchorOffsetCss({ x: 120, y: 240 }, { left: 100, top: 250 }))
      .toEqual({ left: 'calc(anchor(left) + 20px)', top: 'calc(anchor(top) + -10px)' });
  });
});

describe('HintBadge.needsScrollReposition (window-scroll trim)', () => {
  // The window-scroll reposition is scoped to badges that don't track their
  // target on their own. A nested badge rides the scroll-ancestor compositor,
  // so it must report "no reposition needed" — that's what lets content.ts
  // skip the placement sweep that dominated scroll-time CPU on heavy pages.
  const label = { letter: 'a', words: ['arch'], isSingle: true };

  afterEach(() => {
    hintsTesting.setAnchorSupport(null);
  });

  function place(badge: HintBadge): void {
    badge.show();
    badge.reposition(); // runs updatePosition → snapshots target/outer origin
  }

  it('returns false for a placed, compositor-tracked nesting badge', () => {
    hintsTesting.setAnchorSupport(false);
    const root = mount('<div id="c"><button id="btn">click</button></div>');
    const badge = new HintBadge(root.querySelector('#btn')!, label, 'button', 'word');
    place(badge);
    // Target and outer share a zero origin and neither moved → no drift.
    expect(badge.needsScrollReposition()).toBe(false);
    badge.remove();
  });

  it('returns true when the target drifts relative to the badge outer', () => {
    hintsTesting.setAnchorSupport(false);
    const root = mount('<div id="c"><button id="btn">click</button></div>');
    const btn = root.querySelector('#btn')! as HTMLElement;
    const badge = new HintBadge(btn, label, 'button', 'word');
    place(badge);
    // Simulate the scroll-context-mismatch case: the target shifted but the
    // badge's outer (still at origin) did not move with it.
    btn.getBoundingClientRect = () => new DOMRect(0, 200, 10, 10);
    expect(badge.needsScrollReposition()).toBe(true);
    badge.remove();
  });

  it('returns true for a sticky/fixed-clamped badge even with no drift', () => {
    hintsTesting.setAnchorSupport(false);
    const root = mount('<div id="c"><button id="btn">click</button></div>');
    const badge = new HintBadge(root.querySelector('#btn')!, label, 'button', 'word');
    place(badge);
    badge.scrollSensitive = true; // placement marks this when a sticky bound resolves
    expect(badge.needsScrollReposition()).toBe(true);
    badge.remove();
  });

  it('returns false in anchor mode regardless of drift or sticky marking', () => {
    hintsTesting.setAnchorSupport(true);
    const root = mount('<div id="c"><button id="btn">click</button></div>');
    const btn = root.querySelector('#btn')! as HTMLElement;
    const badge = new HintBadge(btn, label, 'button', 'word');
    badge.show();
    badge.scrollSensitive = true;
    btn.getBoundingClientRect = () => new DOMRect(0, 500, 10, 10);
    // Anchor-mode badges follow the target via the compositor + anchor();
    // the JS scroll reposition never applies.
    expect(badge.needsScrollReposition()).toBe(false);
    badge.remove();
  });
});
