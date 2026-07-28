/**
 * Badge visibility — ONE owner for "are the page's badges on screen", the
 * transitions in and out, and the screen borrow.
 *
 * Extracted from content.ts (Wave 4 tail, notes/PLAN_MODE_HOLDER_IMPL.md):
 * the compound showing-predicate was hand-copied at four content.ts sites
 * plus the range pick's, and three borrow-the-screen-and-give-it-back sites
 * (find's badge borrow, the pick's entry snapshot, and the retired
 * StoreCodewordHooks) each rolled the same shape — one of which shipped
 * missing its restore half and became a user-visible bug (find left every
 * always-mode page badge-less, 2026-07-26). One module, one predicate, one
 * borrow primitive.
 *
 * The showing-read is deliberately COMPOUND: the mode flag
 * (pageSession.badgesVisible — "user wants hints showing") OR any actually
 * visible badge. If the flag desyncs (badges painted while it reads hidden),
 * keying off it alone makes a toggle "show" a second set on top instead of
 * hiding — the double-badge / "won't hide" report. Any actually-visible
 * badge counts as showing, so a transition always acts on what the user
 * sees.
 *
 * This module owns visibility, not discovery or dispatch — but it does
 * TRIGGER a rescan on the hidden→shown edge, and it imports `doScan` to do
 * it. That used to arrive through an init hook on the stated grounds that
 * "the discovery walk is a content.ts-local orchestration this module has no
 * import path to". Both halves were false: `doScan` lives in
 * scan/scan-orchestrator and content.ts merely re-exports it, and the value-
 * import graph has NO path in EITHER direction between this module and that
 * one. There was no cycle to route around, so the hook (and with it the
 * module's whole init step) is gone.
 *
 * Consequence worth stating, because retiring a hook usually costs something:
 * `clearHintFilter` carried a bare `requireHooks()` whose only job was to
 * fail loud on use-before-init. With nothing left to initialise there is no
 * use-before-init state to be in — the requirement is gone, not the
 * guarantee. Source modules (observe/*) still reach showBadges through
 * pageSession.deps, their sanctioned reach-back; orchestration-layer modules
 * import this one directly.
 */

import { pageSession } from '../lifecycle/page-session';
import { store } from '../core/store';
import { dispatcher, keyHandler } from '../core/singletons';
import { inTopFrame } from '../core/frame';
import { getDisplayMode, getHintVisibility } from '../config';
import { applyClaimLabel } from '../scan/element-wrapper';
import { HintBadge } from './hints';
import { elementTarget } from './badge-target';
import { isVisible } from '../scan/scanner';
import { doScan } from '../scan/scan-orchestrator';
import { overlayCodewordsLive } from '../labels/holder-registry';
import { connectVisibilityMO } from '../observe/visibility-tracker';
import { placeBadges } from '../placement';
import { cacheLayout, cacheConstruction, clearLayoutCache, isRectOnScreen } from '../core/layout-cache';
import type { ElementWrapper } from '../scan/element-wrapper';
import { firehoseStep } from '../debug/firehose';
import { recordCpu } from '../debug/perf-counters';
import type { MessageHandler, MessageOf } from '../core/message-router';

const MAX_BADGE_COUNT = 676; // No artificial cap; word pairs for >26

/** The one showing-read (see header: compound on purpose). */
export function anyBadgesShowing(): boolean {
  return pageSession.badgesVisible || store.all.some((w) => w.hint?.isVisible);
}

// Hints appear on their own — on a fresh page or after an action — only in
// "always" mode. "manual" mode never auto-shows (summon with `f`). A Shift+F
// hide in always mode is momentary (this page only): there is no persisted
// hidden state, so the next page paints them again — "Always" always means
// always, and a stray hide can never silently strand the badges off.
export function shouldAutoShowBadges(): boolean {
  return getHintVisibility() === 'always';
}

// Re-scan and re-render hint badges after a short delay. Used after
// always-mode activation so post-activate DOM mutations (modal open, form
// expansion, autocomplete) are reflected. Idempotent re-call is coalesced:
// if a refresh is already scheduled, drop the new request — the existing
// one will pick up whatever changed by the time it fires.
//
// Delay must exceed the activation flash duration (400ms in hints.ts) so
// the refresh's updateLabel — which resets badge text to the displayMode
// default — runs AFTER the yellow flash completes. Otherwise the
// activated badge's narrowed text ("a check") would visibly snap back to
// "arch c" mid-flash.
let hintRefreshScheduled = false;
const HINT_REFRESH_DELAY_MS = 450;

export function scheduleHintRefresh(): void {
  if (hintRefreshScheduled) return;
  hintRefreshScheduled = true;
  pageSession.resources.timeout(() => {
    hintRefreshScheduled = false;
    if (!shouldAutoShowBadges()) return;
    doScan();
    showBadges();
  }, HINT_REFRESH_DELAY_MS);
}

/** Filter to viewport-visible elements and sort by position (top-left first). */
function viewportSort(wrappers: ElementWrapper[]): ElementWrapper[] {
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  return wrappers
    .filter(w => isRectOnScreen(w.element.getBoundingClientRect(), vw, vh))
    .sort((a, b) => {
      const ra = a.element.getBoundingClientRect();
      const rb = b.element.getBoundingClientRect();
      return (ra.top - rb.top) || (ra.left - rb.left);
    });
}

export async function showBadges(): Promise<void> {
  // Wait one frame so any pending IntersectionObserver entries (queued
  // synchronously by observe(), delivered async) have a chance to fire,
  // then drain pending claims/releases. Without this, a `f` keypress
  // immediately after page load can race the tracker — wrappers exist
  // but their codewords haven't been claimed yet and badges would
  // render with no labels.
  await new Promise(r => requestAnimationFrame(() => r(null)));
  await pageSession.tracker.flushNow();

  const allTargets = [...store.all];

  // pageSession.badgesVisible is the mode flag — "user wants hints showing." Set it
  // even when the store has nothing to paint right now so subsequent
  // wrappers arriving via the batched scan (or MutationObserver
  // discovery) paint via badgeNewlyCodeworded, which is pageSession.badgesVisible-
  // gated. Under the old whole-grammar path the store was always
  // populated by the time showBadges fired, so an empty return here
  // never mattered; under batched mode the scan is async and showBadges
  // can race ahead of the first batch landing.
  if (allTargets.length === 0) {
    pageSession.badgesVisible = true;
    return;
  }

  // Filter to viewport-visible and sort by position (same as grammar push)
  const targets = viewportSort(allTargets);
  if (targets.length === 0) {
    pageSession.badgesVisible = true;
    return;
  }

  // Only render hints for elements that received a pool codeword.
  // Elements without one wouldn't be voice-addressable and their badge
  // would say "?" — better to leave them unhinted.
  const renderable = targets
    .slice(0, MAX_BADGE_COUNT)
    .filter(w => w.scanned.codeword.length > 0);

  // Breadcrumbs around the heavy per-batch paint: HintBadge construction
  // (shadow root + DOM per badge) + placeBadges layout reads. Suspected wedge
  // on heavy SPA targets (YouTube /@channel/videos with 80+ badges).
  firehoseStep('showBadges:start', renderable.length, 20);
  cacheLayout(renderable.map(w => w.element));
  // Ancestor warm (rect + style + dims) for the same construction walks the
  // build pass warms for (see badgeNewlyCodeworded) — showBadges constructs
  // the strict-viewport slice and pays them per badge otherwise.
  cacheConstruction(renderable.map(w => w.element));
  firehoseStep('showBadges:cache_end', renderable.length, 20);
  try {
    for (const wrapper of renderable) {
      const label = applyClaimLabel(wrapper);

      if (!wrapper.hint) {
        wrapper.hint = new HintBadge(
          elementTarget(wrapper.element),
          label,
          getDisplayMode(),
        );
      } else {
        wrapper.hint.updateLabel(label, getDisplayMode());
      }

      // Don't paint a badge on a CSS-invisible target (visibility:hidden /
      // opacity:0 — a hover-reveal action bar). These never fire a mutation
      // (they're hidden from the start, never hovered), so the throttled
      // visibility recheck never gets a transition to clean them up — the badge
      // would stay painted (and flicker on scroll) on something the user can't
      // see. Gate at the paint source instead. The voice (strict) side reads
      // the same fact fresh at plan/stamp time — no stored flag; the cache is
      // warm from cacheLayout above, so isVisible is cheap here.
      const cssVisible = isVisible(wrapper.element);
      if (cssVisible) {
        wrapper.hint.show();
        wrapper.tFirstShown ??= performance.now();
      } else {
        wrapper.hint.hide();
      }
    }
    firehoseStep('showBadges:mount_end', renderable.length, 20);

    // Ensure visibilityMO is running so class/style-driven visibility
    // transitions (YouTube controls fading out, etc.) request the settle
    // pass (schedulePassSoon — the demoted backstop). Idempotent — no-op if
    // already connected, just refreshes the abandon timer.
    if (renderable.length > 0) connectVisibilityMO();

    const __pbStart = performance.now();
    try { placeBadges(renderable); } finally {
      recordCpu('placeBadges:show', performance.now() - __pbStart);
      firehoseStep('showBadges:place_end', renderable.length, 20);
    }
  } finally {
    clearLayoutCache();
  }
  pageSession.badgesVisible = true;
  // showBadges painted only the strict-viewport `renderable` slice. Converge
  // the rest of the desired set: build badges for in-band (IO-margin)
  // codeworded wrappers that fell outside the strict viewport — the
  // noHintObject set that otherwise stayed hintless until the next scroll.
  pageSession.engine.reconcile();
}

// Reset narrowing/interaction state on existing hint badges without
// removing them from the DOM. Used after an action completes when we want
// to keep badges visible (always-mode activate) but clear visual highlights
// from prefix narrowing or keyboard filter typing, and exit interaction
// modes (keyboard hint mode, new-tab flag) so the next utterance starts
// fresh. Safe to call when no badges are showing — the per-wrapper calls
// are no-ops on hidden hints.
//
// Does NOT reset matched-chars on badges. That state represents "user
// matched the prefix X" — we want it preserved during the activation
// flash so the user sees the narrowed text (e.g., "a check") while the
// badge flashes yellow, not the displayMode default ("arch c"). The
// scheduled hint refresh (after the flash completes) re-renders all
// badges via updateLabel, which resets the text naturally.
export function clearHintFilter(): void {
  // An abandoned verb must not survive the filter that armed it: clearing the
  // hint prefix is exactly the moment 'yank' stops applying to anything.
  keyHandler.resetHintAction();
  keyHandler.exitHintMode();
  for (const w of store.all) {
    w.hint?.setFiltered(false);
  }
}

export function hideBadges(): void {
  clearHintFilter();
  pageSession.badgesVisible = false;
  for (const w of store.all) {
    w.hint?.hideLeader();
    w.hint?.hide();
  }

  // Catch up on DOM changes that occurred while hints were visible
  if (pageSession.pendingMutation) {
    pageSession.pendingMutation = false;
    pageSession.resources.timeout(() => { void doScan(); }, 100);
  }
}

// The modal `hint` mode (where Escape dismisses all hints) only makes sense
// when the user explicitly summoned hints — i.e. manual visibility mode. In
// always-visible mode hints are persistent and there's a dedicated hide chord,
// so the handler stays in normal mode: Escape keeps its native behavior (close
// a dropdown mid-utterance, etc.) instead of nuking every badge. Typing still
// works in always mode via the hints-visible predicate, independent of mode.
function enterHintModeIfManual(): void {
  if (getHintVisibility() !== 'always') keyHandler.enterHintMode();
}

// The shared show/hide toggle used by both Shift+F (keyboard) and the voice
// "toggle" command, so the two entry points can't drift. Branches on the
// compound showing-read (see header) so the toggle always dismisses what the
// user sees. Keeps the new-tab modifier untouched so a stray toggle doesn't
// re-arm new-tab activation.
//
// The hide is momentary — NOT persisted. In always mode the next page repaints
// the badges (shouldAutoShowBadges); in manual mode a fresh page is hidden by
// the mode itself. Persistent "stay hidden while I browse" IS manual mode, so
// there's no separate hidden flag to silently override the visible setting.
// Returns true if it ended up showing.
export function toggleHints(): boolean {
  return setBadgesVisible(!anyBadgesShowing());
}

// Drive badges to a definite visibility. The popup's Show/Hide button uses this
// (a definite set, not a blind toggle, so a click can't race the read that
// labeled the button). Momentary — no persistence, exactly like Shift+F: in
// always mode the next page repaints; in manual mode a fresh page is hidden by
// the mode. Returns the resulting shown state. No-op when already there.
export function setBadgesVisible(visible: boolean): boolean {
  const showing = anyBadgesShowing();
  if (visible === showing) return showing;
  if (visible) {
    void doScan();
    void showBadges();
    enterHintModeIfManual();
  } else {
    hideBadges();
    keyHandler.exitHintMode();
  }
  return visible;
}

/**
 * One outstanding borrow of the badge screen: snapshot the compound
 * showing-read, hide if shown, and give back EXACTLY what was taken —
 * conditionally, idempotently. The primitive behind find's badge borrow
 * (content.ts) and the pick's entry snapshot (range-disambiguation.ts):
 * the shape that, hand-rolled, shipped once with its restore half missing.
 *
 * Snapshotted, not assumed: under manual visibility the badges were already
 * hidden before the borrower ran, and re-showing on restore would be a state
 * change the user never asked for. The snapshot is read BEFORE the hide —
 * hiding also exits hint mode, so a caller that needs the keyboard half
 * (the pick) must read it before calling this.
 */
export interface BadgeBorrow {
  /** Did the borrow actually hide anything? (I.e. were badges showing at
   *  entry.) Lets a re-entrant borrower re-assert the hide over a live
   *  session without re-snapshotting the state it itself caused. */
  readonly took: boolean;
  /** Give the screen back in the state the borrow found it. Idempotent —
   *  whichever exit path runs first restores, later ones no-op. */
  restore(): void;
}

export function borrowBadgeScreen(): BadgeBorrow {
  const took = anyBadgesShowing();
  if (took) hideBadges();
  let returned = false;
  return {
    took,
    restore() {
      if (returned) return;
      returned = true;
      if (took) void showBadges();
    },
  };
}

// --- The screen borrow, as a single slot ---
//
// Find borrows the badge screen while it runs — highlights and the badge layer
// compete for the same screen — and gives it back on exit (field, 2026-07-26:
// every exit left an always-mode page badge-less, healed only by `f` as a side
// effect). The slot and its re-entrancy rule lived in content.ts as a bare
// `let`, which is exactly what made find's callback seam uninvertible; here it
// sits beside the primitive it wraps and the hide/show it drives.
//
// One slot, not a stack, and that is deliberate: there is one screen, and a
// second borrower arriving over a live borrow is a bug, not a nesting.
let screenBorrow: BadgeBorrow | null = null;

/**
 * Take the badge screen if it is not already taken; re-assert the hide if it
 * is.
 *
 * The re-assert half is the load-bearing one. `findImmediate` re-fires the
 * activate path over a LIVE session, and re-borrowing there would snapshot the
 * hidden state the borrow itself caused — the give-back would then conclude the
 * badges had always been hidden and leave the page bare. Re-asserting instead
 * covers the case it is actually for: `f` mid-session re-showed the badges and
 * find still wants the screen.
 */
export function assertBadgeScreenBorrow(): void {
  if (screenBorrow === null) screenBorrow = borrowBadgeScreen();
  else if (screenBorrow.took) hideBadges();
}

/** Give the screen back in the state the borrow found it. Safe on a slot that
 *  was never taken, and safe to call twice — `restore` is itself idempotent,
 *  and every find exit path can reach here. */
export function returnBadgeScreenBorrow(): void {
  screenBorrow?.restore();
  screenBorrow = null;
}

/**
 * Drop the borrow WITHOUT restoring — the slot describes a page that no longer
 * exists (same-document nav).
 *
 * `closeFindMode` is reachable only from `find_close`, the escape cascade and
 * caret, so nothing returned the borrow across an SPA nav and the slot outlived
 * its page. Concretely: find opens over already-hidden badges (`took === false`),
 * the route changes, the user shows badges, find reopens —
 * `assertBadgeScreenBorrow` finds a non-null slot whose `took` is false, does
 * nothing, and the highlights paint under a live badge layer. Same class as the
 * 2026-07-26 field bug.
 *
 * Dropping rather than restoring is the whole subtlety, and it is not a
 * shortcut. `restore()` on a `took === true` borrow kicks the ASYNC
 * `showBadges`, which raises `pageSession.badgesVisible` only after a frame —
 * while the nav path's manual-mode hide reads that flag synchronously on the
 * next line. Restoring here would skip the hide and then paint badges onto a
 * manual-mode page one frame later.
 *
 * What this does NOT fix: an always-mode page whose badges were hidden by a
 * `took === true` borrow stays badge-less across the nav until the next `f`.
 * That is unchanged — a stale slot was never restored either — and it wants the
 * nav path to drive visibility positively rather than only hide, which is a
 * separate change.
 */
export function discardBadgeScreenBorrow(): void {
  screenBorrow = null;
}

/** Test-only reset. */
export function _resetBadgeVisibilityForTesting(): void {
  screenBorrow = null;
}

// --- Popup ⇄ page badge state (notes/DESIGN_ENTRY_POINT_TOPOLOGY.md phase 3) ---
//
// Both handlers used to be branches of content.ts's onMessage chain. They read
// and write exactly what this module owns, so they belong beside it.

export const badgeVisibilityMessageHandlers: Record<string, MessageHandler> = {
  // Only the top frame answers, so the popup receives a single response. The
  // count is this frame's hint candidates; subframe hints aren't aggregated.
  GET_PAGE_STATUS: () =>
    inTopFrame() ? { hintCount: store.all.length, badgesVisible: anyBadgesShowing() } : undefined,

  // Popup Show/Hide button — the UI twin of Shift+F. Sent to every frame (no
  // frameId) so "this page" means the whole page, not just the top frame; each
  // frame drives its own badges. Only the top frame answers, so the popup gets
  // one response to refresh its readout from.
  SET_BADGES_VISIBLE: (m: MessageOf<'SET_BADGES_VISIBLE'>) => {
    const nowShowing = setBadgesVisible(m.visible);
    return inTopFrame() ? { badgesVisible: nowShowing, hintCount: store.all.length } : undefined;
  },
};

// --- Command bindings (notes/DESIGN_ENTRY_POINT_TOPOLOGY.md phase 3b) -------
//
// Registered here rather than in a binding module: this module already reaches
// core/singletons, and it already owns every collaborator both commands need.

export function registerHintModeCommands(): void {
  dispatcher.register('hint_mode', () => {
    // The ambient paint, skipped when an overlay tier already holds codewords
    // — field 2026-07-26: `/ query Enter f`, to type a search badge, repainted
    // every link hint over the results just asked for.
    if (!pageSession.badgesVisible && !overlayCodewordsLive()) { void doScan(); void showBadges(); }
    keyHandler.enterHintMode();
  });

  // The shared Shift+F / voice-"toggle" / popup transition, which is this
  // module's own primitive.
  dispatcher.register('toggle_hints', () => { toggleHints(); });
}
