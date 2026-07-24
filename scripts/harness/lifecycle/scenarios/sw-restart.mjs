/**
 * Scenario: SW idle-kill + resync. Kill the extension's service worker via
 * browser-level CDP (Target.closeTarget — the automatable stand-in for MV3
 * idle termination), let the wake path run (fresh SW init wipes the pool;
 * the CS liveness ports reconnect and reconfirm), and assert every painted
 * badge re-homes and routes.
 *
 * This scenario found a real bug before it first shipped (2026-07-24):
 * confirmLabels' "pool not ready → treat as accepted" branch silently ate
 * the resync reconfirm, leaving every badge voice-dead after any SW
 * restart — the third member of the removed-broadcast-fallback family.
 * The mid-transient is expected (audit right after the kill shows all
 * held labels unroutable); the assertion is CONVERGENCE.
 */

import { waitForBadges, poolAudit, assertClean, settle } from '../driver.mjs';

export async function run({ ctx, base, sw }) {
  if (!sw) throw new Error('sw-restart scenario needs chromium');
  const page = await ctx.newPage();
  try {
    await page.goto(`${base}/a.html`);
    await waitForBadges(page);
    await settle();
    assertClean(await poolAudit(page), 'baseline');

    const browser = ctx.browser();
    const cdp = await browser.newBrowserCDPSession();
    const { targetInfos } = await cdp.send('Target.getTargets');
    const swTarget = targetInfos.find(
      (t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'),
    );
    if (!swTarget) throw new Error('extension SW target not found');
    await cdp.send('Target.closeTarget', { targetId: swTarget.targetId });

    // Wake + resync window: liveness ports notice the disconnect, reconnect
    // (500ms retry) into the fresh SW, and the reconfirm re-homes onto the
    // rebuilt pool. Converge, then assert.
    await settle(8_000);
    const badges = await page.evaluate(() => document.querySelectorAll('[data-branchkit-hint]').length);
    return assertClean(await poolAudit(page), `post-SW-restart resync (${badges} badges)`);
  } finally {
    await page.close();
  }
}
