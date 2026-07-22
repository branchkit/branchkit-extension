/**
 * BranchKit Browser — portable text segmentation for voice selection (pure).
 *
 * Cross-engine fallback substrate (see notes/DESIGN_VOICE_SELECTION_BOUNDS.md,
 * Phase C). Firefox lacks `sentence`/`paragraph`/`*boundary` granularities and
 * `Selection.modify` is inert inside text inputs, so word/sentence/paragraph
 * movement is re-derived here from `Intl.Segmenter` over a plain string:
 *
 * - Over the caret's flat text index (cross-node prose) when native modify is a
 *   no-op for a granularity, and
 * - Over `input.value` + `selectionStart/End` inside editable fields, where the
 *   document Selection can't reach.
 *
 * Pure string math — no DOM — so it's directly unit-testable and identical on
 * every engine. The offsets it returns map back to DOM Ranges via the caller's
 * flat index (find.ts `buildFlatIndex`) or straight onto a field's selection.
 */

import type { NativeGranularity, Direction, ModifyPlan } from './selection-grammar';

// Intl.Segmenter isn't in the ES2021 lib; declare the slice we use. Guarded at
// runtime by `segmenterAvailable()` so older engines degrade instead of throw.
interface SegmentData { segment: string; index: number; isWordLike?: boolean }
interface SegmenterLike { segment(input: string): Iterable<SegmentData> }
interface SegmenterCtor {
  new (locales?: string | string[], options?: { granularity: 'grapheme' | 'word' | 'sentence' }): SegmenterLike;
}
function segmenterCtor(): SegmenterCtor | null {
  const seg = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;
  return typeof seg === 'function' ? seg : null;
}

export function segmenterAvailable(): boolean {
  return segmenterCtor() !== null;
}

/** The granularities this fallback can synthesize (character/lineboundary are
 *  handled directly, not via Segmenter). */
export type FallbackGranularity = 'word' | 'sentence' | 'line' | 'paragraph';

/**
 * Sorted, de-duplicated set of candidate stop offsets for a granularity — the
 * positions a focus can land on when moving by that unit. Always includes the
 * string ends (0 and length) so movement clamps cleanly at the edges.
 *
 * - word: each word-like segment's start AND end (so forward stops at word end,
 *   backward at word start — matching native word movement's feel).
 * - sentence: each sentence segment's start.
 * - line: every newline (line end) and the character after it (next line start).
 * - paragraph: each blank-line gap's start and end.
 */
export function segmentStops(text: string, granularity: FallbackGranularity): number[] {
  const stops = new Set<number>([0, text.length]);
  if (granularity === 'word' || granularity === 'sentence') {
    const Ctor = segmenterCtor();
    if (Ctor) {
      const seg = new Ctor(undefined, { granularity });
      for (const s of seg.segment(text)) {
        if (granularity === 'word') {
          if (s.isWordLike) { stops.add(s.index); stops.add(s.index + s.segment.length); }
        } else {
          stops.add(s.index);
        }
      }
    }
  } else if (granularity === 'line') {
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\n') { stops.add(i); stops.add(i + 1); }
    }
  } else {
    const re = /\n[ \t]*\n/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      stops.add(m.index);
      stops.add(m.index + m[0].length);
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return [...stops].sort((a, b) => a - b);
}

/** Move `offset` by `count` stops of `granularity` in `direction`, clamped to
 *  the string. The core of the portable word/sentence/paragraph movement. */
export function nextStop(
  text: string,
  granularity: FallbackGranularity,
  offset: number,
  direction: Direction,
  count: number,
): number {
  const stops = segmentStops(text, granularity);
  let idx = Math.max(0, Math.min(offset, text.length));
  const steps = Math.max(1, Math.floor(count));
  for (let n = 0; n < steps; n++) {
    if (direction === 'forward') {
      const next = stops.find((s) => s > idx);
      if (next === undefined) { idx = text.length; break; }
      idx = next;
    } else {
      let prev: number | undefined;
      for (const s of stops) { if (s < idx) prev = s; else break; }
      if (prev === undefined) { idx = 0; break; }
      idx = prev;
    }
  }
  return idx;
}

/**
 * The char span of the word/sentence *containing* `offset` — the substrate for
 * "select this word/sentence" (`iw`/`is`/`aw`/`as`) where the caret sits anywhere
 * inside the entity. Deterministic (unlike native `Selection.modify` sentence
 * granularity). If the caret is in a gap/at the end, returns the nearest entity
 * at or before it. Falls back to the whole string when Segmenter is unavailable.
 */
export function entitySpan(
  text: string,
  granularity: 'word' | 'sentence',
  offset: number,
): { start: number; end: number } {
  const clamped = Math.max(0, Math.min(offset, text.length));
  const Ctor = segmenterCtor();
  if (!Ctor || text.length === 0) return { start: 0, end: text.length };
  const segs = [...new Ctor(undefined, { granularity }).segment(text)]
    .filter((s) => (granularity === 'word' ? !!s.isWordLike : true))
    .map((s) => ({ start: s.index, end: s.index + s.segment.length }));
  if (segs.length === 0) return { start: 0, end: text.length };
  for (const s of segs) {
    if (clamped >= s.start && clamped < s.end) return s;
  }
  // In a gap or at the end: the nearest entity starting at or before the caret,
  // else the first (caret before all text, e.g. leading whitespace).
  let chosen = segs[0];
  for (const s of segs) { if (s.start <= clamped) chosen = s; else break; }
  return chosen;
}

/** Shrink a span to exclude leading/trailing whitespace — the "inner" trim
 *  (`iw`/`is`/`ip`) so a copied entity has no surrounding spaces/newlines. */
export function trimSpan(text: string, start: number, end: number): { start: number; end: number } {
  let s = Math.max(0, start);
  let e = Math.min(text.length, end);
  while (s < e && /\s/.test(text[s])) s++;
  while (e > s && /\s/.test(text[e - 1])) e--;
  return { start: s, end: e };
}

/** Start (backward) or end (forward) of the line containing `offset`, where a
 *  "line" is delimited by newlines — the field/flat-text analog of the native
 *  `lineboundary` granularity ("extend to end/start of line"). */
export function lineBoundary(text: string, offset: number, direction: Direction): number {
  const clamped = Math.max(0, Math.min(offset, text.length));
  if (direction === 'forward') {
    const nl = text.indexOf('\n', clamped);
    return nl === -1 ? text.length : nl;
  }
  const nl = text.lastIndexOf('\n', clamped - 1);
  return nl === -1 ? 0 : nl + 1;
}

// --- Editable-field selection (input.value + selectionStart/End) ---

/** A field selection as anchor (fixed end) + focus (moving end). */
export interface FieldRange { anchor: number; focus: number }

/**
 * Apply a `ModifyPlan` to a field selection over `value`, moving the focus and
 * leaving the anchor fixed — the Segmenter twin of `Selection.modify('extend',
 * …)` for inputs/textareas, where the document Selection can't reach. `paragraph`
 * degrades to `line` when the field has no blank-line gaps (single-line inputs).
 */
export function applyFieldModify(value: string, sel: FieldRange, plan: ModifyPlan): FieldRange {
  let focus: number;
  if (plan.granularity === 'lineboundary') {
    focus = lineBoundary(value, sel.focus, plan.direction);
  } else if (plan.granularity === 'character') {
    const d = plan.direction === 'forward' ? 1 : -1;
    focus = Math.max(0, Math.min(sel.focus + d * Math.max(1, plan.count), value.length));
  } else {
    focus = nextStop(value, plan.granularity, sel.focus, plan.direction, plan.count);
  }
  return { anchor: sel.anchor, focus };
}

/** Read an input/textarea's current selection as anchor/focus, honoring the
 *  browser's `selectionDirection` so anchor is the fixed end. */
export function readFieldRange(el: HTMLInputElement | HTMLTextAreaElement): FieldRange {
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? start;
  return el.selectionDirection === 'backward'
    ? { anchor: end, focus: start }
    : { anchor: start, focus: end };
}

/** Write an anchor/focus range back onto an input/textarea (start/end +
 *  direction), so a subsequent read round-trips and the OS caret sits at focus. */
export function writeFieldRange(el: HTMLInputElement | HTMLTextAreaElement, r: FieldRange): void {
  const start = Math.min(r.anchor, r.focus);
  const end = Math.max(r.anchor, r.focus);
  el.setSelectionRange(start, end, r.focus < r.anchor ? 'backward' : 'forward');
}

/** True while native `Selection.modify` for a granularity is unavailable or a
 *  no-op — i.e. the string length didn't change and it's a granularity Firefox
 *  omits. Callers pass the pre/post selection text length. */
export function nativeModifyWasInert(
  granularity: NativeGranularity,
  beforeLen: number,
  afterLen: number,
): boolean {
  if (beforeLen !== afterLen) return false;
  // character/word/line exist everywhere; a no-op there is a genuine boundary,
  // not a missing granularity. sentence/paragraph/lineboundary are the ones
  // Firefox lacks — a no-op there means "fall back to the Segmenter."
  return granularity === 'sentence' || granularity === 'paragraph' || granularity === 'lineboundary';
}
