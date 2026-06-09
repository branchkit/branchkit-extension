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
