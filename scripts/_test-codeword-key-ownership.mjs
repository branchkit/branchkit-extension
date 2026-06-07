// Guardrail for the codeword key-ownership transfer (Layer 1 of
// notes/DESIGN_CODEWORD_KEY_OWNERSHIP.md).
//
// The bug it pins: when a page re-mounts an element IN PLACE (removes the old
// DOM node, adds a fresh one with the same href — no document reload), the new
// node should inherit the predecessor's codeword + registry id rather than
// claim a fresh letter. Before key-ownership the predecessor still held the
// letter at claim time, so the successor took a new one and the badge "churned"
// (the QuickBase sidebar symptom).
//
// This isolates that exact path deterministically — no BranchKit app required.
// It seeds an alphabet straight into extension storage (same trick as
// _test-anchor-rebind.mjs), loads a faux sidebar, lets the links claim
// codewords, then replaces one link with a same-href node and asserts the
// codeword + id transferred AND the rebind_key counter ticked (proving it went
// through the strong-key path, not the fingerprint fallback). A second link that
// is NOT re-mounted is the control.
//
// State is read via the cross-world snapshot channel (the content script's
// window.* accessors live in the isolated world, invisible to page.evaluate):
// dispatch `__branchkit__capture_snapshot`, read `dataset.branchkitSnapshot`.
//
// Run: node scripts/_test-codeword-key-ownership.mjs

import { chromium } from 'playwright';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, rmSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const EXT = resolve(root, 'dist/chrome');
const PROFILE = '/tmp/branchkit-codeword-key-ownership-profile';
const TARGET_HREF = '/app/users';     // the link we re-mount
const CONTROL_HREF = '/app/settings'; // a link we leave alone

const fixtureHtml = readFileSync(resolve(root, 'test-fixtures/codeword-key-ownership.html'), 'utf8');
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

// Seed an alphabet so codewords get claimed without the app (same as
// _test-anchor-rebind.mjs). always-mode so the links claim on scan.
const ALPHABET = 'arch bat cat dog echo fox golf hotel india jam kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu'.split(' ');
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
await sw.evaluate(async (a) => {
  await chrome.storage.sync.set({ aggressiveHints: true, hintVisibility: 'always' });
  await chrome.storage.local.set({ alphabet: a });
}, ALPHABET);

const page = await ctx.newPage();
console.log('[2] load fixture, settle 6s for scan + codeword claim');
await page.goto(FIXTURE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);

// Cross-world read: the content-script listener builds the snapshot synchronously
// during the CustomEvent dispatch and mirrors it onto a dataset attribute.
async function capture() {
  return await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('__branchkit__capture_snapshot'));
    const raw = document.documentElement.dataset.branchkitSnapshot;
    if (!raw) return { wrappers: [], rebindKey: -1 };
    const p = JSON.parse(raw);
    return {
      wrappers: (p.wrappers || []).map((w) => ({
        href: (w.fingerprint && w.fingerprint.href) || null,
        id: w.scanned.id,
        cw: w.scanned.codeword,
      })),
      rebindKey: p.rebind_counters ? p.rebind_counters.rebind_key : -1,
    };
  });
}
const byHref = (cap, href) => cap.wrappers.filter((w) => w.href === href && w.cw);

console.log('[3] baseline');
const before = await capture();
const tBefore = byHref(before, TARGET_HREF);
const cBefore = byHref(before, CONTROL_HREF);
console.log('    target ', JSON.stringify(tBefore), ' rebind_key=', before.rebindKey);
console.log('    control', JSON.stringify(cBefore));
if (tBefore.length !== 1 || !tBefore[0].cw) {
  fail(`target ${TARGET_HREF} did not get exactly one codeworded wrapper at baseline (alphabet/claim issue?)`);
}
if (cBefore.length !== 1 || !cBefore[0].cw) {
  fail(`control ${CONTROL_HREF} did not get a codeword at baseline`);
}

if (!failed) {
  console.log('[4] re-mount the target in place (add same-href node, then remove old) — no reload');
  await page.evaluate((href) => {
    const old = document.querySelector(`a[href="${href}"]`);
    const fresh = document.createElement('a');
    fresh.setAttribute('href', href);
    fresh.textContent = old.textContent;
    old.parentNode.insertBefore(fresh, old); // add-before-remove (the QuickBase shape)
    old.remove();
  }, TARGET_HREF);

  console.log('    wait 1.2s for the mutation → discovery → rebind');
  await sleep(1200);

  console.log('[5] after');
  const after = await capture();
  const tAfter = byHref(after, TARGET_HREF);
  const cAfter = byHref(after, CONTROL_HREF);
  console.log('    target ', JSON.stringify(tAfter), ' rebind_key=', after.rebindKey);
  console.log('    control', JSON.stringify(cAfter));

  if (tAfter.length !== 1) {
    fail(`expected exactly one codeworded wrapper for ${TARGET_HREF} after re-mount, got ${tAfter.length}`);
  } else {
    if (tAfter[0].cw === tBefore[0].cw) pass(`target kept its codeword "${tBefore[0].cw}" across the re-mount`);
    else fail(`target codeword CHANGED "${tBefore[0].cw}" -> "${tAfter[0].cw}" (key-ownership did not transfer)`);

    if (tAfter[0].id === tBefore[0].id) pass(`target kept its registry id ${tBefore[0].id}`);
    else fail(`target id CHANGED ${tBefore[0].id} -> ${tAfter[0].id} (fresh wrapper, not a transfer)`);
  }

  if (after.rebindKey > before.rebindKey) pass(`rebind_key incremented ${before.rebindKey} -> ${after.rebindKey} (strong-key path fired)`);
  else fail(`rebind_key did not increment (${before.rebindKey} -> ${after.rebindKey}) — transfer went through some other path or not at all`);

  if (cAfter.length === 1 && cAfter[0].cw === cBefore[0].cw && cAfter[0].id === cBefore[0].id) {
    pass('control link untouched (id + codeword stable)');
  } else {
    fail(`control link changed unexpectedly: ${JSON.stringify(cBefore)} -> ${JSON.stringify(cAfter)}`);
  }
}

console.log('\n=== VERDICT ===');
console.log(failed
  ? '  ✗ FAIL — codeword key-ownership did not transfer across the in-place re-mount'
  : '  ✓ PASS — re-mounted link inherited its predecessor codeword + id via the strong-key path');

await page.screenshot({ path: '/tmp/branchkit-codeword-key-ownership.png' });
await ctx.close();
server.close();
process.exit(failed ? 1 : 0);
