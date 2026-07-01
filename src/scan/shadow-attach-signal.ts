/**
 * BranchKit Browser — disconnected-shadow-attach signal.
 *
 * The standard web-component pattern (createElement → attachShadow in the
 * constructor → populate → append) attaches the shadow root before the host
 * is in the document. The SHADOW_EVENT path can't identify the host: an
 * event dispatched on a disconnected element never propagates to the
 * document listener, and the element reference can't cross the
 * MAIN→ISOLATED world boundary (CustomEvent detail objects read as null in
 * Chrome's isolated worlds; DOM nodes aren't postMessage-cloneable). All the
 * bootstrap can say is THAT a disconnected attach happened — a bare
 * document-dispatched SHADOW_EVENT, recorded here as a timestamped signal.
 *
 * `consumeShadowAttachSignal` is the compensation, consulted by
 * `drainDiscovery` when the light-DOM pre-filter (`subtreeMaybeHintable`)
 * would skip an added root: while a signal is live, the skipped root gets
 * the deep (shadow-piercing) hintability check, and a hit forces the full
 * discovery walk. Pages that never do constructor-time attaches never have
 * a live signal, so the childList storm path (YouTube /watch) pays nothing.
 * Signals expire after 30s (a host created but never inserted must not tax
 * mutation processing forever) and one is consumed per hit root.
 *
 * Dynamically-inserted DECLARATIVE shadow roots emit no attachShadow call
 * and no signal — those still rely on the scroll-settle band sweep.
 */

import { deepSubtreeMaybeHintable } from './scanner';

const SIGNAL_TTL_MS = 30_000;

/** Timestamps (performance.now()) of un-consumed disconnected attaches. */
let signals: number[] = [];

export function noteDisconnectedShadowAttach(): void {
  signals.push(performance.now());
}

function anyLive(): boolean {
  if (signals.length === 0) return false;
  const cutoff = performance.now() - SIGNAL_TTL_MS;
  if (signals[0] < cutoff) signals = signals.filter(t => t >= cutoff);
  return signals.length > 0;
}

/**
 * True if a live signal exists AND `root` deep-checks hintable (open-shadow
 * pierce). Consumes one signal on a hit — the caller runs the full walk for
 * this root. No live signal → false without touching the DOM.
 */
export function consumeShadowAttachSignal(root: Element): boolean {
  if (!anyLive()) return false;
  if (!deepSubtreeMaybeHintable(root)) return false;
  signals.shift();
  return true;
}

/** Test-only: reset module state between cases. */
export function _resetShadowAttachSignalForTests(): void {
  signals = [];
}
