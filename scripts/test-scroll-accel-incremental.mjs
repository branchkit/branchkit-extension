// Integration test for the INCREMENTAL chain-update fix (the cure for hover-gated
// re-arm churn).
//
// When a hover-gated inner scroller flaps during an outer scroll, the ridden chain
// flips [inner,outer] <-> [outer]. The OLD path re-armed by tearing down ALL layers
// and rebuilding them — including the still-running OUTER layer — a 1-frame jump per
// flap (the "slight wiggle"). The fix reconciles the chain INCREMENTALLY: only the
// inner layer is added/removed; the outer layer's ScrollTimeline keeps running.
//
// Observable proof via two host counters:
//   data-bk-accel-rearms  = chain-change events (climbs ~2 per flap in BOTH old/new)
//   data-bk-accel-builds  = ScrollTimeline anims BUILT (the cost)
// Incremental builds ~1 per flap (re-add the inner only) and reuses the outer, so
// builds climbs much SLOWER than rearms. The old full-teardown rebuilt ~3 per flap
// (>= the chain-change count). So `builds < rearms` and `builds ~ flaps` is the
// signature of the fix; it FAILS on the old code (builds >= rearms, ~3x flaps).
//
// Run: npm run test:scroll-accel-incremental

import { chromium } from 'playwright';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const EXT = resolve(root, 'dist/chrome');
const PROFILE = '/tmp/branchkit-incremental-profile';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const links = Array.from({ length: 30 }, (_, i) =>
  `<li><a href="#a${i}">cell ${String(i + 1).padStart(2, '0')}</a></li>`).join('\n');
const FIXTURE_HTML = `<!doctype html><html><head><title>incremental chain update</title>
<style>
  #report { overflow: hidden; }
  #report:hover { overflow: auto; }
  #report::-webkit-scrollbar { width: 0; height: 0; }
</style></head>
<body style="font-family:sans-serif;margin:0;padding:20px;">
<div id="outer" style="height:380px;overflow:auto;border:2px solid #c00;">
  <div style="height:24px"></div>
  <p style="margin:0 16px"><a id="ctrl" href="#ctrl">control link</a></p>
  <div style="height:16px"></div>
  <div id="report" style="height:200px;border:2px solid #06c;">
    <ul id="list" style="line-height:34px;font-size:18px;list-style:none;margin:0;padding:0 16px;">
    ${links}
    </ul>
  </div>
  <div style="height:700px"></div>
</div>
<div style="height:1200px"></div>
</body></html>`;

const server = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(FIXTURE_HTML);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const FIXTURE = `http://127.0.0.1:${server.address().port}/`;
console.log('fixture:', FIXTURE);

if (existsSync(PROFILE)) rmSync(PROFILE, { recursive: true });
const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
const ALPHABET = 'arch bat cat dog echo fox golf hotel india jam kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu'.split(' ');
await sw.evaluate(async (a) => {
  await chrome.storage.sync.set({ aggressiveHints: true, hintVisibility: 'always' });
  await chrome.storage.local.set({ alphabet: a }); // nested is default-on
}, ALPHABET);

const page = await ctx.newPage();
await page.goto(FIXTURE, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => localStorage.setItem('bkOpenShadow', '1'));
await page.reload({ waitUntil: 'domcontentloaded' });
await sleep(6000);

const fail = async (msg) => { console.log('FAIL —', msg); await ctx.close(); server.close(); process.exit(1); };

const env = await page.evaluate(() => ({
  nested: document.documentElement.dataset.bkScrollAccelNested,
  st: typeof ScrollTimeline !== 'undefined',
  hosts: document.querySelectorAll('[data-branchkit-hint]').length,
}));
console.log('env:', env);
if (!env.st) await fail('ScrollTimeline unsupported in this Chromium');
if (env.hosts === 0) await fail('no badge hosts painted');
if (env.nested !== 'on') await fail(`nested expected on (default), got ${env.nested}`);

async function badgeFor(sel, txt) {
  return page.evaluate(({ sel, txt }) => {
    const target = txt
      ? [...document.querySelectorAll(sel)].find((a) => a.textContent.trim() === txt)
      : document.querySelector(sel);
    if (!target) return { ok: false, reason: 'target gone' };
    const tr = target.getBoundingClientRect();
    let host = null, bestD = Infinity;
    for (const h of document.querySelectorAll('[data-branchkit-hint]')) {
      const bi = h.shadowRoot && h.shadowRoot.querySelector('.bk-inner');
      if (!bi) continue;
      const r = bi.getBoundingClientRect();
      const d = Math.hypot(r.left - tr.left, r.top - tr.top);
      if (d < bestD) { bestD = d; host = h; }
    }
    if (!host) return { ok: false, reason: 'no host' };
    return {
      ok: true, bestD: Math.round(bestD),
      accel: host.getAttribute('data-bk-accel'),
      rearms: Number(host.getAttribute('data-bk-accel-rearms') || 0),
      builds: Number(host.getAttribute('data-bk-accel-builds') || 0),
    };
  }, { sel, txt });
}

// Arm [report, outer].
await page.locator('#report').hover();
await page.evaluate(() => document.getElementById('report').scrollBy(0, 16));
await sleep(250);
const reportBase = await badgeFor('#report a', 'cell 03');
const ctrlBase = await badgeFor('#ctrl', null);
console.log('report baseline:', reportBase, '\ncontrol baseline:', ctrlBase);
if (!reportBase.ok || !ctrlBase.ok) await fail('badge(s) not found');
if (reportBase.accel !== '2') await fail(`report not riding [inner,outer] (accel=${reportBase.accel})`);

// Flap the inner :hover while scrolling the outer (net-zero so both stay in view).
const FLAPS = 6;
for (let i = 0; i < FLAPS; i++) {
  await page.mouse.move(5, 5);
  await page.evaluate(() => document.getElementById('outer').scrollBy(0, 12));
  await sleep(45);
  await page.locator('#report').hover();
  await page.evaluate(() => document.getElementById('outer').scrollBy(0, -12));
  await sleep(45);
}

const reportAfter = await badgeFor('#report a', 'cell 03');
const ctrlAfter = await badgeFor('#ctrl', null);
console.log(`\nafter ${FLAPS} hover flaps:\n  report:`, reportAfter, '\n  control:', ctrlAfter);
if (!reportAfter.ok) await fail('report badge lost after flaps');

const rearmsDelta = reportAfter.rearms - reportBase.rearms;   // chain changes (~2/flap)
const buildsDelta = reportAfter.builds - reportBase.builds;   // anims built (~1/flap incremental)
const ctrlBuildsDelta = ctrlAfter.ok ? ctrlAfter.builds - ctrlBase.builds : -1;

// (1) The scenario genuinely flapped the chain.
const flapped = rearmsDelta >= FLAPS;
console.log(`  chain flapped (rearm delta ${rearmsDelta} >= ${FLAPS}): ${flapped ? 'PASS' : 'FAIL'}`);

// (2) INCREMENTAL: anims built grew ~1 per flap (re-add the inner), and strictly
// SLOWER than chain-changes — i.e. the outer layer's anim was REUSED, not rebuilt.
// Old full-teardown rebuilt every layer each flap (builds >= rearms, ~3x flaps).
const incremental = buildsDelta <= FLAPS + 2 && buildsDelta < rearmsDelta;
console.log(`  incremental reuse (builds delta ${buildsDelta} <= ${FLAPS + 2} AND < rearms ${rearmsDelta}): ${incremental ? 'PASS' : 'FAIL'}`);

// (3) Control badge (outer-only chain, never flaps) builds nothing extra.
const ctrlStable = ctrlBuildsDelta <= 1;
console.log(`  control builds stable (delta ${ctrlBuildsDelta} <= 1): ${ctrlStable ? 'PASS' : 'FAIL'}`);

// (4) Correctness preserved: still riding [inner, outer] while hovered.
const correct = reportAfter.accel === '2';
console.log(`  still rides [inner,outer] after flaps (accel=2): ${correct ? 'PASS' : 'FAIL'} (accel=${reportAfter.accel})`);

await page.screenshot({ path: '/tmp/incremental-accel.png' });
console.log('\nscreenshot: /tmp/incremental-accel.png');
console.log('\n=== VERDICT ===');
console.log(`  chain flapped:                  ${flapped ? 'PASS' : 'FAIL'} (rearms +${rearmsDelta})`);
console.log(`  incremental layer reuse:        ${incremental ? 'PASS' : 'FAIL'} (builds +${buildsDelta})`);
console.log(`  control builds stable:          ${ctrlStable ? 'PASS' : 'FAIL'}`);
console.log(`  correctness preserved (accel=2):${correct ? 'PASS' : 'FAIL'}`);
console.log(incremental
  ? '  -> outer layer reused across flaps; the re-arm-churn wiggle is gone.'
  : '  -> outer layer rebuilt every flap (full teardown); churn wiggle persists.');

await ctx.close();
server.close();
process.exit(flapped && incremental && ctrlStable && correct ? 0 : 1);
