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

import { waitForBadges, poolAudit, assertClean, settle, Skip, bfcacheProbeReport, assertChannelHealed } from '../driver.mjs';

export async function run({ ctx, base, browser }) {
  const page = await ctx.newPage();
  try {
    // Chrome will name its own bfcache objections: collect
    // notRestoredExplanations so a skip is actionable, not a shrug.
    // (CDP is chromium-only; Firefox runs without the diagnostics.)
    const explanations = [];
    if (browser !== 'firefox') {
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Page.enable');
      cdp.on('Page.backForwardCacheNotUsed', (e) => {
        for (const r of e.notRestoredExplanations ?? []) explanations.push(r.reason);
      });
    }

    await page.goto(`${base}/a.html`);
    await waitForBadges(page);
    await settle();

    // Cross-ORIGIN hop (127.0.0.1 → localhost, same server): Chrome's first
    // shakeout verdict was BrowsingInstanceNotSwapped — same-origin A→B kept
    // the browsing instance under automation, which disqualifies bfcache.
    // A cross-origin navigation forces the swap.
    const crossBase = base.replace('127.0.0.1', 'localhost');
    await page.goto(`${crossBase}/b.html`);
    await waitForBadges(page);
    await settle();

    // A bfcache restore fires pageshow, not load — Playwright's default
    // goBack() waits for load and times out on a REAL restore. Commit-level
    // wait, then our own pageshow marker is the completion signal.
    await page.goBack({ waitUntil: 'commit' });
    await page.waitForFunction(() => document.documentElement.dataset.persisted !== undefined);
    const persisted = await page.evaluate(() => document.documentElement.dataset.persisted);
    if (persisted !== 'true') {
      const why = explanations.length ? ` — Chrome's reasons: ${[...new Set(explanations)].join(', ')}` : '';
      throw new Skip(`browser did not engage bfcache under automation (persisted=false)${why}`);
    }

    const badges = await waitForBadges(page);
    await settle(3_000); // restore reconfirm + debounced syncs (+ the probe's 2s settled sample)
    const clean = assertClean(await poolAudit(page), `bfcache restore (${badges} badges, persisted)`);
    // Mechanism-A pin: the settled sample must show the repaired channel.
    await assertChannelHealed(page, 'bfcache restore');
    // Full layer-2 probe trail rides the pass line for the record.
    return `${clean} | ${await bfcacheProbeReport(page)}`;
  } finally {
    await page.close();
  }
}
