/**
 * Scenario: bfcache composite — back AND forward, twice through the cache.
 * The sequences are where lifecycle bugs actually live: A→B→back(A
 * restored)→forward(B restored)→back(A restored again). Audit at each
 * restore; every painted badge must route every time.
 */

import { waitForBadges, poolAudit, assertClean, settle, Skip, bfcacheProbeReport } from '../driver.mjs';

async function expectRestored(page, label) {
  await page.waitForFunction(() => document.documentElement.dataset.persisted !== undefined);
  const persisted = await page.evaluate(() => document.documentElement.dataset.persisted);
  if (persisted !== 'true') throw new Skip(`${label}: not restored from bfcache under automation`);
}

export async function run({ ctx, base, browser }) {
  const page = await ctx.newPage();
  try {
    const crossBase = base.replace('127.0.0.1', 'localhost');
    await page.goto(`${base}/a.html`);
    await waitForBadges(page);
    await settle();
    await page.goto(`${crossBase}/b.html`);
    await waitForBadges(page);
    await settle();

    await page.goBack({ waitUntil: 'commit' });
    await expectRestored(page, 'back to A');
    await settle(3_000);
    assertClean(await poolAudit(page), 'A restored (1st)');

    await page.goForward({ waitUntil: 'commit' });
    await expectRestored(page, 'forward to B');
    await settle(3_000);
    assertClean(await poolAudit(page), 'B restored');

    await page.goBack({ waitUntil: 'commit' });
    await expectRestored(page, 'back to A (2nd)');
    await settle(3_000);
    const clean = assertClean(await poolAudit(page), 'roundtrip complete, A restored (2nd)');
    // A restored twice → up to 4 probe samples on this document (layer 2).
    return `${clean} | ${await bfcacheProbeReport(page)}`;
  } finally {
    await page.close();
  }
}
