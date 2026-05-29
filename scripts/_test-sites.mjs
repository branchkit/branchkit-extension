// Regression check: take a screenshot + measure badge stats on a few
// representative sites after the resolveContainer fixes. Looking for
// (a) hints render, (b) anchorParentTag distribution looks sensible,
// (c) no obvious visual breakage in screenshots.

import { chromium } from 'playwright';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, rmSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const EXT = resolve(root, 'dist/chrome');
const PROFILE = '/tmp/branchkit-multisite-profile';

const SITES = [
  { name: 'wikipedia', url: 'https://en.wikipedia.org/wiki/Cascading_Style_Sheets' },
  { name: 'github', url: 'https://github.com/anthropics/anthropic-cookbook' },
  { name: 'reddit', url: 'https://www.reddit.com/r/programming/' },
  { name: 'hn', url: 'https://news.ycombinator.com/' },
  { name: 'mdn', url: 'https://developer.mozilla.org/en-US/docs/Web/CSS/position' },
  { name: 'youtube-home', url: 'https://www.youtube.com' },
];

if (existsSync(PROFILE)) rmSync(PROFILE, { recursive: true });

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  args: ['--disable-extensions-except=' + EXT, '--load-extension=' + EXT],
});

const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
await sw.evaluate(async () => {
  await chrome.storage.sync.set({ hintVisibility: 'always' });
});

const results = [];

for (const site of SITES) {
  const page = await ctx.newPage();
  try {
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  } catch (err) {
    console.warn(`${site.name}: load failed - ${err.message}`);
    await page.close();
    continue;
  }
  await page.waitForTimeout(7000); // settle

  const stats = await page.evaluate(() => {
    const raw = document.documentElement.dataset.branchkitPerf;
    const snap = raw ? JSON.parse(raw) : null;
    const hosts = [...document.querySelectorAll('[data-branchkit-hint]')];
    const byParent = {};
    for (const h of hosts) {
      const tag = h.parentElement?.tagName.toLowerCase() ?? 'no-parent';
      byParent[tag] = (byParent[tag] || 0) + 1;
    }
    return {
      wrappers: snap?.wrapperCount ?? null,
      hosts: hosts.length,
      byParentTag: byParent,
    };
  });

  await page.screenshot({ path: `/tmp/sitecheck-${site.name}.png` });
  results.push({ site: site.name, ...stats });
  await page.close();
}

console.log('\n=== Site check after resolveContainer fixes ===\n');
for (const r of results) {
  const tags = Object.entries(r.byParentTag).map(([k, v]) => `${k}=${v}`).join(' ');
  console.log(`  ${r.site.padEnd(15)} wrappers=${r.wrappers}  hosts=${r.hosts}  hosts-by-tag: ${tags}`);
}
console.log('\nScreenshots: /tmp/sitecheck-{wikipedia,github,reddit,hn,mdn,youtube-home}.png');

await ctx.close();
