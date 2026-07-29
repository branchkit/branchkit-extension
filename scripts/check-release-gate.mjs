#!/usr/bin/env node
/**
 * Release gate: the harness-hook define must actually be APPLIED to release
 * artifacts (2026-07-24 finding: the define runtime-gates the hooks but does
 * NOT strip their bytes — esbuild has no cross-function constant
 * propagation — so the load-bearing invariant is that __HARNESS_HOOKS__ is
 * replaced with `false` in every release bundle, making every hook a
 * runtime no-op; unit tests pin the no-op behavior per hook).
 *
 * Checks:
 *  1. Release builds (chrome + firefox) contain NO unreplaced
 *     `__HARNESS_HOOKS__` token — a new entrypoint missing the define would
 *     leave the token literal (and the hooks ENABLED, since undefined
 *     counts as enabled for vitest's sake).
 *  2. Release bundles contain none of the DEV-ONLY BYTES listed below.
 *  3. package.json packaging scripts route through --release / BK_RELEASE.
 *
 * Check 2 exists because check 1 was not enough, and the way it was not enough
 * is the point. Asserting the define is APPLIED is a guard on the INPUT: it
 * proves `__DEV_RELOAD__` became `false`, and says nothing about whether the
 * branch it guards survived. It did survive. esbuild's dead-branch elimination
 * is a minify feature, so `if (false) { ... }` was emitted verbatim and every
 * release bundle shipped `new WebSocket('ws://127.0.0.1:35729')` plus its
 * reconnect loop — a hardcoded localhost socket with no user-facing purpose, a
 * different port and peer than the companion-app host the permission
 * justifications describe, and the first thing a store reviewer grepping the
 * bundle would find. build.mjs now sets `minifySyntax` on release builds, which
 * removes it; this check is what keeps it removed, because the next way the
 * bytes come back will not be the same way.
 *
 * So: assert on the OUTPUT. A gate that reads the build flags can only ever
 * re-state the build's own intent back to itself.
 *
 * Rebuilds dist/ in release mode, so it restores the dev build afterwards
 * when run locally (CI doesn't care). NOTE: that rebuild rm+renames dist/ for
 * BOTH targets — see DESIGN_EXTENSION_CONNECTION_HEALTH.md on running it with
 * an unpacked extension loaded in a live browser.
 */

import { execSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'pipe' }).toString();

let failed = false;

/**
 * Bytes that must not appear in a shipped bundle, with the reason a reviewer
 * would give. Substrings rather than regexes: each one is a literal a human
 * can grep the artifact for and confirm by eye.
 */
const FORBIDDEN = [
  ['ws://127.0.0.1:35729', 'the dev auto-reload socket (dev.mjs\'s livereload port)'],
  ['[BranchKit Dev]', 'dev auto-reload console output'],
];

for (const browser of ['chrome', 'firefox']) {
  run(`node scripts/build.mjs ${browser} --release`);
  const dist = resolve(root, `dist/${browser}`);
  for (const f of readdirSync(dist).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(resolve(dist, f), 'utf8');
    if (src.includes('__HARNESS_HOOKS__')) {
      console.error(`RELEASE GATE: unreplaced __HARNESS_HOOKS__ in dist/${browser}/${f} — ` +
        `this bundle's harness hooks would be LIVE in the shipped build ` +
        `(undefined counts as enabled). Add the define to its esbuild entry.`);
      failed = true;
    }
    for (const [needle, why] of FORBIDDEN) {
      if (!src.includes(needle)) continue;
      console.error(`RELEASE GATE: dist/${browser}/${f} contains ${JSON.stringify(needle)} — ` +
        `${why}. The define being applied is not enough: esbuild only eliminates ` +
        `a dead \`if (false)\` branch when minifySyntax is on. Check that ` +
        `build.mjs still sets minifySyntax for release, and that this code is ` +
        `behind a define-guarded branch at all.`);
      failed = true;
    }
  }
  console.log(`ok: dist/${browser} release bundles have the define applied`);
  console.log(`ok: dist/${browser} release bundles carry none of the ${FORBIDDEN.length} dev-only literals`);
}

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
for (const [name, cmd] of Object.entries(pkg.scripts)) {
  if (!name.startsWith('package:')) continue;
  if (!cmd.includes('--release') && !cmd.includes('BK_RELEASE')) {
    console.error(`RELEASE GATE: script "${name}" does not build with --release: ${cmd}`);
    failed = true;
  }
}
console.log('ok: packaging scripts route through --release');

// Restore the dev build so a local run doesn't leave release bits in dist/.
run('node scripts/build.mjs chrome');
run('node scripts/build.mjs firefox');

process.exit(failed ? 1 : 0);
