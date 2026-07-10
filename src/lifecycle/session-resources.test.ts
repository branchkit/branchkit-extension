import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionResources } from './session-resources';

describe('SessionResources', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('removes listeners on teardown', () => {
    const r = new SessionResources();
    const target = new EventTarget();
    const handler = vi.fn();
    r.listen(target, 'ping', handler);

    target.dispatchEvent(new Event('ping'));
    expect(handler).toHaveBeenCalledTimes(1);

    r.teardownAll();
    target.dispatchEvent(new Event('ping'));
    expect(handler).toHaveBeenCalledTimes(1); // no further calls
    expect(r.counts.listeners).toBe(0);
  });

  it('clears intervals on teardown', () => {
    const r = new SessionResources();
    const tick = vi.fn();
    r.interval(tick, 100);

    vi.advanceTimersByTime(250);
    expect(tick).toHaveBeenCalledTimes(2);

    r.teardownAll();
    vi.advanceTimersByTime(500);
    expect(tick).toHaveBeenCalledTimes(2); // stopped
    expect(r.counts.intervals).toBe(0);
  });

  it('stopInterval cancels one interval and forgets it (pause without teardown)', () => {
    const r = new SessionResources();
    const a = vi.fn();
    const b = vi.fn();
    const idA = r.interval(a, 100);
    r.interval(b, 100);
    expect(r.counts.intervals).toBe(2);

    r.stopInterval(idA);
    expect(r.counts.intervals).toBe(1); // only A dropped
    vi.advanceTimersByTime(250);
    expect(a).not.toHaveBeenCalled(); // A paused
    expect(b).toHaveBeenCalledTimes(2); // B still runs

    r.stopInterval(idA); // no-op on an already-stopped id
    expect(r.counts.intervals).toBe(1);
  });

  it('clears pending timeouts on teardown', () => {
    const r = new SessionResources();
    const fn = vi.fn();
    r.timeout(fn, 100);
    expect(r.counts.timeouts).toBe(1);

    r.teardownAll();
    vi.advanceTimersByTime(200);
    expect(fn).not.toHaveBeenCalled();
    expect(r.counts.timeouts).toBe(0);
  });

  it('a fired timeout self-removes from the set', () => {
    const r = new SessionResources();
    const fn = vi.fn();
    r.timeout(fn, 100);
    expect(r.counts.timeouts).toBe(1);

    vi.advanceTimersByTime(150);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(r.counts.timeouts).toBe(0);
  });

  it('tracks and cancels rAFs', () => {
    const r = new SessionResources();
    r.raf(() => {});
    expect(r.counts.rafs).toBe(1);
    r.teardownAll();
    expect(r.counts.rafs).toBe(0);
  });

  it('disconnects tracked observers on teardown', () => {
    const r = new SessionResources();
    const obs = { disconnect: vi.fn() };
    expect(r.track(obs)).toBe(obs);
    expect(r.counts.observers).toBe(1);

    r.teardownAll();
    expect(obs.disconnect).toHaveBeenCalledTimes(1);
    expect(r.counts.observers).toBe(0);
  });

  it('teardownAll is idempotent and isolates failures', () => {
    const r = new SessionResources();
    const good = { disconnect: vi.fn() };
    const bad = { disconnect: vi.fn(() => { throw new Error('boom'); }) };
    r.track(bad);
    r.track(good);

    expect(() => r.teardownAll()).not.toThrow();
    expect(good.disconnect).toHaveBeenCalledTimes(1); // bad's throw didn't skip good
    expect(() => r.teardownAll()).not.toThrow(); // second call no-ops
  });
});
