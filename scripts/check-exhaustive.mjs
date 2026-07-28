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
    // 24 -> 22 (2026-07-27): republishAllGrammar moved to labels/label-sync.ts
    // (entry-point seam inversion, phase 2 STATEFUL). The sweep did not grow or
    // shrink — it changed file, so this lower and label-sync's raise below are
    // one move and must be read together.
    // 22 -> 20 (2026-07-28): buildPerfSnapshot's store walk and its
    // `store.all.length` went to debug/perf-snapshot.ts with the rest of the
    // perf block (entry-point topology phase 4). Same two sites, new file —
    // this lower and perf-snapshot's pin below are one move.
    // 20 -> 18 (2026-07-28): the two `store.all.length` hint counts in
    // GET_PAGE_STATUS / SET_BADGES_VISIBLE went to badge-visibility.ts with
    // those handlers (entry-point topology phase 3a). This lower and
    // badge-visibility's raise are one move.
    'src/content.ts': 18,
    // 4 -> 6 (2026-07-28): the popup's two hint counts, arrived from
    // content.ts. Not a new membership question — the popup asks "how many
    // hints does this page have", which is the same total anyBadgesShowing
    // already reads the store for, one line above each of them.
    'src/render/badge-visibility.ts': 6,
    'src/plugin/resolve.ts': 1,
    // 1 -> 3 (2026-07-27): republishAllGrammar's full re-push arrived from
    // content.ts — the loop over live wrappers plus the count it logs. Not a
    // new membership question: it is the same sweep content.ts ran, now beside
    // the session rotation and the put queue it exists to feed. It does NOT
    // route through the holder registry deliberately — holders outside the
    // store re-publish off the is_final chokepoint in postBatch instead, which
    // also covers the plain-rescan path this function never reaches.
    'src/labels/label-sync.ts': 3,
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
    // New 2026-07-28: the perf-snapshot integrator's one store walk (limbo /
    // sentinel-disconnected / in-band split) plus the wrapperCount read.
    // Arrived from content.ts unchanged — see the content.ts note above.
    'src/debug/perf-snapshot.ts': 2,
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

  // --- D2. Every passthrough id actually has a registered handler ----------
  //
  // The checks above treat DISPATCH_PASSTHROUGH_ACTIONS as PROOF that an id is
  // handled. That was sound while the set and all 44 `dispatcher.register`
  // calls lived ~250 lines apart in content.ts. Phase 3b moved the handlers to
  // eleven feature modules and left the set behind, so the direction that
  // matters now is the one lint D cannot see: the id is in the set, and
  // nothing registers it.
  //
  // `dispatcher.dispatch` on an unregistered id is a bare console.warn, so the
  // voice phrase matches, dispatches, arrives, and nothing happens. Verified:
  // renaming a handler id together with its own test left every lint, tsc and
  // the full suite green while the command was dead.
  //
  // Both sides are read from the code. Loop-driven registrations are read from
  // their command tables the same way lint D reads its other literals.
  {
    /** action id -> the files that bind it. */
    const owners = new Map();
    const claim = (id, where) => {
      if (!owners.has(id)) owners.set(id, []);
      owners.get(id).push(where);
    };

    for (const rel of srcFiles()) {
      for (const m of read(rel).matchAll(/dispatcher\.register\(\s*'([a-z_0-9]+)'/g)) {
        claim(m[1], rel);
      }
    }
    // The loops that register from a table rather than a literal.
    for (const [file, name] of [
      ['src/activate/tab-commands.ts', 'TAB_COMMANDS'],
      ['src/activate/tab-commands.ts', 'ZOOM_COMMANDS'],
    ]) {
      const src = read(file);
      const open = src.indexOf('[', src.indexOf(`const ${name}`));
      const close = src.indexOf('];', open);
      if (open === -1 || close === -1) fail(`lint D2 could not parse ${name} in ${file}`);
      for (const m of src.slice(open, close).matchAll(/\[\s*'([a-z_0-9]+)'/g)) claim(m[1], `${file} (${name})`);
    }
    {
      const src = read('src/render/palette-host.ts');
      const open = src.indexOf('{', src.indexOf('const PALETTE_COMMAND_SCOPE'));
      const close = src.indexOf('};', open);
      if (open === -1 || close === -1) fail('lint D2 could not parse PALETTE_COMMAND_SCOPE');
      for (const m of src.slice(open, close).matchAll(/^\s+([a-z_0-9]+):/gm)) {
        claim(m[1], 'src/render/palette-host.ts (PALETTE_COMMAND_SCOPE)');
      }
    }

    const registered = new Set(owners.keys());
    if (registered.size === 0) {
      fail('lint D2 found zero dispatcher.register ids — fix the lint');
    }

    // --- and no two modules may bind the same action ----------------------
    //
    // ActionDispatcher.register throws on a duplicate, but that is a RUNTIME
    // throw during content.ts boot — and no unit test can reach it, because
    // each module's tests register that module alone. Cross-module collision
    // is only observable once every registrar has run, so check it statically
    // and leave the throw as the backstop rather than the discovery mechanism.
    // (Exactly the argument lint E makes for message-type disjointness.)
    for (const [id, where] of owners) {
      if (where.length > 1) {
        fail(`action '${id}' is bound by ${where.length} sites (${where.join(', ')}) — ` +
          'ActionDispatcher.register throws on the duplicate, so content.ts boot dies; ' +
          'and before that throw existed, whichever registrar ran last silently won');
      }
    }
    const passthrough = setLiteral(content, 'DISPATCH_PASSTHROUGH_ACTIONS', 'content.ts');
    const orphaned = passthrough.filter((id) => !registered.has(id));
    for (const id of orphaned) {
      fail(`'${id}' is in DISPATCH_PASSTHROUGH_ACTIONS but nothing calls dispatcher.register('${id}') — ` +
        'the voice command matches, dispatches, and lands on console.warn. Lint D counts the ' +
        'passthrough set as proof of handling, so it cannot see this');
    }
    if (!failed) {
      ok(`command bindings: ${registered.size} actions bound uniquely, ` +
        `all ${passthrough.length} passthrough ids have a handler`);
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
//
// TWO entry points since phase 3: background.ts and content.ts. They are
// separate esbuild bundles, so each has its OWN handler table — which is why
// registration is checked against "some entry point" and disjointness is
// checked WITHIN one. `MARK_RESTORE` in the content table and `MARK_SET` in
// the SW's are not competing for anything, and a rule that said otherwise
// would be inventing a constraint the runtime does not have.
{
  const ENTRIES = ['src/background.ts', 'src/content.ts'];
  const entrySrc = new Map(ENTRIES.map((e) => [e, read(e)]));
  const entryPaths = new Set(ENTRIES.map((e) => join(...e.split('/'))));

  const exported = [];
  for (const rel of srcFiles()) {
    if (entryPaths.has(rel)) continue;
    for (const m of read(rel).matchAll(/^export const (\w*MessageHandlers)\b/gm)) {
      exported.push({ name: m[1], file: rel });
    }
  }

  /** entry -> the map names it composes. */
  const registeredBy = new Map(
    ENTRIES.map((e) => [e, new Set(
      [...entrySrc.get(e).matchAll(/registerMessageHandlers\(\s*(\w+)/g)].map((m) => m[1]),
    )]),
  );
  const registeredAnywhere = new Set([...registeredBy.values()].flatMap((s) => [...s]));

  if (exported.length === 0) {
    fail('lint E found zero exported *MessageHandlers maps — fix the lint');
  }

  const unregistered = exported.filter((e) => !registeredAnywhere.has(e.name));
  for (const { name, file } of unregistered) {
    fail(`${name} (${file}) is exported but never registered in an entry point — ` +
      'its message types route nowhere and senders await a response that never comes');
  }

  // Nothing may bypass the table: each listener takes routeMessage directly, so
  // a reintroduced inline if-chain fails here rather than quietly coexisting.
  for (const entry of ENTRIES) {
    if (!/onMessage\.addListener\(routeMessage\)/.test(entrySrc.get(entry))) {
      fail(`${entry} no longer installs routeMessage as its sole onMessage listener — ` +
        'handlers belong in a module map (notes/DESIGN_ENTRY_POINT_TOPOLOGY.md)');
    }
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

  /** Types a named map claims, or null if the map's literal cannot be found. */
  const keysOfMap = (name, file) => {
    const src = read(file);
    const at = src.indexOf(`export const ${name}`);
    if (at === -1) return null;
    return literalKeys(src, src.indexOf('{', src.indexOf('=', at)));
  };

  const collisions = [];
  let typeCount = 0;

  // Disjointness is per TABLE, and each entry point owns one.
  for (const entry of ENTRIES) {
    const owner = new Map();   // message type -> the map that claimed it first
    const claim = (type, by) => {
      typeCount++;
      if (owner.has(type)) collisions.push({ entry, type, first: owner.get(type), second: by });
      else owner.set(type, by);
    };
    for (const { name, file } of exported) {
      if (!registeredBy.get(entry).has(name)) continue;
      for (const type of keysOfMap(name, file) ?? []) claim(type, name);
    }
    // Both entry points compose a map inline — the SW's offscreen-bridge
    // residue, content.ts's BRANCHKIT_ACTION — and either can collide with a
    // module's just as easily.
    const src = entrySrc.get(entry);
    for (const m of src.matchAll(/registerMessageHandlers\(\{/g)) {
      for (const type of literalKeys(src, m.index + m[0].length - 1)) claim(type, `${entry} (inline)`);
    }
  }

  if (typeCount === 0) {
    fail('lint E parsed zero message types out of the handler maps — fix the lint');
  }
  for (const { entry, type, first, second } of collisions) {
    fail(`message type '${type}' is claimed by both ${first} and ${second} in ${entry}'s table — ` +
      'registerMessageHandlers throws on the duplicate and that handler is lost');
  }

  if (unregistered.length === 0 && collisions.length === 0) {
    ok(`message handlers: ${exported.length} maps across ${ENTRIES.length} tables, ` +
      `${typeCount} types disjoint per table, both listeners are the table`);
  }
}

// --- The value-import graph, shared by F and G -----------------------------
//
// VALUE edges only. `import type {…}`, `export type {…} from`, an import whose
// every named specifier is `type`-prefixed, and type-position `import('x').Y` /
// `typeof import('x')` are ERASED by the compiler and are NOT edges. Every
// verdict below turns on that: a reviewer who counted them would have called
// `page-session → settle-engine` a cycle, and one who ignored bare
// `import './x'` would have missed a real one.

/** value-import adjacency over non-test src, as repo-relative paths. */
function valueImportGraph() {
  const files = srcFiles();
  const known = new Set(files);
  const graph = new Map(files.map((f) => [f, new Set()]));
  // Comments first: a commented-out import is not an edge.
  const decomment = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const resolve = (from, spec) => {
    if (!spec.startsWith('.')) return null;
    const base = join(dirname(from), spec);
    for (const c of [`${base}.ts`, join(base, 'index.ts')]) if (known.has(c)) return c;
    return null;
  };
  for (const file of files) {
    const src = decomment(read(file));
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s+([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g)) {
      const clause = m[1].trim();
      const target = resolve(file, m[2]);
      if (!target) continue;
      if (/^type\s/.test(clause)) continue;                       // import type {…} / export type {…}
      const named = clause.match(/^\{([\s\S]*)\}$/);
      if (named) {
        const parts = named[1].split(',').map((s) => s.trim()).filter(Boolean);
        if (parts.length && parts.every((p) => /^type\s/.test(p))) continue; // all-inline-type
      }
      graph.get(file).add(target);
    }
    for (const m of src.matchAll(/(?:^|\n)\s*import\s*['"](\.[^'"]+)['"]/g)) {  // bare side-effect import
      const target = resolve(file, m[1]);
      if (target) graph.get(file).add(target);
    }
  }
  return graph;
}

/** Files reachable from `entry` over value edges, inclusive. */
function closureOf(graph, entry) {
  const seen = new Set([entry]);
  const stack = [entry];
  while (stack.length) {
    for (const next of graph.get(stack.pop()) ?? []) {
      if (!seen.has(next)) { seen.add(next); stack.push(next); }
    }
  }
  return seen;
}

/** Tarjan. Returns only non-trivial SCCs (size > 1, or a self-loop). */
function stronglyConnected(graph) {
  const index = new Map(), low = new Map(), onStack = new Set();
  const stack = [], out = [];
  let counter = 0;
  const strongConnect = (v) => {
    index.set(v, counter); low.set(v, counter); counter++;
    stack.push(v); onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!index.has(w)) { strongConnect(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) === index.get(v)) {
      const comp = [];
      for (;;) { const w = stack.pop(); onStack.delete(w); comp.push(w); if (w === v) break; }
      if (comp.length > 1 || (graph.get(v) ?? new Set()).has(v)) out.push(comp.sort());
    }
  };
  for (const v of graph.keys()) if (!index.has(v)) strongConnect(v);
  return out;
}

// --- F. The value-import graph gains no new import cycle -------------------
//
// A cycle is not merely untidy here, it is a boot hazard with no other
// detector. `activate/escape-cascade.ts` registers the Escape hook at module
// scope and reads `keyHandler` eagerly to do it, which is only safe because
// `core/singletons` strictly precedes it. Close a cycle between them and
// evaluation order inverts: esbuild lowers `const`→`var`, so the bundle throws
// `Cannot read properties of undefined (reading 'setEscapeHook')` at import —
// in EVERY frame — and build.mjs's IIFE footer only swallows messages
// containing "duplicate injection", so it re-throws uncaught and the content
// script is simply dead. Nothing else in CI sees that (2026-07-27 review).
//
// The two entries below are pre-existing and deliberately grandfathered, not
// endorsed. This is a ratchet: breaking one is a win to be banked by deleting
// its line, and a NEW cycle fails.
{
  const KNOWN_CYCLES = [
    // The lifecycle/observer knot. Wrapper teardown, the page session and the
    // observers that feed them are mutually recursive by construction.
    ['src/core/wrapper-lifecycle.ts', 'src/lifecycle/page-session.ts', 'src/observe/limbo.ts',
      'src/observe/mutation-source.ts', 'src/observe/visibility-tracker.ts', 'src/rules/rule-apply.ts'],
    // The adapter registry and its one concrete adapter.
    ['src/adapters/index.ts', 'src/adapters/quickbase.ts'],
  ].map((c) => c.slice().sort().join(' + '));

  const found = stronglyConnected(valueImportGraph()).map((c) => c.join(' + '));
  for (const cycle of found) {
    if (!KNOWN_CYCLES.includes(cycle)) {
      fail(`NEW import cycle: ${cycle}\n` +
        '      A cycle here is a boot hazard, not a style issue — module-scope registrations ' +
        'depend on a strict evaluation order that a cycle inverts (lint F header).');
    }
  }
  for (const cycle of KNOWN_CYCLES) {
    if (!found.includes(cycle)) {
      fail(`import cycle BROKEN (good) but still listed: ${cycle}\n` +
        '      Delete it from KNOWN_CYCLES in this commit so the win locks in.');
    }
  }
  if (!failed) ok(`import cycles: ${found.length} at baseline, none new`);
}

// --- G. Module-scope registrations stay reachable from an entry point -------
//
// These modules install behaviour by being IMPORTED — `escape-cascade` wires
// the Escape key, `search-badges` its find teardown, and the two probe
// registrations below. None is called by name from anywhere. So each is live
// only as long as some entry point still value-imports it for an unrelated
// reason, and if a refactor moves that last use out, esbuild drops the module
// and the feature silently stops existing — with every unit test still green,
// because tests import these modules directly (2026-07-27 review).
//
// §6a's rule is "a seam may live at module scope if it is a pure assignment".
// This is that rule's missing half: it may, and then it must stay imported.
{
  const REGISTRARS = {
    'src/activate/escape-cascade.ts': 'Escape key → the cascade; hint inner-transient probe',
    'src/activate/search-badges.ts': 'find deactivate → clear the search badges',
    'src/activate/selection-commands.ts': "caret's inner-transient probe",
    'src/activate/range-disambiguation.ts': "range_pick's inner-transient probe",
  };
  const graph = valueImportGraph();
  const reachable = new Set([
    ...closureOf(graph, 'src/content.ts'),
    ...closureOf(graph, 'src/background.ts'),
  ]);
  let checked = 0;
  for (const [file, what] of Object.entries(REGISTRARS)) {
    if (!graph.has(file)) {
      fail(`lint G: ${file} no longer exists — update REGISTRARS, and check ${what} still happens`);
      continue;
    }
    // The registration must actually be there, or the pin is guarding nothing.
    const topLevelCall = read(file).split('\n').some((l) => /^[a-zA-Z_$][\w.]*\(/.test(l));
    if (!topLevelCall) {
      fail(`lint G: ${file} has no module-scope registration any more (${what}) — ` +
        'if it moved, move this pin with it; if it went away, delete the entry');
    }
    if (!reachable.has(file)) {
      fail(`${file} is no longer value-imported by content.ts or background.ts, so esbuild will ` +
        `drop it and this stops happening: ${what}. Nothing else fails when it does — ` +
        'its own tests import it directly and stay green.');
    }
    checked++;
  }
  if (!failed) ok(`module-scope registrars: ${checked} pinned into an entry point's import closure`);
}

// --- G2. Every command registrar is actually CALLED ------------------------
//
// The other half of the same failure. Phase 3b moves inline
// `dispatcher.register` calls into `register*Commands()` functions that an
// entry point invokes. G above catches a module that stops being IMPORTED;
// this catches one that is imported and never RUN — an exported registrar
// nobody calls, which drops every command it holds.
//
// The symptom is identical to lint E's unregistered handler map and to the
// old if-chain's silent fall-through: the command is in the catalog, the
// keybind and the voice phrase both resolve, and nothing happens. Its own
// tests stay green because they call the registrar themselves.
//
// Both sides are read from the code. A new `register*Commands` export joins
// the check by existing.
{
  const ENTRIES = ['src/content.ts', 'src/background.ts'];
  const called = new Set();
  for (const entry of ENTRIES) {
    for (const m of read(entry).matchAll(/^\s*(register\w*Commands)\(\s*\)/gm)) called.add(m[1]);
  }

  const registrars = [];
  for (const rel of srcFiles()) {
    for (const m of read(rel).matchAll(/^export function (register\w*Commands)\s*\(/gm)) {
      registrars.push({ name: m[1], file: rel });
    }
  }

  if (registrars.length === 0) {
    fail('lint G2 found zero register*Commands registrars — fix the lint');
  }
  for (const { name, file } of registrars) {
    if (!called.has(name)) {
      fail(`${name} (${file}) is exported but never called from an entry point — ` +
        'every command it registers silently does nothing, and its own tests still pass ' +
        'because they call it themselves');
    }
  }
  if (!failed) ok(`command registrars: ${registrars.length} exported, all called at boot`);
}

process.exit(failed ? 1 : 0);
