// Control for the watchdog-stall attribution: same YouTube /watch page, same
// scroll soak, but with NO extension loaded. A page-injected watchdog (a
// mirror of the extension's setTimeout-drift detector) measures YouTube's OWN
// main-thread stalls. Compare against _drive-firefox-youtube.mjs (extension on):
//
//   - control quiet + extension-on stalls  ⇒ the stalls are our injected DOM
//     (display:contents wrappers + badges) being laid out/painted by Firefox.
//   - control already stalls comparably     ⇒ the unattributed time is YouTube's
//     own scroll work (lazy comment load, video), not something our fix can cut.
//
// Plain Playwright Firefox (no withExtension) so the page is pristine.

import { firefox } from 'playwright';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const URL = process.argv[2] || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const SOAK_MS = Number(process.argv[3] || 60000);

const profile = '/tmp/branchkit-ff-control-profile';
if (existsSync(profile)) rmSync(profile, { recursive: true });
mkdirSync(profile, { recursive: true });

const ctx = await firefox.launchPersistentContext(profile, {
  headless: false,
  firefoxUserPrefs: { 'dom.min_background_timeout_value': 4 },
});

const page = await ctx.newPage();

// Same watchdog as telemetry/perf-counters.ts: a self-rescheduling 250ms
// setTimeout records how late it fires (= main-thread block time) while the
// tab is visible, keeping the worst stalls.
await page.addInitScript(() => {
  const INTERVAL = 250, THRESH = 100;
  const stalls = [];
  let last = performance.now();
  let visPrev = document.visibilityState === 'visible';
  window.__ctrlStalls = stalls;
  function tick() {
    const now = performance.now();
    const vis = document.visibilityState === 'visible';
    if (vis && visPrev) {
      const delay = Math.max(0, now - (last + INTERVAL));
      if (delay > THRESH) {
        stalls.push(+delay.toFixed(1));
        stalls.sort((a, b) => b - a);
        if (stalls.length > 12) stalls.length = 12;
      }
    }
    last = now; visPrev = vis;
    setTimeout(tick, INTERVAL);
  }
  setTimeout(tick, INTERVAL);
});

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(9000);

const start = Date.now();
let y = 0;
while (Date.now() - start < SOAK_MS) {
  y += 600;
  await page.evaluate((yy) => window.scrollTo(0, yy), y).catch(() => {});
  await page.waitForTimeout(120);
  if (y > 12000) y = 0;
}
await page.waitForTimeout(600);

const stalls = await page.evaluate(() => window.__ctrlStalls || []);
console.log(`\n--- CONTROL (no extension, ${SOAK_MS}ms scroll soak, YouTube /watch) ---`);
console.log(`worst stalls (>100ms blocks): ${stalls.length ? stalls.join('ms, ') + 'ms' : 'none'}`);
console.log('(compare to extension-on run: 286/131/102ms. control quiet ⇒ stalls are our DOM)');
await ctx.close();
