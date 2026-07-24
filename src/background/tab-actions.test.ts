/**
 * BranchKit Browser — tab/zoom verb handler unit tests.
 *
 * Pins the verb semantics over a faked chrome.tabs: next/previous cycling,
 * goto's 1-based clamp, move bounds, zoom stepping within Chrome's 25%–500%
 * limits, and switchToTabById's stale-id refresh path.
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type TabActions = typeof import('./tab-actions');

const scheduleTabPublish = vi.fn();
let tabs: Array<{ id: number; active: boolean; pinned?: boolean; windowId?: number; mutedInfo?: { muted: boolean } }>;
const updated: Array<{ id: number; props: Record<string, unknown> }> = [];
const last = () => updated[updated.length - 1];
let zoom = 1;

async function loadTabActions(): Promise<TabActions> {
  vi.resetModules();
  vi.doMock('./tab-collection', () => ({ scheduleTabPublish }));
  return await import('./tab-actions');
}

beforeEach(() => {
  vi.clearAllMocks();
  updated.length = 0;
  zoom = 1;
  tabs = [
    { id: 10, active: false, windowId: 1 },
    { id: 11, active: true, windowId: 1 },
    { id: 12, active: false, windowId: 1 },
  ];
  vi.stubGlobal('chrome', {
    tabs: {
      query: vi.fn(async () => tabs),
      update: vi.fn(async (id: number, props: Record<string, unknown>) => { updated.push({ id, props }); }),
      create: vi.fn(async () => ({})),
      remove: vi.fn(async () => {}),
      duplicate: vi.fn(async () => ({})),
      move: vi.fn(async () => ({})),
      get: vi.fn(async (id: number) => {
        const t = tabs.find((x) => x.id === id);
        if (!t) throw new Error('no such tab');
        return t;
      }),
      getZoom: vi.fn(async () => zoom),
      setZoom: vi.fn(async (_id: number, z: number) => { zoom = z; }),
    },
    windows: { update: vi.fn(async () => ({})) },
    sessions: { restore: vi.fn(async () => ({})) },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('./tab-collection');
});

describe('handleTabAction', () => {
  it('next/previous cycle with wraparound', async () => {
    const ta = await loadTabActions();
    await ta.handleTabAction('next');
    expect(last()).toEqual({ id: 12, props: { active: true } });
    await ta.handleTabAction('previous');
    expect(last()).toEqual({ id: 10, props: { active: true } });
  });

  it('goto clamps its 1-based index to the tab strip', async () => {
    const ta = await loadTabActions();
    await ta.handleTabAction('goto', 99);
    expect(last()).toEqual({ id: 12, props: { active: true } }); // clamped to last
    await ta.handleTabAction('goto', 1);
    expect(last()).toEqual({ id: 10, props: { active: true } });
  });

  it('goto to the already-active position is a no-op', async () => {
    const ta = await loadTabActions();
    await ta.handleTabAction('goto', 2); // tab 11 is active
    expect(updated).toHaveLength(0);
  });

  it('move respects the strip bounds', async () => {
    const ta = await loadTabActions();
    tabs[0].active = true; tabs[1].active = false;
    await ta.handleTabAction('move_left'); // already leftmost
    expect(chrome.tabs.move).not.toHaveBeenCalled();
    await ta.handleTabAction('move_right');
    expect(chrome.tabs.move).toHaveBeenCalledWith(10, { index: 1 });
  });

  it('pin and mute toggle the current state', async () => {
    const ta = await loadTabActions();
    await ta.handleTabAction('pin');
    expect(last()).toEqual({ id: 11, props: { pinned: true } });
    await ta.handleTabAction('mute');
    expect(last()).toEqual({ id: 11, props: { muted: true } });
  });
});

describe('handleZoomAction', () => {
  it('steps zoom by 10% and clamps at the 500% ceiling', async () => {
    const ta = await loadTabActions();
    tabs = [{ id: 11, active: true }];
    await ta.handleZoomAction('in');
    expect(zoom).toBeCloseTo(1.1);
    zoom = 4.98;
    await ta.handleZoomAction('in');
    expect(zoom).toBe(5);
  });

  it('clamps at the 25% floor and reset returns to default', async () => {
    const ta = await loadTabActions();
    tabs = [{ id: 11, active: true }];
    zoom = 0.3;
    await ta.handleZoomAction('out');
    expect(zoom).toBe(0.25);
    await ta.handleZoomAction('reset');
    expect(zoom).toBe(0);
  });
});

describe('switchToTabById', () => {
  it('focuses the window then activates the tab', async () => {
    const ta = await loadTabActions();
    await ta.switchToTabById(12);
    expect(chrome.windows.update).toHaveBeenCalledWith(1, { focused: true });
    expect(last()).toEqual({ id: 12, props: { active: true } });
  });

  it('a stale id refreshes the tab collection instead', async () => {
    const ta = await loadTabActions();
    await ta.switchToTabById(999);
    expect(scheduleTabPublish).toHaveBeenCalled();
    expect(updated).toHaveLength(0);
  });
});
