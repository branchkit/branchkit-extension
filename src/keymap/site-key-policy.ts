/**
 * Per-site keyboard policy, applied to the live `keyHandler` — full exclusion
 * (all keys to the page) and/or granular passthrough (specific keys to the
 * page, the rest of BranchKit's binds still work). Applied on install and kept
 * live as the popup/options page edits it. Voice is unaffected. The policy
 * itself lives in `keyboard-rules.ts`; this is only its application.
 *
 * **Why it is a call and not a module side effect.** It briefly lived at
 * `core/singletons.ts` module scope, which meant an async `chrome.storage`
 * read and a listener registration fired at *import* time, in *import* order —
 * and seven modules import singletons, so nothing in the tree decided when
 * boot happened. `content.ts` calls this once instead. Adding a boot line back
 * to the entry point is the point: the goal of the seam inversion is zero
 * behaviour *injection*, not zero lines.
 *
 * **Why it is not in `keyboard-rules.ts`,** which is the obvious-looking home.
 * `popup.ts` and `options.ts` are separate esbuild bundles that import that
 * file for the rule editors. Reaching `keyHandler` from it would drag the
 * whole content-script singleton graph — `new KeyHandler(...)`, the
 * dispatcher, the mode chip, the holder registry — into both of those pages,
 * side effects and all. This module is imported by `content.ts` alone, so
 * `keyboard-rules.ts` stays a pure-data leaf that any surface can read.
 *
 * See notes/DESIGN_PASS_THROUGH.md.
 */

import { keyHandler } from '../core/singletons';
import { bkLog } from '../debug/bk-log';
import { getSiteKeyState, onSiteKeysChanged } from './keyboard-rules';

/**
 * Read the effective policy for this frame's URL and push it at the handler.
 *
 * Resolves once applied; **never rejects**. A storage read that fails must not
 * surface as an unhandled rejection — the fallback is the handler's existing
 * state (on first call: no exclusion, no pass keys, i.e. BranchKit keeps every
 * bind), which is the safe direction. Exported for tests.
 */
export async function applySiteKeys(): Promise<void> {
  try {
    const { excluded, passKeys } = await getSiteKeyState(location.href);
    keyHandler.setExcluded(excluded);
    keyHandler.setPassKeys(passKeys);
  } catch (e) {
    bkLog('BK_SITE_KEYS_FAILED', { error: String(e) }, 'warn');
  }
}

/**
 * Apply the policy now and re-apply it whenever the rules change. Returns the
 * unsubscribe for the change listener.
 */
export function installSiteKeyPolicy(): () => void {
  void applySiteKeys();
  return onSiteKeysChanged(() => { void applySiteKeys(); });
}
