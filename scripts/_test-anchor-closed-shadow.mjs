// Verify CSS Anchor Positioning works across a CLOSED Shadow DOM boundary —
// the actual mode BranchKit hint hosts use (hints.ts:331).
//
// Shadow `mode` is a JS-access flag, not a CSS one, so this is expected to
// behave identically to the open-mode prototype. We probe the badge via
// window.__badge because host.shadowRoot is null for closed roots.

import { chromium } from 'playwright';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const FIXTURE = `file://${resolve(root, 'test-fixtures/anchor-positioning-closed-shadow.html')}`;

const ctx = await chromium.launch({ headless: false });
const page = await ctx.newPage();
await page.goto(FIXTURE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(500);

async function probe(label) {
  return await page.evaluate((label) => {
    const target = document.getElementById('target');
    const badge = window.__badge;
    const t = target.getBoundingClientRect();
    const b = badge.getBoundingClientRect();
    return {
      label,
      target: { top: Math.round(t.top), left: Math.round(t.left) },
      badge: { top: Math.round(b.top), left: Math.round(b.left) },
      delta: { dy: Math.round(b.top - t.top), dx: Math.round(b.left - t.left) },
    };
  }, label);
}

console.log('--- Anchor Positioning + CLOSED Shadow DOM probe ---');
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
  console.log('PASS: badge tracked target across scroll inside a CLOSED shadow root.');
  console.log('Shadow mode does NOT affect CSS Anchor Positioning. Fast-path is viable.');
} else {
  console.log('FAIL: badge did not track target.');
  console.log(`  initial:  dy=${p0.delta.dy}, dx=${p0.delta.dx}`);
  console.log(`  scroll 1: dy=${p1.delta.dy}, dx=${p1.delta.dx}`);
  console.log(`  scroll 2: dy=${p2.delta.dy}, dx=${p2.delta.dx}`);
}

await page.screenshot({ path: '/tmp/anchor-closed-shadow-test.png' });
console.log('screenshot: /tmp/anchor-closed-shadow-test.png');
await ctx.close();
