/**
 * BranchKit Browser — mutation-source routing tests.
 *
 * The observer firehose is observer/rAF-driven (integration territory), but its
 * routing decision — added Element → discovery queue, own badge mutations
 * filtered out — is deterministic. These pin that routing via processMutations
 * against a fake PageSession; the drain/walk timing is covered by the harness.
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { pageSession, type PageSessionDeps } from '../lifecycle/page-session';
import { processMutations, teardownMutationSource } from './mutation-source';

function childListRecord(added: Node[] = [], removed: Node[] = []): MutationRecord {
  return { type: 'childList', addedNodes: added, removedNodes: removed } as unknown as MutationRecord;
}

// The mutation source reads the pageSession singleton directly (Tier 3 — the
// initMutationSource seam is gone); reset the session state it touches and
// install stub deps per test.
const session = pageSession;

beforeEach(() => {
  vi.useFakeTimers(); // neutralize the yield-fallback timeout the discovery scheduler arms
  // firehoseStep posts a breadcrumb via chrome.runtime.sendMessage; stub it.
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { sendMessage: vi.fn(() => Promise.resolve()) },
  };
  session.pendingDiscoveryRoots.clear();
  session.discoveryScheduled = false;
  session.hugeMutationTimer = null;
  session.badgesVisible = false;
  session.pendingMutation = false;
  session.deps = {
    discoverInSubtree: vi.fn(() => 0),
    discoverInSubtreeBatched: vi.fn(async () => 0),
    reevaluateAttribute: vi.fn(() => false),
    scheduleReposition: vi.fn(),
    scheduleDeferredReposition: vi.fn(),
  } as unknown as PageSessionDeps;
});

afterEach(() => {
  teardownMutationSource();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('processMutations routing', () => {
  it('queues an added foreign element for discovery', () => {
    const el = document.createElement('div');
    processMutations([childListRecord([el])]);
    expect(session.pendingDiscoveryRoots.has(el)).toBe(true);
  });

  it('ignores our own badge mutations (data-branchkit-hint)', () => {
    const ownBadge = document.createElement('div');
    ownBadge.setAttribute('data-branchkit-hint', '');
    processMutations([childListRecord([ownBadge])]);
    expect(session.pendingDiscoveryRoots.has(ownBadge)).toBe(false);
    expect(session.pendingDiscoveryRoots.size).toBe(0);
  });

  it('does not queue non-element added nodes (e.g. text)', () => {
    const text = document.createTextNode('hello');
    processMutations([childListRecord([text])]);
    expect(session.pendingDiscoveryRoots.size).toBe(0);
  });
});

describe('teardownMutationSource', () => {
  it('is idempotent', () => {
    expect(() => {
      teardownMutationSource();
      teardownMutationSource();
    }).not.toThrow();
  });
});
