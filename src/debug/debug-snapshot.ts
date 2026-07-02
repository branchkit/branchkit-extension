/**
 * BranchKit Browser — hint-diagnostics debug snapshot (Phase 2b of
 * `docs/completed/DESIGN_HINT_DIAGNOSTICS.md`).
 *
 * Triggered by `Ctrl+Alt+A` (wired in content.ts). Walks the live store,
 * registry, DOM, and the activate-path ring buffer to build a frozen
 * structural picture of hint resolution on this page. Forwards the
 * structured JSON to background.ts, which POSTs to the plugin's
 * `/debug-snapshot` endpoint and then performs `chrome.tabs.captureVisibleTab`
 * for the viewport PNG.
 *
 * What this captures that BK_ACTIVATE_PATH can't:
 *
 * - **Negative space**: elements that matched `HINTABLE_SELECTOR` but
 *   were rejected (`EXCLUDE` / `invisible` / `redundant`). No activation
 *   ever fires for these, so they're invisible to the per-activation log.
 * - **Orphans**: registry entries whose wrappers got detached. Explains
 *   "why did my badge disappear" with no clicking required.
 * - **Visual-layer signal**: viewport screenshot pairs with each wrapper's
 *   `hint.innerRect` / `hint.outerRect` so category-3 failures (badge
 *   overlaps element B but anchors to A) become diagnosable.
 *
 * Snapshot id is the directory name on disk; the content script generates
 * an ISO-timestamp-shaped id with colons replaced by hyphens
 * (filesystem-safe across platforms). Server-side validation rejects
 * anything else — see plugins/browser/src/debug_snapshot.go.
 */

import { ElementWrapper, WrapperStore } from '../scan/element-wrapper';
import * as idRegistry from '../scan/registry';
import { rebindCounters } from '../observe/limbo';
import type { RebindCounters } from '../labels/rebind';
import { persistedCodeword } from '../labels/codeword-recall';
import { enumerateAlmostHintable, isHintable, isVisible, type AlmostHintable } from '../scan/scanner';
import { accessibleName } from '../scan/accessible-name';
import { diagnoseContainerResolution, type ContainerResolutionDiag } from '../render/container-diagnostics';
import {
  elementSnap,
  parentChainSig,
  getActivatePathBuffer,
  type ActivatePathEvent,
  type ElementSnap,
} from '../activate/activate-path-log';

// --- payload shape ---

/** Closest-anchor info — surfaces the anchor-delegation failure mode
 * from event-sequence.ts. `sameAsElement: false` is the smoking gun:
 * activateElement will click the ancestor anchor rather than the
 * wrapper's actual element. */
interface ClosestAnchorInfo {
  tag: string;
  href: string | null;
  accessibleName: string;
  sameAsElement: boolean;
}

/** Per-wrapper capture: scanned metadata + registry fingerprint + live
 * element data + hint placement + closest-anchor info (the structural
 * input that drives `activateElement`'s delegation decision). */
interface WrapperRecord {
  scanned: {
    id: number;
    label: string;
    category: string;
    codeword: string;
    type: string;
    adapter: string | null;
    in_strict_viewport: boolean | undefined;
  };
  fingerprint: idRegistry.Fingerprint | null;
  element: (ElementSnap & { closestAnchor: ClosestAnchorInfo | null }) | null;
  hint: {
    /** True when `show()` was called and `hide()` hasn't been since — i.e.
     * the badge currently believes itself to be painted. Used to diagnose
     * the hover-revealed-UI visibility recheck (notes/...): if a player
     * control element is CSS-invisible (opacity:0 via `ytp-autohide`) but
     * its hint reports `isVisible: true`, recheckHintedVisibility didn't
     * catch the transition. Mirrors the host's `data-bk-shown` attribute. */
    isVisible: boolean;
    /** True when the target element passes `isVisible()` *right now*. If
     * `isVisible` and `targetCssVisible` disagree, the visibility recheck
     * has drifted from CSS reality — typically the hover-reveal/autohide
     * timing race (opacity transition mid-flight when the throttled recheck
     * sampled). */
    targetCssVisible: boolean;
    innerRect: { x: number; y: number; w: number; h: number };
    outerRect: { x: number; y: number; w: number; h: number };
    anchorParentRect: { x: number; y: number; w: number; h: number };
    anchorParentScroll: { top: number; left: number; width: number; height: number };
    anchorParentOverflow: { x: string; y: string };
    anchorParentTag: string;
    anchorParentClasses: string;
    displayedAs: string;
    targetTag: string;
    reconcileOffset: { x: number; y: number } | null;
    hostTransform: string;
    viewportFixed: boolean;
    scrollAccelArmed: boolean;
    scrollAccelMax: number | null;
    scrollAccelScrollerTop: number | null;
    scrollAccelLayers: { scroller: string; max: number; scrollTop: number }[] | null;
    scrollAccelRearms: number;
    scrollAccelAnimBuilds: number;
    occluded: boolean;
    /** The two inputs behind `occluded` (effective = overlayCovered ||
     * clipped), so a snapshot pins WHICH signal hid the badge without a
     * flag-bisection round-trip (QuickBase combobox triage, 2026-07-01). */
    occludedBy: { overlayCovered: boolean; clipped: boolean };
  } | null;
  containerResolution: ContainerResolutionDiag | null;
  isInViewport: boolean;
  /** Plugin ACK'd the codeword (it reached the recognizer grammar). A
   * strictly-painted badge with grammar_ready=false is painted but the
   * extension->plugin sync hasn't confirmed it — a drift signal the Layer-2
   * reconcile keys off. */
  grammar_ready: boolean;
  lastSentStrictViewport: boolean | undefined;
}

interface AlmostHintableRecord {
  el: ElementSnap;
  reason: AlmostHintable['reason'];
}

interface OrphanRecord {
  registryId: number;
  fingerprint: idRegistry.Fingerprint | null;
}

interface DomSurveyElement {
  tag: string;
  id: string;
  className: string;
  role: string;
  accessibleName: string;
  cursor: string;
  href: string | null;
  forAttr: string | null;
  tabindex: string | null;
  contenteditable: string | null;
  rect: { x: number; y: number; w: number; h: number };
  matchesHintable: boolean;
  isHinted: boolean;
  parentChain: string[];
}

/** Build timestamp injected by esbuild (`define`) at compile time. Lets a
 *  captured snapshot prove which build the running content script came from. */
declare const __BUILD_ID__: string;

export interface RecallStats {
  /** Got its pre-reload codeword back. */
  reclaimed: number;
  /** Had a remembered codeword but was assigned a different one (the leak). */
  missed: number;
  /** No memory for this fingerprint — not a reclaim opportunity. */
  no_memory: number;
  /** reclaimed, restricted to near-viewport elements (the user-facing number). */
  viewport_reclaimed: number;
  /** missed, restricted to near-viewport elements. */
  viewport_missed: number;
}

export interface DebugSnapshotPayload {
  snapshot_id: string;
  taken_at: string;
  /** ISO build time of the running bundle (esbuild-injected). */
  build_id: string;
  frame_url: string;
  viewport: { width: number; height: number; scrollX: number; scrollY: number };
  wrappers: WrapperRecord[];
  almost_hintable: AlmostHintableRecord[];
  orphans: OrphanRecord[];
  recent_activations: readonly ActivatePathEvent[];
  /** Cumulative rebind-route tallies (clean/position/distance/no-match/key).
   *  rebind_key is the key-ownership transfer count — handy for spotting churn
   *  vs stable re-mounts in a snapshot. See DESIGN_CODEWORD_KEY_OWNERSHIP.md. */
  rebind_counters: RebindCounters;
  /** Regime-B reclaim metric across a reload (DESIGN_REGIME_B_RECALL.md).
   *  viewport_reclaimed / (viewport_reclaimed + viewport_missed) is the
   *  user-facing reclaim rate this layer drives upward. */
  recall_stats: RecallStats;
  /** Accelerator flag state at capture ("on"/"off"/"unsupported"/undefined),
   *  mirrored from the documentElement data-attrs. Makes a snapshot self-describing:
   *  a single-layer ridden chain on a deeply-nested target means nested was off,
   *  not a detection bug. */
  scroll_accel_flags: { enabled: string | null; nested: string | null };
  dom_survey?: DomSurveyElement[];
  /** What the settle pass DID (applied counts per action class, last pass +
   * cumulative) — Phase E of DESIGN_UNIFIED_RECONCILER.md flipped this
   * surface from the shadow plan/diff to the authoritative pass's output.
   * Attached by the content-script capture path, which owns the pipeline. */
  reconcile_applied?: {
    passes: number;
    last: Record<string, number>;
    total: Record<string, number>;
  };
  /** Grammar-epoch tripwire counters (Phase 2a of
   * DESIGN_GRAMMAR_EPOCH_HANDSHAKE.md) — checks/mismatches/skippedBusy plus
   * the last mismatch detail. Attached by the capture path. */
  grammar_epoch?: {
    checks: number;
    mismatches: number;
    skippedBusy: number;
    lastMismatch: Record<string, unknown> | null;
  };
}

// --- id generation ---

/** Generate a filesystem-safe ISO-timestamp id like
 * `2026-05-20T19-30-45-123Z`. Colons in the standard ISO format collide
 * with Windows filesystems; dashes are universally safe. Matches the
 * format the plugin-side validator accepts. */
export function generateSnapshotId(now: Date = new Date()): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

// --- per-wrapper capture ---

function captureWrapper(w: ElementWrapper): WrapperRecord {
  const el = w.element;
  const baseSnap = elementSnap(el);

  // closestAnchor: surfaces the anchor-delegation failure mode from
  // event-sequence.ts:206 — if `closest('a')` returns a different element
  // than the wrapper's, activateElement will click the ancestor anchor
  // instead of the wrapper. `sameAsElement: false` is the smoking gun.
  let closestAnchor: ClosestAnchorInfo | null = null;
  const anchor = el.closest('a');
  if (anchor) {
    const anchorSnap = elementSnap(anchor);
    closestAnchor = {
      tag: 'a',
      href: anchor.getAttribute('href'),
      accessibleName: anchorSnap?.accessibleName ?? '',
      sameAsElement: anchor === el,
    };
  }

  const fingerprint = idRegistry.get(w.scanned.id)?.fingerprint ?? null;

  let hint: WrapperRecord['hint'] = null;
  if (w.hint) {
    const diag = w.hint.diagnostics;
    let targetCssVisible = false;
    try {
      if (el.isConnected) targetCssVisible = isVisible(el);
    } catch { /* detached or stale element */ }
    hint = {
      isVisible: w.hint.isVisible,
      targetCssVisible,
      innerRect: diag.innerRect,
      outerRect: diag.outerRect,
      anchorParentRect: diag.anchorParentRect,
      anchorParentScroll: diag.anchorParentScroll,
      anchorParentOverflow: diag.anchorParentOverflow,
      anchorParentTag: diag.anchorParentTag,
      anchorParentClasses: diag.anchorParentClasses,
      displayedAs: diag.displayedAs,
      targetTag: diag.targetTag,
      reconcileOffset: diag.reconcileOffset,
      hostTransform: diag.hostTransform,
      viewportFixed: diag.viewportFixed,
      scrollAccelArmed: diag.scrollAccelArmed,
      scrollAccelMax: diag.scrollAccelMax,
      scrollAccelScrollerTop: diag.scrollAccelScrollerTop,
      scrollAccelLayers: diag.scrollAccelLayers,
      scrollAccelRearms: diag.scrollAccelRearms,
      scrollAccelAnimBuilds: diag.scrollAccelAnimBuilds,
      occluded: diag.occluded,
      occludedBy: { overlayCovered: w.overlayCovered, clipped: w.clipped },
    };
  }

  let containerResolution: ContainerResolutionDiag | null = null;
  try {
    if (el.isConnected) containerResolution = diagnoseContainerResolution(el);
  } catch { /* detached element */ }

  return {
    scanned: {
      id: w.scanned.id,
      label: w.scanned.label,
      category: String(w.scanned.category),
      codeword: w.scanned.codeword,
      type: w.scanned.type,
      adapter: w.scanned.adapter,
      // Strict-viewport flag: the value most recently computed for this
      // wrapper. Independent of `isInViewport` (the IO band's wide-margin
      // flag) — the strict bit governs which entries land in the
      // `browser_hints_<prefix>_strict` companion collection driving voice
      // matching + Discovery HUD. Distinguishes "badge painted for
      // scroll-ahead but not voice-matchable" from "actually matchable".
      in_strict_viewport: w.scanned.in_strict_viewport,
    },
    fingerprint,
    element: baseSnap ? { ...baseSnap, closestAnchor } : null,
    hint,
    containerResolution,
    isInViewport: w.isInViewport,
    grammar_ready: w.grammarReady,
    // What was last pushed to the plugin for this wrapper. A divergence
    // between `scanned.in_strict_viewport` (current) and `lastSentStrictViewport`
    // means a reconcile re-push is pending or missed.
    lastSentStrictViewport: w.lastSentStrictViewport,
  };
}

// --- orphan detection (§2.5(f)) ---

/** Find registry ids whose wrappers are no longer in the store.
 * Iterates the registry by walking wrappers' ids, then surfacing any
 * id that registry.get() knows about but no wrapper currently owns.
 *
 * Two-pass: collect all wrapper ids, then collect every registry id
 * surfaced anywhere on the live wrappers' elements (via `getIdFor`),
 * and treat ids only known by `registry.get` (via direct iteration) as
 * orphans. Implementation note: registry's internal Map isn't exported,
 * so we discover known ids by reading them off wrappers and via
 * `getIdFor` on candidate elements that bear `data-bk-id`. */
export function findOrphans(
  store: WrapperStore,
  knownRegistryIds: Iterable<number>,
): OrphanRecord[] {
  const liveIds = new Set<number>();
  for (const w of store.all) {
    liveIds.add(w.scanned.id);
  }
  const out: OrphanRecord[] = [];
  for (const id of knownRegistryIds) {
    if (liveIds.has(id)) continue;
    const entry = idRegistry.get(id);
    if (!entry) continue;
    out.push({ registryId: id, fingerprint: entry.fingerprint });
  }
  return out;
}

// --- almost-hintable capture ---

function captureAlmostHintable(): AlmostHintableRecord[] {
  return enumerateAlmostHintable().reduce<AlmostHintableRecord[]>((out, ah) => {
    const snap = elementSnap(ah.el);
    if (snap) out.push({ el: snap, reason: ah.reason });
    return out;
  }, []);
}

// --- DOM survey ---

function captureDomSurvey(store: WrapperStore): DomSurveyElement[] {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const hintedEls = new Set<Element>(store.all.map(w => w.element));
  const out: DomSurveyElement[] = [];

  for (const el of document.querySelectorAll('*')) {
    if (el.closest('[data-branchkit-hint]')) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;
    if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) continue;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;

    const tag = el.tagName.toLowerCase();
    const interactive = tag === 'a' || tag === 'button' || tag === 'input' ||
      tag === 'textarea' || tag === 'select' || tag === 'label' || tag === 'summary' ||
      el.hasAttribute('role') || el.hasAttribute('tabindex') ||
      el.hasAttribute('contenteditable') || style.cursor === 'pointer';
    if (!interactive) continue;

    out.push({
      tag,
      id: el.id,
      className: typeof el.className === 'string' ? el.className.slice(0, 200) : '',
      role: el.getAttribute('role') ?? '',
      accessibleName: accessibleName(el).slice(0, 200),
      cursor: style.cursor,
      href: el.getAttribute('href'),
      forAttr: el.getAttribute('for'),
      tabindex: el.getAttribute('tabindex'),
      contenteditable: el.getAttribute('contenteditable'),
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
      matchesHintable: isHintable(el),
      isHinted: hintedEls.has(el),
      parentChain: parentChainSig(el, 4),
    });
  }
  return out;
}

// --- top-level builder ---

interface BuildInputs {
  store: WrapperStore;
  /** Caller supplies the discovered registry ids — we don't have a
   * `registry.all()` API in v1, so the caller passes ids it can see
   * (live wrappers' ids plus anything cached in
   * `BK_ACTIVATE_PATH` history). For v1 this is best-effort orphan
   * detection; a `registry.allIds()` API would tighten it. */
  knownRegistryIds: Iterable<number>;
  frameUrl: string;
  now?: Date;
}

/**
 * Regime-B reclaim metric (DESIGN_REGIME_B_RECALL.md). For each codeworded
 * wrapper, compare its assigned codeword against what the SW-persisted memory
 * held for its fingerprint at page load. "reclaimed" = got its pre-reload letter
 * back; "missed" = had a remembered letter but got a different one (the leak we
 * tune); "no_memory" = nothing remembered (not a reclaim opportunity). The
 * `viewport_*` split is the user-facing number — what they actually see. Uses
 * the tracker's near-viewport flag (no extra layout read).
 */
export function computeRecallStats(store: WrapperStore): RecallStats {
  const s: RecallStats = {
    reclaimed: 0, missed: 0, no_memory: 0,
    viewport_reclaimed: 0, viewport_missed: 0,
  };
  for (const w of store.all) {
    if (w.scanned.id <= 0 || !w.scanned.codeword) continue;
    const fp = idRegistry.get(w.scanned.id)?.fingerprint;
    if (!fp) continue;
    const remembered = persistedCodeword(fp);
    if (remembered == null) { s.no_memory++; continue; }
    if (remembered === w.scanned.codeword) {
      s.reclaimed++;
      if (w.isInViewport) s.viewport_reclaimed++;
    } else {
      s.missed++;
      if (w.isInViewport) s.viewport_missed++;
    }
  }
  return s;
}

export function buildSnapshotPayload(inputs: BuildInputs): DebugSnapshotPayload {
  const now = inputs.now ?? new Date();
  return {
    snapshot_id: generateSnapshotId(now),
    taken_at: now.toISOString(),
    build_id: typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'unknown',
    frame_url: inputs.frameUrl,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    },
    scroll_accel_flags: {
      enabled: document.documentElement.getAttribute('data-bk-scroll-accel'),
      nested: document.documentElement.getAttribute('data-bk-scroll-accel-nested'),
    },
    wrappers: inputs.store.all.map(captureWrapper),
    almost_hintable: captureAlmostHintable(),
    orphans: findOrphans(inputs.store, inputs.knownRegistryIds),
    recent_activations: getActivatePathBuffer(),
    dom_survey: captureDomSurvey(inputs.store),
    rebind_counters: { ...rebindCounters },
    recall_stats: computeRecallStats(inputs.store),
  };
}

// --- trigger entrypoint ---

/** Build the snapshot and send it to background.ts for forwarding to the
 * plugin (disk write + screenshot capture). Returns the built payload so
 * callers — notably the `window.__branchkitCaptureSnapshot` test hook —
 * can read the structured snapshot synchronously without waiting on the
 * async disk-write/plugin-reachability path. */
export function captureDebugSnapshot(
  store: WrapperStore,
  frameUrl: string,
  /** Caller-owned diagnostic surfaces (reconcile_applied, grammar_epoch) —
   * merged BEFORE the send so the on-disk snapshot carries them. Attaching
   * after the call only ever reached the dataset mirror, which is why disk
   * snapshots silently lacked these fields (found 2026-06-12). */
  extras?: Partial<DebugSnapshotPayload>,
): DebugSnapshotPayload {
  const knownIds = new Set<number>();
  for (const w of store.all) knownIds.add(w.scanned.id);
  for (const ev of getActivatePathBuffer()) {
    if (ev.wrapperId > 0) knownIds.add(ev.wrapperId);
  }
  const payload = buildSnapshotPayload({
    store,
    knownRegistryIds: knownIds,
    frameUrl,
  });
  if (extras) Object.assign(payload, extras);
  try {
    chrome.runtime.sendMessage({ type: 'DEBUG_SNAPSHOT', payload });
  } catch {
    // Extension context invalidated; nothing useful to do.
  }
  return payload;
}
