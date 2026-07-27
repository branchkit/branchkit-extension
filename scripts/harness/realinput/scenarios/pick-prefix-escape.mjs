/**
 * Escape mid-codeword unsays the LETTERS, not the pick (field, 2026-07-27).
 *
 * Typing at a chip and getting it wrong should cost the letters and nothing
 * else — the chips stay up so a different one can be typed. What happened
 * instead: the escape cascade asks only the TOP entry for an intra-mode
 * transient, and a pick rides ABOVE the hint mode that owns the typed prefix,
 * so the letters were unreachable and Escape cancelled the whole pick.
 *
 * Needs a prefix that narrows without completing — a unique prefix fires the
 * pick immediately — so it reads the chips through the bkOpenShadow affordance
 * and types a first letter two of them share. The pool draw decides whether
 * such a letter exists; no shared letter is a loud Skip, never a silent pass.
 */

import { freshPage, dictateNative, boxPlaceholder, settle, selectionText, Skip } from '../driver.mjs';

/** Every shown chip: its codeword text and whether it is dimmed (narrowed
 *  away). Chips dim rather than hide — BadgeVariant.nonCandidate 'dim'. */
function chips(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-branchkit-hint]')]
      .filter((h) => h.shadowRoot && h.hasAttribute('data-bk-shown'))
      .map((h) => h.shadowRoot.querySelector('.bk-inner'))
      .filter((el) => el && getComputedStyle(el).display !== 'none')
      .map((el) => {
        const m = getComputedStyle(el).borderTopColor.match(/rgba?\(([^)]+)\)/);
        const parts = m ? m[1].split(/[,/]/).map((s) => parseFloat(s.trim())) : [];
        return {
          text: (el.textContent || '').replace(/\s+/g, '').toLowerCase(),
          dimmed: el.classList.contains('bk-dimmed'),
          // Chips are page-filled, so they ride the same 0.3 → 1 armed border
          // as link hints. Arming a pick enters hint mode, so they should be
          // at full the whole time they are up — including after a prefix peel,
          // which is the sharpest available proof that hint mode SURVIVED the
          // escape rather than being re-entered or left behind.
          alpha: parts.length > 3 ? parts[3] : 1,
        };
      }));
}

const dimmedCount = (cs) => cs.filter((c) => c.dimmed).length;
const unarmed = (cs) => cs.filter((c) => c.alpha < 1).length;

export async function run({ page, base }) {
  await freshPage(page, base);
  await page.evaluate(() => localStorage.setItem('bkOpenShadow', '1'));
  try {
    await freshPage(page, base);

    // "highlight" (gs) → phrase box → a phrase with many matches → chips.
    await page.keyboard.press('g');
    await page.keyboard.press('s');
    await settle(400);
    await dictateNative(page, 'signal');
    await settle(1200);
    if ((await boxPlaceholder(page)) !== null) {
      throw new Error('the highlight phrase never committed — no pick to escape out of');
    }

    const atArm = await chips(page);
    if (atArm.length < 2) {
      throw new Error(`expected a multi-candidate pick; saw ${atArm.length} chip(s)`);
    }
    if (dimmedCount(atArm) !== 0) {
      throw new Error('chips arrived pre-narrowed — the prefix was not clean at arm');
    }
    // Arming takes the screen, not the keyboard: the chips are up but NOT yet
    // typable, so they wear the resting border and `f` is what arms them. That
    // gives chips the same visible "the keyboard is listening now" transition
    // link hints have — there was none while arming entered hint mode for you.
    if (unarmed(atArm) !== atArm.length) {
      throw new Error(
        `${atArm.length - unarmed(atArm)} chips were already border-armed at arm time — ` +
        'the pick is taking the keyboard again, which costs the whole Normal keymap (j/k)',
      );
    }

    await page.keyboard.press('f');
    await settle(500);
    const armed = await chips(page);
    if (unarmed(armed) !== 0) {
      throw new Error(
        `after \`f\` every chip must wear the armed border; ${unarmed(armed)} of ` +
        `${armed.length} were still at rest`,
      );
    }

    // Deliberately a first letter only ONE chip has. That is the case that used
    // to resolve the pick on a single keystroke — the chip painted "ag" and a
    // bare 'a' picked it, so the chips vanished mid-word (field, 2026-07-27).
    // Firing now takes the whole codeword, so this must narrow and nothing more.
    // Falls back to any first letter when the draw gives no unique one; the
    // assertions below hold either way.
    const byFirst = new Map();
    for (const c of armed) {
      if (!c.text) continue;
      byFirst.set(c.text[0], (byFirst.get(c.text[0]) ?? 0) + 1);
    }
    const shared = [...byFirst.entries()].find(([, n]) => n === 1)?.[0]
      ?? [...byFirst.keys()][0];
    if (!shared) {
      throw new Skip(`no chip carried a readable codeword (${armed.length} armed)`);
    }

    await page.keyboard.press(shared);
    await settle(500);

    if (await selectionText(page)) {
      throw new Error(
        `'${shared}' resolved the pick on ONE keystroke — the chip paints a longer codeword ` +
        'than that, so firing on a prefix breaks the promise the badge is making',
      );
    }
    const narrowed = await chips(page);
    if (dimmedCount(narrowed) === 0) {
      throw new Error(`'${shared}' was not accepted as a prefix (nothing narrowed)`);
    }

    // THE ASSERTION: escape unsays the letters, the pick survives.
    await page.keyboard.press('Escape');
    await settle(600);

    const afterEscape = await chips(page);
    if (afterEscape.length !== armed.length) {
      throw new Error(
        `escape cancelled the pick: ${afterEscape.length} chips, expected ${armed.length} ` +
        '(the typed prefix did not consume the escape — peelTop never reached it)',
      );
    }
    if (dimmedCount(afterEscape) !== 0) {
      throw new Error(
        `the pick survived but the prefix did not clear (${dimmedCount(afterEscape)} chips ` +
        'still dimmed) — the letters must go, so a different chip can be typed',
      );
    }
    if (await selectionText(page)) {
      throw new Error('escape resolved a pick instead of clearing the prefix');
    }
    if (unarmed(afterEscape) !== 0) {
      throw new Error(
        `the prefix peel dropped hint mode: ${unarmed(afterEscape)} chips fell back to the ` +
        'resting border. The letters go, the mode stays — otherwise the next letter typed ' +
        'is a stray key, not a codeword',
      );
    }

    // Escape #2 leaves hint mode — and the chips REMAIN, because `f` was
    // entered over the pick and peels off it in the order it went on. The
    // chips fall back to the resting border: still there, no longer typable.
    await page.keyboard.press('Escape');
    await settle(700);
    const afterSecond = await chips(page);
    if (afterSecond.length !== armed.length) {
      throw new Error(
        `the second escape took the pick with it: ${afterSecond.length} chips, expected ` +
        `${armed.length}. Leaving hint mode should hand the keyboard back and no more — ` +
        'the question the chips are asking is still open',
      );
    }
    if (unarmed(afterSecond) !== afterSecond.length) {
      throw new Error('left hint mode but the chips still read as armed');
    }

    // Escape #3 answers-by-abandoning: the pick itself.
    await page.keyboard.press('Escape');
    await settle(700);
    if ((await chips(page)).length === armed.length) {
      throw new Error('the third escape did not cancel the pick — the chips are stuck');
    }

    return `prefix '${shared}' narrowed ${armed.length} chips; Esc unsaid the letters, ` +
      'Esc left hint mode with the chips still up, Esc cancelled the pick';
  } finally {
    await page.evaluate(() => localStorage.removeItem('bkOpenShadow'));
  }
}
