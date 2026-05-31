// Confirm-or-kill the active-tab-gate theory for missing badges.
//
// Theory (see the yesterday-commits investigation): commit 7270943
// ("scope grammar push to the active tab") added `if (!getTabActive())
// return` at the top of processScanBatch. When the SW's active-tab gate
// (background.ts:1026) rejects a focused tab's push with `inactive`,
// content flips tabActive=false. It's sticky — only a `reactivate`
// message clears it, and republishForActivation re-queues only wrappers
// that ALREADY hold a codeword. If that flip happens on a tab the user
// believes is foreground, the scan-path claim goes silent and visible
// links lose their badges.
//
// This harness reads the perf snapshot the content script mirrors to
// document.documentElement.dataset.branchkitPerf (250ms cadence), which
// now carries the diagnostic fields wired in alongside this script:
//   tabActive               — false on a foreground tab = the bug
//   tabActiveDeactivations  — true→false flips since CS load
//   claim.scanBatchGatedSkips — processScanBatch early-returns on !tabActive
//   claim.scanPathClaimed   — codewords from the full-page scan path
//   claim.trackerPathClaimed— codewords from the viewport IntersectionTracker
//   inViewportWrappers / inViewportWithCodeword — the direct symptom ratio
//
// Two scenarios:
//   [WITHIN-BROWSER] tab A → tab B → back to A. Exercises onActivated and
//     the reactivate/republish recovery path. Reproducible in pure
//     Playwright.
//   [CROSS-WINDOW] two Firefox windows; toggle OS focus between them.
//     Closer to the real "Firefox + Firefox Nightly" report, where focus
//     moves at the window/app level (onFocusChanged), and recovery only
//     fires when hintVisibility==='always' AND the active tab changed.
//
// Run with the BranchKit app running + a real window focused so the SW
// gate and plugin focus handshake are live. NOTE: a faithful cross-bundle
// repro (Firefox vs Firefox Nightly) needs two distinct browser bundles;
// Playwright launches one bundle, so the CROSS-WINDOW pass approximates it
// with two windows of the same bundle. See the printed Tier-2 steps.

import { firefox } from 'playwright';
import { withExtension } from 'playwright-webextext/dist/factory.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const EXT = resolve(root, 'dist/firefox');
const START = process.argv[2] || 'https://www.youtube.com/results?search_query=astronomy';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freshProfile(tag) {
  const p = `/tmp/branchkit-ff-active-tab-${tag}-profile`;
  if (existsSync(p)) rmSync(p, { recursive: true });
  mkdirSync(p, { recursive: true });
  return p;
}

// Reads the perf snapshot dataset the content script publishes every 250ms.
const probe = () => {
  let perf = null;
  try { perf = JSON.parse(document.documentElement.dataset.branchkitPerf || 'null'); } catch { /* */ }
  if (!perf) return { scrollY: Math.round(scrollY), missing: true };
  const inView = perf.inViewportWrappers ?? 0;
  const inViewCw = perf.inViewportWithCodeword ?? 0;
  return {
    scrollY: Math.round(scrollY),
    tabActive: perf.tabActive,
    deactivations: perf.tabActiveDeactivations,
    gatedSkips: perf.claim?.scanBatchGatedSkips,
    scanClaimed: perf.claim?.scanPathClaimed,
    trackerClaimed: perf.claim?.trackerPathClaimed,
    wrappers: perf.wrapperCount,
    inView,
    inViewCw,
    coverage: inView ? +(inViewCw / inView).toFixed(2) : null,
  };
};

async function readPerf(page, label) {
  const s = await page.evaluate(probe);
  if (s.missing) {
    console.log(`   [${label}] no perf dataset yet (CS not loaded / app down)`);
    return s;
  }
  console.log(
    `   [${label}] tabActive=${s.tabActive} deact=${s.deactivations} ` +
    `gatedSkips=${s.gatedSkips} scanClaimed=${s.scanClaimed} ` +
    `trackerClaimed=${s.trackerClaimed} | wrappers=${s.wrappers} ` +
    `inView=${s.inView} inViewCw=${s.inViewCw} coverage=${s.coverage} y=${s.scrollY}`,
  );
  return s;
}

async function focusAndSettle(page, ms = 8000) {
  await page.bringToFront();
  await page.mouse.move(472, 300);
  await page.mouse.click(472, 300);
  await sleep(ms);
}

const VIEWPORT = { width: 944, height: 1054 }; // match the user's snapshot

// ----------------------------------------------------------------------
console.log('[1] launching Firefox window 1 (with extension)');
const ffWithExt = withExtension(firefox, EXT);
const ctxA = await ffWithExt.launchPersistentContext(freshProfile('a'), {
  headless: false,
  viewport: VIEWPORT,
});
const ytA = await ctxA.newPage();
ytA.setDefaultTimeout(8000);

console.log('[2] navigate window 1 →', START);
try {
  await ytA.goto(START, { waitUntil: 'domcontentloaded', timeout: 60000 });
} catch (e) { console.log('   goto error:', e.message); }
await focusAndSettle(ytA);

console.log('\n=== BASELINE (foreground, fresh) ===');
const baseline = await readPerf(ytA, 'baseline');

// ---------------- WITHIN-BROWSER: tab switch + return ------------------
console.log('\n=== WITHIN-BROWSER: open 2nd tab, switch to it, return ===');
const tabB = await ctxA.newPage();
await tabB.goto('https://example.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
await tabB.bringToFront();
await sleep(4000);
console.log('   (YouTube tab now backgrounded — its next push should be rejected `inactive`)');
// Nudge the backgrounded YouTube tab to attempt a push by mutating it.
await ytA.evaluate(() => window.scrollBy(0, Math.round(innerHeight * 1.2))).catch(() => {});
await sleep(3000);
const whileBackgrounded = await readPerf(ytA, 'A backgrounded');

console.log('   returning focus to the YouTube tab (fires onActivated → reactivate)');
await focusAndSettle(ytA, 6000);
const afterReturn = await readPerf(ytA, 'A refocused');

console.log('   scrolling to reveal new content (does the scan path re-claim?)');
for (let i = 0; i < 4; i++) {
  await ytA.evaluate(() => window.scrollBy(0, Math.round(innerHeight * 1.2)));
  await sleep(1500);
}
await sleep(2000);
const afterScroll = await readPerf(ytA, 'A scrolled');

// ---------------- CROSS-WINDOW: OS focus contention --------------------
console.log('\n=== CROSS-WINDOW: 2nd Firefox window steals OS focus ===');
console.log('   launching Firefox window 2');
const ctxC = await ffWithExt.launchPersistentContext(freshProfile('c'), {
  headless: false,
  viewport: VIEWPORT,
});
const ytC = await ctxC.newPage();
await ytC.goto(START, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await focusAndSettle(ytC, 6000); // window 2 grabs OS focus → window 1 gets onFocusChanged(NONE)
console.log('   window 2 focused; window 1 saw focus loss. Mutating window 1 while blurred.');
await ytA.evaluate(() => window.scrollBy(0, Math.round(innerHeight * 1.2))).catch(() => {});
await sleep(3000);
const crossBlurred = await readPerf(ytA, 'A cross-blurred');

console.log('   returning OS focus to window 1');
await focusAndSettle(ytA, 6000);
const crossRefocused = await readPerf(ytA, 'A cross-refocused');

// --------------------------- SUMMARY -----------------------------------
console.log('\n================== ACTIVE-TAB GATE SUMMARY ==================');
console.log('  stage              tabActive  deact  gatedSkips  coverage');
const row = (label, s) => {
  if (!s || s.missing) { console.log(`  ${label.padEnd(18)} (no perf)`); return; }
  console.log(
    `  ${label.padEnd(18)} ${String(s.tabActive).padStart(9)}  ${String(s.deactivations).padStart(5)}  ` +
    `${String(s.gatedSkips).padStart(10)}  ${String(s.coverage).padStart(8)}`,
  );
};
row('baseline', baseline);
row('A backgrounded', whileBackgrounded);
row('A refocused', afterReturn);
row('A scrolled', afterScroll);
row('A cross-blurred', crossBlurred);
row('A cross-refocused', crossRefocused);

const stuck = [afterReturn, afterScroll, crossRefocused].some(
  (s) => s && !s.missing && s.tabActive === false,
);
console.log('\n  VERDICT:', stuck
  ? 'tabActive STUCK false on a foreground tab → active-tab gate CONFIRMED as the strander'
  : 'tabActive recovered on refocus → gate is not permanently stranding in this scenario');

console.log('\n  --- Tier-2 (real two-bundle) manual repro ---');
console.log('  1. Launch the BranchKit app.');
console.log('  2. Open Firefox (stable) + Firefox Nightly, each on a dense YouTube page.');
console.log('  3. Alt-tab between the two browsers a few times, end on Firefox stable.');
console.log('  4. On the focused Firefox tab, press Ctrl+Alt+A (or read the Perf panel).');
console.log('  5. Inspect tabActive / tabActiveDeactivations / claim.scanBatchGatedSkips');
console.log('     in the snapshot. tabActive=false while clearly foreground = confirmed.');

console.log('\n[done] leaving windows open 8s');
await sleep(8000);
await ctxC.close().catch(() => {});
await ctxA.close().catch(() => {});
console.log('closed.');
