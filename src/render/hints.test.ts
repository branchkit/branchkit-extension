import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { findBadgeContainer, findLimitParent, resolveContainer } from './container-resolution';
import { HintBadge, __refineScheduler, clampOffscreenBadgeBox } from './hints';
import { __testing as containerTracker } from '../observe/container-resize-tracker';
import { __testing as targetTracker } from '../observe/target-mutation-tracker';
import { __testing as hostTracker } from '../observe/host-attribute-tracker';

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

// Force `HintBadge` construction to run `refine()` synchronously instead of
// queueing onto requestIdleCallback. The tests assert observer state right
// after `new HintBadge(...)`, which the production deferred-refine path
// doesn't satisfy until the scheduler drains. This flag flips the
// constructor back to the inline-refine behavior that the tests pin.
beforeEach(() => {
  __refineScheduler.setImmediate(true);
});

afterEach(() => {
  for (const el of mounted) el.remove();
  mounted.length = 0;
  __refineScheduler.setImmediate(false);
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

describe('HintBadge.retarget (reconcile mode)', () => {
  // The badge swaps its tracked target + container tracking atomically; the
  // body-mounted reconcile host (and its host-attribute observer) survive.
  const label = { letter: 'a', words: ['arch'], isSingle: true };

  afterEach(() => {
    containerTracker.reset();
    targetTracker.reset();
    hostTracker.reset();
  });

  it('swaps the tracked target; host stays body-mounted, observer survives', () => {
    const root = mount(
      '<div id="oldContainer"><button id="oldBtn">click</button></div>' +
      '<div id="newContainer"><button id="newBtn">click</button></div>'
    );
    const oldBtn = root.querySelector('#oldBtn')!;
    const newBtn = root.querySelector('#newBtn')!;

    const badge = new HintBadge(oldBtn, label, 'button', 'word');
    // Reconcile host is body-mounted, never nested in the target's container.
    expect(badge.host.parentElement).toBe(document.body);
    expect(targetTracker.isTracked(oldBtn)).toBe(true);
    expect(hostTracker.isTracked(badge.host)).toBe(true);

    badge.retarget(newBtn);

    expect(badge.host.parentElement).toBe(document.body);
    expect(targetTracker.isTracked(oldBtn)).toBe(false);
    expect(targetTracker.isTracked(newBtn)).toBe(true);
    expect(hostTracker.isTracked(badge.host)).toBe(true);

    badge.remove();
  });

  it('remove() after retarget unsubscribes the new target, not the old', () => {
    const root = mount(
      '<div id="oldContainer"><button id="oldBtn">click</button></div>' +
      '<div id="newContainer"><button id="newBtn">click</button></div>'
    );
    const oldBtn = root.querySelector('#oldBtn')!;
    const newBtn = root.querySelector('#newBtn')!;

    const badge = new HintBadge(oldBtn, label, 'button', 'word');
    badge.retarget(newBtn);
    badge.remove();

    expect(targetTracker.isTracked(newBtn)).toBe(false);
    expect(hostTracker.isTracked(badge.host)).toBe(false);
  });
});

describe('container-resize refcount guard (2026-07 audit finding 8)', () => {
  // The container-resize tracker is a SHARED refcount (many badges per
  // anchorParent). A badge whose deferred refine() never ran holds no
  // refcount — its remove()/retarget() must not untrack, or it drains a
  // sibling's count and unobserves a container survivors still track.
  const label = { letter: 'a', words: ['arch'], isSingle: true };

  afterEach(() => {
    containerTracker.reset();
    targetTracker.reset();
    hostTracker.reset();
  });

  it('removing a never-refined badge does not steal a refined sibling\'s refcount', () => {
    const root = mount('<div id="c"><button id="b1">x</button><button id="b2">y</button></div>');
    const b1 = root.querySelector('#b1')!;
    const b2 = root.querySelector('#b2')!;
    const container = resolveContainer(b1);
    expect(resolveContainer(b2)).toBe(container); // same anchorParent

    const refined = new HintBadge(b1, label, 'button', 'word'); // refines inline
    expect(containerTracker.getRefCount(container)).toBe(1);

    // Leave immediate mode OFF for the rest of the test — flipping it back
    // on drains the queue and refines the badge we need unrefined.
    __refineScheduler.setImmediate(false);
    const unrefined = new HintBadge(b2, label, 'button', 'word');
    expect(containerTracker.getRefCount(container)).toBe(1); // never tracked

    unrefined.remove(); // pre-fix: underflowed to 0 and unobserved the container
    expect(containerTracker.getRefCount(container)).toBe(1);

    refined.remove();
    expect(containerTracker.getRefCount(container)).toBe(0);
  });

  it('retargeting a never-refined badge tracks the new container without draining the old', () => {
    const root = mount(
      '<div id="c1"><button id="b1">x</button><button id="b2">y</button></div>' +
      '<div id="c2"><button id="b3">z</button></div>'
    );
    const b1 = root.querySelector('#b1')!;
    const b2 = root.querySelector('#b2')!;
    const b3 = root.querySelector('#b3')!;
    const c1 = resolveContainer(b1);
    const c2 = resolveContainer(b3);

    const refined = new HintBadge(b1, label, 'button', 'word');
    __refineScheduler.setImmediate(false); // stays off — see sibling test
    const unrefined = new HintBadge(b2, label, 'button', 'word');
    expect(containerTracker.getRefCount(c1)).toBe(1);

    unrefined.retarget(b3); // pre-fix: drained c1's count on the way out
    expect(containerTracker.getRefCount(c1)).toBe(1);
    expect(containerTracker.getRefCount(c2)).toBe(1); // retarget tracks the new one

    unrefined.remove(); // now holds a real refcount on c2 — released once
    expect(containerTracker.getRefCount(c2)).toBe(0);
    expect(containerTracker.getRefCount(c1)).toBe(1);

    refined.remove();
    expect(containerTracker.getRefCount(c1)).toBe(0);
  });
});

describe('HintBadge.reconcileRead (positioning math)', () => {
  // The crux of the pure-JS reconcile model: convert the live target rect +
  // baked offset into the host's transform coords. Anchoring is per-target —
  // flow targets get DOCUMENT coords (rect + page scroll) so the absolute host
  // rides window scroll on the compositor; viewport-pinned targets get VIEWPORT
  // coords (rect only, no scroll term) so the fixed host stays with the pinned
  // target. Both must be scroll-invariant for their target — no per-frame chase.
  const label = { letter: 'a', words: ['arch'], isSingle: true };

  function rectStub(left: number, top: number): DOMRect {
    return {
      left, top, right: left + 20, bottom: top + 14, width: 20, height: 14,
      x: left, y: top, toJSON() { /* DOMRect shape */ },
    } as DOMRect;
  }
  function setScroll(x: number, y: number): void {
    Object.defineProperty(window, 'scrollX', { value: x, configurable: true });
    Object.defineProperty(window, 'scrollY', { value: y, configurable: true });
  }

  afterEach(() => {
    setScroll(0, 0);
    containerTracker.reset();
    targetTracker.reset();
    hostTracker.reset();
  });

  it('flow target: document coords stay constant as the window scrolls (rides scroll, no chase)', () => {
    const root = mount('<div id="c"><button id="btn">click</button></div>');
    const btn = root.querySelector('#btn')! as HTMLElement;
    setScroll(0, 0);
    btn.getBoundingClientRect = () => rectStub(100, 200);

    const badge = new HintBadge(btn, label, 'button', 'word');
    badge.show();
    badge.updatePosition({ x: 90, y: 190 }); // badge nudged up-left of the target

    expect(badge.reconcileRead()).toMatchObject({ x: 90, y: 190 });

    // Page scrolls down 300 / right 50: a flow target's viewport rect shifts by
    // -scroll, and reconcileRead adds +scroll, so the document coords (and thus
    // the host transform) are invariant — the badge tracks the target for free.
    setScroll(50, 300);
    btn.getBoundingClientRect = () => rectStub(100 - 50, 200 - 300);
    expect(badge.reconcileRead()).toMatchObject({ x: 90, y: 190 });

    badge.remove();
  });

  it('viewport-pinned target (fixed ancestor): no scroll term — host stays put on scroll', () => {
    const root = mount('<div id="fixed" style="position:fixed"><button id="btn">x</button></div>');
    const btn = root.querySelector('#btn')! as HTMLElement;
    setScroll(0, 0);
    btn.getBoundingClientRect = () => rectStub(40, 60);

    const badge = new HintBadge(btn, label, 'button', 'word');
    badge.show();
    badge.updatePosition({ x: 30, y: 50 });
    expect(badge.reconcileRead()).toMatchObject({ x: 30, y: 50 });

    // A fixed target keeps its viewport rect as the window scrolls; reconcileRead
    // must NOT fold in the scroll offset (adding scrollX=50 would yield x=80).
    setScroll(50, 300);
    expect(badge.reconcileRead()).toMatchObject({ x: 30, y: 50 });

    badge.remove();
  });

  it('returns null while hidden (not yet shown)', () => {
    const root = mount('<div><button id="btn">x</button></div>');
    const btn = root.querySelector('#btn')! as HTMLElement;
    btn.getBoundingClientRect = () => rectStub(10, 10);
    const badge = new HintBadge(btn, label, 'button', 'word');
    badge.updatePosition({ x: 5, y: 5 }); // baked, but never shown
    expect(badge.reconcileRead()).toBeNull();
    badge.remove();
  });

  it('returns null once the target disconnects from the DOM (soft-detach survivor stays glued, dead target does not)', () => {
    const root = mount('<div><button id="btn">x</button></div>');
    const btn = root.querySelector('#btn')! as HTMLElement;
    btn.getBoundingClientRect = () => rectStub(10, 10);
    const badge = new HintBadge(btn, label, 'button', 'word');
    badge.show();
    badge.updatePosition({ x: 5, y: 5 });
    expect(badge.reconcileRead()).not.toBeNull();

    btn.remove(); // target leaves the DOM
    expect(badge.reconcileRead()).toBeNull();
    badge.remove();
  });

  it('returns null before any offset has been baked (no updatePosition yet)', () => {
    const root = mount('<div><button id="btn">x</button></div>');
    const btn = root.querySelector('#btn')! as HTMLElement;
    btn.getBoundingClientRect = () => rectStub(10, 10);
    const badge = new HintBadge(btn, label, 'button', 'word');
    badge.show(); // visible + connected, but no baked offset
    expect(badge.reconcileRead()).toBeNull();
    badge.remove();
  });
});

describe('HintBadge reuse contract (setLabel + clearLabel)', () => {
  // The IO claim/release loop holds onto HintBadge instances across
  // viewport cycles so scroll-back doesn't pay full shadow-DOM-creation
  // cost. setLabel/clearLabel are the swap-text-without-recreate API.

  const label1 = { letter: 'a', words: ['arch'], isSingle: true };
  const label2 = { letter: 'b', words: ['bake'], isSingle: true };

  afterEach(() => {
    containerTracker.reset();
    targetTracker.reset();
    hostTracker.reset();
  });

  it('setLabel swaps inner text + invalidates badge size cache', () => {
    const root = mount('<div id="c"><button id="btn">click</button></div>');
    const badge = new HintBadge(root.querySelector('#btn')!, label1, 'button', 'word');
    // Touch badgeSize so a _size value gets cached.
    void badge.badgeSize;
    expect((badge as unknown as { inner: HTMLDivElement }).inner.textContent).toBe('arch');

    badge.setLabel(label2);

    expect((badge as unknown as { inner: HTMLDivElement }).inner.textContent).toBe('bake');
    // setLabel must invalidate _size so the next read re-measures with
    // the new text width; the cached value from 'arch' (different width)
    // would otherwise paint the badge with stale dimensions.
    expect((badge as unknown as { _size: unknown })._size).toBe(null);
    badge.remove();
  });

  it('clearLabel empties text + nulls the internal label without tearing down', () => {
    const root = mount('<div id="c"><button id="btn">click</button></div>');
    const badge = new HintBadge(root.querySelector('#btn')!, label1, 'button', 'word');
    expect((badge as unknown as { inner: HTMLDivElement }).inner.textContent).toBe('arch');

    badge.clearLabel();

    // Text gone, but the host + shadow + observers all still in place.
    expect((badge as unknown as { inner: HTMLDivElement }).inner.textContent).toBe('');
    expect(badge.host.isConnected).toBe(true);
    // The IO exit + show() cycle still works after clearLabel — the next
    // setLabel + show paints text back without reconstructing.
    badge.setLabel(label2);
    badge.show();
    expect((badge as unknown as { inner: HTMLDivElement }).inner.textContent).toBe('bake');
    badge.remove();
  });

  it('setMatchedChars after clearLabel is a no-op (guards against label=null)', () => {
    const root = mount('<div id="c"><button id="btn">click</button></div>');
    const badge = new HintBadge(root.querySelector('#btn')!, label1, 'button', 'word');
    badge.clearLabel();
    // Race: text-search filter fires while the wrapper is dormant. With
    // label cleared, setMatchedChars must short-circuit instead of
    // throwing on a null label deref.
    expect(() => badge.setMatchedChars(1)).not.toThrow();
    badge.remove();
  });

  it('show() on a dormant (cleared-label) badge stays hidden — no empty box', () => {
    const root = mount('<div id="c"><button id="btn">click</button></div>');
    const badge = new HintBadge(root.querySelector('#btn')!, label1, 'button', 'word');
    badge.clearLabel();
    // The recheck / pointerover show path can race ahead of the setLabel the
    // claim pipeline issues (a hover-revealed sidebar item mid-reclaim). A
    // label-less show() must NOT paint — otherwise the badge box appears with
    // no letters (the QuickBase URL-bar empty-box symptom).
    badge.show();
    expect(badge.isVisible).toBe(false);
    expect((badge as unknown as { inner: HTMLDivElement }).inner.textContent).toBe('');
    // Once the label is restored, show() paints normally.
    badge.setLabel(label2);
    badge.show();
    expect(badge.isVisible).toBe(true);
    expect((badge as unknown as { inner: HTMLDivElement }).inner.textContent).toBe('bake');
    badge.remove();
  });

  it('remove() unschedules pending refine + sets _removed so a late refine no-ops', () => {
    // Force the scheduler back into deferred mode so refine isn't called
    // inline. (beforeEach in the file flips it to immediate.)
    __refineScheduler.setImmediate(false);
    try {
      const root = mount('<div id="c"><button id="btn">click</button></div>');
      const badge = new HintBadge(root.querySelector('#btn')!, label1, 'button', 'word');
      // refine is queued, not yet run; remove before it can fire.
      badge.remove();
      // Draining the scheduler now must not crash and must not register
      // observers on the now-removed badge (no MO entries created).
      __refineScheduler.drainNow();
      // Indirect check: post-remove the host is detached and no observer
      // was registered (the four trackers are all empty).
      expect(badge.host.isConnected).toBe(false);
      expect(containerTracker.getRefCount(badge.anchorParent)).toBe(0);
    } finally {
      __refineScheduler.setImmediate(true);
    }
  });
});

describe('HintBadge bk-pending opacity indicator (voice-not-ready state)', () => {
  // Option B: badge paints translucent when the wrapper's codeword isn't
  // yet ACK'd by the plugin's grammar. The bk-pending class drives the
  // CSS opacity; markGrammarReady removes it when the ACK lands.

  const label = { letter: 'a', words: ['arch'], isSingle: true };

  afterEach(() => {
    containerTracker.reset();
    targetTracker.reset();
    hostTracker.reset();
  });

  it('show(false) adds bk-pending; markGrammarReady removes it', async () => {
    const root = mount('<div id="c"><button id="btn">click</button></div>');
    const badge = new HintBadge(root.querySelector('#btn')!, label, 'button', 'word');
    badge.show(false);
    // show() schedules the visible class via rAF; wait one frame.
    await new Promise(r => requestAnimationFrame(() => r(undefined)));
    expect((badge as unknown as { inner: HTMLDivElement }).inner.classList.contains('bk-pending')).toBe(true);
    expect((badge as unknown as { inner: HTMLDivElement }).inner.classList.contains('visible')).toBe(true);

    badge.markGrammarReady();
    expect((badge as unknown as { inner: HTMLDivElement }).inner.classList.contains('bk-pending')).toBe(false);
    // visible stays — markGrammarReady only flips the pending state.
    expect((badge as unknown as { inner: HTMLDivElement }).inner.classList.contains('visible')).toBe(true);
    badge.remove();
  });

  it('show(true) skips bk-pending entirely (race: grammar ACK already landed)', async () => {
    const root = mount('<div id="c"><button id="btn">click</button></div>');
    const badge = new HintBadge(root.querySelector('#btn')!, label, 'button', 'word');
    badge.show(true);
    await new Promise(r => requestAnimationFrame(() => r(undefined)));
    expect((badge as unknown as { inner: HTMLDivElement }).inner.classList.contains('bk-pending')).toBe(false);
    expect((badge as unknown as { inner: HTMLDivElement }).inner.classList.contains('visible')).toBe(true);
    badge.remove();
  });

  it('markGrammarReady is idempotent', () => {
    const root = mount('<div id="c"><button id="btn">click</button></div>');
    const badge = new HintBadge(root.querySelector('#btn')!, label, 'button', 'word');
    badge.show(false);
    badge.markGrammarReady();
    expect(() => badge.markGrammarReady()).not.toThrow();
    expect((badge as unknown as { inner: HTMLDivElement }).inner.classList.contains('bk-pending')).toBe(false);
    badge.remove();
  });
});

describe('clampOffscreenBadgeBox (paint-the-band write-time clamp)', () => {
  const VW = 1000;
  const VH = 800;

  it('pushes a left-parked target\'s overhanging badge back to the target\'s side (the drawer artifact)', () => {
    // Narrow target fully off the left edge; the badge box (wider than the
    // target's remaining offset) would bleed into the viewport.
    const target = { left: -30, right: -2, top: 100, bottom: 130 };
    const clamped = clampOffscreenBadgeBox({ x: -30, y: 95, w: 40, h: 15 }, target, VW, VH);
    // badgeX + badgeW ≤ target.right — fully on the target's side of the edge.
    expect(clamped.x + 40).toBeLessThanOrEqual(target.right);
    expect(clamped.y).toBe(95); // vertically on-screen: y-axis untouched
  });

  it('leaves a badge alone when it already sits on the target\'s side', () => {
    const target = { left: -228, right: -28, top: 100, bottom: 130 };
    const clamped = clampOffscreenBadgeBox({ x: -240, y: 95, w: 40, h: 15 }, target, VW, VH);
    expect(clamped).toEqual({ x: -240, y: 95 });
  });

  it('clamps a right-parked target\'s badge to at or beyond the target\'s left edge', () => {
    const target = { left: 1005, right: 1200, top: 100, bottom: 130 };
    const clamped = clampOffscreenBadgeBox({ x: 990, y: 95, w: 40, h: 15 }, target, VW, VH);
    expect(clamped.x).toBeGreaterThanOrEqual(target.left);
    expect(clamped.y).toBe(95);
  });

  it('clamps an above-viewport target\'s badge fully above with it', () => {
    const target = { left: 100, right: 200, top: -50, bottom: -5 };
    const clamped = clampOffscreenBadgeBox({ x: 95, y: -12, w: 40, h: 15 }, target, VW, VH);
    // badgeY + badgeH ≤ target.bottom.
    expect(clamped.y + 15).toBeLessThanOrEqual(target.bottom);
    expect(clamped.x).toBe(95);
  });

  it('clamps a below-fold target\'s badge overhang down to the target\'s top edge', () => {
    // Target 5px below the fold; placement hangs the badge up-and-left, so
    // the badge box would poke ~10px into the viewport bottom.
    const target = { left: 100, right: 200, top: VH + 5, bottom: VH + 35 };
    const clamped = clampOffscreenBadgeBox({ x: 95, y: VH - 10, w: 40, h: 15 }, target, VW, VH);
    expect(clamped.y).toBeGreaterThanOrEqual(target.top);
    expect(clamped.x).toBe(95);
  });

  it('clamps only the off-screen axis for a diagonally-parked target', () => {
    const target = { left: -30, right: -2, top: -50, bottom: -5 };
    const clamped = clampOffscreenBadgeBox({ x: -20, y: -10, w: 40, h: 15 }, target, VW, VH);
    expect(clamped.x + 40).toBeLessThanOrEqual(target.right);
    expect(clamped.y + 15).toBeLessThanOrEqual(target.bottom);
  });
});
