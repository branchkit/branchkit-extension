// Measures Regime B codeword reclaim across a FULL page reload (Layer 3 of
// notes/DESIGN_REGIME_B_RECALL.md).
//
// A reload destroys the content script, so reclaim can only come from the
// SW-persisted fingerprint->codeword memory. This loads a page of 130 links
// (above the reservoir's 100-codeword initial preferred-fill so the cap shows),
// lets them claim + persist, then reloads and reads the recall_stats metric:
// reclaimed = got its pre-reload letter back, missed = had a remembered letter
// but got a different one. The reclaim rate is what this layer drives up.
//
// Deterministic, no app: seeds the alphabet straight into extension storage.
// Reads state via the cross-world snapshot channel (dataset.branchkitSnapshot).
//
// Run: node scripts/_test-regime-b-recall.mjs

import { chromium } from 'playwright';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, rmSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const EXT = resolve(root, 'dist/chrome');
const PROFILE = '/tmp/branchkit-regime-b-recall-profile';
const TARGET_RATE = 0.90; // viewport reclaim we want this layer to reach

const fixtureHtml = readFileSync(resolve(root, 'test-fixtures/regime-b-recall.html'), 'utf8');
const server = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(fixtureHtml);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const FIXTURE = `http://127.0.0.1:${server.address().port}/`;

if (existsSync(PROFILE)) rmSync(PROFILE, { recursive: true });

let failed = false;
const fail = (msg) => { failed = true; console.log('  FAIL —', msg); };
const pass = (msg) => console.log('  ok  —', msg);

console.log('[1] launch Chromium with extension');
const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  args: ['--disable-extensions-except=' + EXT, '--load-extension=' + EXT],
});

const ALPHABET = 'arch bat cat dog echo fox golf hotel india jam kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu'.split(' ');
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
await sw.evaluate(async (a) => {
  await chrome.storage.sync.set({ aggressiveHints: true, hintVisibility: 'always' });
  await chrome.storage.local.set({ alphabet: a });
}, ALPHABET);

const page = await ctx.newPage();
await page.setViewportSize({ width: 1280, height: 3000 });

async function recallStats() {
  return await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('__branchkit__capture_snapshot'));
    const raw = document.documentElement.dataset.branchkitSnapshot;
    if (!raw) return null;
    const p = JSON.parse(raw);
    const codeworded = (p.wrappers || []).filter((w) => w.scanned && w.scanned.codeword).length;
    return { ...(p.recall_stats || {}), codeworded };
  });
}
const rate = (s) => {
  const denom = s.viewport_reclaimed + s.viewport_missed;
  return denom > 0 ? s.viewport_reclaimed / denom : null;
};

console.log('[2] first load — claim + persist codewords (settle 7s)');
await page.goto(FIXTURE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(7000);
const first = await recallStats();
console.log('    first-load stats:', JSON.stringify(first));
if (!first || first.codeworded < 100) {
  fail(`expected >=100 codeworded links on first load, got ${first ? first.codeworded : 'null'} (claim/alphabet issue?)`);
}

if (!failed) {
  console.log('[3] FULL RELOAD — content script is rebuilt; only the SW memory survives');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(7000);

  const after = await recallStats();
  console.log('    after-reload stats:', JSON.stringify(after));
  const r = rate(after);
  const overallDenom = after.reclaimed + after.missed;
  const overall = overallDenom > 0 ? after.reclaimed / overallDenom : null;

  console.log(`    viewport reclaim: ${after.viewport_reclaimed}/${after.viewport_reclaimed + after.viewport_missed}` +
    (r != null ? ` = ${(r * 100).toFixed(0)}%` : ' (n/a)'));
  console.log(`    overall reclaim:  ${after.reclaimed}/${overallDenom}` +
    (overall != null ? ` = ${(overall * 100).toFixed(0)}%` : ' (n/a)'));

  if (r == null) {
    fail('no remembered-and-present viewport elements after reload — nothing to score (persist/recall broke)');
  } else if (r >= TARGET_RATE) {
    pass(`viewport reclaim ${(r * 100).toFixed(0)}% >= target ${(TARGET_RATE * 100).toFixed(0)}%`);
  } else {
    fail(`viewport reclaim ${(r * 100).toFixed(0)}% < target ${(TARGET_RATE * 100).toFixed(0)}% — the cap/refill leak (Layer 3 fix A)`);
  }
}

console.log('\n=== VERDICT ===');
console.log(failed
  ? '  ✗ BELOW TARGET — Regime B reclaim needs the fix-A work (preferred through refills / scan path)'
  : '  ✓ AT TARGET — Regime B reclaim meets the goal');

await page.screenshot({ path: '/tmp/branchkit-regime-b-recall.png' });
await ctx.close();
server.close();
process.exit(failed ? 1 : 0);
