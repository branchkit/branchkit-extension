// Real-Firefox driver for the YouTube /watch unresponsive-script repro.
//
// This is the verification we couldn't do before: drive a REAL Firefox (not a
// Chromium proxy) with the live dist/firefox extension loaded, navigate to the
// page that actually froze (YouTube /watch), and read the perf counters before
// and after a sustained scroll soak. Firefox has no CSS anchor() so it always
// runs the display:contents nesting path + the new scroll-reposition trim — the
// exact code path under test.
//
// Loading mechanism: playwright-webextext's withExtension() installs the add-on
// over Firefox's remote debugging protocol (installTemporaryAddon), which works
// where the profile-side-load approach did not. MV3 on Firefox requires
// launchPersistentContext, and dist/firefox/manifest.json already carries
// browser_specific_settings.gecko.id.
//
// Requires the BranchKit app running so the alphabet arrives over SSE and hints
// actually paint (the harness never seeds an alphabet on a remote page).

import { firefox } from 'playwright';
// Import the factory directly: the package index also re-exports a Playwright
// test fixture that requires @playwright/test (a peer we don't need here).
import { withExtension } from 'playwright-webextext/dist/factory.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
// BK_EXT points the driver at an alternate firefox build (e.g. a pre-trim
// worktree's dist/firefox) for A/B comparison; defaults to the current build.
const EXT = process.env.BK_EXT ? resolve(process.env.BK_EXT) : resolve(root, 'dist/firefox');
const URL = process.argv[2] || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const SOAK_MS = Number(process.argv[3] || 15000);

const profile = '/tmp/branchkit-ff-youtube-profile';
if (existsSync(profile)) rmSync(profile, { recursive: true });
mkdirSync(profile, { recursive: true });

const ffWithExt = withExtension(firefox, EXT);
const ctx = await ffWithExt.launchPersistentContext(profile, {
  headless: false,
  firefoxUserPrefs: {
    // Playwright bundles Firefox NIGHTLY, which now ships CSS anchor
    // positioning. That makes CSS.supports('anchor-name') true, so the
    // extension would take the fast-path — NOT the display:contents nesting
    // path that real-user (stable/ESR) Firefox runs and that actually froze.
    // Disable it so this run faithfully exercises the nesting path + scroll trim.
    'layout.css.anchor-positioning.enabled': false,
    // Keep Firefox from throttling background/occluded timers during the soak.
    'dom.min_background_timeout_value': 4,
  },
});

const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => errors.push('goto: ' + e.message));
// Content script load + app SSE alphabet + scan + paint.
await page.waitForTimeout(9000);

// Confirm path: anchor-mode badges set anchor-name on their target. Real Firefox
// should have zero (no anchor() support) → pure nesting path.
const anchored = await page.evaluate(() =>
  document.querySelectorAll('[style*="anchor-name"]').length).catch(() => 'n/a');
console.log(`anchored targets (want 0 for Firefox nesting path): ${anchored}  [EXT=${EXT}]`);

async function readPerf() {
  return page.evaluate(() => {
    const raw = document.documentElement.dataset.branchkitPerf;
    const hosts = document.querySelectorAll('[data-branchkit-hint]').length;
    if (!raw) return { present: false, hosts };
    try {
      const p = JSON.parse(raw);
      const b = p.cpu?.buckets || {};
      return {
        present: true,
        hosts,
        scanCalls: p.scanCalls,
        cpuPct: p.cpu?.share?.pct,
        reposMs: b['placeBadges:reposition']?.totalMs || 0,
        reposCount: b['placeBadges:reposition']?.count || 0,
        scrollMs: b['placeBadges:scroll']?.totalMs || 0,
        scrollCount: b['placeBadges:scroll']?.count || 0,
        longtaskCount: p.cpu?.longtask?.count,
        longtaskMax: p.cpu?.longtask?.maxMs,
        longtaskTotal: p.cpu?.longtask?.totalMs,
      };
    } catch (e) { return { present: false, hosts, parseError: String(e) }; }
  });
}

const before = await readPerf();
console.log('before soak:', JSON.stringify(before));
if (errors.length) console.log('page errors:', errors.slice(0, 6));

if (!before.present || before.hosts === 0) {
  console.log('\nFAIL — no hints painted (hosts=' + before.hosts + '). Extension loaded but no alphabet?');
  console.log('Is the BranchKit app running and is the content script connecting over SSE?');
  await ctx.close();
  process.exit(1);
}

// Sustained window scroll, like a user reading comments — this is what pegged
// the main thread in the original freeze.
const start = Date.now();
let y = 0;
while (Date.now() - start < SOAK_MS) {
  y += 600;
  await page.evaluate((yy) => window.scrollTo(0, yy), y).catch(() => {});
  await page.waitForTimeout(120);
  if (y > 12000) y = 0;
}
await page.waitForTimeout(600); // let the settle reposition fire

const after = await readPerf();
console.log('after soak: ', JSON.stringify(after));

console.log('\n--- Analysis (' + SOAK_MS + 'ms scroll soak, REAL Firefox / nesting path) ---');
console.log(`hints painted:           ${after.hosts}`);
console.log(`cpu.share.pct:           before=${before.cpuPct}  after=${after.cpuPct}`);
console.log(`reposition fires (all):  Δ=${after.reposCount - before.reposCount}  (full-replace path)`);
console.log(`reposition CPU (all):    Δ=${(after.reposMs - before.reposMs).toFixed(1)}ms`);
console.log(`scroll-trim fires:       Δ=${after.scrollCount - before.scrollCount}  (drifted-scoped path)`);
console.log(`scroll-trim CPU:         Δ=${(after.scrollMs - before.scrollMs).toFixed(1)}ms over the soak`);
console.log(`longtasks:               before count=${before.longtaskCount}/max=${before.longtaskMax}ms; after count=${after.longtaskCount}/max=${after.longtaskMax}ms (Δtotal=${(after.longtaskTotal - before.longtaskTotal).toFixed(0)}ms)`);

await page.screenshot({ path: '/tmp/firefox-youtube.png' }).catch(() => {});
console.log('\nscreenshot: /tmp/firefox-youtube.png');
await ctx.close();
