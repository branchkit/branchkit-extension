// Measures Regime B codeword reclaim across a FULL page reload (Layer 3 of
// notes/DESIGN_REGIME_B_RECALL.md). Two scenarios:
//
//  1. SAME-content reload (?t=A -> ?t=A): every element is remembered, so all
//     reclaim. Regression guard for fix A1/A2.
//  2. CROSS-content reload (?t=A -> ?t=B): the SIDEBAR is stable but the BODY
//     content changes (no memory) — the QuickBase "switch tables" shape. The
//     new body claims fresh; fix A3 (reserved codewords) must stop it from
//     stealing the sidebar's letters. Asserts the sidebar keeps its codewords.
//
// Deterministic, no app: seeds the alphabet into extension storage. Reads state
// via the cross-world snapshot channel (dataset.branchkitSnapshot).
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
const SIDEBAR_TARGET = 0.90; // sidebar reclaim we require across a cross-content reload

const fixtureHtml = readFileSync(resolve(root, 'test-fixtures/regime-b-recall.html'), 'utf8');
const server = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(fixtureHtml);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

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
await page.setViewportSize({ width: 1280, height: 4000 });

// Map href -> codeword for the live store, via the cross-world snapshot channel.
async function codewordsByHref() {
  return await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('__branchkit__capture_snapshot'));
    const raw = document.documentElement.dataset.branchkitSnapshot;
    if (!raw) return {};
    const p = JSON.parse(raw);
    const out = {};
    for (const w of (p.wrappers || [])) {
      const href = w.fingerprint && w.fingerprint.href;
      if (href && w.scanned && w.scanned.codeword) out[href] = w.scanned.codeword;
    }
    return out;
  });
}
const pick = (m, pred) => Object.fromEntries(Object.entries(m).filter(([h]) => pred(h)));
const stableFrac = (before, after) => {
  const common = Object.keys(before).filter((h) => h in after);
  if (!common.length) return { n: 0, stable: 0, frac: null };
  const stable = common.filter((h) => before[h] === after[h]).length;
  return { n: common.length, stable, frac: stable / common.length };
};

console.log('[2] load ?t=A — claim + persist (settle 7s)');
await page.goto(BASE + '?t=A', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(7000);
const A1 = await codewordsByHref();
console.log(`    sidebar links: ${Object.keys(pick(A1, h => h.startsWith('/s/'))).length}, body links: ${Object.keys(pick(A1, h => h.startsWith('/b/'))).length}`);

console.log('[3] SAME-content reload (?t=A -> ?t=A)');
await page.goto(BASE + '?t=A', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(7000);
const A2 = await codewordsByHref();
const sameAll = stableFrac(A1, A2);
console.log(`    all links stable: ${sameAll.stable}/${sameAll.n}` + (sameAll.frac != null ? ` = ${(sameAll.frac * 100).toFixed(0)}%` : ''));
if (sameAll.frac != null && sameAll.frac >= 0.95) pass('same-content reload reclaims ~everything (A1/A2 intact)');
else fail(`same-content reclaim regressed: ${sameAll.frac != null ? (sameAll.frac * 100).toFixed(0) + '%' : 'n/a'}`);

console.log('[4] CROSS-content reload (?t=A -> ?t=B): same sidebar, different body');
await page.goto(BASE + '?t=B', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(7000);
const B = await codewordsByHref();
const sb = stableFrac(pick(A2, h => h.startsWith('/s/')), pick(B, h => h.startsWith('/s/')));
console.log(`    SIDEBAR stable across body change: ${sb.stable}/${sb.n}` + (sb.frac != null ? ` = ${(sb.frac * 100).toFixed(0)}%` : ''));
if (sb.frac == null) {
  fail('no sidebar links to compare after cross-content reload');
} else if (sb.frac >= SIDEBAR_TARGET) {
  pass(`sidebar reclaim ${(sb.frac * 100).toFixed(0)}% >= target ${(SIDEBAR_TARGET * 100).toFixed(0)}% — body did not steal its letters (A3 holds)`);
} else {
  fail(`sidebar reclaim ${(sb.frac * 100).toFixed(0)}% < target ${(SIDEBAR_TARGET * 100).toFixed(0)}% — new body content stole reserved codewords (A3 leak)`);
}

console.log('\n=== VERDICT ===');
console.log(failed
  ? '  ✗ FAIL — Regime B reclaim not solid across content change'
  : '  ✓ PASS — same-content fully reclaims AND the sidebar survives a body change');

await page.screenshot({ path: '/tmp/branchkit-regime-b-recall.png' });
await ctx.close();
server.close();
process.exit(failed ? 1 : 0);
