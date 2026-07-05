/**
 * BranchKit Browser — palette codeword assignment (voice half of Layer 2,
 * notes/DESIGN_TAB_NAVIGATION.md).
 *
 * Assigns a spoken badge to each palette row from the 26-word voice alphabet,
 * in empty-state row order, once per palette open. Pure and deterministic —
 * stable row order in = stable badges; refiltering never reassigns.
 *
 * The single/pair split is DISJOINT by construction: singles come from the
 * head of the alphabet, pair words only from the tail. A pair's first word is
 * therefore never itself a badge, so an utterance chopped mid-pair ("ocean" …
 * pause … "quill") matches nothing rather than mis-selecting a single-badge
 * row. (Page hints solve the same chop with the matcher bridge; the palette
 * has no bridge, so it removes the ambiguity structurally instead.)
 *
 * No label-pool claim: the palette runs under the plugin's EXCLUSIVE palette
 * tag, which suppresses page-hint captures while open — reusing the same
 * alphabet words as painted hints is safe by context, not by partition.
 */

// Head-of-alphabet rows get one-word badges; the tail feeds pairs. 14/12
// yields 14 singles + 12×11 = 132 pairs — 146 addressable rows, comfortably
// above a typical tabs+commands palette. Rows beyond that render unbadged
// (keyboard/typing still reaches them).
const SINGLES = 14;

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
  mode: 'letter' | 'word' | 'both' | 'first-word',
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
    case 'both':
      return words.length === 1 ? `${letters[0]} ${words[0]}` : words.join(' ');
    case 'first-word':
      return words.length === 1 ? words[0] : `${words[0]} ${letters[1]}`;
  }
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
