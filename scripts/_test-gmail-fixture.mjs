// Replicates the Gmail mail-list structure: a scrolling outer wrapper
// containing a static inner div containing a table. Verifies badges
// mount inside <td> (per the new findBadgeContainer fix) so they
// scroll with the table when the wrapper scrolls internally.

import { chromium } from 'playwright';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, rmSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const EXT = resolve(root, 'dist/chrome');
const FIXTURE = `file://${resolve(root, 'test-fixtures/gmail-like-table.html')}`;
const PROFILE = '/tmp/branchkit-gmail-fixture-profile';

if (existsSync(PROFILE)) rmSync(PROFILE, { recursive: true });

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  args: ['--disable-extensions-except=' + EXT, '--load-extension=' + EXT],
});

const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
await sw.evaluate(async () => {
  await chrome.storage.sync.set({ hintVisibility: 'always' });
});

const page = await ctx.newPage();
await page.goto(FIXTURE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);

const inspect = async () => page.evaluate(() => {
  const tds = [...document.querySelectorAll('td')];
  const tdsWithHosts = tds.filter(td =>
    [...td.children].some(c => c.hasAttribute && c.hasAttribute('data-branchkit-hint'))
  );
  const allHosts = [...document.querySelectorAll('[data-branchkit-hint]')];
  const hostParents = allHosts.map(h => {
    const p = h.parentElement;
    return p ? `${p.tagName.toLowerCase()}${p.id ? '#' + p.id : ''}${p.className ? '.' + (p.className+'').slice(0, 20) : ''}` : 'no-parent';
  });
  const byParent = {};
  for (const p of hostParents) byParent[p] = (byParent[p] || 0) + 1;
  return {
    total_tds: tds.length,
    tds_with_hosts: tdsWithHosts.length,
    total_hosts: allHosts.length,
    host_parent_distribution: byParent,
  };
});

console.log('\n=== Gmail-like fixture: where do badges mount? ===\n');
console.log(JSON.stringify(await inspect(), null, 2));

// Scroll the wrapper, see if badges follow
console.log('\n=== Scrolling wrapper 200px ===');
await page.evaluate(() => { document.querySelector('.scroll-wrapper').scrollTop = 200; });
await page.waitForTimeout(1000);

const scrollState = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('a[data-row]')];
  return rows.slice(0, 5).map(a => {
    const r = a.getBoundingClientRect();
    // Find nearest hint host
    let nearest = null, bestDy = Infinity;
    for (const h of document.querySelectorAll('[data-branchkit-hint]')) {
      const hr = h.getBoundingClientRect();
      const dy = Math.abs(hr.top - r.top);
      if (dy < bestDy) { bestDy = dy; nearest = h; }
    }
    if (!nearest) return { row: a.dataset.row, target_y: Math.round(r.top), badge: null };
    const hr = nearest.getBoundingClientRect();
    return {
      row: a.dataset.row,
      target_y: Math.round(r.top),
      badge_y: Math.round(hr.top),
      delta: Math.round(hr.top - r.top),
    };
  });
});

console.log('Target vs badge positions after scroll:');
console.table(scrollState);

await page.screenshot({ path: '/tmp/gmail-fixture-test.png' });
console.log('screenshot: /tmp/gmail-fixture-test.png');

await ctx.close();
