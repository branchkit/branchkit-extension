/**
 * BranchKit Browser — harness-hook gate.
 *
 * One switch for every PAGE-EXPOSED test affordance: the 4Hz
 * `dataset.branchkitPerf` mirror, the `__branchkit__capture_snapshot` /
 * `__branchkit__force_teardown` CustomEvent hooks, the
 * `data-branchkit-orphan-hits` gauge, the `window.__branchkitDebugJSON`
 * boot bridge, and the `bkOpenShadow` open-shadow-root toggle. Each is a
 * page-readable (or page-dispatchable) surface: any site can fingerprint
 * the extension through them, read the full perf/debug payloads, or open
 * badge shadow roots — fine on a dev machine, not in a shipped build.
 *
 * `__HARNESS_HOOKS__` is an esbuild define: `true` in default and dev
 * builds (every local Playwright harness keeps working, with or without
 * the harness.json staging marker), `false` in release builds
 * (`--release` / `BK_RELEASE=1`, wired into the packaging scripts).
 * Undefined (vitest runs the TS directly, no defines) counts as enabled
 * so unit tests exercise the hook paths.
 *
 * Deliberately NOT gated here: the 5s PERF_REPORT ship — it goes to the
 * paired plugin, not the page, and the long-session perf trail on real
 * browsers depends on it.
 */

declare const __HARNESS_HOOKS__: boolean;

export function harnessHooksEnabled(): boolean {
  return typeof __HARNESS_HOOKS__ === 'undefined' || __HARNESS_HOOKS__;
}
