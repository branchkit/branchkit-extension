// Guardrail for the band-discovery backstop (Phase 3b of
// notes/DESIGN_HINT_LIFECYCLE_RECONCILER.md — reconcile's "discover" step).
//
// The gap it covers: a hintable element enters the DOM while the doc-level
// MutationObserver drops/coalesces its insertion record under a mutation
// storm, so no wrapper is ever created. reconcile() converges {codeword,hint}
// over EXISTING wrappers — it can't see an element that has none. The discover
// step re-walks the document via the sliced/batched discovery on scroll-settle
// and idempotently attaches anything missed.
//
// Synthesizing that gap deterministically, no app required: the doc-level
// MutationObserver does NOT observe inside a shadow root, but the scanner's
// deepQuerySelectorAll DOES pierce OPEN shadow roots. So appending a hintable
// <a href> into an open shadow root post-baseline is a real discovery gap —
// hintable + in-band, but our observer never saw it, so the normal path makes
// no wrapper. ONLY scheduleBandDiscovery (fired by scroll-settle) can find it.
//
// Flow: baseline (static links badged) -> inject <a> into the open shadow root
// -> confirm it is NOT yet badged (the gap is real) -> small scroll-and-back to
// fire the scroll-settle reconcile + discover sweep -> assert the injected
// element is now badged. The static links stay in-band throughout (the only
// scrollable region is an empty below-the-fold spacer), so the post-sweep badge
// delta is uniquely attributable to the discover step.
//
// Runs on Chromium (CSS anchor positioning + open-shadow scan, same engine the
// production backstop runs on).

import { chromium } from 'playwright';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, rmSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const EXT = resolve(root, 'dist/chrome');
const PROFILE = '/tmp/branchkit-band-discovery-profile';

// Content scripts match <all_urls> but Chrome excludes file:// without file
// access. Serve the fixture over http://localhost so the content script runs.
const fixtureHtml = readFileSync(resolve(root, 'test-fixtures/band-discovery.html'), 'utf8');
const server = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(fixtureHtml);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const FIXTURE = `http://127.0.0.1:${server.address().port}/`;

if (existsSync(PROFILE)) rmSync(PROFILE, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const fail = (msg) => { failed = true; console.log('  FAIL —', msg); };
const pass = (msg) => console.log('  ok  —', msg);

console.log('[1] launch Chromium with extension');
const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  args: ['--disable-extensions-except=' + EXT, '--load-extension=' + EXT],
});

// Seed an alphabet so showHints() doesn't bail at isAlphabetLoaded(), plus
// always-mode so badges paint on load without a "show" command.
const ALPHABET = 'arch bat cat dog echo fox golf hotel india jam kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu'.split(' ');
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
await sw.evaluate(async (a) => {
  await chrome.storage.sync.set({ aggressiveHints: true, hintVisibility: 'always' });
  await chrome.storage.local.set({ alphabet: a });
}, ALPHABET);

const page = await ctx.newPage();
console.log('[2] load fixture, settle 6s for scan + paint');
await page.goto(FIXTURE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);

// Count every badge host across the light DOM and the open shadow root. Also
// report whether the injected element (if present) has a host bound to it.
const INJECTED_ID = 'gap-link';
async function probe() {
  return await page.evaluate((injectedId) => {
    const sr = document.getElementById('shadow-host').shadowRoot;
    const lightHosts = document.querySelectorAll('[data-branchkit-hint]').length;
    const shadowHosts = sr ? sr.querySelectorAll('[data-branchkit-hint]').length : 0;
    const injected = sr ? sr.getElementById(injectedId) : null;
    // A badged element on the anchor path carries an inline anchor-name we set;
    // on the nesting path a host is mounted next to it inside the shadow root.
    const injectedAnchorName = injected
      ? injected.style.getPropertyValue('anchor-name').trim() : null;
    return {
      lightHosts,
      shadowHosts,
      totalHosts: lightHosts + shadowHosts,
      injectedExists: !!injected,
      injectedAnchorName,
    };
  }, INJECTED_ID);
}

console.log('[3] baseline');
const base = await probe();
console.log('   ', JSON.stringify(base));
if (base.totalHosts < 3) {
  fail(`expected >=3 baseline badges for the static links, got ${base.totalHosts} — scan/paint not running?`);
} else {
  pass(`baseline badges painted (${base.totalHosts} hosts)`);
}

console.log('[4] inject a hintable <a> into the OPEN shadow root (the discovery gap)');
await page.evaluate((injectedId) => {
  const sr = document.getElementById('shadow-host').shadowRoot;
  const a = document.createElement('a');
  a.href = '#';
  a.id = injectedId;
  a.textContent = 'Gap link';
  a.style.cssText = 'display:block;padding:16px 20px;';
  sr.appendChild(a);
}, INJECTED_ID);

console.log('[5] confirm the gap is real: settle briefly, element must NOT be badged yet');
await sleep(600);
const gapped = await probe();
console.log('   ', JSON.stringify(gapped));
if (!gapped.injectedExists) {
  fail('injected element vanished — fixture/shadow setup broken');
} else if (gapped.totalHosts !== base.totalHosts) {
  fail(`element got a badge WITHOUT the sweep (hosts ${base.totalHosts} -> ${gapped.totalHosts}) — `
    + 'the MutationObserver saw the shadow insertion; gap not synthesized, test invalid');
} else {
  pass('injected element is NOT badged before the sweep (genuine discovery gap)');
}

console.log('[6] small window scroll-and-back to fire scroll-settle -> band-discovery sweep');
// Keep the static links + shadow host in-band the whole time (only the empty
// spacer is below the fold) so nothing is torn down/rebuilt; the sole post-sweep
// badge delta is the discover step attaching the missed shadow element.
await page.evaluate(() => window.scrollTo(0, 60));
await sleep(150);
await page.evaluate(() => window.scrollTo(0, 0));
console.log('   wait 1500ms for settle debounce + idle sweep + reconcile + paint');
await sleep(1500);

console.log('[7] assert the injected element is now badged');
const after = await probe();
console.log('   ', JSON.stringify(after));
if (after.totalHosts <= base.totalHosts) {
  fail(`no new badge after sweep (hosts ${base.totalHosts} -> ${after.totalHosts}) — `
    + 'scheduleBandDiscovery did not attach the missed element');
} else {
  pass(`a new badge appeared after the sweep (hosts ${base.totalHosts} -> ${after.totalHosts})`);
}
// Stronger attribution: the badge must be tied to the injected element, either
// via an inline anchor-name (anchor path) or a host inside the shadow root
// (nesting path). Either proves the discover step found THIS element.
if (after.injectedAnchorName && after.injectedAnchorName.startsWith('--bk-')) {
  pass(`injected element bound on anchor path (anchor-name=${after.injectedAnchorName})`);
} else if (after.shadowHosts > gapped.shadowHosts) {
  pass(`injected element bound on nesting path (shadow host mounted)`);
} else {
  fail('a badge appeared but is not attributable to the injected element');
}

console.log('\n=== VERDICT ===');
console.log(failed ? '  ✗ FAIL — band-discovery backstop did not attach the missed in-band hintable'
                   : '  ✓ PASS — band-discovery backstop attached the missed in-band hintable');

await page.screenshot({ path: '/tmp/branchkit-band-discovery.png' });
await ctx.close();
server.close();
process.exit(failed ? 1 : 0);
