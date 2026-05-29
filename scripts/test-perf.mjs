#!/usr/bin/env node
/**
 * Measure scan + hintability perf on the stress fixture in both modes.
 *
 * For each mode (aggressive off / on):
 * 1. Reset perf counters.
 * 2. Let the page churn for SOAK_MS while mutations fire.
 * 3. Read counters.
 * 4. Report scan rate, ms/scan, computed-style calls/scan, etc.
 *
 * Goal: identify hot path before optimizing. Numbers from this script
 * give a baseline; subsequent optimizations get measured against it.
 */

import { chromium } from 'playwright';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, rmSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const EXT = resolve(root, 'dist/chrome');
const FIXTURE = resolve(root, 'test-fixtures/perf-stress.html');
const PROFILE = '/tmp/branchkit-perf-test-profile';
const SOAK_MS = 10_000;

if (existsSync(PROFILE)) rmSync(PROFILE, { recursive: true });

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

async function setAggressive(on) {
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  await sw.evaluate(async (v) => {
    await chrome.storage.sync.set({ aggressiveHints: v });
  }, on);
}

async function runMode(label, on) {
  await setAggressive(on);
  const page = await ctx.newPage();
  await page.goto(`file://${FIXTURE}`);
  // Wait for first scan to settle (badge claims etc.)
  await page.waitForTimeout(1500);
  // Reset counters via the dataset bridge (content script runs in
  // isolated world; main-world page.evaluate can't call its globals
  // directly).
  await page.evaluate(() => { document.documentElement.dataset.branchkitResetPerf = '1'; });
  await page.waitForTimeout(400); // let the content script observe + reset
  const start = Date.now();
  await page.waitForTimeout(SOAK_MS);
  const elapsedMs = Date.now() - start;
  const stats = await page.evaluate(() => {
    const raw = document.documentElement.dataset.branchkitPerf;
    return raw ? JSON.parse(raw) : null;
  });
  await page.close();

  if (!stats) {
    console.log(`\n=== ${label} ===\n  branchkitPerfStats not exposed.`);
    return null;
  }
  console.log(`\n=== ${label} (${elapsedMs}ms soak) ===`);
  console.log(`  wrappers in store        ${stats.wrapperCount}`);
  console.log(`  scan calls (subtree)     ${stats.scanCalls}`);
  console.log(`    scan total ms          ${stats.scanTotalMs.toFixed(1)}`);
  console.log(`    scan avg ms            ${stats.scanCalls ? (stats.scanTotalMs / stats.scanCalls).toFixed(2) : '-'}`);
  console.log(`    candidates seen        ${stats.scanCandidatesSeen.toLocaleString()}`);
  console.log(`    kept as hintable       ${stats.scanKeptAsHintable}`);
  console.log(`    rejected: exclude      ${stats.scanRejectedExclude}`);
  console.log(`    rejected: invisible    ${stats.scanRejectedInvisible}`);
  console.log(`    rejected: redundant    ${stats.scanRejectedRedundant}`);
  console.log(`    rejected: extra-NC     ${stats.scanRejectedExtraNotClickable}`);
  console.log(`  scanSingle calls         ${stats.scanSingleCalls.toLocaleString()}`);
  console.log(`  isHintableExtra calls    ${stats.isHintableExtraCalls.toLocaleString()}`);
  console.log(`  getComputedStyle calls   ${stats.computedStyleCalls.toLocaleString()}`);
  console.log(`  getBoundingClientRect    ${stats.boundingRectCalls.toLocaleString()}`);
  return stats;
}

const off = await runMode('Aggressive hints OFF', false);
const on = await runMode('Aggressive hints ON', true);

if (off && on) {
  console.log('\n=== Delta (ON − OFF) ===');
  console.log(`  scan candidates  +${(on.scanCandidatesSeen - off.scanCandidatesSeen).toLocaleString()}`);
  console.log(`  scan total ms    +${(on.scanTotalMs - off.scanTotalMs).toFixed(1)}`);
  console.log(`  computedStyle    +${(on.computedStyleCalls - off.computedStyleCalls).toLocaleString()}`);
  console.log(`  wrappers added   +${on.wrapperCount - off.wrapperCount}`);
}

await ctx.close();
