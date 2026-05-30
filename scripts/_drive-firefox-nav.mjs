// Real-Firefox driver for the SPA-nav reconcile check (restructure step 3).
//
// Loads the live dist/firefox extension into a real Firefox, opens a YouTube
// /watch page, lets badges paint, then performs an IN-APP (same-document)
// navigation to another video by clicking a recommendation thumbnail. It then
// verifies the PageSession.onUrlChange rescan path reconciled the new page
// WITHOUT a full document reload.
//
// Proof model:
//   - A window sentinel set before the nav must SURVIVE it. If it survives, the
//     JS context (content script) persisted => this was a same-document SPA nav,
//     not a full load. (A full load would wipe the sentinel and reset scanCalls.)
//   - scanCalls must INCREASE after the nav => the bounded `rescan` action ran
//     and reconciled the DOM (not the mutation firehose, which wouldn't bump
//     scanCalls the same way).
//   - hosts (painted badges) must be > 0 on the new page => grammar/badges
//     re-established for the new video's controls.
//
// Requires the BranchKit app running (SSE alphabet) so hints paint.

import { firefox } from 'playwright';
import { withExtension } from 'playwright-webextext/dist/factory.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const EXT = resolve(root, 'dist/firefox');
const START = process.argv[2] || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

const profile = '/tmp/branchkit-ff-nav-profile';
if (existsSync(profile)) rmSync(profile, { recursive: true });
mkdirSync(profile, { recursive: true });

const ffWithExt = withExtension(firefox, EXT);
const ctx = await ffWithExt.launchPersistentContext(profile, {
  headless: false,
  viewport: { width: 1280, height: 900 },
  firefoxUserPrefs: {
    'layout.css.anchor-positioning.enabled': false,
    'dom.min_background_timeout_value': 4,
  },
});

const page = await ctx.newPage();
// Fail fast: the new-page rescan can wedge Firefox's renderer, so a stuck
// evaluate must error in a few seconds, not hang on the 30s default.
page.setDefaultTimeout(5000);
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

async function readPerf() {
  return page.evaluate(() => {
    const raw = document.documentElement.dataset.branchkitPerf;
    const hosts = document.querySelectorAll('[data-branchkit-hint]').length;
    const sentinel = window.__bkNavSentinel;
    if (!raw) return { present: false, hosts, sentinel };
    try {
      const p = JSON.parse(raw);
      return { present: true, hosts, sentinel, wrapperCount: p.wrapperCount, scanCalls: p.scanCalls, url: location.href };
    } catch (e) { return { present: false, hosts, sentinel, parseError: String(e) }; }
  });
}

await page.goto(START, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => errors.push('goto: ' + e.message));
await page.waitForTimeout(9000); // CS load + SSE alphabet + scan + paint

const before = await readPerf();
console.log('video A:', JSON.stringify(before));
if (!before.present || before.hosts === 0) {
  console.log('\nFAIL — no hints painted on video A (hosts=' + (before?.hosts) + '). Is the BranchKit app running?');
  if (errors.length) console.log('page errors:', errors.slice(0, 6));
  await ctx.close();
  process.exit(1);
}

// Stamp a sentinel that only survives a same-document navigation.
const startUrl = before.url;
await page.evaluate(() => { window.__bkNavSentinel = 'alive-' + Date.now(); });
const stamped = (await readPerf()).sentinel;
console.log('sentinel stamped:', stamped);

// Trigger an in-app SPA nav: click a recommendation thumbnail. Scroll a touch
// first so the related rail lazy-loads, then click the first /watch link that
// points at a different video.
await page.evaluate(() => window.scrollTo(0, 800));
await page.waitForTimeout(3000);

const curId = (startUrl.split('v=')[1] || '').split('&')[0];
const clicked = await page.evaluate((cur) => {
  const links = Array.from(document.querySelectorAll('a[href*="/watch?v="]'));
  const seen = links.map(a => a.href).slice(0, 5);
  const target = links.find(a => {
    try {
      const id = (new URL(a.href).searchParams.get('v')) || '';
      return id && id !== cur;
    } catch { return false; }
  });
  if (!target) return { href: null, found: links.length, sample: seen };
  target.scrollIntoView({ block: 'center' });
  target.click();
  return { href: target.href, found: links.length, sample: seen };
}, curId).catch(e => { errors.push('click: ' + e.message); return { href: null, found: 0, sample: [] }; });

console.log('watch-links found:', clicked.found, 'sample:', JSON.stringify(clicked.sample));

console.log('clicked recommendation ->', clicked.href);

if (!clicked.href) {
  console.log('\nFAIL — could not find a recommendation thumbnail to click for the SPA nav.');
  await ctx.close();
  process.exit(1);
}

// POLL the perf snapshot right after the click. We must catch the reconcile in
// the window after the URL changes but before the heavy new-page scan saturates
// the renderer (which makes evaluate() time out). Each read fails fast (5s cap).
const safeRead = () => readPerf().catch(e => { errors.push('read: ' + e.message); return null; });
let after = before, urlSeenChanged = false;
const t0 = Date.now();
while (Date.now() - t0 < 20000) {
  await new Promise(r => setTimeout(r, 700));
  const s = await safeRead();
  if (s && s.present) {
    after = s;
    if (s.url && s.url !== startUrl) urlSeenChanged = true;
    if (urlSeenChanged && (s.scanCalls ?? 0) > (before.scanCalls ?? 0) && (s.hosts ?? 0) > 0) break;
  }
}
console.log('video B (last good):', JSON.stringify(after));

const sentinelSurvived = after.sentinel === stamped;
const urlChanged = after.url && after.url !== startUrl;
const scanned = (after.scanCalls ?? 0) > (before.scanCalls ?? 0);
const painted = (after.hosts ?? 0) > 0;

console.log('\n--- SPA-nav reconcile verdict (real Firefox) ---');
console.log(`URL changed:               ${urlChanged}  (${startUrl}  ->  ${after.url})`);
console.log(`same-document (sentinel):  ${sentinelSurvived}  (survived=${sentinelSurvived ? 'yes => SPA nav, CS persisted' : 'NO => full reload, not an SPA nav'})`);
console.log(`rescan ran (scanCalls):    ${scanned}  (${before.scanCalls} -> ${after.scanCalls})`);
console.log(`badges re-painted:         ${painted}  (hosts ${before.hosts} -> ${after.hosts}, wrappers ${before.wrapperCount} -> ${after.wrapperCount})`);

const pass = urlChanged && sentinelSurvived && scanned && painted;
console.log(`\nRESULT: ${pass ? 'PASS — same-document nav reconciled via the rescan path' : 'FAIL — see above'}`);
if (errors.length) console.log('page errors:', errors.slice(0, 6));

await page.screenshot({ path: '/tmp/firefox-nav.png' }).catch(() => {});
await ctx.close().catch(() => {});
process.exit(pass ? 0 : 1);
