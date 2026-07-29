/**
 * The shared search-match colour.
 *
 * `find-highlight.ts` exists for one reason — two layers must agree on what
 * "this is a search match" looks like, and a second copy of the hex is a thing
 * that drifts — and until now nothing observed either half of that. The module
 * landed with no test at all (review, 2026-07-27): its colour could have been
 * changed, or `badge-variant` un-wired to hold its own copy, with every one of
 * the 2131 tests still green.
 *
 * Note what the coupling test does NOT do. `expect(SEARCH_VARIANT.fill).toEqual(
 * { tint: FIND_HIGHLIGHT })` is the obvious assertion and it is worthless here:
 * it passes just as well when badge-variant hardcodes its own '#ffeb3b',
 * because the two values are equal either way. That was my first attempt and it
 * survived exactly the mutant it was written to catch. The only way to see the
 * difference is to change the constant and check the badge MOVED — so the test
 * mocks the module to a colour nothing else in the tree uses.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { FIND_HIGHLIGHT } from './find-highlight';
import { SEARCH_VARIANT } from './badge-variant';

/** A colour no other module could plausibly hold, so a match cannot be luck. */
const SENTINEL = '#010203';

afterEach(() => {
  vi.doUnmock('./find-highlight');
  vi.resetModules();
});

describe('the search-match colour is shared, not copied', () => {
  it('the badge tint FOLLOWS the constant rather than duplicating its value', async () => {
    vi.resetModules();
    vi.doMock('./find-highlight', () => ({ FIND_HIGHLIGHT: SENTINEL }));

    const { SEARCH_VARIANT: rewired } = await import('./badge-variant');

    // Fails the moment badge-variant stops reading the shared constant, even
    // if the literal it substitutes is byte-identical to the real one.
    expect(rewired.fill).toEqual({ tint: SENTINEL });
  });

  it('ships the real colour wired the same way', () => {
    expect(SEARCH_VARIANT.fill).toEqual({ tint: FIND_HIGHLIGHT });
  });

  it('is a colour the CSS in find.ts can actually use', () => {
    // find interpolates it straight into a ::highlight() background-color
    // (scan/find.ts ensureHighlightStyle). A malformed value fails silently
    // there — the rule is dropped and matches paint unstyled.
    expect(FIND_HIGHLIGHT).toMatch(/^#[0-9a-fA-F]{6}$/);
  });
});
