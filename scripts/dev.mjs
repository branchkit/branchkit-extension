#!/usr/bin/env node
/**
 * Dev server: esbuild watch + WebSocket reload signal.
 *
 * Runs esbuild in watch mode for all entry points. On each successful build,
 * pings connected WebSocket clients (the extension's background script) to
 * trigger chrome.runtime.reload().
 *
 * Usage: node scripts/dev.mjs
 */

import * as esbuild from 'esbuild';
import { WebSocketServer } from 'ws';
import { cpSync } from 'fs';

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
  { in: 'src/content.ts',    out: 'dist/content.js',    format: 'iife' },
  { in: 'src/bootstrap.ts',  out: 'dist/bootstrap.js',  format: 'iife' },
  { in: 'src/background.ts', out: 'dist/background.js', format: 'esm' },
  { in: 'src/offscreen.ts',  out: 'dist/offscreen.js',  format: 'iife' },
  { in: 'src/popup.ts',      out: 'dist/popup.js',      format: 'iife' },
  { in: 'src/options.ts',    out: 'dist/options.js',    format: 'iife' },
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

// Copy static files once
cpSync('manifest.json', 'dist/manifest.json');
cpSync('offscreen.html', 'dist/offscreen.html');
cpSync('popup.html', 'dist/popup.html');
cpSync('options.html', 'dist/options.html');
cpSync('icons', 'dist/icons', { recursive: true });

// Start a watch context per entry point. The last one to finish a rebuild
// sends the reload signal (all rebuild nearly simultaneously).
const contexts = await Promise.all(
  entries.map((e) =>
    esbuild.context({
      entryPoints: [e.in],
      outfile: e.out,
      bundle: true,
      format: e.format,
      define: { __DEV_RELOAD__: 'true' },
      plugins: [reloadPlugin],
    })
  )
);

await Promise.all(contexts.map((ctx) => ctx.watch()));

console.log(`[dev] watching — reload server on ws://localhost:${PORT}`);
