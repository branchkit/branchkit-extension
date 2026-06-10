import { describe, it, expect, afterEach } from 'vitest';
import type { ElementWrapper } from '../scan/element-wrapper';
import {
  reconcileClipObservation,
  drainClipObservers,
  setClipObserverEnabled,
  clipObserverDebug,
} from './clip-observer';

const mounted: Element[] = [];
const stubbed: Element[] = [];

function makeScroller(): HTMLElement {
  const el = document.createElement('div');
  el.style.overflowY = 'auto';
  document.body.appendChild(el);
  mounted.push(el);
  Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: 300, configurable: true });
  stubbed.push(el);
  return el;
}

function wrapperFor(el: Element): ElementWrapper {
  return { element: el, hint: { isVisible: true } as never, clipped: false } as unknown as ElementWrapper;
}

afterEach(() => {
  drainClipObservers();
  setClipObserverEnabled(false);
  for (const el of mounted) el.remove();
  mounted.length = 0;
  for (const el of stubbed) {
    delete (el as unknown as Record<string, unknown>).scrollHeight;
    delete (el as unknown as Record<string, unknown>).clientHeight;
  }
  stubbed.length = 0;
});

describe('reconcileClipObservation', () => {
  it('observes nothing when the flag is off', () => {
    const scroller = makeScroller();
    const btn = document.createElement('button');
    scroller.appendChild(btn);
    reconcileClipObservation([wrapperFor(btn)]);
    expect(clipObserverDebug().targets).toBe(0);
  });

  it('observes a hinted target that sits inside a scroll container', () => {
    setClipObserverEnabled(true);
    const scroller = makeScroller();
    const btn = document.createElement('button');
    scroller.appendChild(btn);
    reconcileClipObservation([wrapperFor(btn)]);
    const dbg = clipObserverDebug();
    expect(dbg.targets).toBe(1);
    expect(dbg.roots).toBe(1);
  });

  it('does not observe a target with no inner scroll container', () => {
    setClipObserverEnabled(true);
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    mounted.push(btn);
    reconcileClipObservation([wrapperFor(btn)]);
    expect(clipObserverDebug().targets).toBe(0);
  });

  it('does not observe a position:fixed popup nested inside a scroll container', () => {
    // QuickBase renders a table's settings dropdown as a fixed popup inline
    // inside the sidebar's scroll <ul>. Ancestor overflow does not clip a fixed
    // element, so the clip IO must not root at that scroller — otherwise the
    // menu items get false-flagged `clipped` and their badges vanish.
    setClipObserverEnabled(true);
    const scroller = makeScroller();
    const popup = document.createElement('div');
    popup.style.position = 'fixed';
    const item = document.createElement('a');
    popup.appendChild(item);
    scroller.appendChild(popup);
    reconcileClipObservation([wrapperFor(item)]);
    expect(clipObserverDebug().targets).toBe(0);
  });

  it('drops observation when the target is no longer in the wanted set', () => {
    setClipObserverEnabled(true);
    const scroller = makeScroller();
    const btn = document.createElement('button');
    scroller.appendChild(btn);
    reconcileClipObservation([wrapperFor(btn)]);
    expect(clipObserverDebug().targets).toBe(1);
    reconcileClipObservation([]); // btn no longer present
    expect(clipObserverDebug().targets).toBe(0);
  });

  it('drainClipObservers clears everything', () => {
    setClipObserverEnabled(true);
    const scroller = makeScroller();
    const btn = document.createElement('button');
    scroller.appendChild(btn);
    reconcileClipObservation([wrapperFor(btn)]);
    drainClipObservers();
    expect(clipObserverDebug()).toEqual({ roots: 0, targets: 0 });
  });

  it('flipping the flag off drains existing observers', () => {
    setClipObserverEnabled(true);
    const scroller = makeScroller();
    const btn = document.createElement('button');
    scroller.appendChild(btn);
    reconcileClipObservation([wrapperFor(btn)]);
    expect(clipObserverDebug().targets).toBe(1);
    setClipObserverEnabled(false);
    expect(clipObserverDebug().targets).toBe(0);
  });
});
