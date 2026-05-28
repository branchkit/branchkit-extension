#!/usr/bin/env node
/**
 * Build a target-specific `dist/manifest.json` from the base `manifest.json`.
 *
 * Usage: node scripts/build-manifest.mjs <chrome|firefox>
 *
 * The base manifest is structured to be Firefox-compatible by default
 * (it omits Chrome-only permissions). Chrome builds layer those back in.
 * Chrome-and-Firefox-shared fields (`background.service_worker` +
 * `background.scripts`, `browser_specific_settings.gecko`) live in the
 * base manifest unchanged — each browser silently ignores the other's
 * fields, so no patching needed for those.
 *
 * Single source of truth principle: one manifest.json, two
 * deterministic outputs. If a third browser shows up, add a branch
 * here; the JS bundles never change.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const target = process.argv[2];
if (target !== 'chrome' && target !== 'firefox') {
  console.error('usage: build-manifest.mjs <chrome|firefox>');
  process.exit(1);
}

const base = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));

// Per-browser patches. Each branch mutates `base` to its target shape.
if (target === 'chrome') {
  // Chrome supports chrome.offscreen.createDocument for persistent
  // EventSource in MV3. Firefox doesn't have this API and warns on the
  // unknown permission, so it lives only in the Chrome output.
  if (!base.permissions.includes('offscreen')) {
    base.permissions.push('offscreen');
  }
} else if (target === 'firefox') {
  // Firefox doesn't recognize the `offscreen` permission; AMO's
  // validator flags it. Strip if present.
  base.permissions = base.permissions.filter((p) => p !== 'offscreen');
  // Firefox ignores `background.service_worker` and warns about it
  // during AMO review — `background.scripts` is the Firefox-supported
  // form. Both fields coexist in the base manifest so Chrome sees
  // service_worker; strip the unused one for the Firefox bundle so
  // AMO doesn't flag it.
  if (base.background?.service_worker) {
    delete base.background.service_worker;
  }
  // `data_collection_permissions` is now required on all new Firefox
  // submissions (and will be required on updates "in the future").
  // BranchKit's PRIVACY.md affirms: no PII collected, all data stays
  // on localhost. Declare "none" to satisfy the requirement.
  base.browser_specific_settings.gecko.data_collection_permissions = {
    required: ['none'],
  };
}

writeFileSync(resolve(root, 'dist/manifest.json'), JSON.stringify(base, null, 2) + '\n');
console.log(`wrote dist/manifest.json for ${target}`);
