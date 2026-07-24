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

describe('repairLivenessAfterBfcacheRestore — layer 3 mechanism A', () => {
  interface RepairPort {
    onMessage: { addListener: ReturnType<typeof vi.fn> };
    onDisconnect: { addListener: ReturnType<typeof vi.fn> };
    postMessage: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }

  let ports: RepairPort[];
  let connect: ReturnType<typeof vi.fn>;
  let sendMessage: ReturnType<typeof vi.fn>;
  const handlers = { onFrameId: vi.fn(), onOrphan: vi.fn(), onResync: vi.fn() };

  // Fresh module per test: livenessPort/openedHandlers are module state.
  async function loadLiveness(): Promise<typeof import('./liveness')> {
    vi.resetModules();
    return await import('./liveness');
  }

  beforeEach(() => {
    vi.clearAllMocks();
    ports = [];
    connect = vi.fn(() => {
      const p: RepairPort = {
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      };
      ports.push(p);
      return p;
    });
    sendMessage = vi.fn().mockResolvedValue({ tracked: false });
    vi.stubGlobal('chrome', { runtime: { connect, sendMessage, id: 'ext-id' } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reopens when the SW confirms it is not tracking this doc (the proven dead state)', async () => {
    const liveness = await loadLiveness();
    liveness.openLivenessPort(handlers);
    expect(connect).toHaveBeenCalledTimes(1);

    const outcome = await liveness.repairLivenessAfterBfcacheRestore();
    expect(outcome).toBe('reopened');
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'LIVENESS_QUERY' }));
    expect(ports[0].disconnect).toHaveBeenCalledTimes(1); // zombie locally closed
    expect(connect).toHaveBeenCalledTimes(2); // fresh port
    expect(handlers.onResync).not.toHaveBeenCalled(); // restore owns that work
  });

  it('never severs a channel the SW says is healthy', async () => {
    const liveness = await loadLiveness();
    liveness.openLivenessPort(handlers);
    sendMessage.mockResolvedValue({ tracked: true });

    const outcome = await liveness.repairLivenessAfterBfcacheRestore();
    expect(outcome).toBe('healthy');
    expect(ports[0].disconnect).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('treats an erroring SW query as untracked and reopens', async () => {
    const liveness = await loadLiveness();
    liveness.openLivenessPort(handlers);
    sendMessage.mockRejectedValue(new Error('SW asleep'));

    expect(await liveness.repairLivenessAfterBfcacheRestore()).toBe('reopened');
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('does nothing on a dead context (teardown is mechanism B, not repair)', async () => {
    const liveness = await loadLiveness();
    liveness.openLivenessPort(handlers);
    (chrome as unknown as { runtime: { id?: string } }).runtime.id = undefined;

    expect(await liveness.repairLivenessAfterBfcacheRestore()).toBe('context_dead');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('is a no-op if the port was never opened', async () => {
    const liveness = await loadLiveness();
    expect(await liveness.repairLivenessAfterBfcacheRestore()).toBe('never_opened');
    expect(connect).not.toHaveBeenCalled();
  });
});
