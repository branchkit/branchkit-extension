/**
 * Follow the page's "next" / "previous" link (Vimium goNext / goPrevious).
 *
 * Preference order:
 *   1. An authoritative `rel="next"` / `rel="prev"` on an <a> or <link>.
 *   2. An <a href> whose visible text / aria-label / title matches a common
 *      next/prev phrase — exact match beats a whole-word match beats a
 *      substring, and earlier phrases in the list win ties.
 *
 * Pure over a `Document` so it's unit-testable. Visibility isn't checked here
 * (rel links and labelled nav links are essentially always visible); refine if
 * a real page surfaces a hidden false-positive.
 */

export type Rel = 'next' | 'prev';

// Ordered by preference. Symbols cover icon-only pagers.
const NEXT_PHRASES = ['next', 'next page', 'newer', 'forward', 'more', '›', '»', '→', '>>', '>'];
const PREV_PHRASES = ['prev', 'previous', 'previous page', 'older', 'back', '‹', '«', '←', '<<', '<'];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Resolve the next/prev target URL for `doc`, or null if none is found. */
export function findPageLink(doc: Document, rel: Rel): string | null {
  // 1. rel attribute — authoritative when present.
  const rels = rel === 'next' ? ['next'] : ['prev', 'previous'];
  for (const r of rels) {
    const el = doc.querySelector<HTMLAnchorElement>(`a[rel~="${r}" i][href], link[rel~="${r}" i][href]`);
    if (el && el.href) return el.href;
  }

  // 2. Label heuristic across anchors with an href.
  const phrases = rel === 'next' ? NEXT_PHRASES : PREV_PHRASES;
  const anchors = Array.from(doc.querySelectorAll<HTMLAnchorElement>('a[href]'));
  let best: { href: string; score: number } | null = null;

  for (const a of anchors) {
    const haystacks = [
      (a.textContent ?? '').trim().toLowerCase(),
      (a.getAttribute('aria-label') ?? '').trim().toLowerCase(),
      (a.getAttribute('title') ?? '').trim().toLowerCase(),
    ].filter(Boolean);

    for (let i = 0; i < phrases.length; i++) {
      const p = phrases[i];
      for (const h of haystacks) {
        let s = 0;
        if (h === p) s = 1000 - i;
        else if (/^[a-z ]+$/.test(p) && new RegExp(`\\b${escapeRegExp(p)}\\b`).test(h)) s = 500 - i;
        else if (h.includes(p)) s = 100 - i;
        if (s > 0 && (!best || s > best.score) && a.href) best = { href: a.href, score: s };
      }
    }
  }
  return best?.href ?? null;
}
