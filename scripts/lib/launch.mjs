/**
 * Shared Playwright launch helper for the extension test harness.
 *
 * Every harness script MUST launch through this (enforced by
 * src/harness-isolation.test.ts's ratchet). It exists because a harness
 * browser that loads the raw dist/ connects to a LIVE BranchKit like any
 * real browser — it claims OS focus and projects its fixture grammar/tab
 * words into the user's session (incident 2026-07-02, see
 * notes/DESIGN_EXTENSION_CONNECTION_HEALTH.md piece B).
 *
 * Isolation mechanism: the helper copies dist/<browser> to a per-profile
 * staging dir and drops a `harness.json` marker into the copy; the
 * extension's actuator-client checks that packaged resource BEFORE its
 * boot-time discovery, so the harness build is deterministically standalone.
 * A copied dir (not a second build flavor) so tests exercise byte-identical
 * code, and a packaged marker (not a storage flag) because storage seeding
 * via sw.evaluate races the SW's boot-time discovery.
 *
 * Live-plugin tests opt in with {allowDiscovery: true} — and even then the
 * pre-flight refuses to run against a REACHABLE live actuator unless
 * BRANCHKIT_ALLOW_LIVE=1 is set, so joining a user's session is always a
 * conscious act.
 */

import { chromium, firefox } from 'playwright';
import { withExtension } from 'playwright-webextext/dist/factory.js';
import { cpSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');
const ACTUATOR_URL = 'http://127.0.0.1:21551';

/**
 * Launch a persistent Chromium context with the extension loaded.
 *
 * @param {object} opts
 * @param {string} opts.profile - persistent profile dir (wiped when freshProfile)
 * @param {boolean} [opts.allowDiscovery=false] - let the extension discover a
 *   live BranchKit host. Requires BRANCHKIT_ALLOW_LIVE=1 when one is reachable.
 * @param {boolean} [opts.freshProfile=true] - rm -rf the profile first
 * @param {boolean} [opts.headless=false]
 * @param {string[]} [opts.extraArgs=[]] - appended to the extension args
 * @param {object} [opts.contextOptions={}] - extra launchPersistentContext options
 * @returns {Promise<{ctx: import('playwright').BrowserContext,
 *   sw: import('playwright').Worker, extDir: string}>}
 */
export async function launchExtension({
  profile,
  allowDiscovery = false,
  freshProfile = true,
  headless = false,
  extraArgs = [],
  contextOptions = {},
} = {}) {
  if (!profile) throw new Error('launchExtension: profile is required');

  const dist = resolve(root, 'dist/chrome');
  if (!existsSync(resolve(dist, 'manifest.json'))) {
    throw new Error(`No manifest at ${dist}/manifest.json — run \`npm run build:chrome\` first.`);
  }

  let extDir = dist;
  if (allowDiscovery) {
    await preflightLiveActuator();
  } else {
    // Stage a marked copy next to the profile so parallel harnesses don't
    // fight over one staging dir.
    extDir = `${profile}-ext`;
    if (existsSync(extDir)) rmSync(extDir, { recursive: true });
    cpSync(dist, extDir, { recursive: true });
    writeFileSync(
      resolve(extDir, 'harness.json'),
      JSON.stringify({ discovery: 'disabled', staged_from: dist }) + '\n',
    );
  }

  if (freshProfile && existsSync(profile)) rmSync(profile, { recursive: true });

  const ctx = await chromium.launchPersistentContext(profile, {
    headless,
    args: [
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
      ...extraArgs,
    ],
    ...contextOptions,
  });
  const sw = ctx.serviceWorkers()[0]
    ?? await ctx.waitForEvent('serviceworker', { timeout: 10_000 });
  return { ctx, sw, extDir };
}

/**
 * Launch a persistent Firefox context with the extension loaded
 * (playwright-webextext). Same isolation contract as launchExtension:
 * default is a staged harness.json-marked copy (standalone); live tests
 * opt in with {allowDiscovery: true} and pass the same pre-flight.
 *
 * @param {object} opts
 * @param {string} opts.profile - persistent profile dir (wiped when freshProfile)
 * @param {boolean} [opts.allowDiscovery=false]
 * @param {boolean} [opts.freshProfile=true]
 * @param {boolean} [opts.headless=false]
 * @param {object} [opts.firefoxUserPrefs={}]
 * @param {object} [opts.contextOptions={}]
 * @returns {Promise<{ctx: import('playwright').BrowserContext, extDir: string}>}
 */
export async function launchFirefoxExtension({
  profile,
  allowDiscovery = false,
  freshProfile = true,
  headless = false,
  firefoxUserPrefs = {},
  contextOptions = {},
} = {}) {
  if (!profile) throw new Error('launchFirefoxExtension: profile is required');

  const dist = resolve(root, 'dist/firefox');
  if (!existsSync(resolve(dist, 'manifest.json'))) {
    throw new Error(`No manifest at ${dist}/manifest.json — run \`npm run build:firefox\` first.`);
  }

  let extDir = dist;
  if (allowDiscovery) {
    await preflightLiveActuator();
  } else {
    extDir = `${profile}-ext`;
    if (existsSync(extDir)) rmSync(extDir, { recursive: true });
    cpSync(dist, extDir, { recursive: true });
    writeFileSync(
      resolve(extDir, 'harness.json'),
      JSON.stringify({ discovery: 'disabled', staged_from: dist }) + '\n',
    );
  }

  if (freshProfile && existsSync(profile)) rmSync(profile, { recursive: true });

  const ctx = await withExtension(firefox, extDir).launchPersistentContext(profile, {
    headless,
    firefoxUserPrefs,
    ...contextOptions,
  });
  return { ctx, extDir };
}

/**
 * Refuse to run a discovery-enabled harness against a live actuator unless
 * explicitly permitted. Reachable actuator = a user session this browser
 * would join, steal focus from, and pollute.
 */
async function preflightLiveActuator() {
  let reachable = false;
  try {
    const resp = await fetch(`${ACTUATOR_URL}/plugins`, { signal: AbortSignal.timeout(1500) });
    reachable = resp.ok;
  } catch {
    // Not reachable — safe to proceed.
  }
  if (reachable && process.env.BRANCHKIT_ALLOW_LIVE !== '1') {
    console.error(
      `\nA live BranchKit actuator is reachable at ${ACTUATOR_URL} and this harness\n` +
      'run has allowDiscovery enabled. Joining it would let the test browser claim\n' +
      "OS focus and project fixture grammar into the live session (2026-07-02\n" +
      'incident). Stop BranchKit first, or re-run with BRANCHKIT_ALLOW_LIVE=1 if\n' +
      'you mean to test against the live host.\n',
    );
    process.exit(2);
  }
}
