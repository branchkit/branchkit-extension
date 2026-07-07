/**
 * BranchKit Browser — connection-mirror behavior.
 *
 * The mirror feeds isPaintReady only (disconnected badges paint opaque —
 * voice isn't coming). Pins: default-false posture, transition-only
 * callbacks, and the boot-read vs live-change race (a stale get() must not
 * overwrite a newer onChanged edge).
 *
 * Run: npm test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  initConnectionMirror,
  isBranchKitConnected,
  resetConnectionMirrorForTest,
} from './connection-mirror';

type StorageChanges = Record<string, { newValue?: unknown; oldValue?: unknown }>;
type ChangeListener = (changes: StorageChanges, area: string) => void;

describe('connection mirror', () => {
  let changeListeners: ChangeListener[];
  let resolveGet!: (value: Record<string, unknown>) => void;
  let getPromise: Promise<Record<string, unknown>>;

  const fireChange = (value: boolean, area = 'local'): void => {
    for (const l of changeListeners) l({ branchkitConnected: { newValue: value } }, area);
  };

  beforeEach(() => {
    resetConnectionMirrorForTest();
    changeListeners = [];
    getPromise = new Promise((r) => { resolveGet = r; });
    vi.stubGlobal('chrome', {
      storage: {
        local: { get: vi.fn(() => getPromise) },
        onChanged: { addListener: (l: ChangeListener) => changeListeners.push(l) },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to disconnected until the boot read resolves', () => {
    const onTransition = vi.fn();
    initConnectionMirror(onTransition);
    expect(isBranchKitConnected()).toBe(false);
    expect(onTransition).not.toHaveBeenCalled();
  });

  it('boot read of true fires a single transition', async () => {
    const onTransition = vi.fn();
    initConnectionMirror(onTransition);
    resolveGet({ branchkitConnected: true });
    await getPromise;
    expect(isBranchKitConnected()).toBe(true);
    expect(onTransition).toHaveBeenCalledTimes(1);
    expect(onTransition).toHaveBeenCalledWith(true);
  });

  it('boot read of false (or missing key) stays silent — no false→false callback', async () => {
    const onTransition = vi.fn();
    initConnectionMirror(onTransition);
    resolveGet({});
    await getPromise;
    expect(isBranchKitConnected()).toBe(false);
    expect(onTransition).not.toHaveBeenCalled();
  });

  it('fires only on real edges, not same-value writes', async () => {
    const onTransition = vi.fn();
    initConnectionMirror(onTransition);
    resolveGet({});
    await getPromise;

    fireChange(true);
    fireChange(true); // SW re-writes true on every reconnect — must not re-fire
    fireChange(false);
    fireChange(false);

    expect(onTransition.mock.calls).toEqual([[true], [false]]);
    expect(isBranchKitConnected()).toBe(false);
  });

  it('a stale boot read must not overwrite a newer live change', async () => {
    // The disconnect edge lands while the boot get() is still in flight
    // (storage reads resolve async): the read's snapshot says true, but the
    // live value is already false.
    const onTransition = vi.fn();
    initConnectionMirror(onTransition);
    fireChange(true);
    fireChange(false);
    resolveGet({ branchkitConnected: true });
    await getPromise;
    expect(isBranchKitConnected()).toBe(false);
    expect(onTransition.mock.calls).toEqual([[true], [false]]);
  });

  it('ignores non-local areas and unrelated keys', async () => {
    const onTransition = vi.fn();
    initConnectionMirror(onTransition);
    resolveGet({});
    await getPromise;
    fireChange(true, 'sync');
    for (const l of changeListeners) l({ alphabet: { newValue: ['arch'] } }, 'local');
    expect(isBranchKitConnected()).toBe(false);
    expect(onTransition).not.toHaveBeenCalled();
  });
});
