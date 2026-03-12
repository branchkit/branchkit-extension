/**
 * BranchKit Extension — DOM element scanning.
 *
 * Selectors from DESIGN_BROWSER_EXTENSION.md §1.
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
  const htmlEl = el as HTMLElement;
  if (htmlEl.offsetWidth === 0 && htmlEl.offsetHeight === 0) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  return true;
}

/**
 * Scan the DOM for all hintable elements.
 * Returns ScannedElement[] sorted by DOM order.
 */
export function scanElements(root: Document | Element = document): { elements: ScannedElement[]; refs: Element[] } {
  const elements: ScannedElement[] = [];
  const refs: Element[] = [];
  const seen = new Set<Element>();

  const candidates = (root === document ? document : root).querySelectorAll(HINTABLE_SELECTOR);

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
    if (idx >= 0) return `[role="tablist"] > [role="tab"]:nth-child(${idx + 1})`;
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
      ancestor = ancestor.parentElement!;
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
