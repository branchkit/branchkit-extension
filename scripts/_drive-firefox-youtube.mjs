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
  // A tall viewport is the lever that drives the visible-badge count up. The
  // scroll-reposition handler iterates `visible` (painted badges within the
  // viewport+200px band) and does a getBoundingClientRect per badge every
  // settle. At a default 720px viewport only ~76 land in-band; the real freeze
  // ran 400-1100. A ~2400px viewport widens the band ~3x so the soak actually
  // exercises the O(visible) cost path that bites at scale.
  viewport: { width: 1500, height: 2400 },
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
      // `hosts` ([data-branchkit-hint]) is one light-DOM host per PAINTED badge
      // — the set the scroll handler iterates and rect-reads each settle, so the
      // freeze cost scales with it. wrapperCount is the larger JS-object total.
      return {
        present: true,
        hosts,
        wrapperCount: p.wrapperCount,
        scanCalls: p.scanCalls,
        cpuPct: p.cpu?.share?.pct,
        reposMs: b['placeBadges:reposition']?.totalMs || 0,
        reposCount: b['placeBadges:reposition']?.count || 0,
        scrollMs: b['placeBadges:scroll']?.totalMs || 0,
        scrollCount: b['placeBadges:scroll']?.count || 0,
        longtaskCount: p.cpu?.longtask?.count,
        longtaskMax: p.cpu?.longtask?.maxMs,
        longtaskTotal: p.cpu?.longtask?.totalMs,
        stalls: p.cpu?.watchdog?.stalls || [],
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

// Progressive deep scroll, like a user reading a long comment thread. The
// original short soak reset to y=0 every 12000px, so YouTube never lazy-loaded
// the comment section beyond the first screen and only ~76 badges ever painted.
// To reproduce the heavy state (400-1100 visible badges, 1000+ wrappers) we
// keep descending and DWELL at each step: each pause lets YouTube fetch the
// next comment batch and lets the extension's scanner discover + paint the new
// interactive controls before we read counts. We never scroll back up, so the
// painted-badge set monotonically grows toward the freeze regime.
const start = Date.now();
let y = 0;
let peakHosts = before.hosts, peakWrappers = before.wrapperCount || 0;
while (Date.now() - start < SOAK_MS) {
  y += 1400;
  await page.evaluate((yy) => window.scrollTo(0, yy), y).catch(() => {});
  await page.waitForTimeout(450); // dwell: let comments lazy-load + scanner paint
  const s = await readPerf().catch(() => null);
  if (s?.present) {
    peakHosts = Math.max(peakHosts, s.hosts);
    peakWrappers = Math.max(peakWrappers, s.wrapperCount || 0);
  }
}
await page.waitForTimeout(600); // let the settle reposition fire

const after = await readPerf();
console.log('after soak: ', JSON.stringify(after));
console.log(`peak during soak: hosts=${peakHosts} wrappers=${peakWrappers} (final scrollY≈${y})`);

console.log('\n--- Analysis (' + SOAK_MS + 'ms scroll soak, REAL Firefox / nesting path) ---');
console.log(`hints painted:           ${after.hosts}  (peak ${peakHosts})`);
console.log(`wrappers (store.all):    ${after.wrapperCount}  (peak ${peakWrappers})`);
console.log(`cpu.share.pct:           before=${before.cpuPct}  after=${after.cpuPct}`);
console.log(`reposition fires (all):  Δ=${after.reposCount - before.reposCount}  (full-replace path)`);
console.log(`reposition CPU (all):    Δ=${(after.reposMs - before.reposMs).toFixed(1)}ms`);
console.log(`scroll-trim fires:       Δ=${after.scrollCount - before.scrollCount}  (drifted-scoped path)`);
console.log(`scroll-trim CPU:         Δ=${(after.scrollMs - before.scrollMs).toFixed(1)}ms over the soak`);
console.log(`longtasks:               before count=${before.longtaskCount}/max=${before.longtaskMax}ms; after count=${after.longtaskCount}/max=${after.longtaskMax}ms (Δtotal=${(after.longtaskTotal - before.longtaskTotal).toFixed(0)}ms)`);

console.log('\n--- Watchdog stalls (main-thread blocks; Firefox has no Long Tasks API) ---');
if (!after.stalls.length) {
  console.log('none recorded (no block exceeded the 100ms threshold)');
} else {
  for (const s of after.stalls) {
    const top = s.topLabels.map(t => `${t.label}=${t.ms}ms×${t.count}`).join(', ') || '(no instrumented marks)';
    const verdict = s.unattributedMs > s.trackedMs ? 'NOT-our-JS (browser render / page script)' : 'OUR-JS';
    console.log(`  stall ${s.delayMs}ms: tracked=${s.trackedMs}ms unattributed=${s.unattributedMs}ms → ${verdict}`);
    console.log(`    top: ${top}`);
  }
}

await page.screenshot({ path: '/tmp/firefox-youtube.png' }).catch(() => {});
console.log('\nscreenshot: /tmp/firefox-youtube.png');
await ctx.close();
