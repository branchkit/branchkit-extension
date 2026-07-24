/**
 * Scenario: bfcache back/forward — the 2026-07-24 "go back then
 * no_such_hint" field failure, scripted. Navigate A → B, go back, and
 * assert the RESTORED document's badges all route (the restore reconfirm
 * re-acquired the pool under document-scoped ownership).
 *
 * bfcache is frequently disabled under CDP automation; the fixture records
 * pageshow.persisted, and a non-persisted restore SKIPs loudly rather than
 * passing vacuously (a fresh load would trivially satisfy the invariant).
 */

import { waitForBadges, poolAudit, assertClean, settle, Skip } from '../driver.mjs';

export async function run({ ctx, base }) {
  const page = await ctx.newPage();
  try {
    await page.goto(`${base}/a.html`);
    await waitForBadges(page);
    await settle();

    await page.goto(`${base}/b.html`);
    await waitForBadges(page);
    await settle();

    await page.goBack();
    await page.waitForFunction(() => document.documentElement.dataset.persisted !== undefined);
    const persisted = await page.evaluate(() => document.documentElement.dataset.persisted);
    if (persisted !== 'true') {
      throw new Skip('browser did not engage bfcache under automation (persisted=false)');
    }

    const badges = await waitForBadges(page);
    await settle(3_000); // restore reconfirm + debounced syncs
    return assertClean(await poolAudit(page), `bfcache restore (${badges} badges, persisted)`);
  } finally {
    await page.close();
  }
}
