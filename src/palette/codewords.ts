/**
 * BranchKit Browser — palette codeword assignment (voice half of Layer 2,
 * notes/DESIGN_TAB_NAVIGATION.md).
 *
 * Assigns a spoken badge to each palette row from the 26-word voice alphabet,
 * in empty-state row order, once per palette open. Pure and deterministic —
 * stable row order in = stable badges; refiltering never reassigns.
 *
 * Badges are UNIFORM length within an open, chosen from the row count at
 * assignment time (the full list is in hand — no estimation): singles cover
 * 26 rows, pairs 650 (26×25), triples 15,600 (26×25×24). Uniform length is
 * the chop-safety property: every key is exactly N words, so a partial
 * utterance ("ocean" … pause) is never a complete key — it matches nothing
 * rather than mis-selecting another row. (Page hints solve the same chop with
 * the matcher bridge; the palette has no bridge, so it removes the ambiguity
 * structurally.) The same argument prohibits MIXING lengths within a session
 * — a chopped triple's first two words WOULD be a valid pair key — but not
 * choosing per open: no cross-length keys ever coexist. Cross-open
 * inconsistency (a 30-row palette speaks pairs where yesterday's 20-row one
 * spoke singles) is the accepted cost of not paying two words on a small
 * palette.
 *
 * No label-pool claim: the palette runs under the plugin's EXCLUSIVE palette
 * tag, which suppresses page-hint captures while open — reusing the same
 * alphabet words as painted hints is safe by context, not by partition.
 */

/**
 * Uniform badge length for a palette of `rowCount` rows — the smallest tier
 * that covers the whole list.
 *
 * `eligible` is how many alphabet letters are actually available. It is below 26
 * when the palette has withheld letters for list navigation
 * (keymap/palette-reserved.ts): badges are TYPED in letter mode, so a letter that
 * moves the selection cannot also label a row. With the shipping five reserved
 * the tiers become 21 / 420 / 7,980.
 */
export function codewordLength(rowCount: number, eligible = 26): 1 | 2 | 3 {
  if (rowCount <= eligible) return 1;
  if (rowCount <= eligible * (eligible - 1)) return 2;
  return 3;
}

/** Maximum rows that can carry a voice badge (the triple tier's capacity). */
export function maxVoiceRows(eligible = 26): number {
  return eligible * (eligible - 1) * (eligible - 2);
}

/** The letter an alphabet slot stands for — index 0 is 'a' (A–Z order). */
function letterAt(index: number): string {
  return String.fromCharCode(97 + index);
}

/**
 * The `index`-th codeword of `length` distinct words drawn from `words`: unranks
 * the index into the ordered no-repeat sequences, leading word varying slowest
 * (row 0 starts at the head). Null past the tier's capacity.
 *
 * `words` is the ELIGIBLE subset, not necessarily the full 26 — reserved letters
 * are already removed by the caller. Everything here is relative to
 * `words.length`, so the arithmetic needs no other change.
 */
function codewordAt(
  words: readonly string[],
  index: number,
  length: number,
): string | null {
  let capacity = 1;
  for (let k = 0; k < length; k++) capacity *= words.length - k;
  if (index >= capacity) return null;
  const pool = [...words];
  const picked: string[] = [];
  let rem = index;
  let block = capacity;
  for (let k = 0; k < length; k++) {
    // Sequences sharing the word chosen at this position (exact integer:
    // capacity is the running product of these divisors).
    block /= words.length - k;
    const i = Math.floor(rem / block);
    rem %= block;
    picked.push(pool[i]);
    pool.splice(i, 1);
  }
  return picked.join(' ');
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
      return words.length === 1 ? words[0] : `${words[0]} ${letters.slice(1).join('')}`;
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
 *
 * `reserved` names letters the palette needs for list navigation, which are
 * withheld from assignment. IT IS FILTERED OUT OF THE UNRANKING ONLY — the
 * `alphabet` array itself stays 26 long, because it is the letter↔word
 * DICTIONARY that codewordDisplay and codewordToken index by position. Shortening
 * it would silently bind every badge to the wrong letter, which is the same trap
 * the header note about "deliberately NOT LETTERS_26" guards against.
 */
export function assignCodewords(
  rowIds: readonly string[],
  alphabet: readonly string[],
  reserved: ReadonlySet<string> = new Set(),
): Map<string, string> {
  const out = new Map<string, string>();
  if (alphabet.length !== 26 || alphabet.some((w) => typeof w !== 'string' || w.length === 0)) {
    return out;
  }
  const eligible = alphabet.filter((_, i) => !reserved.has(letterAt(i)));
  if (eligible.length < 3) return out; // can't even form a triple
  const length = codewordLength(rowIds.length, eligible.length);
  let i = 0;
  for (const id of rowIds) {
    const cw = codewordAt(eligible, i, length);
    if (cw === null) break; // beyond the triple tier — unbadged
    out.set(id, cw);
    i++;
  }
  return out;
}

/**
 * Split a rendered badge into the part the user has already spoken and the
 * part still owed, given how many words are consumed. `done + rest === badge`
 * always, so the caller only has to decide how to paint each half.
 *
 * ONE BADGE SEGMENT PER SPOKEN WORD is the whole rule, and a segment is a
 * CHARACTER in letter form ("io") or a WORD in spaced form ("is opal", and
 * expand's "is o"). That single statement covers every shape the palette
 * renders — tabs-scope marks and all three `badgeDisplayMode` values — because
 * it is the same invariant `codewordToken` already relies on: one letter per
 * spoken word.
 *
 * Splitting only on whitespace (what this used to do) collapsed letter form to
 * a single segment, so speaking the first word of "io" faded the ENTIRE badge —
 * which reads as "this row is out", the opposite of the intended "the i is
 * spent, now say the o". Page hints get this right via `setMatchedChars`
 * (render/hints.ts), which branches per display mode; the palette can state it
 * once instead because it splits the already-rendered string.
 */
export function splitSpokenBadge(
  badge: string,
  consumed: number,
): { done: string; rest: string } {
  if (consumed <= 0) return { done: '', rest: badge };
  if (!/\s/.test(badge)) {
    const cut = Math.min(consumed, badge.length);
    return { done: badge.slice(0, cut), rest: badge.slice(cut) };
  }
  // End of the `consumed`-th run of non-space characters. A prefix longer than
  // the badge has segments consumes all of it rather than throwing — the
  // holder and the badge can disagree for one frame during teardown.
  const runs = /\S+/g;
  let cut = badge.length;
  let seen = 0;
  for (let m = runs.exec(badge); m !== null; m = runs.exec(badge)) {
    if (++seen === consumed) {
      cut = m.index + m[0].length;
      break;
    }
  }
  return { done: badge.slice(0, cut), rest: badge.slice(cut) };
}

/**
 * Claim-level token for a badge — letters, space-joined ("o", "o r").
 *
 * This is the shape the codeword holder registry speaks (`labels/words.ts`
 * pool tokens), so `letterFormOf` and `anyCodewordMatchesPrefix` apply to
 * palette badges unchanged. Two badge shapes reach it:
 *
 *  - FULL PALETTE — `badge` is spoken alphabet words ("ocean river"). A
 *    word's letter is its ALPHABETICAL index in the array: BranchKit pushes
 *    its 26 codewords in A–Z order, so alphabet[0] is the word for 'a'. This
 *    is the exact inverse of `markToSpokenWords`' `charCodeAt(0) - 97`, and
 *    deliberately NOT `LETTERS_26`, whose order is typing-ergonomic (home
 *    row first) and would bind every badge to the wrong letter.
 *  - TABS SCOPE — `badge` is already a strip mark ("a", "ab"), so its
 *    letters just need separating.
 *
 * `alphabet` is a parameter rather than the words.ts overlay because the
 * frame assigned from THIS array; deriving from a separately loaded overlay
 * would make correctness depend on the two agreeing.
 *
 * An unmappable word yields '' — the row is unspeakable rather than bound to
 * the wrong letter.
 */
export function codewordToken(badge: string, alphabet: readonly string[]): string {
  const parts = badge.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  // A mark is one whitespace-free run of letters, already in claim form.
  if (parts.length === 1 && !alphabet.includes(parts[0])) {
    return parts[0].split('').join(' ');
  }
  const letters: string[] = [];
  for (const word of parts) {
    const idx = alphabet.indexOf(word);
    if (idx < 0 || idx > 25) return '';
    letters.push(String.fromCharCode(97 + idx));
  }
  return letters.join(' ');
}
