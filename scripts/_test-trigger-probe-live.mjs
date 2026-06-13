// Live verify for the Phase 3a trigger-redundancy probe
// (notes/DESIGN_GRAMMAR_EPOCH_HANDSHAKE.md "Phase 3a LANDED").
//
// Drives the one enumerated trigger reachable in a lab Firefox — the
// reactivate push on tab activation — and asserts the probe breadcrumb
// lands in the plugin log:
//   tab A (links, codewords claimed) → open tab B → switch back to A
//   → background onActivated relays reactivate{tab_activated}
//   → republishForActivation probes BEFORE rotating → BK_TRIGGER_PROBE.
//
// Why not the bfcache leg of _test-epoch-live-repros.mjs: Playwright's
// Firefox build DISABLES BFCache outright (playwright.cfg:
// "Disable BFCache in parent process ... also separately in content via
// docShell property"), so page.goBack() cold-boots a fresh CS and
// bfcache_restore can never fire in this harness — that leg degrades to a
// plain back-nav test. bfcache_restore + sw_restart_resync probe coverage
// comes from the real-Firefox soak (both fire organically there).
//
// Acceptance, read from the browser.log delta:
//   - at least one BK_TRIGGER_PROBE with reason=tab_activated;
//   - the line is well-formed (diverged true/false/null, busy boolean);
//   - zero BK_GRAMMAR_EPOCH_CAP (probe must not feed the act path).
//
// Usage: npm run build:firefox && node scripts/_test-trigger-probe-live.mjs

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
const PROFILE = '/tmp/branchkit-ff-trigger-probe';
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

console.log('[1] tab A: load, settle (codewords claim + sync)');
const tabA = await ctx.newPage();
await tabA.goto(`${BASE}/a`, { waitUntil: 'load' });
await sleep(6000);
const hostsA = await tabA.evaluate(() => document.querySelectorAll('[data-branchkit-hint]').length).catch(() => -1);
console.log(`    hostsA=${hostsA}`);

console.log('[2] tab B: open (activates B, backgrounds A)');
const tabB = await ctx.newPage();
await tabB.goto(`${BASE}/b`, { waitUntil: 'load' });
await sleep(4000);

console.log('[3] switch back to A → onActivated → reactivate{tab_activated} → probe');
await tabA.bringToFront();
await sleep(5000);

const delta = logDelta();
const probeLines = delta.split('\n').filter((l) => l.includes('BK_TRIGGER_PROBE'));
const tabActivatedProbes = probeLines
  .map((l) => { try { return JSON.parse(l.slice(l.indexOf('{'))); } catch { return null; } })
  .filter((p) => p && p.reason === 'tab_activated');
const capLines = delta.split('\n').filter((l) => l.includes('BK_GRAMMAR_EPOCH_CAP]'));

console.log('\n=== PROBE LINES (this run) ===');
for (const l of probeLines) console.log('  ' + l.trim());

const wellFormed = tabActivatedProbes.every(
  (p) => (p.diverged === true || p.diverged === false || p.diverged === null) && typeof p.busy === 'boolean',
);

console.log('\n=== VERDICT ===');
const checks = [
  [`badges on tab A (${hostsA})`, hostsA > 0],
  [`tab_activated probe fired (${tabActivatedProbes.length})`, tabActivatedProbes.length >= 1],
  ['probe lines well-formed (diverged/busy)', wellFormed],
  [`no cap exhaustion (${capLines.length})`, capLines.length === 0],
];
let pass = true;
for (const [name, okFlag] of checks) {
  console.log(`  ${okFlag ? '✓' : '✗'} ${name}`);
  if (!okFlag) pass = false;
}
console.log(`GATE: ${pass ? 'PASS' : 'FAIL'}`);

await ctx.close();
server.close();
process.exit(pass ? 0 : 1);
