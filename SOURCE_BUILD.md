# Building BranchKit Browser from source (for AMO / store reviewers)

This add-on's submitted JavaScript is bundled with [esbuild](https://esbuild.github.io/).
Per Mozilla's source-submission policy, these are the exact steps to reproduce the
submitted `dist/firefox` bundle from source.

## Environment

- **Node.js 24.x** (see `.nvmrc`; developed on 24.3.0)
- **npm** (ships with Node); no other global tooling required
- OS-independent (developed on macOS; builds on Linux/Windows the same way)

## Reproduce the submitted build

```bash
npm ci                              # install exact locked dependencies
BK_BUILD_ID=<id-from-submission> npm run package:firefox
```

- `npm run package:firefox` runs `node scripts/build.mjs firefox --release`
  (esbuild bundle → `dist/firefox/`) and then `web-ext build` to produce the
  `.zip` in `artifacts/`.
- **`BK_BUILD_ID`** is the one otherwise-nondeterministic input: the build stamps
  a build identifier into the bundle (used to identify which build a running
  content script came from). Set it to the value included with the submission and
  the output is **byte-identical** to what was uploaded. Without it, the only diff
  from the submitted files is that timestamp string.

## What the build does

- One base `manifest.json` (Firefox-shaped) is transformed per target by
  `scripts/build-manifest.mjs` (deterministic; Chrome-only keys like `offscreen`
  and `use_dynamic_url` are layered into the Chrome build, stripped from Firefox).
- `--release` sets `__HARNESS_HOOKS__=false` (disables test-only hooks). Always
  use the release build for store packaging.
- No code is fetched or generated from the network at build or run time; all
  dependencies come from `package-lock.json`.

## Verify

```bash
npm run lint:firefox    # web-ext lint — expected: 0 errors
npm test                # vitest unit suite
```

## Source layout (entry points)

- `src/background.ts` → `background.js` (service worker / event page)
- `src/bootstrap.ts` → `bootstrap.js` (MAIN-world bridge, ~1 KB)
- `src/content.ts` → `content.js` (page content script — hint badges, keyboard)
- `src/offscreen.ts`, `src/options.ts`, `src/popup.ts`, `src/palette-page.ts` →
  their respective `.js` / HTML pages

The unminified, commented TypeScript sources under `src/` are the human-readable
form of everything in the bundle.
