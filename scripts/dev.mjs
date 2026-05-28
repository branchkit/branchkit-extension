#!/usr/bin/env node
/**
 * Dev server: esbuild watch + WebSocket reload signal.
 *
 * Runs esbuild in watch mode for all entry points, writing output to
 * `dist/<target>/`. On each successful build, pings connected WebSocket
 * clients (the extension's background script) to trigger
 * chrome.runtime.reload().
 *
 * Usage: node scripts/dev.mjs <chrome|firefox>
 *
 * Pick whichever target matches the browser you've sideloaded. Both
 * target dirs can coexist on disk, so you can run two dev sessions
 * (one per browser) only if you bump the WS port for the second.
 */

import * as esbuild from 'esbuild';
import { WebSocketServer } from 'ws';
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const target = process.argv[2];
if (target !== 'chrome' && target !== 'firefox') {
  console.error('usage: dev.mjs <chrome|firefox>');
  process.exit(1);
}

const outDir = resolve(root, 'dist', target);

const PORT = 35729;
const wss = new WebSocketServer({ port: PORT });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
});

function notifyReload() {
  for (const ws of clients) {
    ws.send('reload');
  }
}

const entries = [
  { in: 'src/content.ts',    out: 'content.js',    format: 'iife' },
  { in: 'src/bootstrap.ts',  out: 'bootstrap.js',  format: 'iife' },
  { in: 'src/background.ts', out: 'background.js', format: 'esm'  },
  { in: 'src/offscreen.ts',  out: 'offscreen.js',  format: 'iife' },
  { in: 'src/popup.ts',      out: 'popup.js',      format: 'iife' },
  { in: 'src/options.ts',    out: 'options.js',    format: 'iife' },
];

const reloadPlugin = {
  name: 'reload-notify',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length === 0) {
        notifyReload();
      }
    });
  },
};

if (existsSync(outDir)) rmSync(outDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

// Static files copied once at startup. The manifest splitter writes
// dist/<target>/manifest.json — re-run by hand if you edit it.
cpSync(resolve(root, 'offscreen.html'), resolve(outDir, 'offscreen.html'));
cpSync(resolve(root, 'popup.html'),     resolve(outDir, 'popup.html'));
cpSync(resolve(root, 'options.html'),   resolve(outDir, 'options.html'));
cpSync(resolve(root, 'icons'),          resolve(outDir, 'icons'), { recursive: true });

const manifestResult = spawnSync(
  process.execPath,
  [resolve(__dirname, 'build-manifest.mjs'), target],
  { stdio: 'inherit' },
);
if (manifestResult.status !== 0) process.exit(manifestResult.status ?? 1);

// Start a watch context per entry point. The last one to finish a rebuild
// sends the reload signal (all rebuild nearly simultaneously).
const contexts = await Promise.all(
  entries.map((e) =>
    esbuild.context({
      entryPoints: [resolve(root, e.in)],
      outfile: resolve(outDir, e.out),
      bundle: true,
      format: e.format,
      define: { __DEV_RELOAD__: 'true' },
      plugins: [reloadPlugin],
    })
  )
);

await Promise.all(contexts.map((ctx) => ctx.watch()));

console.log(`[dev] watching ${target} → dist/${target}/  (reload server ws://localhost:${PORT})`);
