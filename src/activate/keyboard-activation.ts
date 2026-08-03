/**
 * BranchKit Browser — the keyboard half of activation.
 *
 * `activateWrapper` is where every keyboard path that resolves a badge ends:
 * the store's CodewordHolder delegate when a typed codeword completes, and
 * nothing else since `activate_hint` was deleted (2026-07-28 — it had never
 * been dispatchable; see command-catalog.ts). The VOICE half of the same verbs
 * lives in activate/voice-dispatch.ts, and section 6g.7's measurement is why
 * the two are separate files rather than one: they are the same verb to the
 * user and share no dependency. The keyboard arms are `armHintAction(kind)`
 * plus `enterHintMode()` and close over nothing; the voice arms resolve a
 * codeword through three tiers and act on it. This module is what the keyboard
 * arms eventually reach, once the user has typed.
 *
 * Its own module rather than a home in an existing one, on section 6g.7's rule
 * (ask the graph first). `keyboard-commands.ts` deliberately sits below the
 * singletons and would have to drag caret, references and badge-visibility down
 * with it; `event-sequence.ts` is the primitive this calls, so depending back on
 * caret and the store would invert the layer and close cycles;
 * `badge-visibility.ts` owns whether badges are on screen, not what happens to
 * an element.
 *
 * Registers nothing at import time — it has no commands to register. Its two
 * exports are called, never installed.
 */

import { keyHandler } from '../core/singletons';
import { copyText } from './clipboard';
import { flashToast } from '../render/toast';
import { activateElement, dispatchHover, resolveNavTarget } from './event-sequence';
import { caret } from './selection-commands';
import { noteActivated } from '../scan/references';
import {
  clearHintFilter, hideBadges, shouldAutoShowBadges, scheduleHintRefresh,
} from '../render/badge-visibility';
import type { ElementWrapper } from '../scan/element-wrapper';

// Visibility handoff after a keyboard hint action. In always-mode we clear
// narrowing/keyboard state and schedule a refresh; in manual-mode we fully hide
// so the user can re-summon explicitly. Shared by every activateWrapper verb.
function hintActionHandoff(): void {
  if (shouldAutoShowBadges()) {
    clearHintFilter();
    scheduleHintRefresh();
  } else {
    hideBadges();
  }
}

/**
 * Returns true when the hint gather CONTINUES — a background open ("Aa")
 * keeps badges painted and hint mode live, so the caller must not hide.
 * Every other verb ends the interaction as before (false).
 */
export function activateWrapper(wrapper: ElementWrapper): boolean {
  const el = wrapper.element as HTMLElement;
  // Consume the keyboard hint action and reset immediately, so no path can leak
  // it to the next activation. See notes/DESIGN_HINT_ACTION_MODES.md.
  //
  // NOT named `action`, and that is load-bearing rather than style. Lint D
  // reads `action === '…'` across a whole ROUTE_FILE as proof a voiced command
  // id has an extension-side route, so while these six keyboard hint verbs
  // were called `action` they silently vouched for yank/copytext/focus/hover/
  // caret/newtab — none of which any BRANCHKIT_ACTION arm handles. Measured:
  // a voiced entry `{ id: 'hover' }` with no route passed as "all 77 voiced
  // catalog actions handled", and failed correctly once this stopped matching.
  // Those are the shortened forms of hover_hint/focus_hint/caret_hint/
  // copytext_hint, i.e. exactly what a future edit reaches for.
  const hintAction = keyHandler.takeHintAction();

  // Verbs that act ON the element without following it (Vimium hint modes).
  if (hintAction === 'yank') {
    // Copy the link's URL (Vimium yf).
    const href = (el.closest('a') as HTMLAnchorElement | null)?.href ?? '';
    wrapper.hint?.flash();
    if (href) void copyText(href).then((ok) => flashToast(ok ? 'Copied link' : 'Copy failed'));
    else flashToast('Not a link');
    hintActionHandoff();
    return false;
  }
  if (hintAction === 'copytext') {
    // Copy the element's visible text (Vimium copy-link-text).
    const text = (el.textContent || '').trim();
    wrapper.hint?.flash();
    if (text) void copyText(text).then((ok) => flashToast(ok ? 'Copied text' : 'Copy failed'));
    else flashToast('No text');
    hintActionHandoff();
    return false;
  }
  if (hintAction === 'focus') {
    // Focus without activating — a field to type in, or any element (Vimium focus).
    wrapper.hint?.flash();
    el.focus();
    flashToast('Focused');
    hintActionHandoff();
    return false;
  }
  if (hintAction === 'hover') {
    // Reveal hover-state UI (menus, player controls) without clicking (Vimium
    // hover). The always-mode handoff re-scans, so badges appear for whatever
    // the hover just exposed. Voice "hover {hint}" is the twin (plugin-side).
    wrapper.hint?.flash();
    dispatchHover(el);
    flashToast('Hovered');
    hintActionHandoff();
    return false;
  }
  if (hintAction === 'caret') {
    // Start a caret/visual selection AT this element (Vimium hint→caret). Then
    // drive it by keyboard (hjkl/y) or voice ("select word" / "copy that").
    wrapper.hint?.flash();
    hintActionHandoff();
    caret.enterAt(el);
    return false;
  }

  // "Aa" — a capital FIRST letter: voice "stash"'s keyboard twin. Open the
  // link behind (the SW owns chrome.tabs) and keep gathering: badges stay
  // painted and hint mode stays live with the prefix peeled, so the next
  // codeword types immediately. A non-anchor target falls through to plain
  // activation below, exactly like the voice twin's fallback.
  if (hintAction === 'background') {
    const nav = resolveNavTarget(el);
    const href = nav && (nav.protocol === 'http:' || nav.protocol === 'https:')
      ? nav.href : null;
    if (href) {
      wrapper.hint?.flash();
      noteActivated(el);
      void chrome.runtime.sendMessage({ type: 'OPEN_TAB_BACKGROUND', url: href });
      keyHandler.peelHintPrefix();
      if (shouldAutoShowBadges()) scheduleHintRefresh();
      return true;
    }
  }

  noteActivated(el);
  hintActionHandoff();

  wrapper.hint?.flash();
  if (wrapper.category === 'input') {
    el.focus();
  } else {
    activateElement(el, { newTab: hintAction === 'newtab' });
  }
  return false;
}