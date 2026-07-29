/**
 * BranchKit Browser — the L3 reap, in a real browser.
 *
 * notes/DESIGN_ASSIGNED_LABEL_RECLAIM.md diagnosed a one-way leak: labels move
 * free -> reserved -> assigned, and `releaseDocument` returns a dead document's
 * assignments, but its ONLY caller is the liveness Port's `onDisconnect`, which
 * cannot fire in a service worker that is not running. Chrome does not replay a
 * disconnect for a port that died while the worker slept, so the assigned side
 * never self-heals. Field evidence: two dead documents holding 248 of 676
 * labels, unchanged across six minutes and several navigations.
 *
 * The fix (L3 reap in `claimLabels`) had unit coverage and nothing else. This
 * closes that.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT.
 *
 * It proves the REAP works in the real extension: given a pool whose free list
 * is empty and whose assignments belong to a document with no live Port and a
 * stale stamp, a claim reclaims them and badges paint. It does NOT reproduce
 * the LEAK. Reproducing the leak needs the service worker genuinely asleep at
 * the instant a document dies, which this harness cannot stage — the worker is
 * busy driving it, so the disconnect fires and the healthy path runs. Those are
 * two different claims and only the first is made here.
 *
 * HOW THE PRECONDITION IS STAGED. Both of the reap's conditions are real, not
 * stubbed: the owner document id is one that never had a Port (so
 * `isDocPortLive` is genuinely false), and the stamps are genuinely older than
 * ASSIGNMENT_STALE_MS. Only the CLOCK is staged, by writing stamps in the past
 * rather than waiting fifteen minutes.
 *
 * The seam is `stackCache`, the in-memory mirror. `loadStack` consults it first
 * and falls back to `chrome.storage.session`, so a tab whose stack has never
 * been loaded reads whatever is in session storage. A tab parked on about:blank
 * has no content script and therefore no claim, so its mirror stays cold and
 * the seeded stack is what the first real claim sees.
 *
 * The negative control is the point. A run that only asserts "badges appeared"
 * cannot tell the reap from an ordinary claim against a healthy pool — the same
 * fixture paints badges either way. So the same pool is staged twice, differing
 * ONLY in the stamp, and the fresh-stamp arm must paint NOTHING.
 */
import { startFixtureServer, launchHarness, waitForBadges } from '../lifecycle/driver.mjs';

const ASSIGNMENT_STALE_MS = 15 * 60_000;
/** Enough to cover the fixture's hint count with room to spare. */
const STRANDED = 40;
/** A document that never existed, so it can never have a live Port. */
const DEAD_DOC = 'ghost-doc-that-never-had-a-port';

const fixture = await startFixtureServer();
const { ctx, sw } = await launchHarness('labelreap');
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); };
const EXPECTED = 4;

/** Two-letter labels that cannot collide with the fixture's own preferences. */
const strandedLabels = Array.from({ length: STRANDED }, (_, i) =>
  `z${'abcdefghijklmnopqrstuvwxyz'[i % 26]}${i >= 26 ? String(i) : ''}`);

/**
 * Park a tab on about:blank (no content script -> no claim -> cold mirror),
 * seed its stack, then navigate it at the fixture and see what the claim does.
 *
 * @param {number} ageMs how far in the past to stamp the assignments
 */
async function runArm(ageMs) {
  const before = await sw.evaluate(async () => (await chrome.tabs.query({})).map((t) => t.id));
  const page = await ctx.newPage();
  const tabId = await sw.evaluate(async (prev) => {
    const now = await chrome.tabs.query({});
    return now.map((t) => t.id).find((id) => !prev.includes(id));
  }, before);
  if (typeof tabId !== 'number') throw new Error('could not identify the new tab');

  await sw.evaluate(async ([id, labels, age, deadDoc]) => {
    const assigned = {}, assignedAt = {};
    const stamp = Date.now() - age;
    for (const l of labels) { assigned[l] = { d: deadDoc, f: 0 }; assignedAt[l] = stamp; }
    // free EMPTY: the reap only runs once pass 2 and the L2 steal come up short.
    await chrome.storage.session.set({
      [`labelStack:${id}`]: { free: [], reserved: {}, reservedAt: {}, assigned, assignedAt },
    });
  }, [tabId, strandedLabels, ageMs, DEAD_DOC]);

  const seeded = await sw.evaluate(async (id) => {
    const got = await chrome.storage.session.get(`labelStack:${id}`);
    const s = got[`labelStack:${id}`];
    return { free: s.free.length, assigned: Object.keys(s.assigned).length };
  }, tabId);

  await page.goto(`${fixture.base}/a.html`);
  let badges = 0;
  try { badges = await waitForBadges(page, { min: 1, timeout: 12_000 }); } catch { badges = 0; }

  const after = await sw.evaluate(async (id) => {
    const got = await chrome.storage.session.get(`labelStack:${id}`);
    const s = got[`labelStack:${id}`];
    if (!s) return null;
    return {
      free: s.free.length,
      assigned: Object.keys(s.assigned).length,
      reserved: Object.keys(s.reserved).length,
    };
  }, tabId);

  await page.close();
  return { seeded, badges, after };
}

try {
  // --- Arm 1: stale assignments. The reap must fire. ---
  const stale = await runArm(ASSIGNMENT_STALE_MS + 5 * 60_000);
  check('precondition: the pool is drained and fully assigned',
    stale.seeded.free === 0 && stale.seeded.assigned === STRANDED,
    `free=${stale.seeded.free} assigned=${stale.seeded.assigned}`);
  check('STALE: badges paint from labels reclaimed off a dead document',
    stale.badges > 0,
    `${stale.badges} badge(s); stack after: ${JSON.stringify(stale.after)}`);
  check('STALE: the reclaimed labels left the dead document\'s assignments',
    stale.after !== null && stale.after.assigned < STRANDED,
    `assigned ${STRANDED} -> ${stale.after?.assigned}, reserved=${stale.after?.reserved}`);

  // --- Arm 2 (control): same pool, fresh stamps. The reap must NOT fire. ---
  // Without this, arm 1 proves only that badges can appear, which they can for
  // reasons having nothing to do with the reap.
  const fresh = await runArm(0);
  check('CONTROL: a pool of the same shape with FRESH stamps paints nothing',
    fresh.badges === 0 && fresh.after !== null && fresh.after.assigned === STRANDED,
    `${fresh.badges} badge(s); assigned still ${fresh.after?.assigned}/${STRANDED}`);
} finally {
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail}`);
  const failures = results.filter((r) => !r.ok).length;
  if (results.length < EXPECTED) {
    console.log(`\nONLY ${results.length}/${EXPECTED} PROBES RAN — the run aborted, this is NOT a pass`);
    process.exitCode = 1;
  } else if (failures) {
    console.log(`\n${failures} PROBE FAILURE(S)`);
    process.exitCode = 1;
  } else {
    console.log(`\nALL ${EXPECTED} PROBES PASS`);
  }
  await ctx.close();
  fixture.server.close();
}
