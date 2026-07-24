/**
 * BranchKit Browser — SSE transport unit tests.
 *
 * Pins the transport's health policy: the pause choke on the retry ladder and
 * on connect/event edges, the connect-edge bookkeeping order (transport state
 * before the heal hook), the direct-SSE already-connecting guard, and the
 * connection-check probe. The hooks are faked — this suite verifies WHEN they
 * fire, background.ts owns what they do.
 *
 * The module holds realm state (stream refs, backoff, pause flag) and detects
 * chrome.offscreen at load, so each test imports a fresh copy via
 * vi.resetModules() after stubbing the chrome global (no `offscreen` key →
 * Firefox direct-SSE engine).
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type Transport = typeof import('./sse-transport');

// Minimal EventSource fake: records instances, exposes listener maps.
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static OPEN = 1;
  static CLOSED = 2;
  readyState = 0; // CONNECTING
  closed = false;
  listeners = new Map<string, (e: unknown) => void>();
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: unknown) => void): void {
    this.listeners.set(type, fn);
  }
  close(): void {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
  emit(type: string, data?: unknown): void {
    this.listeners.get(type)?.({ data: JSON.stringify(data) });
  }
}

const storageData: Record<string, unknown> = {};

function stubChrome(): void {
  vi.stubGlobal('chrome', {
    // no `offscreen` key → hasOffscreenAPI false → Firefox direct-SSE path
    action: {
      setBadgeText: vi.fn().mockResolvedValue(undefined),
      setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
    },
    storage: {
      local: {
        set: vi.fn(async (obj: Record<string, unknown>) => { Object.assign(storageData, obj); }),
        get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
      },
    },
    runtime: { sendMessage: vi.fn().mockResolvedValue(undefined) },
  });
  vi.stubGlobal('EventSource', FakeEventSource);
}

// Fresh module graph per test: transport + its state/actuator-client deps.
async function loadTransport(opts?: { discoverResult?: boolean; creds?: boolean }) {
  vi.resetModules();
  const discoverPlugin = vi.fn().mockResolvedValue(opts?.discoverResult ?? false);
  const setVoicePaused = vi.fn();
  const hasCreds = opts?.creds ?? true;
  vi.doMock('./actuator-client', () => ({
    discoverPlugin,
    setVoicePaused,
    getPluginPort: () => (hasCreds ? 21551 : null),
    getPluginToken: () => (hasCreds ? 'tok' : null),
  }));
  const transport: Transport = await import('./sse-transport');
  const { bgState } = await import('../background/state');
  bgState.branchkitConnected = false;
  const hooks = {
    onPreConnect: vi.fn(),
    onConnectedEdge: vi.fn(),
    onEvent: vi.fn(),
    onAlphabet: vi.fn(),
  };
  transport.initSSETransport(hooks);
  return { transport, hooks, discoverPlugin, setVoicePaused, bgState };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.instances = [];
  for (const k of Object.keys(storageData)) delete storageData[k];
  stubChrome();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.doUnmock('./actuator-client');
});

describe('connectSSE (direct engine)', () => {
  it('fires onPreConnect and opens an EventSource carrying the conn_id', async () => {
    const { transport, hooks } = await loadTransport();
    transport.connectSSE();
    expect(hooks.onPreConnect).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toContain('token=tok');
    expect(FakeEventSource.instances[0].url).toContain('conn_id=');
  });

  it('bails without creds — no hook, no stream', async () => {
    const { transport, hooks } = await loadTransport({ creds: false });
    transport.connectSSE();
    expect(hooks.onPreConnect).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('keeps the in-flight socket on a redundant connect with unchanged creds', async () => {
    const { transport } = await loadTransport();
    transport.connectSSE();
    transport.connectSSE(); // same creds, first socket still CONNECTING
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].closed).toBe(false);
  });

  it('replaces a CLOSED socket on reconnect', async () => {
    const { transport } = await loadTransport();
    transport.connectSSE();
    FakeEventSource.instances[0].readyState = FakeEventSource.CLOSED;
    transport.connectSSE();
    expect(FakeEventSource.instances).toHaveLength(2);
  });
});

describe('connect edge', () => {
  it('stream `connected` → flags + mirror + onConnectedEdge', async () => {
    const { transport, hooks, bgState } = await loadTransport();
    transport.connectSSE();
    FakeEventSource.instances[0].listeners.get('connected')?.({});
    expect(bgState.branchkitConnected).toBe(true);
    expect(storageData.branchkitConnected).toBe(true);
    expect(hooks.onConnectedEdge).toHaveBeenCalledTimes(1);
  });

  it('routes action events to onEvent and alphabet events to onAlphabet', async () => {
    const { transport, hooks } = await loadTransport();
    transport.connectSSE();
    const es = FakeEventSource.instances[0];
    es.emit('action', { action: 'scroll_down' });
    expect(hooks.onEvent).toHaveBeenCalledWith({ action: 'scroll_down' });
    es.emit('alphabet', { words: ['ape', 'bat'] });
    expect(hooks.onAlphabet).toHaveBeenCalledWith(['ape', 'bat']);
  });

  it('onerror closes the stream and marks the connection down', async () => {
    const { transport, bgState } = await loadTransport();
    transport.connectSSE();
    const es = FakeEventSource.instances[0];
    es.listeners.get('connected')?.({});
    es.onerror?.();
    expect(es.closed).toBe(true);
    expect(bgState.branchkitConnected).toBe(false);
    expect(storageData.branchkitConnected).toBe(false);
  });
});

describe('retry ladder', () => {
  it('retries discovery until found, then connects', async () => {
    const { transport, discoverPlugin } = await loadTransport();
    transport.scheduleSSERetry();
    discoverPlugin.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await vi.advanceTimersByTimeAsync(60_000); // walk the whole backoff ladder
    expect(discoverPlugin).toHaveBeenCalledTimes(2);
    expect(FakeEventSource.instances).toHaveLength(1); // connected on 2nd find
  });

  it('collapses concurrent schedules into one pending timer', async () => {
    const { transport, discoverPlugin } = await loadTransport();
    transport.scheduleSSERetry();
    transport.scheduleSSERetry();
    discoverPlugin.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});

describe('voice pause (the choke)', () => {
  it('pauseVoice gates transport, tears down the stream, persists, and does NOT re-arm retry', async () => {
    const { transport, setVoicePaused, discoverPlugin, bgState } = await loadTransport();
    transport.connectSSE();
    const es = FakeEventSource.instances[0];
    es.listeners.get('connected')?.({});
    await transport.pauseVoice();
    expect(transport.isVoicePaused()).toBe(true);
    expect(setVoicePaused).toHaveBeenCalledWith(true);
    expect(es.closed).toBe(true);
    expect(bgState.branchkitConnected).toBe(false);
    expect(storageData.voicePaused).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(discoverPlugin).not.toHaveBeenCalled(); // ladder stayed dark
  });

  it('paused blocks scheduleSSERetry, onSSEConnected, and runConnectionCheck', async () => {
    const { transport, hooks, discoverPlugin, bgState } = await loadTransport();
    await transport.pauseVoice();
    transport.scheduleSSERetry();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(discoverPlugin).not.toHaveBeenCalled();
    transport.onSSEConnected(); // late HEALTH_STATUS(true) from a superseded stream
    expect(bgState.branchkitConnected).toBe(false);
    expect(hooks.onConnectedEdge).not.toHaveBeenCalled();
    await transport.runConnectionCheck();
    expect(discoverPlugin).not.toHaveBeenCalled();
  });

  it('resumeVoice un-gates and reconnects when discovery succeeds', async () => {
    const { transport, setVoicePaused, discoverPlugin } = await loadTransport();
    await transport.pauseVoice();
    discoverPlugin.mockResolvedValue(true);
    await transport.resumeVoice();
    expect(transport.isVoicePaused()).toBe(false);
    expect(setVoicePaused).toHaveBeenLastCalledWith(false);
    expect(storageData.voicePaused).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('restoreVoicePaused honors a persisted pause: gate + teardown + mirror, no connect', async () => {
    storageData.voicePaused = true;
    const { transport, setVoicePaused, bgState } = await loadTransport();
    expect(await transport.restoreVoicePaused()).toBe(true);
    expect(transport.isVoicePaused()).toBe(true);
    expect(setVoicePaused).toHaveBeenCalledWith(true);
    expect(bgState.branchkitConnected).toBe(false);
    expect(storageData.branchkitConnected).toBe(false);
  });

  it('restoreVoicePaused with no persisted pause leaves the mirror untouched', async () => {
    const { transport } = await loadTransport();
    expect(await transport.restoreVoicePaused()).toBe(false);
    // No unconditional mirror write — init's discovery path owns reconciliation.
    expect(storageData.branchkitConnected).toBeUndefined();
  });
});

describe('runConnectionCheck (direct engine)', () => {
  it('declares a silently-dead stream disconnected and re-arms retry', async () => {
    const { transport, bgState, discoverPlugin } = await loadTransport();
    transport.connectSSE();
    const es = FakeEventSource.instances[0];
    es.listeners.get('connected')?.({});
    es.readyState = FakeEventSource.CLOSED; // died without onerror
    await transport.runConnectionCheck();
    expect(bgState.branchkitConnected).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(discoverPlugin).toHaveBeenCalled(); // ladder re-armed
  });

  it('leaves a healthy OPEN stream alone', async () => {
    const { transport, bgState, discoverPlugin } = await loadTransport();
    transport.connectSSE();
    const es = FakeEventSource.instances[0];
    es.listeners.get('connected')?.({});
    es.readyState = FakeEventSource.OPEN;
    await transport.runConnectionCheck();
    expect(bgState.branchkitConnected).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(discoverPlugin).not.toHaveBeenCalled();
  });
});
