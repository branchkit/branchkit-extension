#!/usr/bin/env node
/**
 * Drive the REAL popup edit flow: open the popup page (with
 * chrome.tabs.query stubbed to return the fixture tab), click the entry's
 * edit pencil, change the nudge X offset, click Save — then check both
 * what landed in chrome.storage.sync and whether the fixture page's
 * badges moved.
 *
 * Usage: node scripts/verify-nudge-popup.mjs
 */

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchExtension } from './lib/launch.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const PORT = 8935;
const PROFILE = '/tmp/branchkit-verify-nudge-popup-profile';

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

// Seed one nudge rule the popup will show for the fixture host.
await sw.evaluate((payload) => chrome.storage.sync.set(payload), {
  domainRules: {
    rules: [{
      id: 'r-verify',
      pattern: 'localhost',
      enabled: true,
      entries: [{
        id: 'e-verify',
        kind: 'nudge',
        matcher: { type: 'css', selector: 'a' },
        nudge: { dx: 100, dy: 50 },
      }],
    }],
  },
});

const fixturePage = await ctx.newPage();
await fixturePage.goto(`http://localhost:${PORT}/`);
await fixturePage.waitForTimeout(2500);

async function badgeXs() {
  return fixturePage.evaluate(() => {
    const out = [];
    for (const host of document.querySelectorAll('[data-branchkit-hint]')) {
      const m = /translate\(([-\d.]+)px/.exec(host.style.transform || '');
      if (m) out.push(parseFloat(m[1]));
    }
    return out;
  });
}

const before = await badgeXs();
if (before.length === 0) {
  console.error('FAIL: no badges on fixture');
  process.exit(1);
}

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

const entryText = await popup.evaluate(() =>
  Array.from(document.querySelectorAll('.entry-text')).map((e) => e.textContent));
console.log('popup entry rows:', entryText);

const editCount = await popup.locator('.entry-edit').count();
if (editCount === 0) {
  console.error('FAIL: no edit button rendered in popup');
  process.exit(1);
}
await popup.locator('.entry-edit').first().click();
await popup.waitForTimeout(200);

const formState = await popup.evaluate(() => {
  const matcher = document.querySelector('.add-entry input.matcher');
  const nudgeInputs = Array.from(document.querySelectorAll('.add-entry input.nudge-px'));
  const addBtn = document.querySelector('.add-entry button.primary');
  const nudgeRow = document.querySelector('.add-entry .nudge-row');
  return {
    matcherValue: matcher?.value,
    matcherWidth: matcher?.getBoundingClientRect().width,
    nudgeValues: nudgeInputs.map((i) => i.value),
    nudgeRowHidden: nudgeRow?.hidden,
    addBtnText: addBtn?.textContent,
  };
});
console.log('edit form state:', JSON.stringify(formState));

// Change X offset 100 → -40. Live write-through: the value must land in
// storage BEFORE Save is clicked (debounced 400ms).
await popup.locator('.add-entry input.nudge-px').first().fill('-40');
await popup.waitForTimeout(900);
const liveStored = await sw.evaluate(() => chrome.storage.sync.get('domainRules'));
const liveDx = liveStored.domainRules?.rules?.[0]?.entries?.[0]?.nudge?.dx;
console.log(`live (pre-Save) stored dx: ${liveDx} (expected -40)`);
if (liveDx !== -40) {
  console.error('FAIL: live write-through did not apply before Save');
  process.exit(1);
}
await popup.locator('.add-entry button.primary').first().click();
await popup.waitForTimeout(300);

const stored = await sw.evaluate(() => chrome.storage.sync.get('domainRules'));
console.log('stored after Save:', JSON.stringify(stored.domainRules?.rules?.[0]?.entries));

await fixturePage.waitForTimeout(1200);
const after = await badgeXs();

// --- Authoring preview: a NEW nudge moves badges BEFORE Add is clicked ---
await popup.locator('.add-entry select').first().selectOption('nudge');
await popup.locator('.add-entry input.matcher').fill('a');
await popup.locator('.add-entry input.nudge-px').first().fill('200');
await popup.waitForTimeout(1000); // 200ms debounce + port + re-place
const previewXs = await badgeXs();
// The preview entry is prepended (first-match-wins), so it overrides the
// stored dx -40 entirely: delta vs `after` should be 200 - (-40) = 240.
const previewDelta = previewXs[0] - after[0];
console.log(`preview (pre-Add) badge x: ${after[0]} -> ${previewXs[0]} (delta ${previewDelta}, expected 240)`);

// Add commits the rule; the preview lifts after the real rule lands. The
// NEW entry appends after the original, which still matches first — so
// badges settle back to the original entry's offset.
await popup.locator('.add-entry button.primary').first().click();
await popup.waitForTimeout(1800);
const committed = await sw.evaluate(() => chrome.storage.sync.get('domainRules'));
const entryCount = committed.domainRules?.rules?.[0]?.entries?.length;
const settledXs = await badgeXs();
console.log(`entries after Add: ${entryCount} (expected 2); settled x: ${settledXs[0]} (expected ${after[0]})`);

server.close();
await ctx.close();

if (Math.abs(previewDelta - 240) > 2) {
  console.error('FAIL: authoring preview did not move badges before Add');
  process.exit(1);
}
if (entryCount !== 2 || Math.abs(settledXs[0] - after[0]) > 2) {
  console.error('FAIL: Add did not commit cleanly / preview did not lift');
  process.exit(1);
}

const movedBy = after.length && before.length ? after[0] - before[0] : NaN;
console.log(`badge x before/after: ${before[0]} -> ${after[0]} (delta ${movedBy}, expected -140)`);

const storedDx = stored.domainRules?.rules?.[0]?.entries?.[0]?.nudge?.dx;
if (storedDx !== -40) {
  console.error(`FAIL: popup Save wrote dx=${storedDx}, expected -40 (popup-side bug)`);
  process.exit(1);
}
if (Math.abs(movedBy + 140) > 2) {
  console.error('FAIL: storage updated but badges did not move (content-side bug)');
  process.exit(1);
}
console.log('PASS');
