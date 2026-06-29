// Orphan-teardown soak harness (notes/SOAK_TEARDOWN.md).
//
// Deterministically induces the torn-down state (dispatch __branchkit__force_
// teardown), then fires a burst of the events that drive the resurrection
// listeners — attachShadow (→ SHADOW_EVENT → discoverInSubtree), visibilitychange,
// scroll — and reads the `branchkitOrphanHits` gauge off the shared DOM. The
// gauge counts guard hits, i.e. handlers that STILL FIRED after teardown.
//
// This is the teardown-COMPLETENESS check: deterministic, automatable, and the
// before/after signal for Lift 4 (DOM-listener removal). It is NOT the
// SW-saturation soak — that emergent, multi-minute, multi-tab failure stays a
// manual real-browser gate (see SOAK_TEARDOWN.md "Playwright is NOT the soak").
//
// Usage: npm run build:chrome && node scripts/_soak-orphan.mjs

import { chromium } from 'playwright';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { existsSync, rmSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const EXT = resolve(root, 'dist/chrome');
const PROFILE = '/tmp/branchkit-soak-orphan-profile';
const BURST = Number(process.env.BURST ?? '50');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FIXTURE = `<!doctype html><html><body style="font-family:sans-serif;padding:40px">
<h1>orphan soak fixture</h1><ul>
${Array.from({ length: 8 }, (_, i) => `<li><a href="#x${i}">link ${i}</a></li>`).join('')}
</ul></body></html>`;

const server = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(FIXTURE);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const URL = `http://127.0.0.1:${server.address().port}/`;

if (existsSync(PROFILE)) rmSync(PROFILE, { recursive: true });
const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  args: ['--disable-extensions-except=' + EXT, '--load-extension=' + EXT],
});

const ALPHABET = 'arch bat cat dog echo fox golf hotel india jam kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu'.split(' ');
let sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 10000 }));
await sw.evaluate(async (a) => {
  await chrome.storage.sync.set({ aggressiveHints: true, hintVisibility: 'always' });
  await chrome.storage.local.set({ alphabet: a });
}, ALPHABET);

const page = await ctx.newPage();
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await sleep(2500);

const readHits = async () => {
  const v = await page.evaluate(() => document.documentElement.dataset.branchkitOrphanHits);
  return v === undefined ? 0 : Number(v);
};

const badges = await page.locator('[data-branchkit-hint]').count();
console.log(`badges painted: ${badges} (content script alive)`);
console.log(`orphanHits baseline: ${await readHits()}`);

// Force the torn-down state, then let the orphan self-quiesce.
await page.evaluate(() => document.dispatchEvent(new CustomEvent('__branchkit__force_teardown')));
await sleep(300);
console.log(`orphanHits after teardown (pre-burst): ${await readHits()}`);

// Burst the resurrection-driving events. attachShadow fires SHADOW_EVENT via the
// main-world bootstrap wrapper; the (orphaned) isolated-world listener catches it.
await page.evaluate((n) => {
  for (let i = 0; i < n; i++) {
    const d = document.createElement('div');
    document.body.appendChild(d);
    try { d.attachShadow({ mode: 'open' }); } catch { /* ignore */ }
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('scroll'));
  }
}, BURST);
await sleep(600);

const hits = await readHits();
console.log(`\norphanHits after ${BURST}-event burst: ${hits}`);

await ctx.close();
server.close();

// Post-Lift-4 the residual must be 0; a non-zero count means a listener was not
// removed on teardown (a regression). Exit code gates CI / `npm run soak:orphan`.
const pass = hits === 0;
console.log(
  pass
    ? `PASS: 0 surviving handler hits — teardown removed these listeners.`
    : `FAIL: handlers still fired ${hits}x after teardown — a listener was not removed (teardown regression).`,
);
process.exit(pass ? 0 : 1);
