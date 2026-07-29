import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Is a voice alphabet loaded — i.e. is there a platform that could admit these
// codewords for SPEECH? Chips must work either way: with no platform nothing is
// admitted, but the codewords are still typeable. Default true so the existing
// cases exercise the admission path; flipped per-test for the standalone case.
let voiceAlphabetLoaded = true;
vi.mock('../labels/words', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../labels/words')>()),
  isVoiceAlphabetLoaded: () => voiceAlphabetLoaded,
}));

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
const deleteCancels: string[] = [];
let admitAll = true;
vi.mock('../labels/label-sync', () => ({
  publishRecords: async (records: Array<{ codeword: string }>) => {
    publishedRecords.push(...records);
    return new Set(admitAll ? records.map(r => r.codeword) : []);
  },
  retireRecords: (codewords: string[]) => { retired.push(codewords); },
  cancelPendingDelete: (codeword: string) => { deleteCancels.push(codeword); },
}));

const toasts: string[] = [];
vi.mock('../render/toast', () => ({
  flashToast: (text: string) => { toasts.push(text); },
}));
vi.mock('../debug/bk-log', () => ({ bkLog: () => {} }));

vi.mock('../plugin/resolve', () => ({
  reportDispatchResult: () => {},
}));

// The chips register in the REAL holder registry (no mock — synthetic
// participants over module replacement, per the design's testing strategy);
// the sweeps drive the registry's own fan-outs.

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

// The badge half of the pick's screen borrow is the shared primitive in
// render/badge-visibility.ts (tested there against the real singletons); here
// it is a SYNTHETIC borrow over a one-field screen model, so these tests pin
// the pick's obligations — borrow at arm, give back exactly once on whichever
// exit runs — without booting content's badge layer.
const screen = vi.hoisted(() => ({ showing: false, shown: 0, hidden: 0 }));
vi.mock('../render/badge-visibility', () => ({
  borrowBadgeScreen: () => {
    const took = screen.showing;
    if (took) { screen.hidden++; screen.showing = false; }
    let returned = false;
    return {
      took,
      restore() {
        if (returned) return;
        returned = true;
        if (took) { screen.shown++; screen.showing = true; }
      },
    };
  },
  // find's single-slot borrow, which it drives itself now (scan/find.ts) —
  // these arrive here because teardown calls clearFindPaint. Deliberately inert
  // and deliberately NOT wired to `screen`: no find borrow is ever live in this
  // file, so a wired fake would be indistinguishable from this one, and the
  // pick's borrow above is what these tests are about. find's own borrow is
  // pinned in scan/find.test.ts ("every entry point takes the badge screen").
  assertBadgeScreenBorrow: () => {},
  returnBadgeScreenBorrow: () => {},
}));

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
  startRangePick, cancelRangePick, isRangePickPending,
  MAX_RANGE_BADGES,
} from './range-disambiguation';
import { keyHandler } from '../core/singletons';
import {
  __resetHolderRegistry, resolveCodeword, anyHolderMatchesPrefix,
  narrowByPrefix, soleHolderMatch, republishAll, rejectAll, reconcileAll,
  allHeld, disposeAllHolders,
} from '../labels/holder-registry';
import { modes } from '../core/modes';

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
    __resetHolderRegistry();
    modes.reset();
    claimed.length = 0;
    released.length = 0;
    publishedRecords.length = 0;
    retired.length = 0;
    deleteCancels.length = 0;
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

    expect(resolveCodeword('bravo')).toEqual({ kind: 'acted', holder: 'pick' });
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
    // Prefix 'a' through the registry: the exclusive chips take the progress;
    // the 'a b' chip stays live with its prefix marked, 'c d' is marked
    // non-candidate (which the range-pick variant renders as a dim in place,
    // not a hide — see render/badge-variant.ts).
    narrowByPrefix('a');
    expect(ab.filtered).toBe(false);
    expect(ab.matchedChars).toBe(1);
    expect(cd.filtered).toBe(true);
    // Empty prefix = pair cancelled — everything resets.
    narrowByPrefix('');
    expect(ab.filtered).toBe(false);
    expect(ab.matchedChars).toBe(0);
    expect(cd.filtered).toBe(false);
    // No pick live → the holder is unregistered, so the keyboard's accept
    // gate no longer answers for chips and progress falls through.
    cancelRangePick('test');
    expect(anyHolderMatchesPrefix('a')).toBe(false);
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
    narrowByPrefix('ab');
    expect(ab.filtered).toBe(false);
    expect(ab.matchedChars).toBe(2);
    expect(ac.filtered).toBe(true);
  });

  it('SWALLOWS codewords that are not part of the pick — the exclusive claim', () => {
    startRangePick([makeRange(), makeRange()], () => {});
    // Not 'none': while the question is up, a stray badge codeword must not
    // fall through and click a link out from under it. The caller owns the
    // refusal guidance, keyed on the named holder.
    expect(resolveCodeword('zulu')).toEqual({ kind: 'swallowed', holder: 'pick' });
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
    // 'far' sits outside the viewport but inside the band, so it pre-claims.
    const view = withScrollableRects(['near'], ['far']);
    try {
      startRangePick([makeRange('near'), makeRange('far')], () => {});
      await Promise.resolve();

      expect(chipCount()).toBe(2); // both painted — the scroll-ahead cue
      const strict = new Map(publishedRecords.map(r => [r.codeword, r.in_strict_viewport]));
      expect(strict.get('alpha')).toBe(true);   // on screen -> speakable
      expect(strict.get('bravo')).toBe(false);  // past the fold -> a no-op
    } finally { view.restore(); }
  });

  it('refuses to pick a chip whose match is off screen, and keeps the pick live', async () => {
    // Seen-is-pickable, the chips' twin of the element path's sealed strict
    // gate. The band paints chips past the fold as a scroll-ahead cue, so a
    // chip can hold a codeword the user has never read — acting on it would be
    // acting on something they can't see.
    const view = withScrollableRects(['near'], ['far']);
    try {
      const picks: Range[] = [];
      startRangePick([makeRange('near'), makeRange('far')], (r) => picks.push(r));
      await Promise.resolve();

      expect(resolveCodeword('bravo')).toEqual({ kind: 'off_screen', holder: 'pick' }); // 'far'
      expect(picks).toEqual([]);
      expect(isRangePickPending()).toBe(true);   // still live — scroll and retry
      expect(isRangePickPending('bravo')).toBe(true); // codeword kept
      expect(toasts.some(t => t.includes('off screen'))).toBe(true);

      // Scroll to it and the same codeword now works.
      view.scrollTo(['near', 'far']);
      reconcileAll('general');
      await Promise.resolve();
      expect(resolveCodeword('bravo')).toEqual({ kind: 'acted', holder: 'pick' });
      expect(picks.map(String)).toEqual(['far']);
    } finally { view.restore(); }
  });

  it('reads geometry live, not the flag published at the last scroll settle', async () => {
    // A dispatch can land mid-scroll, after the chip moved but before the
    // settle re-published its eligibility. The gate must not trust the flag.
    const view = withScrollableRects(['near', 'far']);
    try {
      startRangePick([makeRange('near'), makeRange('far')], () => {});
      await Promise.resolve();
      expect(isRangePickPending('bravo')).toBe(true);

      // 'far' slides past the fold with NO reconcile — Chip.strict still true.
      view.scrollTo(['near'], ['far']);
      expect(resolveCodeword('bravo')).toEqual({ kind: 'off_screen', holder: 'pick' });
    } finally { view.restore(); }
  });

  it('a pre-claimed chip becomes speakable when it scrolls in, without changing codeword', async () => {
    // 'far' pre-claims at arm (in band, past the fold) so this exercises the
    // eligibility FLIP, not a new chip arriving.
    const view = withScrollableRects(['near'], ['far']);
    try {
      startRangePick([makeRange('near'), makeRange('far')], () => {});
      await Promise.resolve();
      expect(chipCount()).toBe(2);
      const before = publishedRecords.length;

      view.scrollTo(['near', 'far']); // 'far' is now on screen
      reconcileAll('general');
      await Promise.resolve();

      // No membership change — only the eligibility flag is re-sent, and the
      // codeword is untouched.
      const republished = publishedRecords.slice(before);
      expect(republished.map(r => r.codeword)).toEqual(['bravo']);
      expect(republished[0].in_strict_viewport).toBe(true);
      expect(isRangePickPending('bravo')).toBe(true);
      expect(chipCount()).toBe(2);
    } finally { view.restore(); }
  });

  // --- Rolling viewport window (reconcileRangePickChips) --------------------
  // Membership, not positioning: the badge seam made a chip FOLLOW its phrase,
  // but a match below the fold at arm time had no codeword at all, so scrolling
  // to it showed nothing. `visibleTexts` is the viewport — reassigning it is a
  // scroll.
  // Three positions, because the band and the strict cut are different lines:
  // ON SCREEN (overhang 0, pickable), JUST PAST THE FOLD (off screen but inside
  // VIEWPORT_MARGIN_PX — pre-claims a chip, not pickable), and FAR (outside the
  // band entirely — no chip at all).
  function withScrollableRects(initial: string[], nearbyInit: string[] = []): {
    scrollTo(texts: string[], nearby?: string[]): void; restore(): void;
  } {
    let visibleTexts = new Set(initial);
    let nearbyTexts = new Set(nearbyInit);
    const original = Range.prototype.getBoundingClientRect;
    Range.prototype.getBoundingClientRect = function (this: Range): DOMRect {
      const t = this.toString();
      if (visibleTexts.has(t)) {
        return { top: 10, bottom: 30, left: 10, right: 60, width: 50, height: 20 } as DOMRect;
      }
      if (nearbyTexts.has(t)) {
        const y = window.innerHeight + 120; // past the fold, inside the band
        return { top: y, bottom: y + 20, left: 10, right: 60, width: 50, height: 20 } as DOMRect;
      }
      return { top: -4000, bottom: -3980, left: 10, right: 60, width: 50, height: 20 } as DOMRect;
    };
    return {
      scrollTo: (texts, nearby = []) => {
        visibleTexts = new Set(texts);
        nearbyTexts = new Set(nearby);
      },
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
      reconcileAll('general');
      await Promise.resolve();

      // Two chips again — for the matches now on screen, not the old ones.
      expect(chipCount()).toBe(2);
      // The departed codewords were RECYCLED onto the arrivals rather than
      // drawn fresh, so 'alpha' still resolves — but to the new range.
      expect(released.flat().sort()).toEqual(['alpha', 'bravo']);
      expect(publishedRecords.map(r => r.codeword)).toEqual(
        ['alpha', 'bravo', 'alpha', 'bravo']);
      expect(resolveCodeword('alpha')).toEqual({ kind: 'acted', holder: 'pick' });
      expect(picks[0].toString()).toBe('three');
    } finally { view.restore(); }
  });

  it('a recycled codeword un-queues its own pending delete', async () => {
    // Field bug 2026-07-25: the window releases before it claims so codewords
    // recycle, but the retire rides the DEBOUNCED batch while the re-publish
    // goes out immediately — so the delete landed after the put and stripped a
    // live chip from the hint collections. Painted, armed, and missing from the
    // HUD's suffix menu: say the prefix, get an empty second-word list.
    const view = withScrollableRects(['one', 'two']);
    try {
      startRangePick(['one', 'two', 'three', 'four'].map(makeRange), () => {});
      await Promise.resolve();
      const atArm = deleteCancels.length; // arm-time calls are harmless no-ops

      view.scrollTo(['three', 'four']);
      reconcileAll('general');
      await Promise.resolve();

      // The reservoir hands the released pair straight back (sticky reclaim),
      // so both retired codewords are re-minted — and both retires cancelled.
      expect(retired.flat().sort()).toEqual(['alpha', 'bravo']);
      expect(deleteCancels.slice(atArm).sort()).toEqual(['alpha', 'bravo']);
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
      reconcileAll('general');
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
      reconcileAll('general');
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

      reconcileAll('general');
      await Promise.resolve();

      expect(pickWindowPosts).toHaveLength(postsAtArm);
      expect(publishedRecords).toHaveLength(publishedAtArm);
      expect(chipCount()).toBe(2);
    } finally { view.restore(); }
  });

  it('declares its codewords to the reservoir leak sweep while a pick is live', async () => {
    // Without this the sweep sees grants no store wrapper holds, calls them
    // leaked after 30s, releases them to the pool AND deletes them plugin-side
    // — a live pick dying on a wall clock the module says it doesn't have.
    startRangePick([makeRange('a'), makeRange('b')], () => {});
    await Promise.resolve();
    expect(allHeld().sort()).toEqual(['alpha', 'bravo']);

    // And stops declaring them the moment the pick ends, or the fix becomes a leak.
    cancelRangePick('test');
    expect(allHeld()).toEqual([]);
  });

  it('re-publishes its records on a session rotation', async () => {
    // Every rotation path enumerates store.all; chips aren't there, so the
    // plugin drops them at the rotation's is_final batch. The holder's
    // republish is the chips' seat at that table.
    startRangePick([makeRange('a'), makeRange('b')], () => {});
    await Promise.resolve();
    const before = publishedRecords.length;

    republishAll();
    await Promise.resolve();

    const republished = publishedRecords.slice(before);
    expect(republished.map(r => r.codeword).sort()).toEqual(['alpha', 'bravo']);
    // Re-armed with the live set so the plugin's projection narrow follows.
    expect(pickWindowPosts[pickWindowPosts.length - 1].sort()).toEqual(['alpha', 'bravo']);
  });

  it('drops a chip whose codeword another document won', async () => {
    startRangePick([makeRange('a'), makeRange('b')], () => {});
    await Promise.resolve();

    rejectAll('alpha');

    expect(isRangePickPending('alpha')).toBe(false);
    expect(isRangePickPending('bravo')).toBe(true);
    expect(chipCount()).toBe(1); // the loser's badge is gone, not just muted
  });

  it('ends the pick when every codeword is rejected', async () => {
    startRangePick([makeRange('a'), makeRange('b')], () => {});
    await Promise.resolve();

    rejectAll('alpha');
    rejectAll('bravo');

    expect(isRangePickPending()).toBe(false);
    expect(chipCount()).toBe(0);
    expect(toasts.some(t => t.includes('Lost the highlighted matches'))).toBe(true);
  });

  it('reaps a chip whose range left the DOM, and ends the pick if that empties it', async () => {
    const a = makeRange('a'), b = makeRange('b');
    startRangePick([a, b], () => {});
    await Promise.resolve();
    expect(chipCount()).toBe(2);

    // The page re-renders 'a' away. A Range never rebinds.
    (a.commonAncestorContainer.parentElement as HTMLElement).remove();
    reconcileAll('general');
    await Promise.resolve();

    expect(chipCount()).toBe(1);
    expect(isRangePickPending('alpha')).toBe(false);
    expect(released.flat()).toEqual(['alpha']); // codeword returned to the pool
    expect(isRangePickPending()).toBe(true);

    // Now the rest goes too — the pick must not survive as a codeword-swallower
    // with nothing on screen to explain itself.
    (b.commonAncestorContainer.parentElement as HTMLElement).remove();
    reconcileAll('general');
    await Promise.resolve();

    expect(isRangePickPending()).toBe(false);
    expect(chipCount()).toBe(0);
    expect(toasts.some(t => t.includes('Lost the highlighted matches'))).toBe(true);
  });

  it('keeps a chip whose range is merely collapsed but still connected', async () => {
    // A hidden accordion collapses the rect without killing the range; that
    // must not drop the chip, or a reveal loses its codeword for no reason.
    const restore = withStubbedRects(() => false); // every rect collapses
    try {
      startRangePick([makeRange('a'), makeRange('b')], () => {});
      await Promise.resolve();
      const before = chipCount();
      reconcileAll('general');
      await Promise.resolve();
      expect(chipCount()).toBe(before);
      expect(released.flat()).toEqual([]);
    } finally { restore(); }
  });

  it('republish is a no-op with no pick live', () => {
    const before = publishedRecords.length;
    republishAll();
    expect(publishedRecords).toHaveLength(before);
  });

  it('reconciling with no pick pending does nothing', () => {
    expect(() => reconcileAll('general')).not.toThrow();
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

    resolveCodeword('alpha');
    expect(pickWindowPosts).toEqual([['alpha', 'bravo'], []]);
  });

  it('keeps the pick armed when the publish is refused, and stays narrowed', async () => {
    // A refused publish is always LOCAL: no voice alphabet, a transport failure
    // (BranchKit not running), or a plugin-side validation refusal. None of them
    // means the codeword now belongs to somewhere else, so the chips stay
    // painted — they are still typeable — and RangeBadgeSet retries the publish
    // on the next reconcile, which makes them speakable the moment voice
    // arrives. Dropping them here instead put "Lost the highlighted matches" on
    // screen every time the app happened to be closed (2026-07-26).
    //
    // The one refusal that DOES drop a chip is a cross-document collision, and
    // it arrives by a different route entirely (onCodewordRejected, covered
    // above) — which is what makes the two distinguishable without parsing a
    // reason string.
    admitAll = false;
    startRangePick([makeRange(), makeRange()], () => {});
    await Promise.resolve();
    await Promise.resolve();
    expect(isRangePickPending()).toBe(true);
    expect(chipCount()).toBe(2);
    expect(pickWindowPosts).toEqual([['alpha', 'bravo']]);
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

  // Speakable and USABLE are different properties, and conflating them broke
  // the keyboard entry: with no platform there is nothing to admit, so every
  // chip was dropped and the pick gave up with "Lost the highlighted matches"
  // on a page where the codewords were perfectly typeable (2026-07-26).
  it('KEEPS its chips when there is no platform to admit them', async () => {
    voiceAlphabetLoaded = false;
    admitAll = false;   // would drop everything if admission were consulted
    try {
      startRangePick([makeRange(), makeRange()], () => {});
      await Promise.resolve();
      await Promise.resolve();
      expect(isRangePickPending()).toBe(true);
      expect(chipCount()).toBe(2);
    } finally {
      voiceAlphabetLoaded = true;
    }
  });

  // ...and the codewords are reachable by PREFIX, which is what the keyboard
  // needs to accept the first keystroke at all.
  // --- Entry state (what the pick borrows and owes back) --------------------
  // A pick is modal in two ways at once: it hides the page's badges AND takes
  // the keyboard. It used to record only the first, and always released the
  // keys to 'normal' — so answering a pick armed from hint mode handed back a
  // repainted page whose badge letters fired keybinds instead (2026-07-26).
  describe('entry state (the stack floor payload — Wave 3 C3b)', () => {
    // The badge half rides the shared borrow primitive (the synthetic above)
    // and the keyboard goes through the singleton; the floor rides the
    // range_pick entry, so what push recorded is what whichever exit runs
    // gives back. Assertions read the synthetic's counters.
    function arrangeScreen(at: { badgesVisible: boolean; hintMode: boolean }): void {
      screen.showing = at.badgesVisible;
      screen.shown = 0;
      screen.hidden = 0;
      if (at.hintMode) keyHandler.enterHintMode();
      else keyHandler.exitHintMode();
    }
    afterEach(() => {
      keyHandler.exitHintMode();
      screen.showing = false;
    });

    it('gives back BOTH halves of what it took — badges and keyboard mode', () => {
      arrangeScreen({ badgesVisible: true, hintMode: true });
      startRangePick([makeRange('a'), makeRange('b')], () => {});
      expect(screen.hidden).toBe(1);
      expect(keyHandler.isHintMode()).toBe(true); // capturing codeword keys
      expect(screen.shown).toBe(0);

      resolveCodeword('alpha');
      expect(screen.shown).toBe(1);                      // badges back
      expect(keyHandler.isHintMode()).toBe(true); // hint mode back
    });

    // The nav arm. A same-document navigation owns what the NEW page looks
    // like, so the pick must not hand the old page's badge state back on its
    // way out — restore() kicks an ASYNC showBadges that raises
    // pageSession.badgesVisible a frame later, while the nav path reads that
    // flag synchronously to decide whether the new page starts hidden. The
    // keyboard half still runs, because a nav must not strand the user in a
    // hint mode entered for chips that no longer exist. Asserting the halves
    // SEPARATELY is the whole point — skipping both would also leave
    // screen.shown at 0.
    it('a nav teardown gives back the keyboard but NOT the badges', () => {
      // hintMode FALSE at arm, then entered during the pick (`f` at the chips).
      // That is what makes the keyboard assertion able to fail: restoring to a
      // floor of `false` must EXIT hint mode, so skipping the keyboard half is
      // visible. Arming with hintMode already true would leave the flag true
      // either way — the restore's enterHintMode is a no-op re-entry — and the
      // test would pass against an implementation that restored nothing at all.
      arrangeScreen({ badgesVisible: true, hintMode: false });
      startRangePick([makeRange('a'), makeRange('b')], () => {});
      keyHandler.enterHintMode();
      expect(screen.hidden).toBe(1);
      expect(screen.shown).toBe(0);

      cancelRangePick('spa_nav', false);
      expect(screen.shown).toBe(0);                // badges NOT re-shown
      expect(keyHandler.isHintMode()).toBe(false); // keyboard half DID restore
      expect(isRangePickPending()).toBe(false);
    });

    it('every other exit still gives both halves back', () => {
      arrangeScreen({ badgesVisible: true, hintMode: true });
      startRangePick([makeRange('a'), makeRange('b')], () => {});
      cancelRangePick('escape'); // the default, unchanged
      expect(screen.shown).toBe(1);
      expect(keyHandler.isHintMode()).toBe(true);
    });

    it('takes the screen but NOT the keyboard — `f` still hands that over', () => {
      // Arming used to call enterHintMode() so chips were instantly typable.
      // That silently swapped the whole Normal keymap for codeword input, so
      // j/k stopped scrolling exactly when a pick's off-screen matches made
      // scrolling necessary (field, 2026-07-27). Visible and typable are
      // separate states; a pick is not a reason to collapse them.
      arrangeScreen({ badgesVisible: true, hintMode: false });
      startRangePick([makeRange('a'), makeRange('b')], () => {});
      expect(isRangePickPending()).toBe(true);      // chips are up
      expect(keyHandler.isHintMode()).toBe(false);  // ...and keys are still commands
    });

    it('leaves an ALREADY-live hint mode alone when it arms', () => {
      // The converse: entering a pick must not exit hint mode either. The user
      // was typing at hints, said "highlight <phrase>", and the chips join the
      // mode already in progress.
      arrangeScreen({ badgesVisible: true, hintMode: true });
      startRangePick([makeRange('a'), makeRange('b')], () => {});
      expect(keyHandler.isHintMode()).toBe(true);
    });

    it('restores the state it actually found, not a fixed one', () => {
      arrangeScreen({ badgesVisible: false, hintMode: false });
      startRangePick([makeRange('a'), makeRange('b')], () => {});
      expect(screen.hidden).toBe(0); // nothing was up, nothing to hide
      cancelRangePick('escape');
      expect(screen.shown).toBe(0);
      expect(keyHandler.isHintMode()).toBe(false);
    });

    it('restores once, on whichever exit runs first', () => {
      arrangeScreen({ badgesVisible: true, hintMode: false });
      startRangePick([makeRange('a'), makeRange('b')], () => {});
      cancelRangePick('escape');
      cancelRangePick('escape_again');
      expect(screen.shown).toBe(1);
    });

    it('restores when the set empties itself rather than being answered', async () => {
      // onEmpty is the exit that does not go through teardown — under the
      // floor payload it cannot hold its own half-copy of the restore rule.
      arrangeScreen({ badgesVisible: true, hintMode: true });
      const a = makeRange('a'), b = makeRange('b');
      startRangePick([a, b], () => {});
      await Promise.resolve();
      (a.commonAncestorContainer.parentElement as HTMLElement).remove();
      (b.commonAncestorContainer.parentElement as HTMLElement).remove();
      reconcileAll('general');
      await Promise.resolve();

      expect(isRangePickPending()).toBe(false);
      expect(screen.shown).toBe(1);
      expect(keyHandler.isHintMode()).toBe(true);
    });

    it('the registry dispose fan-out ends the whole question (orphan teardown)', async () => {
      // quiesceOrphan calls disposeAllHolders instead of naming this module:
      // the holder's dispose must route through the full cancel — pending
      // cleared, plugin-side projection narrow released, floor given back —
      // not just the set's badge teardown.
      arrangeScreen({ badgesVisible: true, hintMode: true });
      startRangePick([makeRange('a'), makeRange('b')], () => {});
      await Promise.resolve();
      await Promise.resolve();

      disposeAllHolders('teardown_orphan');

      expect(isRangePickPending()).toBe(false);
      expect(chipCount()).toBe(0);
      expect(pickWindowPosts[pickWindowPosts.length - 1]).toEqual([]);
      expect(screen.shown).toBe(1);
      expect(allHeld()).toEqual([]);
    });

    it('never entered the window means nothing to give back', () => {
      // The pool is dry, so the pick acts on the first match instead of arming.
      nextClaim = [];
      arrangeScreen({ badgesVisible: true, hintMode: true });
      startRangePick([makeRange('a'), makeRange('b')], () => {});
      expect(screen.hidden).toBe(0);
      expect(screen.shown).toBe(0);
      expect(modes.has('range_pick')).toBe(false);
    });
  });

  it('answers prefix queries so the keyboard can address a chip', () => {
    nextClaim = ['a b', 'c d'];
    startRangePick([makeRange(), makeRange()], () => {});
    expect(chipCount()).toBe(2);
    expect(anyHolderMatchesPrefix('a')).toBe(true);
    // Exclusive: the chips answer ALONE — a letter no chip can complete is
    // refused rather than falling through to anything underneath.
    expect(anyHolderMatchesPrefix('z')).toBe(false);
    // Firing takes the WHOLE codeword, matching what the chip paints. A bare
    // 'a' narrows the set but resolves nothing, even though it leaves exactly
    // one candidate: the chip reads "ab", and a chip that picks itself
    // mid-word reads as the pick vanishing (field, 2026-07-27). This is where
    // a badge SET differs from the ambient store, whose dense codewords make
    // prefix-firing indistinguishable from typing the whole thing.
    expect(soleHolderMatch('a')).toBe(null);
    expect(soleHolderMatch('ab')).toBe('a b');
    expect(soleHolderMatch('')).toBe(null);

    // No pick up: the holder is gone from the registry, so the fall-through
    // to whatever else is registered happens by construction.
    cancelRangePick('test');
    expect(anyHolderMatchesPrefix('a')).toBe(false);
  });

  // --- Wave 3 C2: the mode stack rides the pick's lifetime ------------------

  it('arming pushes the mode; every exit pops it', async () => {
    startRangePick([makeRange('a'), makeRange('b')], () => {});
    expect(modes.has('range_pick')).toBe(true);
    expect(modes.top()).toBe('range_pick');

    resolveCodeword('alpha'); // answered
    expect(modes.has('range_pick')).toBe(false);

    startRangePick([makeRange('c'), makeRange('d')], () => {});
    cancelRangePick('escape'); // abandoned
    expect(modes.has('range_pick')).toBe(false);
  });

  it('the not-armed fallback never enters the mode', () => {
    nextClaim = []; // dry pool: acts on the first match instead of arming
    startRangePick([makeRange('a'), makeRange('b')], () => {});
    expect(modes.has('range_pick')).toBe(false);
  });

  it('the set emptying itself pops the mode with everything else', async () => {
    const a = makeRange('a'), b = makeRange('b');
    startRangePick([a, b], () => {});
    await Promise.resolve();
    (a.commonAncestorContainer.parentElement as HTMLElement).remove();
    (b.commonAncestorContainer.parentElement as HTMLElement).remove();
    reconcileAll('general');
    await Promise.resolve();
    expect(isRangePickPending()).toBe(false);
    expect(modes.has('range_pick')).toBe(false);
  });
});
