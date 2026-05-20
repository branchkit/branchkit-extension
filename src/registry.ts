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
import type { Category } from './types';
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

// --- Distinguishers ---
//
// When two registrations would otherwise share a fingerprint, we look for
// any structural signal that voice-addressable disambiguation can lean on:
// surrounding heading, ancestor landmark label, parent test-id, or
// position-among-same-role siblings. If none distinguishes them, register
// rejects the new element so voice can't ambiguously activate either.

function nearestHeadingText(el: Element): string {
  let cur: Element | null = el.parentElement;
  while (cur) {
    const t = cur.tagName.toLowerCase();
    if (t === 'h1' || t === 'h2' || t === 'h3' || t === 'h4' || t === 'h5' || t === 'h6') {
      return visibleText(cur, 80);
    }
    if ((cur.getAttribute('role') || '').toLowerCase() === 'heading') {
      return visibleText(cur, 80);
    }
    if (t === 'section' || t === 'article' || (cur.getAttribute('role') || '').toLowerCase() === 'region') {
      const lead = cur.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6');
      if (lead) return visibleText(lead, 80);
    }
    cur = cur.parentElement;
  }
  return '';
}

const LANDMARK_ROLES = new Set([
  'navigation', 'main', 'banner', 'contentinfo', 'complementary',
  'region', 'search', 'form',
]);
const LANDMARK_TAGS = new Set(['nav', 'main', 'header', 'footer', 'aside', 'section', 'form']);

function nearestLandmarkLabel(el: Element): string {
  let cur: Element | null = el.parentElement;
  while (cur) {
    const role = (cur.getAttribute('role') || '').toLowerCase();
    const tag = cur.tagName.toLowerCase();
    if (LANDMARK_ROLES.has(role) || LANDMARK_TAGS.has(tag)) {
      const lab = cur.getAttribute('aria-label');
      if (lab) return lab.trim();
    }
    cur = cur.parentElement;
  }
  return '';
}

function positionAmongSameRole(el: Element, role: string): number {
  const parent = el.parentElement;
  if (!parent) return -1;
  const siblings = Array.from(parent.children).filter(c => computeRole(c) === role);
  return siblings.indexOf(el);
}

function distinguish(fp: Fingerprint, newEl: Element, otherEl: Element): string | null {
  const heading = nearestHeadingText(newEl);
  const otherHeading = nearestHeadingText(otherEl);
  if (heading && heading !== otherHeading) return `h:${heading}`;

  const landmark = nearestLandmarkLabel(newEl);
  const otherLandmark = nearestLandmarkLabel(otherEl);
  if (landmark && landmark !== otherLandmark) return `l:${landmark}`;

  const tid = newEl.parentElement?.getAttribute('data-testid');
  const otherTid = otherEl.parentElement?.getAttribute('data-testid');
  if (tid && tid !== otherTid) return `t:${tid}`;

  const idx = positionAmongSameRole(newEl, fp.role);
  const otherIdx = positionAmongSameRole(otherEl, fp.role);
  if (idx >= 0 && idx !== otherIdx) return `p:${idx}`;

  return null;
}

// --- Public API ---

/**
 * Mint a registry id for `wrapper`. Idempotent: a re-registration of the
 * same element returns its existing id. Returns 0 to indicate a refused
 * registration — caller should treat the wrapper as not voice-addressable.
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
    if (!otherEl) continue; // stale; reclaim later via fingerprint fallback
    if (otherEl === wrapper.element) {
      wrapper.scanned.id = otherId;
      reverseIndex.set(wrapper.element, otherId);
      return otherId;
    }
    const distinct = distinguish(fp, wrapper.element, otherEl);
    if (!distinct) return 0;
    fp.text = distinct;
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
 * just mutated (aria-label, type, role, etc.). Re-runs the collision
 * validator; on unresolvable conflict the entry is dropped so a stale
 * fingerprint can't shadow a live one of the same shape.
 */
export function refreshFingerprint(id: number, el: Element): void {
  const entry = registry.get(id);
  if (!entry) return;
  const fp = computeFingerprint(el);

  for (const [otherId, other] of registry) {
    if (otherId === id) continue;
    if (!fingerprintsEqual(other.fingerprint, fp)) continue;
    const otherEl = other.ref.deref();
    if (!otherEl) continue;
    const distinct = distinguish(fp, el, otherEl);
    if (!distinct) {
      registry.delete(id);
      reverseIndex.delete(el);
      return;
    }
    fp.text = distinct;
    break;
  }

  entry.fingerprint = fp;
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
