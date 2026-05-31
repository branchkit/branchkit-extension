// Reproduce the YouTube channel /featured → /videos wedge in Playwright Firefox.
//
// User-reported repro (2026-05-30): on stable Firefox, navigating from a
// channel /featured page to /videos via voice-clicked Videos tab freezes the
// page. Disabling the extension makes it fine — confirms wedge is in our code.
//
// Detection strategy: NEVER use page.evaluate() after the click. When the
// renderer wedges, Playwright's juggler pipe dies and every evaluate() hangs
// indefinitely regardless of timeout. Instead, do all observation via:
//   1. A pre-click sentinel stamped via evaluate (then never read back)
//   2. A post-click wait, then a take_screenshot (fails if renderer dead)
//   3. External read of the actuator.log breadcrumbs from the BranchKit app
//
// Run with the BranchKit app running so the alphabet arrives over SSE.

import { firefox } from 'playwright';
import { withExtension } from 'playwright-webextext/dist/factory.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, rmSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const EXT = resolve(root, 'dist/firefox');
const START = process.argv[2] || 'https://www.youtube.com/@MaxandOccy/featured';
const ACTUATOR_LOG = resolve(homedir(), 'Library/Application Support/BranchKitDev/actuator.log');

const profile = '/tmp/branchkit-ff-videos-wedge-profile';
if (existsSync(profile)) rmSync(profile, { recursive: true });
mkdirSync(profile, { recursive: true });

console.log('[1] launching Firefox Nightly with extension');
const ffWithExt = withExtension(firefox, EXT);
const ctx = await ffWithExt.launchPersistentContext(profile, {
  headless: false,
  viewport: { width: 1280, height: 900 },
});

const page = await ctx.newPage();
page.setDefaultTimeout(8000);
const consoleErrors = [];
page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
page.on('console', m => {
  if (m.type() === 'error') consoleErrors.push('console.error: ' + m.text());
});

console.log('[2] navigate to', START);
const navStart = Date.now();
try {
  await page.goto(START, { waitUntil: 'domcontentloaded', timeout: 60000 });
} catch (e) {
  console.log('   goto error:', e.message);
}
console.log('   nav took', Date.now() - navStart, 'ms');

console.log('[3] wait 8s for CS load + SSE alphabet + scan + paint');
await page.waitForTimeout(8000);

let before;
try {
  before = await page.evaluate(() => ({
    url: location.href,
    hosts: document.querySelectorAll('[data-branchkit-hint]').length,
    wrappers: document.documentElement.dataset.branchkitPerf
      ? JSON.parse(document.documentElement.dataset.branchkitPerf).wrapperCount
      : null,
  }), { timeout: 5000 });
  console.log('[4] before-click:', JSON.stringify(before));
} catch (e) {
  console.log('[4] before-click eval FAILED:', e.message);
  await ctx.close();
  process.exit(1);
}

if (!before.hosts) {
  console.log('FAIL — no badges painted on /featured. Is BranchKit app running?');
  await ctx.close();
  process.exit(1);
}

console.log('[5] mark Videos tab and grab its rect');
let videosTab;
try {
  videosTab = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('yt-tab-shape, [role="tab"]'));
    const el = candidates.find(c => {
      const t = (c.textContent || '').trim().toLowerCase();
      const a = (c.getAttribute('aria-label') || '').toLowerCase();
      return t === 'videos' || a.includes('videos');
    });
    if (!el) return null;
    el.setAttribute('data-bk-videos-tab', '1');
    return el.getBoundingClientRect().toJSON ? el.getBoundingClientRect().toJSON() : { x: el.getBoundingClientRect().x, y: el.getBoundingClientRect().y };
  }, { timeout: 5000 });
} catch (e) {
  console.log('   tab-find eval FAILED:', e.message);
  await ctx.close();
  process.exit(1);
}
console.log('   →', JSON.stringify(videosTab));
if (!videosTab) {
  console.log('FAIL — Videos tab not in DOM.');
  await ctx.close();
  process.exit(1);
}

// Capture actuator.log size BEFORE the click so we know where the relevant
// breadcrumbs begin.
const logSizeBeforeClick = statSync(ACTUATOR_LOG).size;
console.log('[6] actuator.log size before click:', logSizeBeforeClick, 'bytes');

console.log('[7] click Videos tab');
const clickStart = Date.now();
try {
  // Use locator click with a short timeout. Click itself shouldn't hang —
  // it's the post-click evals that hang on a wedged page.
  await page.locator('[data-bk-videos-tab]').click({ timeout: 5000 });
  console.log('   click dispatched in', Date.now() - clickStart, 'ms');
} catch (e) {
  console.log('   click error:', e.message);
}

// Wait without using evaluate. waitForTimeout uses the protocol but doesn't
// require the renderer to be responsive.
console.log('[8] wait 15s (no evaluate, just clock)');
await new Promise(r => setTimeout(r, 15000));

// Try a screenshot — if the renderer is alive, this succeeds. Doesn't need
// JS to run in the page.
console.log('[9] try screenshot (probes renderer liveness)');
let renderingAlive = false;
try {
  await page.screenshot({ path: '/tmp/branchkit-videos-wedge-after.png', timeout: 5000 });
  renderingAlive = true;
  console.log('   ✓ screenshot succeeded → renderer is alive');
} catch (e) {
  console.log('   ✗ screenshot FAILED →', e.message);
}

// Read actuator.log breadcrumbs that landed since the click.
console.log('[10] read actuator.log breadcrumbs since click');
const logText = readFileSync(ACTUATOR_LOG, 'utf8');
const newBytes = readFileSync(ACTUATOR_LOG, 'utf8').slice(logSizeBeforeClick);
const breadcrumbLines = newBytes.split('\n').filter(l =>
  l.includes('cs_nav_step') || l.includes('cs_firehose_step') || l.includes('cs_rescan_received') || l.includes('cs_scan_completed')
);
console.log(`   ${breadcrumbLines.length} breadcrumb lines since click:`);
for (const line of breadcrumbLines.slice(0, 50)) {
  const match = line.match(/\[pipeline\.([a-z_]+)\] (.+)$/);
  if (match) console.log('     ', match[1].padEnd(20), match[2]);
}

console.log('\n=== VERDICT ===');
if (renderingAlive) {
  console.log('  ✓ renderer responsive after click — wedge did NOT reproduce');
} else {
  console.log('  ✗ renderer unresponsive after click — wedge REPRODUCED');
}

// Check for proactive_detach breadcrumbs to confirm the fix path ran.
const detachFired = breadcrumbLines.some(l => l.includes('proactive_detach:start'));
const detachEnded = breadcrumbLines.some(l => l.includes('proactive_detach:end'));
console.log(`  proactive_detach:start fired: ${detachFired}`);
console.log(`  proactive_detach:end fired:   ${detachEnded}`);
const deferredFired = breadcrumbLines.some(l => l.includes('deferred_scan:start'));
const deferredEnded = breadcrumbLines.some(l => l.includes('deferred_scan:end'));
console.log(`  deferred_scan:start fired:    ${deferredFired}`);
console.log(`  deferred_scan:end fired:      ${deferredEnded}`);

if (consoleErrors.length) {
  console.log('\nconsole/page errors:');
  for (const e of consoleErrors.slice(0, 8)) console.log('  ', e);
}

console.log('\n[11] leaving browser open 10s for visual inspection');
await new Promise(r => setTimeout(r, 10000));
await ctx.close();
console.log('done.');
