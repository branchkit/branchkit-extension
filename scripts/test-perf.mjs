#!/usr/bin/env node
/**
 * Measure scan + hintability perf and memory cost in fixture or real-site
 * mode, single or multi-tab, optionally comparing against Rango.
 *
 * Per-engine signals fall in two buckets:
 * - Engine-agnostic (works for any extension): JS heap from
 *   `performance.memory`, sampled at t=0/5/15/30s for leak detection.
 *   Slope is the smoking gun for runaway processes.
 * - BranchKit-specific: the perf counters wired into scanner.ts, read via
 *   the documentElement.dataset bridge. Rango has no equivalent; in
 *   `engine=rango` mode the counter block is omitted from the per-tab
 *   report and the comparison is on memory + leak slope only.
 *
 * Examples:
 *   npm run test:perf
 *   npm run test:perf -- --url https://github.com/anthropics
 *   npm run test:perf -- --url https://www.reddit.com --tabs 3 --scroll
 *   npm run test:perf -- --engine=both --url https://news.ycombinator.com
 *
 * Rango path defaults to /tmp/rango/dist/chrome (built via
 * `cd /tmp/rango && npm i && npm run build:chrome`).
 */

import { chromium } from 'playwright';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, rmSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { launchExtension } from './lib/launch.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const FIXTURE = resolve(root, 'test-fixtures/perf-stress.html');

const { values: argv } = parseArgs({
  options: {
    url: { type: 'string', multiple: true },
    tabs: { type: 'string', default: '1' },
    soak: { type: 'string', default: '30' },
    engine: { type: 'string', default: 'branchkit' }, // branchkit|rango|both|none
    'rango-path': { type: 'string', default: '/tmp/rango/dist/chrome' },
    scroll: { type: 'boolean', default: false },
    headless: { type: 'boolean', default: false },
    warmup: { type: 'string', default: '2' },
  },
});

const warmupMs = Math.max(1, Number(argv.warmup)) * 1000;

const urls = argv.url && argv.url.length ? argv.url : [`file://${FIXTURE}`];
const tabsPerUrl = Math.max(1, Number(argv.tabs));
const soakMs = Math.max(1, Number(argv.soak)) * 1000;
const engines = argv.engine === 'both'
  ? ['branchkit', 'rango']
  : [argv.engine];

// Leak-detection sample points (ms from soak start). Final reading also
// happens at end-of-soak — but the per-window slope from these snapshots
// is what tells us "memory is climbing steadily" vs "flat after settle".
const SAMPLE_TIMES_MS = [0, 5_000, 15_000, 30_000].filter(t => t <= soakMs);
if (!SAMPLE_TIMES_MS.includes(soakMs)) SAMPLE_TIMES_MS.push(soakMs);
SAMPLE_TIMES_MS.sort((a, b) => a - b);

async function launchContext(engine) {
  const profile = `/tmp/branchkit-perf-${engine}-profile`;

  // BranchKit loads through the shared helper so the harness copy carries the
  // standalone marker — a perf run against a live host would both pollute the
  // user's session AND corrupt the measurement (SSE + grammar traffic).
  if (engine === 'branchkit') {
    const { ctx } = await launchExtension({
      profile,
      headless: argv.headless,
      extraArgs: ['--enable-precise-memory-info'], // un-buckets performance.memory
    });
    return ctx;
  }

  if (existsSync(profile)) rmSync(profile, { recursive: true });
  const args = ['--enable-precise-memory-info'];
  if (engine === 'rango') {
    if (!existsSync(argv['rango-path'])) {
      throw new Error(
        `Rango build not found at ${argv['rango-path']}. ` +
        `Build it: cd /tmp/rango && npm i && npm run build:chrome`,
      );
    }
    args.push(`--disable-extensions-except=${argv['rango-path']}`);
    args.push(`--load-extension=${argv['rango-path']}`);
  } // engine=none: no extension loaded — baseline page cost

  return chromium.launchPersistentContext(profile, {
    headless: argv.headless,
    args,
  });
}

async function setBranchKitAggressive(ctx, on) {
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  await sw.evaluate(async (v) => {
    await chrome.storage.sync.set({ aggressiveHints: v });
  }, on);
}

async function openTab(ctx, url) {
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch (err) {
    console.warn(`  load failed for ${url}: ${err.message}`);
  }
  // Warmup: let the extension's initial scan settle. Default is short
  // for snappy runs, but big-fixture pages need 5s+ for the per-batch
  // scan + grammar push round-trips to drain. Override with --warmup=S.
  await page.waitForTimeout(warmupMs);
  return page;
}

async function readMemory(page) {
  return page.evaluate(() => {
    const mem = performance.memory ? {
      usedMB: performance.memory.usedJSHeapSize / 1048576,
      totalMB: performance.memory.totalJSHeapSize / 1048576,
    } : null;
    // Read BranchKit's wrapperCount + limbo size via the same dataset
    // bridge the perf counters use. Engine-agnostic readers (Rango,
    // none) will see null — which is fine, we only graph when present.
    const raw = document.documentElement.dataset.branchkitPerf;
    const stats = raw ? JSON.parse(raw) : null;
    return mem
      ? { ...mem, wrapperCount: stats?.wrapperCount ?? null, limbo: stats?.wrapperLimboCount ?? null }
      : null;
  }).catch(() => null);
}

async function readBranchKitCounters(page) {
  return page.evaluate(() => {
    const raw = document.documentElement.dataset.branchkitPerf;
    return raw ? JSON.parse(raw) : null;
  }).catch(() => null);
}

async function resetBranchKitCounters(page) {
  await page.evaluate(() => {
    document.documentElement.dataset.branchkitResetPerf = '1';
  }).catch(() => { });
}

async function scrollTab(page) {
  await page.evaluate(() => {
    window.scrollBy(0, 500);
  }).catch(() => { });
}

function fmt(n, digits = 0) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return String(n);
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function fmtSlope(samples) {
  // samples: [{ t, usedMB }]. Returns "+X.XMB over Yms (Z.ZMB/min)"
  if (samples.length < 2) return 'n/a';
  const first = samples[0];
  const last = samples[samples.length - 1];
  const dMB = last.usedMB - first.usedMB;
  const dMs = last.t - first.t;
  const perMin = (dMB / dMs) * 60_000;
  const sign = dMB >= 0 ? '+' : '';
  return `${sign}${fmt(dMB, 2)}MB over ${fmt(dMs)}ms (${sign}${fmt(perMin, 2)}MB/min)`;
}

async function runEngine(engine) {
  console.log(`\n========================================`);
  console.log(`  ENGINE: ${engine}`);
  console.log(`========================================`);

  const ctx = await launchContext(engine);
  if (engine === 'branchkit') {
    // Aggressive hints ON gives the worst-case workload — that's what we
    // want to stress, since the OFF mode does essentially nothing on
    // div-heavy pages.
    await setBranchKitAggressive(ctx, true);
  }

  const tabs = [];
  for (const url of urls) {
    for (let i = 0; i < tabsPerUrl; i++) {
      console.log(`  opening ${url}  (tab ${i + 1}/${tabsPerUrl})`);
      const page = await openTab(ctx, url);
      tabs.push({ url, idx: i + 1, page });
    }
  }

  // Reset BranchKit counters in parallel — for Rango/none this is a no-op.
  if (engine === 'branchkit') {
    await Promise.all(tabs.map(t => resetBranchKitCounters(t.page)));
    await new Promise(r => setTimeout(r, 400));
  }

  // Leak sampling: snapshot heap at each sample point during the soak.
  // Tab samples are taken in parallel so a slow-respond tab doesn't skew
  // others' timestamps.
  const samples = tabs.map(() => []);
  const scrollTimer = argv.scroll
    ? setInterval(() => { for (const t of tabs) scrollTab(t.page); }, 1000)
    : null;

  const soakStart = Date.now();
  for (const sampleAt of SAMPLE_TIMES_MS) {
    const waitMs = sampleAt - (Date.now() - soakStart);
    if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
    const t = Date.now() - soakStart;
    const mems = await Promise.all(tabs.map(tab => readMemory(tab.page)));
    for (let i = 0; i < tabs.length; i++) {
      if (mems[i]) samples[i].push({ t, ...mems[i] });
    }
  }

  if (scrollTimer) clearInterval(scrollTimer);

  const finalCounters = engine === 'branchkit'
    ? await Promise.all(tabs.map(t => readBranchKitCounters(t.page)))
    : tabs.map(() => null);

  await Promise.all(tabs.map(t => t.page.close().catch(() => { })));

  // Per-tab report
  let aggHeapStartMB = 0;
  let aggHeapEndMB = 0;
  let aggHeapPeakMB = 0;
  let aggWrappers = 0;
  let aggScans = 0;
  let aggScanMs = 0;
  let aggCandidates = 0;
  let aggGCS = 0;
  let aggBCR = 0;
  let tabsWithMem = 0;
  let tabsWithCounters = 0;

  for (let i = 0; i < tabs.length; i++) {
    const { url, idx } = tabs[i];
    const ts = samples[i];
    const c = finalCounters[i];
    console.log(`\n  ${url}  [tab ${idx}]`);
    if (ts.length === 0) {
      console.log(`    (no memory readings — performance.memory unavailable)`);
    } else {
      tabsWithMem++;
      const peak = Math.max(...ts.map(s => s.usedMB));
      console.log(`    heap samples       ${ts.map(s => `t=${(s.t / 1000).toFixed(0)}s ${fmt(s.usedMB, 1)}MB`).join(' | ')}`);
      console.log(`    heap slope         ${fmtSlope(ts)}`);
      console.log(`    heap peak          ${fmt(peak, 1)}MB`);
      if (ts.some(s => s.wrapperCount !== null)) {
        console.log(`    wrapper samples    ${ts.map(s =>
          `t=${(s.t / 1000).toFixed(0)}s w=${s.wrapperCount}${s.limbo ? `+${s.limbo}L` : ''}`,
        ).join(' | ')}`);
      }
      aggHeapStartMB += ts[0].usedMB;
      aggHeapEndMB += ts[ts.length - 1].usedMB;
      aggHeapPeakMB += peak;
    }
    if (c) {
      tabsWithCounters++;
      console.log(`    wrappers           ${fmt(c.wrapperCount)}`);
      console.log(`    scans              ${fmt(c.scanCalls)} (${fmt(c.scanTotalMs, 1)}ms total, ${fmt(c.scanCalls ? c.scanTotalMs / c.scanCalls : 0, 2)}ms avg)`);
      console.log(`    candidates         ${fmt(c.scanCandidatesSeen)}`);
      console.log(`    scanSingle calls   ${fmt(c.scanSingleCalls)}`);
      console.log(`    getComputedStyle   ${fmt(c.computedStyleCalls)}`);
      console.log(`    getBoundingRect    ${fmt(c.boundingRectCalls)}`);
      if (c.wrapperDisconnectedOutOfLimbo !== undefined) {
        console.log(`    limbo (final)      ${fmt(c.wrapperLimboCount)} (disc-not-limbo ${fmt(c.wrapperDisconnectedOutOfLimbo)})`);
      }
      if (c.lifecycleCounters) {
        const l = c.lifecycleCounters;
        console.log(`    MO callback        ${fmt(l.moCallbackInvocations)} fires, ${fmt(l.moForeignRecords)} foreign records, ${fmt(l.moHugePathFired)} huge path`);
        console.log(`    processMutations   ${fmt(l.processMutationsCalls)} calls, ${fmt(l.moRemoveRecordsSeen)} remove records seen`);
        console.log(`    dropDisc           ${fmt(l.dropDisconnectedCalls)} calls, ${fmt(l.dropDisconnectedFound)} found`);
        console.log(`    finalize           ${fmt(l.finalizeSweeps)} sweeps, ${fmt(l.finalizeDetached)} detached`);
      }
      if (c.messages) {
        const m = c.messages;
        const kb = (m.bytes / 1024).toFixed(1);
        console.log(`    messages out       ${fmt(m.total)} (${kb}KB)`);
        const byType = Object.entries(m.byType)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `${k}=${fmt(v)}`)
          .join(' ');
        if (byType) console.log(`      by type          ${byType}`);
      }
      if (c.targetRectStore) {
        const t = c.targetRectStore;
        console.log(`    rect store         size=${fmt(t.size)} subs=${fmt(t.subscribers)} drift=${fmt(t.drift.drifted)}/${fmt(t.drift.sampled)} max=${fmt(t.drift.maxDriftPx, 1)}px`);
      }
      if (c.cpu) {
        const sorted = Object.entries(c.cpu.buckets)
          .sort((a, b) => b[1].maxMs - a[1].maxMs);
        if (sorted.length) {
          console.log(`    cpu buckets (sorted by maxMs)`);
          for (const [k, b] of sorted) {
            const avg = b.count ? b.totalMs / b.count : 0;
            console.log(`      ${k.padEnd(26)} count=${fmt(b.count)} total=${fmt(b.totalMs, 1)}ms max=${fmt(b.maxMs, 1)}ms avg=${fmt(avg, 2)}ms`);
          }
        }
        const lt = c.cpu.longtask;
        if (lt.supported) {
          console.log(`    longtask           count=${fmt(lt.count)} total=${fmt(lt.totalMs, 1)}ms max=${fmt(lt.maxMs, 1)}ms`);
          if (lt.top.length) {
            const topStr = lt.top.slice(0, 3).map(t => `${fmt(t.ms, 0)}ms`).join(', ');
            console.log(`      top 3 by ms      ${topStr}`);
          }
        } else {
          console.log(`    longtask           (not supported in this browser)`);
        }
      }
      aggWrappers += c.wrapperCount;
      aggScans += c.scanCalls;
      aggScanMs += c.scanTotalMs;
      aggCandidates += c.scanCandidatesSeen;
      aggGCS += c.computedStyleCalls;
      aggBCR += c.boundingRectCalls;
    }
  }

  if (tabs.length > 1 && (tabsWithMem > 0 || tabsWithCounters > 0)) {
    console.log(`\n  --- Aggregate across ${tabs.length} tabs ---`);
    if (tabsWithMem > 0) {
      console.log(`    heap (sum start)   ${fmt(aggHeapStartMB, 1)}MB`);
      console.log(`    heap (sum end)     ${fmt(aggHeapEndMB, 1)}MB`);
      console.log(`    heap (sum peak)    ${fmt(aggHeapPeakMB, 1)}MB`);
      console.log(`    heap growth        ${fmt(aggHeapEndMB - aggHeapStartMB, 1)}MB`);
    }
    if (tabsWithCounters > 0) {
      console.log(`    wrappers (sum)     ${fmt(aggWrappers)}`);
      console.log(`    scans (sum)        ${fmt(aggScans)}`);
      console.log(`    scan ms (sum)      ${fmt(aggScanMs, 1)}`);
      console.log(`    GCS (sum)          ${fmt(aggGCS)}`);
      console.log(`    BCR (sum)          ${fmt(aggBCR)}`);
    }
  }

  await ctx.close();

  return {
    engine,
    tabCount: tabs.length,
    heapStartMB: aggHeapStartMB,
    heapEndMB: aggHeapEndMB,
    heapPeakMB: aggHeapPeakMB,
    growthMB: aggHeapEndMB - aggHeapStartMB,
  };
}

const results = [];
for (const e of engines) {
  results.push(await runEngine(e));
}

if (results.length > 1) {
  console.log(`\n========================================`);
  console.log(`  CROSS-ENGINE COMPARISON`);
  console.log(`========================================`);
  console.log(`  ${'engine'.padEnd(12)} ${'start'.padStart(10)} ${'end'.padStart(10)} ${'peak'.padStart(10)} ${'growth'.padStart(10)}`);
  for (const r of results) {
    console.log(`  ${r.engine.padEnd(12)} ${(fmt(r.heapStartMB, 1) + 'MB').padStart(10)} ${(fmt(r.heapEndMB, 1) + 'MB').padStart(10)} ${(fmt(r.heapPeakMB, 1) + 'MB').padStart(10)} ${(fmt(r.growthMB, 1) + 'MB').padStart(10)}`);
  }
  // Ratio relative to first engine (typically BranchKit)
  const base = results[0];
  for (let i = 1; i < results.length; i++) {
    const r = results[i];
    if (base.heapEndMB > 0) {
      const x = r.heapEndMB / base.heapEndMB;
      console.log(`  ${r.engine} vs ${base.engine}: end-heap ${fmt(x, 2)}×`);
    }
    if (base.growthMB !== 0) {
      const x = r.growthMB / base.growthMB;
      console.log(`  ${r.engine} vs ${base.engine}: growth ${fmt(x, 2)}×`);
    }
  }
}
