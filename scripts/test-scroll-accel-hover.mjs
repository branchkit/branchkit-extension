// Integration test for the HOVER-ACTIVATED-scroller accelerator gap.
//
// Some app shells reveal a scroller only on pointer hover: the container is
// `overflow:hidden` at rest and flips to `overflow:auto` under `:hover` (QuickBase
// classic report grids — div.EmbeddedReportContainer — do exactly this). A CSS
// `:hover` flip emits NO mutation and NO scroll until the user actually scrolls,
// so the settle-time `reconcileScrollAccel` never armed the inner scroller before
// the gesture. The badge then CHASES (wiggles) the entire first inner-scroll and
// only rides the compositor after the 100ms settle re-detects the chain.
//
// The fix re-detects the chain at scroll START, scoped to the scroller that just
// scrolled, so the inner scroller is ridden from the first frame. This test drives
// the live extension and asserts the badge rides the hover-revealed inner scroller
// well before the settle window — it FAILS without the fix (accel stuck at 1 until
// ~100ms) and PASSES with it (accel 2 within the first frames).
//
// Run: npm run test:scroll-accel-hover  (or node scripts/test-scroll-accel-hover.mjs after build)

import { createServer } from 'node:http';
import { launchExtension } from './lib/launch.mjs';

const PROFILE = '/tmp/branchkit-hover-scroller-profile';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 30 links inside a REPORT pane that is `overflow:hidden` at rest and only
// becomes scrollable on `:hover` (the QuickBase classic-report pattern). The
// report pane lives inside an OUTER overflow scroller, so once revealed a link's
// chain is [report, outer] — both scroll. At show the report is NOT a scroller
// (overflow:hidden), so the chain is just [outer] and the badge arms accel=1.
const links = Array.from({ length: 30 }, (_, i) =>
  `<li><a href="#a${i}">cell ${String(i + 1).padStart(2, '0')}</a></li>`).join('\n');
const FIXTURE_HTML = `<!doctype html><html><head><title>hover-activated scroller accel</title>
<style>
  /* The defining trait: a scroller that only exists under :hover. */
  #report { overflow: hidden; }
  #report:hover { overflow: auto; }
  /* Zero-width scrollbar = overlay-equivalent: the hidden->auto flip adds NO
     layout space, so it triggers no reflow and no ResizeObserver. This matches
     macOS overlay scrollbars (the user's real environment), where hover emits
     nothing observable until the actual scroll — the condition that defeats the
     settle-time re-detection. A classic space-taking scrollbar would reflow on
     hover and spuriously re-arm early, masking the bug. */
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

const { ctx, sw } = await launchExtension({ profile: PROFILE });
const ALPHABET = 'arch bat cat dog echo fox golf hotel india jam kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu'.split(' ');
await sw.evaluate(async (a) => {
  await chrome.storage.sync.set({ aggressiveHints: true, hintVisibility: 'always' });
  await chrome.storage.local.set({ alphabet: a, bkScrollAccelNested: true }); // nested: ride [report, outer]
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

// Correlate by the painted badge (.bk-inner), which rides the accelerator transform.
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
      targetTop: Math.round(tr.top), offset: Math.round(ir.top - tr.top),
      reportScroll: Math.round(document.getElementById('report').scrollTop),
      outerScroll: Math.round(document.getElementById('outer').scrollTop),
    };
  }, txt);
}

// Target a link in the visible top band of the report (not clipped at rest).
const TARGET = 'cell 02';
const base = await badgeFor(TARGET);
console.log('baseline (report overflow:hidden, not hovered):', base);
if (!base.ok) await fail(`could not find target/badge: ${base.reason}`);
if (base.bestD > 80) await fail(`nearest badge ${base.bestD}px from target — correlation unreliable`);

// (1) PRECONDITION: at rest the report is not a scroller, so the badge rides only
// the outer (accel=1). This establishes the gap the fix must close.
const preOk = base.accel === '1';
console.log(`  precondition (report not scrollable at rest, accel=1): ${preOk ? 'PASS' : 'FAIL'} (accel=${base.accel})`);
if (!preOk) await fail(`expected accel=1 at rest, got ${base.accel} — fixture not exercising the hover gap`);

// Reveal the inner scroller by hovering it (real pointer → triggers :hover).
await page.locator('#report').hover();
await sleep(150);
const hov = await badgeFor(TARGET);
console.log('after HOVER (no scroll yet):', hov);
// Hover alone emits no scroll/mutation, so nothing has re-armed: still accel=1.
console.log(`  hover alone does not arm (accel still 1): ${hov.accel === '1' ? 'as-expected' : 'note: armed early ('+hov.accel+')'}`);

// (2) THE FIX: scroll the report ONCE and measure BEFORE the 100ms settle window.
// Without the fix the inner scroller is armed only at settle, so at ~50ms the
// badge is still chasing (accel=1). With the fix it armed at scroll start (accel=2).
await page.evaluate(() => { document.getElementById('report').scrollBy(0, 24); });
await sleep(50); // < 100ms settle: discriminates scroll-start arm from settle arm
const early = await badgeFor(TARGET);
console.log('after FIRST report scroll (~50ms, pre-settle):', early);
const armedEarly = early.ok && early.accel === '2';
console.log(`  rides hover-revealed inner scroller from first frame (accel=2 pre-settle): ${armedEarly ? 'PASS' : 'FAIL'} (accel=${early.ok ? early.accel : '?'})`);

// (3) Once armed, the badge tracks further inner+outer scroll with a stable offset
// (composite:'add' over [report, outer]). Measured after settle.
await sleep(200);
const armed = await badgeFor(TARGET);
await page.evaluate(() => { document.getElementById('report').scrollBy(0, 30); document.getElementById('outer').scrollBy(0, 40); });
await sleep(300);
const tracked = await badgeFor(TARGET);
console.log('armed baseline:', armed, '\nafter inner+outer scroll:', tracked);
const tracks = armed.ok && tracked.ok && Math.abs(tracked.offset - armed.offset) <= 3;
console.log(`  tracks across inner+outer scroll once armed (offset ${armed.ok ? armed.offset : '?'}->${tracked.ok ? tracked.offset : '?'}): ${tracks ? 'PASS' : 'FAIL'}`);

await page.screenshot({ path: '/tmp/hover-scroller-accel.png' });
console.log('\nscreenshot: /tmp/hover-scroller-accel.png');
console.log('\n=== VERDICT ===');
console.log(`  precondition (accel=1 at rest):        ${preOk ? 'PASS' : 'FAIL'}`);
console.log(`  arms inner scroller pre-settle:        ${armedEarly ? 'PASS' : 'FAIL'}`);
console.log(`  tracks inner+outer once armed:         ${tracks ? 'PASS' : 'FAIL'}`);
if (!armedEarly) console.log("  -> hover-revealed scroller not ridden until settle; the badge chases (wiggles) the first gesture.");

await ctx.close();
server.close();
process.exit(preOk && armedEarly && tracks ? 0 : 1);
