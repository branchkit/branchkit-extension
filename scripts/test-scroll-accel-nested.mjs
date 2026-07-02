// Integration test for the NESTED-scroller accelerator (flag bkScrollAccelNested).
//
// A target inside scroller-in-scroller needs every scroller in the chain ridden,
// not just the nearest. The nested path composes a ScrollTimeline per scroller via
// ADDITIVE transforms (composite:'add') on `outer` — the per-layer translateYs
// concatenate to -Σ scrollTop. Whether composite:'add' actually composes
// ScrollTimeline-driven transforms in Chromium was UNVERIFIED (the reason the flag
// is opt-in). This drives the live extension to settle it: if the OUTER scroll
// tracks, composite:'add' works; if it drifts, we must switch to nested layers.
//
// Run: npm run test:scroll-accel-nested  (or node scripts/test-scroll-accel-nested.mjs after build)

import { createServer } from 'node:http';
import { launchExtension } from './lib/launch.mjs';

const PROFILE = '/tmp/branchkit-nested-scroller-profile';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Links inside an INNER overflow pane (30 links overflow 200px), the inner pane
// inside an OUTER overflow pane (content overflows 380px). A link's scroller chain
// is [inner, outer] — both scroll.
const links = Array.from({ length: 30 }, (_, i) =>
  `<li><a href="#a${i}">pane link ${String(i + 1).padStart(2, '0')}</a></li>`).join('\n');
const FIXTURE_HTML = `<!doctype html><html><head><title>nested scroller accel</title></head>
<body style="font-family:sans-serif;margin:0;padding:20px;">
<div id="outer" style="height:380px;overflow:auto;border:2px solid #c00;">
  <div style="height:80px"></div>
  <div id="inner" style="height:200px;overflow:auto;border:2px solid #06c;">
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
  await chrome.storage.local.set({ alphabet: a, bkScrollAccelNested: true }); // <- enable nested
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
    const target = [...document.querySelectorAll('#inner a')].find((a) => a.textContent.trim() === t);
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
      innerScroll: Math.round(document.getElementById('inner').scrollTop),
      outerScroll: Math.round(document.getElementById('outer').scrollTop),
    };
  }, txt);
}

const TARGET = 'pane link 03';
const base = await badgeFor(TARGET);
console.log('baseline:', base);
if (!base.ok) await fail(`could not find target/badge: ${base.reason}`);
if (base.bestD > 80) await fail(`nearest badge ${base.bestD}px from target — correlation unreliable`);

// (1) chain detection: a target in scroller-in-scroller should ride BOTH (accel=2).
const chainOk = base.accel === '2';
console.log(`  chain detection (accel=2 for [inner,outer]): ${chainOk ? 'PASS' : 'FAIL'} (accel=${base.accel})`);

// (2) OUTER scroll tracks — the discriminating test for composite:'add'.
await page.evaluate(() => { document.getElementById('outer').scrollBy(0, 40); });
await sleep(500);
const afterOuter = await badgeFor(TARGET);
console.log('after OUTER scroll:', afterOuter);
const outerTracks = afterOuter.ok && Math.abs(afterOuter.offset - base.offset) <= 3;
console.log(`  tracks across OUTER scroll (composite:'add' composes): ${outerTracks ? 'PASS' : 'FAIL'} (offset ${base.offset}->${afterOuter.ok ? afterOuter.offset : '?'})`);

// (3) INNER scroll tracks too.
await page.evaluate(() => { document.getElementById('inner').scrollBy(0, 30); });
await sleep(500);
const afterInner = await badgeFor(TARGET);
console.log('after INNER scroll:', afterInner);
const innerTracks = afterInner.ok && Math.abs(afterInner.offset - base.offset) <= 3;
console.log(`  tracks across INNER scroll: ${innerTracks ? 'PASS' : 'FAIL'} (offset ${base.offset}->${afterInner.ok ? afterInner.offset : '?'})`);

await page.screenshot({ path: '/tmp/nested-scroller-accel.png' });
console.log('\nscreenshot: /tmp/nested-scroller-accel.png');
console.log('\n=== VERDICT ===');
console.log(`  chain detection (accel=2):     ${chainOk ? 'PASS' : 'FAIL'}`);
console.log(`  OUTER scroll tracks (add):     ${outerTracks ? 'PASS' : 'FAIL'}`);
console.log(`  INNER scroll tracks:           ${innerTracks ? 'PASS' : 'FAIL'}`);
if (!outerTracks) console.log('  -> composite:\'add\' does NOT compose ScrollTimeline transforms; switch to nested layers.');

await ctx.close();
server.close();
process.exit(chainOk && outerTracks && innerTracks ? 0 : 1);
