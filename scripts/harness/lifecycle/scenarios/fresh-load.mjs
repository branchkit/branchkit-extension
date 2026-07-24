/**
 * Scenario: fresh load. The baseline — badges paint and every painted
 * codeword routes. If this fails, nothing else is meaningful.
 */

import { waitForBadges, poolAudit, assertClean, settle } from '../driver.mjs';

export async function run({ ctx, base }) {
  const page = await ctx.newPage();
  try {
    await page.goto(`${base}/a.html`);
    const badges = await waitForBadges(page);
    await settle();
    return assertClean(await poolAudit(page), `fresh load (${badges} badges)`);
  } finally {
    await page.close();
  }
}
