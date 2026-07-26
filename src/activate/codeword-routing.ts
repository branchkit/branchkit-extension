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
 * by construction, and the next one added inherits both. (The spoken path was
 * migrated second, 2026-07-26 — the header claimed both callers before it had
 * them, and by then the inline copy had already drifted: it re-painted every
 * link hint on a prefix the keyboard narrowed silently.)
 *
 * What deliberately does NOT live here: per-dispatch RESULT REPORTING, and the
 * spoken path's pick-window swallow (`refusePickWindowCodeword`), which carries
 * a report of its own. The ORDER is the shared rule; those are call-site facts.
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
  /** Paint the page's link hints if they are currently hidden. Their codewords
   *  stay published while hidden (find hides them, manual mode starts hidden),
   *  so a prefix can arrive for a badge nobody can see — see `narrowByPrefix`
   *  for when this fires. */
  reveal(): void;
  /** Activate a link hint by whole codeword. True if one was found.
   *  NOTE (2026-07-26): all but unreachable — see `resolveCodeword`. */
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
  const claimedBySearch = searchBadgePrefixMatch(prefix) === true;
  filterSearchBadges(prefix);
  if (!store) return;
  // The store's hints can be HIDDEN while their codewords stay published and
  // speakable (find's onActivate hides them; manual mode starts hidden), so a
  // prefix can arrive for a badge nobody can see. Revealing them is the only
  // way that prefix can be finished by eye — but ONLY when no other holder can
  // finish it: the spoken path used to reveal unconditionally, so saying the
  // first word of a SEARCH badge's codeword re-painted every link hint find had
  // just hidden, while typing the same letter did not (2026-07-26).
  if (prefix !== '' && !claimedBySearch && store.matchesPrefix(prefix)) store.reveal();
  store.narrow(prefix);
}

/** What one of the two Range-backed holders did with a codeword. `not_mine`
 *  means neither claimed it and the caller owns what happens next. */
export type HolderOutcome =
  | { kind: 'picked' }
  | { kind: 'jumped' }
  | { kind: 'off_screen'; holder: 'pick' | 'search' }
  | { kind: 'not_mine' };

export type CodewordOutcome =
  | Exclude<HolderOutcome, { kind: 'not_mine' }>
  | { kind: 'activated' }
  | { kind: 'none' };

/**
 * Offer a whole codeword to the non-store holders, in THE order: a chip answers
 * the pick, a search badge jumps to its match.
 *
 * Split out from `resolveCodeword` because the two inputs diverge on what
 * happens AFTER the holders decline. The keyboard hands the leftover to the
 * store (below); the spoken path runs the full three-tier element resolution
 * (id → fingerprint → codeword) which this layer has no business knowing about.
 * The ORDER is what both share, so the order is what lives here.
 */
export function resolveHolderCodeword(codeword: string): HolderOutcome {
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
  return { kind: 'not_mine' };
}

/**
 * Act on a whole codeword: the holders first, then the store's link hints.
 *
 * The store leg is all but dead and deliberately kept for now (the registry in
 * notes/DESIGN_MODE_STACK_AND_CODEWORD_HOLDERS.md deletes `StoreCodewordHooks`
 * outright): the only caller passes a codeword from `soleHolderMatch`, which
 * excludes store hints, so reaching `store.resolve` needs a search badge to
 * claim the codeword and then find its own range stale in the same call.
 */
export function resolveCodeword(codeword: string): CodewordOutcome {
  const held = resolveHolderCodeword(codeword);
  if (held.kind !== 'not_mine') return held;
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
