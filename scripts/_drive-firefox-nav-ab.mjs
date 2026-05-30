// A/B driver: does a same-document YouTube SPA nav wedge Firefox because of OUR
// extension, or is it YouTube's own nav cost? Both arms use IDENTICAL
// instrumentation (page-injected watchdog + heartbeat) and the same nav, so the
// only variable is whether the extension is loaded.
//
//   BK_NAV_EXT=1 node _drive-firefox-nav-ab.mjs   # extension ON
//   node _drive-firefox-nav-ab.mjs                # control (no extension)
//
// Decisive metric: POST-NAV RECOVERY. The heartbeat (window.__beat) ticks every
// 100ms on the page's own main thread and SURVIVES a same-document nav. After
// the nav we poll the page with a fail-fast 4s read:
//   - reads keep returning + beat keeps advancing  => renderer stayed live
//   - reads time out / beat frozen for seconds      => main thread wedged
// The extension-ON nav previously wedged so hard Playwright lost the renderer
// for minutes. If the control wedges comparably, the cost is YouTube's, not ours.

import { firefox } from 'playwright';
import { withExtension } from 'playwright-webextext/dist/factory.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const WITH_EXT = process.env.BK_NAV_EXT === '1';
const EXT = resolve(root, 'dist/firefox');
const START = process.argv[2] || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const ARM = WITH_EXT ? 'EXTENSION-ON' : 'CONTROL (no extension)';

const profile = `/tmp/branchkit-ff-navab-${WITH_EXT ? 'ext' : 'control'}-profile`;
if (existsSync(profile)) rmSync(profile, { recursive: true });
mkdirSync(profile, { recursive: true });

const launcher = WITH_EXT ? withExtension(firefox, EXT) : firefox;
const ctx = await launcher.launchPersistentContext(profile, {
  headless: false,
  viewport: { width: 1280, height: 900 },
  firefoxUserPrefs: {
    'layout.css.anchor-positioning.enabled': false,
    'dom.min_background_timeout_value': 4,
  },
});

const page = await ctx.newPage();
page.setDefaultTimeout(4000); // fail fast: a wedged renderer must error, not hang

// Heartbeat + watchdog, installed before any page script and persisting across
// same-document navs (it lives on the window the SPA nav keeps).
await page.addInitScript(() => {
  window.__beat = 0;
  window.__wd = [];
  let last = performance.now();
  setInterval(() => { window.__beat++; }, 100);
  (function tick() {
    const now = performance.now();
    const delay = Math.max(0, now - (last + 250));
    if (delay > 100) { window.__wd.push(+delay.toFixed(0)); window.__wd.sort((a, b) => b - a); if (window.__wd.length > 12) window.__wd.length = 12; }
    last = now;
    setTimeout(tick, 250);
  })();
});

const errors = [];
page.on('pageerror', e => errors.push(e.message));

const read = () => page.evaluate(() => ({
  beat: window.__beat,
  wd: window.__wd ? window.__wd.slice() : [],
  url: location.href,
  perf: document.documentElement.dataset.branchkitPerf ? JSON.parse(document.documentElement.dataset.branchkitPerf) : null,
})).catch(e => ({ failed: String(e.message || e) }));

console.log(`\n=== ARM: ${ARM} ===`);
await page.goto(START, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => errors.push('goto: ' + e.message));
await page.waitForTimeout(9000);

const before = await read();
const hostsBefore = before.perf ? before.perf.wrapperCount : null;
console.log(`video A: beat=${before.beat} url-ok=${!!before.url} ${WITH_EXT ? 'wrappers=' + hostsBefore : ''}`);
if (before.failed) { console.log('FAIL — could not read video A:', before.failed); await ctx.close(); process.exit(1); }

const startUrl = before.url;
const curId = (startUrl.split('v=')[1] || '').split('&')[0];

// Scroll a touch so the recommendation rail lazy-loads, then click a different video.
await page.evaluate(() => window.scrollTo(0, 800)).catch(() => {});
await page.waitForTimeout(3000);
const clicked = await page.evaluate((cur) => {
  const links = Array.from(document.querySelectorAll('a[href*="/watch?v="]'));
  const target = links.find(a => { try { return (new URL(a.href).searchParams.get('v') || '') !== cur && a.href.includes('/watch?v='); } catch { return false; } });
  if (!target) return null;
  target.scrollIntoView({ block: 'center' });
  target.click();
  return target.href;
}, curId).catch(() => null);
console.log(`clicked -> ${clicked}`);
if (!clicked) { console.log('FAIL — no recommendation to click'); await ctx.close(); process.exit(1); }

// Poll post-nav. Track: first time URL changes, recovery latency, timed-out reads,
// beat advance, worst stalls.
const navT0 = Date.now();
let urlChangedAt = null, firstGoodAfterNav = null, timeouts = 0, reads = 0, last = before;
while (Date.now() - navT0 < 25000) {
  const t = Date.now();
  const s = await read();
  reads++;
  const lat = Date.now() - t;
  if (s.failed) { timeouts++; }
  else {
    last = s;
    if (s.url && s.url !== startUrl && urlChangedAt === null) urlChangedAt = Date.now() - navT0;
    if (urlChangedAt !== null && firstGoodAfterNav === null && lat < 3500) firstGoodAfterNav = Date.now() - navT0;
  }
  await new Promise(r => setTimeout(r, 800));
}

const beatDelta = (last.beat ?? before.beat) - before.beat;
console.log(`\n--- ${ARM}: post-nav (25s window) ---`);
console.log(`URL changed:           ${urlChangedAt !== null ? 'yes @ ' + urlChangedAt + 'ms' : 'NO'}  (${startUrl} -> ${last.url})`);
console.log(`reads timed out:       ${timeouts}/${reads}  (each cap 4s; high => renderer wedged)`);
console.log(`heartbeat advance:     ${beatDelta} ticks over the window  (expect ~250 if main thread free; near-0 => frozen)`);
console.log(`worst watchdog stalls: ${(last.wd && last.wd.length) ? last.wd.join('ms, ') + 'ms' : 'none>100ms (or unreadable)'}`);
if (WITH_EXT) console.log(`wrappers after:        ${last.perf ? last.perf.wrapperCount : 'unreadable'}`);
if (errors.length) console.log('page errors:', errors.slice(0, 4));

await ctx.close().catch(() => {});
