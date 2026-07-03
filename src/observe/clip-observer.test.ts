import { describe, it, expect, afterEach } from 'vitest';
import type { ElementWrapper } from '../scan/element-wrapper';
import {
  reconcileClipObservation,
  drainClipObservers,
  setClipObserverEnabled,
  clipObserverDebug,
  boundClipRoot,
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

  it('rebinds a target whose bound root detached (same-task reparent)', () => {
    // A same-task remove+insert keeps the element connected at every
    // disconnect check, so no limbo/unobserve reset fires — the recheck in
    // the reconcile loop is the only thing that catches the stale binding.
    setClipObserverEnabled(true);
    const scrollerA = makeScroller();
    const scrollerB = makeScroller();
    const btn = document.createElement('button');
    scrollerA.appendChild(btn);
    const w = wrapperFor(btn);
    reconcileClipObservation([w]);
    expect(boundClipRoot(btn)).toBe(scrollerA);

    scrollerB.appendChild(btn); // reparent: btn never disconnects observably
    scrollerA.remove(); // old route's scroller detaches
    reconcileClipObservation([w]);
    expect(boundClipRoot(btn)).toBe(scrollerB);
    expect(clipObserverDebug()).toEqual({ roots: 1, targets: 1 });

    reconcileClipObservation([]);
    expect(clipObserverDebug()).toEqual({ roots: 0, targets: 0 });
  });

  it('rebinds when the wrapper was recreated for a still-bound element', () => {
    setClipObserverEnabled(true);
    const scroller = makeScroller();
    const btn = document.createElement('button');
    scroller.appendChild(btn);
    reconcileClipObservation([wrapperFor(btn)]);
    expect(clipObserverDebug()).toEqual({ roots: 1, targets: 1 });

    // Fresh wrapper object for the same element (attribute-flap
    // detach→reattach). Clip signals must land on the live wrapper.
    reconcileClipObservation([wrapperFor(btn)]);
    expect(clipObserverDebug()).toEqual({ roots: 1, targets: 1 });

    reconcileClipObservation([]);
    expect(clipObserverDebug()).toEqual({ roots: 0, targets: 0 });
  });

  it('releases the root observer when its last target is dropped', () => {
    // The root Map entry strongly references the scroll container; an entry
    // that outlives its targets pins a detached SPA route's subtree for the
    // life of the tab (the long-session leak — INVESTIGATION_LONG_SESSION_PERF).
    setClipObserverEnabled(true);
    const scroller = makeScroller();
    const a = document.createElement('button');
    const b = document.createElement('button');
    scroller.appendChild(a);
    scroller.appendChild(b);
    reconcileClipObservation([wrapperFor(a), wrapperFor(b)]);
    expect(clipObserverDebug()).toEqual({ roots: 1, targets: 2 });
    reconcileClipObservation([wrapperFor(a)]); // b dropped; root still has a
    expect(clipObserverDebug()).toEqual({ roots: 1, targets: 1 });
    reconcileClipObservation([]); // last target gone → root observer released
    expect(clipObserverDebug()).toEqual({ roots: 0, targets: 0 });
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
