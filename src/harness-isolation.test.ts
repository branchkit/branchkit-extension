import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Harness-isolation ratchet (notes/DESIGN_EXTENSION_CONNECTION_HEALTH.md,
 * piece B).
 *
 * A harness script that launches the raw dist/ connects to a live BranchKit
 * like a real browser — claiming OS focus and projecting fixture grammar into
 * the user's session (2026-07-02 incident). scripts/lib/launch.mjs stages a
 * marked copy that the extension treats as deterministically standalone, so
 * every script must launch through it.
 *
 * The GRANDFATHERED list is the pre-helper underscore one-off diagnostics,
 * frozen at introduction time. The ratchet only tightens:
 *  - a NEW script (or any maintained, non-underscore script) that launches
 *    without the helper fails the test;
 *  - a grandfathered script that gets migrated or deleted must leave the
 *    list, so the list shrinks monotonically and can't quietly re-grow.
 */

const SCRIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts');

const GRANDFATHERED = new Set([
  // Survivors of the 2026-07-18 script prune (scripts/README.md) that
  // predate lib/launch.mjs. Migrate-or-delete before adding anything here.
  '_test-gmail-fixture.mjs',
  '_test-hints.mjs',
  '_test-sites.mjs',
  '_test-sse-resilience.mjs',
  '_test-videos-tab-wedge.mjs',
]);

function scriptFiles(): string[] {
  return readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith('.mjs'));
}

function launchesRaw(file: string): boolean {
  const text = readFileSync(resolve(SCRIPTS_DIR, file), 'utf8');
  return text.includes('launchPersistentContext') && !text.includes('lib/launch.mjs');
}

describe('harness isolation ratchet', () => {
  it('every non-grandfathered script that launches a browser uses lib/launch.mjs', () => {
    const offenders = scriptFiles().filter(
      (f) => !GRANDFATHERED.has(f) && launchesRaw(f),
    );
    expect(offenders, 'new harness scripts must launch via scripts/lib/launch.mjs ' +
      '(standalone marker + live-actuator pre-flight)').toEqual([]);
  });

  it('the grandfather list only shrinks (migrated/deleted scripts leave it)', () => {
    const files = new Set(scriptFiles());
    const stale = [...GRANDFATHERED].filter(
      (f) => !files.has(f) || !launchesRaw(f),
    );
    expect(stale, 'these entries no longer need grandfathering — remove them ' +
      'from GRANDFATHERED so the ratchet stays tight').toEqual([]);
  });

  it('grandfathers only underscore one-off diagnostics', () => {
    for (const f of GRANDFATHERED) {
      expect(f.startsWith('_'), `${f}: maintained scripts must use the helper`).toBe(true);
    }
  });
});
