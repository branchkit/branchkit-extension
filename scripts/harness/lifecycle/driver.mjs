/**
 * Lifecycle-harness driver (DESIGN_LIFECYCLE_HARNESS.md).
 *
 * Shared plumbing for every scenario: launches the isolated harness build
 * (through scripts/lib/launch.mjs — standalone marker, never joins a live
 * BranchKit), serves the lifecycle fixtures over HTTP (bfcache and
 * speculation-rules prerender require http, not file://), and exposes the
 * two protocol reads every scenario asserts on:
 *
 *   waitForBadges(page)  — painted badge hosts exist ([data-branchkit-hint])
 *   poolAudit(page)      — dispatch __branchkit__pool_audit, poll the
 *                          dataset mirror, return {held, unroutable, foreign}
 *
 * Scenarios PASS on `unroutable == [] && foreign == []`, FAIL on divergence,
 * and SKIP (loudly) when the browser didn't engage the transition under
 * automation (e.g. bfcache is often disabled under CDP) — a skip is never a
 * silent green.
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchExtension, launchFirefoxExtension } from '../../lib/launch.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../../..');
const FIXTURES = resolve(root, 'test-fixtures/lifecycle');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

export async function startFixtureServer() {
  const server = createServer((req, res) => {
    const path = resolve(FIXTURES, `.${new URL(req.url, 'http://x').pathname}`);
    if (!path.startsWith(FIXTURES) || !existsSync(path)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'text/plain' });
    res.end(readFileSync(path));
  });
  // Listen on all interfaces so both http://127.0.0.1 and http://localhost
  // (the bfcache scenario's cross-origin pair) resolve to this server.
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  return { server, base: `http://127.0.0.1:${port}` };
}

export async function launchHarness(profileSuffix, browser = 'chromium') {
  if (browser === 'firefox') {
    // Firefox: no SW handle (event-page background), no CDP, no default
    // bfcache-disable flag to strip. hintVisibility defaults to 'always'
    // in config.ts, so no seeding is needed.
    const { ctx } = await launchFirefoxExtension({
      profile: `/tmp/branchkit-lifecycle-ff-${profileSuffix}`,
    });
    return { ctx, sw: null, browser };
  }
  const { ctx, sw } = await launchExtension({
    profile: `/tmp/branchkit-lifecycle-${profileSuffix}`,
    extraArgs: [
      // Ask Chrome to keep bfcache/prerender live under automation; the
      // scenarios still verify engagement and SKIP loudly if the browser
      // declined (never assume the flag worked).
      '--enable-features=BackForwardCache,Prerender2',
    ],
    contextOptions: {
      // Chrome's own bfcache verdict named BackForwardCacheDisabledByCommandLine:
      // Playwright passes --disable-back-forward-cache by default. Drop it —
      // the bfcache scenario is meaningless with it in place.
      ignoreDefaultArgs: ['--disable-back-forward-cache'],
    },
  });
  // Badges paint automatically (the user's always-mode is the harness mode).
  await sw.evaluate(async () => {
    await chrome.storage.sync.set({ hintVisibility: 'always' });
  });
  return { ctx, sw, browser: 'chromium' };
}

export async function waitForBadges(page, { min = 1, timeout = 15_000 } = {}) {
  await page.waitForFunction(
    (n) => document.querySelectorAll('[data-branchkit-hint]').length >= n,
    min,
    { timeout },
  );
  return page.evaluate(() => document.querySelectorAll('[data-branchkit-hint]').length);
}

export async function poolAudit(page, { timeout = 10_000 } = {}) {
  await page.evaluate(() => {
    delete document.documentElement.dataset.branchkitPoolAudit;
    document.dispatchEvent(new CustomEvent('__branchkit__pool_audit'));
  });
  await page.waitForFunction(
    () => document.documentElement.dataset.branchkitPoolAudit !== undefined,
    undefined,
    { timeout },
  );
  const audit = JSON.parse(
    await page.evaluate(() => document.documentElement.dataset.branchkitPoolAudit),
  );
  if (audit.held === -1) throw new Error('pool audit: SW unreachable');
  return audit;
}

/** Assert the invariant; returns a human line for the runner. Covers both
 * halves of the audit: pool (every held label routes here) and paint (no
 * badge host stamped by a dead elder context — the orphan-paint tripwire). */
export function assertClean(audit, label) {
  const staleHosts = audit.stale_hosts ?? 0;
  if (audit.unroutable.length === 0 && audit.foreign.length === 0 && staleHosts === 0) {
    return `${label}: ${audit.held} held, all routable, no stale paint`;
  }
  throw new Error(
    `${label}: INVARIANT BROKEN — held=${audit.held} ` +
    `unroutable=[${audit.unroutable}] foreign=[${audit.foreign}] ` +
    `stale_hosts=${staleHosts} stale_docs=[${audit.stale_docs ?? []}]`,
  );
}

/** Read the layer-2 bfcache port-probe samples (debug/bfcache-probe.ts) and
 * render a compact verdict for the runner line. Report-only: the probe's
 * whole point is that the ground truth is unknown — never assert on it. */
export async function bfcacheProbeReport(page) {
  const raw = await page.evaluate(
    () => document.documentElement.dataset.branchkitBfcacheProbe,
  );
  if (!raw) return 'probe: no samples';
  const samples = JSON.parse(raw);
  return 'probe: ' + samples
    .map((s) => `${s.when}[ctx=${s.ctx_valid ? 'ok' : 'DEAD'} port=${s.port} sw=${s.sw_tracked}]`)
    .join(' ');
}

/** Loud skip — a transition the browser declined to engage under automation. */
export class Skip extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'Skip';
  }
}

/** Let the extension settle (debounced syncs, reconfirms) before auditing. */
export const settle = (ms = 2_000) => new Promise((r) => setTimeout(r, ms));
