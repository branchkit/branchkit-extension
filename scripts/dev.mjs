#!/usr/bin/env node
/**
 * Dev server: esbuild watch + WebSocket reload signal.
 *
 * Runs esbuild in watch mode for all entry points, writing output to
 * `dist/<target>/`. On each successful build, pings connected WebSocket
 * clients (the extension's background script) to trigger
 * chrome.runtime.reload().
 *
 * Usage: node scripts/dev.mjs [chrome|firefox ...]   (default: both)
 *
 * BOTH TARGETS BY DEFAULT, from ONE server. Every loaded extension connects to
 * the same hard-coded port (background.ts), so a single reload broadcast
 * already reaches both browsers — but a server watching one target rebuilds
 * only that dist, and the other browser then reloads a dist nobody rebuilt.
 * That silently pinned Firefox to an old build for a whole session while its
 * files on disk looked current (2026-07-26): the browser kept contributing a
 * command catalog that no longer existed in source.
 */

import * as esbuild from 'esbuild';
import { WebSocketServer } from 'ws';
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ENTRIES, STATIC_FILES, STATIC_DIRS, guardBailWrap } from './lib/bundle-spec.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const VALID = ['chrome', 'firefox'];
const targets = process.argv.length > 2 ? process.argv.slice(2) : VALID;
for (const t of targets) {
  if (!VALID.includes(t)) {
    console.error(`usage: dev.mjs [${VALID.join('|')} ...]   (default: all)`);
    process.exit(1);
  }
}

const PORT = 35729;
const wss = new WebSocketServer({ port: PORT });
const clients = new Set();

// Connection log: which clients are attached and what they said. The one
// place the reload chain was still dark — a browser that never reconnects
// (or whose hello never arrives) is indistinguishable from a healthy one
// without these lines (Firefox, 2026-07-27).
let connSeq = 0;
function logWs(id, what) {
  console.log(`[dev] ws#${id} ${what} (clients=${clients.size})`);
}

wss.on('connection', (ws) => {
  clients.add(ws);
  const id = ++connSeq;
  logWs(id, 'connected');
  ws.on('message', (m) => {
    const msg = m.toString();
    // Out-of-band build notification: a bare `npm run build` (build.mjs)
    // connects, sends this, and disconnects — we broadcast the reload so no
    // loaded extension keeps running a prior generation against the freshly
    // swapped dist/.
    if (msg === 'external-build') { logWs(id, 'external-build'); notifyReload(); }
    // Stale-client heal: the broadcast is fire-and-forget, so a background
    // asleep at broadcast time (Firefox event pages especially) missed it
    // FOREVER and ran a stale build while dist/ looked current — three field
    // retries burned on exactly this, 2026-07-26. The client sends the epoch
    // ms its build loaded; if the dist changed after that, this connection is
    // stale by construction and gets a direct reload, no broadcast needed.
    else if (msg.startsWith('hello ')) {
      const loadedAt = Number(msg.slice(6));
      const stale = Number.isFinite(loadedAt) && lastBuildAt > loadedAt;
      logWs(id, `hello loadedAt=${loadedAt} lastBuildAt=${lastBuildAt} → ${stale ? 'RELOAD' : 'current'}`);
      if (stale) ws.send('reload');
    }
  });
  ws.on('close', () => { clients.delete(ws); logWs(id, 'closed'); });
});

// One reload per burst. Each target runs a watch context per entry point, so a
// single edit finishes a dozen builds within milliseconds; broadcasting on each
// would fire a dozen runtime.reload() calls, and a reload mid-reload is how a
// browser ends up on a half-swapped dist.
let notifyTimer = null;
let lastBuildAt = 0; // epoch ms of the newest build generation (see the hello heal)
function notifyReload() {
  if (notifyTimer) clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    lastBuildAt = Date.now();
    for (const ws of clients) ws.send('reload');
  }, 150);
}


// A wedged watcher is worse than a failed build: the dist keeps its last good
// output, the browser keeps running it, and every later "rebuilt, go test it"
// is a lie. This server sat broken for hours on one stale import that scrolled
// past in the log (2026-07-26), so failure and RECOVERY are both stated
// loudly, and the server never claims to be watching while broken.
const broken = new Set();
function reportBuildState(target, errors) {
  const key = target;
  if (errors.length > 0) {
    broken.add(key);
    console.error(
      `\n✘ [dev] ${target} BUILD FAILED — dist/${target}/ is STALE and the ` +
      `browser is running an OLD build until this is fixed.`,
    );
    return false;
  }
  if (broken.delete(key)) {
    console.log(`✓ [dev] ${target} build recovered — dist/${target}/ is current again.`);
  }
  return true;
}

for (const target of targets) {
  const outDir = resolve(root, 'dist', target);
  if (existsSync(outDir)) rmSync(outDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  // Static files copied once at startup. The manifest splitter writes
  // dist/<target>/manifest.json — re-run by hand if you edit it.
  for (const f of STATIC_FILES) cpSync(resolve(root, f), resolve(outDir, f));
  for (const d of STATIC_DIRS) cpSync(resolve(root, d), resolve(outDir, d), { recursive: true });

  const manifestResult = spawnSync(
    process.execPath,
    [resolve(__dirname, 'build-manifest.mjs'), target],
    { stdio: 'inherit' },
  );
  if (manifestResult.status !== 0) process.exit(manifestResult.status ?? 1);

  const reloadPlugin = {
    name: 'reload-notify',
    setup(build) {
      build.onEnd((result) => {
        if (reportBuildState(target, result.errors)) notifyReload();
      });
    },
  };

  // Start a watch context per entry point. Reloads are coalesced above, so all
  // targets and entries settle into a single broadcast.
  const contexts = await Promise.all(
    ENTRIES.map((e) =>
      esbuild.context({
        entryPoints: [resolve(root, e.in)],
        outfile: resolve(outDir, e.out),
        bundle: true,
        format: e.format,
        // Same define set as build.mjs's non-release path, so a watch build
        // behaves identically to `npm run build` (harness hooks on; the
        // typeof-guarded fallbacks would cover us, but identical is simpler).
        define: {
          __DEV_RELOAD__: 'true',
          __HARNESS_HOOKS__: 'true',
          __BUILD_ID__: JSON.stringify('dev-watch'),
        },
        plugins: [reloadPlugin],
        ...guardBailWrap(e),
      })
    )
  );

  await Promise.all(contexts.map((ctx) => ctx.watch()));
}

console.log(
  `[dev] watching ${targets.join(' + ')} → ${targets.map((t) => `dist/${t}/`).join(', ')}` +
  `  (reload server ws://localhost:${PORT})`,
);
