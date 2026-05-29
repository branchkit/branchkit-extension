#!/usr/bin/env node
/**
 * Drive Chromium with the extension loaded against test fixtures and
 * report badge placement. Use this for fast iteration on placement
 * algorithm changes without needing to manually reload Chrome + a real
 * site.
 *
 * Usage:
 *   npm run test:placement
 *
 * What it does:
 * 1. Launches Chromium (Playwright's bundled build) with dist/chrome
 *    loaded as an unpacked extension.
 * 2. Opens each fixture in `test-fixtures/`.
 * 3. Waits for content script to scan + badges to render.
 * 4. Reports per-fixture: did any badge overlap the text it's anchored
 *    to (via `inner.right > text.left`)?
 * 5. Saves an annotated screenshot per fixture to test-fixtures/output/.
 *
 * Exits non-zero if any badge overlaps its text — useful for CI.
 *
 * Requires: `npx playwright install chromium` once, then this script
 * reuses the cached browser.
 */

import { chromium } from 'playwright';
import { readdirSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const EXT = resolve(root, 'dist/chrome');
const FIXTURE_DIR = resolve(root, 'test-fixtures');
const OUT_DIR = resolve(FIXTURE_DIR, 'output');
const PROFILE = '/tmp/branchkit-place-test-profile';

if (!existsSync(resolve(EXT, 'manifest.json'))) {
  console.error(`No manifest at ${EXT}/manifest.json — run \`npm run build:chrome\` first.`);
  process.exit(1);
}

if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

const fixtures = readdirSync(FIXTURE_DIR).filter(f => f.endsWith('.html'));
if (fixtures.length === 0) {
  console.error('No .html fixtures in test-fixtures/');
  process.exit(1);
}

console.log(`Launching Chromium with extension at ${EXT}`);
const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

let failures = 0;

for (const fixture of fixtures) {
  const page = await ctx.newPage();
  const url = `file://${resolve(FIXTURE_DIR, fixture)}`;
  await page.goto(url);
  // Wait for content script + grammar push + codeword claim + badge render.
  await page.waitForTimeout(2500);

  const result = await page.evaluate(() => {
    // For each hintable element, find its badge (if any) and check overlap.
    const items = Array.from(document.querySelectorAll('a, button, [role="button"], [tabindex]:not([tabindex="-1"])'));
    const hosts = Array.from(document.querySelectorAll('[data-branchkit-hint="true"]'));

    const findHostForItem = (item) => {
      const ir = item.getBoundingClientRect();
      return hosts.find(h => {
        const inner = h.shadowRoot?.querySelector('.bk-inner');
        const r = inner?.getBoundingClientRect();
        if (!r || r.width === 0) return false;
        return r.top >= ir.top - 30 && r.top <= ir.bottom + 5
          && r.left >= ir.left - 80 && r.left <= ir.right;
      });
    };

    const findText = (item) => {
      const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (node.textContent?.trim()) {
          const range = document.createRange();
          const i = node.textContent.search(/\S/);
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          return { node, rect: range.getBoundingClientRect() };
        }
      }
      return null;
    };

    const results = [];
    for (const item of items) {
      const host = findHostForItem(item);
      if (!host) continue;
      const inner = host.shadowRoot?.querySelector('.bk-inner');
      const badgeRect = inner?.getBoundingClientRect();
      const text = findText(item);
      const label = item.textContent.trim().slice(0, 30);
      if (badgeRect && text) {
        const overlapsX = badgeRect.right > text.rect.left + 1;
        const overlapsY = badgeRect.bottom > text.rect.top + (text.rect.height * 0.3);
        results.push({
          label,
          badge: { left: Math.round(badgeRect.left), right: Math.round(badgeRect.right), top: Math.round(badgeRect.top), text: inner?.textContent },
          text: { left: Math.round(text.rect.left), top: Math.round(text.rect.top) },
          overlapsX,
          overlapsY,
          fail: overlapsX && overlapsY,
        });
      }
    }
    return { totalHosts: hosts.length, results };
  });

  await page.screenshot({ path: resolve(OUT_DIR, fixture.replace('.html', '.png')) });

  const fixtureFailures = result.results.filter(r => r.fail);
  failures += fixtureFailures.length;

  console.log(`\n=== ${fixture} ===`);
  console.log(`  ${result.totalHosts} badges in DOM, ${result.results.length} matched to items`);
  for (const r of result.results) {
    const mark = r.fail ? '❌' : '✅';
    console.log(`  ${mark} ${r.label.padEnd(30)} badge="${r.badge.text}" overlapX=${r.overlapsX} overlapY=${r.overlapsY}`);
  }
  await page.close();
}

await ctx.close();

console.log(`\n${failures === 0 ? '✅ all clear' : `❌ ${failures} overlap failures`}`);
console.log(`Screenshots: ${OUT_DIR}`);
process.exit(failures > 0 ? 1 : 0);
