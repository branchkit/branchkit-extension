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
import { labelReservoir } from '../labels/label-reservoir';
import { poolLabelToAssignment, type LabelAssignment } from '../labels/words';
import { publishRecords, retireRecords } from '../labels/label-sync';
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

/** One chip: its badge, plus the label assignment the prefix filter tests
 *  against (kept rather than re-derived from the token on every progress
 *  event). */
interface Chip {
  badge: HintBadge;
  label: LabelAssignment;
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
  byCodeword: Map<string, Range>;
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
 * The subset of `ranges` currently on screen in this frame. Mirrors the
 * geometry cut in stampStrictViewport (lifecycle/strict-viewport.ts) — including
 * its ancestor-chain check, so a range inside an iframe that is itself scrolled
 * out of view counts as off-screen — but reads Range rects rather than element
 * rects, which is why it can't call that helper directly.
 *
 * Deliberately geometry-only: no occlusion hit-test or CSS-visibility read. A
 * text range under a sticky header is still something the user can reasonably
 * be asked to pick, and the per-member cost those checks carry is meant for
 * hundreds of hint wrappers, not nine chips.
 */
function rangesInViewport(ranges: Range[]): Range[] {
  if (!isAncestorChainInVisibleViewport(window)) return [];
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  return ranges.filter((r) => {
    let rect: DOMRect;
    try { rect = r.getBoundingClientRect(); } catch { return false; }
    // A fully collapsed rect has nowhere to anchor a chip.
    if (rect.width === 0 && rect.height === 0) return false;
    return rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw;
  });
}

/** True when a pick is live (optionally: for this specific codeword). */
export function isRangePickPending(codeword?: string): boolean {
  if (!pending) return false;
  return codeword === undefined || pending.byCodeword.has(codeword);
}

/**
 * Consume a spoken codeword if it belongs to the pending pick. Returns true
 * when consumed (the caller must NOT fall through to element activation).
 */
export function resolveRangePick(codeword: string): boolean {
  if (!pending) return false;
  const range = pending.byCodeword.get(codeword);
  if (!range) return false;
  const onPick = pending.onPick;
  teardown('picked');
  onPick(range);
  return true;
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
  if (!pending || pending.byCodeword.has(codeword)) return false;
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

  // Badge what the user can actually see. Document order alone put the 9 chips
  // wherever the phrase happened to appear first, so on a long page they landed
  // below the fold and the user had to scroll to find the question being asked
  // (field report 2026-07-25). Same on-screen predicate the strict-viewport
  // stamp uses for hint badges, so chips and hints agree on "visible".
  //
  // Fallback when nothing is in view: badge by document order as before, rather
  // than dead-ending a command the user just spoke.
  const visible = rangesInViewport(ranges);
  const pool = visible.length > 0 ? visible : ranges;
  const overflow = pool.length - MAX_RANGE_BADGES;
  const picked = pool.slice(0, MAX_RANGE_BADGES);
  const codewords = labelReservoir.claim(picked.length).filter(cw => cw !== '');
  if (codewords.length === 0) {
    // Pool dry or alphabet not loaded — fall back to today's behavior.
    bkLog('BK_RANGE_PICK_NO_LABELS', { ranges: picked.length });
    onPick(picked[0]);
    return;
  }

  const byCodeword = new Map<string, Range>();
  const chips = new Map<string, Chip>();
  const records: ScannedElement[] = [];
  for (let i = 0; i < picked.length && i < codewords.length; i++) {
    byCodeword.set(codewords[i], picked[i]);
    chips.set(codewords[i], paintChip(picked[i], codewords[i]));
    records.push({
      label: codewords[i],
      id: 0, // not in the element registry — codeword is the only address
      category: 'view',
      type: 'range_disambiguation',
      adapter: null,
      codeword: codewords[i],
      in_strict_viewport: true, // matchability gate — these must be eligible
    });
  }

  const restoreBadges = pickWindowHooks?.hideBadges() ?? false;
  pending = { byCodeword, chips, onPick, restoreBadges };

  void publishRecords(records).then((admitted) => {
    // Rejected codewords (pool race, plugin refusal) can never be spoken —
    // drop their chips so a painted badge always implies a working pick.
    if (!pending || pending.byCodeword !== byCodeword) return;
    for (const [cw] of byCodeword) {
      if (!admitted.has(cw)) {
        chips.get(cw)?.badge.remove();
        chips.delete(cw);
        byCodeword.delete(cw);
      }
    }
    if (byCodeword.size === 0) {
      teardown('nothing_admitted');
      return;
    }
    // Arm the projection narrow only now, with the ADMITTED set: arming before
    // the publish lands would filter the chips out of the projection too (the
    // plugin hasn't stored them yet), blanking the HUD instead of narrowing it.
    publishPickWindow([...byCodeword.keys()]);
  });

  bkLog('BK_RANGE_PICK_START', {
    matches: ranges.length, inView: visible.length, badged: byCodeword.size,
  });
  if (overflow > 0) {
    // Name the scope so "9 of 105" doesn't read as an arbitrary truncation:
    // the rest are off-screen, and scrolling then re-asking reaches them.
    flashToast(visible.length > 0
      ? `${pool.length} matches in view of ${ranges.length} — showing first ${MAX_RANGE_BADGES}, say more words to narrow`
      : `${ranges.length} matches, none in view — showing first ${MAX_RANGE_BADGES}`);
  }
}

function teardown(reason: string): void {
  if (!pending) return;
  const { byCodeword, chips, restoreBadges } = pending;
  pending = null;
  for (const { badge } of chips.values()) badge.remove();
  if (restoreBadges) pickWindowHooks?.showBadges();
  // Release the projection narrow before retiring the codewords: the retire is
  // debounced, so releasing first means the page's own hints are back in the
  // HUD immediately rather than after the next sync.
  publishPickWindow([]);
  const codewords = [...byCodeword.keys()];
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
  return { badge, label };
}
