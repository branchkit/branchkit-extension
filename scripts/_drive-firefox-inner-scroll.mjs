// Phase 5b validation: does inner-pane scroll keep TargetRectStore warm?
//
// The window `scroll` listener never fires for an overflow container's scroll
// (`scroll` doesn't bubble), so before Phase 5b the engine's known rects for
// targets inside an inner pane went stale on inner-pane scroll — the badges
// still tracked visually (compositor nesting) but the store the positioning
// cutover will read from was wrong. Phase 5b registers one scroll listener per
// inner pane and writes fresh rects on scroll.
//
// This drives REAL Firefox on the nesting path (anchor positioning disabled,
// like stable/ESR), paints hints on an inner-scroll fixture, scrolls the PANE
// (not the window), and reads the store's drift sampler before/after:
//
//   - with Phase 5b:  scrollAncestors.containers >= 1 and post-scroll drift ~0
//   - pre-5b (BK_EXT pointing at an older build): drift jumps by the scroll dist
//
// Requires the BranchKit app running so the alphabet arrives over SSE and hints
// paint. A/B: BK_EXT=/path/to/old/dist/firefox node scripts/_drive-firefox-inner-scroll.mjs

import { firefox } from 'playwright';
import { withExtension } from 'playwright-webextext/dist/factory.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const EXT = process.env.BK_EXT ? resolve(process.env.BK_EXT) : resolve(root, 'dist/firefox');
const SCROLL_PX = Number(process.argv[2] || 120);

const fixtureHtml = readFileSync(resolve(root, 'test-fixtures/inner-scroll-hints.html'), 'utf8');
const server = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(fixtureHtml);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const FIXTURE = `http://127.0.0.1:${server.address().port}/`;

const profile = '/tmp/branchkit-ff-inner-scroll-profile';
if (existsSync(profile)) rmSync(profile, { recursive: true });
mkdirSync(profile, { recursive: true });

const ffWithExt = withExtension(firefox, EXT);
const ctx = await ffWithExt.launchPersistentContext(profile, {
  headless: false,
  viewport: { width: 800, height: 700 },
  firefoxUserPrefs: {
    // Force the nesting path: Playwright bundles Firefox Nightly which ships
    // CSS anchor positioning; real stable/ESR Firefox does not.
    'layout.css.anchor-positioning.enabled': false,
    'dom.min_background_timeout_value': 4,
  },
});

const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));

await page.goto(FIXTURE, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => errors.push('goto: ' + e.message));
await page.waitForTimeout(9000); // SSE alphabet + scan + paint

async function snap() {
  return page.evaluate(() => {
    // content.js runs in the isolated content-script world, so its
    // window.branchkitPerfStats isn't visible here (MAIN world). It mirrors
    // each 250ms snapshot onto a DOM dataset attribute, which any world reads.
    const raw = document.documentElement.dataset.branchkitPerf;
    const hosts = document.querySelectorAll('[data-branchkit-hint]').length;
    if (!raw) return { present: false, hosts };
    let p;
    try { p = JSON.parse(raw); } catch (e) { return { present: false, hosts, parseError: String(e) }; }
    return {
      present: true,
      hosts,
      anchored: document.querySelectorAll('[style*="anchor-name"]').length,
      store: p.targetRectStore,
      paneScrollTop: document.getElementById('pane')?.scrollTop ?? -1,
    };
  });
}

const before = await snap();
console.log('before scroll:', JSON.stringify(before));
if (errors.length) console.log('page errors:', errors.slice(0, 6));

if (!before.present || before.hosts === 0) {
  console.log('\nFAIL — no hints painted (hosts=' + before.hosts + '). App running? SSE alphabet arriving?');
  await ctx.close(); server.close(); process.exit(1);
}
if (before.anchored > 0) {
  console.log('\nWARN — anchored targets present (' + before.anchored + '); not the pure nesting path.');
}

// Scroll the INNER pane, not the window.
await page.evaluate((px) => { document.getElementById('pane').scrollTop = px; }, SCROLL_PX);
await page.waitForTimeout(800); // 5b rAF write + a couple of 250ms snapshot ticks

const after = await snap();
console.log('after inner scroll:', JSON.stringify(after));

console.log(`\n--- Phase 5b validation (REAL Firefox / nesting path, scrolled pane ${SCROLL_PX}px)  [EXT=${EXT}] ---`);
const sa = after.store?.scrollAncestors || { containers: 0, targets: 0 };
const sd = after.store?.scrollAncestorDrift || {};
console.log(`scroll-ancestors registered:  containers=${sa.containers} targets=${sa.targets}`);
console.log(`store size:                   before=${before.store?.size} after=${after.store?.size}`);
console.log(`ALL-store drift after scroll: sampled=${after.store?.drift?.sampled} drifted=${after.store?.drift?.drifted} maxPx=${after.store?.drift?.maxDriftPx} (mixes unpainted entries)`);
console.log(`SCOPED drift (registered):    before sampled=${before.store?.scrollAncestorDrift?.sampled} drifted=${before.store?.scrollAncestorDrift?.drifted} maxPx=${before.store?.scrollAncestorDrift?.maxDriftPx}`);
console.log(`                              after  sampled=${sd.sampled} drifted=${sd.drifted} maxPx=${sd.maxDriftPx}`);
console.log(`pane scrollTop:               before=${before.paneScrollTop} after=${after.paneScrollTop}`);

const registered = sa.containers >= 1;
const warm = (sd.maxDriftPx ?? 999) <= 2 && (sd.sampled ?? 0) >= 1;
const paneMoved = after.paneScrollTop > before.paneScrollTop;
if (registered && warm && paneMoved) {
  console.log(`\nPASS — inner pane registered (${sa.containers} container) and store stayed warm for all ${sd.sampled} painted targets (scoped maxDrift ${sd.maxDriftPx}px) through a ${SCROLL_PX}px inner scroll.`);
} else {
  console.log(`\nRESULT — registered=${registered} warm=${warm} paneMoved=${paneMoved}`);
  console.log('(pre-5b build expectation: registered=false, drift maxPx≈scroll distance)');
}

await page.screenshot({ path: '/tmp/firefox-inner-scroll.png' }).catch(() => {});
console.log('screenshot: /tmp/firefox-inner-scroll.png');
await ctx.close();
server.close();
