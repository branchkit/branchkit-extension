/**
 * BranchKit Browser — per-frame window focus, and the query the SW asks it.
 *
 * Each frame's content script knows whether its `window` currently has focus.
 * The background uses this (via GET_FOCUS_STATUS) to route actions to whichever
 * frame the user is interacting with, when that is relevant. Trusted
 * focus/blur events on `window` are the canonical signal — hence the capture
 * listeners and the `e.target === window` check, which rejects the bubbled
 * focus of any element inside the frame.
 *
 * Lifted from content.ts with its message handler
 * (notes/DESIGN_ENTRY_POINT_TOPOLOGY.md phase 3).
 */

import { pageSession } from '../lifecycle/page-session';
import type { MessageHandler } from './message-router';

let hasFocus = false;
let installed = false;

/** Whether this frame's window currently holds focus. */
export function windowHasFocus(): boolean {
  return hasFocus;
}

/**
 * Seed from `document.hasFocus()` and start tracking. Called once from
 * content.ts; the listeners are session resources, so a teardown takes them.
 *
 * The initial read happens HERE rather than at module scope: a frame injected
 * into an already-focused page must not report `false` until its first focus
 * event, which would only ever arrive on a refocus that may never come.
 */
export function installWindowFocusTracking(): void {
  hasFocus = document.hasFocus();
  if (installed) return;
  installed = true;
  pageSession.resources.listen(window, 'focus', (e) => {
    if (e.target === window) hasFocus = true;
  }, true);
  pageSession.resources.listen(window, 'blur', (e) => {
    if (e.target === window) hasFocus = false;
  }, true);
}

/** Test seam. */
export function _resetWindowFocusForTesting(): void {
  hasFocus = false;
  installed = false;
}

export const focusMessageHandlers: Record<string, MessageHandler> = {
  GET_FOCUS_STATUS: () => ({ focused: hasFocus }),
};
