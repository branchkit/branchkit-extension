/**
 * BranchKit Browser — shadow hosts whose attach happened while disconnected.
 *
 * The standard web-component pattern (createElement → attachShadow in the
 * constructor → populate → append) attaches the shadow root before the host
 * is in the document. At that moment a discovery walk finds nothing (zero
 * rects, disconnected), and at append time the childList path's
 * `subtreeMaybeHintable` pre-filter is light-DOM-only — a host whose
 * hintables live entirely in shadow is skipped, so its hints only appear
 * when a later full walk (scroll-settle band sweep) happens by.
 *
 * The bootstrap's attachShadow wrapper reports disconnected attaches via a
 * document-dispatched SHADOW_EVENT carrying the host; the SHADOW_EVENT
 * listener parks them here. `consumePendingShadowHostsIn` is consulted by
 * `drainDiscovery` before the pre-filter skip: an added root that contains a
 * parked host must be walked even when its light DOM looks hintless.
 *
 * WeakRefs so a host that is created but never inserted doesn't pin its
 * detached subtree; dead refs are pruned on each consume pass.
 */

const pending = new Set<WeakRef<Element>>();

export function addPendingShadowHost(host: Element): void {
  pending.add(new WeakRef(host));
}

/**
 * True if `root` is or contains a parked host. Matching entries are removed
 * (the caller is about to run the full discovery walk over that subtree);
 * dead refs are pruned as a side effect. `contains` is light-tree — a parked
 * host inserted inside some OTHER shadow tree under `root` is missed here,
 * which is conservative (the band sweep still covers it).
 */
export function consumePendingShadowHostsIn(root: Element): boolean {
  if (pending.size === 0) return false;
  let found = false;
  for (const ref of pending) {
    const host = ref.deref();
    if (!host) {
      pending.delete(ref);
      continue;
    }
    if (root === host || root.contains(host)) {
      pending.delete(ref);
      found = true;
    }
  }
  return found;
}

/** Test-only: reset module state between cases. */
export function _clearPendingShadowHostsForTests(): void {
  pending.clear();
}
