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
 *  2. package.json packaging scripts route through --release / BK_RELEASE.
 *
 * Rebuilds dist/ in release mode, so it restores the dev build afterwards
 * when run locally (CI doesn't care).
 */

import { execSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'pipe' }).toString();

let failed = false;

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
  }
  console.log(`ok: dist/${browser} release bundles have the define applied`);
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
