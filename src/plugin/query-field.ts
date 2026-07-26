/**
 * BranchKit Browser — query-field reporting.
 *
 * Tells the plugin when focus sits in a single-line text input, so it can hold
 * the gate that declares `dictation_profile: query` (app
 * notes/DESIGN_DICTATION_PROFILES.md). Dictating into a search box or a field
 * name is querying, not writing, and WhisperKit punctuates prosody reliably —
 * "Gmail." for a word meant as a search term.
 *
 * Deliberately NARROWER than the keyboard's `isInsertMode`: a textarea or a
 * contenteditable is where you compose, and composing wants its punctuation.
 * Only a single-line `<input>` is structurally a query — a term, a name, a
 * field value. That's why this needs no per-site list to maintain: it's a
 * property of the control, not of the page.
 *
 * The reporter is edge-triggered and deduped, so a page that moves focus
 * between two inputs posts nothing. A stale `true` is mild by construction —
 * the gate is non-exclusive, so the worst case is one dictation losing a
 * period, not a suppressed command set.
 */

import type { Message } from '../types';

/** Input types whose content is a query or a value — never prose.
 *  `password` is deliberately absent: credentials are entered literally and
 *  must not be reshaped by any profile. */
const QUERY_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel']);

/** Whether dictation landing on `el` should be treated as a query. */
export function isQueryField(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLInputElement)) return false;
  if (el.readOnly || el.disabled) return false;
  return QUERY_INPUT_TYPES.has(el.type.toLowerCase());
}

type Listen = (
  target: EventTarget,
  type: string,
  handler: (e: Event) => void,
  options?: AddEventListenerOptions,
) => void;

/**
 * Watch focus and mirror "a query field has focus" to the plugin. `listen` is
 * the page session's tracked registrar, so the listeners die with the session.
 */
export function startQueryFieldReporting(listen: Listen): void {
  // Starts false, not null, so a page whose focus is nowhere interesting says
  // NOTHING at boot — otherwise every content script in every tab opens with a
  // redundant "not a query field" post.
  let reported = false;
  const send = (active: boolean): void => {
    if (active === reported) return;
    reported = active;
    chrome.runtime
      .sendMessage({ type: 'QUERY_FIELD_ACTIVE', active } as Message)
      .catch(() => {});
  };

  // focusout fires BEFORE focus lands, so `document.activeElement` still names
  // the element being left — `relatedTarget` is the one gaining focus. Reading
  // the wrong one reports a field as focused after the user has left it.
  listen(document, 'focusin', (e) => send(isQueryField(e.target)), { passive: true });
  listen(document, 'focusout',
    (e) => send(isQueryField((e as FocusEvent).relatedTarget)), { passive: true });

  // Re-assert on window focus. The plugin refuses a claim from a browser that
  // doesn't hold OS focus — a background tab must not shape dictation aimed at
  // another app — so a claim made while in the background was DROPPED, and an
  // edge-triggered reporter would never mention it again. Clearing `reported`
  // makes the next evaluation post, and posts nothing when there is nothing to
  // assert.
  listen(window, 'focus', () => {
    reported = false;
    send(isQueryField(document.activeElement));
  }, { passive: true });

  // A page can load with an input already focused (autofocus, or a restored
  // session), which fires no focus event.
  send(isQueryField(document.activeElement));
}
