/**
 * Scenario: extension reload while a page sits in BFCACHE — the orphan-paint
 * window (layer 3 mechanism B, notes/DESIGN_ORPHAN_PAINT.md). Layer 2 proved
 * a frozen page can never learn of the reload (no disconnect is delivered),
 * so on restore its elder CS wakes with a dead chrome.runtime. Pre-fix it
 * repainted badges nobody could service; the fix tears it down instead.
 *
 * Two valid post-restore worlds, both asserted stale-paint-free:
 *   - a successor CS from the new generation recovered the page → the pool
 *     audit's stale_hosts (layer 1) must be 0;
 *   - nobody recovered it → the DOM must hold ZERO badge hosts (the elder
 *     tore its paint down rather than stranding it).
 *
 * KNOWN PERMANENT SKIP on Chromium (probed 2026-07-24): Chrome flushes the
 * bfcache on extension reload (notRestoredExplanations: CacheFlushed), so
 * this window cannot occur on the Chromium reload path — Back is a fresh
 * load with a fresh CS. The scenario stays in the matrix so a future Chrome
 * behavior change re-engages it; mechanism B remains as defense-in-depth
 * for the paths this flush does NOT cover (Firefox reload — not automatable,
 * field-probed instead; the build-while-loaded wedge, which orphans the CS
 * with NO reload and therefore no flush; extension crash/uninstall edges).
 */

import { waitForBadges, poolAudit, assertClean, settle, Skip, devReloadExtension } from '../driver.mjs';

export async function run({ ctx, base, sw }) {
  const page = await ctx.newPage();
  try {
    // Name Chrome's objection if it declines the restore (see bfcache.mjs).
    const explanations = [];
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Page.enable');
    cdp.on('Page.backForwardCacheNotUsed', (e) => {
      for (const r of e.notRestoredExplanations ?? []) explanations.push(r.reason);
    });

    await page.goto(`${base}/a.html`);
    await waitForBadges(page);
    await settle();

    // Put A into bfcache via the cross-origin hop (see bfcache.mjs).
    const crossBase = base.replace('127.0.0.1', 'localhost');
    await page.goto(`${crossBase}/b.html`);
    await waitForBadges(page);
    await settle();

    // Reload the extension while A is frozen: A's CS becomes an orphan that
    // was never told.
    await devReloadExtension(ctx, sw);

    await page.goBack({ waitUntil: 'commit' });
    await page.waitForFunction(() => document.documentElement.dataset.persisted !== undefined);
    const persisted = await page.evaluate(() => document.documentElement.dataset.persisted);
    if (persisted !== 'true') {
      const why = explanations.length
        ? ` — Chrome's reasons: ${[...new Set(explanations)].join(', ')}`
        : '';
      throw new Skip(`no bfcache restore after extension reload (persisted=false)${why}`);
    }

    await settle(3_000);

    // Scenario validity: the elder's probe must have recorded a DEAD context
    // at restore. If ctx was still valid, the reload didn't orphan it and
    // this run proves nothing — loud skip, not vacuous green.
    const probeRaw = await page.evaluate(
      () => document.documentElement.dataset.branchkitBfcacheProbe,
    );
    const restoreSample = probeRaw
      ? JSON.parse(probeRaw).find((s) => s.when === 'restore')
      : null;
    if (!restoreSample) throw new Skip('no restore probe sample — probe not armed in the elder?');
    if (restoreSample.ctx_valid) {
      throw new Skip('elder context still valid after reload — orphan condition not staged');
    }

    // THE PIN: no stale paint, in whichever world we landed in.
    const successorLive = await page.evaluate(
      () => document.documentElement.hasAttribute('data-branchkit-cs'),
    );
    if (successorLive) {
      const badges = await waitForBadges(page, { timeout: 15_000 });
      return assertClean(
        await poolAudit(page),
        `orphan restore, successor recovered (${badges} badges)`,
      );
    }
    const hosts = await page.evaluate(
      () => document.querySelectorAll('[data-branchkit-hint="true"]').length,
    );
    if (hosts > 0) {
      throw new Error(`ORPHAN PAINT SURVIVED — ${hosts} badge hosts with no live CS`);
    }
    return 'orphan restore: elder tore down cleanly, zero badge hosts (no successor injected)';
  } finally {
    await page.close().catch(() => {});
  }
}
