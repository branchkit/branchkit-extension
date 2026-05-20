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
        id: 0,
        category: 'edit',
        type: 'record_action',
        adapter: 'quickbase',
        codeword: '',
      });
    } else {
      viewNum++;
      elements.push({
        label: `View row ${viewNum}`,
        id: 0,
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

    elements.push({
      label: text,
      id: 0,
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
