import { describe, it, expect, afterEach } from 'vitest';
import { isHitOccluding, isOccluded, setOcclusionEnabled, applyOcclusion } from './occlusion';
import type { ElementWrapper } from '../scan/element-wrapper';

function fakeWrapper(init: { overlayCovered?: boolean; clipped?: boolean }): {
  w: ElementWrapper;
  shown: boolean[];
} {
  const shown: boolean[] = [];
  const w = {
    overlayCovered: init.overlayCovered ?? false,
    clipped: init.clipped ?? false,
    occluded: false,
    hint: { setOccluded: (b: boolean) => shown.push(b) },
  } as unknown as ElementWrapper;
  return { w, shown };
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

describe('applyOcclusion — combine overlay + clip signals', () => {
  it('neither signal → not occluded, no badge write', () => {
    const { w, shown } = fakeWrapper({});
    expect(applyOcclusion(w)).toBe(false);
    expect(w.occluded).toBe(false);
    expect(shown).toEqual([]);
  });

  it('overlayCovered alone → occluded, hides the badge', () => {
    const { w, shown } = fakeWrapper({ overlayCovered: true });
    expect(applyOcclusion(w)).toBe(true);
    expect(w.occluded).toBe(true);
    expect(shown).toEqual([true]);
  });

  it('clipped alone → occluded (the IO signal)', () => {
    const { w, shown } = fakeWrapper({ clipped: true });
    expect(applyOcclusion(w)).toBe(true);
    expect(w.occluded).toBe(true);
    expect(shown).toEqual([true]);
  });

  it('both signals → occluded once', () => {
    const { w } = fakeWrapper({ overlayCovered: true, clipped: true });
    expect(applyOcclusion(w)).toBe(true);
    expect(w.occluded).toBe(true);
  });

  it('is idempotent — no write when effective state is unchanged', () => {
    const { w, shown } = fakeWrapper({ clipped: true });
    applyOcclusion(w);
    expect(applyOcclusion(w)).toBe(false);
    expect(shown).toEqual([true]);
  });

  it('clearing both un-hides the badge', () => {
    const { w, shown } = fakeWrapper({ overlayCovered: true });
    applyOcclusion(w);
    w.overlayCovered = false;
    expect(applyOcclusion(w)).toBe(true);
    expect(w.occluded).toBe(false);
    expect(shown).toEqual([true, false]);
  });
});
