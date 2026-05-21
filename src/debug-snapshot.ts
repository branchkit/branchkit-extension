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
 *   `hint.hostRect` so category-3 failures (badge overlaps element B but
 *   anchors to A) become diagnosable.
 *
 * Snapshot id is the directory name on disk; the content script generates
 * an ISO-timestamp-shaped id with colons replaced by hyphens
 * (filesystem-safe across platforms). Server-side validation rejects
 * anything else — see plugins/browser/src/debug_snapshot.go.
 */

import { ElementWrapper, WrapperStore } from './element-wrapper';
import * as idRegistry from './registry';
import { enumerateAlmostHintable, isHintable, type AlmostHintable } from './scanner';
import { accessibleName } from './accessible-name';
import {
  elementSnap,
  parentChainSig,
  getActivatePathBuffer,
  type ActivatePathEvent,
  type ElementSnap,
} from './activate-path-log';

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
  };
  fingerprint: idRegistry.Fingerprint | null;
  element: (ElementSnap & { closestAnchor: ClosestAnchorInfo | null }) | null;
  hint: {
    hostRect: { x: number; y: number; w: number; h: number };
    anchorParentTag: string;
    displayedAs: string;
  } | null;
  isInViewport: boolean;
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

export interface DebugSnapshotPayload {
  snapshot_id: string;
  taken_at: string;
  frame_url: string;
  wrappers: WrapperRecord[];
  almost_hintable: AlmostHintableRecord[];
  orphans: OrphanRecord[];
  recent_activations: readonly ActivatePathEvent[];
  dom_survey?: DomSurveyElement[];
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
    const r = w.hint.host.getBoundingClientRect();
    hint = {
      hostRect: {
        x: Math.round(r.left),
        y: Math.round(r.top),
        w: Math.round(r.width),
        h: Math.round(r.height),
      },
      anchorParentTag: w.hint.anchorParent.tagName.toLowerCase(),
      displayedAs: w.hint.host.textContent ?? '',
    };
  }

  return {
    scanned: {
      id: w.scanned.id,
      label: w.scanned.label,
      category: String(w.scanned.category),
      codeword: w.scanned.codeword,
      type: w.scanned.type,
      adapter: w.scanned.adapter,
    },
    fingerprint,
    element: baseSnap ? { ...baseSnap, closestAnchor } : null,
    hint,
    isInViewport: w.isInViewport,
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

export function buildSnapshotPayload(inputs: BuildInputs): DebugSnapshotPayload {
  const now = inputs.now ?? new Date();
  return {
    snapshot_id: generateSnapshotId(now),
    taken_at: now.toISOString(),
    frame_url: inputs.frameUrl,
    wrappers: inputs.store.all.map(captureWrapper),
    almost_hintable: captureAlmostHintable(),
    orphans: findOrphans(inputs.store, inputs.knownRegistryIds),
    recent_activations: getActivatePathBuffer(),
    dom_survey: captureDomSurvey(inputs.store),
  };
}

// --- trigger entrypoint ---

/** Fire-and-forget: build the snapshot, send to background.ts for
 * forwarding to the plugin. Background does the screenshot capture
 * + POST sequence. */
export function captureDebugSnapshot(store: WrapperStore, frameUrl: string): void {
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
  try {
    chrome.runtime.sendMessage({ type: 'DEBUG_SNAPSHOT', payload });
  } catch {
    // Extension context invalidated; nothing useful to do.
  }
}
