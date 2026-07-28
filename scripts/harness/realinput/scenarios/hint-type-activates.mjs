/**
 * Typing a codeword activates its element — and an ARMED verb acts on it
 * instead of following it.
 *
 * This is `activateWrapper`, the function every keyboard hint action ends in,
 * and before this scenario nothing anywhere executed it. Not a unit test (it
 * was a `content.ts` local, and the entry points have no tests by design,
 * DESIGN_ENTRY_POINT_TOPOLOGY.md open question 4); not the messages harness
 * (that drives BRANCHKIT_ACTION, whose element verbs are a different code path
 * entirely — section 6g.7 measured that the two share no dependency); not any
 * scenario here (`answerPickByTyping` reaches range-pick chips, not the store).
 * Measured, not assumed: replacing the whole body with `return` left tsc, all
 * thirteen lints, 2,278 tests and every harness green.
 *
 * Section 6l's rule is why that matters now — a relocation verified textually
 * is a relocation whose rule was never run.
 *
 * TWO halves, and neither alone discriminates:
 *
 *   - PLAIN: `f`, then type — the default branch, `activateElement`. Observable
 *     is the page's own click event plus the hash it navigates to. A no-op
 *     mutant records nothing.
 *   - ARMED: `gf` (focus_hint), then type — the `hintAction === 'focus'` branch,
 *     which focuses and RETURNS before the activation below it. Observable is
 *     activeElement, and the assertion that carries it is that NO new click
 *     landed: dropping the branch falls straight through to `activateElement`,
 *     so a click-only check would pass against a `gf` that clicked the link.
 *
 * The codeword is found by walking the alphabet rather than read out of the
 * badge, deliberately. `bkOpenShadow` would make the typing deterministic, but
 * it OPENS the badge shadow roots — and `shownBadges`, the driver probe five
 * other scenarios assert on, identifies a real badge BY its closed shadow root.
 * Every scenario in a run shares one page and one origin, so setting the flag
 * would make this scenario's position in the list load-bearing for the others.
 * It runs last today, which makes that harmless today; relying on it would be
 * the kind of order coupling a harness should not have.
 *
 * (An earlier draft of this comment said the flag would leak to the NEXT RUN
 * via a persistent profile. That is wrong — `launchExtension` and
 * `launchFirefoxExtension` both default `freshProfile = true` and rm -rf the
 * profile before launch. The walk is still the right call, for the reason
 * above.)
 *
 * The walk works because `narrowByPrefix` refuses a letter no live codeword can
 * complete, so the prefix only ever grows along a real path.
 */

import { freshPage, settle } from '../driver.mjs';

/** Clicks the page itself saw, newest last: [tag, href, text]. */
const clicks = (page) => page.evaluate(() => globalThis.__bkClicks ?? []);

async function watchClicks(page) {
  await page.evaluate(() => {
    globalThis.__bkClicks = [];
    document.addEventListener('click', (e) => {
      const el = e.target instanceof Element ? e.target.closest('a') ?? e.target : null;
      globalThis.__bkClicks.push([
        el?.tagName ?? '?', el?.getAttribute?.('href') ?? '', (el?.textContent ?? '').trim(),
      ]);
    }, true);
  });
}

/**
 * Press letters until `done()` answers truthily, and return what it answered.
 * Refused letters do not extend the prefix, so a full sweep composes a real
 * codeword one accepted letter at a time. Returns null if 26 letters changed
 * nothing — which means the keyboard never reached the badges at all.
 */
async function typeUntil(page, done) {
  for (const ch of 'abcdefghijklmnopqrstuvwxyz') {
    await page.keyboard.press(ch);
    await settle(120);
    const got = await done();
    if (got) return got;
  }
  return null;
}

export async function run({ page, base }) {
  await freshPage(page, base);
  await watchClicks(page);

  const links = await page.evaluate(() => document.querySelectorAll('a[href^="#a"]').length);
  if (links === 0) throw new Error('fixture has no anchor links — nothing to activate');

  // --- Half 1: `f`, type, the element is followed --------------------------
  await page.keyboard.press('f');
  await settle(400);

  const followed = await typeUntil(page, async () => {
    const hash = await page.evaluate(() => location.hash);
    return hash ? hash : null;
  });
  if (!followed) {
    throw new Error(
      'typed the whole alphabet in hint mode and no element activated — ' +
      'activateWrapper never ran (or the store never took the keyboard)',
    );
  }
  const afterPlain = await clicks(page);
  const lastClick = afterPlain[afterPlain.length - 1];
  if (!lastClick || lastClick[0] !== 'A') {
    throw new Error(
      `the hash moved to ${followed} but the page saw no click on an <a> ` +
      `(saw ${JSON.stringify(afterPlain)}) — the navigation did not come from activateElement`,
    );
  }
  if (lastClick[1] !== followed) {
    throw new Error(
      `clicked ${lastClick[1]} but the page is at ${followed} — the activation ` +
      'landed on a different element than the one that navigated',
    );
  }

  // --- Half 2: `gf`, type, the element is FOCUSED and not followed ---------
  //
  // Reset first: the hash is the half-1 observable and a stale one would let
  // half 2 pass without focusing anything.
  await page.keyboard.press('Escape');
  await settle(300);
  await page.evaluate(() => {
    history.replaceState(null, '', location.pathname);
    document.activeElement?.blur?.();
    globalThis.__bkClicks = [];
  });
  await page.evaluate(() => document.body.click());
  await settle(200);
  await page.evaluate(() => { globalThis.__bkClicks = []; });
  await settle(600);

  await page.keyboard.press('g');
  await page.keyboard.press('f');
  await settle(500);

  const focused = await typeUntil(page, async () => page.evaluate(() => {
    const a = document.activeElement;
    return a && a.tagName === 'A' ? (a.getAttribute('href') ?? '') : null;
  }));
  if (!focused) {
    throw new Error(
      'typed the whole alphabet after `gf` and no link took focus — the ' +
      "hintAction === 'focus' branch of activateWrapper did not run",
    );
  }

  const armedClicks = await clicks(page);
  if (armedClicks.length > 0) {
    throw new Error(
      `\`gf\` clicked ${JSON.stringify(armedClicks)} — focus_hint must focus and RETURN, ` +
      'not fall through to activateElement (the armed branch was dropped)',
    );
  }
  const hashAfterArmed = await page.evaluate(() => location.hash);
  if (hashAfterArmed) {
    throw new Error(
      `\`gf\` navigated to ${hashAfterArmed} — the armed verb followed the link it was ` +
      'only supposed to focus',
    );
  }

  // Leave the page as the next scenario expects it.
  await page.keyboard.press('Escape');
  await page.evaluate(() => history.replaceState(null, '', location.pathname));
  await settle(400);

  return `typing followed ${followed} (click on <a>), and \`gf\` focused ${focused} ` +
    'without clicking';
}
