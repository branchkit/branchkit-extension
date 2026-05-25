/**
 * BranchKit Browser — DOM element scanning.
 *
 * Selectors from DESIGN_BROWSER_EXTENSION.md section 1.
 * buildSelector adapted from basetypes-extension.
 */

import { Category, ScannedElement } from './types';
import { accessibleName } from './accessible-name';

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

// Standard HTML elements that don't host shadow DOM in practice. Used as a
// pre-filter for shadow-host detection: only `<div>` and custom elements
// (which have hyphens in their tag names) commonly attach shadow roots, so
// skip the `.shadowRoot` lookup for everything else. Pattern from Rango.
const COMMON_LEAF_TAGS = new Set([
  'a', 'abbr', 'address', 'area', 'article', 'aside', 'audio', 'b', 'base',
  'bdi', 'bdo', 'blockquote', 'body', 'br', 'button', 'canvas', 'caption',
  'cite', 'code', 'col', 'colgroup', 'data', 'datalist', 'dd', 'del',
  'details', 'dfn', 'dialog', 'dl', 'dt', 'em', 'embed', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5',
  'h6', 'head', 'header', 'hgroup', 'hr', 'html', 'i', 'iframe', 'img',
  'input', 'ins', 'kbd', 'label', 'legend', 'li', 'link', 'main', 'map',
  'mark', 'menu', 'meta', 'meter', 'nav', 'noscript', 'object', 'ol',
  'optgroup', 'option', 'output', 'p', 'picture', 'pre', 'progress', 'q',
  'rp', 'rt', 'ruby', 's', 'samp', 'script', 'section', 'select', 'slot',
  'small', 'source', 'span', 'strong', 'style', 'sub', 'summary', 'sup',
  'svg', 'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th',
  'thead', 'time', 'title', 'tr', 'track', 'u', 'ul', 'var', 'video', 'wbr',
]);

function findShadowHosts(root: ParentNode): Element[] {
  const hosts: Element[] = [];
  // querySelectorAll('*') only returns descendants. When `root` itself is
  // a custom-element host (the case fired by the SHADOW_EVENT listener
  // in content.ts on attachShadow), we'd miss its shadow root entirely.
  if (root instanceof Element && !COMMON_LEAF_TAGS.has(root.tagName.toLowerCase()) && root.shadowRoot) {
    hosts.push(root);
  }
  const candidates = root.querySelectorAll('*');
  for (const el of candidates) {
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

function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);

  if (style.visibility === 'hidden' || rect.width < 5 || rect.height < 5 || style.opacity === '0') {
    if (el instanceof HTMLInputElement &&
        (el.type === 'checkbox' || el.type === 'radio') &&
        el.parentElement && isVisible(el.parentElement)) {
      return true;
    }
    return false;
  }

  let current = el.parentElement;
  while (current) {
    if (getComputedStyle(current).opacity === '0') return false;
    current = current.parentElement;
  }

  return true;
}

function isRedundant(el: Element): boolean {
  if (el.parentElement instanceof HTMLLabelElement &&
      el.parentElement.control === el) {
    return false;
  }

  if (el.parentElement?.matches(HINTABLE_SELECTOR) &&
      !hasSignificantSiblings(el)) {
    return true;
  }


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
  if (!el.matches(HINTABLE_SELECTOR)) return false;
  if (el.matches(EXCLUDE_SELECTOR)) return false;
  if (el.closest('[data-branchkit-hint]')) return false;
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
export function scanElements(root: Document | Element = document): { elements: ScannedElement[]; refs: Element[]; invisibleCandidates: Element[] } {
  return collectHintables(root);
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
): { elements: ScannedElement[]; refs: Element[]; invisibleCandidates: Element[] } {
  const elements: ScannedElement[] = [];
  const refs: Element[] = [];
  const invisibleCandidates: Element[] = [];
  const seen = new Set<Element>(initialSeen);

  for (const el of deepQuerySelectorAll(root, HINTABLE_SELECTOR)) {
    if (seen.has(el)) continue;
    if (el.matches(EXCLUDE_SELECTOR)) continue;
    if (el.closest('[data-branchkit-hint]')) continue;

    if (!isVisible(el)) {
      invisibleCandidates.push(el);
      continue;
    }
    if (isRedundant(el)) continue;

    seen.add(el);
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
 */
export function* scanInBatches(
  root: Document | Element = document,
  batchSize: number = DEFAULT_SCAN_BATCH_SIZE,
  initialSeen?: ReadonlySet<Element>,
): Generator<ScanBatch, void, void> {
  const { elements, refs, invisibleCandidates } = collectHintables(root, initialSeen);

  if (elements.length === 0) {
    yield { elements: [], refs: [], isLast: true, invisibleCandidates };
    return;
  }

  const total = elements.length;
  for (let start = 0; start < total; start += batchSize) {
    const end = Math.min(start + batchSize, total);
    const isLast = end === total;
    yield {
      elements: elements.slice(start, end),
      refs: refs.slice(start, end),
      isLast,
      invisibleCandidates: isLast ? invisibleCandidates : [],
    };
  }
}

function getElementLabel(el: Element): string {
  return accessibleName(el);
}
