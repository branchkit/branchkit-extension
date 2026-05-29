// Quick: load extension, set hint_visibility='always', open a simple page,
// check whether hint badges actually render in the DOM.
import { chromium } from 'playwright';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, rmSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const EXT = resolve(root, 'dist/chrome');
const PROFILE = '/tmp/branchkit-hints-test-profile';

if (existsSync(PROFILE)) rmSync(PROFILE, { recursive: true });

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  args: [
    '--disable-extensions-except=' + EXT,
    '--load-extension=' + EXT,
    '--enable-precise-memory-info',
  ],
});

const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');

// Set hintVisibility='always' so badges paint automatically (camelCase
// is the key the content script actually reads).
await sw.evaluate(async () => {
  await chrome.storage.sync.set({ hintVisibility: 'always' });
});

const page = await ctx.newPage();
await page.goto('https://github.com/anthropics/anthropic-cookbook', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(8000);  // let initial scan + grammar push settle

const result = await page.evaluate(() => {
  const snap = document.documentElement.dataset.branchkitPerf
    ? JSON.parse(document.documentElement.dataset.branchkitPerf)
    : null;
  // Hint badges are rendered as shadow-host elements with a known class.
  // Look for branchkit hint badge hosts (the wrapper around shadow root).
  const hintHosts = Array.from(document.querySelectorAll('[data-branchkit-hint]'));
  // Fallback: any element from the extension's hint pattern
  const allShadowHosts = Array.from(document.querySelectorAll('*'))
    .filter(el => el.shadowRoot)
    .filter(el => el.shadowRoot.querySelector('[class*="hint"]'));
  return {
    wrapperCount: snap?.wrapperCount ?? 'no snapshot',
    snapshot_present: !!snap,
    hint_data_hosts: hintHosts.length,
    shadow_hint_hosts: allShadowHosts.length,
    bridge_keys: snap ? Object.keys(snap) : [],
  };
});

console.log(JSON.stringify(result, null, 2));
await page.screenshot({ path: '/tmp/branchkit-hints-test.png', fullPage: false });
console.log('screenshot at /tmp/branchkit-hints-test.png');

await ctx.close();
