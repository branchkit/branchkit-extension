/**
 * BranchKit Browser — palette codeword assignment (voice half of Layer 2,
 * notes/DESIGN_TAB_NAVIGATION.md).
 *
 * Assigns a spoken badge to each palette row from the 26-word voice alphabet,
 * in empty-state row order, once per palette open. Pure and deterministic —
 * stable row order in = stable badges; refiltering never reassigns.
 *
 * Badges are UNIFORM two-word pairs. Uniform length is the chop-safety
 * property: every key is exactly two words, so a partial utterance ("ocean" …
 * pause) is never a complete key — it matches nothing rather than
 * mis-selecting another row. (Page hints solve the same chop with the matcher
 * bridge; the palette has no bridge, so it removes the ambiguity
 * structurally.) The same argument rules out mixing in triples: a chopped
 * triple's first two words WOULD be a valid pair key. Pairs over the full
 * alphabet give 26×25 = 650 badges — beyond any realistic tabs+commands
 * list, so escalation never comes up.
 *
 * No label-pool claim: the palette runs under the plugin's EXCLUSIVE palette
 * tag, which suppresses page-hint captures while open — reusing the same
 * alphabet words as painted hints is safe by context, not by partition.
 */

// One-word badges for the first N rows (from the alphabet head; pairs then
// draw only from the tail — the disjoint split that keeps a chopped pair
// from matching a single). 0 — pairs-only — is the shipped default: uniform
// badges and a 650-row ceiling beat a one-word fast path that caps badging
// at 146 rows for heavy-tab sessions. Raising this buys back one-word badges
// on the head rows if lived use ever wants them.
const SINGLES = 0;

/** Maximum rows that can carry a voice badge. */
export function maxVoiceRows(): number {
  const pairPool = 26 - SINGLES;
  return SINGLES + pairPool * (pairPool - 1);
}

/**
 * Badge display for a spoken codeword under the shared `badgeDisplayMode`
 * setting — the SAME knob the page hints read, so both surfaces agree.
 * Mirrors labels/words.ts labelToDisplay: the spoken form is always the
 * word(s) (that's what the recognizer hears); this only shapes the visible
 * chip. `alphabet` is the same A–Z word list the codeword was assigned from,
 * so each word maps back to its letter by index.
 */
export function codewordDisplay(
  codeword: string,
  alphabet: readonly string[],
  mode: 'letter' | 'word' | 'expand',
): string {
  const words = codeword.split(' ');
  const letters = words.map((w) => {
    const i = alphabet.indexOf(w);
    return i >= 0 ? 'abcdefghijklmnopqrstuvwxyz'[i] : '?';
  });
  switch (mode) {
    case 'letter':
      return letters.join('');
    case 'word':
      return words.join(' ');
    case 'expand':
      return words.length === 1 ? words[0] : `${words[0]} ${letters[1]}`;
  }
}

/**
 * Classify a typed mark string against the assigned marks, for the tab
 * palette's letter-jump: 'exact' → activate that tab; 'prefix' → narrow and
 * wait for more; 'none' → reject the keystroke (never blank the list). Relies
 * on marks being prefix-free (a single letter is never the start of a pair),
 * so 'exact' is unambiguous — a complete single-letter mark activates on one
 * keystroke.
 */
export function classifyMarkInput(
  marks: readonly string[],
  typed: string,
): 'exact' | 'prefix' | 'none' {
  if (marks.includes(typed)) return 'exact';
  if (marks.some((m) => m.startsWith(typed))) return 'prefix';
  return 'none';
}

/**
 * Map row ids to spoken badges. `alphabet` is the 26-word voice alphabet in
 * A–Z order (empty/invalid → empty map: the palette degrades to keyboard-only).
 * Rows past `maxVoiceRows()` are left out of the map.
 */
export function assignCodewords(
  rowIds: readonly string[],
  alphabet: readonly string[],
): Map<string, string> {
  const out = new Map<string, string>();
  if (alphabet.length !== 26 || alphabet.some((w) => typeof w !== 'string' || w.length === 0)) {
    return out;
  }
  const singles = alphabet.slice(0, SINGLES);
  const pairPool = alphabet.slice(SINGLES);
  let i = 0;
  for (const id of rowIds) {
    if (i < SINGLES) {
      out.set(id, singles[i]);
    } else {
      const p = i - SINGLES;
      const first = Math.floor(p / (pairPool.length - 1));
      if (first >= pairPool.length) break; // beyond maxVoiceRows — unbadged
      // Skip the doubled pair (first === second): j indexes the pool with
      // the first word removed.
      const j = p % (pairPool.length - 1);
      const second = j < first ? j : j + 1;
      out.set(id, `${pairPool[first]} ${pairPool[second]}`);
    }
    i++;
  }
  return out;
}
