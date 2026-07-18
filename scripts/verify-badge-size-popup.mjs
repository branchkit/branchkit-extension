#!/usr/bin/env node
/**
 * Drive the REAL popup badge-size flow: open the popup page (with
 * chrome.tabs.query stubbed to return the fixture tab), drag the rule
 * card's "Badge size" slider, and check that (a) the debounced live save
 * lands rule.badgeSizePx in chrome.storage.sync, (b) the fixture page's
 * badges resize, and (c) the × clear button removes the override and the
 * badges revert.
 *
 * Usage: node scripts/verify-badge-size-popup.mjs
 */

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchExtension } from './lib/launch.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const PORT = 8936;
const PROFILE = '/tmp/branchkit-verify-badge-size-popup-profile';

const fixture = readFileSync(resolve(root, 'test-fixtures/scrollable-sidebar.html'), 'utf8');
const server = http.createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(fixture);
});
await new Promise((r) => server.listen(PORT, r));

const { ctx } = await launchExtension({ profile: PROFILE, freshProfile: true });

let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;

// Seed a rule (no size override yet) so the popup shows a rule card.
await sw.evaluate((payload) => chrome.storage.sync.set(payload), {
  domainRules: {
    rules: [{
      id: 'r-verify',
      pattern: 'localhost',
      enabled: true,
      entries: [{
        id: 'e-verify',
        kind: 'exclude',
        matcher: { type: 'css', selector: '.no-such-thing' },
      }],
    }],
  },
});

const fixturePage = await ctx.newPage();
await fixturePage.goto(`http://localhost:${PORT}/`);
await fixturePage.evaluate(() => localStorage.setItem('bkOpenShadow', '1'));
await fixturePage.reload({ waitUntil: 'domcontentloaded' });
await fixturePage.waitForTimeout(2500);

async function dominantBadgeFont() {
  return fixturePage.evaluate(() => {
    const counts = new Map();
    for (const host of document.querySelectorAll('[data-branchkit-hint]')) {
      const inner = host.shadowRoot?.querySelector('.bk-inner');
      if (!inner) continue;
      const px = parseFloat(inner.style.fontSize);
      if (Number.isFinite(px)) counts.set(px, (counts.get(px) ?? 0) + 1);
    }
    let best = null;
    for (const [px, count] of counts) if (!best || count > best.count) best = { px, count };
    return best;
  });
}

const fail = async (msg) => {
  console.error(`FAIL: ${msg}`);
  server.close();
  await ctx.close();
  process.exit(1);
};

const before = await dominantBadgeFont();
console.log('baseline badge font:', before);
if (!before) await fail('no open-shadow badges on the fixture');

// Open the popup with tabs.query stubbed to point at the fixture tab.
const popup = await ctx.newPage();
await popup.addInitScript(({ port }) => {
  if (typeof chrome !== 'undefined' && chrome.tabs?.query) {
    const orig = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = () => orig({ url: `http://localhost:${port}/*` });
  }
}, { port: PORT });
await popup.goto(`chrome-extension://${extId}/popup.html`);
await popup.waitForTimeout(800);

const rowState = await popup.evaluate(() => {
  const slider = document.querySelector('.badge-size-slider');
  const num = document.querySelector('.badge-size-num');
  const clear = document.querySelector('.badge-size-clear');
  return slider && num && clear ? {
    sliderValue: slider.value,
    numValue: num.value,
    numPlaceholder: num.placeholder,
    clearHidden: clear.hidden,
  } : null;
});
console.log('badge-size row state:', JSON.stringify(rowState));
if (!rowState) await fail('no badge-size row rendered on the rule card');
if (rowState.numValue !== '' || !rowState.clearHidden) {
  await fail('override-free rule should show the empty "use global" state');
}

// Drag the slider to its 16px max — fill() fires `input`, the live-apply
// path. On the fixture's 16px links: round(16 × 16/14) = 18px badges.
await popup.locator('.badge-size-slider').fill('16');
await popup.waitForTimeout(900); // 400ms debounced save + settle

const stored = await sw.evaluate(() => chrome.storage.sync.get('domainRules'));
const storedPx = stored.domainRules?.rules?.[0]?.badgeSizePx;
console.log(`stored badgeSizePx after slider drag: ${storedPx} (expected 16)`);
if (storedPx !== 16) await fail('slider drag did not live-save rule.badgeSizePx');

await fixturePage.waitForTimeout(2000);
const resized = await dominantBadgeFont();
console.log('badge font under override:', resized);
if (resized?.px !== 18) await fail(`badges did not resize to 18px, got ${JSON.stringify(resized)}`);

// Clear back to global.
await popup.locator('.badge-size-clear').click();
await popup.waitForTimeout(900);
const cleared = await sw.evaluate(() => chrome.storage.sync.get('domainRules'));
const clearedPx = cleared.domainRules?.rules?.[0]?.badgeSizePx;
console.log(`stored badgeSizePx after clear: ${clearedPx} (expected undefined)`);
if (clearedPx !== undefined) await fail('clear button did not remove the override');

await fixturePage.waitForTimeout(2000);
const reverted = await dominantBadgeFont();
console.log('badge font after clear:', reverted);
if (reverted?.px !== before.px) await fail(`badges did not revert to ${before.px}px, got ${JSON.stringify(reverted)}`);

server.close();
await ctx.close();
console.log('PASS');
