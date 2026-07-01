// End-to-end guardrail for the SSE resilience work (notes/DESIGN_SSE_RESILIENCE.md).
//
// Runs a FAKE host (actuator status endpoint on 21551 + plugin server with a
// tokened SSE /events stream and POST endpoints) and drives the real extension
// through four scenarios:
//
//   A. boot     — extension discovers, connects SSE, grammar batches arrive.
//   B. restart  — SSE sockets destroyed + token rotated (a host restart).
//                 Must reconnect with the NEW token and re-emit the active
//                 tab's grammar (the b7399f5 healer, unmasked by the
//                 real-connect-edge change — this is the verification that
//                 DESIGN_HOST_RESTART_RESYNC.md left pending).
//   C. rotation — token rotated while the SSE stays OPEN (the undetected-drop
//                 wedge): POSTs 401, creds must clear, and a later batch must
//                 succeed on the new token with no SSE drop to help it.
//   D. flap     — plugin SSE down, actuator up (crash-loop shape). Discovery
//                 fetch cadence must ESCALATE (stable-reset backoff), not
//                 hammer at 1s. Then the plugin comes back and the ladder
//                 must still reconnect.
//
// Needs port 21551 free — quit BranchKit first (just stop).
// Run: npm run build:chrome && node scripts/_test-sse-resilience.mjs

import { chromium } from 'playwright';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const EXT = resolve(root, 'dist/chrome');
const PROFILE = '/tmp/branchkit-sse-resilience-profile';
const ACTUATOR_PORT = 21551; // hardcoded in the extension's actuator-client

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const fail = (msg) => { failed = true; console.log('  FAIL —', msg); };
const pass = (msg) => console.log('  ok  —', msg);

// ---------- fake host ----------

let currentToken = 'token-gen-1';
let sseEnabled = true;                 // scenario D flips this off
let actuatorUp = true;                 // scenario D flips this off (503s)
const statusHits = [];                 // timestamps of discovery fetches
const events = [];                     // {t, kind, ...} log of everything seen
const sseSockets = new Set();

const note = (kind, extra = {}) => { events.push({ t: Date.now(), kind, ...extra }); };

// Fake actuator: only the discovery endpoint.
const actuator = createServer((req, res) => {
  if (req.url.startsWith('/v1/plugins/browser/status')) {
    statusHits.push(Date.now());
    note('discover');
    if (!actuatorUp) { res.writeHead(503); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ enabled: true, listen: { port: pluginPort, token: currentToken } }));
    return;
  }
  res.writeHead(404); res.end();
});

// Fake plugin: SSE /events + tokened POSTs.
const plugin = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/events') {
    if (!sseEnabled) { note('sse_attempt_refused'); req.socket.destroy(); return; }
    const tok = url.searchParams.get('token');
    note('sse_connect', { token: tok });
    if (tok !== currentToken) { res.writeHead(401); res.end(); return; }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('event: connected\ndata: {"ok":true}\n\n');
    sseSockets.add(res);
    req.on('close', () => sseSockets.delete(res));
    return;
  }

  // POST endpoints. Collect body, check bearer.
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const auth = req.headers.authorization ?? '';
    const ok = auth === `Bearer ${currentToken}`;
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { /* non-JSON */ }
    note('post', { path: url.pathname, ok, elements: parsed?.elements?.length ?? 0 });
    if (!ok) { res.writeHead(401); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (url.pathname === '/grammar/batch') {
      res.end(JSON.stringify({
        result: 'ok',
        succeeded: (parsed?.elements ?? []).map((e) => e.codeword),
        failed: [],
      }));
    } else {
      res.end(JSON.stringify({ result: 'ok' }));
    }
  });
});

function killSSESockets() {
  for (const res of sseSockets) { try { res.socket.destroy(); } catch { /* gone */ } }
  sseSockets.clear();
}

// Wait until an event matching pred arrives with t >= since (checks history
// first, then polls). Returns the event or null on timeout.
async function waitForEvent(pred, since, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = events.find((e) => e.t >= since && pred(e));
    if (hit) return hit;
    if (Date.now() > deadline) return null;
    await sleep(200);
  }
}

// ---------- fixture page ----------

const FIXTURE_HTML = `<!doctype html><html><body style="font-family:sans-serif;padding:30px">
<h1>sse resilience fixture</h1>
<ul>${Array.from({ length: 30 }, (_, i) => `<li><a href="/x${i}">link ${i}</a></li>`).join('\n')}</ul>
</body></html>`;
const fixtureServer = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(FIXTURE_HTML);
});

// ---------- run ----------

let pluginPort;
try {
  await new Promise((r, j) => { actuator.on('error', j); actuator.listen(ACTUATOR_PORT, '127.0.0.1', r); });
} catch {
  console.error(`port ${ACTUATOR_PORT} is busy — quit BranchKit (just stop) and re-run.`);
  process.exit(2);
}
await new Promise((r) => plugin.listen(0, '127.0.0.1', r));
pluginPort = plugin.address().port;
await new Promise((r) => fixtureServer.listen(0, '127.0.0.1', r));
const FIXTURE = `http://127.0.0.1:${fixtureServer.address().port}/`;

if (existsSync(PROFILE)) rmSync(PROFILE, { recursive: true });

console.log('[A] boot: launch extension against the fake host');
const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  args: ['--disable-extensions-except=' + EXT, '--load-extension=' + EXT],
});
let swSpawns = 0;
ctx.on('serviceworker', () => { swSpawns++; note('sw_spawn'); });
const ALPHABET = 'arch bat cat dog echo fox golf hotel india jam kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu'.split(' ');
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
await sw.evaluate(async (a) => {
  await chrome.storage.sync.set({ aggressiveHints: true, hintVisibility: 'always' });
  await chrome.storage.local.set({ alphabet: a });
}, ALPHABET);

const t0 = Date.now();
const page = await ctx.newPage();
await page.goto(FIXTURE, { waitUntil: 'domcontentloaded' });

{
  const sse = await waitForEvent((e) => e.kind === 'sse_connect' && e.token === currentToken, t0, 15_000);
  sse ? pass('SSE connected with the current token') : fail('no SSE connection within 15s of boot');
  const batch = await waitForEvent((e) => e.kind === 'post' && e.path === '/grammar/batch' && e.ok && e.elements > 0, t0, 15_000);
  batch ? pass(`grammar batch arrived (${batch.elements} elements)`) : fail('no authorized grammar batch after boot');
}

console.log('[B] host restart: destroy SSE + rotate token; expect reconnect on NEW token + grammar re-emit (healer)');
{
  const tRestart = Date.now();
  currentToken = 'token-gen-2';
  killSSESockets();

  const sse = await waitForEvent((e) => e.kind === 'sse_connect' && e.token === 'token-gen-2', tRestart, 20_000);
  sse ? pass(`reconnected with new token after ${((sse.t - tRestart) / 1000).toFixed(1)}s`) : fail('no SSE reconnect with the new token within 20s');
  // The healer's republish → content reactivate → grammar re-Put. This is the
  // pending DESIGN_HOST_RESTART_RESYNC.md verification: pre-fix, the optimistic
  // connected flag masked the edge and NO batch re-arrived.
  const batch = await waitForEvent((e) => e.kind === 'post' && e.path === '/grammar/batch' && e.ok && e.elements > 0, tRestart, 25_000);
  batch ? pass(`grammar re-emitted on new token ${((batch.t - tRestart) / 1000).toFixed(1)}s after restart (healer fired)`)
        : fail('grammar was never re-emitted after host restart — healer did not fire');
}

console.log('[C] silent token rotation (SSE stays OPEN): POSTs must self-heal via cred-clear');
{
  await sleep(1500);
  const tRotate = Date.now();
  currentToken = 'token-gen-3'; // old SSE socket stays connected — no drop signal
  await page.reload({ waitUntil: 'domcontentloaded' }); // fresh scan → grammar batches

  const denied = await waitForEvent((e) => e.kind === 'post' && !e.ok, tRotate, 15_000);
  denied ? pass(`a stale-token POST 401'd (${denied.path}) — the wedge condition exists`)
         : fail('no 401 observed — rotation did not exercise the stale-cred path');
  const healed = await waitForEvent((e) => e.kind === 'post' && e.path === '/grammar/batch' && e.ok && e.elements > 0, tRotate, 20_000);
  healed ? pass(`a later grammar batch succeeded on the new token ${((healed.t - tRotate) / 1000).toFixed(1)}s after rotation (creds cleared + rediscovered)`)
         : fail('POSTs stayed wedged on the stale token — cred-clear did not recover');
}

console.log('[D] host down (crash-loop shape): discovery cadence must stay bounded (watching 45s)');
{
  const tFlap = Date.now();
  actuatorUp = false;   // discovery 503s (observable, unlike a closed port)
  sseEnabled = false;   // plugin SSE gone
  killSSESockets();
  await sleep(45_000);
  const hits = statusHits.filter((t) => t >= tFlap);
  const gaps = hits.slice(1).map((t, i) => ((t - hits[i]) / 1000).toFixed(1));
  const spawnsInFlap = events.filter((e) => e.t >= tFlap && e.kind === 'sw_spawn').length;
  console.log(`    ${hits.length} discovery fetches in 45s; SW spawns during flap: ${spawnsInFlap}; gaps: ${gaps.join(', ') || '(none)'}`);
  if (process.env.TRACE) {
    console.log('    --- first 20s of flap-window events ---');
    for (const e of events.filter((e) => e.t >= tFlap && e.t < tFlap + 20_000)) {
      console.log(`    +${((e.t - tFlap) / 1000).toFixed(2)}s ${e.kind}${e.path ? ' ' + e.path : ''}${e.ok === false ? ' (401)' : ''}`);
    }
  }
  // Budget: the ladder contributes ~6 fetches in 45s (1,2,4,8,16,30s) and the
  // discover-on-miss path is negative-cached at 5s (≤9 more under constant
  // content traffic). The pre-fix behavior — ladder reset on every optimistic
  // "connect" + unthrottled per-POST discovery — produced 55-90.
  if (hits.length > 0 && hits.length <= 20) pass(`bounded discovery (${hits.length} fetches in 45s)`);
  else if (hits.length === 0) fail('no discovery fetches at all — retry ladder is dead');
  else fail(`${hits.length} discovery fetches in 45s — discovery is hammering`);

  console.log('[D2] host returns: must reconnect');
  actuatorUp = true;
  sseEnabled = true;
  const tBack = Date.now();
  const sse = await waitForEvent((e) => e.kind === 'sse_connect' && e.token === currentToken, tBack, 45_000);
  sse ? pass(`reconnected ${((sse.t - tBack) / 1000).toFixed(1)}s after the host came back`)
      : fail('never reconnected after the host came back (ladder wedged)');
}

console.log('\n=== VERDICT ===');
console.log(failed
  ? '  ✗ FAIL — SSE resilience regression'
  : '  ✓ PASS — reconnect healer, cred self-heal, and escalating backoff all hold');

await ctx.close();
actuator.close(); plugin.close(); fixtureServer.close();
process.exit(failed ? 1 : 0);
