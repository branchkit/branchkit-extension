/**
 * BranchKit Browser — paint-stability sampler + latency stats (content side).
 *
 * The eye-level perf surfaces merged into every debug snapshot: the
 * scroll-armed 10Hz paint-stability ring, the per-discovery-source latency
 * decomposition, and the stage-delta percentiles. Pure reads over
 * already-stamped wrapper fields and counters — nothing here mutates
 * pipeline state. Lifted out of content.ts
 * (notes/DESIGN_RESTRUCTURE_ROUND3.md); the buildPerfSnapshot INTEGRATOR
 * stays in content.ts by design (it reads counters from everywhere).
 */

import { store } from '../core/store';
import { pageSession } from '../lifecycle/page-session';
import { labelReservoir } from '../labels/label-reservoir';
import { lifecycleCounters } from './perf-counters';
import { churnStats } from './churn-log';
import { syncTraceStats } from './sync-trace';
import { getObserverFirstAttachedAt } from '../observe/mutation-source';
import { getHintVisibility } from '../config';

// --- Paint-stability sampler: the eye-level truth ---
// A 10Hz change-log of visible-state counts, armed by scroll activity and
// self-terminating 5s after the last scroll event (wedge discipline: a
// bounded timer chain, not a rAF). Dumped raw into the debug snapshot
// (paint_stability) alongside the per-wrapper stage stamps.
//
// Exists because the stage stamps CANNOT see what the user sees: tFirstShown
// credits a badge's first paint, but QuickBase's row churn re-hides and
// re-shows badges (repair waves of 80-105 mid-fling), so a badge the stamps
// score at 50ms may visibly stabilize seconds later. This ring records the
// actual on-screen badge count over time — plateau time and flicker dips
// included — which is the number that corresponds to perceived paint speed
// (the stage-percentiles-improve-but-it-feels-the-same disconnect,
// 2026-07-03). Cost per tick: O(store) property reads + one live
// HTMLCollection length; nothing runs while the page is scroll-idle.
const PAINT_SAMPLE_INTERVAL_MS = 100;
const PAINT_SAMPLE_TRAIL_MS = 5000;
const PAINT_SAMPLE_RING_MAX = 900;
// Tuple layout (round 34d appended the four photon columns):
// [t, rows, wrappers, painted, shown, shownStrict, poolFree,
//  eyeVpSolid, eyeVpTransl, eyeSolid, eyeTransl]
// The first seven read wrapper FLAGS (intent); the eye columns read each
// badge's computed style + geometry (HintBadge.eyeState) — what the user's
// retina gets. Flag/eye divergence in one sample IS the historically
// recurring "logs say fast, eye says slow" gap, now measured per drill.
const paintSamples: Array<[
  number, number, number, number, number, number, number,
  number, number, number, number,
]> = [];
let paintSamplerRunning = false;
let paintSamplerLastScroll = 0;
let paintSamplerLastKey = '';

export function notePaintSamplerScroll(): void {
  paintSamplerLastScroll = performance.now();
  if (paintSamplerRunning) return;
  paintSamplerRunning = true;
  paintSamplerTick();
}

function paintSamplerTick(): void {
  const now = performance.now();
  if (pageSession.isTornDown || now - paintSamplerLastScroll > PAINT_SAMPLE_TRAIL_MS) {
    paintSamplerRunning = false;
    return;
  }
  let painted = 0, shown = 0, shownStrict = 0;
  // Photon columns (round 34d): computed-style + geometry truth per badge.
  // All reads, batched in one pass — at most one forced layout per tick,
  // bounded to the scroll-armed sampling window. The flag columns above
  // record intent; these record what renders. Their divergence is the
  // recurring "logs say fast, eye says slow" gap, now a number per drill.
  let eyeVpSolid = 0, eyeVpTransl = 0, eyeSolid = 0, eyeTransl = 0;
  for (const w of store.all) {
    if (w.hint) {
      painted++;
      if (w.hint.isVisible) {
        shown++;
        // Viewport slice (round 22): the band-scoped `shown` hid a
        // viewport-only wipe (~40 of ~400 badges) entirely. Flag read,
        // no layout — the strict machinery maintains it.
        if (w.scanned.in_strict_viewport) shownStrict++;
      }
      const eye = w.hint.eyeState();
      if (eye) {
        if (eye.solid) { eyeSolid++; if (eye.inViewport) eyeVpSolid++; }
        else { eyeTransl++; if (eye.inViewport) eyeVpTransl++; }
      }
    }
  }
  // 'tr' count as the content-arrival proxy (live collection; .length is
  // cheap). Page-shape-specific but harmless where rows aren't tables.
  const rows = document.getElementsByTagName('tr').length;
  // Pool depth per sample (round 22): mid-storm reservoir exhaustion is a
  // repop-delay suspect (doomed-but-connected wrappers hold letters while
  // the replacement window claims); the at-rest snapshot can't see it.
  const poolFree = labelReservoir.stats().free;
  const key = `${rows}|${store.all.length}|${painted}|${shown}|${shownStrict}|${poolFree}|${eyeVpSolid}|${eyeVpTransl}|${eyeSolid}|${eyeTransl}`;
  if (key !== paintSamplerLastKey) {
    paintSamplerLastKey = key;
    paintSamples.push([
      Math.round(now), rows, store.all.length, painted, shown, shownStrict, poolFree,
      eyeVpSolid, eyeVpTransl, eyeSolid, eyeTransl,
    ]);
    if (paintSamples.length > PAINT_SAMPLE_RING_MAX) {
      paintSamples.splice(0, paintSamples.length - PAINT_SAMPLE_RING_MAX);
    }
  }
  pageSession.resources.timeout(paintSamplerTick, PAINT_SAMPLE_INTERVAL_MS);
}

// Paint-latency decomposition for the debug snapshot: stage-delta
// percentiles over wrappers first shown in the trailing window. Answers
// "where does the time go between a row appearing and its badge painting"
// (notes/DESIGN_PAINT_THE_BAND.md) — attached→band is discovery+IO,
// band→claimed is the claim debounce/flush, claimed→shown is the build
// queue. Pure reads over already-stamped fields; no layout.
const PAINT_LATENCY_WINDOW_MS = 90_000;

// Percentile helpers shared by paintLatencyStats and discoverySourceStats.
const latencyPct = (arr: number[], p: number) => {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
};
const latencySummary = (arr: number[]) =>
  ({ n: arr.length, p50: latencyPct(arr, 50), p90: latencyPct(arr, 90), max: latencyPct(arr, 100) });

// Per-discovery-source decomposition (DESIGN_FLING_WAVE round 15): kills the
// survivorship bias where only MO-path wrappers carried dom_seen stamps and
// the sweep-found 41% dropped out of every percentile. Per source over the
// trailing window: how many wrappers attached/shown, how many carried a REAL
// MO stamp (mo_stamped), and the stage latencies. Reading it for the miss
// diagnosis: a big band/settle_sweep cohort with mo_stamped high means the MO
// saw those subtrees but the walk didn't yield the elements (hydrated-later /
// pre-filter suspects); mo_stamped low means the MO never got a usable record
// for any ancestor (text-only records, observer-level gap). For non-MO
// sources dom_seen_to_attached (MO-stamped wrappers only) IS the miss window.
export function discoverySourceStats() {
  const now = performance.now();
  type SourceAcc = {
    attached: number; shown: number; moStamped: number; inViewportAtAttach: number;
    seenToAttached: number[]; seenToShown: number[]; attachedToShown: number[];
  };
  const bySource: Record<string, SourceAcc> = {};
  for (const w of store.all) {
    if (now - w.tAttached > PAINT_LATENCY_WINDOW_MS) continue;
    const s = (bySource[w.discoverySource] ??= {
      attached: 0, shown: 0, moStamped: 0, inViewportAtAttach: 0,
      seenToAttached: [], seenToShown: [], attachedToShown: [],
    });
    s.attached++;
    if (w.inViewportAtAttach) s.inViewportAtAttach++;
    if (w.domSeenByMo && w.tDomSeen !== null) {
      s.moStamped++;
      s.seenToAttached.push(w.tAttached - w.tDomSeen);
    }
    if (w.tFirstShown !== null) {
      s.shown++;
      if (w.tDomSeen !== null) s.seenToShown.push(w.tFirstShown - w.tDomSeen);
      s.attachedToShown.push(w.tFirstShown - w.tAttached);
    }
  }
  return Object.fromEntries(Object.entries(bySource).map(([source, s]) => [source, {
    attached_in_window: s.attached,
    shown_in_window: s.shown,
    mo_stamped: s.moStamped,
    // Round 21: sweep cohort with this HIGH + big dom_seen→attached = held
    // ineligible in view (chase it); LOW = scroll-ahead accounting (benign).
    in_viewport_at_attach: s.inViewportAtAttach,
    dom_seen_to_attached: latencySummary(s.seenToAttached),
    dom_seen_to_shown: latencySummary(s.seenToShown),
    attached_to_shown: latencySummary(s.attachedToShown),
  }]));
}

export function paintLatencyStats() {
  const now = performance.now();
  const deltas: Record<string, number[]> = {
    dom_seen_to_attached: [], attached_to_band: [], band_to_claimed: [],
    claimed_to_shown: [], attached_to_shown: [], dom_seen_to_shown: [],
    gated_to_shown: [],
  };
  let count = 0;
  for (const w of store.all) {
    if (w.tFirstShown === null || now - w.tFirstShown > PAINT_LATENCY_WINDOW_MS) continue;
    count++;
    if (w.tDomSeen !== null) {
      deltas.dom_seen_to_attached.push(w.tAttached - w.tDomSeen);
      deltas.dom_seen_to_shown.push(w.tFirstShown - w.tDomSeen);
    }
    // Built-but-gated on an invisible target: how long the reveal path took.
    if (w.tBuildGated !== null) deltas.gated_to_shown.push(w.tFirstShown - w.tBuildGated);
    if (w.tInBand !== null) deltas.attached_to_band.push(w.tInBand - w.tAttached);
    if (w.tInBand !== null && w.tClaimed !== null) deltas.band_to_claimed.push(w.tClaimed - w.tInBand);
    if (w.tClaimed !== null) deltas.claimed_to_shown.push(w.tFirstShown - w.tClaimed);
    deltas.attached_to_shown.push(w.tFirstShown - w.tAttached);
  }
  return {
    window_ms: PAINT_LATENCY_WINDOW_MS,
    shown_in_window: count,
    dom_seen_to_attached: latencySummary(deltas.dom_seen_to_attached),
    attached_to_band: latencySummary(deltas.attached_to_band),
    band_to_claimed: latencySummary(deltas.band_to_claimed),
    claimed_to_shown: latencySummary(deltas.claimed_to_shown),
    attached_to_shown: latencySummary(deltas.attached_to_shown),
    dom_seen_to_shown: latencySummary(deltas.dom_seen_to_shown),
    gated_to_shown: latencySummary(deltas.gated_to_shown),
  };
}

/** Diagnostic surfaces owned by this module, merged into every debug
 * snapshot (both the Ctrl+Alt+A path and the test-capture event) BEFORE the
 * send — see captureDebugSnapshot's extras param. */
export function snapshotExtras() {
  const engine = pageSession.engine;
  return {
    // Fling-wave pipeline health (notes/DESIGN_FLING_WAVE.md): cohort sizes
    // for the two geometry fast paths and the reservoir state they depend
    // on. reservoir.free pinned at ~0 during a fling = claims starving
    // (the round-2 signature); band_sweep_releases should fund it.
    wave: {
      band_converge_claims: lifecycleCounters.bandConvergeClaims,
      band_converge_releases: lifecycleCounters.bandConvergeReleases,
      long_stop_rescues: lifecycleCounters.longStopRescues,
      reservoir: labelReservoir.stats(),
      // Round 15+: who discovers wrappers, with per-source latency, over the
      // paint-latency window. The MO should own steady-state discovery; a
      // large sweep/scan share on a churny page is the miss being measured.
      discovery_sources: discoverySourceStats(),
      // Round 21 boot classifier: dom-seen stamps only exist for insertions
      // after this moment. Unstamped wrappers attached near it are
      // pre-observer boot content, NOT a mid-fling no-trace cohort.
      observer_attached_at: (() => {
        const t = getObserverFirstAttachedAt();
        return t === null ? null : Math.round(t);
      })(),
      // Lifetime attach counts per source (not window-scoped) + the
      // suspect-(c) tripwire: add records the Element gate skipped wholesale.
      attached_by_source: { ...lifecycleCounters.attachedBySource },
      mo_text_only_add_records: lifecycleCounters.moTextOnlyAddRecords,
      // Walk-reached-but-invisible registrations (attention handoff). ≈0
      // while sweeps attach hundreds → the walk never saw the missed
      // content; large → promotion-path latency is the thing to chase.
      invisible_candidates_observed: lifecycleCounters.invisibleCandidatesObserved,
      // Layer-3 reveal sensor (round 21): nonzero-box RO deliveries on parked
      // candidates. Climbing while attached_by_source.visibility stays flat =
      // the promote recheck rejects what the sensor reports.
      visibility_ro_signals: lifecycleCounters.visibilityRoSignals,
    },
    paint_latency: paintLatencyStats(),
    // Raw eye-level ring: [t_ms, tr_rows, wrappers, painted, shown,
    // shown_strict_viewport, pool_free] change entries from the
    // scroll-armed sampler above. shown_strict_viewport is the
    // viewport-sliced count (round 22 — a viewport wipe barely dents the
    // band-scoped `shown`); pool_free is the label reservoir depth per
    // sample (mid-storm exhaustion suspect).
    paint_stability: {
      interval_ms: PAINT_SAMPLE_INTERVAL_MS,
      columns: ['t', 'rows', 'wrappers', 'painted', 'shown', 'shown_strict', 'pool_free',
        'eye_vp_solid', 'eye_vp_transl', 'eye_solid', 'eye_transl'],
      samples: [...paintSamples],
    },
    // Round 22: history of shown-then-detached wrappers (the churn the
    // percentiles can't see — dead wrappers leave store.all). A fling with
    // a healthy pipeline shows recent[] ≈ empty; a pop→wipe→rebuild cycle
    // shows a burst of short shown_for_ms, in_viewport, had_codeword
    // records at the swap.
    churn: churnStats(PAINT_LATENCY_WINDOW_MS),
    // Round 22b: every grammar postBatch outcome (result, size, session,
    // elapsed) — a stalled post-swap sync (289 badges translucent ~25s,
    // snapshot 15-55) names its mechanism here: transport errors, slow
    // round-trips, wholesale refusals, or session-rotation races
    // (old-session batches failing after a rotate).
    sync_trace: syncTraceStats(PAINT_LATENCY_WINDOW_MS),
    reconcile_applied: {
      passes: engine.applied.passes,
      last: { ...engine.applied.last },
      total: { ...engine.applied.total },
    },
    // Visibility state — to diagnose a stuck toggle (badges painted but the
    // flag says hidden, so Shift+F routes to "show" instead of "hide"). If
    // painted_badges > 0 while hints_visible is false, that's the desync.
    visibility: {
      hints_visible: pageSession.badgesVisible,
      hint_visibility: getHintVisibility(),
      // Constructed badge OBJECTS — includes dormant scroll-back badges
      // (hidden, label cleared, codeword RELEASED), so this legitimately
      // exceeds claimed_codewords by the dormant count (the 2026-07-18
      // "11-badge gap" user report). visible_badges is the shown subset.
      painted_badges: store.all.filter((w) => w.hint !== null).length,
      visible_badges: store.all.filter((w) => w.hint?.isVisible).length,
      claimed_codewords: store.all.filter((w) => w.scanned.codeword.length > 0).length,
      // Actual badge-host DOM nodes. If this exceeds painted_badges, there are
      // untracked/stale badge nodes in the DOM — i.e. visually doubled hints
      // that no wrapper owns (the cleanup-on-hide/scroll gap).
      dom_badge_hosts: document.querySelectorAll('[data-branchkit-hint]').length,
    },
  };
}
