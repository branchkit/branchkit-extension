/**
 * What KIND of badge this is.
 *
 * THREE badges exist: the ambient link hint; the range-pick chip that asks
 * "which of these text matches did you mean?" (activate/range-disambiguation.ts);
 * and the search badge over a committed find (activate/search-badges.ts).
 * They share everything — shadow host, stylesheet, APCA colours, size settings,
 * placement, the reconciler, the codeword pool, the holder registry, and the
 * typing rule — and differ only in how the set narrows while the user is
 * mid-codeword, plus how much page-defence machinery a seconds-long badge
 * should carry.
 *
 * Every field derives from ONE fact (persistent ambient badge vs transient
 * authoritative overlay), which is why they live in one object rather than five
 * loose constructor flags: they must move together.
 *
 * BEFORE YOU MAKE THE THREE VARIANTS MORE ALIKE, read
 * notes/DESIGN_HINT_ENGINE.md §5.2. Eleven of the differences between hint
 * types look like inconsistencies and are load-bearing, each with its reason
 * recorded at its site; several were regressions once already (chips shipped
 * with no observers and stranded; chips wore a gold prefix accent until
 * consistency won). `defendAgainstPage: false` for chips in particular is a
 * CORRECTNESS constraint, not a cost one — see its field doc. Flattening them
 * re-opens closed bugs, which is the characteristic failure of a tidying pass
 * through this file.
 *
 * See also notes/DESIGN_BADGE_TARGET_SEAM.md.
 */

import { FIND_HIGHLIGHT } from '../scan/find';

export interface BadgeVariant {
  /**
   * How the badge fills.
   *
   * 'page' — the page's own resolved background, with the page's text colour
   * on top. Deliberately ghosty: the badge reads as native to whatever it sits
   * on, which is right when it sits on everything.
   *
   * {tint} — the badge wears a MEANING (search-match yellow), so the fill is
   * that colour everywhere and legibility is carried by the ink and a rim
   * solved against the page (badge-colors.ts computeTintedBadgeColors). For
   * badges shown alongside the ambient ones, where colour is the only thing
   * saying which is which.
   */
  readonly fill: 'page' | { tint: string };
  /**
   * A badge that CAN'T complete the current codeword prefix.
   *
   * 'hide' (hints): hundreds are painted, so hiding the non-candidates
   * declutters and what remains on screen IS the answer.
   * 'dim' (chips): at most nine, and their spatial arrangement IS the question
   * being asked — hiding one would delete an option from a question the user
   * has already been asked.
   */
  readonly nonCandidate: 'hide' | 'dim';
  // The already-spoken prefix is FADED on every badge kind — dim what's been
  // said so the remaining letters carry the eye. There is deliberately no
  // per-kind choice here: mid-codeword progress means the same thing wherever
  // you see it, and a badge that marked it differently would read as a
  // different KIND of progress. Chips and search badges used a gold accent
  // instead until 2026-07-26; consistency with the link hints won.
  /**
   * Track the anchor container's size, so a layout shift that is neither a
   * scroll nor a window resize still repositions this badge.
   *
   * ON for both, which a first cut of this design got wrong: the chips were
   * given no observers at all, and a Playwright run then caught them
   * stranding when a block was inserted above their phrase — the very defect
   * the badge seam existed to fix. It is one shared, refcounted
   * ResizeObserver with an idempotent observe, so registering ≤9 more
   * containers is consuming an existing signal rather than adding sensing.
   */
  readonly trackContainer: boolean;
  /**
   * The per-element page-tampering defences: target-mutation tracking and the
   * host-attribute defender.
   *
   * Off for chips, and NOT merely to save work: `trackTargetMutations` is
   * keyed 1:1 per element with an unconditional untrack, so a chip whose
   * container is also a hinted element ("highlight <link text>") would
   * disconnect that link badge's observer on teardown. A badge that lives
   * seconds also has little to defend.
   */
  readonly defendAgainstPage: boolean;
  /**
   * Suppress paint when the anchor sits mostly over an actively-playing video?
   *
   * The gate exists for Firefox compositor churn under hundreds of badges
   * repainting per SPA advance (render/video-overlay.ts). Off for chips: nine
   * static chips aren't that churn, and the failure mode is wrong here — the
   * codeword stays live while the paint is suppressed, so the user would be
   * asked to pick from options they can't see.
   */
  readonly suppressOverVideo: boolean;
  /**
   * What makes this badge's target THE SAME target after the page moves under
   * it. See `HintIdentity`.
   */
  readonly identity: HintIdentity;
}

/**
 * What a hint's target IS, such that you could find it again.
 *
 * This is deliberately a statement about IDENTITY, not a menu of recovery
 * procedures. An earlier sketch of this axis was
 * `onChurn: 'rebind' | 'refind' | 'cancel'` — but those name three mechanisms
 * that are emphatically not interchangeable (notes/DESIGN_HINT_ENGINE.md §5.1
 * forbids merging the element and range lifecycles), and a field offering a
 * choice among them invites exactly that merge. Identity is the thing that
 * actually differs; recovery is a CONSEQUENCE of it, never a separate choice:
 *
 *   'element-fingerprint'  a link hint is an element, recognisable by its
 *                          fingerprint among limbo candidates
 *                          (labels/rebind.ts, observe/limbo.ts).
 *   'text-occurrence'      a search badge is (query, occurrence). A text range
 *                          has no element identity to fingerprint, so it is
 *                          re-acquired by re-running the query
 *                          (scan/find.ts refindCommitted).
 *   'none'                 a pick chip names one of several answers to a
 *                          question asked seconds ago. It has no identity
 *                          beyond that moment, so there is nothing to
 *                          re-acquire and cancelling is the only honest
 *                          option — not a policy choice, an entailment.
 *
 * The payoff is that a FOURTH hint type (over a11y nodes, over canvas regions)
 * is designed by asking "what is this hint's identity?" — a question about the
 * thing being hinted, which something that doesn't exist yet can still answer —
 * instead of "which of my three recovery verbs fits?", a question about the
 * current implementation, which it cannot.
 */
export type HintIdentity = 'element-fingerprint' | 'text-occurrence' | 'none';

/**
 * Can a hint of this kind be re-acquired at all? DERIVED, never declared
 * beside identity — no identity means nothing to re-acquire.
 *
 * `RangeBadgeSet.create` enforces the two-way contract this implies: a
 * recoverable identity must be given a way to recover, and 'none' must not be.
 * That check is what would have caught bug #5 (notes/DESIGN_HINT_ENGINE.md §2)
 * at construction — search badges shipped claiming a (query, occurrence)
 * identity with nothing wired to re-run the query, and silently pointed at
 * text that no longer existed.
 */
export function canRecover(variant: BadgeVariant): boolean {
  return variant.identity !== 'none';
}

export const HINT_VARIANT: BadgeVariant = {
  fill: 'page',
  nonCandidate: 'hide',
  trackContainer: true,
  defendAgainstPage: true,
  suppressOverVideo: true,
  // An element, recognisable again by fingerprint after SPA churn.
  identity: 'element-fingerprint',
};

export const RANGE_PICK_VARIANT: BadgeVariant = {
  // Chips stay page-filled, identical to link hints: a pick HIDES the page's
  // badges, so modality carries the meaning and there is nothing to be
  // confused with. Colour is not doing work here.
  fill: 'page',
  nonCandidate: 'dim',
  trackContainer: true,
  defendAgainstPage: false,
  suppressOverVideo: false,
  // One of several answers to a question asked seconds ago. Nothing outlives
  // the question, so there is nothing to re-acquire — the set cancels, and
  // that is an entailment rather than a policy.
  identity: 'none',
};

/**
 * Search-match badges: shown ALONGSIDE the page's link hints, so unlike the
 * pick they have no mode to lean on and must be told apart by sight. The
 * accent-filled badge is a saturated chip against the hints' page-coloured
 * ghosts, and its lightness is solved per page so it can't vanish into a site
 * that shares the hue.
 *
 * Long-lived (a find session lasts minutes, not seconds) so it takes the full
 * page defences, unlike the chips.
 */
export const SEARCH_VARIANT: BadgeVariant = {
  // The same highlighter yellow the match itself is painted in — the badge and
  // the thing it points at are one object, and retheming the highlight
  // retints the badge with it. Learnable by association, not by convention.
  fill: { tint: FIND_HIGHLIGHT },
  // Non-candidates dim rather than vanish: the spread of matches down the page
  // is information — it's how you see there are more below.
  nonCandidate: 'dim',
  trackContainer: true,
  defendAgainstPage: true,
  suppressOverVideo: true,
  // (query, occurrence) — a text range has no element identity to fingerprint,
  // so it is re-acquired by re-running the retained query.
  identity: 'text-occurrence',
};
