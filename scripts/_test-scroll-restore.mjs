// Verifies that hints reappear after scroll-down-then-back-up.
// This is the Gmail mail-list bug class: user scrolls items way out
// of attention, scrolls back, hints should return.
import { chromium } from 'playwright';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, rmSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const EXT = resolve(root, 'dist/chrome');
const PROFILE = '/tmp/branchkit-scroll-restore-profile';

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
await sw.evaluate(async () => {
  await chrome.storage.sync.set({ hintVisibility: 'always' });
});

const page = await ctx.newPage();
// Long page that allows window scroll for many viewports.
await page.goto('https://github.com/anthropics/anthropic-cookbook/blob/main/README.md', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(8000);

async function snapshot(label) {
  return await page.evaluate((label) => {
    const snap = JSON.parse(document.documentElement.dataset.branchkitPerf || '{}');
    const hosts = document.querySelectorAll('[data-branchkit-hint]').length;
    return { label, scrollY: Math.round(window.scrollY), wrappers: snap.wrapperCount, hints: hosts };
  }, label);
}

const s0 = await snapshot('initial');
console.log(s0);

// Scroll far down (10 viewports worth)
const vh = await page.evaluate(() => window.innerHeight);
console.log(`viewport height: ${vh}, scrolling ${vh * 10}px down...`);
await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), vh * 10);
await page.waitForTimeout(3000);

const s1 = await snapshot('after scroll down 10vh');
console.log(s1);

// Scroll back to top
console.log('scrolling back to top...');
await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
await page.waitForTimeout(3000);

const s2 = await snapshot('after scroll back to top');
console.log(s2);

const ratio = s0.hints > 0 ? (s2.hints / s0.hints) : 0;
console.log(`\nhint restoration ratio: ${(ratio * 100).toFixed(0)}% (${s2.hints}/${s0.hints})`);
if (ratio < 0.7) {
  console.log('FAIL: hints did not restore on scroll-back (<70% recovered)');
} else {
  console.log('PASS: hints restored on scroll-back');
}

await ctx.close();
