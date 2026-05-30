// Verify CSS Anchor Positioning when the anchor CSS lives on the light-DOM
// HOST element (same tree scope as the target), with the badge visuals in a
// closed shadow root. This is the structure BranchKit actually has and the
// fallback after badge-in-shadow anchoring was shown to fail (tree-scope rule).

import { chromium } from 'playwright';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const FIXTURE = `file://${resolve(root, 'test-fixtures/anchor-positioning-host-light.html')}`;

const ctx = await chromium.launch({ headless: false });
const page = await ctx.newPage();
await page.goto(FIXTURE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(500);

async function probe(label) {
  return await page.evaluate((label) => {
    const target = document.getElementById('target');
    const host = window.__badgeHost;
    const t = target.getBoundingClientRect();
    const b = host.getBoundingClientRect();
    return {
      label,
      target: { top: Math.round(t.top), left: Math.round(t.left) },
      host: { top: Math.round(b.top), left: Math.round(b.left) },
      delta: { dy: Math.round(b.top - t.top), dx: Math.round(b.left - t.left) },
    };
  }, label);
}

console.log('--- Anchor on light-DOM host (shadow = visuals only) ---');
const p0 = await probe('initial');
console.log(p0);

await page.evaluate(() => { document.getElementById('sidebar').scrollTop = 100; });
await page.waitForTimeout(300);
const p1 = await probe('after sidebar scroll 100px');
console.log(p1);

await page.evaluate(() => { document.getElementById('sidebar').scrollTop = 50; });
await page.waitForTimeout(300);
const p2 = await probe('after sidebar scroll back to 50px');
console.log(p2);

console.log('\n--- Analysis ---');
const match = p0.delta.dy === p1.delta.dy && p0.delta.dy === p2.delta.dy
           && p0.delta.dx === p1.delta.dx && p0.delta.dx === p2.delta.dx;
if (match) {
  console.log('PASS: host tracked target across overflow scroll with zero JS.');
  console.log('Fast-path is viable: put anchor CSS on the light-DOM host, badge stays in closed shadow.');
} else {
  console.log('FAIL: host did not track target.');
  console.log(`  initial:  dy=${p0.delta.dy}, dx=${p0.delta.dx}`);
  console.log(`  scroll 1: dy=${p1.delta.dy}, dx=${p1.delta.dx}`);
  console.log(`  scroll 2: dy=${p2.delta.dy}, dx=${p2.delta.dx}`);
}

await page.screenshot({ path: '/tmp/anchor-host-light-test.png' });
console.log('screenshot: /tmp/anchor-host-light-test.png');
await ctx.close();
