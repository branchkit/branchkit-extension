import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openLivenessPort } from './liveness';

interface FakePort {
  onMessage: { addListener: ReturnType<typeof vi.fn> };
  onDisconnect: { addListener: ReturnType<typeof vi.fn> };
  fireDisconnect?: () => void;
}

describe('openLivenessPort — grammar resync on SW restart', () => {
  let ports: FakePort[];
  let connect: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    ports = [];
    connect = vi.fn(() => {
      const p: FakePort = {
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn((cb: () => void) => { p.fireDisconnect = cb; }) },
      };
      ports.push(p);
      return p;
    });
    vi.stubGlobal('chrome', { runtime: { connect, id: 'ext-id' } });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not resync on the initial open', () => {
    const onResync = vi.fn();
    openLivenessPort({ onFrameId: vi.fn(), onOrphan: vi.fn(), onResync });
    expect(onResync).not.toHaveBeenCalled();
  });

  it('resyncs after a transient SW-restart reconnect', () => {
    const onResync = vi.fn();
    const onOrphan = vi.fn();
    openLivenessPort({ onFrameId: vi.fn(), onOrphan, onResync });

    // SW idle-terminates: the Port drops while the runtime is still valid.
    ports[0].fireDisconnect!();
    expect(onResync).not.toHaveBeenCalled(); // reconnect is delayed

    vi.advanceTimersByTime(500); // reconnect fires
    expect(connect).toHaveBeenCalledTimes(2); // reopened
    expect(onResync).toHaveBeenCalledTimes(1);
    expect(onOrphan).not.toHaveBeenCalled();
  });

  it('orphans (no resync, no reconnect) when the runtime context is invalidated', () => {
    const onResync = vi.fn();
    const onOrphan = vi.fn();
    openLivenessPort({ onFrameId: vi.fn(), onOrphan, onResync });

    // Extension reload/uninstall: chrome.runtime.id goes away.
    (chrome as unknown as { runtime: { id?: string } }).runtime.id = undefined;
    ports[0].fireDisconnect!();
    vi.advanceTimersByTime(500);

    expect(onOrphan).toHaveBeenCalledTimes(1);
    expect(onResync).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(1); // never reopened
  });
});
