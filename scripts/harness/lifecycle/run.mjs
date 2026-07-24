#!/usr/bin/env node
/**
 * Lifecycle-harness runner (DESIGN_LIFECYCLE_HARNESS.md).
 *
 *   node scripts/harness/lifecycle/run.mjs             # all scenarios
 *   node scripts/harness/lifecycle/run.mjs bfcache …   # subset
 *
 * PASS  — transition engaged, invariant held (every painted badge routable)
 * FAIL  — invariant broken (or scenario error); exit 1
 * SKIP  — the browser declined the transition under automation; listed
 *         loudly, does not fail the run (no silent green: a skip line names
 *         exactly what was NOT covered)
 */

import { startFixtureServer, launchHarness, Skip } from './driver.mjs';

const SCENARIOS = ['fresh-load', 'bfcache', 'bfcache-roundtrip', 'iframe', 'sw-restart', 'prerender', 'reload'];
// Firefox: no CDP (prerender is Chrome-shaped anyway) and no automatable
// about:debugging reload — the applicable subset only.
const FIREFOX_SCENARIOS = ['fresh-load', 'bfcache', 'bfcache-roundtrip'];

const browser = process.argv.includes('--browser=firefox') ? 'firefox' : 'chromium';
const args = process.argv.slice(2).filter((a) => !a.startsWith('--browser='));
const available = browser === 'firefox' ? FIREFOX_SCENARIOS : SCENARIOS;
const requested = args.length ? args : available;
const unknown = requested.filter((s) => !available.includes(s));
if (unknown.length) {
  console.error(`unknown scenario(s) for ${browser}: ${unknown.join(', ')}\navailable: ${available.join(', ')}`);
  process.exit(2);
}

const { server, base } = await startFixtureServer();
const results = [];

for (const name of requested) {
  const { ctx, sw } = await launchHarness(name, browser);
  try {
    const { run } = await import(`./scenarios/${name}.mjs`);
    const detail = await run({ ctx, sw, base, browser });
    results.push({ name, status: 'PASS', detail });
  } catch (e) {
    results.push({
      name,
      status: e instanceof Skip ? 'SKIP' : 'FAIL',
      detail: e.message,
    });
  } finally {
    await ctx.close().catch(() => {});
  }
}

server.close();

let failed = 0;
console.log(`\n=== lifecycle harness (${browser}) ===`);
for (const r of results) {
  console.log(`${r.status.padEnd(5)} ${r.name.padEnd(12)} ${r.detail}`);
  if (r.status === 'FAIL') failed++;
}
const skips = results.filter((r) => r.status === 'SKIP').length;
if (skips) console.log(`\n${skips} skip(s): those transitions were NOT covered this run.`);
process.exit(failed ? 1 : 0);
