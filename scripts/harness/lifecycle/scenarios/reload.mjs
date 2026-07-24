/**
 * Scenario: extension reload survival (the standing requirement for any
 * background change). Reload the extension from inside its own SW, wait for
 * the new SW's reinject storm to recover the already-open tab, and assert
 * the recovered page's badges all route against the FRESH pool.
 */

import { waitForBadges, poolAudit, assertClean, settle, Skip } from '../driver.mjs';

export async function run({ ctx, base, sw }) {
  // ENGAGEMENT BLOCKER (2026-07-24 shakeout): chrome.runtime.reload() on a
  // command-line-loaded extension (--load-extension) does not restart it
  // under Playwright — no new SW ever appears (known Chromium quirk; the
  // extension is effectively disabled). The real reload path for the
  // harness is driving the chrome://extensions UI (dev-mode reload button
  // through its open shadow DOM) — queued in DESIGN_LIFECYCLE_HARNESS.md.
  // Until then this scenario reports itself uncovered rather than
  // pretending; the manual chrome://extensions reload check remains the
  // standing requirement for background changes.
  throw new Skip('runtime.reload() is inert for command-line-loaded extensions; needs the chrome://extensions driver');
  // eslint-disable-next-line no-unreachable

  const page = await ctx.newPage();
  try {
    await page.goto(`${base}/a.html`);
    await waitForBadges(page);
    await settle();

    // Reload from inside the SW — the real chrome://extensions reload path.
    // Playwright doesn't reliably emit a `serviceworker` event for the
    // reloaded extension, so poll for a worker that isn't the old one.
    const oldSw = sw;
    sw.evaluate(() => chrome.runtime.reload()).catch(() => {
      /* the SW dies mid-evaluate — expected */
    });
    const deadline = Date.now() + 30_000;
    let newSw = null;
    while (Date.now() < deadline) {
      newSw = ctx.serviceWorkers().find((w) => w !== oldSw) ?? null;
      if (newSw) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!newSw) throw new Error('no new service worker appeared after runtime.reload()');

    // The new SW's onInstalled reinject storm re-injects this tab's CS
    // (fromReload path). Fresh CS → fresh doc id → fresh claims.
    await waitForBadges(page, { timeout: 30_000 });
    await settle(3_000);
    const badges = await page.evaluate(() => document.querySelectorAll('[data-branchkit-hint]').length);
    return assertClean(await poolAudit(page), `post-reload recovery (${badges} badges)`);
  } finally {
    await page.close();
  }
}
