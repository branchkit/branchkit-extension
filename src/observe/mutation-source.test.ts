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
import {
  processMutations, teardownMutationSource,
  constructPageMutationObserver, attachPageMutationObserver, observeShadowRootForMutations,
} from './mutation-source';
import { deepQuerySelectorAll, setShadowRootSightingHook } from '../scan/scanner';

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

describe('shadow-root observation (observeShadowRootForMutations)', () => {
  // Pin OUR registration logic (guards, dedup, lifecycle) via an observe()
  // spy — record delivery for shadow-root targets is engine territory the
  // happy-dom env can't be trusted to model.
  let observeSpy: ReturnType<typeof vi.spyOn>;

  function makeOpenShadowHost(): { host: HTMLElement; root: ShadowRoot } {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    return { host, root };
  }

  beforeEach(() => {
    constructPageMutationObserver();
    observeSpy = vi.spyOn(MutationObserver.prototype, 'observe');
    attachPageMutationObserver();
  });

  afterEach(() => {
    observeSpy.mockRestore();
    setShadowRootSightingHook(null);
    document.body.innerHTML = '';
  });

  it('registers a sighted root with the page-observation options', () => {
    const { root } = makeOpenShadowHost();
    observeShadowRootForMutations(root);
    const call = observeSpy.mock.calls.find(([target]) => target === root);
    expect(call).toBeDefined();
    const options = call?.[1] as MutationObserverInit;
    expect(options.childList).toBe(true);
    expect(options.subtree).toBe(true);
    expect(options.attributes).toBe(true);
    expect(options.attributeFilter).toContain('href');
  });

  it('registers each root once (WeakSet dedup)', () => {
    const { root } = makeOpenShadowHost();
    observeShadowRootForMutations(root);
    observeShadowRootForMutations(root);
    expect(observeSpy.mock.calls.filter(([target]) => target === root)).toHaveLength(1);
  });

  it('skips our own UI roots (host carries data-branchkit-hint)', () => {
    const { host, root } = makeOpenShadowHost();
    host.setAttribute('data-branchkit-hint', '');
    observeShadowRootForMutations(root);
    expect(observeSpy.mock.calls.some(([target]) => target === root)).toBe(false);
  });

  it('is a no-op after teardown and resumes after re-attach (fresh dedup set)', () => {
    const { root } = makeOpenShadowHost();
    teardownMutationSource();
    observeShadowRootForMutations(root);
    expect(observeSpy.mock.calls.some(([target]) => target === root)).toBe(false);
    attachPageMutationObserver();
    observeShadowRootForMutations(root);
    expect(observeSpy.mock.calls.filter(([target]) => target === root)).toHaveLength(1);
  });

  it('is sighted by the scanner walk (hook wired at construction)', () => {
    const { root } = makeOpenShadowHost();
    const link = document.createElement('a');
    link.setAttribute('href', '/x');
    root.appendChild(link);
    deepQuerySelectorAll(document.body, 'a[href]');
    expect(observeSpy.mock.calls.some(([target]) => target === root)).toBe(true);
  });
});
