/**
 * Scenario: iframe add/remove — cross-document pool hygiene inside one tab.
 * A dynamically-added iframe's content script claims its own labels (its
 * own documentInstanceId); removal fires its liveness-Port disconnect and
 * releaseDocument must free EXACTLY its labels. Pool state is read directly
 * from the SW (chrome.storage.session), so the assertions are on ownership
 * itself, not just the top document's audit.
 */

import { waitForBadges, poolAudit, assertClean, settle } from '../driver.mjs';

async function poolOwners(sw, tabId) {
  const stacks = await sw.evaluate(async (tid) => {
    const all = await chrome.storage.session.get(null);
    return all[`labelStack:${tid}`] ?? null;
  }, tabId);
  if (!stacks) return { docs: [], free: 0 };
  const docs = new Set();
  for (const owner of Object.values(stacks.assigned)) docs.add(owner.d);
  return { docs: [...docs], free: stacks.free.length };
}

export async function run({ ctx, base, sw }) {
  if (!sw) throw new Error('iframe scenario needs the SW handle (chromium)');
  const page = await ctx.newPage();
  try {
    await page.goto(`${base}/a.html`);
    await waitForBadges(page);
    await settle();
    const tabId = await sw.evaluate(async () => (await chrome.tabs.query({}))
      .find((t) => t.url?.includes('/a.html'))?.id);

    const before = await poolOwners(sw, tabId);
    if (before.docs.length !== 1) throw new Error(`expected 1 owning doc pre-iframe, got ${before.docs.length}`);

    await page.click('#add-iframe');
    // The iframe's own CS boots, scans b.html, claims + confirms.
    const frame = await (await page.waitForSelector('#child')).contentFrame();
    await frame.waitForFunction(() => document.querySelectorAll('[data-branchkit-hint]').length > 0, undefined, { timeout: 20_000 });
    await settle(3_000);

    const withFrame = await poolOwners(sw, tabId);
    if (withFrame.docs.length !== 2) throw new Error(`expected 2 owning docs with iframe, got ${withFrame.docs.length}`);

    await page.click('#remove-iframe');
    await settle(4_000); // liveness disconnect → releaseDocument

    const after = await poolOwners(sw, tabId);
    if (after.docs.length !== 1) throw new Error(`iframe labels not reaped: ${after.docs.length} owners remain`);
    if (after.free <= withFrame.free) throw new Error(`free pool did not recover (${withFrame.free} → ${after.free})`);

    return assertClean(await poolAudit(page), `iframe churn (owners 1→2→1, free recovered to ${after.free})`);
  } finally {
    await page.close();
  }
}
