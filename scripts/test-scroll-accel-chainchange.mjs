// Integration test for MID-GESTURE chain change (the "both hover states, scroll
// the outer" drift).
//
// A hover-activated inner scroller (QuickBase classic report grid: overlay
// scrollbar, overflow:hidden<->auto under :hover) is ridden as [inner, outer]
// (accel=2). Then the user scrolls the OUTER, which slides the report pane out
// from under the stationary cursor — the inner's :hover flips OFF mid-gesture,
// so the inner stops being a scroller and the armed chain goes stale. Because
// this happens WITHIN a continuous outer-scroll burst, the gesture-start
// re-detection (reconcileScrollAccelForScroller, gated on timer==null) is
// skipped: it only ran on the burst's first event, when the inner was still
// hovered. The recovery therefore depends on reconcileRead self-healing — re-arm
// to the remaining chain ([outer]) instead of disarming to the JS chase.
//
// Without the self-heal, reconcileRead disarms on the stale chain and the badge
// chases (wiggles) the rest of the outer scroll (accel=null until the ~100ms
// settle). With it, the badge re-arms to [outer] (accel=1) and keeps riding the
// compositor. This test drives the live extension through that exact sequence and
// measures DURING the burst (before settle), so it FAILS without the self-heal
// and PASSES with it.
//
// Run: npm run test:scroll-accel-chainchange

import { chromium } from 'playwright';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const EXT = resolve(root, 'dist/chrome');
const PROFILE = '/tmp/branchkit-chainchange-profile';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Same shape as the hover test: a report pane that is overflow:hidden at rest and
// :hover{overflow:auto} with a zero-width (overlay-equivalent) scrollbar, nested
// inside an outer scroller. Once hovered a link's chain is [report, outer].
const links = Array.from({ length: 30 }, (_, i) =>
  `<li><a href="#a${i}">cell ${String(i + 1).padStart(2, '0')}</a></li>`).join('\n');
const FIXTURE_HTML = `<!doctype html><html><head><title>mid-gesture chain change</title>
<style>
  #report { overflow: hidden; }
  #report:hover { overflow: auto; }
  #report::-webkit-scrollbar { width: 0; height: 0; }
</style></head>
<body style="font-family:sans-serif;margin:0;padding:20px;">
<div id="outer" style="height:380px;overflow:auto;border:2px solid #c00;">
  <div style="height:60px"></div>
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
  await chrome.storage.local.set({ alphabet: a, bkScrollAccelNested: true });
}, ALPHABET);

const page = await ctx.newPage();
await page.goto(FIXTURE, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => localStorage.setItem('bkOpenShadow', '1'));
await page.reload({ waitUntil: 'domcontentloaded' });
await sleep(6000);

const fail = async (msg) => { console.log('FAIL —', msg); await ctx.close(); server.close(); process.exit(1); };

const env = await page.evaluate(() => ({
  accel: document.documentElement.dataset.bkScrollAccel,
  nested: document.documentElement.dataset.bkScrollAccelNested,
  st: typeof ScrollTimeline !== 'undefined',
  hosts: document.querySelectorAll('[data-branchkit-hint]').length,
}));
console.log('env:', env);
if (env.accel !== 'on') await fail(`data-bk-scroll-accel="${env.accel}", expected "on"`);
if (env.nested !== 'on') await fail(`data-bk-scroll-accel-nested="${env.nested}", expected "on"`);
if (!env.st) await fail('ScrollTimeline unsupported in this Chromium');
if (env.hosts === 0) await fail('no badge hosts painted');

async function badgeFor(txt) {
  return page.evaluate((t) => {
    const target = [...document.querySelectorAll('#report a')].find((a) => a.textContent.trim() === t);
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
    if (!host) return { ok: false, reason: 'no host/inner' };
    const ir = inner.getBoundingClientRect();
    return {
      ok: true, bestD: Math.round(bestD), accel: host.getAttribute('data-bk-accel'),
      offset: Math.round(ir.top - tr.top),
      reportScroll: Math.round(document.getElementById('report').scrollTop),
      outerScroll: Math.round(document.getElementById('outer').scrollTop),
      reportOverflow: getComputedStyle(document.getElementById('report')).overflowY,
    };
  }, txt);
}

const TARGET = 'cell 02';

// (1) Arm [inner, outer]: hover the report (inner becomes scrollable) and scroll
// it once. The gesture-start re-detect arms the full chain. Let it settle so the
// next scroll begins a fresh burst (timer null) with accel=2 stable.
await page.locator('#report').hover();
await page.evaluate(() => document.getElementById('report').scrollBy(0, 18));
await sleep(250);
const armed = await badgeFor(TARGET);
console.log('armed [inner, outer]:', armed);
if (!armed.ok) await fail(`could not find target/badge: ${armed.reason}`);
if (armed.bestD > 80) await fail(`nearest badge ${armed.bestD}px from target — correlation unreliable`);
const armedOk = armed.accel === '2';
console.log(`  precondition (armed [inner,outer], accel=2): ${armedOk ? 'PASS' : 'FAIL'} (accel=${armed.accel})`);
if (!armedOk) await fail(`expected accel=2 after hover+inner-scroll, got ${armed.accel}`);

// (2) Start a CONTINUOUS outer-scroll burst. Event 1 fires while the inner is
// still hovered — gesture-start re-detect (timer null) sees [inner, outer], no
// change. This event sets the settle timer, so every later event in the burst is
// a continuation (timer non-null) and SKIPS the gesture-start re-detect.
await page.evaluate(() => document.getElementById('outer').scrollBy(0, 12));
await sleep(30);

// (3) Mid-burst, the inner's :hover flips OFF (the pane slid out from under the
// cursor — modeled here by moving the pointer away). The inner reverts to
// overflow:hidden, so the armed [inner, outer] chain is now stale. No reflow
// (overlay scrollbar) and no mutation, so nothing re-arms it yet.
await page.mouse.move(4, 4);

// (4) Keep the outer burst alive (< 100ms between events, so the settle never
// fires and the gesture-start re-detect stays skipped). Only reconcileRead can
// recover here — self-heal re-arms [outer]; without it, it disarms to the chase.
await page.evaluate(() => document.getElementById('outer').scrollBy(0, 12));
await sleep(30);
await page.evaluate(() => document.getElementById('outer').scrollBy(0, 12));
await sleep(40); // let the per-frame reconcile run; still < 100ms since last scroll

const mid = await badgeFor(TARGET);
console.log('mid-burst after inner :hover dropped (pre-settle):', mid);
if (mid.reportOverflow !== 'hidden') {
  await fail(`inner :hover did not drop (overflowY=${mid.reportOverflow}); pointer-move didn't unhover the report`);
}
// THE FIX: re-armed to [outer] (accel=1), still riding the compositor. Without
// the self-heal this is null — disarmed to the chase, wiggling the rest of the
// outer scroll until settle.
const reArmed = mid.ok && mid.accel === '1';
console.log(`  re-arms to [outer] mid-gesture (accel=1, not disarmed): ${reArmed ? 'PASS' : 'FAIL'} (accel=${mid.ok ? mid.accel : '?'})`);

// (5) Confirm it keeps tracking the outer scroll with a stable offset once
// re-armed (measured after settle, chain now stably [outer]).
await sleep(200);
const settled = await badgeFor(TARGET);
await page.evaluate(() => document.getElementById('outer').scrollBy(0, 40));
await sleep(300);
const tracked = await badgeFor(TARGET);
const tracks = settled.ok && tracked.ok && Math.abs(tracked.offset - settled.offset) <= 3;
console.log(`  tracks outer scroll once re-armed (offset ${settled.ok ? settled.offset : '?'}->${tracked.ok ? tracked.offset : '?'}): ${tracks ? 'PASS' : 'FAIL'}`);

await page.screenshot({ path: '/tmp/chainchange-accel.png' });
console.log('\nscreenshot: /tmp/chainchange-accel.png');
console.log('\n=== VERDICT ===');
console.log(`  precondition (armed accel=2):          ${armedOk ? 'PASS' : 'FAIL'}`);
console.log(`  re-arms to [outer] mid-gesture:        ${reArmed ? 'PASS' : 'FAIL'}`);
console.log(`  tracks outer once re-armed:            ${tracks ? 'PASS' : 'FAIL'}`);
if (!reArmed) console.log('  -> stale chain disarmed to the chase mid-gesture; badge wiggles the rest of the outer scroll.');

await ctx.close();
server.close();
process.exit(armedOk && reArmed && tracks ? 0 : 1);
