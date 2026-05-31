// Measure the two observation-layer leaks (stale isInViewport + discovery
// gap) across scroll positions on a dense YouTube page, using the new
// programmatic snapshot hook. See memory/project_observation_layer_leaks.md
// and scripts/_snapshot.mjs.
//
// Run with the BranchKit app up and the (reloaded) extension build active.

import { firefox } from 'playwright';
import { withExtension } from 'playwright-webextext/dist/factory.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { captureSnapshot, classify } from './_snapshot.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const EXT = resolve(root, 'dist/firefox');
// A signed-out fresh profile has an EMPTY home feed ("Try searching to get
// started"), so default to search results — a dense video list regardless of
// login, which is what reproduces the lockup-row discovery gap.
const START = process.argv[2] || 'https://www.youtube.com/results?search_query=news';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = '/tmp/branchkit-ff-leak-measure-profile';
if (existsSync(profile)) rmSync(profile, { recursive: true });
mkdirSync(profile, { recursive: true });

async function measure(page, label) {
  const snap = await captureSnapshot(page);
  if (!snap) {
    console.log(`  ${label.padEnd(16)} (no snapshot — content script not present?)`);
    return null;
  }
  const c = classify(snap);
  const y = Math.round(snap.viewport?.scrollY ?? -1);
  console.log(
    `  ${label.padEnd(16)} y=${String(y).padStart(6)}  ` +
    `working=${String(c.working).padStart(3)}  ` +
    `staleInView=${String(c.staleInViewport).padStart(3)}  ` +
    `discoveryGap=${String(c.discoveryGap).padStart(3)}  ` +
    `claimGap=${String(c.claimGapInViewport).padStart(3)}  ` +
    `offscreenReleased=${String(c.offscreenReleased).padStart(3)}`,
  );
  return c;
}

console.log('[1] launching Firefox with extension');
const ffWithExt = withExtension(firefox, EXT);
const ctx = await ffWithExt.launchPersistentContext(profile, {
  headless: false,
  viewport: { width: 944, height: 1054 },
});
const page = await ctx.newPage();
page.setDefaultTimeout(8000);

console.log('[2] navigate', START);
try {
  await page.goto(START, { waitUntil: 'domcontentloaded', timeout: 60000 });
} catch (e) { console.log('   goto error:', e.message); }
await page.bringToFront();
await page.mouse.move(472, 300);
await page.mouse.click(472, 300);

console.log('[3] settle 8s (CS load + alphabet + scan + paint)\n');
await sleep(8000);

console.log('=== LEAK MEASUREMENT (scroll sweep) ===');
await measure(page, 'top');
await page.mouse.move(472, 500);
for (let step = 1; step <= 6; step++) {
  await page.mouse.wheel(0, Math.round(1054 * 1.2));
  await sleep(2500); // let discovery + IO settle after each scroll
  await measure(page, `+${step} vp`);
}

console.log('\n[4] scroll back to top (do stale badges from the top reappear / clean up?)');
await page.mouse.wheel(0, -100000);
await sleep(3000);
await measure(page, 'back-to-top');

console.log('\n[done] leaving window open 5s');
await sleep(5000);
await ctx.close();
console.log('closed.');
