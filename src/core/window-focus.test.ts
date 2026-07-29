/**
 * BranchKit Browser — window-focus unit tests.
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type WindowFocus = typeof import('./window-focus');

let listeners: Array<{ type: string; fn: (e: Event) => void; capture: unknown }> = [];

async function load(): Promise<WindowFocus> {
  vi.resetModules();
  vi.doMock('../lifecycle/page-session', () => ({
    pageSession: {
      resources: {
        listen: (_t: unknown, type: string, fn: (e: Event) => void, capture: unknown) => {
          listeners.push({ type, fn, capture });
        },
      },
    },
  }));
  return await import('./window-focus');
}

/** An event whose target is `window`, which happy-dom will not synthesize. */
const at = (type: string, target: unknown) => {
  const e = new Event(type);
  Object.defineProperty(e, 'target', { value: target });
  return e;
};

beforeEach(() => { listeners = []; });
afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../lifecycle/page-session');
});

describe('installWindowFocusTracking', () => {
  it('seeds from document.hasFocus() so an injected frame does not wait for a refocus', async () => {
    const m = await load();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    expect(m.windowHasFocus()).toBe(false);
    m.installWindowFocusTracking();
    expect(m.windowHasFocus()).toBe(true);
    expect(m.focusMessageHandlers.GET_FOCUS_STATUS({}, {} as never)).toEqual({ focused: true });
  });

  it('tracks focus and blur on the window', async () => {
    const m = await load();
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    m.installWindowFocusTracking();
    const fire = (type: string, target: unknown) =>
      listeners.filter((l) => l.type === type).forEach((l) => l.fn(at(type, target)));

    fire('focus', window);
    expect(m.windowHasFocus()).toBe(true);
    fire('blur', window);
    expect(m.windowHasFocus()).toBe(false);
  });

  it('ignores focus that bubbled from an element inside the frame', async () => {
    const m = await load();
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    m.installWindowFocusTracking();
    const focus = listeners.find((l) => l.type === 'focus')!;
    const blur = listeners.find((l) => l.type === 'blur')!;

    focus.fn(at('focus', document.createElement('input')));
    expect(m.windowHasFocus()).toBe(false);
    // And the same guard on the way out: a field losing focus inside a focused
    // frame must not report the whole frame as blurred.
    focus.fn(at('focus', window));
    blur.fn(at('blur', document.createElement('input')));
    expect(m.windowHasFocus()).toBe(true);
  });

  it('listens in the capture phase — focus and blur do not bubble', async () => {
    const m = await load();
    m.installWindowFocusTracking();
    expect(listeners.map((l) => l.capture)).toEqual([true, true]);
  });

  it('re-installing ATTACHES again — the listeners it seeds are torn down with the session', async () => {
    const m = await load();
    const focused = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    m.installWindowFocusTracking();
    expect(listeners).toHaveLength(2);

    // What a teardown does: pageSession.resources removes them as a set.
    listeners.length = 0;
    focused.mockReturnValue(true);
    m.installWindowFocusTracking();

    // An already-installed latch would re-seed and attach nothing, freezing
    // the value forever while GET_FOCUS_STATUS kept answering it.
    expect(m.windowHasFocus()).toBe(true);
    expect(listeners).toHaveLength(2);
    const fire = (type: string) =>
      listeners.filter((l) => l.type === type).forEach((l) => l.fn(at(type, window)));
    fire('blur');
    expect(m.windowHasFocus()).toBe(false);
  });
});
