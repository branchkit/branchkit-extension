/**
 * BranchKit Browser — badge churn log (round 22, DESIGN_FLING_WAVE.md).
 *
 * The third survivorship deception in this arc: destroyed wrappers leave
 * `store.all`, so every latency percentile silently measures only the FINAL
 * population — a pop→wipe→rebuild cycle (QuickBase's double-buffered second
 * render killing freshly-badged first-render wrappers) is invisible to all
 * of them. This ring preserves the history of wrappers that were SHOWN and
 * then detached, so a drill can see the wipe without frame-by-frame video.
 *
 * Written by `detachWrapper` (the single teardown funnel — limbo finalize,
 * attribute-unhintable, and disconnected-reevaluation all route through
 * it). Rebinds/takeovers deliberately never reach it: identity survival is
 * not churn.
 */

export interface WipeRecord {
  /** performance.now at detach. */
  tDetached: number;
  /** How long the badge was visible before it died (tDetached - tFirstShown). */
  shownForMs: number;
  tag: string;
  source: string;
  /** Was the target inside the strict viewport at its last sighting
   * (wrapper.lastRect)? Viewport wipes are the perceptual ones. */
  inViewport: boolean;
  /** Died holding a codeword — its letter was released and the replacement
   * will claim a DIFFERENT one (the letters-changed tell). */
  hadCodeword: boolean;
}

const RING_MAX = 300;
const WIPE_WINDOW_MS = 2000;

const ring: WipeRecord[] = [];
let detachedShownTotal = 0;
let wipedWithin2sTotal = 0;

export function recordShownDetach(rec: WipeRecord): void {
  detachedShownTotal++;
  if (rec.shownForMs < WIPE_WINDOW_MS) wipedWithin2sTotal++;
  ring.push(rec);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
}

/** Snapshot view: totals + the window's records, newest last. */
export function churnStats(windowMs: number): {
  detached_shown_total: number;
  wiped_within_2s_total: number;
  recent: Array<{
    t_detached: number;
    shown_for_ms: number;
    tag: string;
    source: string;
    in_viewport: boolean;
    had_codeword: boolean;
  }>;
} {
  const cutoff = performance.now() - windowMs;
  return {
    detached_shown_total: detachedShownTotal,
    wiped_within_2s_total: wipedWithin2sTotal,
    recent: ring
      .filter((r) => r.tDetached >= cutoff)
      .map((r) => ({
        t_detached: Math.round(r.tDetached),
        shown_for_ms: Math.round(r.shownForMs),
        tag: r.tag,
        source: r.source,
        in_viewport: r.inViewport,
        had_codeword: r.hadCodeword,
      })),
  };
}

export function resetChurnLog(): void {
  ring.length = 0;
  detachedShownTotal = 0;
  wipedWithin2sTotal = 0;
}
