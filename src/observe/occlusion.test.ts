import { describe, it, expect, afterEach } from 'vitest';
import { isHitOccluding, isOccluded, setOcclusionEnabled } from './occlusion';
import { HintBadge, __refineScheduler } from '../render/hints';

// The two-input occlusion fold lives on the badge (paint-decision state —
// DESIGN_OBSERVED_STATE_READ_TIME phase 2). Real HintBadge, real class/attr
// writes; applied occluded-ness is asserted off the host attribute the fold
// mirrors for diagnostics.
function makeBadge(): HintBadge {
  __refineScheduler.setImmediate(true);
  const root = document.createElement('div');
  root.innerHTML = '<button>x</button>';
  document.body.appendChild(root);
  mounted.push(root);
  return new HintBadge(
    root.querySelector('button')!,
    { letter: 'a', words: ['arch'], isSingle: true },
    'button', 'word',
  );
}
function isOccludedApplied(b: HintBadge): boolean {
  return b.host.getAttribute('data-bk-occluded') === 'true';
}

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
  setOcclusionEnabled(false);
});

describe('isHitOccluding', () => {
  it('null hit defers (not occluded)', () => {
    const root = mount('<button id="t">x</button>');
    const t = root.querySelector('#t')!;
    expect(isHitOccluding(t, null)).toBe(false);
  });

  it('hit === target is not occluded', () => {
    const root = mount('<button id="t">x</button>');
    const t = root.querySelector('#t')!;
    expect(isHitOccluding(t, t)).toBe(false);
  });

  it('hit is the target own descendant — not occluded (its visible content)', () => {
    const root = mount('<a id="t"><span id="label">go</span></a>');
    const t = root.querySelector('#t')!;
    const child = root.querySelector('#label')!;
    expect(isHitOccluding(t, child)).toBe(false);
  });

  it('hit is an ancestor wrapping the target — not occluded', () => {
    const root = mount('<a id="link"><span id="t">go</span></a>');
    const t = root.querySelector('#t')!;
    const anchor = root.querySelector('#link')!;
    expect(isHitOccluding(t, anchor)).toBe(false);
  });

  it('hit is an unrelated element on top — occluded', () => {
    const root = mount('<button id="t">x</button><div id="overlay">cover</div>');
    const t = root.querySelector('#t')!;
    const overlay = root.querySelector('#overlay')!;
    expect(isHitOccluding(t, overlay)).toBe(true);
  });

  it('hit is a sibling element — occluded', () => {
    const root = mount('<div id="a">a</div><div id="b">b</div>');
    const a = root.querySelector('#a')!;
    const b = root.querySelector('#b')!;
    expect(isHitOccluding(a, b)).toBe(true);
  });

  // Shadow-hosted target: document-level elementFromPoint can't pierce shadow,
  // so the hit for a point over shadow content is the HOST. Node.contains
  // stops at the boundary — without composed-tree containment every
  // shadow-hosted target reads as occluded by its own host.
  it('hit is the shadow host of a shadow-hosted target — not occluded', () => {
    const root = mount('<div id="host"></div>');
    const host = root.querySelector('#host')!;
    const shadow = host.attachShadow({ mode: 'open' });
    const t = document.createElement('button');
    shadow.appendChild(t);
    expect(isHitOccluding(t, host)).toBe(false);
  });

  it('hit inside the target own shadow tree — not occluded (its visible content)', () => {
    const root = mount('<div id="t"></div>');
    const t = root.querySelector('#t')!;
    const shadow = t.attachShadow({ mode: 'open' });
    const inner = document.createElement('span');
    shadow.appendChild(inner);
    expect(isHitOccluding(t, inner)).toBe(false);
  });

  it('hit is an unrelated shadow host — occluded', () => {
    const root = mount('<button id="t">x</button><div id="other"></div>');
    const t = root.querySelector('#t')!;
    const other = root.querySelector('#other')!;
    other.attachShadow({ mode: 'open' });
    expect(isHitOccluding(t, other)).toBe(true);
  });

  it('target and hit in sibling shadow trees under one host — occluded', () => {
    const root = mount('<div id="host"></div>');
    const host = root.querySelector('#host')!;
    const shadow = host.attachShadow({ mode: 'open' });
    const a = document.createElement('button');
    const b = document.createElement('div');
    shadow.append(a, b);
    expect(isHitOccluding(a, b)).toBe(true);
  });

  // Transparent overlays: hit-testable but invisible — the stretched
  // opacity:0 file input over a styled dropzone button. An invisible cover
  // isn't a visual cover.
  it('opacity:0 hit (stretched file input) — not occluded', () => {
    const root = mount(
      '<button id="t">Choose file</button><input id="overlay" type="file" style="opacity:0">');
    const t = root.querySelector('#t')!;
    const overlay = root.querySelector('#overlay')!;
    expect(isHitOccluding(t, overlay)).toBe(false);
  });

  it('hit inside an opacity:0 ancestor — not occluded (subtree is invisible)', () => {
    const root = mount(
      '<button id="t">x</button><div style="opacity:0"><div id="inner">cover</div></div>');
    const t = root.querySelector('#t')!;
    const inner = root.querySelector('#inner')!;
    expect(isHitOccluding(t, inner)).toBe(false);
  });

  it('transparent-BACKGROUND hit stays an occluder (only opacity exempts)', () => {
    const root = mount(
      '<button id="t">x</button><div id="scrim" style="background:transparent">text</div>');
    const t = root.querySelector('#t')!;
    const scrim = root.querySelector('#scrim')!;
    expect(isHitOccluding(t, scrim)).toBe(true);
  });
});

describe('isOccluded — flag gate', () => {
  it('returns false when the flag is off, regardless of geometry', () => {
    const root = mount('<button id="t">x</button>');
    const t = root.querySelector('#t')!;
    // flag defaults off (afterEach resets it)
    expect(isOccluded(t)).toBe(false);
  });

  it('returns false for a zero-area target even when enabled', () => {
    setOcclusionEnabled(true);
    const root = mount('<button id="t" style="width:0;height:0"></button>');
    const t = root.querySelector('#t') as HTMLElement;
    Object.defineProperty(t, 'getBoundingClientRect', {
      value: () => new DOMRect(10, 10, 0, 0),
      configurable: true,
    });
    expect(isOccluded(t)).toBe(false);
  });
});

describe('isOccluded — multi-point sampling', () => {
  const origEFP = document.elementFromPoint;
  afterEach(() => {
    document.elementFromPoint = origEFP;
    setOcclusionEnabled(false);
  });

  // Stub elementFromPoint: points at/below `coverFromY` return `cover`, else the
  // target. The box is 100x100 at (100,100); sample y's are 120/150/180.
  function stub(t: Element, cover: Element, coverFromY: number): void {
    Object.defineProperty(t, 'getBoundingClientRect', {
      value: () => new DOMRect(100, 100, 100, 100),
      configurable: true,
    });
    document.elementFromPoint = ((_x: number, y: number) =>
      y >= coverFromY ? cover : t) as typeof document.elementFromPoint;
  }

  it('occluded when most points are covered (center + bottom corners)', () => {
    setOcclusionEnabled(true);
    const root = mount('<button id="t">x</button><div id="c">c</div>');
    const t = root.querySelector('#t')!;
    const c = root.querySelector('#c')!;
    // cover y>=150: center(150) + both bottom corners(180) = 3 of 5 → occluded
    stub(t, c, 150);
    expect(isOccluded(t)).toBe(true);
  });

  it('NOT occluded when only a minority (bottom corners) is covered', () => {
    setOcclusionEnabled(true);
    const root = mount('<button id="t">x</button><div id="c">c</div>');
    const t = root.querySelector('#t')!;
    const c = root.querySelector('#c')!;
    // cover y>=180: only the two bottom corners = 2 of 5 → not occluded
    stub(t, c, 180);
    expect(isOccluded(t)).toBe(false);
  });

  it('NOT occluded when nothing covers it (all points hit the target)', () => {
    setOcclusionEnabled(true);
    const root = mount('<button id="t">x</button>');
    const t = root.querySelector('#t')!;
    Object.defineProperty(t, 'getBoundingClientRect', {
      value: () => new DOMRect(100, 100, 100, 100),
      configurable: true,
    });
    document.elementFromPoint = (() => t) as typeof document.elementFromPoint;
    expect(isOccluded(t)).toBe(false);
  });
});

describe('HintBadge.applyOcclusion — combine overlay + clip signals', () => {
  it('neither signal → not occluded, no flip', () => {
    const b = makeBadge();
    expect(b.applyOcclusion(false, false)).toBe(false);
    expect(isOccludedApplied(b)).toBe(false);
  });

  it('overlay verdict alone → occluded, hides the badge', () => {
    const b = makeBadge();
    expect(b.applyOcclusion(true, false)).toBe(true);
    expect(isOccludedApplied(b)).toBe(true);
  });

  it('clip signal alone (overlay: null — the clip IO path) → occluded', () => {
    const b = makeBadge();
    expect(b.applyOcclusion(null, true)).toBe(true);
    expect(isOccludedApplied(b)).toBe(true);
  });

  it('both signals → occluded, one flip', () => {
    const b = makeBadge();
    expect(b.applyOcclusion(true, true)).toBe(true);
    expect(isOccludedApplied(b)).toBe(true);
  });

  it('is idempotent — no flip when effective state is unchanged', () => {
    const b = makeBadge();
    b.applyOcclusion(null, true);
    expect(b.applyOcclusion(null, true)).toBe(false);
    expect(isOccludedApplied(b)).toBe(true);
  });

  it('remembers the overlay half across a clip-only update (the fold memory)', () => {
    const b = makeBadge();
    b.applyOcclusion(true, false);           // settle: overlay covers
    expect(b.applyOcclusion(null, false)).toBe(false); // clip IO: still covered by overlay
    expect(isOccludedApplied(b)).toBe(true);
  });

  it('clearing both un-hides the badge', () => {
    const b = makeBadge();
    b.applyOcclusion(true, false);
    expect(b.applyOcclusion(false, false)).toBe(true);
    expect(isOccludedApplied(b)).toBe(false);
    expect(b.diagnostics.overlayOccluded).toBe(false);
  });
});
