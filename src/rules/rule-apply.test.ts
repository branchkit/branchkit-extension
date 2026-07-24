/**
 * BranchKit Browser — rule-apply unit tests.
 *
 * Pins the rule-application semantics over the real domain-rules compiler
 * with faked store/placement/render collaborators: badge-size changes detach
 * every wrapper exactly when the resolved size changes, the preview nudge is
 * prepended (first-match-wins) and evaporates on clear, and
 * applyUserRuleToScan's exclusion filter + full-document dedup behave.
 *
 * Run: npm test
 */

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DomainRule, RuleEntry } from './domain-rules';

type RuleApply = typeof import('./rule-apply');

const detachWrapper = vi.fn();
const placeBadges = vi.fn();
const setRuleNudges = vi.fn();
const setBadgeSizeOverridePx = vi.fn();
const wrappers: Array<{ element: Element; hint: unknown; cachedRuleNudge?: unknown }> = [];

async function loadRuleApply(): Promise<RuleApply> {
  vi.resetModules();
  vi.doMock('../core/store', () => ({ store: { get all() { return wrappers; } } }));
  vi.doMock('../core/wrapper-lifecycle', () => ({ detachWrapper }));
  vi.doMock('../placement', () => ({ placeBadges, setRuleNudges }));
  vi.doMock('../render/hints', () => ({ setBadgeSizeOverridePx }));
  return await import('./rule-apply');
}

function rule(entries: RuleEntry[], badgeSizePx?: number): DomainRule {
  return { pattern: '*.example.com', entries, ...(badgeSizePx ? { badgeSizePx } : {}) } as unknown as DomainRule;
}

beforeEach(() => {
  vi.clearAllMocks();
  wrappers.length = 0;
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.doUnmock('../core/store');
  vi.doUnmock('../core/wrapper-lifecycle');
  vi.doUnmock('../placement');
  vi.doUnmock('../render/hints');
});

describe('applyMatchedRules / badge size', () => {
  it('a size change sets the override and detaches every wrapper', async () => {
    const ra = await loadRuleApply();
    const el = document.createElement('a');
    wrappers.push({ element: el, hint: null });
    ra.applyMatchedRules([rule([], 14)]);
    expect(setBadgeSizeOverridePx).toHaveBeenCalledWith(14);
    expect(detachWrapper).toHaveBeenCalledWith(el);
  });

  it('an unchanged size does not detach', async () => {
    const ra = await loadRuleApply();
    wrappers.push({ element: document.createElement('a'), hint: null });
    ra.applyMatchedRules([rule([], 14)]);
    detachWrapper.mockClear();
    ra.applyMatchedRules([rule([{ id: 'x', kind: 'exclude', matcher: { type: 'css', selector: '.x' } } as RuleEntry], 14)]);
    expect(detachWrapper).not.toHaveBeenCalled();
  });

  it('clearing all rules resets the compiled state (and drops the size back)', async () => {
    const ra = await loadRuleApply();
    ra.applyMatchedRules([rule([], 14)]);
    ra.applyMatchedRules([]);
    expect(ra.getCompiledRule()).toBeNull();
    expect(setBadgeSizeOverridePx).toHaveBeenLastCalledWith(null);
    expect(ra.getExcludes()).toEqual([]);
  });
});

describe('preview nudge', () => {
  it('prepends the preview entry so first-match-wins makes it authoritative', async () => {
    const ra = await loadRuleApply();
    const compiled: RuleEntry = { id: 'n1', kind: 'nudge', matcher: { type: 'css', selector: 'a' }, nudge: { dx: 1, dy: 1 } } as RuleEntry;
    ra.applyMatchedRules([rule([compiled])]);
    const preview: RuleEntry = { id: '_nudge_preview', kind: 'nudge', matcher: { type: 'css', selector: 'a' }, nudge: { dx: 9, dy: 9 } } as RuleEntry;
    ra.setPreviewNudge(preview);
    const calls = setRuleNudges.mock.calls;
    const applied = calls[calls.length - 1][0] as RuleEntry[];
    expect(applied[0].id).toBe('_nudge_preview');
    expect(applied).toHaveLength(2);
    expect(ra.hasPreviewNudge()).toBe(true);
  });

  it('clearing the preview restores the compiled set and invalidates wrapper caches', async () => {
    const ra = await loadRuleApply();
    wrappers.push({ element: document.createElement('a'), hint: {}, cachedRuleNudge: { dx: 9, dy: 9 } });
    ra.setPreviewNudge({ id: '_nudge_preview', kind: 'nudge', matcher: { type: 'css', selector: 'a' }, nudge: { dx: 9, dy: 9 } } as RuleEntry);
    ra.setPreviewNudge(null);
    expect(ra.hasPreviewNudge()).toBe(false);
    expect(setRuleNudges.mock.calls[setRuleNudges.mock.calls.length - 1][0]).toEqual([]);
    expect(wrappers[0].cachedRuleNudge).toBeUndefined();
    expect(placeBadges).toHaveBeenCalled(); // hinted wrappers re-placed
  });
});

describe('applyUserRuleToScan', () => {
  it('is a no-op without an active rule', async () => {
    const ra = await loadRuleApply();
    const el = document.createElement('a');
    const result = { refs: [el], elements: [{ codeword: '' }] as never[] };
    ra.applyUserRuleToScan(result, document);
    expect(result.refs).toHaveLength(1);
  });

  it('drops refs matching an exclude entry', async () => {
    const ra = await loadRuleApply();
    ra.applyMatchedRules([rule([{ id: 'x', kind: 'exclude', matcher: { type: 'css', selector: '.ad' } } as RuleEntry])]);
    const keep = document.createElement('a');
    const drop = document.createElement('a');
    drop.className = 'ad';
    document.body.append(keep, drop);
    const result = { refs: [keep, drop], elements: [{ codeword: 'a' }, { codeword: 'b' }] as never[] };
    ra.applyUserRuleToScan(result, document);
    expect(result.refs).toEqual([keep]);
    expect(result.elements).toHaveLength(1);
  });
});
