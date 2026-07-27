#!/usr/bin/env node
/**
 * Real-input harness runner (Wave 4 D1, notes/PLAN_MODE_HOLDER_IMPL.md).
 *
 *   node scripts/harness/realinput/run.mjs                       # chromium, all
 *   node scripts/harness/realinput/run.mjs --browser=firefox     # firefox, all
 *   node scripts/harness/realinput/run.mjs escape-unwind …       # subset
 *
 * PASS — the chain held end to end; FAIL — assertion broke (exit 1);
 * SKIP — the browser declined a transition under automation, listed loudly.
 * Requires a built dist (npm run build); launches standalone via
 * scripts/lib/launch.mjs — never joins a live BranchKit.
 */

import { startFixtureServer, launchHarness, Skip } from './driver.mjs';

const SCENARIOS = [
  'dictate-commit-pick', 'dictate-announced', 'badge-borrow', 'escape-unwind',
  'search-badge-hint-mode', 'armed-cue-tinted', 'pick-prefix-escape',
  'refused-key-feedback', 'pick-keeps-keymap', 'search-survives-rerender',
  'find-reaps-dead-matches',
];

const browser = process.argv.includes('--browser=firefox') ? 'firefox' : 'chromium';
const args = process.argv.slice(2).filter((a) => !a.startsWith('--browser='));
const requested = args.length ? args : SCENARIOS;
const unknown = requested.filter((s) => !SCENARIOS.includes(s));
if (unknown.length) {
  console.error(`unknown scenario(s): ${unknown.join(', ')}\navailable: ${SCENARIOS.join(', ')}`);
  process.exit(2);
}

const { server, base } = await startFixtureServer();
const { ctx } = await launchHarness(browser);
const page = await ctx.newPage();
const results = [];

for (const name of requested) {
  try {
    const { run } = await import(`./scenarios/${name}.mjs`);
    const detail = await run({ ctx, page, base, browser });
    results.push({ name, status: 'PASS', detail });
  } catch (e) {
    results.push({
      name,
      status: e instanceof Skip ? 'SKIP' : 'FAIL',
      detail: e.message,
    });
  }
}

await ctx.close().catch(() => {});
server.close();

let failed = 0;
console.log(`\n=== real-input harness (${browser}) ===`);
for (const r of results) {
  console.log(`${r.status.padEnd(5)} ${r.name.padEnd(20)} ${r.detail}`);
  if (r.status === 'FAIL') failed++;
}
const skips = results.filter((r) => r.status === 'SKIP').length;
if (skips) console.log(`\n${skips} skip(s): those chains were NOT covered this run.`);
process.exit(failed ? 1 : 0);
