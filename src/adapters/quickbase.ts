/**
 * BranchKit Browser — QuickBase site adapter.
 *
 * Adds QuickBase-specific scanning:
 * - Edit/View record icons
 * - Sidebar table navigation links
 * - Exclusion of destructive actions (save, cancel, delete)
 *
 * Ported from basetypes-extension/src/content.ts.
 */

import { SiteAdapter } from './index';
import { ScannedElement } from '../types';
import { buildSelector } from '../scanner';

const EXCLUDE_CLASSES = ['saveBtn', 'cancelBtn', 'deleteBtn', 'qb-splitbutton-menubtn'];
const EXCLUDE_TEXTS = ['save', 'cancel', 'delete', 'customize this form'];

function isExcluded(el: Element): boolean {
  const cls = el.className?.toString() || '';
  if (EXCLUDE_CLASSES.some(c => cls.includes(c))) return true;
  const text = el.textContent?.trim().toLowerCase() || '';
  if (EXCLUDE_TEXTS.some(t => text === t || text.startsWith(t))) return true;
  return false;
}

function scanRecordIcons(): { elements: ScannedElement[]; refs: Element[] } {
  const elements: ScannedElement[] = [];
  const refs: Element[] = [];
  let editNum = 0;
  let viewNum = 0;

  document.querySelectorAll('a.EditRecordIcon, a.ViewRecordIcon').forEach(el => {
    if ((el as HTMLElement).offsetWidth === 0) return;
    const cls = el.className?.toString() || '';
    if (cls.includes('EditRecordIcon')) {
      editNum++;
      elements.push({
        label: `Edit row ${editNum}`,
        selector: buildSelector(el),
        category: 'edit',
        type: 'record_action',
        adapter: 'quickbase',
        codeword: '',
      });
    } else {
      viewNum++;
      elements.push({
        label: `View row ${viewNum}`,
        selector: buildSelector(el),
        category: 'view',
        type: 'record_action',
        adapter: 'quickbase',
        codeword: '',
      });
    }
    refs.push(el);
  });

  return { elements, refs };
}

function scanTables(): { elements: ScannedElement[]; refs: Element[] } {
  const elements: ScannedElement[] = [];
  const refs: Element[] = [];

  document.querySelectorAll('a.custom-link').forEach(el => {
    if (elements.length >= 26) return;
    if ((el as HTMLElement).offsetWidth === 0) return;
    const href = (el as HTMLAnchorElement).href || '';
    if (!href.includes('/table/')) return;
    const text = el.textContent?.trim() || '';
    if (!text) return;

    const match = href.match(/\/table\/([^/]+)/);
    const tableId = match ? match[1] : '';

    // Use href fragment for unique selector
    const selector = tableId
      ? `a.custom-link[href*="${tableId}"]`
      : buildSelector(el);

    elements.push({
      label: text,
      selector,
      category: 'tables',
      type: 'sidebar_link',
      adapter: 'quickbase',
      codeword: '',
    });
    refs.push(el);
  });

  return { elements, refs };
}

export const quickbaseAdapter: SiteAdapter = {
  name: 'quickbase',
  pattern: /quickbase\.com/,
  exclude: isExcluded,
  categories: [
    { category: 'edit', scan: scanRecordIcons },
    { category: 'tables', scan: scanTables },
  ],
};
