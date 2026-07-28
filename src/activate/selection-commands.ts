/**
 * BranchKit Browser — selection, caret, marks, and page-navigation commands.
 *
 * The first Phase-1-shaped feature module (notes/DESIGN_RESTRUCTURE_ROUND3.md):
 * it owns its handlers AND their registration. content.ts calls
 * registerSelectionCommands() from the bootstrap's feature-manifest block;
 * nothing here runs at import time.
 *
 * Covers: the previous-position registers + local/global marks (Vimium m/`),
 * caret/visual mode and the voice-selection command builder
 * (DESIGN_MARKS_AND_CARET.md, DESIGN_VOICE_SELECTION_BOUNDS.md), pagination
 * (goNext/goPrevious), URL hierarchy (gu/gU), and copy-URL (yy).
 */

import { dispatcher, keyHandler } from '../core/singletons';
import { setInnerTransientProbe } from '../core/mode-stack';
import { CaretController, type SelectionCommand } from './caret';
import { findAllRanges, openPhraseBox, clearFindPaint, onFindCommitted } from '../scan/find';
import { startRangePick, cancelRangePick } from './range-disambiguation';
import {
  PREV_POSITION_REGISTERS, isPrevPositionRegister, marksToHash, type StoredMark,
} from '../marks';
import { flashToast } from '../render/toast';
import { bkLog } from '../debug/bk-log';
import { findPageLink, type Rel } from './pagination';
import { urlUp, urlRoot } from './url-nav';
import { copyText } from './clipboard';
import type { Message } from '../types';
import type { MessageHandler } from '../core/message-router';

const isTopFrame = window === window.top;

// Previous-position registers (`` ` `` and `'`): in-memory, per page, holding the
// spot before the last jump so `` `` `` returns you.
const prevPositionRegisters: Record<string, StoredMark> = {};

function currentPosition(): StoredMark {
  return { scrollX: window.scrollX, scrollY: window.scrollY, hash: location.hash };
}
function savePreviousPosition(): void {
  const pos = currentPosition();
  for (const reg of PREV_POSITION_REGISTERS) prevPositionRegisters[reg] = pos;
}
export function restorePosition(mark: StoredMark): void {
  if (marksToHash(mark)) location.hash = mark.hash;
  else window.scrollTo(mark.scrollX, mark.scrollY);
}

// Caret / visual mode (Vimium v / V). The controller owns the Selection-API
// movement + yank; it reports its mode so the KeyHandler capture state and the
// mode chip stay in lockstep. See notes/DESIGN_MARKS_AND_CARET.md (Part 2).
export const caret = new CaretController({
  onModeChange: (mode) => {
    // The caret lifetime rides the stack inside enterCaretMode/exitCaretMode
    // (the one keyboard-side entry/exit, same shape as hint and video) —
    // caret↔visual is one lifetime, null is the exit. The plugin's exclusive
    // caret tag is DERIVED from that stack edge by the service worker
    // (background/mode-mirror.ts, Wave 3 C4a): every frame's stack counts, so
    // a SUBFRAME caret session — a designed path, resolveSelectTo routes
    // subframe matches through the chip pick — asserts the tag by
    // construction, and the per-frame edge dedupe (`caretActivePushed`) and
    // per-frame CARET_ACTIVE post this replaces are gone with the ranking
    // question they existed to answer.
    if (mode) keyHandler.enterCaretMode(mode);
    else keyHandler.exitCaretMode();
  },
});
// The caret spec's intra-mode transient probe (mode-stack.ts): the staged
// unwind — a session-owned find, then visual collapsing to its caret — has
// its one implementation in CaretController.peelInner; escape() and the
// stack's peelTop both route through it.
setInnerTransientProbe('caret', () => caret.peelInner());

// A search commit while a caret/visual selection is live extends that selection
// straight to the match, so "/ query Enter" is a find-and-select rather than a
// find you then have to press `n` through (n skips to the NEXT match).
//
// Registered HERE, next to the caret instance this module owns, rather than
// composed in content.ts: find's commit signal is a multicast whose listener
// order does not matter (see onFindCommitted), so nothing has to sequence this
// against the search badges arming on the same signal. The isActive() guard is
// the caret's own question and travels with it.
onFindCommitted(() => { if (caret.isActive()) caret.extendToCurrentMatch(); });

// (The window-focus caret re-assert timer is retired: the plugin still drains
// the exclusive caret tag on OS focus loss, and the SW now replays the
// CURRENT derivation on its own focus/connect edges — reassertMirror in
// background/mode-mirror.ts — so the heal rides the same signal the drain
// does instead of a per-frame 300 ms race. The 2026-07-25 field finding this
// timer fixed is covered by that replay.)

// The caret-mode voice-selection actions, handled inline (gated on caret mode).
// The per-granularity extend_* ids carry their granularity in the id.
type SelGran = NonNullable<SelectionCommand['granularity']>;
const EXTEND_GRANULARITY: Record<string, SelGran> = {
  extend_word: 'word', extend_sentence: 'sentence', extend_line: 'line',
  extend_paragraph: 'paragraph', extend_edge: 'lineboundary',
};
export const SELECTION_ACTIONS = new Set<string>([
  ...Object.keys(EXTEND_GRANULARITY),
  'select_shrink', 'select_whole', 'select_flip', 'select_copy', 'select_exit',
]);

/** Build a structured SelectionCommand from a discrete selection action + its
 *  params (command-catalog.ts). Central so the voice dispatch stays a one-liner. */
export function parseSelectionCommand(action: string, params?: Record<string, string>): SelectionCommand {
  const paramGran = (params?.granularity as SelGran) || 'word';
  switch (action) {
    case 'select_flip': return { op: 'flip' };
    case 'select_copy': return { op: 'copy' };
    case 'select_exit': return { op: 'exit' };
    case 'select_whole': return { op: 'select', granularity: paramGran };
    case 'select_shrink': return { op: 'shrink', granularity: paramGran };
    default: return {
      // extend_word / extend_sentence / extend_line / extend_paragraph / extend_edge
      op: 'extend',
      granularity: EXTEND_GRANULARITY[action] ?? 'word',
      direction: params?.direction === 'backward' ? 'backward' : 'forward',
      count: params?.count ? parseInt(params.count, 10) || 1 : 1,
    };
  }
}

// Pagination — follow the page's next/prev link (Vimium goNext/goPrevious).
function navigatePage(rel: Rel): void {
  const href = findPageLink(document, rel);
  if (href) location.href = href;
  else flashToast(rel === 'next' ? 'No next page' : 'No previous page');
}

/**
 * Act on a collected phrase: select it, or extend the selection to it.
 *
 * Shared by every way a phrase can arrive — the find box committing (voice or
 * keyboard), the palette, or another frame being handed the answer — so the
 * multi-match and cross-frame rules are decided in exactly one place.
 *
 * Multi-match and cross-frame rules (notes/DESIGN_TEXT_TARGETING.md,
 * "Range-match disambiguation"):
 *   - top frame, exactly one match → act immediately (the common case);
 *   - top frame with several matches, or ANY subframe with matches → codeword
 *     pick badges (startRangePick), so at most one frame can auto-select and
 *     every ambiguous case is an explicit choice. The old behavior — every
 *     frame independently selecting its own first match — is how a selection
 *     landed in a frame the user wasn't looking at (field test 2026-07-24:
 *     "copy that" → "caret mode not active").
 */
export function resolveSelectTo(query: string): void {
  const trimmed = query.trim();
  if (!trimmed) return;
  const ranges = findAllRanges(trimmed);
  // Which branch answered the phrase (none/direct/pick) — the middle of the
  // BK_PHRASE_COMMIT → BK_RANGE_PICK_WINDOW chain.
  bkLog('BK_SELECT_TO_RESOLVE', { len: trimmed.length, matches: ranges.length, top: isTopFrame });
  if (ranges.length === 0) {
    cancelRangePick('requery');
    clearFindPaint();
    if (isTopFrame) flashToast('Phrase not found');
    return;
  }
  if (ranges.length === 1 && isTopFrame) {
    cancelRangePick('resolved_direct');
    // Hand off: the selection replaces the match marking, so drop the paint
    // rather than leaving yellow under a blue selection.
    clearFindPaint();
    caret.extendToRange(ranges[0]);
    return;
  }
  // Several candidates — the paint STAYS while the chips ask which one. The
  // pick's teardown clears it on every exit, picked or abandoned.
  startRangePick(ranges, (range) => caret.extendToRange(range));
}

/** Register the selection/caret/marks/page-nav handlers on the shared
 * dispatcher + key handler. Called once from the content bootstrap. */
export function registerSelectionCommands(): void {
  // Marks (Vimium m / `). `m`/`` ` `` arm a one-shot; KeyHandler captures the
  // next key and calls back here with (op, letter, global). Storage lives in
  // the background (never the page's localStorage); local jumps restore in
  // place, globals go cross-tab.
  dispatcher.register('mark_set', () => keyHandler.armMarkSet());
  dispatcher.register('mark_jump', () => keyHandler.armMarkJump());

  keyHandler.setMarkCallback((op, letter, global) => {
    if (op === 'set') {
      const pos = currentPosition();
      chrome.runtime
        .sendMessage({
          type: 'MARK_SET',
          scope: global ? 'global' : 'local',
          letter,
          url: location.href,
          scrollX: pos.scrollX,
          scrollY: pos.scrollY,
          hash: pos.hash,
        } as Message)
        .catch(() => {});
      flashToast(`${global ? 'Global' : 'Local'} mark ${letter} set`);
      return;
    }

    // Jump. Previous-position registers restore from in-memory state.
    if (!global && isPrevPositionRegister(letter)) {
      const prev = prevPositionRegisters[letter];
      if (!prev) { flashToast('No previous position'); return; }
      savePreviousPosition(); // so `` toggles back and forth
      restorePosition(prev);
      return;
    }

    if (global) {
      void chrome.runtime
        .sendMessage({ type: 'MARK_JUMP', scope: 'global', letter, url: location.href } as Message)
        .then((resp: { ok?: boolean } | undefined) => {
          flashToast(resp?.ok ? `Jumped to global mark ${letter}` : `Global mark ${letter} not set`);
        })
        .catch(() => {});
      return;
    }

    void chrome.runtime
      .sendMessage({ type: 'MARK_JUMP', scope: 'local', letter, url: location.href } as Message)
      .then((resp: { mark?: StoredMark | null } | undefined) => {
        const mark = resp?.mark;
        if (!mark) { flashToast(`Local mark ${letter} not set`); return; }
        savePreviousPosition();
        restorePosition(mark);
        flashToast(`Jumped to local mark ${letter}`);
      })
      .catch(() => {});
  });

  keyHandler.setCaretKeyHandler((e) => caret.handleKey(e));
  // `v` extends an existing selection (visual) or drops to caret — Vimium parity.
  // With no live document selection but an active find match, promote that match
  // to the selection so a find flows straight into grow/shrink (Vimium auto-
  // promotes caret→visual on a non-empty match). See DESIGN_VOICE_SELECTION_BOUNDS.md.
  dispatcher.register('caret_mode', () => {
    const sel = window.getSelection();
    const hasSelection = !!sel && sel.rangeCount > 0 && sel.type === 'Range' && !sel.isCollapsed;
    if (!hasSelection && caret.enterFromFind()) return;
    caret.enterFromNormal();
  });
  dispatcher.register('visual_line_mode', () => caret.enter('visual-line'));
  // "highlight" / "select to" — collect a phrase, then select or extend to it.
  // Resolution lives in resolveSelectTo; this only decides whether the phrase is
  // already in hand.
  dispatcher.register('select_to', (params) => {
    const query = (params.query || '').trim();
    // No query means the phrase hasn't been collected yet: open the box in the
    // matching mode and let it do the collecting. This is the voice and keybind
    // entry (say "highlight", press gs) — the query arrives on commit, via
    // onPhrase. Callers that already HAVE a phrase (the palette, other frames
    // being told the answer) pass it and resolve straight away.
    if (!query) {
      // Top frame only. The box is one page-level affordance, and every subframe
      // opening its own would put several boxes on screen competing for focus.
      if (isTopFrame) {
        // The caller brings its own box copy and its own commit meaning
        // (find.ts PhraseTarget, Wave 3 C5b) — the extend/highlight
        // distinction is UI copy here and nothing else; both hand the phrase
        // to resolveSelectTo, which decides select-vs-extend from the live
        // selection.
        openPhraseBox(params.mode === 'extend'
          ? { glyph: '⇥', placeholder: 'Extend selection to...', onPhrase: resolveSelectTo }
          : { glyph: '✦', placeholder: 'Highlight phrase...', onPhrase: resolveSelectTo });
      }
      return;
    }
    resolveSelectTo(query);
  });

  dispatcher.register('go_next', () => navigatePage('next'));
  dispatcher.register('go_previous', () => navigatePage('prev'));
  // Copy the current page URL (Vimium yy).
  dispatcher.register('copy_url', () => {
    void copyText(location.href).then((ok) => flashToast(ok ? 'Copied URL' : 'Copy failed'));
  });
  // URL hierarchy — up one level / to the site root (Vimium gu/gU).
  dispatcher.register('go_up', () => {
    const up = urlUp(location.href);
    if (up && up !== location.href) location.href = up;
    else flashToast('Already at the top');
  });
  dispatcher.register('go_root', () => {
    const root = urlRoot(location.href);
    if (root && root !== location.href) location.href = root;
    else flashToast('Already at the root');
  });
}

// --- Global-mark restore (notes/DESIGN_ENTRY_POINT_TOPOLOGY.md phase 3) ---
//
// A global-mark jump landed on (or opened) this tab — restore the saved
// position. Top frame only; sub-frame scroll is out of scope for MVP. Was a
// branch of content.ts's onMessage chain; `restorePosition` is right here.

export const markRestoreMessageHandlers: Record<string, MessageHandler> = {
  MARK_RESTORE: (message) => {
    if (isTopFrame) restorePosition({ scrollX: message.scrollX, scrollY: message.scrollY, hash: message.hash });
  },
};
