// Programmatic hint-diagnostics snapshot for Playwright harnesses.
//
// Replaces the old "press Ctrl+Alt+A, then guess the newest file in the
// snapshots dir by mtime" dance. The content script exposes a cross-world
// trigger (see content.ts `__branchkit__capture_snapshot`): dispatching the
// CustomEvent runs `captureDebugSnapshot` synchronously and mirrors the full
// structured payload onto `document.documentElement.dataset.branchkitSnapshot`.
// Because cross-world event listeners fire during the synchronous dispatch,
// the payload is readable in the same evaluate — no keyboard focus, no
// polling, no dependency on the plugin endpoint being reachable.
//
// The viewport PNG half still lands on disk at
//   ~/Library/Application Support/BranchKitDev/plugins/browser/snapshots/<snapshot_id>/viewport.png
// via the service-worker path when the plugin is up; `snapshot_id` is on the
// returned payload, so callers that want the PNG can locate it deterministically.

/**
 * Trigger a snapshot and return the structured payload (same shape as the
 * on-disk snapshot.json). Returns null if the content script isn't present
 * (extension not loaded / tab not yet injected).
 * @param {import('playwright').Page} page
 */
export async function captureSnapshot(page) {
  return page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('__branchkit__capture_snapshot'));
    const raw = document.documentElement.dataset.branchkitSnapshot;
    return raw ? JSON.parse(raw) : null;
  });
}

/**
 * Bucket every wrapper + dom_survey element into the failure-mode taxonomy
 * (see memory/project_observation_layer_leaks.md). `marginPx` mirrors the
 * IntersectionObserver rootMargin (200px) so "near-edge" badges aren't
 * miscounted as off-screen leaks.
 */
export function classify(snap, marginPx = 200) {
  const vp = snap.viewport ?? { width: 0, height: 0 };
  const VH = vp.height;
  const ws = snap.wrappers ?? [];
  const onBand = (r) =>
    r && r.w >= 2 && r.h >= 2 && r.y >= -marginPx && r.y <= VH + marginPx;

  const out = {
    total: ws.length,
    offscreenReleased: 0,   // isInViewport=false, no codeword — EXPECTED
    working: 0,             // codeword + on/near-screen badge
    claimGapInViewport: 0,  // isInViewport=true, no codeword — real claim gap
    noHintObject: 0,        // codeword but badge never built
    staleInViewport: 0,     // isInViewport=true but badge far outside the band
    discoveryGap: 0,        // hintable in dom_survey with no wrapper
  };

  for (const w of ws) {
    const cw = w.scanned?.codeword;
    const inv = w.isInViewport;
    if (!cw) {
      if (inv) out.claimGapInViewport++;
      else out.offscreenReleased++;
      continue;
    }
    if (!w.hint) { out.noHintObject++; continue; }
    if (onBand(w.hint.innerRect)) out.working++;
    else out.staleInViewport++;
  }

  for (const d of snap.dom_survey ?? []) {
    if (d.matchesHintable && !d.isHinted) out.discoveryGap++;
  }
  return out;
}
