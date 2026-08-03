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
 * (render/range-badge-set.ts), which search-match badges share. What lives
 * here is what makes a pick a QUESTION rather than an overlay:
 *
 *   - it is modal: the page's own badges hide for the duration, so the screen
 *     shows exactly what's speakable;
 *   - it OWNS the codewords: `claim: 'exclusive'` in the holder registry
 *     (labels/holder-registry.ts) — while the chips are up, the registry
 *     swallows every non-chip codeword so a stray badge codeword cannot click
 *     a link out from under the question, and the plugin-side projection
 *     narrows to the chips so the HUD advertises only them;
 *   - it is singular: one pending question at a time, answered or exited.
 *
 * Search wants none of those — it ADDS badges alongside link hints — which is
 * exactly why they are here and not in the set.
 */

import { RangeBadgeSet } from '../render/range-badge-set';
import type { AnchorKind } from '../placement/position';
import { RANGE_PICK_VARIANT } from '../render/badge-variant';
import { flashToast } from '../render/toast';
import { clearFindPaint } from '../scan/find';
import { bkLog } from '../debug/bk-log';
import { EXCLUSIVE_OVERLAY_PRIORITY, type HolderOutcome } from '../labels/holder-registry';
import { modes } from '../core/modes';
import { setInnerTransientProbe } from '../core/mode-stack';
import { keyHandler } from '../core/singletons';
import { borrowBadgeScreen, type BadgeBorrow } from '../render/badge-visibility';
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
}

let pending: PendingPick | null = null;

/**
 * The page state a pick borrows and owes back: which badges were up AND
 * whether hint mode was live. Recorded as the range_pick entry's FLOOR
 * PAYLOAD — `modes.push('range_pick', entry)` records it, the pop at teardown
 * hands it back — instead of the hand-kept `PickEntryState`/`pickWindowHooks`
 * pair this retires (Wave 3 C3b; the stack records a floor for every mode
 * rather than for the one that grew its own).
 *
 * While chips are up they OWN the codewords, so the regular badges hide for
 * the window and the screen shows exactly what's speakable (user decision
 * 2026-07-25), and the keyboard captures codeword keys — a question asked in
 * codewords has to be answerable in them, by either input. The badge half is
 * the shared borrow primitive (render/badge-visibility.ts — the same one the
 * find bar rides) and the keyboard half goes through the singleton; the
 * keyboard snapshot MUST be read before the borrow — hiding the badges also
 * exits hint mode. `isHintMode()` is the honest unranked read, so a pick
 * armed from hint mode while caret was also live restores hint correctly
 * (the old getMode()-ranked snapshot's known gap).
 */
interface PickEntry {
  borrow: BadgeBorrow;
  hintMode: boolean;
}

// The pick's intra-mode transient: the letters typed at a chip. It IS hint
// mode's typed prefix, registered under the pick's own id rather than
// inventing a second one. Alongside the caret's probe in
// selection-commands.ts: the mode that owns the transient wires it.
//
// Needed because BOTH stack orders are reachable, and peelTop only ever asks
// the TOP spec:
//   f, then a pick arms      → [hint, range_pick]  ← this probe answers
//   a pick arms, then f      → [range_pick, hint]  ← hint's own probe answers
// The first order is the one that used to lose the letters: Escape cancelled
// the whole pick when the user meant to unsay a keystroke.
setInnerTransientProbe('range_pick', () => keyHandler.peelHintPrefix());

/**
 * Take the screen, and DON'T take the keyboard.
 *
 * The pick used to call enterHintMode() here, on the reasoning that chips
 * exist to be typed at so the keyboard should already be handed over. The cost
 * is the whole Normal-mode keymap: in hint mode bare letters are codeword
 * input, so j/k stopped scrolling the moment chips appeared — and the matches
 * a pick is asking about are frequently off-screen, which is exactly when
 * scrolling matters (field, 2026-07-27).
 *
 * `f` is the one gesture that hands the keyboard over, for chips the same as
 * for link hints. Badges being VISIBLE and badges being TYPABLE are separate
 * states here — that separation is the whole reason hints can stay painted for
 * voice without eating the keymap — and a pick is not a reason to collapse it.
 * Voice is unaffected either way: a spoken codeword resolves through the
 * holder registry and never consults keyboard mode.
 */
function borrowScreen(): PickEntry {
  const hintMode = keyHandler.isHintMode(); // before the borrow's hide
  const borrow = borrowBadgeScreen();
  return { borrow, hintMode };
}

function restoreScreen(entry: PickEntry, restoreBadges = true): void {
  if (restoreBadges) entry.borrow.restore();
  // enterHintMode clears the codeword filter, which is right on both edges:
  // the badges the pick hid are repainted unfiltered, so a prefix typed
  // before the pick no longer names anything on screen.
  if (entry.hintMode) keyHandler.enterHintMode();
  else keyHandler.exitHintMode();
}

/** True when a pick is live (optionally: for this specific codeword). */
export function isRangePickPending(codeword?: string): boolean {
  if (!pending) return false;
  return codeword === undefined || pending.chips.has(codeword);
}

/**
 * The pick's resolve policy (RangeHolderSpec.resolve — the registry routes
 * both input paths here through the holder the set registers).
 *
 * Seen-is-pickable, enforced live at dispatch — the same rule the element path
 * applies in `sealedDispatchSeen` (activate/sealed-gate.ts, which is where it
 * moved when the BRANCHKIT_ACTION split left its two callers on opposite
 * sides of a module boundary), for the same reason. The band
 * paints chips past the fold as a scroll-ahead cue, so a chip can hold a
 * codeword the user has never read; acting on it would be acting on something
 * they can't see, which they could only have said by accident. Refusing keeps
 * the pick live — scroll to the match and the same codeword works.
 *
 * Narrower than the element gate on purpose: geometry only, no occlusion or
 * CSS-visibility check (see RangeBadgeSet's band candidates), so a chip hidden
 * by an overlay is still pickable. That's a known gap, not parity.
 */
function resolvePickCodeword(codeword: string): HolderOutcome {
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
  return 'acted';
}

/** Cancel any pending pick (new arm replaces old, escape, requery, nav). */
/**
 * End a pending pick.
 *
 * `restoreBadges: false` tears down WITHOUT giving the badge screen back, for
 * the one caller where giving it back is wrong: a same-document navigation.
 * The borrow is a snapshot of the page the nav replaced, and `restore()` kicks
 * an ASYNC showBadges that raises pageSession.badgesVisible a frame later —
 * while the nav path reads that flag synchronously to decide whether the new
 * page starts hidden. Restoring here makes the nav skip its own hide and then
 * paint badges onto a manual-mode page one frame after it decided not to. The
 * keyboard half of the restore still runs: a nav must not leave the user in a
 * hint mode entered for chips that no longer exist.
 */
export function cancelRangePick(reason: string, restoreBadges = true): void {
  if (pending) teardown(reason, restoreBadges);
}

/**
 * Start a disambiguation pick over the given ranges. Ranges beyond
 * MAX_RANGE_BADGES are dropped with a visible toast (no silent truncation).
 *
 * The set registers as an EXCLUSIVE CodewordHolder for the chips' lifetime,
 * which is what makes the pick a question: mid-pair progress routes to the
 * chips alone, the keyboard's accept gate answers for them alone, and a
 * codeword nothing holds is SWALLOWED by the registry rather than falling
 * through to hints the window hid (the callers own the refusal toast). The
 * prefix/sole/narrow surface that used to be exported from here is the
 * holder's now — one order, derived, both inputs.
 */
export function startRangePick(
  ranges: Range[],
  onPick: (range: Range) => void,
  opts?: { anchor?: AnchorKind },
): void {
  cancelRangePick('replaced');

  const chips = RangeBadgeSet.create({
    ranges,
    anchor: opts?.anchor,
    variant: RANGE_PICK_VARIANT,
    budget: MAX_RANGE_BADGES,
    logTag: 'BK_RANGE_PICK',
    holder: {
      id: 'pick',
      priority: EXCLUSIVE_OVERLAY_PRIORITY,
      claim: 'exclusive',
      resolve: (cw) => resolvePickCodeword(cw),
      // The registry's dispose fan-out (orphan teardown) must end the whole
      // QUESTION, not just the chips: release the plugin-side projection
      // narrow, give back the entry state, clear the find paint. The set's
      // own dispose would strand `pending` behind a dead set.
      dispose: (reason) => cancelRangePick(reason),
    },
    // Arm the plugin-side narrow with whatever is live, whenever that changes.
    onMembershipChanged: (codewords) => publishPickWindow(codewords),
    onEmpty: () => {
      // The set gave everything back (ranges died, or nothing was admitted).
      // Fail loud rather than leaving a live pick with no chips. The floor
      // rides the stack entry, so this exit path cannot hold its own copy —
      // the pop hands back whatever push recorded, even when onEmpty fires
      // from inside create (the entry is pushed before the set can empty).
      pending = null;
      const floor = modes.pop('range_pick');
      clearFindPaint();
      publishPickWindow([]);
      if (floor) restoreScreen(floor.payload as PickEntry);
      flashToast('Lost the highlighted matches — try again');
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

  // Borrow the screen (snapshot, hide, capture the keyboard), then push with
  // the snapshot as the entry's FLOOR — the pop at whichever exit runs hands
  // it back. Hiding the badges exits hint mode, so the borrow reads first;
  // the pick lands above whatever the user was in, temporally.
  const entry = borrowScreen();
  pending = { chips, onPick };
  modes.push('range_pick', entry);

  if (ranges.length > chips.size) {
    // Name the scope so "9 of 105" doesn't read as an arbitrary truncation:
    // the rest are further from the viewport, and scrolling brings them their
    // own chips.
    flashToast(`${ranges.length} matches — showing the ${chips.size} nearest, scroll for the rest`);
  }
}

// (Settle-driven chip reconciliation is the registered holder's now — the
// registry's reconcileAll fan-out reaches the set directly, every kind.)

function teardown(reason: string, restoreBadges = true): void {
  if (!pending) return;
  const { chips } = pending;
  pending = null;
  const floor = modes.pop('range_pick');
  chips.dispose(reason);
  // The candidates were painted by the phrase box and handed over for the
  // pick's lifetime — the question is now answered (or abandoned), so the
  // marking goes with it. Every exit routes through here, which is why paint
  // ownership can safely cross the module boundary at all.
  clearFindPaint();
  // Badges and keyboard together: whatever the pick borrowed, the recorded
  // floor gives back — except on a nav, where the caller owns visibility and
  // the badge half must not fire (see cancelRangePick).
  if (floor) restoreScreen(floor.payload as PickEntry, restoreBadges);
  // Release the projection narrow AFTER the set gave its codewords back, so the
  // page's own hints are what the HUD falls back to.
  publishPickWindow([]);
}
