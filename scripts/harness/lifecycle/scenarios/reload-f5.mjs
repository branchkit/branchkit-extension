/**
 * Scenario: F5 AFTER an extension reload — the historical "symptom 2"
 * (notes/DESIGN_EXTENSION_RELOAD_SURVIVAL.md): after a chrome://extensions
 * reload, refreshing an already-open tab was reported (2026-06-05,
 * intermittent) to load with NO content script at all — declarative
 * content_scripts apparently inert for that tab — leaving the user with the
 * close+reopen ritual. The 2026-06-06 real-Chrome trial could NOT reproduce
 * it after Layer 1 landed (the tabs.onUpdated backstop reinjected), but it
 * was downgraded to "not reproduced", never closed, and a second consecutive
 * F5 was never tested. This scenario pins the healthy behavior: reload →
 * reinject recovery → F5 → fresh CS with clean pool → F5 again → same.
 */

import { waitForBadges, poolAudit, assertClean, settle, devReloadExtension } from '../driver.mjs';

export async function run({ ctx, base, sw }) {
  const page = await ctx.newPage();
  try {
    await page.goto(`${base}/a.html`);
    await waitForBadges(page);
    await settle();

    await devReloadExtension(ctx, sw);

    // Reinject recovery first (same as the reload scenario) — F5 must be
    // tested from the recovered state, which is where the ritual lived.
    await page.bringToFront();
    await waitForBadges(page, { timeout: 30_000 });
    await settle(3_000);

    // F5 #1: the declarative content_scripts (or the onUpdated backstop)
    // must produce a working CS — badges paint, every label routable.
    await page.reload();
    await waitForBadges(page, { timeout: 30_000 });
    await settle(3_000);
    assertClean(await poolAudit(page), 'post-reload F5 #1');

    // F5 #2: the never-tested consecutive refresh.
    await page.reload();
    await waitForBadges(page, { timeout: 30_000 });
    await settle(3_000);
    const badges = await page.evaluate(() => document.querySelectorAll('[data-branchkit-hint]').length);
    return assertClean(await poolAudit(page), `post-reload F5 #2 (${badges} badges)`);
  } finally {
    await page.close().catch(() => {});
  }
}
