import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the collaborators before importing the module under test.
const claimed: string[][] = [];
const released: string[][] = [];
let nextClaim: string[] = [];
// `nextClaim` IS the pool: claim consumes from the front, release returns to
// the front (the real reservoir's sticky-reclaim semantics). Modelling that
// rather than handing out the same codewords forever is what lets the rolling
// viewport-window tests assert that scrolling RECYCLES codewords instead of
// draining the pool.
vi.mock('../labels/label-reservoir', () => ({
  labelReservoir: {
    claim: (count: number) => {
      const grant = nextClaim.splice(0, count);
      while (grant.length < count) grant.push('');
      claimed.push(grant.filter(l => l !== ''));
      return grant;
    },
    release: (labels: string[]) => { released.push(labels); nextClaim.unshift(...labels); },
  },
}));

const publishedRecords: Array<{ codeword: string; in_strict_viewport?: boolean }> = [];
const retired: string[][] = [];
let admitAll = true;
vi.mock('../labels/label-sync', () => ({
  publishRecords: async (records: Array<{ codeword: string }>) => {
    publishedRecords.push(...records);
    return new Set(admitAll ? records.map(r => r.codeword) : []);
  },
  retireRecords: (codewords: string[]) => { retired.push(codewords); },
}));

const toasts: string[] = [];
vi.mock('../render/toast', () => ({
  flashToast: (text: string) => { toasts.push(text); },
}));
vi.mock('../debug/bk-log', () => ({ bkLog: () => {} }));

vi.mock('../plugin/resolve', () => ({
  reportDispatchResult: () => {},
}));

// Chips are real HintBadges now (render/badge-variant.ts RANGE_PICK_VARIANT).
// Substituting a recording fake is what BadgeHandle exists for — it asserts
// the calls the module actually makes, instead of poking at DOM the badge owns
// (whose shadow root is closed in production anyway).
interface FakeBadge {
  label: { letter: string };
  displayMode: string;
  variant: unknown;
  shown: boolean;
  removed: boolean;
  filtered: boolean;
  matchedChars: number;
  positioned: { x: number; y: number } | null;
}
const badges: FakeBadge[] = [];
vi.mock('../render/hints', () => ({
  HintBadge: class {
    label: { letter: string };
    displayMode: string;
    variant: unknown;
    shown = false;
    removed = false;
    filtered = false;
    matchedChars = 0;
    positioned: { x: number; y: number } | null = null;
    badgeSize = { w: 20, h: 14 };
    constructor(_target: unknown, label: { letter: string }, displayMode: string, variant: unknown) {
      this.label = label;
      this.displayMode = displayMode;
      this.variant = variant;
      badges.push(this as unknown as FakeBadge);
    }
    show(): void { this.shown = true; }
    remove(): void { this.removed = true; }
    setFiltered(f: boolean): void { this.filtered = f; }
    setMatchedChars(n: number): void { this.matchedChars = n; }
    updatePosition(c: { x: number; y: number }): void { this.positioned = c; }
  },
}));
vi.mock('../config', () => ({ getDisplayMode: () => 'letter' }));

/** Chips still up: constructed, shown, not torn down. */
function liveBadges(): FakeBadge[] {
  return badges.filter(b => !b.removed);
}

// The pick arms/releases the plugin-side hint-projection narrow through the SW.
const pickWindowPosts: string[][] = [];
(globalThis as unknown as { chrome: unknown }).chrome = {
  runtime: {
    sendMessage: (m: { type: string; codewords: string[] }) => {
      if (m.type === 'RANGE_PICK') pickWindowPosts.push(m.codewords);
      return Promise.resolve();
    },
  },
};

import { RANGE_PICK_VARIANT } from '../render/badge-variant';
import {
  startRangePick, resolveRangePick, cancelRangePick, isRangePickPending,
  filterRangePickChips, reconcileRangePickChips, MAX_RANGE_BADGES,
} from './range-disambiguation';

function makeRange(text = 'x'): Range {
  const el = document.createElement('p');
  el.textContent = text;
  document.body.appendChild(el);
  const r = document.createRange();
  r.selectNodeContents(el.firstChild!);
  return r;
}

/** Chip count, by live badge — the module owns no DOM of its own now. */
function chipCount(): number {
  return liveBadges().length;
}

describe('range-disambiguation pick', () => {
  // happy-dom reports every rect as all-zeros, which the band planner correctly
  // reads as "collapsed, nowhere to anchor a chip" — so without a default stub
  // every test would silently exercise the nothing-in-band fallback instead of
  // the pick. Give ranges a real on-screen box by default; the viewport tests
  // below override this.
  let restoreDefaultRects: (() => void) | null = null;
  beforeEach(() => {
    const original = Range.prototype.getBoundingClientRect;
    Range.prototype.getBoundingClientRect = () =>
      ({ top: 10, bottom: 30, left: 10, right: 60, width: 50, height: 20 }) as DOMRect;
    restoreDefaultRects = () => { Range.prototype.getBoundingClientRect = original; };
  });
  afterEach(() => { restoreDefaultRects?.(); restoreDefaultRects = null; });

  beforeEach(() => {
    vi.useFakeTimers();
    claimed.length = 0;
    released.length = 0;
    publishedRecords.length = 0;
    retired.length = 0;
    pickWindowPosts.length = 0;
    toasts.length = 0;
    nextClaim = ['alpha', 'bravo', 'charlie', 'delta'];
    admitAll = true;
    badges.length = 0;
    document.body.innerHTML = '';
  });
  afterEach(() => {
    cancelRangePick('test_teardown');
    vi.useRealTimers();
  });

  it('paints one chip per range, publishes the codewords, and resolves a pick', async () => {
    const picks: Range[] = [];
    const ranges = [makeRange('a'), makeRange('b'), makeRange('c')];
    startRangePick(ranges, (r) => picks.push(r));
    await Promise.resolve(); // let the publish settle
    expect(chipCount()).toBe(3);
    expect(publishedRecords.map(r => r.codeword)).toEqual(['alpha', 'bravo', 'charlie']);
    expect(isRangePickPending()).toBe(true);
    expect(isRangePickPending('bravo')).toBe(true);
    expect(isRangePickPending('zulu')).toBe(false);

    expect(resolveRangePick('bravo')).toBe(true);
    expect(picks).toHaveLength(1);
    expect(picks[0]).toBe(ranges[1]);
    // Teardown: chips gone, codewords retired + released.
    expect(chipCount()).toBe(0);
    expect(isRangePickPending()).toBe(false);
    expect(retired.flat().sort()).toEqual(['alpha', 'bravo', 'charlie']);
    expect(released.flat().sort()).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('routes mid-pair progress to the chips: narrows non-matching, resets on empty', () => {
    nextClaim = ['a b', 'c d'];
    startRangePick([makeRange(), makeRange()], () => {});
    const [ab, cd] = liveBadges();
    expect(liveBadges()).toHaveLength(2);
    // Prefix 'a': the 'a b' chip stays live with its prefix marked, 'c d'
    // is marked non-candidate (which the range-pick variant renders as a dim
    // in place, not a hide — see render/badge-variant.ts).
    expect(filterRangePickChips('a')).toBe(true);
    expect(ab.filtered).toBe(false);
    expect(ab.matchedChars).toBe(1);
    expect(cd.filtered).toBe(true);
    // Empty prefix = pair cancelled — everything resets.
    filterRangePickChips('');
    expect(ab.filtered).toBe(false);
    expect(ab.matchedChars).toBe(0);
    expect(cd.filtered).toBe(false);
    // No pick live → false, so content falls through to the store hints.
    cancelRangePick('test');
    expect(filterRangePickChips('a')).toBe(false);
  });

  it('chips are ordinary badges: range-pick variant, shown, and placed', () => {
    nextClaim = ['a b'];
    startRangePick([makeRange('phrase')], () => {});
    const [chip] = liveBadges();
    expect(chip.variant).toBe(RANGE_PICK_VARIANT);
    expect(chip.displayMode).toBe('letter'); // the user's badge setting, inherited
    expect(chip.label.letter).toBe('ab');
    expect(chip.shown).toBe(true);
    // Placed through the shared nudge model rather than a hardcoded -18px.
    expect(chip.positioned).not.toBeNull();
  });

  it('a multi-letter prefix narrows without a charAt(0) special case', () => {
    nextClaim = ['a b', 'a c'];
    startRangePick([makeRange(), makeRange()], () => {});
    const [ab, ac] = liveBadges();
    filterRangePickChips('ab');
    expect(ab.filtered).toBe(false);
    expect(ab.matchedChars).toBe(2);
    expect(ac.filtered).toBe(true);
  });

  it('ignores codewords that are not part of the pick', () => {
    startRangePick([makeRange(), makeRange()], () => {});
    expect(resolveRangePick('zulu')).toBe(false);
    expect(isRangePickPending()).toBe(true);
  });

  // jsdom gives every rect zeros, so the viewport filter finds nothing and the
  // fallback keeps prior behavior — which is why the other tests still pass
  // unchanged. These two stub geometry to exercise the filter itself.
  // "Off-screen" has to mean BEYOND THE BAND, not merely past the fold: chips
  // claim against the same VIEWPORT_MARGIN_PX band the link badges do, so a
  // match 60px above the fold is still a claim candidate (that pre-claim is
  // what makes a chip already painted when you scroll to it).
  const FAR = 4000;
  function withStubbedRects(onScreen: (text: string) => boolean): () => void {
    const original = Range.prototype.getBoundingClientRect;
    Range.prototype.getBoundingClientRect = function (this: Range): DOMRect {
      const visible = onScreen(this.toString());
      return (visible
        ? { top: 10, bottom: 30, left: 10, right: 60, width: 50, height: 20 }
        : { top: -FAR, bottom: -FAR + 20, left: 10, right: 60, width: 50, height: 20 }
      ) as DOMRect;
    };
    return () => { Range.prototype.getBoundingClientRect = original; };
  }

  it('badges only the matches currently in the viewport', async () => {
    const restore = withStubbedRects(text => text === 'seen');
    try {
      const ranges = [makeRange('gone'), makeRange('seen'), makeRange('gone'), makeRange('seen')];
      startRangePick(ranges, () => {});
      await Promise.resolve();
      // Two on-screen matches → two chips, and they claim the first two
      // codewords rather than the ones document order would have given.
      expect(chipCount()).toBe(2);
      expect(publishedRecords.map(r => r.codeword)).toEqual(['alpha', 'bravo']);
      // The pick resolves to an on-screen range, not the document-first one.
      expect(isRangePickPending('alpha')).toBe(true);
    } finally { restore(); }
  });

  it('acts on the first match when nothing is within a band of the viewport', async () => {
    const restore = withStubbedRects(() => false);
    try {
      const picks: Range[] = [];
      const ranges = [makeRange('a'), makeRange('b')];
      startRangePick(ranges, (r) => picks.push(r));
      await Promise.resolve();
      // Badging by document order here would arm a question made of chips the
      // user can't see and (correctly, per the strict cut) can't speak — a
      // wedge dressed as a UI. Acting scrolls the match into view instead.
      expect(chipCount()).toBe(0);
      expect(isRangePickPending()).toBe(false);
      expect(picks).toEqual([ranges[0]]);
    } finally { restore(); }
  });

  it('a chip past the fold is painted but NOT speakable until it is on screen', async () => {
    // The two cuts the link badges have: the band decides who wears a chip,
    // the strict viewport decides who voice will match (strict-viewport.ts).
    const view = withScrollableRects(['near']);
    try {
      // 'far' sits outside the viewport but inside the band, so it pre-claims.
      const original = Range.prototype.getBoundingClientRect;
      Range.prototype.getBoundingClientRect = function (this: Range): DOMRect {
        return (this.toString() === 'near'
          ? { top: 10, bottom: 30, left: 10, right: 60, width: 50, height: 20 }
          : { top: 900, bottom: 920, left: 10, right: 60, width: 50, height: 20 }
        ) as DOMRect;
      };
      startRangePick([makeRange('near'), makeRange('far')], () => {});
      await Promise.resolve();
      Range.prototype.getBoundingClientRect = original;

      expect(chipCount()).toBe(2); // both painted — the scroll-ahead cue
      const strict = new Map(publishedRecords.map(r => [r.codeword, r.in_strict_viewport]));
      expect(strict.get('alpha')).toBe(true);   // on screen -> speakable
      expect(strict.get('bravo')).toBe(false);  // past the fold -> a no-op
    } finally { view.restore(); }
  });

  it('a pre-claimed chip becomes speakable when it scrolls in, without changing codeword', async () => {
    const view = withScrollableRects(['near']);
    try {
      startRangePick([makeRange('near'), makeRange('far')], () => {});
      await Promise.resolve();
      const before = publishedRecords.length;

      view.scrollTo(['near', 'far']); // 'far' is now on screen
      reconcileRangePickChips();
      await Promise.resolve();

      // Only the eligibility flag is re-sent; the codeword is untouched.
      const republished = publishedRecords.slice(before);
      expect(republished.map(r => r.codeword)).toEqual(['bravo']);
      expect(republished[0].in_strict_viewport).toBe(true);
      expect(isRangePickPending('bravo')).toBe(true);
    } finally { view.restore(); }
  });

  // --- Rolling viewport window (reconcileRangePickChips) --------------------
  // Membership, not positioning: the badge seam made a chip FOLLOW its phrase,
  // but a match below the fold at arm time had no codeword at all, so scrolling
  // to it showed nothing. `visibleTexts` is the viewport — reassigning it is a
  // scroll.
  function withScrollableRects(initial: string[]): {
    scrollTo(texts: string[]): void; restore(): void;
  } {
    let visibleTexts = new Set(initial);
    const original = Range.prototype.getBoundingClientRect;
    Range.prototype.getBoundingClientRect = function (this: Range): DOMRect {
      return (visibleTexts.has(this.toString())
        ? { top: 10, bottom: 30, left: 10, right: 60, width: 50, height: 20 }
        : { top: -4000, bottom: -3980, left: 10, right: 60, width: 50, height: 20 }
      ) as DOMRect;
    };
    return {
      scrollTo: (texts) => { visibleTexts = new Set(texts); },
      restore: () => { Range.prototype.getBoundingClientRect = original; },
    };
  }

  it('scrolling gives the newly-visible matches their own chips', async () => {
    const view = withScrollableRects(['one', 'two']);
    try {
      const picks: Range[] = [];
      const ranges = ['one', 'two', 'three', 'four'].map(makeRange);
      startRangePick(ranges, (r) => picks.push(r));
      await Promise.resolve();
      expect(chipCount()).toBe(2);
      expect(isRangePickPending('alpha')).toBe(true);

      view.scrollTo(['three', 'four']);
      reconcileRangePickChips();
      await Promise.resolve();

      // Two chips again — for the matches now on screen, not the old ones.
      expect(chipCount()).toBe(2);
      // The departed codewords were RECYCLED onto the arrivals rather than
      // drawn fresh, so 'alpha' still resolves — but to the new range.
      expect(released.flat().sort()).toEqual(['alpha', 'bravo']);
      expect(publishedRecords.map(r => r.codeword)).toEqual(
        ['alpha', 'bravo', 'alpha', 'bravo']);
      expect(resolveRangePick('alpha')).toBe(true);
      expect(picks[0].toString()).toBe('three');
    } finally { view.restore(); }
  });

  it('a match that stays in view keeps its codeword', async () => {
    const view = withScrollableRects(['one', 'two']);
    try {
      startRangePick(['one', 'two', 'three'].map(makeRange), () => {});
      await Promise.resolve();
      // 'two' is bravo; it stays on screen across the scroll.
      expect(isRangePickPending('bravo')).toBe(true);

      view.scrollTo(['two', 'three']);
      reconcileRangePickChips();
      await Promise.resolve();

      // Renaming a chip the user is mid-way through reading is the thing to
      // avoid — 'two' keeps bravo, and only the departed 'one' was released.
      expect(isRangePickPending('bravo')).toBe(true);
      expect(released.flat()).toEqual(['alpha']);
      expect(chipCount()).toBe(2);
    } finally { view.restore(); }
  });

  it('scrolling past every match keeps the chips rather than emptying the pick', async () => {
    const view = withScrollableRects(['one', 'two']);
    try {
      startRangePick(['one', 'two'].map(makeRange), () => {});
      await Promise.resolve();

      view.scrollTo([]); // nothing on screen
      reconcileRangePickChips();
      await Promise.resolve();

      // Going to zero would leave a live pick that swallows every codeword with
      // nothing on screen to say why. Scrolling back restores them anyway.
      expect(chipCount()).toBe(2);
      expect(isRangePickPending('alpha')).toBe(true);
      expect(released.flat()).toEqual([]);
    } finally { view.restore(); }
  });

  it('a settled scroll that changes nothing is a no-op', async () => {
    const view = withScrollableRects(['one', 'two']);
    try {
      startRangePick(['one', 'two'].map(makeRange), () => {});
      await Promise.resolve();
      const postsAtArm = pickWindowPosts.length;
      const publishedAtArm = publishedRecords.length;

      reconcileRangePickChips();
      await Promise.resolve();

      expect(pickWindowPosts).toHaveLength(postsAtArm);
      expect(publishedRecords).toHaveLength(publishedAtArm);
      expect(chipCount()).toBe(2);
    } finally { view.restore(); }
  });

  it('reconciling with no pick pending does nothing', () => {
    expect(() => reconcileRangePickChips()).not.toThrow();
    expect(chipCount()).toBe(0);
  });

  it('arms the projection narrow with the admitted set, and releases on teardown', async () => {
    const ranges = [makeRange('a'), makeRange('b')];
    startRangePick(ranges, () => {});
    // Not armed before the publish lands — arming early would filter the chips
    // out of the projection too, blanking the HUD instead of narrowing it.
    expect(pickWindowPosts).toEqual([]);
    await Promise.resolve();
    await Promise.resolve();
    expect(pickWindowPosts).toEqual([['alpha', 'bravo']]);

    resolveRangePick('alpha');
    expect(pickWindowPosts).toEqual([['alpha', 'bravo'], []]);
  });

  it('releases the narrow when nothing was admitted', async () => {
    admitAll = false;
    startRangePick([makeRange(), makeRange()], () => {});
    await Promise.resolve();
    await Promise.resolve();
    // Teardown's release, and no arm — the chips never became speakable.
    expect(pickWindowPosts).toEqual([[]]);
  });

  it('never expires on wall clock — only an answer or an explicit exit ends it', () => {
    const picks: Range[] = [];
    startRangePick([makeRange(), makeRange()], (r) => picks.push(r));
    vi.advanceTimersByTime(10 * 60_000);
    expect(isRangePickPending()).toBe(true);
    expect(chipCount()).toBe(2);
    expect(picks).toHaveLength(0);

    cancelRangePick('voice_escape');
    expect(isRangePickPending()).toBe(false);
    expect(chipCount()).toBe(0);
    expect(released.flat()).toHaveLength(2);
  });

  it('a new pick replaces a pending one', () => {
    startRangePick([makeRange(), makeRange()], () => {});
    const firstReleased = released.length;
    startRangePick([makeRange(), makeRange()], () => {});
    expect(released.length).toBeGreaterThan(firstReleased);
    expect(chipCount()).toBe(2); // only the second pick's chips
  });

  it('caps badges at MAX_RANGE_BADGES with a visible toast (no silent truncation)', () => {
    nextClaim = Array.from({ length: 20 }, (_, i) => `cw${i}`);
    const ranges = Array.from({ length: 14 }, () => makeRange());
    startRangePick(ranges, () => {});
    expect(chipCount()).toBe(MAX_RANGE_BADGES);
    expect(toasts.some(t => t.includes('14 matches'))).toBe(true);
  });

  it('falls back to the first range when the pool is dry', () => {
    nextClaim = [];
    const picks: Range[] = [];
    const ranges = [makeRange('a'), makeRange('b')];
    startRangePick(ranges, (r) => picks.push(r));
    expect(picks).toEqual([ranges[0]]);
    expect(isRangePickPending()).toBe(false);
    expect(chipCount()).toBe(0);
  });

  it('drops chips for codewords the plugin refused', async () => {
    admitAll = false;
    startRangePick([makeRange(), makeRange()], () => {});
    await Promise.resolve(); // let the publish settle
    await Promise.resolve();
    expect(isRangePickPending()).toBe(false);
    expect(chipCount()).toBe(0);
  });
});
