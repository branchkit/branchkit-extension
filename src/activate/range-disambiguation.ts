/**
 * Range-match disambiguation for the dictated-argument selection verbs
 * ("highlight <phrase>", "select to <phrase>") — when a phrase matches more
 * than one place, badge each match and let the user pick one by voice, instead
 * of silently taking the first.
 * Design: notes/DESIGN_TEXT_TARGETING.md ("Range-match disambiguation") and
 * notes/DESIGN_BADGE_TARGET_SEAM.md.
 *
 * This module is POLICY. The badges themselves — claiming from the pool,
 * converging on the viewport, following their text, reaping dead ranges,
 * registering as a CodewordHolder — are a `RangeBadgeSet`
 * (render/range-badge-set.ts), which search-match badges will share. What lives
 * here is what makes a pick a QUESTION rather than an overlay:
 *
 *   - it is modal: the page's own badges hide for the duration, so the screen
 *     shows exactly what's speakable;
 *   - it OWNS the codewords: a stray badge codeword must not click a link out
 *     from under the question (refusePickWindowCodeword), and the plugin-side
 *     projection narrows to the chips so the HUD advertises only them;
 *   - it is singular: one pending question at a time, answered or exited.
 *
 * Search will want none of those — it should ADD badges alongside link hints —
 * which is exactly why they are here and not in the set.
 */

import { RangeBadgeSet } from '../render/range-badge-set';
import { RANGE_PICK_VARIANT } from '../render/badge-variant';
import { flashToast } from '../render/toast';
import { bkLog } from '../debug/bk-log';
import { reportDispatchResult } from '../plugin/resolve';
import type { Message } from '../types';

/**
 * Tell the plugin which codewords the chips own, so the hint projection (and
 * with it the Discovery HUD) narrows to exactly them for the pick's duration.
 * Empty = release. Without this the HUD keeps listing the whole page's hints —
 * second words that refusePickWindowCodeword is about to swallow.
 *
 * Fully defensive: teardown runs on the orphan path (quiesceOrphan), where an
 * invalidated context makes sendMessage throw SYNCHRONOUSLY — a bare .catch()
 * would let that escape and abort the rest of the teardown. The plugin's own
 * drains cover a release that never leaves.
 */
function publishPickWindow(codewords: string[]): void {
  // Breadcrumb on the content-script side of the hop: paired with the plugin's
  // ARMED/RELEASE/REFUSED lines, this says which end dropped the narrow.
  bkLog('BK_RANGE_PICK_WINDOW', { codewords });
  try {
    chrome.runtime.sendMessage({ type: 'RANGE_PICK', codewords } as Message).catch(() => {});
  } catch { /* context invalidated — the plugin's drains release it */ }
}

/** Most matches we'll badge — beyond this the phrase is too generic to pick
 * by eye anyway; the toast tells the user to say more words. */
export const MAX_RANGE_BADGES = 9;

/**
 * A pick has NO wall-clock expiry: chips stay up until the question they ask is
 * answered (a chip codeword) or the user exits — voice "escape", the Escape
 * key, a replacing pick, a requery that finds nothing, or an SPA nav. This
 * matches the extension's other modes (caret and palette are explicit-exit
 * mirrors with no timer) and the earlier 12s auto-cancel killed picks mid-hold
 * and mid-codeword.
 *
 * The wedge a timer used to guard is a forgotten pick swallowing every non-chip
 * codeword via refusePickWindowCodeword. What makes that survivable is that it
 * is never SILENT — and every way it could have gone silent is now closed
 * rather than assumed: dead ranges are reaped, an SPA nav cancels, and the
 * reservoir's 30s leak sweep no longer reclaims a live pick's codewords (that
 * WAS a wall clock, and this claim was false while it stood). With those
 * closed: badges are hidden, chips are painted, the refusal toast names the
 * exit, and Escape works even if voice doesn't.
 */
interface PendingPick {
  chips: RangeBadgeSet;
  onPick: (range: Range) => void;
  /** Regular badges were visible at pick start — restore them on teardown. */
  restoreBadges: boolean;
}

let pending: PendingPick | null = null;

/**
 * Pick-window badge hooks, injected by content.ts (badge visibility lives in
 * the content monolith — injection avoids the import cycle). While chips are
 * up they OWN the codewords, so the regular badges hide for the window and
 * the screen shows exactly what's speakable (user decision 2026-07-25);
 * restored on teardown only if they were visible at start. Purely visual —
 * grammar publication is untouched, per-frame like the pick itself.
 */
interface PickWindowHooks {
  /** Hide regular badges; returns whether they were visible (for restore). */
  hideBadges: () => boolean;
  showBadges: () => void;
}
let pickWindowHooks: PickWindowHooks | null = null;
export function setPickWindowHooks(h: PickWindowHooks): void {
  pickWindowHooks = h;
}

/** True when a pick is live (optionally: for this specific codeword). */
export function isRangePickPending(codeword?: string): boolean {
  if (!pending) return false;
  return codeword === undefined || pending.chips.has(codeword);
}

export type RangePickOutcome =
  /** The codeword named a chip the user can see; the pick fired. */
  | 'picked'
  /** The codeword is this pick's, but its match is off screen — refused. */
  | 'off_screen'
  /** Not a chip codeword; the caller continues to element resolution. */
  | 'not_mine';

/**
 * Consume a spoken codeword if it belongs to the pending pick.
 *
 * Seen-is-pickable, enforced live at dispatch — the same rule the element path
 * applies in content's `sealedDispatchSeen`, for the same reason. The band
 * paints chips past the fold as a scroll-ahead cue, so a chip can hold a
 * codeword the user has never read; acting on it would be acting on something
 * they can't see, which they could only have said by accident. Refusing keeps
 * the pick live — scroll to the match and the same codeword works.
 *
 * Narrower than the element gate on purpose: geometry only, no occlusion or
 * CSS-visibility check (see RangeBadgeSet's band candidates), so a chip hidden
 * by an overlay is still pickable. That's a known gap, not parity.
 */
export function resolveRangePick(codeword: string): RangePickOutcome {
  if (!pending) return 'not_mine';
  const range = pending.chips.rangeFor(codeword);
  if (!range) return 'not_mine';
  if (!pending.chips.isOnScreen(codeword)) {
    flashToast('That match is off screen — scroll to it first');
    bkLog('BK_RANGE_PICK_OFF_SCREEN', { codeword });
    return 'off_screen';
  }
  const onPick = pending.onPick;
  teardown('picked');
  onPick(range);
  return 'picked';
}

/** Cancel any pending pick (new arm replaces old, escape, requery, nav). */
export function cancelRangePick(reason: string): void {
  if (pending) teardown(reason);
}

/**
 * Pick-window codeword guard: while chips are up they OWN the codewords — a
 * stray badge codeword must not click a link out from under the question the
 * chips are asking. Returns true when the codeword was swallowed (the caller
 * stops); flashes guidance and reports the refusal. The pick stays live —
 * "escape" (voice or the Escape key) ends it, then the badges and their
 * codewords come back.
 */
export function refusePickWindowCodeword(action: string, codeword: string): boolean {
  if (!pending || pending.chips.has(codeword)) return false;
  flashToast('Pick a highlighted match — or say "escape"');
  reportDispatchResult({
    action, codeword, resolution: 'range_pick', elem_tag: '',
    taken: 'skipped', ok: false,
    frame: `${location.origin}${location.pathname}`.slice(0, 200),
    detail: 'pick pending — codeword is not a chip', fp: '',
  });
  return true;
}

/**
 * Mid-pair progress on the chips — literally the same calls the store hints
 * get; the range-pick variant is what makes them read differently. `prefix` is
 * the SW-translated letter form; '' resets (pair cancelled).
 *
 * Returns true iff a pick is live, so the caller (content's progress handler)
 * routes progress HERE instead of the store hints — without this, speaking a
 * chip's first word re-showed the very badges the pick window just hid.
 */
export function filterRangePickChips(prefix: string): boolean {
  if (!pending) return false;
  pending.chips.filterByPrefix(prefix);
  return true;
}

/**
 * Start a disambiguation pick over the given ranges. Ranges beyond
 * MAX_RANGE_BADGES are dropped with a visible toast (no silent truncation).
 */
export function startRangePick(ranges: Range[], onPick: (range: Range) => void): void {
  cancelRangePick('replaced');

  const chips = RangeBadgeSet.create({
    ranges,
    variant: RANGE_PICK_VARIANT,
    budget: MAX_RANGE_BADGES,
    logTag: 'BK_RANGE_PICK',
    // Arm the plugin-side narrow with whatever is live, whenever that changes.
    onMembershipChanged: (codewords) => publishPickWindow(codewords),
    onEmpty: () => {
      // The set gave everything back (ranges died, or nothing was admitted).
      // Fail loud rather than leaving a live pick with no chips.
      pending = null;
      publishPickWindow([]);
      if (restoreOnEmpty) pickWindowHooks?.showBadges();
      flashToast('Lost the highlighted matches — say "highlight" again');
    },
  });

  if (chips === null) {
    // Nothing within a band of the viewport, or the pool is dry. Badging by
    // document order here would arm a question made of chips the user can't
    // see and (correctly) can't speak: a wedge dressed as a UI. Act on the
    // first match instead, which scrolls it into view — the same thing the
    // single-match case does. If it's the wrong one, saying "highlight" again
    // now has matches in view and gets chips.
    bkLog('BK_RANGE_PICK_NOT_ARMED', { matches: ranges.length });
    onPick(ranges[0]);
    return;
  }

  const restoreBadges = pickWindowHooks?.hideBadges() ?? false;
  restoreOnEmpty = restoreBadges;
  pending = { chips, onPick, restoreBadges };

  if (ranges.length > chips.size) {
    // Name the scope so "9 of 105" doesn't read as an arbitrary truncation:
    // the rest are further from the viewport, and scrolling brings them their
    // own chips.
    flashToast(`${ranges.length} matches — showing the ${chips.size} nearest, scroll for the rest`);
  }
}

// `onEmpty` can fire from inside RangeBadgeSet.create, before `pending` exists,
// so the restore flag it needs is held here rather than read off `pending`.
let restoreOnEmpty = false;

/**
 * Re-derive which matches wear a chip, as a rolling window over the viewport.
 * Driven by the settle engine's existing `afterScrollSettle` hook (content.ts),
 * so it adds no observer, timer or listener.
 */
export function reconcileRangePickChips(): void {
  pending?.chips.reconcile();
}

function teardown(reason: string): void {
  if (!pending) return;
  const { chips, restoreBadges } = pending;
  pending = null;
  chips.dispose(reason);
  if (restoreBadges) pickWindowHooks?.showBadges();
  // Release the projection narrow AFTER the set gave its codewords back, so the
  // page's own hints are what the HUD falls back to.
  publishPickWindow([]);
}
