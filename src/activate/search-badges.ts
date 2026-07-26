/**
 * Codeword badges on committed search matches — say a codeword, jump to that
 * match.
 *
 * The second consumer of `RangeBadgeSet` (render/range-badge-set.ts), which
 * owns everything shared with the range-pick chips: claiming from the pool,
 * converging on the viewport as you scroll, following text through layout
 * shifts, reaping dead ranges, and registering as a CodewordHolder so nine
 * store-scoped lifecycle sweeps don't treat these codewords as garbage. What
 * lives here is only what makes SEARCH badges different from a pick:
 *
 *   - ADDITIVE, not owning. A pick SWALLOWS every non-chip codeword, because it
 *     is a question that must be answered. These claim only their own and fall
 *     through otherwise, so anything else on screen stays speakable.
 *
 *     Note what that does and does not buy in practice: find's own `onActivate`
 *     already hides the page's link badges (content.ts), so for most of a
 *     session these ARE the only badges up. Coexistence shows up when the user
 *     re-shows badges mid-session. The falling-through still matters — search
 *     must not become a second modal layer — but "they sit alongside hints" is
 *     the exception, not the rule.
 *
 *     They are tinted (SEARCH_VARIANT) for a better reason than distinguishing
 *     themselves from hints: the badge wears the same highlighter yellow as the
 *     match it points at, so the two read as one object.
 *
 *   - ARMED ON COMMIT, not on keystroke. Badges appear when a search commits,
 *     which is exactly when n/N navigation goes live — the same moment the
 *     feature stops being "typing" and starts being "a set of results". Arming
 *     per keystroke would churn codewords on every character.
 *
 *   - a codeword means GO THERE: the match becomes current, takes the solid
 *     highlight, and scrolls into view — identical to pressing `n` until you
 *     land on it, which is the behaviour it replaces.
 */

import { RangeBadgeSet } from '../render/range-badge-set';
import { SEARCH_VARIANT } from '../render/badge-variant';
import { getMatchRanges, findGoToRange, isFindActive } from '../scan/find';
import { bkLog } from '../debug/bk-log';

/**
 * How many matches wear a codeword at once.
 *
 * Larger than a pick's nine: a pick is a question you answer immediately, while
 * a search is a result set you move around in, and "the phrase is on this page
 * 40 times" is normal. The band planner still hard-caps to this and spends the
 * budget nearest-the-viewport-first, so a 400-match page badges the ones you
 * can actually see and re-derives as you scroll.
 */
export const MAX_SEARCH_BADGES = 24;

let badges: RangeBadgeSet | null = null;

/** True while search badges are up (optionally: for this specific codeword). */
export function isSearchBadgePending(codeword?: string): boolean {
  if (!badges) return false;
  return codeword === undefined || badges.has(codeword);
}

/**
 * Arm badges over the committed matches. Idempotent per commit: a requery
 * replaces the previous set, so codewords track the current results rather
 * than a stale search.
 */
export function armSearchBadges(): void {
  clearSearchBadges('recommitted');
  const ranges = getMatchRanges();
  if (ranges.length === 0) return;

  badges = RangeBadgeSet.create({
    ranges,
    variant: SEARCH_VARIANT,
    budget: MAX_SEARCH_BADGES,
    logTag: 'BK_SEARCH_BADGES',
    // Nothing to arm plugin-side: search badges publish their codewords like
    // any other and deliberately do NOT narrow the projection, because link
    // hints stay speakable alongside them.
    onEmpty: () => { badges = null; },
  });
  bkLog('BK_SEARCH_BADGES_ARM', { matches: ranges.length, badged: badges?.size ?? 0 });
}

/** Drop every search badge (find session ended, or a requery replaced them). */
export function clearSearchBadges(reason: string): void {
  if (!badges) return;
  badges.dispose(reason);
  badges = null;
}

/**
 * Re-derive which matches wear a badge as the viewport moves. Rides the settle
 * engine's existing afterScrollSettle hook, the same signal the pick chips use
 * — no new observer, timer or listener.
 */
export function reconcileSearchBadges(): void {
  // A find session that ended without a deactivate (defensive: the badges
  // outliving their matches would be a set of codewords pointing at nothing).
  if (badges && !isFindActive()) {
    clearSearchBadges('find_inactive');
    return;
  }
  badges?.reconcile();
}

/**
 * Consume a spoken codeword if it names a search match: make it current and
 * scroll to it, exactly as `n` would.
 *
 * Returns 'not_mine' when the codeword isn't a search badge, so the caller
 * falls through to ordinary hint activation — search badges COEXIST with link
 * hints and must not swallow their codewords.
 *
 * Off-screen badges refuse for the same reason the pick chips do: the band
 * paints past the fold as a scroll-ahead cue, so a badge can hold a codeword
 * the user has never read, and acting on it would be acting on something they
 * cannot see. Unlike a pick this is a soft no — the session stays live and the
 * codeword works once it's on screen.
 */
export type SearchBadgeOutcome = 'jumped' | 'off_screen' | 'not_mine';

export function resolveSearchBadge(codeword: string): SearchBadgeOutcome {
  if (!badges) return 'not_mine';
  const range = badges.rangeFor(codeword);
  if (!range) return 'not_mine';
  if (!badges.isOnScreen(codeword)) return 'off_screen';
  if (!findGoToRange(range)) {
    // The match list moved under us (a requery between paint and speech). Drop
    // the stale set rather than pretend.
    clearSearchBadges('stale_range');
    return 'not_mine';
  }
  bkLog('BK_SEARCH_BADGE_JUMP', { codeword });
  return 'jumped';
}

/** Mid-codeword progress: dim the badges that can't complete the prefix. */
export function filterSearchBadges(prefix: string): boolean {
  if (!badges) return false;
  badges.filterByPrefix(prefix);
  return true;
}
