/**
 * BranchKit Browser — per-domain rule application (content side).
 *
 * Owns the frame's compiled-rule state and everything that applies it: badge
 * size overrides, nudge offsets (including the popup's ephemeral authoring
 * preview), reveal stylesheets, and the exclusion/inclusion filter for scan
 * results. The WIRING (storage load/change subscriptions, the nudge-preview
 * port) stays in content.ts — it owns when rules change; this module owns
 * what a change does. Lifted per notes/DESIGN_RESTRUCTURE_ROUND3.md.
 *
 * One deliberate seam change from the monolith version: applyRuleBadgeSize no
 * longer calls scheduleDoScan itself — both applyMatchedRules call sites (the
 * storage load and the change subscription) already schedule a rescan on any
 * path where the size can change, so the inner call was always coalesced away.
 * The detach-all invalidation stays here (size feeds badge dimension/placement
 * caches — a re-place alone is insufficient).
 */

import { ScannedElement } from '../types';
import {
  CompiledRule, DomainRule, RuleEntry,
  compileRules, applyExclusions, collectInclusions, injectRevealStyles,
} from './domain-rules';
import { store } from '../core/store';
import { detachWrapper } from '../core/wrapper-lifecycle';
import { placeBadges, setRuleNudges } from '../placement';
import { setBadgeSizeOverridePx } from '../render/hints';

// Loaded asynchronously from chrome.storage.sync at startup; the initial
// doScan() runs BEFORE the storage read returns, so the first frame may
// render without user rules applied — the storage callback triggers a second
// doScan once the rule is known.
// See notes/completed/DESIGN_PER_DOMAIN_HINT_RULES.md "Timing".
let compiledRule: CompiledRule | null = null;

export function getCompiledRule(): CompiledRule | null {
  return compiledRule;
}

export function getExcludes(): readonly RuleEntry[] {
  return compiledRule?.excludes ?? [];
}

export function applyMatchedRules(matched: DomainRule[]): void {
  // Sweep any prior reveal stylesheet — covers both our previous match
  // and orphan nodes left by an earlier content-script generation
  // (extension reload re-injects JS but leaves the DOM).
  for (const old of document.querySelectorAll('style[data-branchkit-reveal]')) {
    old.remove();
  }
  if (matched.length === 0) {
    compiledRule = null;
    applyRuleBadgeSize();
    applyNudgeSet();
    return;
  }
  compiledRule = compileRules(matched);
  applyRuleBadgeSize();
  applyNudgeSet();
  const style = injectRevealStyles(compiledRule.reveals);
  if (style && document.head) document.head.appendChild(style);
}

// The per-site badge-size override applied to this frame, resolved from
// the compiled rule set. Tracked so a rule edit that changes the resolved
// size takes the same rebuild path as a badge-appearance settings change:
// size feeds badge dimensions/colors/placement caches, so a re-place
// alone is insufficient — detach everything and let the caller's scheduled
// doScan rebuild. Runs BEFORE applyNudgeSet in applyMatchedRules so a size
// change doesn't waste a placement pass on wrappers about to be detached.
let appliedRuleBadgeSizePx: number | null = null;

function applyRuleBadgeSize(): void {
  const next = compiledRule?.badgeSizePx ?? null;
  if (next === appliedRuleBadgeSizePx) return;
  appliedRuleBadgeSizePx = next;
  setBadgeSizeOverridePx(next);
  for (const w of [...store.all]) detachWrapper(w.element);
}

// Wrapper-cached nudge offsets are resolved against the compiled rule set;
// a rule change invalidates every one of them. The subsequent doScan's
// placement pass re-resolves lazily.
function clearRuleNudgeCaches(): void {
  for (const w of store.all) w.cachedRuleNudge = undefined;
}

// --- Nudge preview (popup authoring) ---
//
// While the popup's add form authors a nudge entry, the offset applies to
// the page EPHEMERALLY so the user tunes against the live badge instead of
// blind-typing values and clicking Add to see them. Nothing persists: the
// preview entry is prepended to the compiled set (first-match-wins makes it
// authoritative while present) and evaporates when the popup clears it,
// switches kinds, or closes — the port's disconnect covers close/crash.
let previewNudge: RuleEntry | null = null;

/** Install (or clear, with null) the popup's ephemeral preview entry and
 * re-place against the live rule set. */
export function setPreviewNudge(entry: RuleEntry | null): void {
  previewNudge = entry;
  applyNudgeSet();
}

export function hasPreviewNudge(): boolean {
  return previewNudge !== null;
}

export function applyNudgeSet(): void {
  const compiled = compiledRule?.nudges ?? [];
  setRuleNudges(previewNudge ? [previewNudge, ...compiled] : compiled);
  clearRuleNudgeCaches();
  placeBadges([...store.all].filter((w) => w.hint));
}

// Apply the current compiled rule's exclusions + inclusions to a scan
// result. Mutates result in place. Used by both doScan (full document)
// and discoverInSubtree (added subtree). Cheap no-op when no rule is
// active — the only added cost is one branch.
export function applyUserRuleToScan(
  result: { refs: Element[]; elements: ScannedElement[] },
  root: ParentNode,
): void {
  const cr = compiledRule;
  if (!cr) return;
  if (cr.excludes.length > 0) applyExclusions(result.refs, result.elements, cr.excludes);
  if (!cr.includeSelector) return;

  // Subtree scans only need to dedupe within this scan — added subtrees
  // don't overlap with existing wrappers (those are by definition NOT
  // in the just-added subtree). Skip the O(store.all) walk for them.
  const seen = new Set<Element>(result.refs);
  if (root === document) {
    for (const w of store.all) seen.add(w.element);
  }
  const extra = collectInclusions(seen, cr.includeSelector, root);
  result.refs.push(...extra.refs);
  result.elements.push(...extra.elements);
}
