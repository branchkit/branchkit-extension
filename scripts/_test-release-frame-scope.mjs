// Guardrail for the frame-scoped RELEASE_LABELS fix (2026-06-29 review,
// owner-blind release; fixed 1c0488a).
//
// The bug it pins: the SW pool's releaseLabels freed ANY matching codeword
// regardless of which frame sent the release. A frame holding a stale local
// copy of a codeword another frame owned could free the owner's live
// assignment — the owner's badge kept painting but stopped routing, and the
// pool could re-issue the codeword to a third frame.
//
// This drives the REAL message path end-to-end: a top page and a same-origin
// iframe both paint hints (always-mode, seeded alphabet — no BranchKit app
// required), then chrome.scripting.executeScript injects a sendMessage into
// the IFRAME's isolated world so the SW receives RELEASE_LABELS with
// _sender.frameId = the iframe. Three checks against the SW-side stack
// (chrome.storage.session, the pool's durable write-through):
//
//   1. ATTACK — iframe releases a codeword ASSIGNED TO THE TOP FRAME.
//      Must be ignored: still assigned to frame 0, not in free.
//   2. CONTROL — iframe releases its OWN codeword. Must free it (proves the
//      injected-message plumbing actually reaches the pool, so check 1's
//      "ignored" is meaningful and not a dead wire).
//   3. Pool can't re-issue the attacked codeword: it stays out of `free`.
//
// Run: npm run build:chrome && node scripts/_test-release-frame-scope.mjs

import { chromium } from 'playwright';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const EXT = resolve(root, 'dist/chrome');
const PROFILE = '/tmp/branchkit-release-frame-scope-profile';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const fail = (msg) => { failed = true; console.log('  FAIL —', msg); };
const pass = (msg) => console.log('  ok  —', msg);

const links = (prefix, n) =>
  Array.from({ length: n }, (_, i) =>
    `<li><a href="/${prefix}-${i}">${prefix} link ${i}</a></li>`).join('\n');

const TOP_HTML = `<!doctype html><html><body style="font-family:sans-serif;padding:30px">
<h1>frame-scope fixture (top)</h1>
<ul>${links('top', 6)}</ul>
<iframe src="/frame" style="width:600px;height:300px;border:1px solid #888"></iframe>
</body></html>`;

const FRAME_HTML = `<!doctype html><html><body style="font-family:sans-serif;padding:20px">
<h2>iframe</h2>
<ul>${links('inner', 6)}</ul>
</body></html>`;

const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(req.url.startsWith('/frame') ? FRAME_HTML : TOP_HTML);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const FIXTURE = `http://127.0.0.1:${server.address().port}/`;

if (existsSync(PROFILE)) rmSync(PROFILE, { recursive: true });

console.log('[1] launch Chromium with extension');
const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  args: ['--disable-extensions-except=' + EXT, '--load-extension=' + EXT],
});

// Seed an alphabet so codewords get claimed without the app (same as
// _test-codeword-key-ownership.mjs). always-mode so links claim on scan.
const ALPHABET = 'arch bat cat dog echo fox golf hotel india jam kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu'.split(' ');
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
await sw.evaluate(async (a) => {
  await chrome.storage.sync.set({ aggressiveHints: true, hintVisibility: 'always' });
  await chrome.storage.local.set({ alphabet: a });
}, ALPHABET);

const page = await ctx.newPage();
console.log('[2] load fixture (top + iframe), settle 6s for scan + claim + confirm');
await page.goto(FIXTURE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);

// SW-side helpers. The stack's storage.session copy is the async write-through
// of the in-memory pool; every mutation saveStack()s, so after a short settle
// it reflects the live state.
async function swState(urlPrefix) {
  return await sw.evaluate(async (prefix) => {
    const tabs = await chrome.tabs.query({ url: prefix + '*' });
    if (tabs.length !== 1) return { error: `expected 1 fixture tab, got ${tabs.length}` };
    const tabId = tabs[0].id;
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    const key = `labelStack:${tabId}`;
    const res = await chrome.storage.session.get(key);
    const stack = res[key] ?? null;
    return {
      tabId,
      frameIds: frames.map((f) => f.frameId),
      assigned: stack ? stack.assigned : null,
      free: stack ? stack.free : null,
    };
  }, urlPrefix);
}

// Inject a RELEASE_LABELS send into a specific frame's isolated world, so the
// SW sees the message with _sender.frameId = that frame.
async function releaseFromFrame(tabId, frameId, labels) {
  await sw.evaluate(async ({ tabId, frameId, labels }) => {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: (ls) => { void chrome.runtime.sendMessage({ type: 'RELEASE_LABELS', labels: ls }); },
      args: [labels],
    });
  }, { tabId, frameId, labels });
  // Message dispatch + withTabLock + saveStack write-through.
  await sleep(700);
}

console.log('[3] baseline: both frames hold assigned codewords');
const base = await swState(FIXTURE);
if (base.error || !base.assigned) {
  fail(base.error || 'no label stack materialized (scan/claim never ran?)');
} else {
  const owners = new Map(); // frameId -> [codewords]
  for (const [cw, fid] of Object.entries(base.assigned)) {
    if (!owners.has(fid)) owners.set(fid, []);
    owners.get(fid).push(cw);
  }
  const iframeId = base.frameIds.find((f) => f !== 0);
  console.log('    frames:', base.frameIds.join(', '),
    '| assigned per frame:', [...owners].map(([f, c]) => `${f}:${c.length}`).join(' '));

  const topCws = owners.get(0) ?? [];
  const innerCws = owners.get(iframeId) ?? [];
  if (iframeId === undefined) fail('no iframe frame found');
  if (topCws.length === 0) fail('top frame has no assigned codewords');
  if (innerCws.length === 0) fail('iframe has no assigned codewords');

  if (!failed) {
    const topCw = topCws[0];
    const innerCw = innerCws[0];

    console.log(`[4] ATTACK — iframe (frame ${iframeId}) releases top frame's "${topCw}"`);
    await releaseFromFrame(base.tabId, iframeId, [topCw]);
    const afterAttack = await swState(FIXTURE);
    if (afterAttack.assigned?.[topCw] === 0) {
      pass(`"${topCw}" still assigned to frame 0 — non-owner release ignored`);
    } else {
      fail(`"${topCw}" assignment changed: now ${JSON.stringify(afterAttack.assigned?.[topCw])} (owner-blind release!)`);
    }
    if (afterAttack.free?.includes(topCw)) {
      fail(`"${topCw}" leaked into free — pool could re-issue it to another frame`);
    } else {
      pass(`"${topCw}" not in free — pool cannot re-issue it`);
    }

    console.log(`[5] CONTROL — iframe releases its own "${innerCw}"`);
    await releaseFromFrame(base.tabId, iframeId, [innerCw]);
    const afterControl = await swState(FIXTURE);
    if (afterControl.assigned?.[innerCw] === undefined && afterControl.free?.includes(innerCw)) {
      pass(`"${innerCw}" freed by its owner — release plumbing works, so [4] was a real test`);
    } else {
      fail(`owner release did not free "${innerCw}" (assigned=${JSON.stringify(afterControl.assigned?.[innerCw])}, inFree=${afterControl.free?.includes(innerCw)})`);
    }
  }
}

console.log('\n=== VERDICT ===');
console.log(failed
  ? '  ✗ FAIL — RELEASE_LABELS frame scoping is not holding'
  : '  ✓ PASS — non-owner release ignored; owner release works');

await ctx.close();
server.close();
process.exit(failed ? 1 : 0);
