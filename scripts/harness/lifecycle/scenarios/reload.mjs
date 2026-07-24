/**
 * Scenario: extension reload survival (the standing requirement for any
 * background change). Drives the REAL user path — the chrome://extensions
 * dev-mode reload button (probed 2026-07-24: present and visible for
 * command-line-loaded extensions, unlike chrome.runtime.reload(), which is
 * inert for them) — then asserts the already-open tab recovers: the new
 * SW's reinject storm re-injects the CS, fresh claims land, and every
 * painted badge routes against the FRESH pool.
 *
 * Known-open and deliberately NOT asserted here: the orphan-CS paint half
 * (stale badge hosts from the previous generation) — perceptual, tracked in
 * PLAN_RELIABILITY_CONSOLIDATION section 6 item 5. The audit reads the
 * fresh document's truth, which is the protocol claim.
 */

import { waitForBadges, poolAudit, assertClean, settle } from '../driver.mjs';

export async function run({ ctx, base, sw }) {
  const page = await ctx.newPage();
  const extPage = await ctx.newPage();
  try {
    await page.goto(`${base}/a.html`);
    await waitForBadges(page);
    await settle();
    const oldSw = sw;

    // The real reload path: chrome://extensions → dev mode → reload button.
    await extPage.goto('chrome://extensions');
    const mgr = extPage.locator('extensions-manager');
    try { await mgr.locator('#devMode').click({ timeout: 3_000 }); } catch { /* already on */ }
    await mgr.locator('extensions-item #dev-reload-button').click();

    // Wait for the reloaded extension's SW.
    const deadline = Date.now() + 30_000;
    let newSw = null;
    while (Date.now() < deadline) {
      newSw = ctx.serviceWorkers().find((w) => w !== oldSw) ?? null;
      if (newSw) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!newSw) throw new Error('no new service worker after chrome://extensions reload');

    // The reinject storm (onInstalled → reinjectContentScripts, fromReload
    // path) recovers the open tab; fresh CS → fresh doc id → fresh claims.
    await page.bringToFront();
    await waitForBadges(page, { timeout: 30_000 });
    await settle(3_000);
    const badges = await page.evaluate(() => document.querySelectorAll('[data-branchkit-hint]').length);
    return assertClean(await poolAudit(page), `post-reload recovery (${badges} badges)`);
  } finally {
    await extPage.close().catch(() => {});
    await page.close().catch(() => {});
  }
}
