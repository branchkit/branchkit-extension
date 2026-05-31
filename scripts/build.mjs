#!/usr/bin/env node
/**
 * Build the extension for a single target into `dist/<target>/`.
 *
 * Usage:
 *   node scripts/build.mjs <chrome|firefox>
 *
 * Each target gets its own output directory so both can coexist on
 * disk — load `dist/chrome/` into Chrome and `dist/firefox/` into
 * Firefox at the same time. Bundles are identical across targets;
 * only `manifest.json` differs (see `scripts/build-manifest.mjs`).
 *
 * `npm run build` runs this for both targets in sequence.
 */

import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const target = process.argv[2];
if (target !== 'chrome' && target !== 'firefox') {
  console.error('usage: build.mjs <chrome|firefox>');
  process.exit(1);
}

const outDir = resolve(root, 'dist', target);

// Stamp every bundle with the build time. Surfaced in the debug snapshot
// (`buildId`) so we can tell, from a captured snapshot, exactly which build
// the running content script came from — and rule out a stale/orphaned CS.
const buildId = new Date().toISOString();

// Clean only this target's directory so a parallel `build:all` doesn't
// race with itself.
if (existsSync(outDir)) rmSync(outDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

const entries = [
  { in: 'src/content.ts',    out: 'content.js',    format: 'iife' },
  { in: 'src/bootstrap.ts',  out: 'bootstrap.js',  format: 'iife' },
  { in: 'src/background.ts', out: 'background.js', format: 'esm'  },
  { in: 'src/offscreen.ts',  out: 'offscreen.js',  format: 'iife' },
  { in: 'src/popup.ts',      out: 'popup.js',      format: 'iife' },
  { in: 'src/options.ts',    out: 'options.js',    format: 'iife' },
];

await Promise.all(entries.map((e) =>
  esbuild.build({
    entryPoints: [resolve(root, e.in)],
    outfile: resolve(outDir, e.out),
    bundle: true,
    format: e.format,
    logLevel: 'warning',
    define: { __BUILD_ID__: JSON.stringify(buildId) },
  })
));

// Static assets (HTML pages + icons).
cpSync(resolve(root, 'offscreen.html'), resolve(outDir, 'offscreen.html'));
cpSync(resolve(root, 'popup.html'),     resolve(outDir, 'popup.html'));
cpSync(resolve(root, 'options.html'),   resolve(outDir, 'options.html'));
cpSync(resolve(root, 'icons'),          resolve(outDir, 'icons'), { recursive: true });

// Target-specific manifest patch. Delegated to keep that logic in one
// place — `build-manifest.mjs` is also useful for cross-target diffs.
const manifestResult = spawnSync(
  process.execPath,
  [resolve(__dirname, 'build-manifest.mjs'), target],
  { stdio: 'inherit' },
);
if (manifestResult.status !== 0) process.exit(manifestResult.status ?? 1);

console.log(`built dist/${target}/`);
