// Integration test for the NESTED-WRAPPER compositor model: when a hover-gated
// inner scroller flaps during an outer scroll, the OUTERMOST layer (the page-scroll
// element `.bk-outer`, the one the user is actually dragging) must NEVER be torn
// down and rebuilt — only the inner wrapper is. That untouched outer layer is what
// keeps the outer scroll on the compositor / smooth.
//
// Each layer's animation carries a monotonic id (`bk-accel-<n>`). The discriminator:
// the `.bk-outer` animation id stays CONSTANT across inner hover flaps (outer layer
// reused), while `data-bk-accel-builds` climbs (inner wrapper rebuilt each flap).
// A full teardown (the old approach) would rebuild the outer layer too, changing its
// id every flap — which this test FAILS on (verified by temporarily forcing it).
//
// NOTE: this proves the outer layer isn't rebuilt, the structural prerequisite for
// smoothness. Whether `composite:'replace'` per nested element actually stays on the
// compositor (vs the old `composite:'add'` main-thread fallback) can only be judged
// in real Chrome — see the user-facing test step.
//
// Run: npm run test:scroll-accel-stability

import { chromium } from 'playwright';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const EXT = resolve(root, 'dist/chrome');
const PROFILE = '/tmp/branchkit-stability-profile';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const links = Array.from({ length: 30 }, (_, i) =>
  `<li><a href="#a${i}">cell ${String(i + 1).padStart(2, '0')}</a></li>`).join('\n');
const FIXTURE_HTML = `<!doctype html><html><head><title>nested-wrapper stability</title>
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
  await chrome.storage.local.set({ alphabet: a }); // nested default-on
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

// Correlate a target to its badge host, and read the OUTERMOST layer's anim id off
// `.bk-outer` (open shadow) plus host counters + offset.
async function badgeFor(sel, txt) {
  return page.evaluate(({ sel, txt }) => {
    const target = txt
      ? [...document.querySelectorAll(sel)].find((a) => a.textContent.trim() === txt)
      : document.querySelector(sel);
    if (!target) return { ok: false, reason: 'target gone' };
    const tr = target.getBoundingClientRect();
    let host = null, inner = null, bestD = Infinity;
    for (const h of document.querySelectorAll('[data-branchkit-hint]')) {
      const bi = h.shadowRoot && h.shadowRoot.querySelector('.bk-inner');
      if (!bi) continue;
      const r = bi.getBoundingClientRect();
      const d = Math.hypot(r.left - tr.left, r.top - tr.top);
      if (d < bestD) { bestD = d; host = h; inner = bi; }
    }
    if (!host) return { ok: false, reason: 'no host' };
    const outerEl = host.shadowRoot.querySelector('.bk-outer');
    const outerAnims = outerEl ? outerEl.getAnimations().filter((a) => (a.id || '').startsWith('bk-accel-')) : [];
    const ir = inner.getBoundingClientRect();
    return {
      ok: true, bestD: Math.round(bestD),
      accel: host.getAttribute('data-bk-accel'),
      builds: Number(host.getAttribute('data-bk-accel-builds') || 0),
      outerAnimId: outerAnims[0] ? outerAnims[0].id : null,
      offset: Math.round(ir.top - tr.top),
    };
  }, { sel, txt });
}

// Arm [report, outer] on a report row.
await page.locator('#report').hover();
await page.evaluate(() => document.getElementById('report').scrollBy(0, 16));
await sleep(250);
const base = await badgeFor('#report a', 'cell 03');
const ctrlBase = await badgeFor('#ctrl', null);
console.log('report baseline:', base, '\ncontrol baseline:', ctrlBase);
if (!base.ok || !ctrlBase.ok) await fail('badge(s) not found');
if (base.accel !== '2') await fail(`report not riding [inner,outer] (accel=${base.accel})`);
if (!base.outerAnimId) await fail('no .bk-outer animation found (outermost layer not animating)');

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

const after = await badgeFor('#report a', 'cell 03');
const ctrlAfter = await badgeFor('#ctrl', null);
console.log(`\nafter ${FLAPS} flaps:\n  report:`, after, '\n  control:', ctrlAfter);
if (!after.ok) await fail('report badge lost after flaps');

// (1) THE GUARANTEE: the outermost (.bk-outer) layer's animation id is UNCHANGED —
// the page-scroll layer was reused, never torn down, across every flap.
const outerReused = after.outerAnimId === base.outerAnimId;
console.log(`  outermost layer reused (anim id ${base.outerAnimId} == ${after.outerAnimId}): ${outerReused ? 'PASS' : 'FAIL'}`);

// (2) The inner wrapper genuinely flapped (builds climbed ~1 per flap).
const flapped = (after.builds - base.builds) >= FLAPS;
console.log(`  inner wrapper rebuilt per flap (builds +${after.builds - base.builds} >= ${FLAPS}): ${flapped ? 'PASS' : 'FAIL'}`);

// (3) Correctness preserved through the flaps.
const correct = after.accel === '2' && Math.abs(after.offset - base.offset) <= 3;
console.log(`  still rides [inner,outer], offset stable (${base.offset}->${after.offset}): ${correct ? 'PASS' : 'FAIL'}`);

// (4) Control badge (single [outer] layer) outer id never changes either.
const ctrlReused = ctrlAfter.ok && ctrlAfter.outerAnimId === ctrlBase.outerAnimId;
console.log(`  control outer layer reused: ${ctrlReused ? 'PASS' : 'FAIL'}`);

await page.screenshot({ path: '/tmp/stability-accel.png' });
console.log('\nscreenshot: /tmp/stability-accel.png');
console.log('\n=== VERDICT ===');
console.log(`  outermost (page-scroll) layer reused: ${outerReused ? 'PASS' : 'FAIL'}`);
console.log(`  inner wrapper rebuilt per flap:       ${flapped ? 'PASS' : 'FAIL'}`);
console.log(`  correctness preserved:                ${correct ? 'PASS' : 'FAIL'}`);
console.log(`  control layer reused:                 ${ctrlReused ? 'PASS' : 'FAIL'}`);
console.log(outerReused
  ? "  -> the page-scroll layer is never torn down on inner flaps; outer scroll stays on the compositor."
  : "  -> the outer layer was rebuilt on a flap; outer scroll would hitch.");

await ctx.close();
server.close();
process.exit(outerReused && flapped && correct && ctrlReused ? 0 : 1);
