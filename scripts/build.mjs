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
import { cpSync, mkdirSync, rmSync, renameSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ENTRIES, STATIC_FILES, STATIC_DIRS, guardBailWrap } from './lib/bundle-spec.mjs';

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


await Promise.all(ENTRIES.map((e) =>
  esbuild.build({
    entryPoints: [resolve(root, e.in)],
    outfile: resolve(outDir, e.out),
    bundle: true,
    format: e.format,
    logLevel: 'warning',
    // Dead-branch elimination is a MINIFY feature in esbuild, not a bundling
    // one. Without this, `if (__DEV_RELOAD__)` becomes a literal `if (false)
    // { ... }` and esbuild emits the whole block verbatim — which is how a
    // release bundle kept shipping `new WebSocket('ws://127.0.0.1:35729')`
    // and its reconnect loop long after the define was correct. Verified
    // directly: `--define:__F__=false` alone leaves the socket URL in the
    // output, `--tree-shaking=true` also leaves it, `--minify-syntax` removes
    // it. background.ts's comment claiming the literal `if (false)` form is
    // "what esbuild's dead-branch elimination actually removes" was true only
    // under minification, and nothing here minified.
    //
    // minifySyntax and NOT minify: syntax-level only, so identifiers and
    // formatting survive. A store reviewer still reads recognisable code, and
    // SOURCE_BUILD.md's byte-reproducibility story is unaffected — this is a
    // deterministic transform of the same input.
    minifySyntax: release,
    define: {
      __BUILD_ID__: JSON.stringify(buildId),
      __HARNESS_HOOKS__: release ? 'false' : 'true',
      // Dev builds keep the auto-reload WS client (background.ts) so a
      // loaded extension reloads itself whenever dev.mjs's server pings —
      // including the external-build ping THIS script sends on finish.
      // Without this, the first plain build overwrites the loaded
      // extension with a deaf one and the reload loop silently dies.
      // Release builds strip it (a localhost socket has no place in a
      // store submission).
      __DEV_RELOAD__: release ? 'false' : 'true',
    },
    ...guardBailWrap(e),
  })
));

// Static assets (HTML pages + icons).
for (const f of STATIC_FILES) cpSync(resolve(root, f), resolve(outDir, f));
for (const d of STATIC_DIRS) cpSync(resolve(root, d), resolve(outDir, d), { recursive: true });

// Target-specific manifest patch. Delegated to keep that logic in one
// place — `build-manifest.mjs` is also useful for cross-target diffs.
const manifestResult = spawnSync(
  process.execPath,
  [resolve(__dirname, 'build-manifest.mjs'), target, outDir, ...(release ? ['--release'] : [])],
  { stdio: 'inherit' },
);
if (manifestResult.status !== 0) process.exit(manifestResult.status ?? 1);

// Swap staging into place (ms-scale window instead of the whole build).
swapIntoPlace(outDir, finalDir);

/**
 * Move `staging` onto `final` WITHOUT the destination directory ever ceasing
 * to exist.
 *
 * The previous form was `rmSync(final)` + `renameSync(staging, final)`: one
 * atomic syscall, but for a few milliseconds the loaded extension's directory
 * was GONE. Chrome tolerates that (its hazard is the SW re-reading a
 * half-written dist, which either form solves). Gecko does not — it treats the
 * directory disappearing as the add-on being removed and tears it down hard
 * enough to take the browser with it. Recorded 2026-07-28 in
 * DESIGN_EXTENSION_CONNECTION_HEALTH.md as "two consecutive build.mjs runs
 * under a Firefox with the extension temporarily installed, and Firefox went
 * down"; reproduced 2026-07-29 by check-release-gate.mjs, which builds four
 * times in a row and killed a live Firefox doing it.
 *
 * That note proposed two fixes and both were workarounds: decline to swap a
 * dist a browser has loaded, or rename BRANCHKIT_NO_DEV_RELOAD to admit what it
 * does. Neither lets you rebuild while developing, which is the entire point of
 * the dev loop. So the destination directory is kept and its CONTENTS are
 * replaced instead — every individual file still lands via `renameSync`, so a
 * reader either sees the whole old file or the whole new one, never a torn one.
 *
 * The trade is honest and worth naming: a whole-directory rename is atomic
 * across ALL files at once, whereas this is atomic per file, so there is a
 * millisecond window where dist holds a mix of generations. That window already
 * existed in practice — it is what the post-swap dev-reload ping closes — and a
 * mixed dist costs a reload, while a vanished dist costs the browser.
 */
function swapIntoPlace(staging, final) {
  if (!existsSync(final)) {
    renameSync(staging, final); // nothing has it open; take the atomic path
    return;
  }
  const walk = (dir, base = '') => readdirSync(dir, { withFileTypes: true })
    .flatMap((d) => (d.isDirectory()
      ? walk(resolve(dir, d.name), `${base}${d.name}/`)
      : [`${base}${d.name}`]));

  const incoming = walk(staging);
  for (const rel of incoming) {
    const dest = resolve(final, rel);
    mkdirSync(dirname(dest), { recursive: true });
    renameSync(resolve(staging, rel), dest);
  }
  // Drop anything the new build no longer produces, so a stale bundle can't
  // outlive the entry that emitted it.
  for (const rel of walk(final)) {
    if (!incoming.includes(rel)) rmSync(resolve(final, rel));
  }
  // ...and the directories that removal just emptied, so a retired entry
  // point's folder doesn't outlive it either. Depth-first: a parent only
  // becomes empty once its children are gone.
  const pruneEmpty = (dir) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (d.isDirectory()) pruneEmpty(resolve(dir, d.name));
    }
    if (dir !== final && readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
  };
  pruneEmpty(final);
  rmSync(staging, { recursive: true });
}

// Couple "files changed" to "extension reloaded": if a dev-reload server
// (scripts/dev.mjs) is listening, ask it to broadcast a reload so no loaded
// extension is left running a prior generation against the new files on
// disk. No server (CI, plain builds with no browser attached) → silent skip.
await pingDevReload();

console.log(`built dist/${target}/`);

async function pingDevReload() {
  // A build that isn't the developer's own must not reload their browsers.
  // An agent, or a second checkout verifying `npm run build`, would otherwise
  // tear down and re-inject every content script in every tab — which lands as
  // a phantom failure in whatever harness the real session is running.
  if (process.env.BRANCHKIT_NO_DEV_RELOAD === '1') return;
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
