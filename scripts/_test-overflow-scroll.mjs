// Measure whether badges stay anchored to targets when an overflow
// container scrolls internally (not the window). Reproduces the
// "Gmail jitter" class of bug in controlled conditions.
//
// Method: load the scrollable-sidebar fixture, let BranchKit attach
// badges to items in the sidebar. Capture badge-vs-target deltas at
// scrollTop=0, 100, 200. If the deltas are stable, the badge is
// mounted in the target's scroll context (correct). If deltas drift
// while scroll position changes, the badge is mounted OUTSIDE the
// scroll context (the jitter bug).

import { chromium } from 'playwright';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, rmSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const EXT = resolve(root, 'dist/chrome');
const FIXTURE = `file://${resolve(root, 'test-fixtures/scrollable-sidebar.html')}`;
const PROFILE = '/tmp/branchkit-overflow-scroll-profile';

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

async function measure(scrollTop) {
  await page.evaluate((y) => { document.getElementById('sidebar').scrollTop = y; }, scrollTop);
  await page.waitForTimeout(500);
  return await page.evaluate(() => {
    // For each hint badge, find its NEAREST sidebar item and report the
    // dy + the item's data-idx so we can track the same target across
    // scroll positions.
    const hosts = Array.from(document.querySelectorAll('[data-branchkit-hint]'));
    const items = Array.from(document.querySelectorAll('.item'));
    const out = [];
    for (const host of hosts) {
      const hr = host.getBoundingClientRect();
      const hcy = hr.top + hr.height / 2;
      let bestItem = null, bestDist = Infinity;
      for (const item of items) {
        const ir = item.getBoundingClientRect();
        const icy = ir.top + ir.height / 2;
        const d = Math.abs(hcy - icy);
        if (d < bestDist) { bestDist = d; bestItem = item; }
      }
      if (bestItem && bestDist < 50) {
        const ir = bestItem.getBoundingClientRect();
        out.push({
          idx: parseInt(bestItem.getAttribute('data-idx'), 10),
          itemTop: Math.round(ir.top),
          badgeTop: Math.round(hr.top),
          dy: Math.round(hr.top - ir.top),
        });
      }
    }
    return out.sort((a, b) => a.idx - b.idx);
  });
}

console.log('\n=== Overflow-container scroll test ===\n');
// Debug counts
const counts = await page.evaluate(() => ({
  hosts: document.querySelectorAll('[data-branchkit-hint]').length,
  items: document.querySelectorAll('.item').length,
  perf: document.documentElement.dataset.branchkitPerf ? JSON.parse(document.documentElement.dataset.branchkitPerf).wrapperCount : null,
}));
console.log('counts:', counts);

// Where are the hint hosts mounted? Walking up from a sample host to
// see if its parent chain crosses the #sidebar boundary or sits outside.
const mountInfo = await page.evaluate(() => {
  const hosts = Array.from(document.querySelectorAll('[data-branchkit-hint]'));
  const sidebar = document.getElementById('sidebar');
  const out = [];
  for (const host of hosts.slice(0, 3)) {
    const chain = [];
    let cur = host;
    while (cur && cur !== document.body) {
      chain.push({
        tag: cur.tagName.toLowerCase(),
        id: cur.id || '',
        cls: (cur.className || '').toString().slice(0, 40),
        insideSidebar: sidebar.contains(cur),
      });
      cur = cur.parentElement;
    }
    const innerStyle = host.shadowRoot
      ? Array.from(host.shadowRoot.querySelectorAll('*')).find(e => e.classList && e.classList.length)?.style?.cssText
      : 'closed-shadow';
    out.push({ chain, insideSidebar: sidebar.contains(host), innerStyle });
  }
  return out;
});
console.log('mount info (first 3 hosts):');
for (const info of mountInfo) {
  console.log(`  insideSidebar=${info.insideSidebar}, chain: ${info.chain.map(c => `${c.tag}${c.id ? '#' + c.id : ''}`).join(' > ')}`);
}

const m0 = await measure(0);
console.log(`scrollTop=0 (${m0.length} entries):`); console.table(m0);
const m1 = await measure(100);
console.log('scrollTop=100:'); console.table(m1);
const m2 = await measure(200);
console.log('scrollTop=200:'); console.table(m2);

// For each idx that appears in all three measurements, compare dy stability.
console.log('\n=== dy stability per target (lower variance = badge tracks correctly) ===');
const indices = new Set([...m0.map(r => r.idx), ...m1.map(r => r.idx), ...m2.map(r => r.idx)]);
for (const idx of indices) {
  const r0 = m0.find(r => r.idx === idx);
  const r1 = m1.find(r => r.idx === idx);
  const r2 = m2.find(r => r.idx === idx);
  const dys = [r0?.dy, r1?.dy, r2?.dy].filter(v => v !== undefined);
  if (dys.length < 2) continue;
  const variance = Math.max(...dys) - Math.min(...dys);
  console.log(`  idx ${idx}: dy values = ${JSON.stringify(dys)}, variance = ${variance}px`);
}

await page.screenshot({ path: '/tmp/overflow-scroll-test.png' });
console.log('\nscreenshot: /tmp/overflow-scroll-test.png');

await ctx.close();
