/**
 * BranchKit Browser — DOM element scanning.
 *
 * Selectors from DESIGN_BROWSER_EXTENSION.md section 1.
 * buildSelector adapted from basetypes-extension.
 */

import { Category, ScannedElement } from './types';

// Core selectors — always scanned
const HINTABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([type="hidden"])',
  'textarea', 'select', 'summary', 'label[for]',
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

/**
 * Check if element is visible (non-zero dimensions and not off-screen).
 */
function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0;
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
  return true;
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
    selector: buildSelector(el),
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
export function scanElements(root: Document | Element = document): { elements: ScannedElement[]; refs: Element[] } {
  const elements: ScannedElement[] = [];
  const refs: Element[] = [];
  const seen = new Set<Element>();

  const candidates = deepQuerySelectorAll(root, HINTABLE_SELECTOR);

  for (const el of candidates) {
    if (seen.has(el)) continue;
    if (el.matches(EXCLUDE_SELECTOR)) continue;
    if (!isVisible(el)) continue;

    // Skip elements inside Shadow DOM hosts we didn't create
    if (el.closest('[data-branchkit-hint]')) continue;

    seen.add(el);

    const label = getElementLabel(el);
    const category = classifyCategory(el);
    const selector = buildSelector(el);

    elements.push({
      label,
      selector,
      category,
      type: el.tagName.toLowerCase(),
      adapter: null,
      codeword: '', // assigned later by doScan via the per-tab label pool
    });
    refs.push(el);
  }

  return { elements, refs };
}

/**
 * Get a human-readable label for an element.
 */
function getElementLabel(el: Element): string {
  // aria-label
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel.trim();

  // Text content (for buttons, links, etc.)
  const text = el.textContent?.trim();
  if (text && text.length <= 60) return text;

  // Placeholder
  const placeholder = (el as HTMLInputElement).placeholder;
  if (placeholder) return placeholder.trim();

  // Associated label
  if (el.id) {
    const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (label) return label.textContent?.trim() || '';
  }

  // Name attribute
  const name = el.getAttribute('name');
  if (name) return name;

  return el.tagName.toLowerCase();
}

/**
 * Build a CSS selector that uniquely identifies an element.
 * Priority: ID > data-testid > role+position > href > nth-child fallback.
 * Adapted from basetypes-extension buildClickableSelector().
 */
export function buildSelector(el: Element): string {
  // 1. ID
  if (el.id) return '#' + CSS.escape(el.id);

  // 2. data-testid
  const testId = el.getAttribute('data-testid');
  if (testId) return `[data-testid="${CSS.escape(testId)}"]`;

  // 3. Role-based tab selector
  const role = el.getAttribute('role');
  if (role === 'tab' && el.parentElement) {
    const tabs = Array.from(el.parentElement.children).filter(c => c.getAttribute('role') === 'tab');
    const idx = tabs.indexOf(el);
    if (idx >= 0) {
      // Use nth-of-type if all tabs share a tag, otherwise use our own index-based selector
      const tag = el.tagName.toLowerCase();
      const allSameTag = tabs.every(t => t.tagName === el.tagName);
      if (allSameTag) {
        return `[role="tablist"] > ${tag}:nth-of-type(${idx + 1})`;
      }
      // Fallback: use role attribute + position among role="tab" siblings
      return `[role="tab"]:nth-of-type(${idx + 1})`;
    }
  }

  // 4. Links with href
  if (el.tagName === 'A') {
    const href = (el as HTMLAnchorElement).getAttribute('href');
    if (href && href !== '#' && href.length < 200) {
      return `a[href="${CSS.escape(href)}"]`;
    }
  }

  // 5. Fallback: nth-of-type from nearest identifiable ancestor
  const parent = el.parentElement;
  if (parent) {
    const siblings = Array.from(parent.children);
    // Try finding an ancestor with ID
    let ancestor = parent;
    let depth = 0;
    while (ancestor && !ancestor.id && depth < 3) {
      if (!ancestor.parentElement) break;
      ancestor = ancestor.parentElement;
      depth++;
    }
    if (ancestor?.id) {
      const sameTag = siblings.filter(c => c.tagName === el.tagName);
      const tagIdx = sameTag.indexOf(el);
      return `#${CSS.escape(ancestor.id)} ${el.tagName.toLowerCase()}:nth-of-type(${tagIdx + 1})`;
    }

    // Last resort: tag + nth-of-type
    const sameTag = Array.from(parent.children).filter(c => c.tagName === el.tagName);
    const idx = sameTag.indexOf(el);
    return `${el.tagName.toLowerCase()}:nth-of-type(${idx + 1})`;
  }

  return el.tagName.toLowerCase();
}
