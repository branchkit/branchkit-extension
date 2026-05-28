/**
 * Defensive per-host MutationObserver.
 *
 * Some pages enumerate `body` and strip "unknown" attributes from
 * elements they don't recognize (Baidu, occasional Google products,
 * site-wide DOM sanitizers). Others apply global CSS that targets
 * inline style overrides. The badge host carries two attributes that
 * must survive:
 *
 *   - `data-branchkit-hint="true"` — the find-key the body-level
 *     reattach observer uses to identify our hosts. If the page strips
 *     this attribute, the badge survives in the DOM but becomes
 *     invisible to our recovery path.
 *   - inline `style="display:contents"` — keeps the host out of layout
 *     so absolute positioning of the inner badge works correctly. If
 *     the page clears this, the host starts taking space and shifts
 *     surrounding content.
 *
 * Strategy mirrors Rango's shadowHostMutationObserver: observe each
 * host with `{attributes: true}`, restore expected values for the two
 * known attributes, strip anything else. Per-host MO instances (not
 * shared) so disconnect is clean.
 *
 * Loop safety: setAttribute/removeAttribute called with the current
 * value of an attribute is a no-op per spec — no MutationRecord
 * fires. Our restoration calls only fire if the value actually
 * differs, and our strip calls become no-ops on the second-pass
 * record because the attribute is already gone.
 */

const observers = new Map<Element, MutationObserver>();

function reconcile(host: HTMLElement, attributeName: string): void {
  if (attributeName === 'data-branchkit-hint') {
    if (host.getAttribute('data-branchkit-hint') !== 'true') {
      host.setAttribute('data-branchkit-hint', 'true');
    }
  } else if (attributeName === 'style') {
    if (host.style.display !== 'contents') {
      host.style.display = 'contents';
    }
  } else {
    host.removeAttribute(attributeName);
  }
}

export function trackHostAttributes(host: HTMLElement): void {
  if (typeof MutationObserver === 'undefined') return;
  if (observers.has(host)) return;
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.attributeName) reconcile(host, r.attributeName);
    }
  });
  observer.observe(host, { attributes: true });
  observers.set(host, observer);
}

export function untrackHostAttributes(host: HTMLElement): void {
  const observer = observers.get(host);
  if (!observer) return;
  observer.disconnect();
  observers.delete(host);
}

export const __testing = {
  reset(): void {
    for (const o of observers.values()) o.disconnect();
    observers.clear();
  },
  isTracked(host: Element): boolean {
    return observers.has(host);
  },
  trackedCount(): number {
    return observers.size;
  },
  reconcile,
};
