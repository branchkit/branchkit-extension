const CONTAINER_TAGS = new Set([
  'nav', 'main', 'aside', 'header', 'footer', 'section',
  'article', 'ul', 'ol', 'table', 'dialog', 'form',
]);
const CONTAINER_ROLES = new Set([
  'navigation', 'main', 'region', 'banner', 'complementary', 'contentinfo',
  'search', 'form', 'list', 'table', 'grid', 'dialog', 'group', 'toolbar', 'menubar',
]);
const NAME_FROM_CONTENT_ROLES = new Set([
  'button', 'link', 'menuitem', 'tab', 'heading', 'option', 'treeitem',
]);
const NAME_FROM_CONTENT_TAGS = new Set([
  'a', 'button', 'summary', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);

const trim = (s: string | null | undefined) =>
  (s ?? '').replace(/\s+/g, ' ').trim();

// One cap at the public boundary, not per-step: the aria-labelledby,
// name-from-content, and describedby paths return raw innerText, and a
// button wrapping a large text blob otherwise yields a multi-KB name that
// flows into fingerprints and grammar labels (2026-06-29 review).
const NAME_CAP = 256;

export function accessibleName(el: Element, visited = new Set<Element>()): string {
  return computeAccessibleName(el, visited).slice(0, NAME_CAP);
}

function computeAccessibleName(el: Element, visited: Set<Element>): string {
  if (visited.has(el)) return '';
  visited.add(el);

  // 1. aria-labelledby
  const lb = el.getAttribute('aria-labelledby');
  if (lb) {
    const doc = el.ownerDocument;
    const out = lb.split(/\s+/)
      .map(id => doc.getElementById(id))
      .filter((n): n is HTMLElement => !!n)
      .map(n => trim(computeAccessibleName(n, visited) || n.innerText))
      .join(' ');
    const result = trim(out);
    if (result) return result;
  }

  // 2. aria-label
  const al = trim(el.getAttribute('aria-label'));
  if (al) return al;

  // 3. Host-language label associations
  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement
      || el instanceof HTMLTextAreaElement) {
    if (el.labels?.length) {
      return trim(Array.from(el.labels).map(l => l.innerText).join(' '));
    }
    if (el instanceof HTMLInputElement
        && ['submit', 'button', 'reset'].includes(el.type)) {
      return trim(el.value) || el.type;
    }
    if ((el as HTMLInputElement).placeholder) return trim((el as HTMLInputElement).placeholder);
  }
  if (el instanceof HTMLImageElement) return trim(el.alt) || trim(el.title);
  if (el.tagName === 'FIELDSET') {
    const lg = el.querySelector(':scope > legend');
    if (lg) return trim((lg as HTMLElement).innerText);
  }

  // SVG icons: descend into <title>
  const svg = el.querySelector(':scope > svg, :scope > * > svg');
  if (svg) {
    const t = svg.querySelector(':scope > title');
    if (t) return trim(t.textContent);
  }

  // 4. Name-from-content roles
  const role = (el.getAttribute('role') || '').toLowerCase();
  const tag = el.tagName.toLowerCase();
  const isContentRole = NAME_FROM_CONTENT_ROLES.has(role)
    || NAME_FROM_CONTENT_TAGS.has(tag);
  if (isContentRole) {
    const txt = trim((el as HTMLElement).innerText);
    if (txt) return txt;
  }

  // 5. Container suppression — landmarks/lists/tables use title only
  const isContainer = CONTAINER_ROLES.has(role) || CONTAINER_TAGS.has(tag);
  if (isContainer) return trim(el.getAttribute('title'));

  // 6. title attribute
  const ti = trim(el.getAttribute('title'));
  if (ti) return ti;

  // 7. aria-describedby as name-of-last-resort
  const db = el.getAttribute('aria-describedby');
  if (db) {
    const doc = el.ownerDocument;
    const node = doc.getElementById(db.split(/\s+/)[0]);
    if (node) return trim(node.innerText);
  }

  // 8. Plain textContent
  return trim((el as HTMLElement).innerText) ?? '';
}
