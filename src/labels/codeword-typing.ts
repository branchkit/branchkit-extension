/**
 * What it takes to TYPE a codeword — one rule, for every badge that wears one.
 *
 * A badge paints its letter form, and that is a promise about the keystrokes
 * required. The rule is therefore the simplest one available: the typed text
 * must EQUAL what is painted. Not "narrows to exactly one" — that fires early
 * whenever the visible population happens to be sparse, which is a property of
 * the page rather than of anything the user can see.
 *
 * Both badge kinds used to answer this separately, and diverged in exactly the
 * way separate answers do:
 *
 *   - range sets (≤9 chips, ≤24 search badges) sample the codeword pool thinly,
 *     so a first letter is unique most of the time. Chips reading
 *     `sf df ff fd fs fa ag sg dg` resolved on a bare `a` — the pick vanishing
 *     mid-word (field, 2026-07-27).
 *   - the element store is DENSER, so the same rule misfired rarely enough to
 *     look correct. It is the same defect: a page with four links gives unique
 *     first letters too, and clicks one before you finish naming it.
 *
 * Fixing only the loud half would have left the quiet half in place under a
 * comment explaining why it was fine. It is not fine; it is rarer.
 *
 * Prefix matching still exists and is still per-holder — it drives NARROWING
 * (which badges dim or hide as you type), and that genuinely differs by kind.
 * What is unified here is only the moment of firing.
 */

/** Letter form of a claim-level codeword: "a s" -> "as". */
export function letterFormOf(codeword: string): string {
  return codeword.replace(/\s+/g, '');
}

/**
 * The codeword `typed` names outright, or null.
 *
 * `entries` yields [codeword, letterForm] pairs — the two badge kinds keep
 * their own member structures and project into this, rather than sharing a
 * storage shape they have good reasons not to share.
 */
export function exactCodewordMatch(
  entries: Iterable<readonly [string, string]>,
  typed: string,
): string | null {
  if (typed === '') return null;
  for (const [codeword, letter] of entries) {
    if (letter === typed) return codeword;
  }
  return null;
}
