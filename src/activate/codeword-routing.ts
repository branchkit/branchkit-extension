/**
 * Who owns a codeword — asked once, answered the same way for every input.
 *
 * Three kinds of thing wear a codeword badge: the page's link hints (wrappers
 * in the element store), the range-pick chips, and the search-match badges.
 * The last two answer for Ranges rather than Elements, so they deliberately
 * live OUTSIDE the store (render/badge-target.ts, labels/codeword-holders.ts).
 *
 * The ordering below used to exist only on the SPOKEN path, with the keyboard
 * carrying a store-only subset of the same rule. The result was that chips and
 * search badges could be spoken but not typed — `gs` opened a phrase box whose
 * multi-match answer was unreachable from the keyboard that opened it, and the
 * keystroke that should have started a codeword was rejected as a stray key
 * because no *store* hint began with it (2026-07-26).
 *
 * That was one rule with two implementations and only one of them complete.
 * Both inputs now call in here, so a holder is reachable by voice and keyboard
 * by construction, and the next one added inherits both.
 *
 * THE ORDER IS THE CONTRACT:
 *
 *   1. Pick chips — EXCLUSIVE. While a pick is up it owns every codeword,
 *      because it is a question that must be answered; a stray badge codeword
 *      must not act out from under it.
 *   2. Search badges — ADDITIVE. They coexist with link hints, so they claim
 *      only their own and fall through otherwise.
 *   3. The store's link hints — the default.
 */

import {
  filterRangePickChips, rangePickPrefixMatch, rangePickSoleMatch,
  resolveRangePick, isRangePickPending,
} from './range-disambiguation';
import {
  filterSearchBadges, searchBadgePrefixMatch, searchBadgeSoleMatch,
  resolveSearchBadge,
} from './search-badges';

/**
 * The store half, injected because the wrapper store and its activation live in
 * content.ts and importing them here would close an import cycle.
 */
export interface StoreCodewordHooks {
  /** Does any painted link hint's codeword start with `prefix`? */
  matchesPrefix(prefix: string): boolean;
  /** Narrow the painted link hints to `prefix` (`''` resets). */
  narrow(prefix: string): void;
  /** Activate a link hint by whole codeword. True if one was found. */
  resolve(codeword: string): boolean;
}

let store: StoreCodewordHooks | null = null;

export function setStoreCodewordHooks(hooks: StoreCodewordHooks): void {
  store = hooks;
}

/**
 * Would `prefix` start (or continue) some codeword on screen?
 *
 * The keyboard's gate for accepting a keystroke at all. A pick answers alone
 * while it is up — that is what exclusivity means — so a letter no chip can
 * complete is refused rather than falling through to hints the pick has hidden.
 */
export function anyHolderMatchesPrefix(prefix: string): boolean {
  const pick = rangePickPrefixMatch(prefix);
  if (pick !== null) return pick;
  return (searchBadgePrefixMatch(prefix) ?? false) || (store?.matchesPrefix(prefix) ?? false);
}

/** Mid-codeword progress, routed to whoever owns the codewords right now. */
export function narrowByPrefix(prefix: string): void {
  // Exclusive: the pick takes progress and nothing else hears it.
  if (filterRangePickChips(prefix)) return;
  // Additive: search badges narrow, and the store's hints narrow in the same
  // breath because they are on screen together.
  filterSearchBadges(prefix);
  store?.narrow(prefix);
}

export type CodewordOutcome =
  | { kind: 'picked' }
  | { kind: 'off_screen'; holder: 'pick' | 'search' }
  | { kind: 'jumped' }
  | { kind: 'activated' }
  | { kind: 'none' };

/**
 * Act on a whole codeword. Same order, same meanings as the spoken path: a chip
 * answers the pick, a search badge jumps to its match, a hint activates its
 * element.
 */
export function resolveCodeword(codeword: string): CodewordOutcome {
  // Search badges are checked first and only when NO pick is up — a pick
  // swallows everything, including codewords a search badge would claim.
  if (!isRangePickPending()) {
    const search = resolveSearchBadge(codeword);
    if (search === 'jumped') return { kind: 'jumped' };
    if (search === 'off_screen') return { kind: 'off_screen', holder: 'search' };
  }
  const pick = resolveRangePick(codeword);
  if (pick === 'picked') return { kind: 'picked' };
  if (pick === 'off_screen') return { kind: 'off_screen', holder: 'pick' };
  return store?.resolve(codeword) ? { kind: 'activated' } : { kind: 'none' };
}

/**
 * The codeword a typed `prefix` has narrowed to exactly one of, if any — so
 * typing can fire at the same moment speaking a whole codeword would.
 * Store hints are excluded: content.ts already completes those itself, with
 * hint-mode bookkeeping (new-tab arming, mode exit) this layer has no business
 * knowing about.
 */
export function soleHolderMatch(prefix: string): string | null {
  if (prefix === '') return null;
  return rangePickSoleMatch(prefix) ?? searchBadgeSoleMatch(prefix);
}
