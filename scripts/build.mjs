#!/usr/bin/env node
/**
 * Build the extension for a single target into `dist/<target>/`.
 *
 * Usage:
 *   node scripts/build.mjs <chrome|firefox> [--release]
 *
 * Each target gets its own output directory so both can coexist on
 * disk — load `dist/chrome/` into Chrome and `dist/firefox/` into
 * Firefox at the same time. Bundles are identical across targets;
 * only `manifest.json` differs (see `scripts/build-manifest.mjs`).
 *
 * `npm run build` runs this for both targets in sequence.
 *
 * `--release` (or BK_RELEASE=1) builds with __HARNESS_HOOKS__=false,
 * stripping every page-exposed test affordance (perf dataset mirror,
 * snapshot/teardown CustomEvent hooks, debug bridge, open-shadow toggle
 * — see src/debug/harness-hooks.ts). Default builds keep them on so the
 * local Playwright harnesses work against dist/ unchanged. Packaging
 * scripts (package:firefox) MUST go through --release.
 */

import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync, renameSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const target = process.argv[2];
if (target !== 'chrome' && target !== 'firefox') {
  console.error('usage: build.mjs <chrome|firefox> [--release]');
  process.exit(1);
}
const release = process.argv.includes('--release') || process.env.BK_RELEASE === '1';

const finalDir = resolve(root, 'dist', target);
// Build into a staging dir and swap at the end. An MV3 service worker
// re-reads its JS from disk whenever it respawns, so seconds of half-written
// dist/ under a loaded unpacked extension is a wedge window — Chrome gives up
// on a SW that fails to start and stops retrying until a manual reload
// (2026-07-02 incident, DESIGN_EXTENSION_CONNECTION_HEALTH.md addendum). The
// rm+rename swap below shrinks that window from the whole build to
// milliseconds; the post-swap dev-reload ping closes the version-skew half.
const outDir = resolve(root, 'dist', `.staging-${target}`);

// Stamp every bundle with the build time. Surfaced in the debug snapshot
// (`buildId`) so we can tell, from a captured snapshot, exactly which build
// the running content script came from — and rule out a stale/orphaned CS.
// Overridable via BK_BUILD_ID so a release build is byte-reproducible — an
// AMO reviewer sets the same value to reproduce the submitted bundle exactly
// (the timestamp is otherwise the only non-deterministic input). See
// notes/PLAN_STORE_SUBMISSION.md P2 and SOURCE_BUILD.md.
const buildId = process.env.BK_BUILD_ID ?? new Date().toISOString();

if (existsSync(outDir)) rmSync(outDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

const entries = [
  // `swallowGuardBail`: content.ts's duplicate-injection guard deliberately
  // throws to abort its IIFE when a script is injected into a frame that
  // already has one. That throw is correct, but it surfaces as an "Uncaught
  // Error" in the page console / dev error list. Wrap the IIFE so ONLY that
  // intentional bail is caught (any real error re-throws, still uncaught).
  { in: 'src/content.ts',    out: 'content.js',    format: 'iife', swallowGuardBail: true },
  { in: 'src/bootstrap.ts',  out: 'bootstrap.js',  format: 'iife' },
  { in: 'src/background.ts', out: 'background.js', format: 'esm'  },
  { in: 'src/offscreen.ts',  out: 'offscreen.js',  format: 'iife' },
  { in: 'src/popup.ts',      out: 'popup.js',      format: 'iife' },
  { in: 'src/options.ts',    out: 'options.js',    format: 'iife' },
  { in: 'src/palette-page.ts', out: 'palette.js',  format: 'iife' },
];

await Promise.all(entries.map((e) =>
  esbuild.build({
    entryPoints: [resolve(root, e.in)],
    outfile: resolve(outDir, e.out),
    bundle: true,
    format: e.format,
    logLevel: 'warning',
    define: {
      __BUILD_ID__: JSON.stringify(buildId),
      __HARNESS_HOOKS__: release ? 'false' : 'true',
    },
    ...(e.swallowGuardBail ? {
      banner: { js: 'try {' },
      footer: { js: '} catch (e) { if (String((e && e.message) || e).indexOf("duplicate injection") === -1) throw e; }' },
    } : {}),
  })
));

// Static assets (HTML pages + icons).
cpSync(resolve(root, 'offscreen.html'), resolve(outDir, 'offscreen.html'));
cpSync(resolve(root, 'popup.html'),     resolve(outDir, 'popup.html'));
cpSync(resolve(root, 'options.html'),   resolve(outDir, 'options.html'));
cpSync(resolve(root, 'palette.html'),   resolve(outDir, 'palette.html'));
cpSync(resolve(root, 'icons'),          resolve(outDir, 'icons'), { recursive: true });

// Target-specific manifest patch. Delegated to keep that logic in one
// place — `build-manifest.mjs` is also useful for cross-target diffs.
const manifestResult = spawnSync(
  process.execPath,
  [resolve(__dirname, 'build-manifest.mjs'), target, outDir],
  { stdio: 'inherit' },
);
if (manifestResult.status !== 0) process.exit(manifestResult.status ?? 1);

// Swap staging into place (ms-scale window instead of the whole build).
if (existsSync(finalDir)) rmSync(finalDir, { recursive: true });
renameSync(outDir, finalDir);

// Couple "files changed" to "extension reloaded": if a dev-reload server
// (scripts/dev.mjs) is listening, ask it to broadcast a reload so no loaded
// extension is left running a prior generation against the new files on
// disk. No server (CI, plain builds with no browser attached) → silent skip.
await pingDevReload();

console.log(`built dist/${target}/`);

async function pingDevReload() {
  let WebSocket;
  try {
    ({ WebSocket } = await import('ws'));
  } catch {
    return; // ws not installed — nothing to ping
  }
  await new Promise((done) => {
    const sock = new WebSocket('ws://127.0.0.1:35729');
    const finish = () => {
      try { sock.close(); } catch { /* already closed */ }
      done();
    };
    const deadline = setTimeout(finish, 500);
    sock.on('open', () => {
      sock.send('external-build');
      console.log('pinged dev-reload server (extensions will reload)');
      clearTimeout(deadline);
      setTimeout(finish, 50); // let the frame flush
    });
    sock.on('error', () => { clearTimeout(deadline); finish(); });
  });
}
