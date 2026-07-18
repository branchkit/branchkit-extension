#!/usr/bin/env node
/**
 * One-off verification: does a rule-level badge size override
 * (DomainRule.badgeSizePx) actually resize live badges — when written,
 * when edited, and back to the global size when removed?
 *
 * Serves a fixture over localhost so a 'localhost' rule pattern matches,
 * seeds chrome.storage.sync from the service worker, and reads each
 * badge's inline font-size through the bkOpenShadow test affordance.
 *
 * Expected sizes on the fixture's default 16px links (global defaults
 * scale 0.8, clamp [8,18]):
 *   no rule        → round(16 × 0.8)          = 13px
 *   badgeSizePx 20 → round(16 × 20/14) = 23 → clamped to widened max 20
 *   badgeSizePx 9  → round(16 × 9/14)         = 10px
 *   rule removed   → 13px again
 *
 * Usage: node scripts/verify-badge-size.mjs
 */

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchExtension } from './lib/launch.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const PORT = 8935;
const PROFILE = '/tmp/branchkit-verify-badge-size-profile';

const fixture = readFileSync(resolve(root, 'test-fixtures/scrollable-sidebar.html'), 'utf8');
const server = http.createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(fixture);
});
await new Promise((r) => server.listen(PORT, r));

const { ctx } = await launchExtension({ profile: PROFILE, freshProfile: true });

function rulesPayload(badgeSizePx) {
  const rule = { id: 'r-verify', pattern: 'localhost', enabled: true, entries: [] };
  if (badgeSizePx !== undefined) rule.badgeSizePx = badgeSizePx;
  return { domainRules: { rules: [rule] } };
}

async function seedRules(payload) {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  await sw.evaluate((p) => chrome.storage.sync.set(p), payload);
}

const page = await ctx.newPage();
await page.goto(`http://localhost:${PORT}/`);
// Open the badge shadow roots so we can read .bk-inner's font-size; the CS
// reads the flag at module load, so set it and reload for a fresh CS.
await page.evaluate(() => localStorage.setItem('bkOpenShadow', '1'));
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);

// Distinct font sizes across all painted badges (the size override applies
// frame-wide, so every badge on the fixture's uniform 16px links should
// carry the same value).
async function badgeFontSizes() {
  return page.evaluate(() => {
    const sizes = new Map();
    for (const host of document.querySelectorAll('[data-branchkit-hint]')) {
      const inner = host.shadowRoot?.querySelector('.bk-inner');
      if (!inner) continue;
      const px = parseFloat(inner.style.fontSize);
      if (Number.isFinite(px)) sizes.set(px, (sizes.get(px) ?? 0) + 1);
    }
    return [...sizes.entries()].map(([px, count]) => ({ px, count }));
  });
}

const fail = async (msg) => {
  console.error(`FAIL: ${msg}`);
  server.close();
  await ctx.close();
  process.exit(1);
};

const dominant = (sizes) => sizes.slice().sort((a, b) => b.count - a.count)[0];

const before = await badgeFontSizes();
console.log('baseline sizes:', before);
if (before.length === 0) await fail('no open-shadow badges rendered on the fixture');
if (dominant(before).px !== 13) await fail(`expected 13px baseline, got ${JSON.stringify(before)}`);

await seedRules(rulesPayload(20));
await page.waitForTimeout(2000);
const withOverride = await badgeFontSizes();
console.log('with badgeSizePx 20:', withOverride);
if (dominant(withOverride).px !== 20) {
  await fail(`expected 20px under override (clamp must widen past fontMax 18), got ${JSON.stringify(withOverride)}`);
}

// Edit path: same rule, new size — the popup slider writes exactly this.
await seedRules(rulesPayload(9));
await page.waitForTimeout(2000);
const edited = await badgeFontSizes();
console.log('with badgeSizePx 9: ', edited);
if (dominant(edited).px !== 10) await fail(`expected 10px after edit, got ${JSON.stringify(edited)}`);

// Removal: rule stays matched (still has the empty entries list) but the
// override is gone — sizes must revert to the global setting.
await seedRules(rulesPayload(undefined));
await page.waitForTimeout(2000);
const reverted = await badgeFontSizes();
console.log('override removed:   ', reverted);
if (dominant(reverted).px !== 13) await fail(`expected 13px after removal, got ${JSON.stringify(reverted)}`);

server.close();
await ctx.close();
console.log('PASS');
