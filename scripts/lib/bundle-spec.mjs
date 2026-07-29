/**
 * What a build produces: the esbuild entry points, and the static files copied
 * beside them. ONE description, imported by both builders.
 *
 * `build.mjs` (one-shot, staging dir + atomic swap) and `dev.mjs` (esbuild
 * watch, writes `dist/<target>` in place) each used to carry their own copy of
 * both lists, and all three had drifted:
 *
 *   entries      build.mjs 7 · dev.mjs 6   — no `palette-page.ts` in dev
 *   static HTML  build.mjs 5 · dev.mjs 3   — no `palette.html`, no `welcome.html`
 *   content.ts   build.mjs wraps the duplicate-injection bail · dev.mjs did not
 *
 * That was not cosmetic. `dev.mjs` **wipes `dist/<target>` at startup** and
 * rebuilds it from its own lists, so starting `just ext-dev` after a good build
 * silently DELETED `palette.html`, `palette.js` and `welcome.html` — for the
 * whole dev session. The command palette was dead and the getting-started page
 * was blank in every session started that way, while `npm run build` on its own
 * produced a correct dist, so the bug only appeared in the workflow the docs
 * tell you to use. Found 2026-07-28 by opening welcome.html.
 *
 * A drift check would need its own list. A shared list cannot drift.
 */

/**
 * `swallowGuardBail`: content.ts's duplicate-injection guard deliberately
 * throws to abort its IIFE when a script is injected into a frame that already
 * has one. That throw is correct, but it surfaces as an "Uncaught Error" in the
 * page console / dev error list — and as a `BK_UNCAUGHT` line in browser.log.
 * Wrap the IIFE so ONLY that intentional bail is caught (any real error
 * re-throws, still uncaught).
 */
export const ENTRIES = [
  { in: 'src/content.ts',      out: 'content.js',    format: 'iife', swallowGuardBail: true },
  { in: 'src/bootstrap.ts',    out: 'bootstrap.js',  format: 'iife' },
  { in: 'src/background.ts',   out: 'background.js', format: 'esm'  },
  { in: 'src/offscreen.ts',    out: 'offscreen.js',  format: 'iife' },
  { in: 'src/popup.ts',        out: 'popup.js',      format: 'iife' },
  { in: 'src/options.ts',      out: 'options.js',    format: 'iife' },
  { in: 'src/palette-page.ts', out: 'palette.js',    format: 'iife' },
];

/** Copied verbatim beside the bundles. `manifest.json` is NOT here — it is
 *  written per target by build-manifest.mjs, which both builders invoke. */
export const STATIC_FILES = [
  'offscreen.html',
  'popup.html',
  'options.html',
  'palette.html',
  'welcome.html',
];

/** Copied recursively. */
export const STATIC_DIRS = ['icons'];

/** The esbuild wrapper for an entry that swallows only the injection bail. */
export const guardBailWrap = (entry) => (entry.swallowGuardBail ? {
  banner: { js: 'try {' },
  footer: {
    js: '} catch (e) { if (String((e && e.message) || e).indexOf("duplicate injection") === -1) throw e; }',
  },
} : {});
