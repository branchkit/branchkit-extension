/**
 * BranchKit Browser — activate-path log + ring buffer.
 *
 * Phase 1 of `docs/completed/DESIGN_HINT_DIAGNOSTICS.md` (BK_ACTIVATE_PATH)
 * lives here so:
 *
 * 1. The activate handler in content.ts can call `emitActivatePath()`
 *    without owning the buffer + serialization machinery.
 * 2. The Phase 2 debug-snapshot.ts module can read the ring buffer
 *    via `getActivatePathBuffer()` to attach the last 10 activations
 *    to each snapshot (Q7 — self-contained debugging artifact).
 *
 * Ring buffer is module-private; mutate only through `emitActivatePath`.
 * Reads return a defensive copy so the snapshot path can't accidentally
 * mutate it. Lost on bfcache restore — by design, matches the rest of
 * the content-script state model.
 */
import * as idRegistry from './registry';
import { accessibleName } from './accessible-name';
import { DispatchResult } from './types';
import { type ActivationResult } from './event-sequence';

/** Per-element capture shape used by `wrapper` / `resolved` / `clicked`
 * fields on an ActivatePathEvent and by debug-snapshot's per-wrapper
 * `element` field. */
export interface ElementSnap {
  tag: string;
  role: string;
  accessibleName: string;
  rect: { x: number; y: number; w: number; h: number };
  dataTestId?: string;
  /** Compact ancestor signature (up to 5 levels) — see `parentChainSig`. */
  parentChain: string[];
}

/** One entry emitted per `browser.activate` dispatch. The schema is
 * versioned implicitly through the design doc; consumers (snapshot
 * payload, actuator log greps) read whatever fields are present.
 */
export interface ActivatePathEvent {
  ts: number;
  url: string;
  wrapperId: number;
  codeword: string;
  resolution: DispatchResult['resolution'];
  fingerprint: idRegistry.Fingerprint | null;
  resolved: ElementSnap | null;
  clicked: ElementSnap | null;
  delegation: ActivationResult['delegation'] | 'focus-input' | 'noop';
}

/** Q7: 10-event ring buffer the snapshot includes for "what just
 * happened" context. ~5KB at full capacity; negligible. */
export const ACTIVATE_PATH_BUFFER_SIZE = 10;

const activatePathBuffer: ActivatePathEvent[] = [];

/** Compact ancestor signature like `["div#main", "nav.sidebar", "ul"]`.
 * 5 levels covers most "is this in the right list/section" distinguishing
 * without paying the cost of a full outerHTML dump (per Q2). */
export function parentChainSig(el: Element, depth: number): string[] {
  const out: string[] = [];
  let cur: Element | null = el.parentElement;
  for (let i = 0; i < depth && cur; i++) {
    let sig = cur.tagName.toLowerCase();
    if (cur.id) sig += `#${cur.id}`;
    else if (cur.classList.length > 0) sig += `.${cur.classList[0]}`;
    const role = cur.getAttribute('role');
    if (role) sig += `[role=${role}]`;
    const tid = cur.getAttribute('data-testid');
    if (tid) sig += `[data-testid=${tid}]`;
    out.push(sig);
    cur = cur.parentElement;
  }
  return out;
}

/** Build an `ElementSnap` for one element, or null if the element is
 * gone. Shared between Phase 1's per-activation emit and Phase 2's
 * per-wrapper snapshot — keep them serialization-compatible so the
 * snapshot and the log lines diff cleanly. */
export function elementSnap(el: Element | null): ElementSnap | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const tid = el.getAttribute('data-testid');
  return {
    tag: el.tagName.toLowerCase(),
    role: idRegistry.computeRole(el),
    accessibleName: accessibleName(el),
    rect: {
      x: Math.round(r.left),
      y: Math.round(r.top),
      w: Math.round(r.width),
      h: Math.round(r.height),
    },
    dataTestId: tid || undefined,
    parentChain: parentChainSig(el, 5),
  };
}

/** Push an activate-path event into the ring buffer and forward it to
 * the per-plugin log as a BK_ACTIVATE_PATH line at info level.
 *
 * Info-level (rather than debug) because v2 of plugin logging defaults
 * the per-plugin threshold to info — debug-level lines would be dropped
 * for users on default settings, and the activation trace is the
 * hint-diagnostics feature's headline signal, not verbose chatter. */
export function emitActivatePath(event: ActivatePathEvent): void {
  activatePathBuffer.push(event);
  if (activatePathBuffer.length > ACTIVATE_PATH_BUFFER_SIZE) {
    activatePathBuffer.shift();
  }
  try {
    chrome.runtime.sendMessage({
      type: 'PLUGIN_DEBUG_LOG',
      tag: 'BK_ACTIVATE_PATH',
      data: event,
      level: 'info',
    });
  } catch {
    // Extension context invalidated; the in-memory ring buffer still
    // captured this event for Phase 2's snapshot consumption.
  }
}

/** Defensive-copy snapshot of the ring buffer. Read by debug-snapshot.ts
 * when assembling the Phase 2 payload. Callers cannot mutate the live
 * buffer through the return value. */
export function getActivatePathBuffer(): readonly ActivatePathEvent[] {
  return activatePathBuffer.slice();
}

/** Test-only reset. Drops the in-memory buffer; production code doesn't
 * call this. */
export function _resetActivatePathBufferForTesting(): void {
  activatePathBuffer.length = 0;
}
