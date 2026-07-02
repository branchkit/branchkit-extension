#!/usr/bin/env node
/**
 * Run the aggressive-hints fixture in both modes (toggle off vs on) and
 * report how many badges render in each. Confirms the toggle actually
 * widens the selector set without breaking the default scan.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync } from 'node:fs';
import { launchExtension } from './lib/launch.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const FIXTURE = resolve(root, 'test-fixtures/aggressive-hints.html');
const OUT = resolve(root, 'test-fixtures/output');
const PROFILE = '/tmp/branchkit-aggressive-test-profile';

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const { ctx } = await launchExtension({ profile: PROFILE });

async function runWith(modeOn) {
  // Set the toggle BEFORE navigating so content script sees the right value.
  // Use the extension's background service worker to write chrome.storage.sync.
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  await sw.evaluate(async (v) => {
    await chrome.storage.sync.set({ aggressiveHints: v });
  }, modeOn);

  const page = await ctx.newPage();
  await page.goto(`file://${FIXTURE}`);
  await page.waitForTimeout(2500);

  const counts = await page.evaluate(() => {
    const hosts = document.querySelectorAll('[data-branchkit-hint="true"]');
    const items = {
      rows: document.querySelectorAll('.row').length,
      cbs: document.querySelectorAll('.cb').length,
      stars: document.querySelectorAll('.star').length,
      btns: document.querySelectorAll('.btn-thing').length,
      reals: document.querySelectorAll('a[href], button').length,
    };
    return { badgeCount: hosts.length, items };
  });

  await page.screenshot({
    path: resolve(OUT, modeOn ? 'aggressive-on.png' : 'aggressive-off.png'),
  });
  await page.close();
  return counts;
}

const off = await runWith(false);
console.log('\n=== Aggressive hints OFF (default) ===');
console.log(`  Page has: ${JSON.stringify(off.items)}`);
console.log(`  Badges rendered: ${off.badgeCount}`);
console.log(`  (Expect ~2: the real <a> and real <button>)`);

const on = await runWith(true);
console.log('\n=== Aggressive hints ON ===');
console.log(`  Page has: ${JSON.stringify(on.items)}`);
console.log(`  Badges rendered: ${on.badgeCount}`);
console.log(`  (Expect more: rows + cbs + stars + btn-thing divs + real elements)`);

console.log(`\nScreenshots: ${OUT}/aggressive-{off,on}.png`);
await ctx.close();
process.exit(on.badgeCount > off.badgeCount ? 0 : 1);
