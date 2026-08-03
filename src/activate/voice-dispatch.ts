/**
 * BranchKit Browser — the voice action dispatch, minus the two arms that
 * navigate away from this page.
 *
 * BRANCHKIT_ACTION arrives from the plugin via the background script and names
 * a verb. Most of those verbs are "resolve something on this page and act on
 * it": toggle the badges, forward to the local dispatcher, hover/focus/copy/
 * caret an element the user named by codeword, run the escape cascade, adjust
 * a selection, narrow mid-codeword, save or recall a reference.
 *
 * TWO arms are NOT here, and the boundary is a real seam rather than an import
 * constraint (notes/DESIGN_ENTRY_POINT_TOPOLOGY.md §6i):
 *
 *   - `activate` (and its tab-targeted variants) calls `preNavObserverTeardown`,
 *     the nav-time wedge preempt — it unobserves every wrapper synchronously
 *     BEFORE the simulated click swaps the DOM.
 *   - `reactivate` calls `republishForActivation`, the nav-rescan republish.
 *
 * Both are the orphan-teardown arc's lifecycle glue, which §5 of that note
 * excludes from this refactor until it is out of soak. Everything that does
 * not touch it lives here. The seam is therefore
 * "act on an element" vs "navigate away from this page", not "what happened to
 * fit" — the four helpers the two sides share (trimFrameUrl, INPUT_TYPES,
 * sealedDispatchSeen, reportNoSuchHint) went to leaves first so neither side
 * has to inject anything into the other.
 *
 * Every arm here is exercised over the real onMessage boundary by
 * `npm run harness:messages`.
 */

import { store } from '../core/store';
import { dispatcher } from '../core/singletons';
import { pageSession } from '../lifecycle/page-session';
import { toggleHints } from '../render/badge-visibility';
import { flashToast } from '../render/toast';
import { capturePhraseSnapshot } from './snapshot';
import { resolveDispatchTarget } from './dispatch-target';
import { narrowByPrefix } from '../labels/holder-registry';
import {
  saveReference, resolveReference, listReferences, noteActivated, lastActivatedElement,
} from '../scan/references';
import { activateElement, dispatchHover, INPUT_TYPES } from './event-sequence';
import { sealedDispatchSeen, reportNoSuchHint } from './sealed-gate';
import { caret, SELECTION_ACTIONS, parseSelectionCommand } from './selection-commands';
import { runEscapeCascade } from './escape-cascade';
import { copyText } from './clipboard';
import { reportDispatchResult } from '../plugin/resolve';
import { trimFrameUrl } from '../core/frame';
import type { Message } from '../types';

// Voice actions that route straight to the local dispatcher (the same handlers
// the keyboard uses). The discrete scroll/find actions are here so a contributed
// voice phrase (e.g. "scroll down" → scroll_down) runs the identical command as
// its keybind. Parameterized scroll + find_immediate carry params through.
//
// Lint D reads this set as proof an id is handled, so it has to stay beside the
// dispatch that forwards it — §6h found that leaving it in content.ts while the
// handlers it names moved away created a direction the lint cannot see.
export const DISPATCH_PASSTHROUGH_ACTIONS = new Set([
  'scroll', 'scroll_to_element', 'scroll_to_percent',
  'scroll_down', 'scroll_up', 'scroll_half_down', 'scroll_half_up',
  'scroll_full_down', 'scroll_full_up',
  'scroll_top', 'scroll_bottom', 'scroll_left', 'scroll_right',
  'find_open', 'find_close', 'find_next', 'find_previous', 'find_immediate',
  'select_to', // voice "extend to <phrase>" — dictated-argument find + extend
  'focus_input',
  'toggle_palette', // voice "palette all" — same handler as the Ctrl+K bind
  'toggle_tab_palette', // voice "palette tabs" — the tabs-only palette (Ctrl+T twin)
  'toggle_command_palette', // voice "palette commands" — the catalog source alone
  'toggle_bookmark_palette', // voice "palette bookmarks" — the bookmark source alone
  'toggle_help', // voice "help" — same handler as the ? bind
  'insert_mode', 'pass_next_key', // voice "pass all" / "pass next" — the i and \ binds
  'go_next', 'go_previous', // voice "next/previous page"
  'copy_url', // voice "copy url"
  'go_up', 'go_root', // voice "go up" / "site root"
  // voice "pause"/"mute"/"faster"/"skip ahead"/"restart video" — the media
  // executors (activate/media.ts); each no-ops in a frame with no large video
  'media_play_pause', 'media_mute', 'media_speed', 'media_seek', 'media_restart',
  'video_mode', 'video_exit', // "video" = the `w` layer's entry; exit = the mirror forwarder (C4b)
]);

/**
 * Run a voice action. Returns nothing and swallows nothing: an action this
 * module does not know falls off the end, exactly as it did when the whole
 * chain was one `else if` ladder in the entry point.
 *
 * The caller has already scoped the dispatch's `tr_` (setLogCorrelation), so
 * every bkLog below the synchronous body joins the matcher chain.
 */
export function dispatchVoiceAction(action: string, params?: Record<string, string>): void {
  if (action === 'toggle_hints') {
    // Voice "toggle" — the same handler as Shift+F. Snapshot on the show
    // direction so a codeword spoken in the same phrase resolves against the
    // freshly-painted badges.
    if (toggleHints()) capturePhraseSnapshot(store.all, performance.now());
  } else if (action === 'rescan') {
    pageSession.onUrlChange(params?.from_cache === 'true', params?.reason ?? '');
  } else if (action === 'set_badge_mode' && params?.mode) {
    chrome.storage.sync.set({ badgeDisplayMode: params.mode });
  } else if (DISPATCH_PASSTHROUGH_ACTIONS.has(action)) {
    dispatcher.dispatch(action, params);
  } else if (action === 'history_back') {
    // history.back() steps through the full history stack regardless of
    // skippable flags. The browser's UI back button skips entries whose
    // pushState ran without sticky user activation, which is every voice
    // click (synthetic events are isTrusted=false). Routing back through
    // a JS call recovers the entries the UI button walks past.
    history.back();
  } else if (action === 'history_forward') {
    // Same rationale as history_back: the UI forward button skips
    // voice-navigated SPA entries (synthetic clicks are isTrusted=false),
    // so route forward through a JS call to step the full stack.
    history.forward();
  } else if (action === 'refresh') {
    location.reload();
  } else if (action === 'hover_hint' || action === 'focus_hint' || action === 'copytext_hint'
    || action === 'caret_hint' || action === 'yank_hint') {
    // Element-verb voice actions (Vimium hint modes): resolve the codeword to
    // a wrapper and act ON it without following it —
    //   hover        → pointer-in event sequence (pointerover/enter/move +
    //                  mouse equivalents), revealing hover-state UI (player
    //                  controls, dropdown menus) without grabbing the mouse
    //                  (mirrors Rango's hoverElement).
    //   focus_hint   → focus the element (a field to type in, or any element).
    //   copytext_hint→ copy the element's visible text.
    //   caret_hint   → start a caret/visual selection at the element.
    //   yank_hint    → copy the enclosing link's URL ("copy link", yf's twin).
    // All share the same three-tier resolution as activate so codewords stay
    // consistent across verbs. None tear down wrappers or hide hints
    // (always-mode keeps badges so the user can follow up on what appeared).
    const codeword = params?.codeword ?? '';
    const resolved = resolveDispatchTarget(params, codeword);
    const target = resolved.target;
    // Same live gate as activate — the old path enforced strict at match
    // time; sealed verbs enforce it here.
    if (params?.prefix_letter != null && !sealedDispatchSeen(target)) {
      reportNoSuchHint(action, codeword, resolved.resolution, resolved.fp, params);
      return;
    }
    if (target instanceof HTMLElement) {
      store.findWrapperFor(target)?.hint?.flash();
      let detail = '';
      if (action === 'hover_hint') {
        dispatchHover(target);
        detail = 'hover dispatched';
      } else if (action === 'focus_hint') {
        target.focus();
        detail = 'focused';
      } else if (action === 'caret_hint') {
        caret.enterAt(target);
        detail = 'caret at element';
      } else if (action === 'yank_hint') {
        const href = (target.closest('a') as HTMLAnchorElement | null)?.href ?? '';
        if (href) void copyText(href).then((ok) => flashToast(ok ? 'Copied link' : 'Copy failed'));
        else flashToast('Not a link');
        detail = href ? 'link copied' : 'not a link';
      } else {
        const text = (target.textContent || '').trim();
        if (text) void copyText(text).then((ok) => flashToast(ok ? 'Copied text' : 'Copy failed'));
        else flashToast('No text');
        detail = text ? 'text copied' : 'no text';
      }
      reportDispatchResult({
        action, codeword, resolution: resolved.resolution, elem_tag: target.tagName.toLowerCase(),
        taken: 'click', ok: true,
        frame: trimFrameUrl(window.location.href),
        detail,
        fp: resolved.fp,
      });
    } else {
      reportDispatchResult({
        action, codeword, resolution: resolved.resolution, elem_tag: '',
        taken: 'skipped', ok: false,
        frame: trimFrameUrl(window.location.href),
        detail: resolved.detail || `${action} target not resolved`,
        fp: resolved.fp,
      });
    }
  } else if (action === 'escape') {
    // Voice "escape"/"over" — the Esc cascade (activate/escape-cascade.ts).
    const peeled = runEscapeCascade('voice_escape');
    reportDispatchResult({
      action, codeword: '', resolution: 'none', elem_tag: '',
      taken: peeled ? 'click' : 'skipped', ok: peeled !== '',
      frame: trimFrameUrl(window.location.href),
      detail: peeled ? `escape: ${peeled}` : 'nothing to close',
      fp: '',
    });
  } else if (SELECTION_ACTIONS.has(action)) {
    // Voice-driven adjustable selection ("extend sentence", "shrink word",
    // "flip", "copy that", "stop selecting"). No-op unless caret mode is active
    // — the CaretController guards it. See notes/DESIGN_VOICE_SELECTION_BOUNDS.md.
    const cmd = parseSelectionCommand(action, params);
    caret.applyVoice(cmd);
    reportDispatchResult({
      action, codeword: '', resolution: 'none', elem_tag: '',
      taken: caret.isActive() ? 'click' : 'skipped', ok: caret.isActive(),
      frame: trimFrameUrl(window.location.href),
      detail: caret.isActive() ? `${action} ${cmd.granularity ?? ''}`.trim() : 'caret mode not active',
      fp: '',
    });
  } else if (action === 'noop') {
    // Mid-codeword progress. The SW translates the inbound spoken prefix word
    // to its letter before forwarding (see frame-router), so `prefix` is
    // already a letter here — the same shape the keyboard's filter callback
    // passes, which is why both go through the registry's one fan-out
    // (labels/holder-registry.ts narrowByPrefix). `''` resets (pair
    // cancelled). This used to be an inline copy of the ordering that had
    // drifted twice: it hardcoded setMatchedChars(1) where the keyboard uses
    // the full prefix length, and it re-painted every link hint on any
    // prefix, including one a search badge already answered.
    narrowByPrefix(params?.prefix ?? '');
  } else if (action === 'name_reference') {
    const refName = params?.name?.toLowerCase().trim();
    if (!refName) return;
    const activated = lastActivatedElement();
    if (!activated) {
      console.warn('[BranchKit Content] name_reference: no last-activated element');
      return;
    }
    saveReference(refName, activated).then(async () => {
      const refs = await listReferences();
      const ref = refs[refName];
      try {
        chrome.runtime.sendMessage({
          type: 'REFERENCE_SAVED',
          host: window.location.hostname,
          name: refName,
          reference: ref as unknown as Record<string, unknown>,
        } as Message);
        chrome.runtime.sendMessage({ type: 'REFERENCE_NAMES_CHANGED' } as Message);
      } catch { /* context invalidated */ }
    });
  } else if (action === 'resolve_reference') {
    const refName = params?.name?.toLowerCase().trim();
    if (!refName) return;
    resolveReference(refName).then(el => {
      if (!el) {
        console.warn('[BranchKit Content] resolve_reference: not found:', refName);
        return;
      }
      noteActivated(el);
      if (el instanceof HTMLElement) {
        store.findWrapperFor(el)?.hint?.flash();
        if (INPUT_TYPES.has(el.tagName.toLowerCase())) {
          el.focus();
        } else {
          activateElement(el);
        }
      }
    });
  }
}
