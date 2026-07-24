/**
 * Scenario: prerender activation — the 2026-07-24 AW-wedge, scripted.
 * Fixture A speculation-rules-prerenders B; clicking through activates the
 * prerendered document (same context, frame identity changes). Assert the
 * activated document's badges all route — under document-scoped ownership
 * the claims survive the transition regardless of when they were made.
 *
 * Prerender may be declined under automation (or the L1 economy deny may
 * defer all claiming until activation — both are fine); the fixture records
 * document.prerendering at parse. If the document was never prerendered at
 * all, SKIP loudly — a plain navigation proves nothing here.
 */

import { waitForBadges, poolAudit, assertClean, settle, Skip } from '../driver.mjs';

export async function run({ ctx, base }) {
  const page = await ctx.newPage();
  try {
    await page.goto(`${base}/prerender-a.html`);
    await waitForBadges(page);
    // Give the speculation-rules prerender time to start and (with the L1
    // deny in place) sit parked before we activate it.
    await settle(3_000);

    await page.click('#to-b');
    await page.waitForFunction(() => document.documentElement.dataset.bornPrerendering !== undefined);
    const born = await page.evaluate(() => document.documentElement.dataset.bornPrerendering);
    if (born !== 'true') {
      throw new Skip('browser did not prerender B under automation (bornPrerendering=false)');
    }

    const badges = await waitForBadges(page);
    await settle(3_000); // post-activation claims/confirms
    return assertClean(await poolAudit(page), `prerender activation (${badges} badges)`);
  } finally {
    await page.close();
  }
}
