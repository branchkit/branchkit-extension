/**
 * BranchKit Browser — the top-frame predicate, in one place.
 *
 * The extension's most-repeated cross-cutting test: a content script runs in
 * every frame, and a great deal of what it does belongs to the tab rather than
 * the frame — the tab title marker, the help overlay, the popup's readout, a
 * global-mark scroll restore.
 *
 * Read at CALL time. `window.top` does not change for a frame's lifetime so it
 * costs nothing, and it is the difference between a gate a test can drive and
 * one that needs a module reload to observe. Three modules had grown their own
 * copy of this line with the same four-line comment attached
 * (notes/DESIGN_ENTRY_POINT_TOPOLOGY.md phase 3b), which is the tell that it is
 * one rule rather than three coincidences.
 *
 * Deliberately NOT a cached const: `window.top` is also the thing that changes
 * meaning under the quirks this repo already tracks (Firefox iframe privileges,
 * prerender/bfcache document reuse), so if the predicate ever needs a try/catch
 * or a `self !== top` fallback, this is the one place it goes.
 */
export function inTopFrame(): boolean {
  return window === window.top;
}
