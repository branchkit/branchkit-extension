/**
 * Real-input harness driver (Wave 4 D1, notes/PLAN_MODE_HOLDER_IMPL.md).
 *
 * The gap that let the mode/escape arc's field regressions through is that
 * every unit test calls the module under test directly — so the interaction
 * CHAINS (dictation → collector → commit → pick; find borrow → handoff →
 * restore; escape through stacked modes) were never exercised end to end.
 * This harness drives the REAL dist in a real browser with real input:
 * Playwright key presses for the keyboard, and the two dictation deliveries
 * the field taught us —
 *
 *   - `page.keyboard.insertText`: the engine-native injected-text shape.
 *     Chromium delivers one multi-char `insertText`; Gecko routes it through
 *     a one-shot composition (`insertCompositionText`, isComposing:false).
 *     Both must read as dictation (ext fea5bee, field regression #3).
 *   - the ANNOUNCED injection: the real Firefox CGEvent delivery captured
 *     live 2026-07-26 — ONE keydown whose `.key` is the whole transcript,
 *     then one `insertText` input event PER CHARACTER (ext e54eb33, field
 *     regression #4). Playwright cannot produce this shape natively, so
 *     `dictateAnnounced` replays the captured event sequence synthetically;
 *     the collector does not gate on isTrusted, so the replay walks the
 *     production path.
 *
 * Same isolation contract as the lifecycle harness: launched through
 * scripts/lib/launch.mjs (standalone marker), fixtures served over local
 * HTTP (content scripts do not inject into data:/about: URLs).
 */

import { createServer } from 'node:http';
import { launchExtension, launchFirefoxExtension } from '../../lib/launch.mjs';

// Enough links that the page's resting badge count clearly exceeds the pick's
// chip count (the borrow assertions need baseline > matches), exactly three
// 'album' matches for the pick, and 'banana' for the typed find legs.
//
// 'signal' is deliberately repeated to the pick's 9-chip cap: a scenario that
// needs a prefix which NARROWS without completing needs two chips sharing a
// first letter, and three codewords drawn from the pool rarely collide. Nine
// is not a guarantee either — the scenario Skips loudly if the draw gives no
// shared letter.
const FIXTURE = `<!doctype html><title>realinput fixture</title><body>
<h1>RealInput fixture</h1>
<p>The album charted. Another album followed. A third album closed the set.</p>
<p>A repeated word: banana here, banana there, and banana everywhere.</p>
<p>The unique-phrase-alpha appears exactly once.</p>
<p>signal one, signal two, signal three, signal four, signal five, signal six,
signal seven, signal eight, signal nine, signal ten, signal eleven.</p>
<nav>
<a href="#a1">link one</a> <a href="#a2">link two</a> <a href="#a3">link three</a>
<a href="#a4">link four</a> <a href="#a5">link five</a> <a href="#a6">link six</a>
<a href="#a7">link seven</a> <a href="#a8">link eight</a> <a href="#a9">link nine</a>
<a href="#a10">link ten</a>
</nav>
</body>`;

export const ALBUM_MATCHES = 3;

export async function startFixtureServer() {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(FIXTURE);
  });
  await new Promise((r) => server.listen(0, r));
  return { server, base: `http://127.0.0.1:${server.address().port}/fixture` };
}

export async function launchHarness(browser = 'chromium') {
  if (browser === 'firefox') {
    // hintVisibility defaults to 'always' in config.ts, so no seeding is needed.
    // Headless is NOT pinned here any more: it was the one arm that already ran
    // headless, and hardcoding it meant BK_HEADED=1 could not open a window for
    // the engine you most often need to watch. It follows the shared default
    // (harnessHeadless) like everything else now.
    const { ctx } = await launchFirefoxExtension({
      profile: '/tmp/branchkit-realinput-ff',
    });
    return { ctx };
  }
  const { ctx, sw } = await launchExtension({ profile: '/tmp/branchkit-realinput' });
  // Badges paint automatically (the user's always-mode is the harness mode).
  await sw.evaluate(async () => {
    await chrome.storage.sync.set({ hintVisibility: 'always' });
  });
  return { ctx };
}

/** Navigate to the fixture and wait out content-script boot + first scan.
 *  A fresh page is a fresh content script, so scenarios are independent. */
export async function freshPage(page, base) {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  await page.waitForTimeout(2500);
  await page.evaluate(() => document.body.click()); // focus the page for keys
}

// --- Probes (all read observable DOM the production code paints) ---

/** Painted-and-shown badge hosts: closed shadow root distinguishes a real
 *  badge (link hint, chip, search badge) from BranchKit's open-shadow UI
 *  (mode chip, find bar) that shares the attribute; data-bk-shown +
 *  computed display are show()/hide()'s own markers. */
export function shownBadges(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-branchkit-hint]')].filter(
      (h) => h.shadowRoot === null
        && h.hasAttribute('data-bk-shown')
        && getComputedStyle(h).display !== 'none',
    ).length);
}

/** The phrase/find box input's placeholder, or null when no box is open. */
export function boxPlaceholder(page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-branchkit-find] input');
    return el ? el.placeholder : null;
  });
}

/** Is the committed-find pill up? (Both bar and pill carry
 *  data-branchkit-find; the pill is the one without an input.) */
export function pillPresent(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-branchkit-find]')].some(
      (el) => !el.querySelector('input')));
}

/** The keyboard mode chip's label ('BADGE', 'VIDEO', 'CARET', …), or null
 *  when no chip is shown (Normal mode). Open shadow root by design. */
export function chipLabel(page) {
  return page.evaluate(() => {
    const host = document.querySelector('[data-branchkit-mode-chip]');
    return host?.shadowRoot?.querySelector('.chip .row span')?.textContent ?? null;
  });
}

/** Which of find's highlight names are painted right now. */
export function painted(page) {
  return page.evaluate(() => ({
    find: !!globalThis.CSS?.highlights?.has('branchkit-find'),
    current: !!globalThis.CSS?.highlights?.has('branchkit-find-current'),
    phrase: !!globalThis.CSS?.highlights?.has('branchkit-phrase'),
  }));
}

export function selectionText(page) {
  return page.evaluate(() => (globalThis.getSelection?.() || '').toString());
}

export async function pressSeq(page, ...keys) {
  for (const k of keys) {
    await page.keyboard.press(k);
    await page.waitForTimeout(150);
  }
}

/** Dictate via the engine-native injected-text shape (Chromium: one
 *  multi-char insertText; Gecko: one-shot insertCompositionText). */
export async function dictateNative(page, text) {
  await page.keyboard.insertText(text);
}

/**
 * Replay the announced-injection delivery (the real Firefox field shape,
 * captured 2026-07-26): one keydown carrying the whole transcript in `.key`,
 * then one insertText input event per character. Synthetic dispatch must
 * also apply the character (an untrusted event has no default action), which
 * is exactly what the announced keydown's real default does.
 */
export async function dictateAnnounced(page, text) {
  const delivered = await page.evaluate((t) => {
    const input = document.querySelector('[data-branchkit-find] input');
    if (!input) return false;
    input.dispatchEvent(new KeyboardEvent('keydown', {
      key: t, keyCode: t.toUpperCase().charCodeAt(0), bubbles: true, composed: true,
    }));
    for (const ch of t) {
      input.value += ch;
      input.dispatchEvent(new InputEvent('input', {
        data: ch, inputType: 'insertText', bubbles: true, composed: true,
      }));
    }
    return true;
  }, text);
  if (!delivered) throw new Error('dictateAnnounced: no phrase box input to deliver into');
}

/**
 * Answer a live pick by typing. Chip shadow roots are closed (the page must
 * not read or forge a codeword), so the harness walks the alphabet: a letter
 * no chip can complete is refused by the match predicate, so only letters of
 * a live codeword register, and the pick fires once one is uniquely
 * identified. Returns the selection text ('' = the walk changed nothing,
 * i.e. the keyboard could not reach the chips).
 */
export async function answerPickByTyping(page) {
  // `f` first: arming a pick takes the screen but NOT the keyboard, so bare
  // letters are still commands until hint mode is entered explicitly — same
  // gesture as for link hints (range-disambiguation.ts borrowScreen).
  await page.keyboard.press('f');
  await page.waitForTimeout(200);
  for (const ch of 'abcdefghijklmnopqrstuvwxyz') {
    await page.keyboard.press(ch);
    await page.waitForTimeout(90);
    const sel = await selectionText(page);
    if (sel) return sel;
  }
  return '';
}

/** Loud skip — the browser declined something under automation. */
export class Skip extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'Skip';
  }
}

export const settle = (ms) => new Promise((r) => setTimeout(r, ms));
