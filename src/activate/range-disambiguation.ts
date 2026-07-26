/**
 * Range-match disambiguation for the dictated-argument selection verbs
 * ("highlight <phrase>", "select to <phrase>") — when a phrase matches more
 * than one place, paint a codeword chip at each match and let the user pick
 * by voice, instead of silently taking the first match.
 * Design: notes/DESIGN_TEXT_TARGETING.md ("Range-match disambiguation").
 *
 * Deliberately OUTSIDE the hints store: the store feeds occlusion, sweep,
 * snapshot, and prefix-filter machinery that must not see a non-element type.
 * This module is an imperative per-frame singleton — one pending pick at a
 * time, codewords claimed from the real deck via the reservoir (SW pool
 * arbitrates cross-frame uniqueness) and published through label-sync so the
 * shadow accounting stays truthful.
 *
 * The chips themselves are ordinary `HintBadge`es anchored to a Range instead
 * of an element (render/badge-target.ts) and wearing the range-pick variant
 * (render/badge-variant.ts): same stylesheet, APCA colours, size settings,
 * display mode, placement nudges, and reconciler as every link hint. Out of
 * the store, they receive no occlusion verdict and no strict-viewport stamp —
 * which is what we want (a chip hidden under a sticky header would delete an
 * option from a question already asked), and matches rangesInViewport's own
 * geometry-only cut.
 */

import { isAncestorChainInVisibleViewport } from '../lifecycle/strict-viewport';
import { type BandCandidate, bandOverhang, planBandWindow } from '../lifecycle/band-window';
import { VIEWPORT_MARGIN_PX } from '../observe/intersection-tracker';
import { labelReservoir } from '../labels/label-reservoir';
import { poolLabelToAssignment, type LabelAssignment } from '../labels/words';
import { publishRecords, retireRecords, cancelPendingDelete } from '../labels/label-sync';
import { HintBadge } from '../render/hints';
import { rangeTarget } from '../render/badge-target';
import { RANGE_PICK_VARIANT } from '../render/badge-variant';
import { placeBadgeAtRect } from '../placement/position';
import { getDisplayMode } from '../config';
import { flashToast } from '../render/toast';
import { bkLog } from '../debug/bk-log';
import { reportDispatchResult } from '../plugin/resolve';
import type { Message, ScannedElement } from '../types';

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

/** One chip: the range it answers for, its badge, and the label assignment the
 *  prefix filter tests against (kept rather than re-derived from the token on
 *  every progress event). Keyed by codeword in `PendingPick.chips` — one map,
 *  not a codeword→range map beside a codeword→ui map. */
interface Chip {
  range: Range;
  badge: HintBadge;
  label: LabelAssignment;
  /** The `in_strict_viewport` value last published for this codeword. Mirrors
   *  ElementWrapper.lastSentStrictViewport: the window re-publishes only when
   *  a chip crosses the screen edge, not on every scroll. */
  strict: boolean;
}

/**
 * A pick has NO wall-clock expiry: chips stay up until the question they ask is
 * answered (a chip codeword) or the user exits (escape cascade, a replacing
 * pick, a requery that finds nothing). This matches the extension's other modes
 * — caret and palette are explicit-exit mirrors with no timer — and the earlier
 * 12s auto-cancel killed picks mid-hold and mid-codeword. The wedge a timer
 * used to guard (a forgotten pick swallowing every non-chip codeword via
 * refusePickWindowCodeword) is not silent: badges are hidden, chips are painted,
 * and the refusal toast names the exit.
 */
interface PendingPick {
  /** EVERY match the query found, not just the badged ones. Membership is a
   *  rolling viewport window over this list (reconcileRangePickChips), so the
   *  full set has to outlive the arm. */
  ranges: Range[];
  chips: Map<string, Chip>;
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

/**
 * Rank every match by how far outside the viewport it sits, for the shared
 * band planner (lifecycle/band-window.ts) — the same derivation the link
 * badges use to decide which wrappers hold codewords. Chips differ only in
 * budget (nine, not the pool) and in what a claim means.
 *
 * The frame-level check comes first, so a range inside an iframe that is
 * itself scrolled out of view counts as out. Reads Range rects rather than
 * element rects, which is why this can't call stampStrictViewport's helper.
 *
 * Deliberately geometry-only: no occlusion hit-test or CSS-visibility read. A
 * text range under a sticky header is still something the user can reasonably
 * be asked to pick, and the per-member cost those checks carry is meant for
 * hundreds of hint wrappers, not nine chips.
 */
function bandCandidates(ranges: Range[], held: (r: Range) => boolean): BandCandidate<Range>[] {
  if (!isAncestorChainInVisibleViewport(window)) return [];
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const out: BandCandidate<Range>[] = [];
  for (const r of ranges) {
    let rect: DOMRect;
    try { rect = r.getBoundingClientRect(); } catch { continue; }
    // A fully collapsed rect has nowhere to anchor a chip.
    if (rect.width === 0 && rect.height === 0) continue;
    out.push({ item: r, overhang: bandOverhang(rect, vw, vh), held: held(r) });
  }
  return out;
}

/**
 * Plan the window AND keep the overhangs, because match-eligibility needs them
 * separately from membership.
 *
 * Two cuts, exactly as the link badges have them (lifecycle/strict-viewport.ts):
 * the BAND decides who wears a chip (pre-claiming past the fold is what makes a
 * chip already painted when you scroll to it), and the STRICT viewport
 * (overhang 0 — the rect actually intersects the screen) decides who is
 * speakable. A chip you can't see is a scroll-ahead cue, not an answer to the
 * question; saying its codeword must be a no-op, not a pick of something
 * off-screen.
 */
function planChipWindow(ranges: Range[], held: Set<Range>): {
  plan: ReturnType<typeof planBandWindow<Range>>;
  isStrict: (r: Range) => boolean;
} {
  const candidates = bandCandidates(ranges, (r) => held.has(r));
  const overhang = new Map(candidates.map((c) => [c.item, c.overhang]));
  return {
    // hardCap: MAX_RANGE_BADGES is what the overflow toast promises, and the
    // usual case is a dozen matches all on screen at overhang 0 — where
    // tightening has nothing to separate a ninth from a tenth by.
    plan: planBandWindow(candidates, MAX_RANGE_BADGES, VIEWPORT_MARGIN_PX, { hardCap: true }),
    isStrict: (r) => overhang.get(r) === 0,
  };
}

/** The grammar record for one chip. `strict` is the match-eligibility cut —
 *  false means painted-but-not-speakable, the same contract element hints
 *  publish for band-but-not-strict wrappers. */
function chipRecord(codeword: string, strict: boolean): ScannedElement {
  return {
    label: codeword,
    id: 0, // not in the element registry — codeword is the only address
    category: 'view',
    type: 'range_disambiguation',
    adapter: null,
    codeword,
    in_strict_viewport: strict,
  };
}

/** Which ranges currently wear a chip — the planner's `held` input. */
function chippedRanges(): Set<Range> {
  return new Set([...(pending?.chips.values() ?? [])].map((c) => c.range));
}

/** True when a pick is live (optionally: for this specific codeword). */
export function isRangePickPending(codeword?: string): boolean {
  if (!pending) return false;
  return codeword === undefined || pending.chips.has(codeword);
}

/**
 * Is this range on screen right now? The seen-is-pickable predicate, read live
 * rather than from `Chip.strict` — that flag only refreshes at scroll settle,
 * and a dispatch can land mid-scroll. `bandOverhang === 0` is the same strict
 * cut `isRectOnScreen` applies to elements, so chips and hints can't disagree
 * about "on screen".
 */
function isRangeOnScreen(range: Range): boolean {
  if (!isAncestorChainInVisibleViewport(window)) return false;
  let rect: DOMRect;
  try { rect = range.getBoundingClientRect(); } catch { return false; }
  if (rect.width === 0 && rect.height === 0) return false;
  return bandOverhang(rect, window.innerWidth, window.innerHeight) === 0;
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
 * CSS-visibility check. Chips are deliberately occlusion-free (a text range
 * under a sticky header is still a reasonable thing to be asked to pick — see
 * `bandCandidates`), so a chip hidden by an overlay is still pickable. That's
 * a known gap, not parity.
 */
export function resolveRangePick(codeword: string): RangePickOutcome {
  if (!pending) return 'not_mine';
  const range = pending.chips.get(codeword)?.range;
  if (!range) return 'not_mine';
  if (!isRangeOnScreen(range)) {
    flashToast('That match is off screen — scroll to it first');
    bkLog('BK_RANGE_PICK_OFF_SCREEN', { codeword });
    return 'off_screen';
  }
  const onPick = pending.onPick;
  teardown('picked');
  onPick(range);
  return 'picked';
}

/** Cancel any pending pick (new arm replaces old, escape, requery). */
export function cancelRangePick(reason: string): void {
  if (pending) teardown(reason);
}

/**
 * Pick-window codeword guard: while chips are up they OWN the codewords — a
 * stray badge codeword must not click a link out from under the question the
 * chips are asking. Returns true when the codeword was swallowed (the caller
 * stops); flashes guidance and reports the refusal. The pick stays live —
 * "escape" or the timeout ends it, then the badges and their codewords come
 * back.
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
 * Mid-pair progress on the chips — literally the same two calls the store
 * hints get (`setFiltered` / `setMatchedChars`); the range-pick variant is
 * what makes them read differently: non-candidates dim in place instead of
 * disappearing, and the spoken prefix goes gold instead of fading. `prefix` is
 * the SW-translated letter form; '' resets (pair cancelled).
 *
 * Returns true iff a pick is live, so the caller (content's progress handler)
 * routes progress HERE instead of the store hints — without this, speaking a
 * chip's first word re-showed the very badges the pick window just hid.
 */
export function filterRangePickChips(prefix: string): boolean {
  if (!pending) return false;
  for (const { badge, label } of pending.chips.values()) {
    const matches = prefix !== '' && label.letter.startsWith(prefix);
    badge.setFiltered(prefix !== '' && !matches);
    // Arbitrary prefix lengths and every display mode, inherited — no
    // charAt(0) special case for exactly two words.
    badge.setMatchedChars(matches ? prefix.length : 0);
  }
  return true;
}

/**
 * Start a disambiguation pick over the given ranges: claim codewords, paint a
 * chip at each range, publish the codewords for matching, and wait for
 * resolveRangePick / an explicit cancel. Ranges beyond MAX_RANGE_BADGES are
 * dropped with a visible toast (no silent truncation).
 */
export function startRangePick(ranges: Range[], onPick: (range: Range) => void): void {
  cancelRangePick('replaced');

  // Badge what the user can actually see, nearest first. Document order alone
  // put the 9 chips wherever the phrase happened to appear, so on a long page
  // they landed below the fold and the user had to scroll to find the question
  // being asked (field report 2026-07-25). The shared band planner is the same
  // rule the link badges claim by, so chips and hints agree on which
  // viewport-ranked things are worth a scarce codeword.
  //
  const { plan, isStrict } = planChipWindow(ranges, new Set());
  const picked = plan.toClaim;
  if (picked.length === 0) {
    // Nothing within a band of the viewport — every match is far away, or this
    // is a background frame. Badging by document order here would arm a
    // question made of chips the user can't see, and (correctly) can't speak:
    // a wedge dressed as a UI. Act on the first match instead, which scrolls it
    // into view — the same thing the single-match case does. If it's the wrong
    // one, saying "highlight" again now has matches in view and gets chips.
    bkLog('BK_RANGE_PICK_NONE_IN_BAND', { matches: ranges.length });
    onPick(ranges[0]);
    return;
  }

  // `pending` is set before the chips exist so addChips has somewhere to write;
  // the badge-hiding hook runs only once at least one chip is real.
  pending = { ranges, chips: new Map(), onPick, restoreBadges: false };
  const added = addChips(picked, isStrict);
  if (added === 0) {
    // Pool dry or alphabet not loaded — fall back to today's behavior.
    pending = null;
    bkLog('BK_RANGE_PICK_NO_LABELS', { ranges: picked.length });
    onPick(picked[0]);
    return;
  }
  pending.restoreBadges = pickWindowHooks?.hideBadges() ?? false;

  bkLog('BK_RANGE_PICK_START', {
    matches: ranges.length, inBand: plan.toClaim.length, badged: added, margin: plan.margin,
  });
  if (ranges.length > added) {
    // Name the scope so "9 of 105" doesn't read as an arbitrary truncation:
    // the rest are further from the viewport, and scrolling brings them their
    // own chips.
    flashToast(`${ranges.length} matches — showing the ${added} nearest, scroll for the rest`);
  }
}

/**
 * Re-derive WHICH matches wear a chip, as a rolling window over the viewport.
 *
 * Membership and positioning are separate questions and this is the membership
 * half: the badge seam made a chip follow its phrase, but a match that was
 * below the fold at arm time still had no codeword, so scrolling to it showed
 * nothing (field report 2026-07-25, round 2). This is the same answer the hint
 * badges give — band membership converges on the viewport — scaled down to
 * nine chips and one imperative pass.
 *
 * Driven by the settle engine's existing `afterScrollSettle` hook (content.ts),
 * so it adds no observer, timer or listener: it consumes a signal that already
 * fires when a scroll storm ends.
 *
 * Codewords are STABLE for a match that stays in view — a chip you were reading
 * doesn't get renamed under you. Departing codewords are released BEFORE the
 * arrivals claim, so scrolling a long page recycles the same nine rather than
 * draining the pool.
 */
export function reconcileRangePickChips(): void {
  if (!pending) return;
  const { plan, isStrict } = planChipWindow(pending.ranges, chippedRanges());
  // Nothing would remain in band: keep what's painted rather than going to
  // zero, which leaves a pick that swallows every codeword
  // (refusePickWindowCodeword) with nothing on screen to explain why — the
  // exact wedge the no-timer decision rests on NOT being silent. Scrolling
  // back restores the chips anyway.
  const wouldEmpty = plan.toKeep.length === 0 && plan.toClaim.length === 0;
  if ((plan.toClaim.length > 0 || plan.toDrop.length > 0) && !wouldEmpty) {
    // Release first so the arrivals can reclaim the very codewords that just
    // left (the reservoir returns them to the front).
    if (plan.toDrop.length > 0) {
      const dropped = new Set(plan.toDrop);
      const gone: string[] = [];
      for (const [cw, chip] of [...pending.chips]) {
        if (!dropped.has(chip.range)) continue;
        chip.badge.remove();
        pending.chips.delete(cw);
        gone.push(cw);
      }
      retireRecords(gone);
      labelReservoir.release(gone);
    }
    const added = addChips(plan.toClaim, isStrict);

    if (pending.chips.size === 0) {
      // Everything left the band and nothing could be claimed to replace it.
      // Fail loud rather than leaving a live pick with no chips.
      flashToast('Lost the highlighted matches — say "highlight" again');
      teardown('reconcile_empty');
      return;
    }
    bkLog('BK_RANGE_PICK_RECONCILE', {
      dropped: plan.toDrop.length, added, live: pending.chips.size, margin: plan.margin,
    });
    // An add republishes the narrow once its records land (addChips); a pure
    // departure has no publish to ride, so shrink the narrow now.
    if (added === 0) publishPickWindow([...pending.chips.keys()]);
  }

  // LAST, and unconditionally: match-eligibility moves independently of
  // membership — a chip that merely crossed the screen edge keeps its codeword
  // and flips speakable, which happens on scrolls that change nothing else.
  // After the mutations, so chips that were just dropped aren't re-sent on
  // their way out.
  republishStrictFlags(isStrict);
}

/**
 * Re-publish the match-eligibility flag for chips that crossed the screen edge
 * — a scroll-ahead chip becoming speakable as it arrives, or a chip that slid
 * off becoming a no-op while it keeps its codeword. Delta only: unchanged
 * chips are not re-sent, mirroring the wrapper path's lastSentStrictViewport.
 */
function republishStrictFlags(isStrict: (r: Range) => boolean): void {
  if (!pending) return;
  const records: ScannedElement[] = [];
  for (const [cw, chip] of pending.chips) {
    const strict = isStrict(chip.range);
    if (strict === chip.strict) continue;
    chip.strict = strict;
    records.push(chipRecord(cw, strict));
  }
  if (records.length === 0) return;
  bkLog('BK_RANGE_PICK_STRICT', { changed: records.map((r) => r.codeword) });
  void publishRecords(records);
}

/**
 * Claim codewords for `ranges`, paint a chip on each, publish them for
 * matching, and re-arm the projection narrow over the full live set. Returns
 * how many chips were painted. Shared by the arm and the rolling window so
 * there is one claim/paint/publish path, not two that must agree.
 */
function addChips(ranges: Range[], isStrict: (r: Range) => boolean): number {
  if (!pending || ranges.length === 0) return 0;
  const codewords = labelReservoir.claim(ranges.length).filter((cw) => cw !== '');
  if (codewords.length === 0) return 0;

  const chips = pending.chips;
  const records: ScannedElement[] = [];
  const minted: string[] = [];
  for (let i = 0; i < ranges.length && i < codewords.length; i++) {
    const strict = isStrict(ranges[i]);
    // This codeword may have been released moments ago by the drop half of the
    // window (or by a replaced pick's teardown) and handed straight back by the
    // reservoir's sticky reclaim. That retire is queued for the DEBOUNCED
    // batch while the publish below goes out immediately — so without this the
    // delete lands after the put and strips a live chip from the hint
    // collections, leaving its Discovery HUD suffix menu empty.
    cancelPendingDelete(codewords[i]);
    chips.set(codewords[i], { ...paintChip(ranges[i], codewords[i]), strict });
    minted.push(codewords[i]);
    records.push(chipRecord(codewords[i], strict));
  }

  void publishRecords(records).then((admitted) => {
    // Rejected codewords (pool race, plugin refusal) can never be spoken —
    // drop their chips so a painted badge always implies a working pick.
    if (!pending || pending.chips !== chips) return;
    for (const cw of minted) {
      if (!admitted.has(cw)) {
        chips.get(cw)?.badge.remove();
        chips.delete(cw);
      }
    }
    if (chips.size === 0) {
      teardown('nothing_admitted');
      return;
    }
    // Arm the projection narrow only now, with the ADMITTED set: arming before
    // the publish lands would filter the chips out of the projection too (the
    // plugin hasn't stored them yet), blanking the HUD instead of narrowing it.
    publishPickWindow([...chips.keys()]);
  });

  return minted.length;
}

function teardown(reason: string): void {
  if (!pending) return;
  const { chips, restoreBadges } = pending;
  pending = null;
  for (const { badge } of chips.values()) badge.remove();
  if (restoreBadges) pickWindowHooks?.showBadges();
  // Release the projection narrow before retiring the codewords: the retire is
  // debounced, so releasing first means the page's own hints are back in the
  // HUD immediately rather than after the next sync.
  publishPickWindow([]);
  const codewords = [...chips.keys()];
  retireRecords(codewords);
  labelReservoir.release(codewords);
  bkLog('BK_RANGE_PICK_END', { reason, released: codewords.length });
}

/**
 * One codeword chip: an ordinary badge anchored to the range.
 *
 * Order matters — construct, show (which renders the text, so the box has a
 * measurable size), then place against the range's rect. Same order
 * showBadges + placeBadges use for element hints, and the same reason.
 *
 * Registration with the batched reconciler comes free with the badge, so a
 * chip follows its phrase through scroll and layout shift instead of stranding
 * where the text used to be. The one thing that took a fix elsewhere: the
 * settle-driven reposition pass used to gate on `badgesVisible`, which a pick
 * deliberately turns off — see SettleEngine.scheduleReposition.
 */
function paintChip(range: Range, token: string): Chip {
  const label = poolLabelToAssignment(token);
  const target = rangeTarget(range);
  const badge = new HintBadge(target, label, getDisplayMode(), RANGE_PICK_VARIANT);
  badge.show();
  placeBadgeAtRect(badge, target.element, target.rect());
  return { range, badge, label, strict: false };
}
