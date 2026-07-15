// Guardrail for the band-discovery backstop (Phase 3b of
// notes/DESIGN_HINT_LIFECYCLE_RECONCILER.md — reconcile's "discover" step),
// its dirty gate, and the shadow-interior observation that made the gate
// sound (notes/DESIGN_BAND_SWEEP_DIRTY_GATE.md).
//
// The gap the sweep covers: a hintable element enters the DOM but its
// discovery walk never runs (race, skip, engine oddity), so no wrapper is
// ever created. reconcile() converges {codeword,hint} over EXISTING wrappers
// — it can't see an element that has none. The sweep re-walks the document
// on settle and idempotently attaches anything missed.
//
// This script's ORIGINAL synthesis — append into an open shadow root, which
// the doc-level MO can't see — stopped being a gap when the scanner's
// sighting hook began registering open roots on the page observer: shadow
// appends now take the incremental path. Part A asserts exactly that (badge
// with NO scroll — no sweep needed). Part B synthesizes a genuine walk-miss
// via the harness fault hook: data-bk-test-drop-discovery-roots makes
// drainDiscovery skip one root's walk, so a light-DOM insert is SEEN (the
// DOM-add epoch goes dirty) but never walked — the dirty-gated settle sweep
// must recover it.
//
// Runs on Chromium (CSS anchor positioning + open-shadow scan, same engine the
// production backstop runs on).

import { chromium } from 'playwright';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, rmSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { captureSnapshot } from './_snapshot.mjs';

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

// Seed an alphabet so showBadges() doesn't bail at isAlphabetLoaded(), plus
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

console.log('[4] PART A — inject a hintable <a> into the OPEN shadow root');
await page.evaluate((injectedId) => {
  const sr = document.getElementById('shadow-host').shadowRoot;
  const a = document.createElement('a');
  a.href = '#';
  a.id = injectedId;
  a.textContent = 'Gap link';
  a.style.cssText = 'display:block;padding:16px 20px;';
  sr.appendChild(a);
}, INJECTED_ID);

console.log('[5] assert it badges INCREMENTALLY (registered root, no scroll, no sweep)');
await sleep(1500);
const afterShadow = await probe();
console.log('   ', JSON.stringify(afterShadow));
if (!afterShadow.injectedExists) {
  fail('injected element vanished — fixture/shadow setup broken');
} else if (afterShadow.totalHosts <= base.totalHosts) {
  fail(`shadow-interior append NOT badged without a scroll (hosts ${base.totalHosts} -> ${afterShadow.totalHosts}) — `
    + 'open-root observation (observeShadowRootForMutations) is not delivering');
} else {
  pass(`shadow-interior append badged incrementally (hosts ${base.totalHosts} -> ${afterShadow.totalHosts})`);
}

console.log('[6] PART B — arm the drop hook, inject a light-DOM link (seen but never walked)');
const GAP_LIGHT_ID = 'gap-light-link';
await page.evaluate((id) => {
  document.documentElement.setAttribute('data-bk-test-drop-discovery-roots', '1');
  const a = document.createElement('a');
  a.href = '#';
  a.id = id;
  a.textContent = 'Dropped link';
  a.style.cssText = 'display:block;padding:16px 20px;';
  document.body.insertBefore(a, document.body.firstChild);
}, GAP_LIGHT_ID);
await sleep(250);
const dropState = await page.evaluate((id) => ({
  dropAttr: document.documentElement.getAttribute('data-bk-test-drop-discovery-roots'),
  sweepGate: document.documentElement.getAttribute('data-bk-sweep-gate'),
  badged: !!document.getElementById(id)?.previousElementSibling?.hasAttribute?.('data-branchkit-hint')
    || false,
}), GAP_LIGHT_ID);
console.log('   ', JSON.stringify(dropState));
if (dropState.dropAttr !== '0') {
  fail(`drop hook not consumed (attr=${dropState.dropAttr}) — harness fault injection broken, gap not synthesized`);
} else {
  pass('drainDiscovery consumed the drop hook (walk skipped for the inserted link)');
}
if (dropState.sweepGate !== 'on') {
  fail(`dirty gate not active (data-bk-sweep-gate=${dropState.sweepGate}) — recovery would not exercise the gated path`);
} else {
  pass('band-sweep dirty gate is ON');
}

console.log('[7] scroll-and-back to fire a settle; a self-heal layer must recover the dropped link');
// Which layer wins the recovery is timing-dependent: the insert dirties the
// DOM-add epoch, so the settle's gated sweep recovers it — but an earlier
// self-heal (a scan pass) may get there first on an idle fixture. The
// guardrail contract is layer-agnostic: a walk-miss is badged promptly, and
// the gate did not starve it. The wrapper's discovery source is reported by
// the snapshot check below.
await page.evaluate(() => window.scrollTo(0, 60));
await sleep(150);
await page.evaluate(() => window.scrollTo(0, 0));
console.log('   wait 2000ms for settle debounce + idle sweep + reconcile + paint');
await sleep(2000);

const after = await probe();
console.log('   ', JSON.stringify(after));
if (after.totalHosts <= afterShadow.totalHosts) {
  fail(`no new badge for the dropped link (hosts ${afterShadow.totalHosts} -> ${after.totalHosts}) — `
    + 'the dirty gate starved recovery of a seen-but-unwalked element');
} else {
  pass(`the dropped link was recovered (hosts ${afterShadow.totalHosts} -> ${after.totalHosts})`);
}
// Stronger attribution: the injected element must own a wrapper with a
// claimed codeword. (The old checks — inline anchor-name, or a host nested
// inside the shadow root — probed the anchor/nesting positioning
// generations deleted in the reconcile-only re-arch 630f35c..83a2439;
// under JS reconcile positioning every host mounts in the light DOM with a
// transform, so both branches were unreachable and the fixture failed on a
// working backstop.)
const snap = await captureSnapshot(page);
const droppedWrapper = (snap?.wrappers ?? []).find(
  (w) => /Dropped link/.test(w.element?.accessibleName ?? ''),
);
if (droppedWrapper && droppedWrapper.scanned?.codeword) {
  pass(`dropped element owns a wrapper with codeword "${droppedWrapper.scanned.codeword}"`
    + (droppedWrapper.discovery ? ` (source=${droppedWrapper.discovery.source})` : ''));
} else {
  fail('a badge appeared but the dropped element has no codeworded wrapper');
}

console.log('\n=== VERDICT ===');
console.log(failed ? '  ✗ FAIL — shadow incremental path or gated band-sweep recovery broken'
                   : '  ✓ PASS — shadow appends badge incrementally; the dirty-gated sweep recovers a walk-miss');

await page.screenshot({ path: '/tmp/branchkit-band-discovery.png' });
await ctx.close();
server.close();
process.exit(failed ? 1 : 0);
