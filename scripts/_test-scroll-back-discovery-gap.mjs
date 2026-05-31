// Reproduce the YouTube scroll-back MISSING-BADGE gap (user-reported 2026-05-31:
// "two videos that don't look like they're even being captured as a link").
//
// This is NOT the placement strand (that was the anchor viewport-floor, fixed
// d35201a). Here whole tiles get NO wrapper at all after scroll-back. From the
// real signed-in snapshot the signature was: an entire grid row of in-viewport
// video tiles whose title <a href=/watch> is matchesHintable:true but
// isHinted:false, with zero wrapper — a discovery gap, not placement, not pool
// exhaustion (41/676 claimed), not build staleness.
//
// Mechanism class (from code read): discovery is edge-triggered. On scroll-back
// YouTube virtualizes/re-renders rows; the doc MutationObserver can drop/coalesce
// the records under the storm, and the lone backstop — scheduleBandDiscovery,
// fired once per scroll-settle, single-flight with NO trailing re-arm — can race
// the re-render or coalesce-and-drop a request that arrives mid-sweep. Either way
// a row that lands after the sweep, with no subsequent scroll, is never swept.
//
// This repro drives a real channel /videos grid (the discovery layer is plain JS,
// engine-agnostic — Chromium is fine and needs no running app: we seed the
// alphabet + always-mode directly like _test-band-discovery.mjs). It measures the
// exact snapshot signature before and after a scroll-down→back-up, then runs an
// EXTRA tiny scroll-and-back as an A-vs-B discriminator:
//   - if the extra settle CLEARS the gap  -> the content was present, the first
//     sweep just missed it (race / coalesced drop) = cause (A), fixable by a
//     trailing re-arm on scheduleBandDiscovery.
//   - if the extra settle does NOT clear it -> the band sweep itself cannot see
//     these nodes (dropped records + deeper state) = cause (B), needs the
//     level-triggered lifecycle reconcile.
//
// IMPORTANT — where it actually bites: the user's snapshot was the SIGNED-IN
// home feed (frame_url https://www.youtube.com/), a personalized infinite-scroll
// grid that churns far harder than a channel /videos page. Signed-out, the home
// feed is a sign-in wall (no grid at all) and a channel /videos grid renders the
// right markup but did NOT trip the race in repeated runs. So to reproduce
// faithfully you must run against a SIGNED-IN session:
//
//   1) BK_KEEP_PROFILE=1 BK_LOGIN=1 node scripts/_test-scroll-back-discovery-gap.mjs https://www.youtube.com/
//      -> browser opens, pauses for you to sign in, profile persists at PROFILE.
//   2) BK_KEEP_PROFILE=1 node scripts/_test-scroll-back-discovery-gap.mjs https://www.youtube.com/
//      -> reuses the signed-in profile and runs the scroll-back measurement.
//
// Usage: node scripts/_test-scroll-back-discovery-gap.mjs [url]
//   default url = a channel /videos grid (signed-out smoke); pass the home feed
//   URL for the real, signed-in repro. (build first: npm run build)
//
//   env BK_KEEP_PROFILE=1  do NOT wipe the persistent profile (keep a sign-in)
//   env BK_LOGIN=1         pause 90s after first load so you can sign in

import { chromium } from 'playwright';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, rmSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const EXT = resolve(root, 'dist/chrome');
const START = process.argv[2] || 'https://www.youtube.com/@mkbhd/videos';
const PROFILE = '/tmp/branchkit-scroll-back-discovery-profile';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const fail = (msg) => { failed = true; console.log('  FAIL —', msg); };
const pass = (msg) => console.log('  ok  —', msg);

const KEEP_PROFILE = process.env.BK_KEEP_PROFILE === '1';
const LOGIN = process.env.BK_LOGIN === '1';
if (!KEEP_PROFILE && existsSync(PROFILE)) rmSync(PROFILE, { recursive: true });

console.log('[1] launch Chromium with extension');
const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  viewport: { width: 944, height: 1054 }, // match the user's snapshot viewport
  args: ['--disable-extensions-except=' + EXT, '--load-extension=' + EXT],
});

// Seed alphabet + always-mode so badges paint on tab focus without the app.
const ALPHABET = ('air bat cat dog echo fox golf hotel india jam kilo lima mike '
  + 'november oscar papa quebec romeo sierra tango uniform victor whiskey xray '
  + 'yankee zulu').split(' ');
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
await sw.evaluate(async (a) => {
  await chrome.storage.sync.set({ aggressiveHints: true, hintVisibility: 'always' });
  await chrome.storage.local.set({ alphabet: a });
}, ALPHABET);

const page = await ctx.newPage();
page.setDefaultTimeout(15000);

console.log('[2] navigate to', START);
try {
  await page.goto(START, { waitUntil: 'domcontentloaded', timeout: 60000 });
} catch (e) {
  console.log('   goto error:', e.message);
}

// Best-effort consent dismiss (EU cookie wall); harmless in US.
try {
  const consent = page.locator('button[aria-label*="Accept"], button:has-text("Accept all")').first();
  if (await consent.count()) { await consent.click({ timeout: 3000 }); }
} catch { /* none */ }

if (LOGIN) {
  console.log('[3a] BK_LOGIN=1 — sign in now; resuming in 90s (profile persists if BK_KEEP_PROFILE=1)');
  await page.waitForTimeout(90000);
  await page.goto(START, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
}

console.log('[3] wait 8s for CS load + scan + paint');
await page.waitForTimeout(8000);

// Pull the full debug snapshot synchronously via the CustomEvent hook.
async function snap() {
  return await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('__branchkit__capture_snapshot'));
    return JSON.parse(document.documentElement.dataset.branchkitSnapshot);
  });
}

// A "video tile title link" is the per-tile signal: tag a, href /watch, the
// ytLockupMetadataViewModelTitle anchor. Count hintable-vs-hinted among the
// in-viewport ones (captureDomSurvey already clips to the viewport).
function titleLinks(s) {
  return (s.dom_survey || []).filter((e) =>
    e.tag === 'a'
    && ((e.className || '').includes('ytLockupMetadataViewModelTitle')
      || (e.href || '').startsWith('/watch')));
}
function gapReport(s) {
  const links = titleLinks(s);
  const hintable = links.filter((e) => e.matchesHintable);
  const missing = hintable.filter((e) => !e.isHinted);
  return { total: links.length, hintable: hintable.length, missing };
}
function printRows(missing) {
  for (const e of missing) {
    console.log(`        miss y=${e.rect.y} x=${e.rect.x}  ${(e.accessibleName || '').slice(0, 48)}`);
  }
}

console.log('[4] baseline at top');
let s = await snap();
let g = gapReport(s);
console.log(`    title links in viewport: ${g.total}  hintable: ${g.hintable}  missing(hintable&unhinted): ${g.missing.length}`);
printRows(g.missing);
if (g.hintable === 0) {
  fail('no hintable title links at baseline — grid not rendered / scan not running (signed-out wall?)');
  await finish();
}
const baselineMissing = g.missing.length;

// Human-like wheel scrolling drives YouTube's lazy virtualization (and our IO +
// scroll-settle debounce) far more faithfully than scrollTo jumps.
await page.mouse.move(472, 527);
console.log('[5] wheel DOWN deep (drive virtualization), brief pauses so rows lazy-load');
for (let i = 0; i < 40; i++) {
  await page.mouse.wheel(0, 900);
  await sleep(120);
}
await sleep(800);

console.log('[6] wheel BACK UP to the top fast (race the single scroll-settle sweep)');
for (let i = 0; i < 60; i++) {
  await page.mouse.wheel(0, -1400);
  await sleep(20);
}
await page.evaluate(() => window.scrollTo(0, 0));
await sleep(2000); // > scroll debounce(100) + idle sweep(<=500) + reconcile + paint

console.log('[7] measure the gap after scroll-back');
s = await snap();
g = gapReport(s);
console.log(`    title links in viewport: ${g.total}  hintable: ${g.hintable}  missing(hintable&unhinted): ${g.missing.length}`);
printRows(g.missing);
const afterMissing = g.missing.length;

const reproduced = afterMissing > baselineMissing && afterMissing > 0;
if (reproduced) {
  console.log(`  >> GAP REPRODUCED: ${baselineMissing} -> ${afterMissing} in-viewport hintable tiles with no badge`);
} else {
  console.log(`  >> gap not reproduced this run (baseline ${baselineMissing}, after ${afterMissing})`);
}

console.log('[8] A-vs-B discriminator: extra tiny scroll-and-back forces one more clean band sweep');
await page.evaluate(() => window.scrollTo(0, 120));
await sleep(200);
await page.evaluate(() => window.scrollTo(0, 0));
await sleep(2000);
s = await snap();
g = gapReport(s);
console.log(`    after extra settle — missing: ${g.missing.length}`);
printRows(g.missing);

console.log('\n=== VERDICT ===');
if (!reproduced) {
  console.log('  (inconclusive) the missing-badge gap did not reproduce this run — rerun, or the');
  console.log('  channel/network rendered differently. The signature to watch is step [7] missing > 0.');
} else if (g.missing.length < afterMissing) {
  console.log('  CAUSE (A): an extra scroll-settle CLEARED the gap. The tiles were present all along;');
  console.log('  the first post-scroll sweep raced/coalesced past them. A trailing re-arm on');
  console.log('  scheduleBandDiscovery (re-run once if a request arrived mid-sweep) should fix it.');
  failed = true; // the gap existed at step [7] => production bug present
} else {
  console.log('  CAUSE (B): even an extra clean sweep did NOT find these tiles. The band sweep cannot');
  console.log('  see them (dropped records + deeper state) — needs the level-triggered lifecycle');
  console.log('  reconcile, not just a re-armed sweep.');
  failed = true;
}

await page.screenshot({ path: '/tmp/branchkit-scroll-back-discovery-gap.png' });
console.log('\n[9] leaving browser open 8s for visual inspection');
await sleep(8000);
await finish();

async function finish() {
  await ctx.close();
  process.exit(failed ? 1 : 0);
}
