/**
 * BranchKit Browser — debug-snapshot.ts unit tests.
 *
 * Covers the pure pieces: snapshot id generation (format must match the
 * plugin-side validator), orphan detection, and the wrapper-id discovery
 * step that captureDebugSnapshot uses to seed orphan detection. Full
 * end-to-end (DOM walk + chrome.runtime.sendMessage) is exercised
 * manually via Ctrl+Alt+D in a real tab; see the Phase 2b verification
 * notes.
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ElementWrapper, WrapperStore } from './element-wrapper';
import * as idRegistry from './registry';
import { ScannedElement, Category } from './types';
import {
  buildSnapshotPayload,
  findOrphans,
  generateSnapshotId,
} from './debug-snapshot';
import { _resetActivatePathBufferForTesting } from './activate-path-log';

// --- helpers ---------------------------------------------------------------

function makeScanned(id: number): ScannedElement {
  return {
    label: `el-${id}`,
    id,
    category: 'click' as Category,
    type: 'button',
    adapter: null,
    codeword: `cw-${id}`,
  };
}

function fakeElement(label = ''): Element {
  // Happy-dom is configured in vitest.config.ts, so real Element APIs
  // (getBoundingClientRect, closest, querySelector for accessible-name)
  // work. Each call returns a fresh button — identity matters to the
  // WrapperStore's Map index, AND distinct text content matters to
  // registry.register's fingerprint-collision check (two identical
  // buttons mint the same id, defeating the orphan test).
  const btn = document.createElement('button');
  if (label) btn.textContent = label;
  return btn;
}

describe('generateSnapshotId', () => {
  it('produces filesystem-safe id with colons + dots replaced by dashes', () => {
    const now = new Date(Date.UTC(2026, 4, 20, 19, 30, 45, 123));
    const id = generateSnapshotId(now);
    expect(id).toBe('2026-05-20T19-30-45-123Z');
  });

  it('contains no chars rejected by the plugin-side validator regex', () => {
    const id = generateSnapshotId(new Date());
    // Plugin validator: ^[a-zA-Z0-9._-]+$ (see plugins/browser/src/debug_snapshot.go)
    expect(id).toMatch(/^[a-zA-Z0-9._-]+$/);
    expect(id).not.toMatch(/[:.]/);
  });

  it('produces unique-enough ids within typical ms granularity', () => {
    const ids = new Set<string>();
    let now = Date.UTC(2026, 0, 1, 0, 0, 0, 0);
    for (let i = 0; i < 100; i++) {
      ids.add(generateSnapshotId(new Date(now + i)));
    }
    expect(ids.size).toBe(100);
  });
});

describe('findOrphans', () => {
  beforeEach(() => {
    idRegistry.clear();
    _resetActivatePathBufferForTesting();
  });

  it('returns empty when every known id is in the store', () => {
    const store = new WrapperStore();
    const el1 = fakeElement('live one');
    const el2 = fakeElement('orphan two');
    const w1 = new ElementWrapper(el1, makeScanned(1));
    const w2 = new ElementWrapper(el2, makeScanned(2));
    store.addWrapper(w1);
    store.addWrapper(w2);
    // Mint registry entries for both so registry.get() returns non-undefined.
    idRegistry.register(w1);
    idRegistry.register(w2);

    const orphans = findOrphans(store, [w1.scanned.id, w2.scanned.id]);
    expect(orphans).toEqual([]);
  });

  it('surfaces ids known to registry but not held by any wrapper', () => {
    const store = new WrapperStore();
    // Distinct text content so register's fingerprint-collision check
    // doesn't reject the second registration (returning 0).
    const el1 = fakeElement('live one');
    const w1 = new ElementWrapper(el1, makeScanned(1));
    store.addWrapper(w1);
    const liveId = idRegistry.register(w1);
    expect(liveId).toBeGreaterThan(0);

    // Mint a second registry entry then "detach" by NOT adding the wrapper
    // to the store. Mirrors the "wrapper destroyed but registry still
    // remembers" failure mode.
    const el2 = fakeElement('orphan two');
    const orphanWrapper = new ElementWrapper(el2, makeScanned(2));
    const orphanId = idRegistry.register(orphanWrapper);
    expect(orphanId).toBeGreaterThan(0);
    expect(orphanId).not.toBe(liveId);

    const orphans = findOrphans(store, [liveId, orphanId]);
    expect(orphans.length).toBe(1);
    expect(orphans[0].registryId).toBe(orphanId);
    expect(orphans[0].fingerprint).not.toBeNull();
  });

  it('ignores ids the registry no longer knows about', () => {
    const store = new WrapperStore();
    // 999 was never registered — findOrphans should skip it, not crash.
    const orphans = findOrphans(store, [999]);
    expect(orphans).toEqual([]);
  });
});

describe('buildSnapshotPayload', () => {
  beforeEach(() => {
    idRegistry.clear();
    _resetActivatePathBufferForTesting();
  });

  it('returns the locked envelope fields with the supplied frame_url', () => {
    const store = new WrapperStore();
    const payload = buildSnapshotPayload({
      store,
      knownRegistryIds: [],
      frameUrl: 'https://example.com/page',
      now: new Date(Date.UTC(2026, 0, 2, 12, 0, 0, 0)),
    });
    expect(payload.snapshot_id).toBe('2026-01-02T12-00-00-000Z');
    expect(payload.taken_at).toBe('2026-01-02T12:00:00.000Z');
    expect(payload.frame_url).toBe('https://example.com/page');
    expect(payload.wrappers).toEqual([]);
    expect(payload.almost_hintable).toEqual([]);
    expect(payload.orphans).toEqual([]);
    expect(payload.recent_activations).toEqual([]);
  });

  it('embeds wrappers from the store with scanned metadata + viewport flag', () => {
    const store = new WrapperStore();
    const w = new ElementWrapper(fakeElement(), makeScanned(7));
    store.addWrapper(w);

    const payload = buildSnapshotPayload({
      store,
      knownRegistryIds: [7],
      frameUrl: 'about:blank',
    });
    expect(payload.wrappers.length).toBe(1);
    expect(payload.wrappers[0].scanned.id).toBe(7);
    expect(payload.wrappers[0].scanned.codeword).toBe('cw-7');
    // Default isInViewport is true (per ElementWrapper constructor).
    expect(payload.wrappers[0].isInViewport).toBe(true);
    // No hint attached → null.
    expect(payload.wrappers[0].hint).toBeNull();
  });
});
