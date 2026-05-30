// Correctness check for the CSS Anchor Positioning fast-path in the LIVE
// extension. Loads dist/chrome, enables aggressive hints so badges paint
// without voice, opens a fixture with an inner overflow-scroll pane of real
// buttons, then verifies a badge host tracks its target across an inner-pane
// scroll — with no JS scroll listener involved (compositor only).
//
// Matching: anchor mode sets `anchor-name:--bk-N` inline on the target and
// `position-anchor:--bk-N` on the body-mounted host. We pair them by name.

import { chromium } from 'playwright';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, rmSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const EXT = resolve(root, 'dist/chrome');

// Content scripts match <all_urls> but Chrome excludes file:// without file
// access. Serve the fixture over http://localhost so the content script runs.
const fixtureHtml = readFileSync(resolve(root, 'test-fixtures/inner-scroll-hints.html'), 'utf8');
const server = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(fixtureHtml);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const FIXTURE = `http://127.0.0.1:${server.address().port}/`;

const profile = '/tmp/branchkit-anchor-verify-profile';
if (existsSync(profile)) rmSync(profile, { recursive: true });

const ctx = await chromium.launchPersistentContext(profile, {
  headless: false,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
  ],
});

const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
// Seed an alphabet so showHints() doesn't bail at isAlphabetLoaded(). Normally
// BranchKit pushes this over SSE; here we inject 26 words straight into storage.
const ALPHABET = 'arch bat cat dog echo fox golf hotel india jam kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu'.split(' ');
await sw.evaluate(async (a) => {
  await chrome.storage.sync.set({ aggressiveHints: true, hintVisibility: 'always' });
  await chrome.storage.local.set({ alphabet: a });
}, ALPHABET);

const page = await ctx.newPage();
await page.goto(FIXTURE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000); // let scan + grammar round-trips + paint settle

async function measure(pinId) {
  return page.evaluate((pin) => {
    // Find targets inside the pane that carry an anchor-name. The page churns
    // anchor-names on rescan, so we pin by the button's stable id (btn-N) and
    // read its CURRENT anchor-name each time.
    const pane = document.getElementById('pane');
    const targets = [...document.querySelectorAll('[style*="anchor-name"]')]
      .filter(t => pane.contains(t) && t.id);
    if (!targets.length) return { ok: false, reason: 'no anchored targets found', anchoredCount: 0 };

    const pr = pane.getBoundingClientRect();
    // Prefer a target in the lower-middle of the pane: a small downward
    // content scroll moves it UP toward center, so it stays visible (and keeps
    // its badge) — letting us track ONE pair across the scroll.
    const visible = targets
      .filter(t => {
        const r = t.getBoundingClientRect();
        return r.top >= pr.top && r.bottom <= pr.bottom;
      })
      .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
    const target = pin
      ? targets.find(t => t.id === pin)
      : (visible[1] || visible[0] || targets[0]);
    if (!target) return { ok: false, reason: `pinned target #${pin} lost anchor-name`, anchoredCount: targets.length };

    const id = target.id;
    const name = target.style.getPropertyValue('anchor-name');
    const hosts = [...document.querySelectorAll('[data-branchkit-hint]')]
      .filter(h => h.style.getPropertyValue('position-anchor') === name);
    if (!hosts.length) return { ok: false, reason: `no host with position-anchor ${name}`, anchoredCount: targets.length };

    const t = target.getBoundingClientRect();
    const h = hosts[0].getBoundingClientRect();
    return {
      ok: true,
      id,
      name,
      anchoredCount: targets.length,
      target: { top: Math.round(t.top), left: Math.round(t.left) },
      host: { top: Math.round(h.top), left: Math.round(h.left) },
      delta: { dy: Math.round(h.top - t.top), dx: Math.round(h.left - t.left) },
      paneScrollTop: pane.scrollTop,
    };
  }, pinId);
}

const before = await measure();
console.log('before scroll:', before);
if (!before.ok) { console.log('FAIL —', before.reason); await ctx.close(); process.exit(1); }

// Scroll the inner pane a small amount (NOT the window) — small enough that
// the pinned target stays in the viewport (badge survives), large enough to
// prove the host tracks it via the compositor.
await page.evaluate(() => { document.getElementById('pane').scrollTop = 40; });
await page.waitForTimeout(400);

const after = await measure(before.id);
console.log('after inner scroll:', after);

console.log('\n--- Analysis ---');
if (!after.ok) {
  console.log('FAIL —', after.reason);
  await ctx.close();
  server.close();
  process.exit(1);
}
const tracked = after.delta.dy === before.delta.dy && after.delta.dx === before.delta.dx;
const paneMoved = after.paneScrollTop !== before.paneScrollTop;
const targetMoved = after.target.top !== before.target.top;
if (tracked && paneMoved && targetMoved) {
  console.log(`PASS: badge tracked target through inner-pane scroll (delta held dy=${before.delta.dy} dx=${before.delta.dx}).`);
  console.log(`  target moved top ${before.target.top}→${after.target.top}; host followed.`);
  console.log(`  ${before.anchoredCount} anchored targets in pane (anchor fast-path active).`);
} else {
  console.log('FAIL: badge did not track.');
  console.log(`  delta before dy=${before.delta.dy}/dx=${before.delta.dx}, after dy=${after.delta.dy}/dx=${after.delta.dx}`);
  console.log(`  paneMoved=${paneMoved} targetMoved=${targetMoved}`);
}

await page.screenshot({ path: '/tmp/anchor-verify.png' });
console.log('screenshot: /tmp/anchor-verify.png');
await ctx.close();
server.close();
