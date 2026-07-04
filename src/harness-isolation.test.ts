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
  // Loads ONLY Rango (built from /tmp/rango-source) for the round-27/28
  // fixture A/B — no BranchKit dist in the browser, so the isolation
  // concern (a raw-dist harness joining the user's live session) cannot
  // apply. Deliberate exemption, not migration debt.
  '_test-qb-fling-rango.mjs',
  '_drive-firefox-control.mjs',
  '_drive-firefox-inner-scroll.mjs',
  '_drive-firefox-nav-ab.mjs',
  '_drive-firefox-nav.mjs',
  '_drive-firefox-youtube.mjs',
  '_inspect-youtube-sidebar.mjs',
  '_nav-probe.mjs',
  '_probe-combobox-occlusion.mjs',
  '_probe-details-cv.mjs',
  '_probe-shadow-event-worlds.mjs',
  '_refresh-loop-check.mjs',
  '_test-active-tab-gate.mjs',
  '_test-anchor-rebind.mjs',
  '_test-band-discovery.mjs',
  '_test-codeword-coverage.mjs',
  '_test-codeword-key-ownership.mjs',
  '_test-coloc-clipping.mjs',
  '_test-coverage-curve.mjs',
  '_test-dual-cs-race.mjs',
  '_test-epoch-live-repros.mjs',
  '_test-extension-baseline-f5.mjs',
  '_test-extension-reload-alt-paths.mjs',
  '_test-extension-reload-firefox.mjs',
  '_test-extension-reload-probes.mjs',
  '_test-extension-reload-refresh.mjs',
  '_test-firefox-channel-cr.mjs',
  '_test-firefox-channel-domsurvey.mjs',
  '_test-firefox-channel-find-host.mjs',
  '_test-firefox-channel-host-locate.mjs',
  '_test-firefox-channel-host-paint.mjs',
  '_test-firefox-channel-snap.mjs',
  '_test-firefox-channel-wrapper-state.mjs',
  '_test-firefox-youtube-channel-dig.mjs',
  '_test-firefox-youtube-channel-isHintable.mjs',
  '_test-firefox-youtube-dig.mjs',
  '_test-firefox-youtube-dormants.mjs',
  '_test-firefox-youtube-hostowners.mjs',
  '_test-firefox-youtube-pending.mjs',
  '_test-firefox-youtube-scan-gap.mjs',
  '_test-firefox-youtube-scroll-back.mjs',
  '_test-firefox-youtube-scroll.mjs',
  '_test-firefox-youtube-snap.mjs',
  '_test-gmail-fixture.mjs',
  '_test-hint-connection-audit.mjs',
  '_test-hints.mjs',
  '_test-leak-measure.mjs',
  '_test-live-churn.mjs',
  '_test-overflow-scroll.mjs',
  '_test-paint-latency.mjs',
  '_test-reconcile-scroll-tracking.mjs',
  '_test-regime-b-recall.mjs',
  '_test-release-frame-scope.mjs',
  '_test-scroll-back-discovery-gap.mjs',
  '_test-scroll-back-drift.mjs',
  '_test-scroll-badge-giveup.mjs',
  '_test-scroll-coverage.mjs',
  '_test-scroll-restore.mjs',
  '_test-sites.mjs',
  '_test-sse-resilience.mjs',
  '_test-trigger-probe-live.mjs',
  '_test-videos-tab-wedge.mjs',
  '_verify-anchor-tracking.mjs',
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
