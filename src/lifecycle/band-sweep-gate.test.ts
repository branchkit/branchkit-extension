import { describe, it, expect, afterEach } from 'vitest';
import {
  shouldRunBandSweep, setSweepGateEnabled, SWEEP_LONG_STOP_MS,
} from './band-sweep-gate';

const base = { domAddEpoch: 5, sweptEpoch: 5, sweepEndAt: 10_000, now: 11_000, fastReveal: false, bootWindow: false };

afterEach(() => setSweepGateEnabled(true));

describe('shouldRunBandSweep', () => {
  it('skips when the epoch is clean and the last sweep is recent', () => {
    expect(shouldRunBandSweep({ ...base })).toBe(false);
  });

  it('runs when adds landed since the last sweep started', () => {
    expect(shouldRunBandSweep({ ...base, domAddEpoch: 6 })).toBe(true);
  });

  it('runs on the first sweep of a session (sweptEpoch sentinel)', () => {
    expect(shouldRunBandSweep({ ...base, sweptEpoch: -1, sweepEndAt: 0, now: 100 })).toBe(true);
  });

  it('fast-arm bypasses the gate even with a clean epoch', () => {
    expect(shouldRunBandSweep({ ...base, fastReveal: true })).toBe(true);
  });

  it('long-stop forces a sweep on a clean epoch (self-heal insurance)', () => {
    expect(shouldRunBandSweep({ ...base, now: base.sweepEndAt + SWEEP_LONG_STOP_MS })).toBe(true);
    expect(shouldRunBandSweep({ ...base, now: base.sweepEndAt + SWEEP_LONG_STOP_MS - 1 })).toBe(false);
  });

  it('kill switch restores every-settle arming', () => {
    setSweepGateEnabled(false);
    expect(shouldRunBandSweep({ ...base })).toBe(true);
  });

  it('boot window bypasses the gate — the add-epoch is blind to visibility-only reveals', () => {
    // The QuickBase tab-reopen trail: a class-flip reveal adds no DOM, so a
    // clean epoch starved the revealed region for up to the 30s long-stop
    // (31 consecutive skipClean rejections on one load).
    expect(shouldRunBandSweep({ ...base, bootWindow: true })).toBe(true);
  });
});
