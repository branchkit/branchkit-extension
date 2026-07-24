/**
 * Scenario: prerender activation — the 2026-07-24 AW-wedge, scripted.
 * Fixture A speculation-rules-prerenders B; clicking through activates the
 * prerendered document (same context, frame identity changes). Assert the
 * activated document's badges all route — under document-scoped ownership
 * the claims survive the transition regardless of when they were made.
 *
 * KNOWN PERMANENT SKIP under Playwright (2026-07-24 shakeout): Chrome's own
 * verdict is PrerenderingDisabledByDevTools — ANY CDP-attached client
 * disables Prerender2, and CDP attachment is Playwright's mechanism. The
 * scenario stays wired so it self-reports the day Chrome lifts this (or a
 * tab-target-mode driver appears); until then the prerender transition is
 * covered by the field tripwire + the doc-scoped pool making the class
 * structurally safe + the frame-transition unit tests.
 */

import { waitForBadges, poolAudit, assertClean, settle, Skip } from '../driver.mjs';

export async function run({ ctx, base }) {
  const page = await ctx.newPage();
  try {
    // Ask Chrome why (or whether) the prerender started: the Preload domain
    // reports per-attempt status incl. the disallowing reason.
    const cdp = await ctx.newCDPSession(page);
    const preloadStatus = [];
    try {
      await cdp.send('Preload.enable');
      cdp.on('Preload.prerenderStatusUpdated', (e) => {
        preloadStatus.push(e.prerenderStatus ? `${e.status}:${e.prerenderStatus}` : e.status);
      });
      cdp.on('Preload.preloadEnabledStateUpdated', (e) => {
        preloadStatus.push(`enabledState=${JSON.stringify(e)}`);
      });
      cdp.on('Preload.prerenderAttemptCompleted', (e) => {
        preloadStatus.push(`final=${e.finalStatus}${e.disallowedApiMethod ? ':' + e.disallowedApiMethod : ''}`);
      });
    } catch { preloadStatus.push('Preload domain unavailable'); }

    await page.goto(`${base}/prerender-a.html`);
    await waitForBadges(page);
    // Give the speculation-rules prerender time to start and (with the L1
    // deny in place) sit parked before we activate it.
    await settle(3_000);

    await page.click('#to-b');
    await page.waitForFunction(() => document.documentElement.dataset.bornPrerendering !== undefined);
    const born = await page.evaluate(() => document.documentElement.dataset.bornPrerendering);
    if (born !== 'true') {
      const why = preloadStatus.length ? ` — Preload domain: ${[...new Set(preloadStatus)].slice(0, 6).join(' | ')}` : '';
      throw new Skip(`browser did not prerender B under automation (bornPrerendering=false)${why}`);
    }

    const badges = await waitForBadges(page);
    await settle(3_000); // post-activation claims/confirms
    return assertClean(await poolAudit(page), `prerender activation (${badges} badges)`);
  } finally {
    await page.close();
  }
}
