/**
 * BranchKit Browser — hint resolution + dispatch-result reporting.
 *
 * Two small content-side helpers that talk to the plugin/background:
 *   - resolveHintLocally: turn a visible codeword into a stable selector
 *     (used by the options page to build domain-rule entries).
 *   - reportDispatchResult: forward a dispatch outcome to the background,
 *     which logs it on the plugin side for end-to-end visibility.
 *
 * Extracted from content.ts as part of the extension restructure (step 1,
 * carve leaf concerns). See notes/DESIGN_EXTENSION_RESTRUCTURE.md.
 */

import { WrapperStore } from '../scan/element-wrapper';
import { generateSelector } from '../scan/selector-generator';
import { accessibleName } from '../scan/accessible-name';
import { DispatchResult, Message, ResolveHintResponse } from '../types';

/**
 * Resolve a visible-hint codeword to a stable selector. Used by the
 * options page (via background) to convert "ape deck" into something like
 * `a.deleteBtn` for a domain rule entry.
 */
export function resolveHintLocally(store: WrapperStore, codeword: string): ResolveHintResponse {
  const wrapper = store.byCodeword(codeword);
  if (!wrapper) {
    return { ok: false, reason: `Codeword "${codeword.trim()}" not visible in this frame.` };
  }
  const el = wrapper.element;
  if (!el.isConnected) {
    return { ok: false, reason: 'Element is no longer in the DOM.' };
  }
  return {
    ok: true,
    selector: generateSelector(el),
    tagName: el.tagName.toLowerCase(),
    accessibleName: accessibleName(el),
  };
}

/**
 * After every BRANCHKIT_ACTION the content script attempted, send the
 * outcome to the background script, which forwards it to the plugin's
 * POST /dispatch-result endpoint. The plugin logs it so the actuator.log
 * carries end-to-end visibility from voice transcript through element
 * activation. Failures are swallowed — observability shouldn't break the
 * user-facing flow.
 */
export function reportDispatchResult(result: DispatchResult): void {
  try {
    chrome.runtime.sendMessage({
      type: 'DISPATCH_RESULT',
      payload: result,
    } as Message);
  } catch {
    // Extension context invalidated; nothing useful to do.
  }
}
