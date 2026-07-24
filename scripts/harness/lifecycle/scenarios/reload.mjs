/**
 * Scenario: extension reload survival (the standing requirement for any
 * background change). Drives the REAL user path — the chrome://extensions
 * dev-mode reload button (see devReloadExtension) — then asserts the
 * already-open tab recovers: the new SW's reinject storm re-injects the CS,
 * fresh claims land, and every painted badge routes against the FRESH pool.
 *
 * The orphan-CS paint half is asserted too since layer 1: assertClean fails
 * on stale_hosts>0, i.e. any badge host still stamped by the previous
 * generation's content script. (The reload-during-BFCACHE variant of that
 * window has its own scenario: bfcache-reload.)
 */

import { waitForBadges, poolAudit, assertClean, settle, devReloadExtension } from '../driver.mjs';

export async function run({ ctx, base, sw }) {
  const page = await ctx.newPage();
  try {
    await page.goto(`${base}/a.html`);
    await waitForBadges(page);
    await settle();

    await devReloadExtension(ctx, sw);

    // The reinject storm (onInstalled → reinjectContentScripts, fromReload
    // path) recovers the open tab; fresh CS → fresh doc id → fresh claims.
    await page.bringToFront();
    await waitForBadges(page, { timeout: 30_000 });
    await settle(3_000);
    const badges = await page.evaluate(() => document.querySelectorAll('[data-branchkit-hint]').length);
    return assertClean(await poolAudit(page), `post-reload recovery (${badges} badges)`);
  } finally {
    await page.close().catch(() => {});
  }
}
