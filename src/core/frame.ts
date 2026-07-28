/**
 * BranchKit Browser — what a content script knows about its own frame.
 *
 * Two cross-cutting reads with no dependencies: is this the top frame, and
 * what is this frame's URL called in a log line.
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

/**
 * Truncate a frame URL for log readability. Includes the path but not the
 * query string (which often carries session data), capped at 200 chars.
 *
 * It sat in `content.ts` between the orphan-quiesce and BK_ACTIVATE_PATH
 * sections — inside the line range notes/DESIGN_ENTRY_POINT_TOPOLOGY.md §5
 * excludes from this refactor, but not inside the excluded CONCERN. It has no
 * relationship to bfcache, orphan quiesce, nav rescan or teardown; it trims a
 * URL. §6i drew that exclusion on concerns rather than lines for this reason.
 *
 * Takes an href rather than reading `window.location.href` itself even though
 * every current caller passes exactly that. Narrowing the signature to match
 * the call sites is a behaviour change, and a behaviour change does not belong
 * inside a move (§6g.1).
 */
export function trimFrameUrl(href: string): string {
  try {
    const u = new URL(href);
    const out = `${u.origin}${u.pathname}`;
    return out.length > 200 ? out.slice(0, 200) + '…' : out;
  } catch {
    return href.slice(0, 200);
  }
}
