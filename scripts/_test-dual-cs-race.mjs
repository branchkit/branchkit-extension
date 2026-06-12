// Dual-CS install race repro + acceptance gate (grammar epoch handshake arc,
// tripwire catch #1 — see notes/DESIGN_GRAMMAR_EPOCH_HANDSHAKE.md).
//
// Mechanism under test: on a fresh install, a SLOW-LOADING page makes the
// manifest content script (document_idle) lag tab creation by seconds. The
// SW's lazy-inject path (tabs.onActivated → ensureContentScriptInjected)
// pings during that window, concludes the tab is empty/orphaned, and runs
// flushOrphanGuard + executeScript — all of which Firefox defers to the SAME
// document_idle moment the manifest script fires at. The flush can therefore
// execute BETWEEN the manifest script's guard-set and the queued injection's
// guard-check, deleting the fresh guard — two live content scripts per frame
// (each with its own grammar session). Which side of the manifest boot the
// flush lands on is scheduler jitter: flush-first shows boot+ABORT pairs,
// flush-in-between shows dual boots.
//
// The fixture STREAMS its body (CHUNKS x 100ms; default ~2.5s) so
// document_idle reliably lags the lazy-inject decision. Each content script
// instance appends a boot entry (cs_id) to the page-world bridge
// `window.__branchkitDebugJSON`; a guard-aborted copy appends an aborted_at
// marker instead. flushOrphanGuard appends a flushed_at marker when it runs
// (diagnostic instrumentation).
//
// Acceptance gate: across repeated runs, dual=0 AND none=0 (every tab boots
// exactly one CS).
//
// Usage: npm run build:firefox && [CHUNKS=n] node scripts/_test-dual-cs-race.mjs [runs]

import { firefox } from 'playwright';
import { withExtension } from 'playwright-webextext/dist/factory.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const EXT = resolve(root, 'dist/firefox');
const PROFILE = '/tmp/branchkit-ff-dualcs';
const TABS = 6;
const RUNS = Number(process.argv[2] ?? '1');
const CHUNKS = Number(process.env.CHUNKS ?? '25');
const CHUNK_MS = 100;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Streaming fixture: headers + first chunk immediately, body trickles in.
const HEAD = `<!doctype html><html><head><title>stream</title></head><body style="font-family:sans-serif;padding:40px"><h1>streaming fixture</h1><ul>`;
const TAIL = `</ul></body></html>`;
const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
  res.write(HEAD);
  let i = 0;
  const t = setInterval(() => {
    i += 1;
    res.write(`<li><a href="#x${i}">link item ${i} on ${req.url}</a></li>\n`);
    if (i >= CHUNKS) {
      clearInterval(t);
      res.end(TAIL);
    }
  }, CHUNK_MS);
  req.on('close', () => clearInterval(t));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
console.log(`fixture: ${BASE}  (streams ${CHUNKS} chunks x ${CHUNK_MS}ms)`);

let totalDual = 0;
let totalNone = 0;
let totalClean = 0;

for (let run = 0; run < RUNS; run += 1) {
  // Fresh profile per run = fresh install every time.
  if (existsSync(PROFILE)) rmSync(PROFILE, { recursive: true });
  mkdirSync(PROFILE, { recursive: true });

  const ffWithExt = withExtension(firefox, EXT);
  const ctx = await ffWithExt.launchPersistentContext(PROFILE, { headless: false });
  // Let the temporary add-on finish registering before opening tabs.
  await sleep(1500);

  const pages = [];
  for (let i = 0; i < TABS; i += 1) {
    const page = await ctx.newPage();
    pages.push(page);
    // Kick off the slow navigation; don't serialize on full load — the race
    // needs tabs.onActivated to fire while the document is still streaming.
    page.goto(`${BASE}/t${i}?run=${run}`, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
    await sleep(300);
  }

  // Page load ≈ CHUNKS*CHUNK_MS; lazy-inject retry ladder ≈ 1s; settle past both.
  await sleep(CHUNKS * CHUNK_MS + 6000);

  console.log(`\n=== run ${run} ===`);
  for (let i = 0; i < TABS; i += 1) {
    let entries = [];
    try {
      entries = await pages[i].evaluate(() => {
        try { return JSON.parse(window.__branchkitDebugJSON ?? '[]'); } catch { return []; }
      });
    } catch (e) {
      console.log(`tab ${i}: evaluate failed: ${String(e).slice(0, 120)}`);
    }
    const boots = entries.filter((e) => e.cs_id);
    const aborts = entries.filter((e) => e.aborted_at !== undefined);
    const flushes = entries.filter((e) => e.flushed_at !== undefined);
    const verdict = boots.length > 1 ? 'DUAL' : boots.length === 0 ? 'NONE' : 'ok';
    if (verdict === 'DUAL') totalDual += 1;
    else if (verdict === 'NONE') totalNone += 1;
    else totalClean += 1;
    console.log(`tab ${i}: boots=${boots.length} aborts=${aborts.length} flushes=${flushes.length}  ${verdict}`);
    // Full timeline, ordered — the diagnostic payload.
    const timeline = entries
      .map((e) => ({ ...e, _t: e.loaded_at ?? e.aborted_at ?? e.flushed_at ?? 0 }))
      .sort((a, b) => a._t - b._t);
    for (const e of timeline) {
      const { _t, ...rest } = e;
      console.log(`    ${_t.toFixed(1).padStart(9)}ms ${JSON.stringify(rest)}`);
    }
  }

  await ctx.close();
}

console.log(`\n=== TOTAL over ${RUNS} run(s) x ${TABS} tabs ===`);
console.log(`clean=${totalClean} dual=${totalDual} none=${totalNone}`);
console.log(totalDual === 0 && totalNone === 0 ? 'GATE: PASS' : 'GATE: FAIL');
server.close();
process.exit(totalDual === 0 && totalNone === 0 ? 0 : 1);
