/**
 * BranchKit Browser — health / voice-pause message unit tests.
 *
 * Pins the two things the popup depends on: that a report drives the stream
 * lifecycle on EVERY message rather than on flag edges (the reconnect healer
 * regressed once on edge-gating — notes/DESIGN_SSE_RESILIENCE.md), and that the
 * toggle answers the SETTLED state, including when the lifecycle call fails.
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

type Mod = typeof import('./voice-status');

const onSSEConnected = vi.fn();
const onSSEDisconnected = vi.fn();
const pauseVoice = vi.fn();
const resumeVoice = vi.fn();
const isVoicePaused = vi.fn();
const ensureConnected = vi.fn();
const bgState = { branchkitConnected: false } as { branchkitConnected: boolean };

async function load(): Promise<Mod> {
  vi.resetModules();
  vi.doMock('./state', () => ({ bgState, connId: 'test' }));
  vi.doMock('../plugin/sse-transport', () => ({
    onSSEConnected, onSSEDisconnected, pauseVoice, resumeVoice, isVoicePaused,
  }));
  vi.doMock('../plugin/actuator-client', () => ({ ensureConnected }));
  return await import('./voice-status');
}

beforeEach(() => {
  vi.clearAllMocks();
  bgState.branchkitConnected = false;
  isVoicePaused.mockReturnValue(false);
  pauseVoice.mockResolvedValue(undefined);
  resumeVoice.mockResolvedValue(undefined);
});

describe('HEALTH_STATUS', () => {
  it('drives connect and disconnect off the report flag', async () => {
    const { voiceStatusMessageHandlers: h } = await load();

    h.HEALTH_STATUS({ type: 'HEALTH_STATUS', branchkit: true }, {} as any);
    expect(onSSEConnected).toHaveBeenCalledTimes(1);
    expect(onSSEDisconnected).not.toHaveBeenCalled();

    h.HEALTH_STATUS({ type: 'HEALTH_STATUS', branchkit: false }, {} as any);
    expect(onSSEDisconnected).toHaveBeenCalledTimes(1);
  });

  it('runs on every report, not just on edges', async () => {
    const { voiceStatusMessageHandlers: h } = await load();

    // Three identical up reports must do the work three times. Edge-gating here
    // is what masked the reconnect healer.
    for (let i = 0; i < 3; i++) h.HEALTH_STATUS({ type: 'x', branchkit: true }, {} as any);
    expect(onSSEConnected).toHaveBeenCalledTimes(3);

    for (let i = 0; i < 2; i++) h.HEALTH_STATUS({ type: 'x', branchkit: false }, {} as any);
    expect(onSSEDisconnected).toHaveBeenCalledTimes(2);
  });

  it('answers nothing — it is fire-and-forget', async () => {
    const { voiceStatusMessageHandlers: h } = await load();
    expect(h.HEALTH_STATUS({ type: 'x', branchkit: true }, {} as any)).toBeUndefined();
  });
});

describe('GET_HEALTH', () => {
  it('reports connected and paused independently', async () => {
    const { voiceStatusMessageHandlers: h } = await load();

    bgState.branchkitConnected = true;
    isVoicePaused.mockReturnValue(true);
    expect(h.GET_HEALTH({ type: 'GET_HEALTH' }, {} as any)).toEqual({ branchkit: true, paused: true });

    bgState.branchkitConnected = false;
    isVoicePaused.mockReturnValue(false);
    expect(h.GET_HEALTH({ type: 'GET_HEALTH' }, {} as any)).toEqual({ branchkit: false, paused: false });
  });

  it('answers synchronously so the router does not hold the channel open', async () => {
    const { voiceStatusMessageHandlers: h } = await load();
    const result = h.GET_HEALTH({ type: 'GET_HEALTH' }, {} as any);
    expect(typeof (result as { then?: unknown })?.then).not.toBe('function');
  });
});

describe('SET_VOICE_PAUSED', () => {
  it('pauses or resumes per the flag', async () => {
    const { voiceStatusMessageHandlers: h } = await load();

    await h.SET_VOICE_PAUSED({ type: 'x', paused: true }, {} as any);
    expect(pauseVoice).toHaveBeenCalledTimes(1);
    expect(resumeVoice).not.toHaveBeenCalled();

    await h.SET_VOICE_PAUSED({ type: 'x', paused: false }, {} as any);
    expect(resumeVoice).toHaveBeenCalledTimes(1);
  });

  it('answers the state as of AFTER the lifecycle settles', async () => {
    const { voiceStatusMessageHandlers: h } = await load();
    // Paused only flips once pauseVoice resolves — reading it early would
    // report the pre-toggle state to a popup that re-reads immediately.
    pauseVoice.mockImplementation(async () => { isVoicePaused.mockReturnValue(true); });

    await expect(h.SET_VOICE_PAUSED({ type: 'x', paused: true }, {} as any))
      .resolves.toEqual({ branchkit: false, paused: true });
  });

  it('still answers a truthful snapshot when the lifecycle call fails', async () => {
    const { voiceStatusMessageHandlers: h } = await load();
    pauseVoice.mockRejectedValue(new Error('offscreen gone'));
    bgState.branchkitConnected = true;

    await expect(h.SET_VOICE_PAUSED({ type: 'x', paused: true }, {} as any))
      .resolves.toEqual({ branchkit: true, paused: false });
  });
});

describe('GET_VOICE_STATUS', () => {
  it('reports connectivity', async () => {
    const { voiceStatusMessageHandlers: h } = await load();

    ensureConnected.mockResolvedValue(true);
    await expect(h.GET_VOICE_STATUS({ type: 'x' }, {} as any)).resolves.toEqual({ connected: true });
  });

  it('resolves not-connected rather than rejecting when discovery fails', async () => {
    const { voiceStatusMessageHandlers: h } = await load();
    ensureConnected.mockRejectedValue(new Error('no host'));

    await expect(h.GET_VOICE_STATUS({ type: 'x' }, {} as any)).resolves.toEqual({ connected: false });
  });
});
