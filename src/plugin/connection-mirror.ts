/**
 * BranchKit Browser — content-script mirror of the host connection state.
 *
 * The SW owns the truth (bgState.branchkitConnected, flipped only by the SSE
 * stream's real `connected` event and its drop) and mirrors it into
 * chrome.storage.local `branchkitConnected` at those same edges, plus a
 * boot-time reconcile in init() for the stale-true case (browser restart
 * with the host down — no disconnect event ever fires to correct it).
 *
 * Content scripts read the mirror for PAINT decisions only — a disconnected
 * host means voice isn't coming, so badges paint at full opacity instead of
 * the bk-pending "voice not ready YET" translucency. Connection state must
 * never gate transport: grammar POSTs run regardless, because a wrongly-
 * false mirror that suppressed syncs would strand painted badges
 * unmatchable with no epoch check ever running to heal them.
 *
 * Defaults to false (standalone posture) until the boot read resolves.
 */

let connected = false;
// An onChanged edge can be delivered before the boot get() resolves; the
// stale read must not overwrite the newer live value.
let sawLiveChange = false;

export function isBranchKitConnected(): boolean {
  return connected;
}

/**
 * Load the mirrored flag and subscribe to updates. `onTransition` fires only
 * on real edges (the boot read included, if it differs from the default),
 * never on same-value writes.
 */
export function initConnectionMirror(onTransition: (connected: boolean) => void): void {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
  chrome.storage.local.get('branchkitConnected').then((r) => {
    if (sawLiveChange) return;
    apply(r.branchkitConnected === true, onTransition);
  }).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !('branchkitConnected' in changes)) return;
    sawLiveChange = true;
    apply(changes.branchkitConnected.newValue === true, onTransition);
  });
}

function apply(next: boolean, onTransition: (connected: boolean) => void): void {
  if (next === connected) return;
  connected = next;
  onTransition(next);
}

/** Test seam: module state is per-page in production, shared across a vitest file. */
export function resetConnectionMirrorForTest(): void {
  connected = false;
  sawLiveChange = false;
}
