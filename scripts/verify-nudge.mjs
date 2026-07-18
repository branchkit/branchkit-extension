#!/usr/bin/env node
/**
 * One-off verification: does a nudge rule (kind 'nudge', {dx, dy}) move a
 * live badge — both when first written and when its offsets are edited
 * (the popup stepper path)?
 *
 * Serves a fixture over localhost so a 'localhost' rule pattern matches,
 * seeds chrome.storage.sync from the service worker, and measures badge
 * host transforms before/after.
 *
 * Usage: node scripts/verify-nudge.mjs
 */

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchExtension } from './lib/launch.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const PORT = 8934;
const PROFILE = '/tmp/branchkit-verify-nudge-profile';

const fixture = readFileSync(resolve(root, 'test-fixtures/scrollable-sidebar.html'), 'utf8');
const server = http.createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(fixture);
});
await new Promise((r) => server.listen(PORT, r));

const { ctx } = await launchExtension({ profile: PROFILE, freshProfile: true });

function rulesPayload(dx, dy) {
  return {
    domainRules: {
      rules: [{
        id: 'r-verify',
        pattern: 'localhost',
        enabled: true,
        entries: [{
          id: 'e-verify',
          kind: 'nudge',
          matcher: { type: 'css', selector: 'a' },
          nudge: { dx, dy },
        }],
      }],
    },
  };
}

async function seedRules(dx, dy) {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  await sw.evaluate((payload) => chrome.storage.sync.set(payload), rulesPayload(dx, dy));
}

const page = await ctx.newPage();
await page.goto(`http://localhost:${PORT}/`);
await page.waitForTimeout(2500);

async function anchorBadgeTransforms() {
  return page.evaluate(() => {
    const out = [];
    for (const host of document.querySelectorAll('[data-branchkit-hint]')) {
      const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(host.style.transform || '');
      if (m) out.push({ x: parseFloat(m[1]), y: parseFloat(m[2]) });
    }
    return out;
  });
}

const before = await anchorBadgeTransforms();
if (before.length === 0) {
  console.error('FAIL: no badges rendered on the fixture');
  process.exit(1);
}

await seedRules(100, 50);
await page.waitForTimeout(1200);
const after = await anchorBadgeTransforms();

await seedRules(-40, 50);   // the "edit an existing rule's dx" path
await page.waitForTimeout(1200);
const edited = await anchorBadgeTransforms();

server.close();
await ctx.close();

const moved = after.filter((p, i) => before[i] && Math.abs(p.x - before[i].x - 100) < 2 && Math.abs(p.y - before[i].y - 50) < 2).length;
const editMoved = edited.filter((p, i) => after[i] && Math.abs(p.x - after[i].x + 140) < 2).length;

console.log(`badges: ${before.length}`);
console.log(`moved by (+100,+50) after rule write: ${moved}/${after.length}`);
console.log(`moved by (-140,0) after rule edit:    ${editMoved}/${edited.length}`);
console.log('sample before/after/edited:', before[0], after[0], edited[0]);

if (moved === 0 || editMoved === 0) {
  console.error('FAIL: nudge rule did not move badges');
  process.exit(1);
}
console.log('PASS');
