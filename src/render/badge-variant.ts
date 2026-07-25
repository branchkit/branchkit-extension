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
   * Register the page-mutation-defence observers (container resize, target
   * mutation, host-attribute defender)?
   *
   * Off for chips, and NOT merely to save work: `trackTargetMutations` is
   * keyed 1:1 per element with an unconditional untrack, so a chip whose
   * container is also a hinted element ("highlight <link text>") would
   * disconnect that link badge's observer on teardown.
   */
  readonly observePage: boolean;
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
  nonCandidate: 'hide',
  matchedPrefix: 'fade',
  observePage: true,
  suppressOverVideo: true,
};

export const RANGE_PICK_VARIANT: BadgeVariant = {
  nonCandidate: 'dim',
  matchedPrefix: 'accent',
  // Gold on the matched letter — an explicit user preference, and the inverse
  // of the retired gold-at-rest scheme.
  accent: '#ffd60a',
  observePage: false,
  suppressOverVideo: false,
};
