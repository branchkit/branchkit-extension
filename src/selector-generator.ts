export const BLACKLIST = [
  /data-hint/,
  /data-branchkit/,
  /href/,
  /^#.*[0-9]/,
  /^.*-[0-9a-f]{6,}$/,
  /^[a-z]+-[a-z0-9]{5,}-[a-z0-9]{5,}$/i,
  /^[A-Za-z]{2,}_[A-Za-z0-9]{6,}$/,
];

export function isProbablyStable(className: string): boolean {
  return /^[a-z]+(?:-[a-z]+){1,3}$/i.test(className);
}

export function matchesBlacklist(value: string): boolean {
  return BLACKLIST.some(re => re.test(value));
}

function stableClasses(el: Element): string[] {
  return Array.from(el.classList).filter(
    c => isProbablyStable(c) && !matchesBlacklist(c),
  );
}

function escapeSelector(s: string): string {
  return CSS.escape(s);
}

function truncateDataUrl(value: string): string {
  const dataMatch = value.match(/^(data:[^;]+)/);
  if (dataMatch) return dataMatch[1];
  if (value.startsWith('blob:')) return 'blob:';
  return value;
}

function nthOfType(el: Element): string {
  const parent = el.parentElement;
  if (!parent) return el.tagName.toLowerCase();
  const tag = el.tagName;
  let idx = 0;
  for (const child of Array.from(parent.children)) {
    if (child.tagName === tag) idx++;
    if (child === el) break;
  }
  return `${el.tagName.toLowerCase()}:nth-of-type(${idx})`;
}

function isUnique(selector: string, scope: ParentNode): boolean {
  try {
    return scope.querySelectorAll(selector).length === 1;
  } catch {
    return false;
  }
}

export function generateSelector(el: Element): string {
  const doc = el.ownerDocument;
  const tag = el.tagName.toLowerCase();

  // 1. ID (skip blacklisted)
  if (el.id && !matchesBlacklist(el.id)) {
    const sel = `#${escapeSelector(el.id)}`;
    if (isUnique(sel, doc)) return sel;
  }

  // 2. data-testid
  const testId = el.getAttribute('data-testid');
  if (testId) {
    const sel = `[data-testid="${escapeSelector(testId)}"]`;
    if (isUnique(sel, doc)) return sel;
  }

  // 3. Tag + stable classes
  const classes = stableClasses(el);
  if (classes.length > 0) {
    const classSel = `${tag}.${classes.map(escapeSelector).join('.')}`;
    if (isUnique(classSel, doc)) return classSel;
  }

  // 4. Tag + aria-label
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) {
    const sel = `${tag}[aria-label="${escapeSelector(ariaLabel)}"]`;
    if (isUnique(sel, doc)) return sel;
  }

  // 5. Tag + attribute escalation for src/href (truncate data:/blob:)
  for (const attr of ['src', 'action']) {
    const val = el.getAttribute(attr);
    if (val) {
      const truncated = truncateDataUrl(val);
      if (truncated !== val) {
        const sel = `${tag}[${attr}^="${escapeSelector(truncated)}"]`;
        if (isUnique(sel, doc)) return sel;
      } else {
        const sel = `${tag}[${attr}="${escapeSelector(val)}"]`;
        if (isUnique(sel, doc)) return sel;
      }
    }
  }

  // 6. Tag + role + nth-of-type from parent
  const role = el.getAttribute('role');
  if (role) {
    const parent = el.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        c => c.getAttribute('role') === role && c.tagName === el.tagName,
      );
      const idx = siblings.indexOf(el) + 1;
      const parentSel = generateSelector(parent);
      const sel = `${parentSel} > ${tag}[role="${role}"]:nth-of-type(${idx})`;
      if (isUnique(sel, doc)) return sel;
    }
  }

  // 7. Ancestor with ID + nth-of-type
  let ancestor = el.parentElement;
  let depth = 0;
  while (ancestor && depth < 4) {
    if (ancestor.id && !matchesBlacklist(ancestor.id)) {
      const nth = nthOfType(el);
      const sel = `#${escapeSelector(ancestor.id)} ${nth}`;
      if (isUnique(sel, doc)) return sel;
    }
    ancestor = ancestor.parentElement;
    depth++;
  }

  // 8. Fallback: tag + nth-of-type
  return nthOfType(el);
}
