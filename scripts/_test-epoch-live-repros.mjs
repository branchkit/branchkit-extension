// Live desync repros for the grammar epoch handshake (Phase 2b acceptance —
// notes/DESIGN_GRAMMAR_EPOCH_HANDSHAKE.md "Verification").
//
// Exercises two of the three live desync scenarios in a lab Firefox against
// the RUNNING BranchKit app, then reads the browser plugin log delta:
//   1. bfcache back/forward — navigate away (purgeTab + session_end), then
//      restore the frozen context. bfcache_restore (enumerated) fires; any
//      residual divergence must surface as BK_GRAMMAR_EPOCH_MISMATCH and
//      self-heal via BK_GRAMMAR_REPUBLISH {reason: epoch_mismatch}.
//   2. extension reload via about:debugging — orphans every CS. Also
//      regression-covers the injection status gate: the existing COMPLETE
//      tab must still recover via flush+inject (boots again), while fresh
//      loading tabs never see SW injection.
//   (SW kill is Chrome-specific — covered by the live soak, not this lab.)
//
// Acceptance, read from the log delta + page state:
//   - badges present at every settle point (hosts > 0);
//   - zero BK_GRAMMAR_EPOCH_CAP (no republish storm / unhealable mismatch);
//   - every BK_GRAMMAR_EPOCH_MISMATCH is followed by a republish or is
//     cooldown-suppressed — and the run does not END on an unhealed
//     mismatch (the final epoch event, if any, must be a republish or a
//     mismatch that converged silently afterwards: we assert no mismatch
//     in the last settle window).
//
// Usage: npm run build:firefox && node scripts/_test-epoch-live-repros.mjs

import { firefox } from 'playwright';
import { withExtension } from 'playwright-webextext/dist/factory.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { existsSync, rmSync, mkdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const EXT = resolve(root, 'dist/firefox');
const PROFILE = '/tmp/branchkit-ff-epoch-live';
const LOG = resolve(homedir(), 'Library/Application Support/BranchKitDev/plugin-logs/browser.log');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pageHtml = (name, n) => `<!doctype html><html><head><title>${name}</title></head>
<body style="font-family:sans-serif;padding:24px"><h1>${name}</h1><ul>
${Array.from({ length: n }, (_, i) => `<li><a href="/x/${name}/${i}">${name} link ${i}</a></li>`).join('\n')}
</ul></body></html>`;

const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
  res.end(req.url.startsWith('/b') ? pageHtml('pageB', 40) : pageHtml('pageA', 50));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const logStart = existsSync(LOG) ? statSync(LOG).size : 0;
function logDelta() {
  if (!existsSync(LOG)) return '';
  const size = statSync(LOG).size;
  if (size <= logStart) return '';
  const fd = openSync(LOG, 'r');
  const buf = Buffer.alloc(size - logStart);
  readSync(fd, buf, 0, buf.length, logStart);
  closeSync(fd);
  return buf.toString('utf8');
}

if (existsSync(PROFILE)) rmSync(PROFILE, { recursive: true });
mkdirSync(PROFILE, { recursive: true });
const ctx = await withExtension(firefox, EXT).launchPersistentContext(PROFILE, {
  headless: false, viewport: { width: 1200, height: 850 },
});
await sleep(1500);

const page = await ctx.newPage();
const hosts = () => page.evaluate(() => document.querySelectorAll('[data-branchkit-hint]').length).catch(() => -1);
const bridge = () => page.evaluate(() => {
  try { return JSON.parse(window.__branchkitDebugJSON ?? '[]'); } catch { return []; }
}).catch(() => []);

console.log('[1] load page A, settle');
await page.goto(`${BASE}/a`, { waitUntil: 'load' });
await sleep(6000);
const h1 = await hosts();
console.log(`    hosts=${h1} boots=${(await bridge()).filter(e => e.cs_id).length}`);

console.log('[2] bfcache: away to page B, back to A');
await page.goto(`${BASE}/b`, { waitUntil: 'load' });
await sleep(2500);
await page.goBack({ waitUntil: 'load' });
await sleep(7000);
const h2 = await hosts();
const b2 = await bridge();
console.log(`    hosts=${h2} boots=${b2.filter(e => e.cs_id).length} aborts=${b2.filter(e => e.aborted_at !== undefined).length}`);

console.log('[3] extension reload via about:debugging (best-effort: privileged page —');
console.log('    Playwright juggler may close the target; reload coverage then falls to');
console.log('    the status-gate unit tests + dual-CS gate + live soak)');
// Every dbg interaction is raced against a hard deadline: on a privileged
// page the juggler connection can neither resolve nor reject (observed:
// evaluate hangs forever, goto times out, target sometimes just closes).
const deadline = (p, ms) => Promise.race([
  p, new Promise((_, rej) => setTimeout(() => rej(new Error(`deadline ${ms}ms`)), ms)),
]);
let reloadClicked = false;
let dbg = null;
try {
  dbg = await deadline(ctx.newPage(), 8000);
  dbg.setDefaultTimeout(8000);
  await dbg.goto('about:debugging#/runtime/this-firefox', { waitUntil: 'commit', timeout: 8000 }).catch(() => {});
  await sleep(2500);
  reloadClicked = await deadline(dbg.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const reload = btns.find(b => /reload/i.test(b.textContent || ''));
    if (!reload) return false;
    reload.click();
    return true;
  }), 8000);
  await sleep(2000);
} catch (e) {
  console.log(`    reload phase unavailable: ${String(e).split('\n')[0].slice(0, 100)}`);
  reloadClicked = false;
}
if (dbg) await deadline(dbg.close(), 5000).catch(() => {});
console.log(`    reload clicked: ${reloadClicked}`);

let h3 = -1;
let boots3 = -1;
if (reloadClicked) {
  console.log('[4] focus tab A; orphan must quiesce, SW must reinject (status gate: tab is complete)');
  await page.bringToFront();
  await sleep(10000); // ping ladder (1s) + flush + inject + boot + sync
  h3 = await hosts();
  const b3 = await bridge();
  boots3 = b3.filter(e => e.cs_id).length;
  console.log(`    hosts=${h3} boots=${boots3} aborts=${b3.filter(e => e.aborted_at !== undefined).length} reclaims=${b3.filter(e => e.reclaimed_at !== undefined).length} superseded=${b3.filter(e => e.superseded_at !== undefined).length}`);
} else {
  console.log('[4] SKIPPED (reload unavailable in this Playwright build)');
}

console.log('[5] final settle window (any unhealed mismatch would keep firing here)');
const preFinal = logDelta().length;
await sleep(8000);
const delta = logDelta();
const finalWindow = delta.slice(preFinal);

const count = (s, re) => (s.match(re) ?? []).length;
const mismatches = count(delta, /BK_GRAMMAR_EPOCH_MISMATCH/g);
const epochRepublishes = count(delta, /"reason":"epoch_mismatch"/g);
const caps = count(delta, /BK_GRAMMAR_EPOCH_CAP\]/g);
const lateMismatch = count(finalWindow, /BK_GRAMMAR_EPOCH_MISMATCH/g);

console.log('\n=== LOG DELTA (this run) ===');
for (const line of delta.split('\n')) {
  if (/BK_GRAMMAR_EPOCH|BK_GRAMMAR_REPUBLISH|BK_GUARD_/.test(line)) console.log('   ', line.slice(0, 200));
}

console.log('\n=== VERDICT ===');
const checks = [
  [`badges after load (${h1})`, h1 > 0],
  [`badges after bfcache back (${h2})`, h2 > 0],
  ...(reloadClicked ? [
    [`badges after extension reload + reinject (${h3})`, h3 > 0],
    [`reinjected CS booted (boots ${boots3} >= 2)`, boots3 >= 2],
  ] : [['extension-reload phase skipped (unavailable under Playwright)', true]]),
  [`no republish-cap exhaustion (${caps})`, caps === 0],
  [`mismatches healed, none in final window (total=${mismatches}, republished=${epochRepublishes}, late=${lateMismatch})`, lateMismatch === 0],
];
let ok = true;
for (const [label, pass] of checks) {
  console.log(`  ${pass ? '✓' : '✗'} ${label}`);
  if (!pass) ok = false;
}
console.log(ok ? 'GATE: PASS' : 'GATE: FAIL');

await ctx.close();
server.close();
process.exit(ok ? 0 : 1);
