#!/usr/bin/env node
/**
 * Exhaustiveness lints (Wave 4 D2, notes/PLAN_MODE_HOLDER_IMPL.md).
 *
 * The arc's bug class is "participant missed the Nth wiring site": a rule
 * declared in one place and open-coded in another drifts silently. The
 * registries (holder-registry.ts, mode-stack.ts) close most of the class by
 * construction; these lints close the residue that stays declarative —
 *
 *   A. Every ModeSpec has an explicit mirror decision: the ModeId union and
 *      the MODE_SPECS table cover each other, and a `mirror: null` entry
 *      carries its recorded reason (the word DECISION in the entry — the
 *      house convention for "null on purpose, here is why").
 *   B. Holder priorities come from the declared rank constants, which stay
 *      unique and strictly ordered (exclusive > additive > ambient). A
 *      numeric-literal priority is a rank the registry's language doesn't
 *      know about.
 *   C. `store.all` iteration is pinned per file. The store stopped being the
 *      codeword membership list at Wave 3 C1 (holders are); a NEW store.all
 *      sweep is either wrapper-lifecycle work in an already-sanctioned
 *      module (raise the pin visibly) or a membership question that belongs
 *      to the holder registry (heldAnywhere/allHeld). Pins are exact and
 *      ratchet both ways, like monolith-ceilings.
 *   D. Every action the platform can dispatch at the extension has a
 *      handler: the catalog's voiced command ids and the browser plugin's
 *      own dispatch sites (mode-mirror forwarders, plugin-initiated events)
 *      must appear in the background's intercepts or content's dispatch
 *      routes. The C4b field bug (spoken "video" matched, dispatched,
 *      arrived — and dropped silently off the end of the else-if chain) is
 *      this check's reason to exist. The plugin half needs the workspace
 *      sibling ../plugins/browser and SKIPs loudly when absent (extension
 *      CI runs standalone; the workspace dev loop and app CI have it).
 *   E. Every exported SW message-handler map is registered into the router,
 *      the onMessage listener is the router itself, and no two maps claim the
 *      same message type. An unregistered map drops its types exactly as
 *      silently as the if-chain used to; a duplicated type throws at
 *      registration, which 479c09f made survivable but not visible — nothing
 *      composes the real maps, so only a static check sees it
 *      (notes/DESIGN_ENTRY_POINT_TOPOLOGY.md).
 *
 * Run: node scripts/check-exhaustive.mjs   (wired as a CI step)
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let failed = false;
const fail = (msg) => { failed = true; console.error(`FAIL: ${msg}`); };
const ok = (msg) => console.log(`ok: ${msg}`);

const read = (rel) => readFileSync(join(root, rel), 'utf8');

/** Every non-test .ts under src/, as repo-relative paths. */
function srcFiles() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(join(root, dir))) {
      const rel = join(dir, name);
      if (statSync(join(root, rel)).isDirectory()) walk(rel);
      else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(rel);
    }
  };
  walk('src');
  return out;
}

// --- A. ModeSpec table: union covered, null mirrors carry their reason ---
{
  const src = read('src/core/mode-stack.ts');
  const unionMatch = src.match(/export type ModeId =([^;]+);/);
  const union = [...(unionMatch?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

  const tableMatch = src.match(/export const MODE_SPECS[^=]*=\s*\[([\s\S]*?)\n\];/);
  const table = tableMatch?.[1] ?? '';
  // Entries are the top-level `{ ... }` objects of the array literal.
  const entries = [];
  let depth = 0, start = -1;
  for (let i = 0; i < table.length; i++) {
    if (table[i] === '{') { if (depth === 0) start = i; depth++; }
    if (table[i] === '}') { depth--; if (depth === 0) entries.push(table.slice(start, i + 1)); }
  }
  const specs = entries.map((text) => ({
    id: text.match(/id:\s*'([a-z_]+)'/)?.[1],
    text,
  }));

  if (union.length === 0 || specs.length === 0) {
    fail('lint A could not parse mode-stack.ts (ModeId union or MODE_SPECS) — fix the lint, not the code');
  }
  const specIds = specs.map((s) => s.id);
  for (const id of union) {
    if (!specIds.includes(id)) fail(`ModeId '${id}' has no MODE_SPECS entry — a mode the stack cannot describe`);
  }
  for (const id of specIds) {
    if (!union.includes(id)) fail(`MODE_SPECS entry '${id}' is not in the ModeId union`);
  }
  for (const s of specs) {
    if (!/mirror:/.test(s.text)) {
      fail(`ModeSpec '${s.id}' has no mirror field — every mode needs an explicit mirror decision`);
    } else if (/mirror:\s*null/.test(s.text) && !/DECISION/.test(s.text)) {
      fail(`ModeSpec '${s.id}' has mirror: null with no recorded reason — write the DECISION comment in the entry`);
    }
  }
  if (!failed) ok(`mode specs: ${specIds.length} entries cover the ModeId union; null mirrors carry reasons`);
}

// --- B. Holder priorities: declared ranks, unique, strictly ordered ---
{
  const reg = read('src/labels/holder-registry.ts');
  const rank = (name) => Number(reg.match(new RegExp(`export const ${name} = (\\d+)`))?.[1]);
  const excl = rank('EXCLUSIVE_OVERLAY_PRIORITY');
  const add = rank('ADDITIVE_OVERLAY_PRIORITY');
  const amb = rank('AMBIENT_PRIORITY');
  if ([excl, add, amb].some(Number.isNaN)) {
    fail('lint B could not parse the rank constants in holder-registry.ts');
  } else if (!(excl > add && add > amb)) {
    fail(`holder rank constants must be unique and strictly ordered exclusive > additive > ambient (got ${excl}, ${add}, ${amb})`);
  }

  let sites = 0;
  for (const file of srcFiles()) {
    // src/testing/ hosts the conformance suite's SYNTHETIC holders — their
    // arbitrary priorities are the suite's fixtures, not registry ranks.
    if (file.startsWith('src/testing/')) continue;
    const src = read(file);
    if (!/from '[^']*labels\/holder-registry'/.test(src)) continue;
    for (const m of src.matchAll(/priority:\s*([^,\n]+)[,\n]/g)) {
      const value = m[1].trim();
      if (/^number;?$/.test(value)) continue; // a type annotation, not a value
      sites++;
      const isRankRef = /_PRIORITY\b/.test(value) || /\bspec\.priority\b/.test(value);
      if (!isRankRef) {
        fail(`${file}: holder priority '${value}' is not one of the declared rank constants — ` +
          'register at EXCLUSIVE_OVERLAY/ADDITIVE_OVERLAY/AMBIENT_PRIORITY so the ordering contract stays one list');
      }
    }
  }
  if (!failed) ok(`holder priorities: ranks ${excl}>${add}>${amb}; ${sites} priority sites all use declared ranks`);
}

// --- C. store.all iteration pinned per file ---
{
  // The sanctioned modules and their exact site counts at pin time
  // (2026-07-26, Wave 4 D2). Over → a new sweep needs a visible raise here
  // (or belongs to the holder registry: heldAnywhere/allHeld/reconcileAll).
  // Under → an extraction won; lower the pin in the same commit.
  const PINS = {
    // 27 -> 26 (2026-07-27): updateBadgeLabels deleted — the display-mode
    // relabel now fans out through relabelAll() like the alphabet swap, so the
    // store-only sweep it used is gone rather than moved.
    // 26 -> 25 (2026-07-27): narrowStoreHints lost its '' branch to the shared
    // narrowing rule (labels/codeword-typing.ts narrowBadge) — one sweep, not
    // two, because the empty prefix stopped being a special case.
    // 25 -> 24 (2026-07-27): the store holder's `reposition` delegate deleted
    // with the dead hook — badge POSITION is the reconcile positioner's
    // registry, which both hint kinds already join.
    'src/content.ts': 24,
    'src/render/badge-visibility.ts': 4,
    'src/plugin/resolve.ts': 1,
    'src/labels/label-sync.ts': 1,
    // 6 → 7 (2026-07-27): StoreHolder.painted, a read of "is any of my paint on
    // screen". It is what stops the store answering "that prefix is mine" while
    // a find session or a pick owns the screen — the read that keeps one
    // keystroke from repainting the page over three search results. Same
    // question badge-visibility's anyBadgesShowing asks; not routed through it
    // because labels/ importing render/ for one boolean is the worse trade.
    // 7 → 5 (2026-07-27): matchesPrefix's two hand-written `store.all.some`
    // scans collapsed into the holder's ONE claimEntries() projection, which
    // soleMatch already walked. The gate and the fire now read the same list.
    'src/labels/store-holder.ts': 5,
    'src/lifecycle/reconcile.ts': 2,
    'src/lifecycle/machinery-gate.ts': 2,
    'src/lifecycle/settle-engine.ts': 5,
    'src/render/debug-overlay.ts': 1,
    'src/render/range-badge-set.ts': 1,
    'src/observe/visibility-tracker.ts': 2,
    'src/observe/intersection-tracker.ts': 1,
    'src/observe/mutation-source.ts': 1,
    'src/observe/limbo.ts': 5,
    'src/rules/rule-apply.ts': 5,
    'src/debug/debug-snapshot.ts': 5,
    'src/debug/perf-report.ts': 9,
    'src/debug/churn-log.ts': 1,
    'src/debug/pool-audit.ts': 1,
  };
  let total = 0;
  const counts = new Map();
  for (const file of srcFiles()) {
    const count = (read(file).match(/\bstore\.all\b/g) ?? []).length;
    if (count > 0) counts.set(relative(root, join(root, file)), count);
    total += count;
  }
  // Union of live counts and pins, so a pinned file whose LAST site was
  // deleted still reports (drop the pin) rather than passing silently.
  for (const file of new Set([...counts.keys(), ...Object.keys(PINS)])) {
    const count = counts.get(file) ?? 0;
    const pin = PINS[file];
    if (pin === undefined) {
      fail(`${file}: ${count} store.all site(s) in an unsanctioned module — membership questions go ` +
        'through the holder registry; wrapper-lifecycle work gets sanctioned here visibly');
    } else if (count > pin) {
      fail(`${file}: ${count} store.all sites (pinned ${pin}) — a new sweep must be sanctioned here visibly ` +
        'or rerouted through the holder registry');
    } else if (count < pin) {
      fail(`${file}: ${count} store.all sites, pinned ${pin} — lower the pin in this commit so the win locks in` +
        (count === 0 ? ' (remove the entry)' : ''));
    }
  }
  if (!failed) ok(`store.all: ${total} sites across ${Object.keys(PINS).length} sanctioned modules, all at pin`);
}

// --- D. Every dispatchable action has an extension-side route ---
{
  const content = read('src/content.ts');
  const background = read('src/background.ts');

  const setLiteral = (src, name, file) => {
    const m = src.match(new RegExp(`${name}[^=]*=\\s*new Set(?:<[^>]*>)?\\(\\[([\\s\\S]*?)\\]\\)`));
    if (!m) { fail(`lint D could not find ${name} in ${file}`); return []; }
    return [...m[1].matchAll(/'([a-z_0-9]+)'/g)].map((x) => x[1]);
  };
  const recordKeys = (src, name, file) => {
    const m = src.match(new RegExp(`${name}[^=]*=\\s*\\{([\\s\\S]*?)\\};`));
    if (!m) { fail(`lint D could not find ${name} in ${file}`); return []; }
    return [...m[1].matchAll(/([a-z_0-9]+):/g)].map((x) => x[1]);
  };
  const eqComparisons = (src) =>
    [...src.matchAll(/(?:data\.)?action === '([a-z_0-9]+)'/g)].map((x) => x[1]);

  const handled = new Set([
    ...eqComparisons(content),
    ...eqComparisons(background),
    ...setLiteral(content, 'DISPATCH_PASSTHROUGH_ACTIONS', 'content.ts'),
    ...setLiteral(read('src/activate/selection-commands.ts'), 'SELECTION_ACTIONS', 'selection-commands.ts'),
    // SELECTION_ACTIONS spreads the per-granularity extend_* ids from this
    // record rather than repeating them.
    ...recordKeys(read('src/activate/selection-commands.ts'), 'EXTEND_GRANULARITY', 'selection-commands.ts'),
    ...setLiteral(read('src/background/media.ts'), 'MEDIA_ACTIONS', 'media.ts'),
    ...setLiteral(read('src/background/tab-surgery.ts'), 'SURGERY_ACTIONS', 'tab-surgery.ts'),
    ...recordKeys(read('src/background/tab-actions.ts'), 'TAB_ACTION_BY_ID', 'tab-actions.ts'),
    ...recordKeys(read('src/background/tab-actions.ts'), 'ZOOM_ACTION_BY_ID', 'tab-actions.ts'),
  ]);

  // Sources half 1 — the extension's own catalog: every voiced command id
  // can come back over SSE as a BRANCHKIT_ACTION (plus per-pattern params
  // actions when a pattern overrides the action — none do today).
  const catalog = read('src/keymap/command-catalog.ts');
  const voiced = [];
  const entryRe = /\{\s*id:\s*'([a-z_0-9]+)'/g;
  let m, prev = null;
  const catalogEntries = [];
  while ((m = entryRe.exec(catalog)) !== null) {
    if (prev) catalogEntries.push({ id: prev.id, text: catalog.slice(prev.index, m.index) });
    prev = { id: m[1], index: m.index };
  }
  if (prev) catalogEntries.push({ id: prev.id, text: catalog.slice(prev.index) });
  for (const e of catalogEntries) {
    if (/voice:/.test(e.text)) voiced.push(e.id);
  }
  if (voiced.length === 0) fail('lint D parsed zero voiced catalog entries — fix the lint, not the code');

  const missing = voiced.filter((id) => !handled.has(id));
  for (const id of missing) {
    fail(`voiced command '${id}' has no extension-side route — it will match, dispatch, arrive, and drop ` +
      'silently (the C4b video_mode class); add it to a background intercept or a content dispatch route');
  }
  if (missing.length === 0) ok(`dispatch routes: all ${voiced.length} voiced catalog actions handled`);

  // Sources half 2 — plugin-initiated dispatches (the mode-mirror forwarder
  // table and literal ActionEvent sends). Workspace-only: needs the sibling.
  const pluginSrc = join(root, '..', 'plugins', 'browser', 'src');
  if (!existsSync(pluginSrc)) {
    console.log('SKIP: plugin-forwarder half — ../plugins/browser not present (standalone checkout); ' +
      'the workspace dev loop and app CI cover it');
  } else {
    const pluginActions = new Set();
    // Actions the plugin's own on_action intercepts before the generic SSE
    // forward (tab_to_desk / tab_to_window → the surgery protocol) never
    // reach the extension under their spoken id — subtract them.
    const intercepted = new Set();
    for (const name of readdirSync(pluginSrc)) {
      if (!name.endsWith('.go') || name.endsWith('_test.go')) continue;
      const src = readFileSync(join(pluginSrc, name), 'utf8');
      // modeMirror table rows: action: "select_exit"
      for (const x of src.matchAll(/\baction:\s*"([a-z_0-9]+)"/g)) pluginActions.add(x[1]);
      // Literal plugin-initiated events: ActionEvent{ Action: "reactivate", … }
      for (const x of src.matchAll(/\bAction:\s*"([a-z_0-9]+)"/g)) pluginActions.add(x[1]);
      // Builder-DSL commands the PLUGIN declares (not the contributed
      // catalog, whose c.Action forms lint half 1 already covers):
      //   Action(pluginID+".video_mode")  /  Action("browser.show_hints")
      // The C4b bug's action arrived from exactly this shape.
      for (const x of src.matchAll(/\bAction\(pluginID\s*\+\s*"\.([a-z_0-9]+)"/g)) pluginActions.add(x[1]);
      for (const x of src.matchAll(/\bAction\("([a-z_0-9.]+)"/g)) {
        pluginActions.add(x[1].split('.').pop());
      }
      const interceptFn = src.match(/func interceptTabSurgeryAction[\s\S]*?\n\}/);
      if (interceptFn) {
        for (const x of interceptFn[0].matchAll(/case "([a-z_0-9]+)":/g)) intercepted.add(x[1]);
      }
    }
    for (const id of intercepted) pluginActions.delete(id);
    if (pluginActions.size === 0) {
      fail('lint D parsed zero plugin dispatch actions from ../plugins/browser — fix the lint');
    }
    const pluginMissing = [...pluginActions].filter((id) => !handled.has(id));
    for (const id of pluginMissing) {
      fail(`plugin-dispatched action '${id}' (plugins/browser) has no extension-side route — ` +
        'the forwarder fires and the extension drops it silently (the C4b class)');
    }
    if (pluginMissing.length === 0) {
      ok(`dispatch routes: all ${pluginActions.size} plugin-initiated actions handled`);
    }
  }
}

// --- E. Every exported message-handler map is actually registered ----------
//
// The SW message table (background/message-router.ts) only routes what
// background.ts composes into it. A module can export a perfectly good handler
// map and simply never be registered — and the symptom is the same silent drop
// the old if-chain had: the message matches nothing, the channel closes, and an
// awaiting content script hangs or reads undefined.
//
// Both sides are read from the code, so there is no list to keep in sync.
{
  const bg = read('src/background.ts');

  const exported = [];
  for (const rel of srcFiles()) {
    if (rel === join('src', 'background.ts')) continue;
    for (const m of read(rel).matchAll(/^export const (\w*MessageHandlers)\b/gm)) {
      exported.push({ name: m[1], file: rel });
    }
  }

  const registered = new Set(
    [...bg.matchAll(/registerMessageHandlers\(\s*(\w+)/g)].map((m) => m[1]),
  );

  if (exported.length === 0) {
    fail('lint E found zero exported *MessageHandlers maps — fix the lint');
  }

  const unregistered = exported.filter((e) => !registered.has(e.name));
  for (const { name, file } of unregistered) {
    fail(`${name} (${file}) is exported but never registered in background.ts — ` +
      'its message types route nowhere and senders await a response that never comes');
  }

  // Nothing may bypass the table: the listener takes routeMessage directly, so
  // a reintroduced inline if-chain fails here rather than quietly coexisting.
  if (!/onMessage\.addListener\(routeMessage\)/.test(bg)) {
    fail('background.ts no longer installs routeMessage as its sole onMessage listener — ' +
      'handlers belong in a module map (notes/DESIGN_ENTRY_POINT_TOPOLOGY.md)');
  }

  // --- and no two maps may claim the same message type --------------------
  //
  // `registerMessageHandlers` throws on a duplicate, which 479c09f made
  // survivable by installing the listener first — a collision now costs one
  // handler instead of every handler. But it is still a runtime throw on a
  // build that is green everywhere: no test composes the REAL maps (the router
  // tests use synthetic ones), and the registration check above asks whether a
  // map is wired up, not whether its keys are free.
  //
  // Disjointness is a static property of the source, so check it statically and
  // leave the runtime throw as the backstop rather than the discovery mechanism.

  /** Keys of the object literal whose opening brace is at `open`. */
  const literalKeys = (src, open) => {
    let depth = 0, i = open;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) break;
    }
    // Handler keys sit at the literal's own level (2 spaces). An object literal
    // inside a handler body is nested deeper, so its keys cannot match.
    return [...src.slice(open, i).matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]);
  };

  const owner = new Map();   // message type -> the map that claimed it first
  const collisions = [];
  let typeCount = 0;
  const claim = (type, by) => {
    typeCount++;
    if (owner.has(type)) collisions.push({ type, first: owner.get(type), second: by });
    else owner.set(type, by);
  };

  for (const { name, file } of exported) {
    const src = read(file);
    const open = src.indexOf('{', src.indexOf('=', src.indexOf(`export const ${name}`)));
    for (const type of literalKeys(src, open)) claim(type, name);
  }
  // background.ts composes one map inline (the offscreen-bridge residue), and
  // it can collide with a module's just as easily.
  for (const m of bg.matchAll(/registerMessageHandlers\(\{/g)) {
    for (const type of literalKeys(bg, m.index + m[0].length - 1)) claim(type, 'background.ts (inline)');
  }

  if (typeCount === 0) {
    fail('lint E parsed zero message types out of the handler maps — fix the lint');
  }
  for (const { type, first, second } of collisions) {
    fail(`message type '${type}' is claimed by both ${first} and ${second} — ` +
      'registerMessageHandlers throws on the duplicate and that handler is lost');
  }

  if (unregistered.length === 0 && collisions.length === 0) {
    ok(`message handlers: ${exported.length} maps registered, ${typeCount} types disjoint, listener is the table`);
  }
}

process.exit(failed ? 1 : 0);
