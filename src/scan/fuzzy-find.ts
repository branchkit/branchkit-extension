/**
 * Phonetic-tolerant correction of a (possibly ASR-garbled) find query to the
 * closest term actually on the page. Used only as a FALLBACK when exact
 * substring find returns nothing — it turns a speech-recognition error into a
 * match against known page text ("shek out" -> "checkout"). Because for
 * find-on-page the target is almost always text that IS on the page, the page's
 * own words are the right candidate set; matching against them is more robust
 * than trying to make the recognizer perfect.
 *
 * Pure (no DOM) so it's unit-testable; the caller passes page text in.
 */

/** Lowercase, letters/digits/space only, whitespace collapsed. */
export function normalizeFuzzy(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A coarse phonetic key (Metaphone-flavoured). The point is that words that
 * *sound* alike collapse to the same/similar key — which is exactly the axis
 * ASR errors move along (ch/sh, ph/f, ck/k, dropped/swapped vowels). Not a full
 * Double Metaphone; just the high-value transforms for English find targets.
 */
export function phoneticKey(input: string): string {
  let s = input.toLowerCase().replace(/[^a-z]/g, '');
  if (!s) return '';
  // Silent / merged leading clusters.
  s = s.replace(/^(kn|gn|pn)/, 'n').replace(/^wr/, 'r').replace(/^wh/, 'w').replace(/^x/, 's');
  // High-value digraphs (order matters: sch before [cs]h).
  s = s
    .replace(/sch/g, 'sk')
    .replace(/ph/g, 'f')
    .replace(/[cs]h/g, 'x') // ch and sh both -> 'x' (they're easily confused)
    .replace(/th/g, 't')
    .replace(/ck/g, 'k')
    .replace(/gh/g, '');
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const next = s[i + 1] ?? '';
    let code: string;
    if ('aeiou'.includes(c)) {
      code = i === 0 ? c : ''; // keep only a leading vowel
    } else if (c === 'c') {
      code = 'eiy'.includes(next) ? 's' : 'k';
    } else if (c === 'q' || c === 'g') {
      code = 'k';
    } else if (c === 'z') {
      code = 's';
    } else if (c === 'v') {
      code = 'f';
    } else if (c === 'x') {
      code = 'ks';
    } else if (c === 'h' || c === 'w' || c === 'y') {
      code = 'aeiou'.includes(next) ? c : ''; // only audible before a vowel
    } else {
      code = c;
    }
    for (const ch of code) {
      if (ch !== out[out.length - 1]) out += ch; // collapse consecutive dupes
    }
  }
  return out;
}

/** Levenshtein edit distance. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur = new Array<number>(n + 1);
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

function simRatio(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

/**
 * Blended similarity in [0,1]: mostly phonetic (the axis ASR errors move on),
 * with surface edit-distance as a tiebreaker so genuinely-close spellings win.
 * Compared space-free so word-segmentation differences ("shek out" vs
 * "checkout") don't matter.
 */
export function fuzzyScore(a: string, b: string): number {
  const na = normalizeFuzzy(a).replace(/\s/g, '');
  const nb = normalizeFuzzy(b).replace(/\s/g, '');
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const surface = simRatio(na, nb);
  const phon = simRatio(phoneticKey(na), phoneticKey(nb));
  return 0.4 * surface + 0.6 * phon;
}

/**
 * Accent-fold to a lowercase base form while preserving length 1:1, so a match
 * index in the folded string maps back to the same offset in the original ("í"
 * -> "i"). Handles the common precomposed Latin accents on find targets.
 */
export function fold1to1(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    out += s[i].normalize('NFD')[0].toLowerCase();
  }
  return out;
}

/**
 * Length-preserving lowercase (case-insensitive but accent-SENSITIVE) for the
 * exact matcher, so match offsets map 1:1 back to DOM offsets. Unlike fold1to1
 * it keeps accents, so "exact" find stays strict ("Martín" ≠ "Martin").
 */
export function lower1to1(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    out += s[i].toLowerCase()[0] ?? s[i];
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A regex source (to run against `fold1to1` text) that matches the query's words
 * in order, tolerant of any non-alphanumeric run between them — so "lope martin
 * marooned" matches "lope martín (marooned" on the page. null if no words.
 */
export function flexiblePattern(term: string): string | null {
  const words = normalizeFuzzy(term).split(' ').filter(Boolean);
  if (!words.length) return null;
  return words.map(escapeRegExp).join('[^a-z0-9]+');
}

export interface PageMatch {
  term: string;
  score: number;
}

/**
 * Best page term matching `query`, or null if nothing clears `threshold`.
 * Tokenizes `pageText` and scores unigrams plus grams the query's word-length
 * (so a single page word can still match a query the recognizer split in two).
 * The returned `term` is original-cased page text, ready to hand back to the
 * exact find. Pure — no DOM.
 */
export function bestPageMatch(
  query: string,
  pageText: string,
  threshold = 0.7,
  maxTokens = 20000,
): PageMatch | null {
  const nq = normalizeFuzzy(query);
  if (!nq) return null;
  const qLen = nq.split(' ').length;
  const tokens = (pageText.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).slice(0, maxTokens);
  const sizes = qLen > 1 ? [1, qLen] : [1];
  const seen = new Set<string>();
  let best: PageMatch | null = null;
  for (const n of sizes) {
    for (let i = 0; i + n <= tokens.length; i++) {
      const gram = tokens.slice(i, i + n).join(' ');
      const key = normalizeFuzzy(gram).replace(/\s/g, '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const score = fuzzyScore(nq, gram);
      if (score >= threshold && (!best || score > best.score)) {
        best = { term: gram, score };
        if (score >= 0.999) return best;
      }
    }
  }
  return best;
}
