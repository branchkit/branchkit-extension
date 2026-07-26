/**
 * What KIND of badge this is.
 *
 * Two badges exist: the ambient link hint, and the range-pick chip that asks
 * "which of these text matches did you mean?" (activate/range-disambiguation.ts).
 * They share everything — shadow host, stylesheet, APCA colours, size settings,
 * placement, the reconciler — and differ only in how the set narrows while the
 * user is mid-codeword, plus how much page-defence machinery a seconds-long
 * badge should carry.
 *
 * Every field derives from ONE fact (persistent ambient badge vs transient
 * authoritative chip), which is why they live in one object rather than five
 * loose constructor flags: they must move together.
 *
 * See notes/DESIGN_BADGE_TARGET_SEAM.md.
 */

export interface BadgeVariant {
  /**
   * How the badge fills.
   *
   * 'page' — the page's own resolved background, with the page's text colour
   * on top. Deliberately ghosty: the badge reads as native to whatever it sits
   * on, which is right when it sits on everything.
   *
   * {accent} — a fixed HUE whose lightness is solved per page against that
   * same background (badge-colors.ts computeAccentBadgeColors). For badges
   * that must be told apart from the ambient ones at a glance while several
   * kinds are on screen. A fixed colour can't do this job: it disappears on
   * the page that happens to share it.
   */
  readonly fill: 'page' | { accent: string };
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
  /**
   * The already-spoken prefix on a badge that CAN complete.
   *
   * 'fade' (hints): dim what's been said so the remaining letters carry the
   * eye — redundant with hiding the non-candidates, but free.
   * 'accent' (chips): the non-candidates are still on screen, so the match
   * needs a positive marker, not a subtractive one.
   */
  readonly matchedPrefix: 'fade' | 'accent';
  /** Accent colour for `matchedPrefix: 'accent'`. */
  readonly accent?: string;
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
}

export const HINT_VARIANT: BadgeVariant = {
  fill: 'page',
  nonCandidate: 'hide',
  matchedPrefix: 'fade',
  trackContainer: true,
  defendAgainstPage: true,
  suppressOverVideo: true,
};

export const RANGE_PICK_VARIANT: BadgeVariant = {
  // Chips stay page-filled, identical to link hints: a pick HIDES the page's
  // badges, so modality carries the meaning and there is nothing to be
  // confused with. Colour is not doing work here.
  fill: 'page',
  nonCandidate: 'dim',
  matchedPrefix: 'accent',
  // Gold on the matched letter — an explicit user preference, and the inverse
  // of the retired gold-at-rest scheme.
  accent: '#ffd60a',
  trackContainer: true,
  defendAgainstPage: false,
  suppressOverVideo: false,
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
  fill: { accent: '#7c5cff' },
  // Non-candidates dim rather than vanish: the spread of matches down the page
  // is information — it's how you see there are more below.
  nonCandidate: 'dim',
  matchedPrefix: 'accent',
  accent: '#ffd60a',
  trackContainer: true,
  defendAgainstPage: true,
  suppressOverVideo: true,
};
