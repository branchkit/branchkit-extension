/**
 * BranchKit Browser — DOM element scanning.
 *
 * Selectors from DESIGN_BROWSER_EXTENSION.md section 1.
 * buildSelector adapted from basetypes-extension.
 */

import { Category, ScannedElement } from '../types';
import { accessibleName } from './accessible-name';
import { peekCachedRect, peekCachedStyle, cacheVisibility, clearLayoutCache } from '../layout-cache';

// Core selectors — always scanned
const HINTABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([type="hidden"])',
  'textarea', 'select', 'summary', 'label',
  '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]',
  '[role="option"]', '[role="checkbox"]', '[role="radio"]',
  '[contenteditable="true"]', '[contenteditable=""]',
  '[tabindex]:not([tabindex="-1"])',
];

// Exclude selectors
const EXCLUDE = [
  '[aria-hidden="true"]', '[disabled]', '[inert]',
];

const HINTABLE_SELECTOR = HINTABLE.join(', ');
const EXCLUDE_SELECTOR = EXCLUDE.join(', ');

// Aggressive-hints opt-in: extra container tags (divs, spans, list items,
// table cells, headings) that aren't natively interactive but commonly
// host click handlers in SPAs. Direct port of Rango's `extraSelector` —
// they only become hintable if they ALSO look interactive (see
// `isHintableExtra` below). Gmail's email-row click area, Slack message
// hover actions, GitHub's role-less buttons, etc. fall in this set.
const EXTRA_TAGS = 'div, span, i, li, td, p, h1, h2, h3, h4, h5, h6';
const EXTRA_SELECTOR = `${HINTABLE_SELECTOR}, ${EXTRA_TAGS}`;

// Heuristic match for "this container is probably clickable" — matches
// Rango's isHintableExtra. Selector match for common JS framework class
// patterns + `[jsaction]` (Google's everything-uses-this attribute).
const EXTRA_CLICKABLE_SELECTOR =
  '[class*="button" i], [class*="btn" i], [class*="select" i], [class*="control" i], [jsaction]';

let extraHintsEnabled = false;

/**
 * Toggle the "extra hints" mode on/off. Persisted by the caller; this
 * just controls scan-time selector behavior. Calling this does NOT
 * re-scan — the caller (content.ts) should trigger a rescan.
 */
export function setExtraHintsEnabled(on: boolean): void {
  extraHintsEnabled = on;
}

export function getExtraHintsEnabled(): boolean {
  return extraHintsEnabled;
}

function isHintableExtra(el: Element): boolean {
  if (!el.matches(EXTRA_SELECTOR)) return false;
  // Cheap match-based check first — avoids the getComputedStyle round
  // trip for the common case.
  if (el.matches(EXTRA_CLICKABLE_SELECTOR)) return true;
  let style = peekCachedStyle(el);
  if (style === null) {
    style = getComputedStyle(el);
    perfCounters.computedStyleCalls++;
  }
  const cursor = style.cursor;
  return cursor === 'pointer' || cursor === 'text';
}

// --- Perf instrumentation ---
// Counters incremented during scan + hintability checks. Exposed via
// `window.branchkitPerfStats()` so a soak on a real page can answer
// "is aggressive mode making us pay 5000 getComputedStyle calls per
// scan?". The counters are absolute; consumers snapshot + diff to
// measure a span of activity.

export interface PerfCounters {
  scanCalls: number;                 // collectHintables (full subtree scan)
  scanTotalMs: number;
  scanCandidatesSeen: number;        // total .matches(scanSelector) hits
  scanKeptAsHintable: number;        // survived all filters
  scanRejectedExclude: number;
  scanRejectedInvisible: number;
  scanRejectedRedundant: number;
  scanRejectedExtraNotClickable: number;
  scanSkippedKnown: number;          // already-tracked, skipped before any layout read
  scanSingleCalls: number;           // scanSingle (per-element re-check via MO)
  isHintableExtraCalls: number;
  computedStyleCalls: number;        // total getComputedStyle calls (all sites)
  boundingRectCalls: number;         // total getBoundingClientRect (forces layout)
  shadowHostPrunedSubtrees: number;  // opaque subtrees (svg/canvas/…) skipped in shadow-host walk
}

const perfCounters: PerfCounters = {
  scanCalls: 0,
  scanTotalMs: 0,
  scanCandidatesSeen: 0,
  scanKeptAsHintable: 0,
  scanRejectedExclude: 0,
  scanRejectedInvisible: 0,
  scanRejectedRedundant: 0,
  scanRejectedExtraNotClickable: 0,
  scanSkippedKnown: 0,
  scanSingleCalls: 0,
  isHintableExtraCalls: 0,
  computedStyleCalls: 0,
  boundingRectCalls: 0,
  shadowHostPrunedSubtrees: 0,
};

export function getPerfCounters(): PerfCounters {
  return { ...perfCounters };
}

export function resetPerfCounters(): void {
  for (const k of Object.keys(perfCounters) as Array<keyof PerfCounters>) {
    perfCounters[k] = 0;
  }
}

// Standard HTML elements that CANNOT host shadow DOM (attachShadow throws).
// Used as a pre-filter for shadow-host detection: skip the `.shadowRoot`
// lookup only for these. The spec-permitted built-in hosts (div, span, p,
// h1-h6, section, article, aside, header, footer, main, nav, blockquote,
// body) and hyphenated custom elements are all checked — declarative shadow
// DOM lands on plain sectioning tags in the wild, and a host skipped here is
// a subtree the hint walk can never see. The check replaced is a plain
// property read (no layout), so the strictly spec-shaped list costs
// microseconds per walk. (Was Rango's wider "doesn't host in practice" list,
// which silently skipped span/section/etc hosts.)
const COMMON_LEAF_TAGS = new Set([
  'a', 'abbr', 'address', 'area', 'audio', 'b', 'base',
  'bdi', 'bdo', 'br', 'button', 'canvas', 'caption',
  'cite', 'code', 'col', 'colgroup', 'data', 'datalist', 'dd', 'del',
  'details', 'dfn', 'dialog', 'dl', 'dt', 'em', 'embed', 'fieldset',
  'figcaption', 'figure', 'form',
  'head', 'hgroup', 'hr', 'html', 'i', 'iframe', 'img',
  'input', 'ins', 'kbd', 'label', 'legend', 'li', 'link', 'map',
  'mark', 'menu', 'meta', 'meter', 'noscript', 'object', 'ol',
  'optgroup', 'option', 'output', 'picture', 'pre', 'progress', 'q',
  'rp', 'rt', 'ruby', 's', 'samp', 'script', 'select', 'slot',
  'small', 'source', 'strong', 'style', 'sub', 'summary', 'sup',
  'svg', 'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th',
  'thead', 'time', 'title', 'tr', 'track', 'u', 'ul', 'var', 'video', 'wbr',
]);

// Opaque-content roots that can hold a deep light-DOM subtree (an <svg>
// icon is hundreds of <path>/<g> nodes; MathML is similar) yet never host a
// custom-element shadow root. The shadow-host walk REJECTs their whole
// subtree — A2 skip-unhintable-subtree. The native hintable-selector pass is
// unaffected (it never matched inside these tags anyway), so light-DOM
// hintables in an SVG <foreignObject> are still found; only the
// vanishingly-rare shadow-host-inside-opaque case is skipped.
const OPAQUE_SUBTREE_TAGS = new Set([
  'svg', 'math', 'canvas', 'video', 'audio', 'picture', 'iframe',
]);

function findShadowHosts(root: ParentNode): Element[] {
  const hosts: Element[] = [];
  // The TreeWalker below only visits descendants. When `root` itself is a
  // custom-element host (the case fired by the SHADOW_EVENT listener in
  // content.ts on attachShadow), we'd miss its shadow root entirely.
  if (root instanceof Element && !COMMON_LEAF_TAGS.has(root.tagName.toLowerCase()) && root.shadowRoot) {
    hosts.push(root);
  }
  // A TreeWalker (vs querySelectorAll('*')) lets us FILTER_REJECT opaque
  // subtrees so their descendants are never visited — on media-heavy pages
  // that skips the bulk of the elements the '*' enumeration used to touch.
  const isDoc = root.nodeType === Node.DOCUMENT_NODE;
  const doc = isDoc ? (root as Document) : root.ownerDocument;
  if (!doc) return hosts;
  const walkRoot: Node = isDoc ? ((root as Document).documentElement ?? root) : root;
  const walker = doc.createTreeWalker(walkRoot, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      if (OPAQUE_SUBTREE_TAGS.has((node as Element).tagName.toLowerCase())) {
        perfCounters.shadowHostPrunedSubtrees++;
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node as Element;
    if (COMMON_LEAF_TAGS.has(el.tagName.toLowerCase())) continue;
    if (el.shadowRoot) hosts.push(el);
  }
  return hosts;
}

/**
 * Pierces open shadow roots. Closed shadow roots return null from
 * .shadowRoot and are silently skipped — the host element is the
 * deepest visible target.
 */
export function deepQuerySelectorAll(root: ParentNode, selector: string): Element[] {
  const out = Array.from(root.querySelectorAll(selector));
  // querySelectorAll excludes the root. When MutationObserver fires for a
  // single hintable leaf added to body (e.g. <button> inserted directly),
  // discoverInSubtree's `root` IS the button — we'd miss it. Include
  // matching root explicitly. (Document doesn't have `matches`, so guard
  // on Element first.)
  if (root instanceof Element && root.matches(selector)) {
    out.unshift(root);
  }
  for (const host of findShadowHosts(root)) {
    if (host.shadowRoot) {
      out.push(...deepQuerySelectorAll(host.shadowRoot, selector));
    }
  }
  return out;
}

/**
 * Cheap light-DOM pre-filter for the childList discovery path. Returns
 * false when `root`'s light DOM contains nothing the scanner could turn
 * into a hint, letting the caller skip the full `discoverInSubtree` walk
 * (deep shadow pierce + limbo rebind + custom-element watch).
 *
 * Light-DOM only by design: shadow-hosted hintables are discovered via
 * the SHADOW_EVENT attach path (see content.ts), so the childList path
 * doesn't need to pierce shadow to stay correct. This is a single native
 * matches()+querySelector() that bails at the first hit — far cheaper
 * than the full pipeline for the YouTube /watch case, where almost no
 * mutation root yields a hintable.
 */
export function subtreeMaybeHintable(root: Element): boolean {
  const sel = extraHintsEnabled ? EXTRA_SELECTOR : HINTABLE_SELECTOR;
  return root.matches(sel) || root.querySelector(sel) !== null;
}

/**
 * Classify an element into a voice category.
 */
export function classifyCategory(el: Element): Category {
  const tag = el.tagName;
  const role = el.getAttribute('role');

  // Inputs / form fields
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
      role === 'textbox' || el.getAttribute('contenteditable') === 'true' ||
      el.getAttribute('contenteditable') === '') {
    return 'input';
  }

  // Tabs
  if (role === 'tab' || role === 'menuitem') return 'tab';

  // Links
  if (tag === 'A') return 'link';

  // Buttons
  if (tag === 'BUTTON' || role === 'button' || role === 'checkbox' || role === 'radio') {
    return 'button';
  }

  // Default to button for anything interactive
  return 'button';
}

// Per-scan cache of ancestors already proven to have non-zero opacity.
// Reduces isVisible's opacity-ancestor walk from O(depth) per element to
// amortized O(1) for siblings within the same scan. Reset to null at scan
// end so we can't leak references into the next scan (ancestor's opacity
// may have changed between scans, and WeakSet has no API to drop entries).
let visibilityCache: WeakSet<Element> | null = null;

export function isVisible(el: Element): boolean {
  // Peek the layout-cache first. Hit = cheap; miss = live read +
  // counter bump. The cache is populated by the rAF-coalesced
  // attribute drain so a batch of same-tree mutations shares the
  // ancestor walk reads.
  let rect = peekCachedRect(el);
  if (rect === null) {
    rect = el.getBoundingClientRect();
    perfCounters.boundingRectCalls++;
  }
  let style = peekCachedStyle(el);
  if (style === null) {
    style = getComputedStyle(el);
    perfCounters.computedStyleCalls++;
  }

  if (style.visibility === 'hidden' || rect.width < 5 || rect.height < 5 || style.opacity === '0') {
    if (el instanceof HTMLInputElement &&
        (el.type === 'checkbox' || el.type === 'radio') &&
        el.parentElement && isVisible(el.parentElement)) {
      return true;
    }
    return false;
  }

  // Walk ancestors checking for opacity:0. Hit the cache first — the
  // first descendant of an ancestor chain pays the full walk, every
  // subsequent descendant within the same scan short-circuits the
  // moment it hits a cached ancestor.
  const chain: Element[] = [];
  let current = el.parentElement;
  while (current) {
    if (visibilityCache && visibilityCache.has(current)) break;
    let parentStyle = peekCachedStyle(current);
    if (parentStyle === null) {
      parentStyle = getComputedStyle(current);
      perfCounters.computedStyleCalls++;
    }
    if (parentStyle.opacity === '0') return false;
    chain.push(current);
    current = current.parentElement;
  }
  // Memoize the chain we just validated for the rest of this scan.
  if (visibilityCache) {
    for (const a of chain) visibilityCache.add(a);
  }

  return true;
}

function isRedundant(el: Element): boolean {
  if (el.parentElement instanceof HTMLLabelElement &&
      el.parentElement.control === el) {
    return false;
  }

  const parent = el.parentElement;
  if (!parent) return false;

  // Wrapped-inside-hintable: standard Rango redundancy filter.
  if (parent.matches(HINTABLE_SELECTOR) && !hasSignificantSiblings(el)) {
    return true;
  }

  // In aggressive mode the wider selector catches nested div/span
  // wrappers whose parent is ALSO an extra hintable (e.g. Gmail's
  // "Select" button → inner decorative span both match). When the
  // inner has no siblings, it's a pure wrapper and the outer is the
  // real target — suppress the inner. When the inner HAS siblings
  // (e.g. a checkbox alongside a star alongside subject text inside
  // a clickable row), the inner IS a distinct target — keep it.
  if (extraHintsEnabled
      && !el.matches(HINTABLE_SELECTOR)
      && isExtraHintableAncestor(parent)
      && !hasSignificantSiblings(el)) {
    return true;
  }

  return false;
}

function isExtraHintableAncestor(el: Element): boolean {
  // Cheap matches first; only fall to getComputedStyle if needed and
  // only for the immediate parent (no walking — keeps O(1) per call).
  if (el.matches(HINTABLE_SELECTOR)) return true;
  if (el.matches(EXTRA_SELECTOR) && isHintableExtra(el)) return true;
  return false;
}

function hasSignificantSiblings(el: Node): boolean {
  if (!el.parentNode) return false;
  if (el.parentNode.childNodes.length > 10) return true;

  return [...el.parentNode.childNodes].some(node =>
    node !== el &&
    ((node instanceof Element && !node.hasAttribute('data-branchkit-hint')) ||
     (node instanceof Text && node.textContent && /\S/.test(node.textContent)))
  );
}

/**
 * Cheap predicate: does this element pass every gate `scanElements` applies?
 * Used by the MutationObserver to recompute hintability when an element's
 * attributes change (e.g. `disabled` toggling) without rebuilding the
 * world. Mirrors the per-element checks in `scanElements`.
 */
export function isHintable(el: Element): boolean {
  if (el.matches(EXCLUDE_SELECTOR)) return false;
  if (el.closest('[data-branchkit-hint]')) return false;
  const matchesCore = el.matches(HINTABLE_SELECTOR);
  if (!matchesCore && !(extraHintsEnabled && isHintableExtra(el))) return false;
  if (!isVisible(el)) return false;
  if (isRedundant(el)) return false;
  return true;
}

/** Reason an element matched `HINTABLE_SELECTOR` but didn't become a
 * wrapper. Used by the debug snapshot to explain "this should have a
 * badge but doesn't" cases — the negative-space signal `BK_ACTIVATE_PATH`
 * can't surface on principle. */
export type AlmostHintableReason = 'EXCLUDE' | 'invisible' | 'redundant';

export interface AlmostHintable {
  el: Element;
  reason: AlmostHintableReason;
}

/** Walk the DOM and surface every element that matched `HINTABLE_SELECTOR`
 * but was rejected by one of `EXCLUDE`/`isVisible`/`isRedundant`. Elements
 * that pass all three are real hintables (handled by `scanElements`); they
 * aren't returned here. Used by the Phase 2 debug snapshot.
 *
 * Skips hint hosts (`[data-branchkit-hint]` descendants) — those are the
 * badges themselves, not page content. */
export function enumerateAlmostHintable(
  root: Document | Element = document,
): AlmostHintable[] {
  const out: AlmostHintable[] = [];
  for (const el of deepQuerySelectorAll(root, HINTABLE_SELECTOR)) {
    if (el.matches(EXCLUDE_SELECTOR)) {
      out.push({ el, reason: 'EXCLUDE' });
      continue;
    }
    if (el.closest('[data-branchkit-hint]')) {
      // Hint badge subtree — neither hintable nor "almost"; just noise.
      continue;
    }
    if (!isVisible(el)) {
      out.push({ el, reason: 'invisible' });
      continue;
    }
    if (isRedundant(el)) {
      out.push({ el, reason: 'redundant' });
      continue;
    }
    // Otherwise this element IS hintable; not almost-hintable.
  }
  return out;
}

/**
 * Build a `ScannedElement` for a single element, or `null` if the element
 * isn't hintable. Same outputs as one iteration of `scanElements`'s loop —
 * exposed so the MutationObserver can produce a wrapper for a freshly
 * inserted node without re-scanning the document.
 */
export function scanSingle(el: Element): ScannedElement | null {
  perfCounters.scanSingleCalls++;
  if (!isHintable(el)) return null;
  return {
    label: getElementLabel(el),
    id: 0, // minted by registry.register during attachWrapper
    category: classifyCategory(el),
    type: el.tagName.toLowerCase(),
    adapter: null,
    codeword: '',
  };
}

/**
 * Scan the DOM for all hintable elements.
 * Returns ScannedElement[] sorted by DOM order.
 */
export function scanElements(
  root: Document | Element = document,
  isKnown?: (el: Element) => boolean,
): { elements: ScannedElement[]; refs: Element[]; invisibleCandidates: Element[] } {
  return collectHintables(root, undefined, isKnown);
}

// Shared DOM walk + filter pipeline. Used by both the eager `scanElements`
// and the batch-yielding `scanInBatches`. Walks `root` once via
// `deepQuerySelectorAll`, filters out excludes / hint hosts / invisible /
// redundant, and returns the surviving (refs, elements) plus an
// invisible-candidate list for the ResizeObserver-driven hintability
// flip path. Same dedup semantics as the original single-pass loop.
//
// `initialSeen` lets the caller pre-mark elements as already-discovered —
// the per-batch doScan uses this so inclusion-rule refs (gathered once
// per scan, see domain-rules.ts:collectInclusions) aren't rediscovered
// by the regular walk.
function collectHintables(
  root: Document | Element,
  initialSeen?: ReadonlySet<Element>,
  isKnown?: (el: Element) => boolean,
): { elements: ScannedElement[]; refs: Element[]; invisibleCandidates: Element[] } {
  const elements: ScannedElement[] = [];
  const refs: Element[] = [];
  const invisibleCandidates: Element[] = [];
  const seen = new Set<Element>(initialSeen);

  const scanStart = performance.now();
  perfCounters.scanCalls++;
  visibilityCache = new WeakSet<Element>();
  const scanSelector = extraHintsEnabled ? EXTRA_SELECTOR : HINTABLE_SELECTOR;

  // Pass 1: cheap, layout-free filters only. Collect survivors so we can
  // batch-warm the layout cache before any getComputedStyle /
  // getBoundingClientRect. Skipping already-tracked elements here is the
  // dominant steady-state win (discovery only needs NEW hintables;
  // visibility/hintability flips are the ResizeObserver/attribute path's
  // job). EXCLUDE and hint-host checks are pure selector matches — no reflow.
  const survivors: Element[] = [];
  for (const el of deepQuerySelectorAll(root, scanSelector)) {
    perfCounters.scanCandidatesSeen++;
    if (seen.has(el)) continue;
    if (isKnown && isKnown(el)) { perfCounters.scanSkippedKnown++; continue; }
    if (el.matches(EXCLUDE_SELECTOR)) { perfCounters.scanRejectedExclude++; continue; }
    if (el.closest('[data-branchkit-hint]')) continue;
    survivors.push(el);
  }

  // Batch-warm element + ancestor rect/style for every survivor. Shared
  // ancestors are deduped inside cacheVisibility, so when a YouTube /watch
  // section mounts ~1000 sibling candidates their common ancestor chain is
  // read once, not once per candidate. The layout-dependent pass below then
  // reads from the warm cache via peekCachedRect/peekCachedStyle. We
  // attribute cacheVisibility's live reads to our own counters so the perf
  // trail reflects the true read count, not just peek-misses.
  const warmed = cacheVisibility(survivors);
  perfCounters.boundingRectCalls += warmed.rects;
  perfCounters.computedStyleCalls += warmed.styles;

  // Pass 2: layout-dependent filters, now hitting the warm cache.
  for (const el of survivors) {
    // In extra-hints mode, the wider selector matches plenty of
    // non-interactive elements. Keep them only if they look clickable.
    if (extraHintsEnabled && !el.matches(HINTABLE_SELECTOR)) {
      perfCounters.isHintableExtraCalls++;
      if (!isHintableExtra(el)) {
        perfCounters.scanRejectedExtraNotClickable++;
        continue;
      }
    }

    if (!isVisible(el)) {
      invisibleCandidates.push(el);
      perfCounters.scanRejectedInvisible++;
      continue;
    }
    if (isRedundant(el)) { perfCounters.scanRejectedRedundant++; continue; }

    seen.add(el);
    perfCounters.scanKeptAsHintable++;
    elements.push({
      label: getElementLabel(el),
      id: 0,
      category: classifyCategory(el),
      type: el.tagName.toLowerCase(),
      adapter: null,
      codeword: '',
    });
    refs.push(el);
  }

  clearLayoutCache();
  perfCounters.scanTotalMs += performance.now() - scanStart;
  visibilityCache = null;
  return { elements, refs, invisibleCandidates };
}

/** Default batch size for `scanInBatches`. Per
 * notes/DESIGN_HINT_PIPELINE_RESYNC.md the per-batch flow targets 10-20
 * elements: small enough that Put+paint per batch feels incremental,
 * large enough that round-trip overhead amortizes. */
export const DEFAULT_SCAN_BATCH_SIZE = 15;

/** One yielded chunk from `scanInBatches`. `invisibleCandidates` is
 * populated only on the terminal yield — the ResizeObserver-flip path
 * needs them once per scan, not per batch. */
export interface ScanBatch {
  elements: ScannedElement[];
  refs: Element[];
  /** True iff this is the last batch in the scan (or the scan was empty). */
  isLast: boolean;
  /** Invisible HINTABLE_SELECTOR matches; populated only when `isLast`. */
  invisibleCandidates: Element[];
}

/**
 * Walk the DOM once eagerly, then yield the surviving hintables in
 * chunks of `batchSize`. Same filter pipeline and dedup as
 * `scanElements`; the only behavior change is that the caller receives
 * results incrementally so per-batch follow-up work (claim codewords,
 * Put, paint) can begin before all candidates have been processed.
 *
 * The walk is eager (not lazy per yield): we need the full candidate
 * count before we can flag `isLast`, and the dedup `seen` set has to
 * cover the whole scan. The incremental win is on what callers DO
 * with each batch, not on the walk itself.
 *
 * Yields exactly one batch with `isLast: true` for a scan that found
 * zero hintables — that signals the caller's terminal-batch handler
 * (cleanup, vocabulary commit) without a special "no batches" path.
 *
 * `initialSeen` pre-marks elements as already-discovered. The per-batch
 * doScan flow runs inclusion-rule queries once at scan start (avoiding
 * N querySelectorAll per batch — see investigation item 15) and passes
 * those refs here so the regular walk doesn't re-emit them.
 *
 * `isKnown` mirrors `scanElements`: when supplied, already-tracked
 * elements are skipped during the walk (not just at attach time), so a
 * batched rediscovery of a freshly-swapped page doesn't spend label/
 * classify work on wrappers the store already holds.
 */
export function* scanInBatches(
  root: Document | Element = document,
  batchSize: number = DEFAULT_SCAN_BATCH_SIZE,
  initialSeen?: ReadonlySet<Element>,
  isKnown?: (el: Element) => boolean,
): Generator<ScanBatch, void, void> {
  // INCREMENTAL walk + filter. The previous implementation called
  // `collectHintables` upfront, walking the entire document and running
  // isVisible/isHintableExtra on every candidate before yielding the
  // first batch. On a freshly-loaded YouTube /watch page (~1000+ hintable
  // candidates × ~0.5ms isVisible per call), that single synchronous
  // task ran 500ms+, blocking the main thread before the snapshot
  // publisher could fire its first sample — the tab would appear frozen
  // and Firefox flagged the extension as unresponsive.
  //
  // Now: deepQuerySelectorAll runs once (cheap — native CSS selector
  // traversal), then we iterate candidates lazily, yielding a batch
  // every `batchSize` accepted ones. The caller (doScanBatched) awaits
  // setTimeout(0) between batches, so the event loop drains between
  // each filter chunk. Final batch (possibly empty) carries isLast and
  // the full invisibleCandidates list — same contract as before.
  const seen = new Set<Element>(initialSeen);
  visibilityCache = new WeakSet<Element>();
  const scanStart = performance.now();
  perfCounters.scanCalls++;
  const scanSelector = extraHintsEnabled ? EXTRA_SELECTOR : HINTABLE_SELECTOR;
  const allCandidates = deepQuerySelectorAll(root, scanSelector);

  const invisibleCandidates: Element[] = [];
  let bufferedElements: ScannedElement[] = [];
  let bufferedRefs: Element[] = [];

  for (const el of allCandidates) {
    perfCounters.scanCandidatesSeen++;
    if (seen.has(el)) continue;
    if (isKnown && isKnown(el)) { perfCounters.scanSkippedKnown++; continue; }
    if (el.matches(EXCLUDE_SELECTOR)) { perfCounters.scanRejectedExclude++; continue; }
    if (el.closest('[data-branchkit-hint]')) continue;

    if (extraHintsEnabled && !el.matches(HINTABLE_SELECTOR)) {
      perfCounters.isHintableExtraCalls++;
      if (!isHintableExtra(el)) {
        perfCounters.scanRejectedExtraNotClickable++;
        continue;
      }
    }

    if (!isVisible(el)) {
      invisibleCandidates.push(el);
      perfCounters.scanRejectedInvisible++;
      continue;
    }
    if (isRedundant(el)) { perfCounters.scanRejectedRedundant++; continue; }

    seen.add(el);
    perfCounters.scanKeptAsHintable++;
    bufferedElements.push({
      label: getElementLabel(el),
      id: 0,
      category: classifyCategory(el),
      type: el.tagName.toLowerCase(),
      adapter: null,
      codeword: '',
    });
    bufferedRefs.push(el);

    if (bufferedElements.length >= batchSize) {
      yield {
        elements: bufferedElements,
        refs: bufferedRefs,
        isLast: false,
        invisibleCandidates: [],
      };
      bufferedElements = [];
      bufferedRefs = [];
    }
  }

  perfCounters.scanTotalMs += performance.now() - scanStart;
  visibilityCache = null;

  // Terminal batch — carries any remaining buffered candidates plus the
  // full invisibleCandidates list. Always emitted (possibly with empty
  // elements/refs) so callers' isLast handler always runs.
  yield {
    elements: bufferedElements,
    refs: bufferedRefs,
    isLast: true,
    invisibleCandidates,
  };
}

function getElementLabel(el: Element): string {
  return accessibleName(el);
}
