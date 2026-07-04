// Validation for the round-16 discovery-source instrumentation
// (notes/DESIGN_FLING_WAVE.md): every wrapper must carry a discovery source
// + a universal dom_seen stamp, and the snapshot's wave.discovery_sources
// section must attribute wrappers to the path that actually found them.
//
// Reuses the band-discovery fixture's shape because it deterministically
// exercises TWO distinct sources with no app dependency:
//   - the boot doScan attaches the static links -> source 'scan'
//   - a post-load light-DOM insertion -> MO record -> 'mo'
//   - an open-shadow-root insertion the doc MO cannot see -> found only by
//     the scroll-settle sweep -> 'band_sweep', domSeenByMo=false
//
// Asserts: no 'unknown' sources, tDomSeen non-null on every wrapper (the
// survivorship fix), the shadow-injected element attributed to a sweep, the
// light-DOM injected element attributed to 'mo' with a real MO stamp.

import { chromium } from 'playwright';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, rmSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { captureSnapshot } from './_snapshot.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const EXT = resolve(root, 'dist/chrome');
const PROFILE = '/tmp/branchkit-discovery-sources-profile';

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

console.log('[3] inject a light-DOM link (MO path) and a shadow-root link (MO-invisible)');
await page.evaluate(() => {
  const a = document.createElement('a');
  a.href = '#mo';
  a.id = 'mo-link';
  a.textContent = 'MO link';
  a.style.cssText = 'display:block;padding:16px 20px;';
  document.body.prepend(a);
  const sr = document.getElementById('shadow-host').shadowRoot;
  const b = document.createElement('a');
  b.href = '#gap';
  b.id = 'gap-link';
  b.textContent = 'Gap link';
  b.style.cssText = 'display:block;padding:16px 20px;';
  sr.appendChild(b);
});
await sleep(600);

console.log('[4] scroll-and-back to fire the settle sweep, wait for idle sweep + paint');
await page.evaluate(() => window.scrollTo(0, 60));
await sleep(150);
await page.evaluate(() => window.scrollTo(0, 0));
await sleep(1500);

console.log('[5] capture snapshot, check per-wrapper + per-source data');
const snap = await captureSnapshot(page);
if (!snap) {
  fail('no snapshot payload — content script not injected?');
} else {
  const ws = snap.wrappers ?? [];
  const noDiscovery = ws.filter((w) => !w.discovery);
  const unknown = ws.filter((w) => w.discovery?.source === 'unknown');
  const noSeen = ws.filter((w) => w.discovery && w.discovery.t_dom_seen === null);
  if (noDiscovery.length) fail(`${noDiscovery.length} wrappers missing the discovery block`);
  else pass('every wrapper carries a discovery block');
  if (unknown.length) fail(`${unknown.length} wrappers tagged 'unknown' — a threading gap`);
  else pass("no 'unknown' sources");
  if (noSeen.length) fail(`${noSeen.length} wrappers with null t_dom_seen — survivorship hole still open`);
  else pass('t_dom_seen stamped on every wrapper (universal dom_seen)');

  const byId = (id) => ws.find((w) => w.element?.accessibleName === id
    || (w.fingerprint && w.fingerprint.name === id));
  const moLink = ws.find((w) => w.element?.tag === 'a' && /MO link/.test(w.element?.accessibleName ?? ''));
  const gapLink = ws.find((w) => w.element?.tag === 'a' && /Gap link/.test(w.element?.accessibleName ?? ''));
  void byId;
  if (!moLink) fail('light-DOM injected link has no wrapper');
  else if (moLink.discovery.source !== 'mo') fail(`light-DOM link source=${moLink.discovery.source}, expected 'mo'`);
  else if (!moLink.discovery.dom_seen_by_mo) fail('light-DOM link not MO-stamped');
  else pass("light-DOM insertion attributed to 'mo' with a real MO stamp");
  if (!gapLink) fail('shadow-injected link has no wrapper — sweep did not attach it');
  else if (!/sweep/.test(gapLink.discovery.source)) {
    fail(`shadow link source=${gapLink.discovery.source}, expected a sweep source`);
  } else if (gapLink.discovery.dom_seen_by_mo) {
    fail('shadow link claims an MO stamp — impossible, doc MO cannot see shadow roots');
  } else {
    pass(`shadow insertion attributed to '${gapLink.discovery.source}', no MO stamp (fallback dom_seen)`);
  }

  const sources = snap.wave?.discovery_sources ?? {};
  console.log('    wave.discovery_sources:', JSON.stringify(
    Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, v.attached_in_window])),
  ));
  console.log('    wave.attached_by_source:', JSON.stringify(snap.wave?.attached_by_source ?? {}));
  if (!Object.keys(sources).length) fail('wave.discovery_sources empty');
  else pass('wave.discovery_sources populated');
}

console.log('\n=== VERDICT ===');
console.log(failed ? '  ✗ FAIL — discovery-source instrumentation broken'
                   : '  ✓ PASS — discovery-source instrumentation verified end-to-end');

await ctx.close();
server.close();
process.exit(failed ? 1 : 0);
