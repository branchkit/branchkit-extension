// LIVE grammar-churn + discovery-efficacy probe for Phase 6 of
// notes/DESIGN_HINT_LIFECYCLE_RECONCILER.md. This is NOT a committed CI
// guardrail — it talks to the running dev actuator (localhost:21551) and reads
// its actuator.log, so it only works on a machine with BranchKit running. It
// briefly clobbers any active browser tab's hint grammar (multi-tab
// last-pusher-wins). Run it deliberately, not in a suite.
//
// It answers the two LIVE gates the signed-out CI guardrails can't:
//   (Phase 5) Does the settle-triggered reconcile spam grammar on every scroll?
//             -> Phase A scrolls with NO new content; expect ~no grammar batches.
//   (Phase 3b) Does the band-discovery sweep actually close a discovery gap
//             through the real grammar path, with BOUNDED (incremental, not
//             full-rescan) commits? -> Phase B injects gap links into an open
//             shadow root during scroll; expect them badged via incremental
//             commits, no `kind=scan` storm.
//
// Isolation: we snapshot the actuator.log byte length before/after and parse
// ONLY the delta, so the user's concurrent traffic doesn't pollute the count.

import { chromium } from 'playwright';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, rmSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const EXT = resolve(root, 'dist/chrome');
const PROFILE = '/tmp/branchkit-live-churn-profile';
const ACTUATOR_LOG = resolve(homedir(), 'Library/Application Support/BranchKitDev/actuator.log');

if (!existsSync(ACTUATOR_LOG)) {
  console.log('FAIL — actuator.log not found; is BranchKit running?');
  process.exit(1);
}

const fixtureHtml = readFileSync(resolve(root, 'test-fixtures/live-churn.html'), 'utf8');
const server = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(fixtureHtml);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const FIXTURE = `http://127.0.0.1:${server.address().port}/`;

if (existsSync(PROFILE)) rmSync(PROFILE, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const fail = (msg) => { failed = true; console.log('  FAIL —', msg); };
const pass = (msg) => console.log('  ok  —', msg);

// Read actuator.log bytes from `fromOffset` to current EOF, return text + new offset.
function readLogSince(fromOffset) {
  const size = statSync(ACTUATOR_LOG).size;
  if (size <= fromOffset) return { text: '', offset: size };
  const fd = openSync(ACTUATOR_LOG, 'r');
  try {
    const len = size - fromOffset;
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, fromOffset);
    return { text: buf.toString('utf8'), offset: size };
  } finally {
    closeSync(fd);
  }
}

// Count the grammar-traffic signatures in a log window.
function grammarStats(text) {
  const lines = text.split('\n');
  let scan = 0, incremental = 0, skipped = 0, pushes = 0, elemsCommitted = 0;
  for (const ln of lines) {
    if (!ln.includes('[browser]')) continue;
    if (ln.includes('grammar batch')) {
      if (ln.includes('kind=scan')) scan++;
      else if (ln.includes('kind=incremental')) incremental++;
      const m = ln.match(/elements=(\d+)/);
      if (m) elemsCommitted += Number(m[1]);
    }
    if (ln.includes('grammar_already_owns')) skipped++;
    if (ln.includes('"collection":"browser_hints')) pushes++;
  }
  return { scan, incremental, skipped, pushes, elemsCommitted };
}

console.log('[1] launch Chromium with extension (connects to live actuator)');
const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  args: ['--disable-extensions-except=' + EXT, '--load-extension=' + EXT],
});
const ALPHABET = 'arch bat cat dog echo fox golf hotel india jam kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu'.split(' ');
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
await sw.evaluate(async (a) => {
  await chrome.storage.sync.set({ aggressiveHints: true, hintVisibility: 'always' });
  await chrome.storage.local.set({ alphabet: a });
}, ALPHABET);

const page = await ctx.newPage();
console.log('[2] load fixture, settle 6s');
await page.goto(FIXTURE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);

const baseShadowBadges = await page.evaluate(() => window.__countShadowBadges());
console.log(`    baseline shadow badges = ${baseShadowBadges} (expect 0 — host empty)`);

// ---- Phase A: steady-state scroll, NO new content ----
console.log('\n[3] Phase A — steady-state scroll burst (no new hintables)');
let off = statSync(ACTUATOR_LOG).size;
for (let i = 0; i < 8; i++) {
  await page.evaluate(() => window.scrollTo(0, 80));
  await sleep(160);
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(160);
}
await sleep(1500); // let any idle sweep + reconcile drain
const a = readLogSince(off);
const aStats = grammarStats(a.text);
console.log('    grammar in window:', JSON.stringify(aStats));
if (aStats.scan > 0) {
  fail(`steady-state scroll triggered ${aStats.scan} full grammar rescans (kind=scan) — settle reconcile is re-posting grammar`);
} else if (aStats.elemsCommitted > 0) {
  fail(`steady-state scroll committed ${aStats.elemsCommitted} grammar elements with no new content — unexpected churn`);
} else {
  pass(`steady-state scroll caused no grammar element commits (scan=0, elements=0, skipped=${aStats.skipped})`);
}

// ---- Phase B: inject discovery-gap links during scroll ----
console.log('\n[4] Phase B — inject 6 gap links (open shadow root) across a scroll burst');
off = a.offset;
const GAPS = 6;
for (let i = 0; i < GAPS; i++) {
  await page.evaluate((id) => window.__injectGap(id), `gap-${i}`);
  await page.evaluate(() => window.scrollTo(0, 80));
  await sleep(160);
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(160);
}
console.log('    wait 2000ms for settle debounce + idle sweep + reconcile + paint');
await sleep(2000);

const boundGaps = await page.evaluate(() => window.__countBoundGapLinks());
const totalGaps = await page.evaluate(() => window.__countGapLinks());
const b = readLogSince(off);
const bStats = grammarStats(b.text);
console.log(`    gap links in shadow = ${totalGaps}, badged (anchor-bound) = ${boundGaps}`);
console.log('    grammar in window:', JSON.stringify(bStats));

if (boundGaps < GAPS) {
  fail(`only ${boundGaps}/${GAPS} injected gap links got badged — band-discovery sweep missed some`);
} else {
  pass(`all ${GAPS} injected gap links discovered + badged (efficacy: discoveryGap -> 0)`);
}
if (bStats.scan > 0) {
  fail(`band-discovery used ${bStats.scan} FULL grammar rescans (kind=scan) — should be incremental`);
} else if (bStats.elemsCommitted < GAPS) {
  fail(`grammar committed only ${bStats.elemsCommitted} elements for ${GAPS} new links — under-committed`);
} else {
  pass(`grammar commits bounded + incremental (scan=0, incremental=${bStats.incremental}, elements=${bStats.elemsCommitted})`);
}

console.log('\n=== VERDICT ===');
console.log(failed
  ? '  ✗ FAIL — live grammar-churn / discovery-efficacy gate not met'
  : '  ✓ PASS — settle reconcile does not spam grammar; band-discovery closes the gap via bounded incremental commits');

await page.screenshot({ path: '/tmp/branchkit-live-churn.png' });
await ctx.close();
server.close();
process.exit(failed ? 1 : 0);
