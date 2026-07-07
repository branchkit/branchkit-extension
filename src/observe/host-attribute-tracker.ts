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
// Expected `display` per host. Firefox/nesting badges use `contents` (host
// generates no box); the Chromium CSS-anchor fast-path needs a real box
// (`position:absolute`) so its host expects `block`. Defaults to `contents`.
const expectedDisplays = new Map<Element, string>();

function reconcile(host: HTMLElement, attributeName: string, expectedDisplay = 'contents'): void {
  if (attributeName === 'data-branchkit-hint') {
    if (host.getAttribute('data-branchkit-hint') !== 'true') {
      host.setAttribute('data-branchkit-hint', 'true');
    }
  } else if (
    attributeName === 'data-bk-shown' ||
    attributeName === 'data-bk-pending' ||
    attributeName === 'data-bk-accel' ||
    attributeName === 'data-bk-accel-rearms' ||
    attributeName === 'data-bk-accel-builds' ||
    attributeName === 'data-bk-occluded'
  ) {
    // Owned by HintBadge.show()/hide()/clearPending() and the inner-scroll
    // accelerator arm/disarm; the tracker MO sees our own writes echo back, so
    // it must allow them through. Tests + dev tools can query `[data-bk-shown]`,
    // `[data-bk-pending]`, `[data-bk-accel]`, and `[data-bk-accel-rearms]` to
    // inspect badge state without peeking into the closed shadow root.
  } else if (attributeName === 'style') {
    if (host.style.display !== expectedDisplay) {
      host.style.display = expectedDisplay;
    }
  } else {
    host.removeAttribute(attributeName);
  }
}

export function trackHostAttributes(host: HTMLElement, expectedDisplay = 'contents'): void {
  if (typeof MutationObserver === 'undefined') return;
  if (observers.has(host)) return;
  expectedDisplays.set(host, expectedDisplay);
  const observer = new MutationObserver((records) => {
    // Callback-rate + cost instrumentation for the per-host MO fan-out, feeding
    // the document-level-MO-fold decision (notes/INVESTIGATION_OBSERVER_CONSOLIDATION.md).
    // Reported via the global recorder content.ts wires up (see
    // __branchkitRecordCpu); no-op in tests / early boot.
    const __t0 = performance.now();
    for (const r of records) {
      if (r.attributeName) reconcile(host, r.attributeName, expectedDisplay);
    }
    const rec = (globalThis as { __branchkitRecordCpu?: (label: string, ms: number) => void }).__branchkitRecordCpu;
    if (rec) rec('hostAttribute:callback', performance.now() - __t0);
  });
  observer.observe(host, { attributes: true });
  observers.set(host, observer);
}

export function untrackHostAttributes(host: HTMLElement): void {
  const observer = observers.get(host);
  if (!observer) return;
  observer.disconnect();
  observers.delete(host);
  expectedDisplays.delete(host);
}

export const __testing = {
  reset(): void {
    for (const o of observers.values()) o.disconnect();
    observers.clear();
    expectedDisplays.clear();
  },
  isTracked(host: Element): boolean {
    return observers.has(host);
  },
  trackedCount(): number {
    return observers.size;
  },
  reconcile,
};
