// Integration test that CONFIRMS the residual-wiggle theory via the re-arm counter
// diagnostic, and verifies nested is now default-on.
//
// The "slight wiggle when hovering the report but scrolling the outer page" is
// re-arm CHURN: the report's inner scroller is hover-gated (QuickBase classic
// report grid flips overflow:hidden<->auto under :hover), so as the outer scroll
// slides the pane under the cursor the inner's :hover flaps, the ridden chain
// flips [inner,outer] <-> [outer], and each flip re-arms the accelerator (a full
// teardown + rebuild of the compositor animations). Each re-arm bumps the badge's
// `data-bk-accel-rearms` counter.
//
// This test drives that exact flap and asserts the REPORT badge's re-arm counter
// climbs while a CONTROL badge (a link directly in the outer scroller, whose chain
// never flaps) stays flat — confirming the churn is real and localized to the
// hover-gated subtree. It also asserts `data-bk-scroll-accel-nested` is "on"
// WITHOUT setting the flag, proving the new default-on.
//
// Run: npm run test:scroll-accel-churn

import { createServer } from 'node:http';
import { launchExtension } from './lib/launch.mjs';

const PROFILE = '/tmp/branchkit-churn-profile';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A CONTROL link in the outer scroller's top band (rides [outer] only, never
// flaps), then the hover-gated report (overflow:hidden / :hover auto, overlay
// scrollbar) whose rows ride [report, outer] only while hovered.
const links = Array.from({ length: 30 }, (_, i) =>
  `<li><a href="#a${i}">cell ${String(i + 1).padStart(2, '0')}</a></li>`).join('\n');
const FIXTURE_HTML = `<!doctype html><html><head><title>re-arm churn</title>
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

const { ctx, sw } = await launchExtension({ profile: PROFILE });
const ALPHABET = 'arch bat cat dog echo fox golf hotel india jam kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu'.split(' ');
// NOTE: deliberately do NOT set bkScrollAccelNested — this verifies the default-on.
await sw.evaluate(async (a) => {
  await chrome.storage.sync.set({ aggressiveHints: true, hintVisibility: 'always' });
  await chrome.storage.local.set({ alphabet: a });
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
if (!env.st) await fail('ScrollTimeline unsupported in this Chromium');
if (env.hosts === 0) await fail('no badge hosts painted');

// (0) DEFAULT-ON: nested is "on" even though we never set bkScrollAccelNested.
const defaultOn = env.nested === 'on';
console.log(`  nested default-on (flag unset -> "on"): ${defaultOn ? 'PASS' : 'FAIL'} (nested=${env.nested})`);

// Correlate a target to its badge host by nearest painted .bk-inner; read the
// host's accel + re-arm counter attributes.
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
    };
  }, { sel, txt });
}

// (1) Arm [report, outer] on a report row by hovering + scrolling the inner.
await page.locator('#report').hover();
await page.evaluate(() => document.getElementById('report').scrollBy(0, 16));
await sleep(250);
const reportBase = await badgeFor('#report a', 'cell 03');
const ctrlBase = await badgeFor('#ctrl', null);
console.log('report baseline:', reportBase, '\ncontrol baseline:', ctrlBase);
if (!reportBase.ok) await fail(`report badge not found: ${reportBase.reason}`);
if (!ctrlBase.ok) await fail(`control badge not found: ${ctrlBase.reason}`);
if (reportBase.accel !== '2') await fail(`report not riding [inner,outer] (accel=${reportBase.accel}); fixture not arming nested`);

// (2) Flap the inner :hover while scrolling the outer (net-zero so both badges stay
// in view): each iteration unhovers->scroll (re-arm to [outer]) then hovers->scroll
// (re-arm to [inner,outer]). This is the pane-sliding-under-the-cursor churn.
const FLAPS = 6;
for (let i = 0; i < FLAPS; i++) {
  await page.mouse.move(5, 5);                                                   // unhover report
  await page.evaluate(() => document.getElementById('outer').scrollBy(0, 12));   // reconcile -> re-arm [outer]
  await sleep(45);
  await page.locator('#report').hover();                                         // re-hover report
  await page.evaluate(() => document.getElementById('outer').scrollBy(0, -12));  // reconcile -> re-arm [inner,outer]
  await sleep(45);
}

const reportAfter = await badgeFor('#report a', 'cell 03');
const ctrlAfter = await badgeFor('#ctrl', null);
console.log(`\nafter ${FLAPS} hover flaps:\n  report:`, reportAfter, '\n  control:', ctrlAfter);

const reportDelta = reportAfter.ok ? reportAfter.rearms - reportBase.rearms : -1;
const ctrlDelta = ctrlAfter.ok ? ctrlAfter.rearms - ctrlBase.rearms : -1;

// (3) Report badge churned (each flap is ~2 re-arms; allow slack), control did not.
const churned = reportDelta >= FLAPS;            // >= 1 re-arm per flap, conservative
const ctrlStable = ctrlDelta <= 1;               // an outer-only chain never flaps
console.log(`  report badge churns (rearm delta ${reportDelta} >= ${FLAPS}): ${churned ? 'PASS' : 'FAIL'}`);
console.log(`  control badge stable (rearm delta ${ctrlDelta} <= 1): ${ctrlStable ? 'PASS' : 'FAIL'}`);

await page.screenshot({ path: '/tmp/churn-accel.png' });
console.log('\nscreenshot: /tmp/churn-accel.png');
console.log('\n=== VERDICT ===');
console.log(`  nested default-on:              ${defaultOn ? 'PASS' : 'FAIL'}`);
console.log(`  report badge churns on flap:    ${churned ? 'PASS' : 'FAIL'} (delta ${reportDelta})`);
console.log(`  control badge does not churn:   ${ctrlStable ? 'PASS' : 'FAIL'} (delta ${ctrlDelta})`);
console.log(churned
  ? '  -> CONFIRMED: the residual wiggle is re-arm churn from the hover-gated inner scroller.'
  : '  -> re-arm churn NOT reproduced; the residual wiggle is something else.');

await ctx.close();
server.close();
process.exit(defaultOn && churned && ctrlStable ? 0 : 1);
