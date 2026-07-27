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
 * NARROWING — which badges dim or hide as you type — is the other half, and it
 * lives here too (2026-07-27). It was described as differing by kind; it does
 * not. What differs is already expressed elsewhere: the non-candidate MARK is
 * the variant's (`nonCandidate: 'hide' | 'dim'`, applied inside setFiltered),
 * and WHICH letter form a member offers is the holder's own projection. The
 * rule between them — a nonempty prefix the letter form continues makes a
 * candidate, and a candidate shows that many matched chars — was hand-written
 * three times and had already drifted once: the store's loop never reset
 * `setMatchedChars` on a badge that STOPPED matching, so it kept the previous
 * prefix's text split. Benign only because link hints hide non-candidates
 * rather than dimming them (the range sets, which dim, wrote the 0) — a
 * variant flag away from being visible. Unified rather than documented.
 *
 * So: every holder projects its members ONCE into [codeword, letterForm]
 * entries, and the three moments — gate, narrow, fire — all read that.
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

/**
 * Can any of these letter forms still complete `prefix`? — the keyboard's gate
 * for accepting a keystroke at all (`CodewordHolder.matchesPrefix`).
 *
 * `''` matches whenever there is anything to match, which is why the callers'
 * `prefix === ''` special cases disappear: an empty prefix is "do you hold
 * anything", and `startsWith('')` already answers it. That is the OPPOSITE of
 * what `''` means to `narrowBadge` below — there it is a reset, and marks
 * nothing a candidate. Both callers used to re-decide this locally.
 *
 * Case is not folded: the keyboard lowercases each key as it arrives
 * (activate/keyboard.ts) and the SW translates spoken words to lowercase pool
 * tokens before forwarding, so both prefix sources are already lower, as are
 * the pool tokens themselves. One of the three copies lowercased both sides
 * anyway; it could never have changed an answer.
 */
export function anyCodewordMatchesPrefix(
  entries: Iterable<readonly [string, string]>,
  prefix: string,
): boolean {
  for (const [, letter] of entries) {
    if (letter.startsWith(prefix)) return true;
  }
  return false;
}

/** The two writes that show mid-codeword progress on one badge. */
export interface NarrowableBadge {
  setFiltered(filtered: boolean): void;
  setMatchedChars(count: number): void;
}

/**
 * Show one badge's mid-codeword progress against `prefix` ('' resets).
 *
 * A `null` badge (unpainted) or `null` letter form (unlabelled) is a no-op /
 * non-candidate respectively, so callers can hand over their whole membership
 * without pre-filtering it.
 *
 * The two writes are a PAIR — a badge that stops being a candidate must drop
 * its matched-char split, because `setMatchedChars` rewrites the badge text and
 * only `0` restores the full label. Splitting them is what let the store's copy
 * leave stale text behind.
 */
export function narrowBadge(
  badge: NarrowableBadge | null | undefined,
  letterForm: string | null | undefined,
  prefix: string,
): void {
  if (!badge) return;
  const candidate = prefix !== '' && (letterForm ?? '').startsWith(prefix);
  badge.setFiltered(prefix !== '' && !candidate);
  badge.setMatchedChars(candidate ? prefix.length : 0);
}
