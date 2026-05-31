// Guardrail for the scroll-back badge-stranding fix (DESIGN_OBSERVER_DRIVEN_LAYOUT
// "Placement staleness: the anchor binding outlives the target").
//
// The bug: the anchor path pins a body-mounted host to its target via an inline
// `anchor-name` set ONCE at construction. List virtualization (YouTube
// scroll-back) recreates/recycles the target node WITHOUT that style, so
// `position-anchor` dangles and the badge collapses to the document origin. No
// scroll/resize fires on the target, our host is never removed, and the wrapper
// isn't disconnected — so neither badgeReattachObserver nor limbo-rebind catches
// it. Only the level-triggered placement reconcile (reconcilePlacement →
// HintBadge.ensureBound) re-asserts the binding.
//
// This isolates that exact path deterministically, no app required: it strips a
// live target's anchor-name (the recycled-node effect, with no disconnect or
// host removal, so ONLY reconcilePlacement can restore it), then drives a
// scroll-settle and asserts the binding is re-asserted and the badge re-glues.
// Restoration is uniquely attributable to ensureBound — nothing else writes
// anchor-name.
//
// Runs on Chromium (it supports CSS anchor positioning, so badges take the
// anchor path — the same path the user's Firefox 131+ takes for these targets).

import { chromium } from 'playwright';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, rmSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const EXT = resolve(root, 'dist/chrome');
const PROFILE = '/tmp/branchkit-anchor-rebind-profile';
const TARGET_ID = 'row-2'; // a near-top row, reliably in-band and hinted

// Content scripts match <all_urls> but Chrome excludes file:// without file
// access. Serve the fixture over http://localhost so the content script runs.
const fixtureHtml = readFileSync(resolve(root, 'test-fixtures/anchor-rebind.html'), 'utf8');
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

console.log('[1] launch Chromium with extension');
const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  args: ['--disable-extensions-except=' + EXT, '--load-extension=' + EXT],
});

// Seed an alphabet so showHints() doesn't bail at isAlphabetLoaded(). Normally
// BranchKit pushes this over SSE; here we inject 26 words straight into storage.
const ALPHABET = 'arch bat cat dog echo fox golf hotel india jam kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu'.split(' ');
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
await sw.evaluate(async (a) => {
  await chrome.storage.sync.set({ aggressiveHints: true, hintVisibility: 'always' });
  await chrome.storage.local.set({ alphabet: a });
}, ALPHABET);

const page = await ctx.newPage();
console.log('[2] load fixture, settle 6s for scan + paint');
await page.goto(FIXTURE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);

// Map: the target's inline anchor-name is the name the host's position-anchor
// references. Returns the host↔target geometry so we can judge "glued".
async function probe(targetId) {
  return await page.evaluate((id) => {
    const target = document.getElementById(id);
    if (!target) return { error: 'no target' };
    const name = target.style.getPropertyValue('anchor-name').trim();
    const hosts = Array.from(document.querySelectorAll('[data-branchkit-hint]'));
    const host = hosts.find(h => h.style.getPropertyValue('position-anchor').trim() === name) || null;
    const t = target.getBoundingClientRect();
    const h = host ? host.getBoundingClientRect() : null;
    return {
      anchorName: name,
      hasHost: !!host,
      dy: h ? Math.round(h.top - t.top) : null,
      dx: h ? Math.round(h.left - t.left) : null,
      targetTop: Math.round(t.top),
      hostTop: h ? Math.round(h.top) : null,
    };
  }, targetId);
}

console.log('[3] baseline');
const base = await probe(TARGET_ID);
console.log('   ', JSON.stringify(base));
if (!base.anchorName || !base.anchorName.startsWith('--bk-')) {
  fail(`target #${TARGET_ID} has no anchor-name — not on the anchor path (no badge painted?)`);
} else if (!base.hasHost) {
  fail('no host references the target anchor-name at baseline');
} else if (Math.abs(base.dy) > 40 || Math.abs(base.dx) > 60) {
  fail(`badge not glued at baseline (dy=${base.dy}, dx=${base.dx})`);
} else {
  pass(`badge glued at baseline (dy=${base.dy}, dx=${base.dx}), name=${base.anchorName}`);
}
const NAME = base.anchorName;

console.log('[4] strip the target anchor-name (simulate recycled node) + assert it took');
const afterStrip = await page.evaluate((id) => {
  const target = document.getElementById(id);
  target.style.removeProperty('anchor-name');
  return { live: target.style.getPropertyValue('anchor-name').trim() }; // synchronous, pre-settle
}, TARGET_ID);
if (afterStrip.live === '') pass('anchor-name removed from target');
else fail(`strip did not take (anchor-name still "${afterStrip.live}")`);

console.log('[5] drive a SMALL window scroll-and-back to fire the scroll-settle reconcile');
// Keep #row-2 (y≈103) inside the attention band the whole time: a large scroll
// would push it out of band, tear its badge down, and rebuild it with a FRESH
// anchor-name on re-entry — which would re-glue the badge for the wrong reason
// and mask whether the reconcile ran. With row-2 in-band throughout, nothing
// tears it down, so re-asserting the ORIGINAL name is uniquely ensureBound's
// doing (retarget — the only other writer — needs a disconnect, which never
// happens here).
await page.evaluate(() => window.scrollTo(0, 60));
await sleep(150);
await page.evaluate(() => window.scrollTo(0, 0));
console.log('   wait 400ms for the 100ms settle debounce + reconcile');
await sleep(400);

console.log('[6] assert binding re-asserted and badge re-glued');
const after = await probe(TARGET_ID);
console.log('   ', JSON.stringify(after));
if (after.anchorName !== NAME) {
  fail(`anchor-name not re-asserted (got "${after.anchorName}", want "${NAME}") — reconcilePlacement/ensureBound did not run`);
} else {
  pass(`anchor-name re-asserted to ${NAME}`);
}
if (!after.hasHost) {
  fail('host no longer references the target after repair');
} else if (Math.abs(after.dy) > 40 || Math.abs(after.dx) > 60) {
  fail(`badge still stranded after repair (dy=${after.dy}, dx=${after.dx})`);
} else {
  pass(`badge re-glued (dy=${after.dy}, dx=${after.dx})`);
}

console.log('\n=== VERDICT ===');
console.log(failed ? '  ✗ FAIL — placement reconcile did not re-glue the dangling anchor binding'
                   : '  ✓ PASS — placement reconcile re-glued the dangling anchor binding');

await page.screenshot({ path: '/tmp/branchkit-anchor-rebind.png' });
await ctx.close();
server.close();
process.exit(failed ? 1 : 0);
