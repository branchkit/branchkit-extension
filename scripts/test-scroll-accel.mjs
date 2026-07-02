// Integration repro for the late-loading-scroller accelerator drift.
//
// The inner-scroll accelerator (ScrollTimeline) arms when a badge is shown. If
// the badge's overflow scroll container is NOT scrollable yet at show time
// (content still loading), arming finds no scroller and the badge chases its
// target on the main thread forever — wiggling on an inner-pane scroll it should
// ride. The fix is level-triggered re-detection (reconcileScrollAccel on settle):
// once the pane becomes scrollable, the badge re-arms. happy-dom can't test this
// (no layout / no ScrollTimeline), so this drives the live extension in Chromium.
//
// Fixture: an overflow:auto pane with FEW links (fits -> not scrollable). After
// the extension paints, JS appends links so the pane overflows -> becomes
// scrollable. Asserts: (1) before, the in-pane badge is NOT accelerated (bug
// state); (2) after a settle, it IS accelerated (fix); (3) it tracks its target
// across an inner-pane scroll.
//
// Run from branchkit-extension/: node scripts/_test-late-scroller-accel.mjs
// (build dist/chrome first: npm run build:chrome)

import { createServer } from 'node:http';
import { launchExtension } from './lib/launch.mjs';

const PROFILE = '/tmp/branchkit-late-scroller-profile';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fewLinks = Array.from({ length: 5 }, (_, i) =>
  `<li><a href="#a${i}">pane link ${String(i + 1).padStart(2, '0')}</a></li>`).join('\n');
const FIXTURE_HTML = `<!doctype html><html><head><title>late scroller accel</title></head>
<body style="font-family:sans-serif;margin:0;padding:20px;">
<h1>header</h1>
<div id="scroller" style="height:200px;overflow:auto;border:2px solid #888;">
  <ul id="list" style="line-height:34px;font-size:18px;list-style:none;margin:0;padding:0 16px;">
  ${fewLinks}
  </ul>
</div>
<div style="height:1600px"></div>
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
  await chrome.storage.local.set({ alphabet: a });
}, ALPHABET);

const page = await ctx.newPage();
await page.goto(FIXTURE, { waitUntil: 'domcontentloaded' });
// Open the badge shadow root (test affordance) so we can measure the PAINTED
// badge, which rides the accelerator transform — the host's own rect does not.
// localStorage is shared with the CS isolated world; reload so a fresh CS reads it.
await page.evaluate(() => localStorage.setItem('bkOpenShadow', '1'));
await page.reload({ waitUntil: 'domcontentloaded' });
await sleep(6000); // scan + grammar round-trips + paint settle

const fail = async (msg) => { console.log('FAIL —', msg); await ctx.close(); server.close(); process.exit(1); };

// Precondition: accelerator on (default) + ScrollTimeline available in this build.
const env = await page.evaluate(() => ({
  accel: document.documentElement.dataset.bkScrollAccel,
  st: typeof ScrollTimeline !== 'undefined',
  hosts: document.querySelectorAll('[data-branchkit-hint]').length,
}));
console.log('env:', env);
if (env.accel !== 'on') await fail(`data-bk-scroll-accel is "${env.accel}", expected "on"`);
if (!env.st) await fail('ScrollTimeline unsupported in this Chromium — cannot test the accelerator');
if (env.hosts === 0) await fail('no badge hosts painted (storage/always-mode setup?)');

// Nearest body-mounted badge host to a link, by corner proximity. Returns its
// data-bk-accel attr (null = not accelerated) + the PAINTED badge's offset. The
// painted badge is `.bk-inner` inside the (test-opened) shadow root — its rect
// includes the accelerator's compositor transform, unlike the host's own rect.
async function badgeFor(txt) {
  return page.evaluate((t) => {
    const target = [...document.querySelectorAll('#scroller a')].find((a) => a.textContent.trim() === t);
    if (!target) return { ok: false, reason: 'target gone' };
    const tr = target.getBoundingClientRect();
    // Correlate by the PAINTED badge (inner), not the host: the body-mounted host
    // sits at docY0 (offset from the target by scrollTop when accelerated), so
    // host-proximity grabs the wrong badge once the pane is scrolled. The inner
    // is painted at the target's corner regardless.
    let host = null, inner = null, bestD = Infinity;
    for (const h of document.querySelectorAll('[data-branchkit-hint]')) {
      const bi = h.shadowRoot && h.shadowRoot.querySelector('.bk-inner');
      if (!bi) continue;
      const r = bi.getBoundingClientRect();
      const d = Math.hypot(r.left - tr.left, r.top - tr.top);
      if (d < bestD) { bestD = d; host = h; inner = bi; }
    }
    if (!host) return { ok: false, reason: 'no host/inner' };
    const sr = host.shadowRoot;
    const outer = sr && sr.querySelector('.bk-outer');
    const ir = inner ? inner.getBoundingClientRect() : null;
    const sc = document.getElementById('scroller');
    return {
      ok: true, bestD: Math.round(bestD), accel: host.getAttribute('data-bk-accel'),
      hasShadow: !!sr, targetTop: Math.round(tr.top),
      hostTop: Math.round(host.getBoundingClientRect().top),
      hostTf: host.style.transform,
      outerTop: outer ? Math.round(outer.getBoundingClientRect().top) : null,
      innerTop: ir ? Math.round(ir.top) : null,
      scrollTop: sc ? Math.round(sc.scrollTop) : null,
      offset: ir ? Math.round(ir.top - tr.top) : null,
    };
  }, txt);
}

const TARGET = 'pane link 03';
const before = await badgeFor(TARGET);
console.log('before (pane NOT scrollable):', before);
if (!before.ok) await fail(`could not find target/badge: ${before.reason}`);
if (!before.hasShadow) await fail('shadow not open — bkOpenShadow test affordance did not apply');
if (before.bestD > 80) await fail(`nearest badge ${before.bestD}px from target — correlation unreliable`);
const bugState = before.accel === null;
console.log(`  bug state (pane not scrollable -> badge NOT accelerated): ${bugState ? 'reproduced' : 'NO (accel=' + before.accel + ')'}`);

// Make the pane overflow -> becomes scrollable (the "content loaded late" event).
await page.evaluate(() => {
  const ul = document.getElementById('list');
  for (let i = 6; i <= 40; i++) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = '#a' + i; a.textContent = 'pane link ' + String(i).padStart(2, '0');
    li.appendChild(a); ul.appendChild(li);
  }
});
await page.evaluate(() => { window.scrollBy(0, 1); window.scrollBy(0, -1); }); // tick a settle
await sleep(900); // past the 100ms settle + reconcileScrollAccel re-detection

const paneScrollable = await page.evaluate(() => {
  const s = document.getElementById('scroller');
  return s.scrollHeight > s.clientHeight;
});
const after = await badgeFor(TARGET);
console.log('after (pane scrollable=' + paneScrollable + '):', after);
const fixWorks = after.ok && after.accel !== null;
console.log(`  FIX (re-detection accelerates the badge): ${fixWorks ? 'PASS' : 'FAIL'} (accel=${after.ok ? after.accel : '?'})`);

// Tracking: scroll the inner pane a little, the badge stays glued to its target.
await page.evaluate(() => { document.getElementById('scroller').scrollBy(0, 30); });
await sleep(500);
const tracked = await badgeFor(TARGET);
console.log('after inner-pane scroll:', tracked);
const tracks = tracked.ok && Math.abs(tracked.offset - after.offset) <= 3;
console.log(`  tracking across inner-pane scroll: ${tracks ? 'PASS' : 'FAIL'} (offset ${after.ok ? after.offset : '?'}->${tracked.ok ? tracked.offset : '?'})`);

await page.screenshot({ path: '/tmp/late-scroller-accel.png' });
console.log('\nscreenshot: /tmp/late-scroller-accel.png');
console.log('\n=== VERDICT ===');
console.log(`  bug state reproducible:      ${bugState}`);
console.log(`  FIX accelerates after load:  ${fixWorks ? 'PASS' : 'FAIL'}`);
console.log(`  tracks inner-pane scroll:    ${tracks ? 'PASS' : 'FAIL'}`);

await ctx.close();
server.close();
process.exit(fixWorks && tracks ? 0 : 1);
