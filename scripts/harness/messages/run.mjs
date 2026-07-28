/**
 * BranchKit Browser — the content script's message table, over the REAL
 * chrome.runtime.onMessage boundary.
 *
 * The gap DESIGN_ENTRY_POINT_TOPOLOGY.md section 7 recorded after phase 1 and
 * never closed: a green suite here is not a green browser. Every handler in
 * both tables only ever runs behind onMessage, and nothing in tsc, vitest or
 * the build exercises that edge — the unit tests call handlers directly. The
 * specific risk is the response contract: a handler that should answer and
 * does not leaves the sender awaiting forever, silently.
 *
 * So this sends each type from the service worker to a real tab and reads what
 * comes back. Opt-in (npm run harness:messages) rather than part of the
 * lifecycle run, so it does not move that harness's PASS/SKIP baseline.
 *
 * It counts its own probes: an abort partway through reports as an abort, not
 * as a pass over an empty list. It shipped with exactly that bug and announced
 * ALL PROBES PASS having run none.
 */
import { startFixtureServer, launchHarness, waitForBadges, settle } from '../lifecycle/driver.mjs';

const fixture = await startFixtureServer();
const url = fixture.base;
const { ctx, sw } = await launchHarness('msgtable');
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); };

try {
  const page = await ctx.newPage();
  await page.goto(`${url}/a.html`);
  await waitForBadges(page, { min: 1 });
  await settle(1000);

  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ active: true }))[0].id);
  const send = (msg, opts) => sw.evaluate(
    ([id, m, o]) => chrome.tabs.sendMessage(id, m, o ?? {}).catch((e) => ({ __err: String(e) })),
    [tabId, msg, opts ?? null],
  );

  // 1. GET_PAGE_STATUS — sync value response through the router.
  const status = await send({ type: 'GET_PAGE_STATUS' }, { frameId: 0 });
  check('GET_PAGE_STATUS', status && typeof status.hintCount === 'number' && !status.__err,
    JSON.stringify(status));

  // 2. GET_FOCUS_STATUS — the map that moved to a brand-new module.
  const focus = await send({ type: 'GET_FOCUS_STATUS' }, { frameId: 0 });
  check('GET_FOCUS_STATUS', focus && typeof focus.focused === 'boolean' && !focus.__err,
    JSON.stringify(focus));

  // 3. RESOLVE_HINT — binds the live store inside the module now.
  const cw = await page.evaluate(() =>
    document.querySelector('[data-branchkit-hint]')?.textContent?.trim() ?? '');
  const hint = await send({ type: 'RESOLVE_HINT', codeword: cw }, { frameId: 0 });
  check('RESOLVE_HINT', hint && typeof hint.ok === 'boolean' && !hint.__err,
    `codeword=${JSON.stringify(cw)} -> ${JSON.stringify(hint)}`);

  // 4. TAB_MARKER — fire-and-forget, observed in the page.
  // Strip any marker the SW already applied — the fixture tab has one.
  const before = (await page.title()).replace(/^\[[a-z]+\] /, '');
  await send({ type: 'TAB_MARKER', letters: 'zq' }, { frameId: 0 });
  await settle(500);
  const after = await page.title();
  check('TAB_MARKER', after === `[zq] ${before}`, `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);

  // 5. SET_BADGES_VISIBLE — acts AND answers.
  const hidden = await send({ type: 'SET_BADGES_VISIBLE', visible: false }, { frameId: 0 });
  await settle(800);
  const painted = await page.evaluate(() =>
    [...document.querySelectorAll('[data-branchkit-hint]')]
      .filter((e) => getComputedStyle(e).visibility !== 'hidden' && e.offsetParent !== null).length);
  check('SET_BADGES_VISIBLE', hidden && hidden.badgesVisible === false && !hidden.__err,
    `answer=${JSON.stringify(hidden)} visible_badges_after=${painted}`);
  await send({ type: 'SET_BADGES_VISIBLE', visible: true }, { frameId: 0 });
  await settle(800);

  // 6. BRANCHKIT_ACTION — the inline map; a benign, observable verb.
  // Make the page scrollable so scroll_down has somewhere to go.
  await page.evaluate(() => { document.body.style.minHeight = '5000px'; });
  await settle(300);
  const y0 = await page.evaluate(() => window.scrollY);
  await send({ type: 'BRANCHKIT_ACTION', payload: { action: 'scroll_down', params: {}, correlation_id: 'tr_probe' } }, { frameId: 0 });
  await settle(900);
  const y1 = await page.evaluate(() => window.scrollY);
  check('BRANCHKIT_ACTION (scroll_down)', y1 > y0, `scrollY ${y0} -> ${y1}`);

  // 7. PALETTE_CLOSE — the ONE handler whose response carries an ordering
  // guarantee: background/palette.ts awaits it before dispatching, and its
  // catch is silent, so a handler that stopped answering would look exactly
  // like a dead tab while the action ran against a still-mounted overlay.
  // Answering `true` is the contract; the close itself is idempotent.
  const closed = await send({ type: 'PALETTE_CLOSE' }, { frameId: 0 });
  check('PALETTE_CLOSE answers', closed === true, JSON.stringify(closed));

  // 8. PALETTE_COMMAND — fire-and-forget INTO the dispatcher, so it exercises
  // the command table from the message side. scroll_top is benign and visible.
  await page.evaluate(() => window.scrollTo(0, 400));
  await settle(200);
  const yBefore = await page.evaluate(() => window.scrollY);
  await send({ type: 'PALETTE_COMMAND', action: 'scroll_top', params: {} }, { frameId: 0 });
  await settle(1200);
  const yTop = await page.evaluate(() => window.scrollY);
  // Near the top rather than exactly 0: scroll_top animates, so the settled
  // value lands within a pixel or two. What is being probed is that the
  // message reached the dispatcher at all, not the easing curve.
  check('PALETTE_COMMAND reaches the dispatcher', yBefore > 300 && yTop < 50,
    `scrollY ${yBefore} -> ${yTop}`);

  // 9. TAB_MARKER_REAPPLY — restores the marker after the page overwrites the
  // title, which is the whole reason the message exists.
  await send({ type: 'TAB_MARKER', letters: 'zq' }, { frameId: 0 });
  await settle(300);
  await page.evaluate(() => { document.title = 'Rewritten By The Page'; });
  await settle(200);
  await send({ type: 'TAB_MARKER_REAPPLY' }, { frameId: 0 });
  await settle(500);
  const reapplied = await page.title();
  check('TAB_MARKER_REAPPLY', reapplied === '[zq] Rewritten By The Page', JSON.stringify(reapplied));

  // 10. MARK_RESTORE — a global-mark jump landing on this tab. Top frame only,
  // and the one handler that writes scroll position.
  await page.evaluate(() => window.scrollTo(0, 0));
  await settle(200);
  await send({ type: 'MARK_RESTORE', scrollX: 0, scrollY: 250, hash: '' }, { frameId: 0 });
  await settle(600);
  const restored = await page.evaluate(() => window.scrollY);
  check('MARK_RESTORE', restored > 0, `scrollY -> ${restored}`);

  // 11. An unknown type must be ignored, not throw the listener.
  await send({ type: 'NOT_A_REAL_TYPE' }, { frameId: 0 });
  const still = await send({ type: 'GET_PAGE_STATUS' }, { frameId: 0 });
  check('unknown type does not break the table',
    still && typeof still.hintCount === 'number', JSON.stringify(still));
} finally {
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail}`);
  if (results.length < 11) console.log(`\nONLY ${results.length}/11 PROBES RAN — the run aborted, this is NOT a pass`);
  else console.log(results.every((r) => r.ok) ? '\nALL 11 PROBES PASS' : `\n${results.filter(r => !r.ok).length} PROBE FAILURE(S)`);
  await ctx.close();
  fixture.server.close();
}
