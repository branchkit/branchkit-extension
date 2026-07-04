/**
 * BranchKit Browser — Stable element identity registry.
 *
 * Frame-local, document-lifetime store mapping monotonic integer ids to
 * WeakRef<Element> + fingerprint. Replaces the selector-based identity
 * stamped at scan time. See docs/completed/DESIGN_ELEMENT_IDENTITY_REGISTRY.md.
 *
 * The registry is the source of truth for "which DOM element does this
 * id refer to" after grammar push: tier 1 (live WeakRef) handles the
 * happy path; tier 2 (fingerprint) recovers when the wrapper was torn
 * down between grammar push and action arrival (e.g. React swap).
 */

import { accessibleName } from './accessible-name';
import type { Category } from '../types';
import type { ElementWrapper } from './element-wrapper';

export interface Fingerprint {
  role: string;
  name: string;
  tag: string;
  text: string;
  href?: string;
  inputType?: string;
}

export interface RegistryEntry {
  ref: WeakRef<Element>;
  fingerprint: Fingerprint;
  createdAt: number;
  category: Category;
}

const registry: Map<number, RegistryEntry> = new Map();
let reverseIndex: WeakMap<Element, number> = new WeakMap();
let nextId = 1;

// --- Role / fingerprint computation ---

// Implicit ARIA roles for common interactive tags. Anything not listed
// falls through to the lowercase tag name — good enough for the
// fingerprint's coarse identity check (we only need role to match, not
// to be spec-perfect).
const IMPLICIT_ROLES: Record<string, string> = {
  a: 'link',
  button: 'button',
  textarea: 'textbox',
  select: 'combobox',
  summary: 'button',
  label: 'label',
  option: 'option',
};

export function computeRole(el: Element): string {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit.toLowerCase();
  const tag = el.tagName.toLowerCase();
  if (tag === 'input') {
    const t = ((el as HTMLInputElement).getAttribute('type') || 'text').toLowerCase();
    if (t === 'checkbox') return 'checkbox';
    if (t === 'radio') return 'radio';
    if (t === 'button' || t === 'submit' || t === 'reset') return 'button';
    return 'textbox';
  }
  return IMPLICIT_ROLES[tag] ?? tag;
}

export function visibleText(el: Element, max = 40): string {
  const raw = (el as HTMLElement).innerText ?? el.textContent ?? '';
  const trimmed = raw.replace(/\s+/g, ' ').trim();
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}

export function computeFingerprint(el: Element): Fingerprint {
  const tag = el.tagName.toLowerCase();
  const fp: Fingerprint = {
    role: computeRole(el),
    name: accessibleName(el),
    tag,
    text: visibleText(el),
  };
  if (tag === 'a') {
    const href = (el as HTMLAnchorElement).getAttribute('href');
    if (href) fp.href = href;
  }
  if (tag === 'input') {
    const t = (el as HTMLInputElement).getAttribute('type');
    if (t) fp.inputType = t.toLowerCase();
  }
  return fp;
}

/**
 * A strong, stable, action-equivalent identity key, or null if the element
 * lacks one. Used by the key-ownership rebind (DESIGN_CODEWORD_KEY_OWNERSHIP.md):
 * a re-mounted element with the same key inherits its predecessor's codeword.
 *
 * Layer 1 is `href` only. Two elements with the same href do the same thing when
 * activated (navigate there), so transferring a codeword between them is harmless
 * even on a wrong guess — and href is stable across a re-mount. `id` is
 * deliberately excluded for now: framework-generated ids (`:r1:`, `ember123`)
 * change across re-mounts and would *cause* churn if treated as identity.
 */
export function computeStrongKey(el: Element): string | null {
  if (el.tagName.toLowerCase() === 'a') {
    const href = (el as HTMLAnchorElement).getAttribute('href');
    if (!href) return null;
    // Cell-context disambiguator (notes/DESIGN_FLING_WAVE.md round 9): data
    // grids link the same record from several columns, so raw-href keys
    // collide row-wide, collectStrongKeyIndex nulls every copy as ambiguous,
    // and the takeover tier — the one rebind path that works when a grid
    // replaces whole row subtrees insert-before-remove — goes dark for
    // exactly the wrappers that churn hardest. The nearest cell's class is
    // stable per column (both the index side and the match side read their
    // own CONNECTED element's cell, so the enrichment is symmetric); same
    // href in different columns → distinct unique keys → the tier fires.
    // Anchors outside any cell keep the raw-href key: duplicate nav/content
    // links stay ambiguous-null, exactly today's safe behavior.
    let p: Element | null = el.parentElement;
    for (let d = 0; p && d < 6; d++, p = p.parentElement) {
      if (p.tagName === 'TD' || p.getAttribute('role') === 'gridcell') {
        return 'h:' + href + '|c:' + p.className;
      }
      if (p.tagName === 'TR') break;
    }
    return 'h:' + href;
  }
  return null;
}

export function fingerprintsEqual(a: Fingerprint, b: Fingerprint): boolean {
  return (
    a.role === b.role &&
    a.name === b.name &&
    a.tag === b.tag &&
    a.text === b.text &&
    a.href === b.href &&
    a.inputType === b.inputType
  );
}

/**
 * Format a fingerprint for the dispatch-result log line. Flat string,
 * not JSON — diagnostic consumers grep, they don't deserialize.
 */
export function fingerprintToString(fp: Fingerprint): string {
  const parts = [`role=${fp.role}`, `name=${JSON.stringify(fp.name)}`, `tag=${fp.tag}`];
  if (fp.text) parts.push(`text=${JSON.stringify(fp.text)}`);
  if (fp.href) parts.push(`href=${JSON.stringify(fp.href)}`);
  if (fp.inputType) parts.push(`inputType=${fp.inputType}`);
  return parts.join(' ');
}

// --- Public API ---

/**
 * Mint a registry id for `wrapper`. Idempotent: a re-registration of the
 * same element returns its existing id. Every hintable element gets an id;
 * codeword assignment is the addressing layer (like Rango's label pool).
 */
export function register(wrapper: ElementWrapper): number {
  const existing = reverseIndex.get(wrapper.element);
  if (existing !== undefined && registry.has(existing)) {
    wrapper.scanned.id = existing;
    return existing;
  }

  const fp = computeFingerprint(wrapper.element);

  for (const [otherId, entry] of registry) {
    if (!fingerprintsEqual(entry.fingerprint, fp)) continue;
    const otherEl = entry.ref.deref();
    if (!otherEl) continue;
    if (otherEl === wrapper.element) {
      wrapper.scanned.id = otherId;
      reverseIndex.set(wrapper.element, otherId);
      return otherId;
    }
    break;
  }

  const id = nextId++;
  registry.set(id, {
    ref: new WeakRef(wrapper.element),
    fingerprint: fp,
    createdAt: performance.now(),
    category: wrapper.category,
  });
  reverseIndex.set(wrapper.element, id);
  wrapper.scanned.id = id;
  return id;
}

export function unregister(id: number): void {
  const entry = registry.get(id);
  if (!entry) return;
  const el = entry.ref.deref();
  if (el) reverseIndex.delete(el);
  registry.delete(id);
}

export function get(id: number): RegistryEntry | undefined {
  return registry.get(id);
}

export function getIdFor(el: Element): number | undefined {
  const id = reverseIndex.get(el);
  if (id === undefined) return undefined;
  return registry.has(id) ? id : undefined;
}

/**
 * Re-point an entry's WeakRef at a fresh element. Called after the
 * fingerprint fallback resolved a dead-ref entry — subsequent
 * activations short-circuit through the live ref instead of re-scanning.
 */
export function rebindRef(id: number, el: Element): void {
  const entry = registry.get(id);
  if (!entry) return;
  entry.ref = new WeakRef(el);
  reverseIndex.set(el, id);
}

/**
 * Recompute the fingerprint for an element whose name-bearing attributes
 * just mutated (aria-label, type, role, etc.).
 */
export function refreshFingerprint(id: number, el: Element): void {
  const entry = registry.get(id);
  if (!entry) return;
  entry.fingerprint = computeFingerprint(el);
}

/**
 * Linear scan over `candidates` looking for the first element whose
 * fingerprint matches on (role, tag, accessibleName). Used as tier 2
 * resolution when an id's WeakRef went dead between grammar push and
 * action arrival (React swap, etc.). Caller supplies candidates via
 * deepQuerySelectorAll so this stays free of scanner imports.
 */
export function fingerprintFallback(fp: Fingerprint, candidates: Iterable<Element>): Element | null {
  for (const el of candidates) {
    if (el.tagName.toLowerCase() !== fp.tag) continue;
    if (computeRole(el) !== fp.role) continue;
    if (accessibleName(el) !== fp.name) continue;
    return el;
  }
  return null;
}

/**
 * Wipe the registry. Called on bfcache restore — content script
 * survived but page state may have shifted. Resets the id counter so
 * the new doScan starts from 1; reverseIndex is swapped for a fresh
 * WeakMap so stale element→id pairs don't shadow re-registration.
 */
export function clear(): void {
  registry.clear();
  reverseIndex = new WeakMap();
  nextId = 1;
}

/** Test-only: snapshot the registry size. */
export function _size(): number {
  return registry.size;
}
