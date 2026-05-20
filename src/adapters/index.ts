/**
 * BranchKit Browser — Site adapter registry.
 *
 * Adapters add site-specific scanning on top of generic scanning.
 * They augment (not replace) the core selectors.
 */

import { ScannedElement, Category } from '../types';
import { scanElements, classifyCategory } from '../scanner';
import { quickbaseAdapter } from './quickbase';

export interface CategoryScan {
  category: Category;
  scan: () => { elements: ScannedElement[]; refs: Element[] };
}

export interface SiteAdapter {
  name: string;
  pattern: RegExp;
  include?: string[];                      // additional selectors to scan
  exclude?: (el: Element) => boolean;      // site-specific exclusions
  categories?: CategoryScan[];             // named groups with custom scan functions
}

const adapters: SiteAdapter[] = [
  quickbaseAdapter,
];

/**
 * Find the active adapter for a URL, or null if none match.
 */
export function getActiveAdapter(url: string): SiteAdapter | null {
  for (const adapter of adapters) {
    if (adapter.pattern.test(url)) {
      return adapter;
    }
  }
  return null;
}

/**
 * Scan using a site adapter. Merges adapter-specific results with generic scan.
 */
export function scanWithAdapter(adapter: SiteAdapter): { elements: ScannedElement[]; refs: Element[] } {
  // Start with generic scan
  const generic = scanElements();
  const elements = [...generic.elements];
  const refs = [...generic.refs];
  const seen = new Set<Element>(refs);

  // Apply adapter exclusions
  if (adapter.exclude) {
    for (let i = elements.length - 1; i >= 0; i--) {
      if (adapter.exclude(refs[i])) {
        elements.splice(i, 1);
        refs.splice(i, 1);
      }
    }
  }

  // Add adapter-specific category scans
  if (adapter.categories) {
    for (const cat of adapter.categories) {
      const result = cat.scan();
      for (let i = 0; i < result.elements.length; i++) {
        if (!seen.has(result.refs[i])) {
          seen.add(result.refs[i]);
          elements.push(result.elements[i]);
          refs.push(result.refs[i]);
        }
      }
    }
  }

  // Scan additional include selectors
  if (adapter.include) {
    const selector = adapter.include.join(', ');
    const extra = document.querySelectorAll(selector);
    for (const el of extra) {
      if (seen.has(el)) continue;
      if ((el as HTMLElement).offsetWidth === 0) continue;
      seen.add(el);
      elements.push({
        label: el.textContent?.trim() || el.tagName.toLowerCase(),
        id: 0,
        category: classifyCategory(el),
        type: el.tagName.toLowerCase(),
        adapter: adapter.name,
        codeword: '',
      });
      refs.push(el);
    }
  }

  return { elements, refs };
}
