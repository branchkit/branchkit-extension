/**
 * BranchKit Browser — Caret / Visual mode (Vimium `v` / `V`).
 *
 * A keyboard-driven text caret and selection over page content, ending in a
 * yank (copy). Ported from Vimium's content_scripts/mode_visual.js. See
 * notes/DESIGN_MARKS_AND_CARET.md (Part 2).
 *
 * The whole thing is one `Movement` over `Selection.modify(alter, dir, gran)`:
 *   - Caret  = alter "move".  There's no real caret on non-editable content, so
 *              the caret is SHOWN as a 1-character selection: after each move we
 *              collapse to the anchor and extend one char forward.
 *   - Visual = alter "extend". Movements grow/shrink the selection from a fixed
 *              anchor.
 *   - Visual-line = visual that re-extends to line boundaries after each move.
 *
 * A self-contained modal handler (like the hint-mode handler) — it owns the
 * Vim movement alphabet, which deliberately shadows the Normal-mode binds
 * (`j`/`k` scroll in Normal, move the caret here), so it can't route through
 * the shared command registry.
 */

import { copyText } from '../clipboard';
import { flashToast } from '../render/toast';
import {
  openFindMode, closeFindMode, isFindActive, hasActiveMatches, findNavigate,
  findFirstRange, getCurrentMatchRange, buildBlockIndex,
} from '../scan/find';
import {
  planModify, nextGrowthDir, opposite,
  type Direction as Dir, type SelectGranularity, type ModifyPlan,
} from './selection-grammar';
import {
  nextStop, lineBoundary, applyFieldModify, readFieldRange, writeFieldRange,
  nativeModifyWasInert, entitySpan, trimSpan, type FallbackGranularity,
} from './segmenter';

type Gran =
  | 'character' | 'word' | 'line' | 'lineboundary'
  | 'sentence' | 'paragraph' | 'documentboundary';
/** Text objects for `aw`/`as`/`ap`. */
type Entity = 'word' | 'sentence' | 'paragraph';
type Alter = 'move' | 'extend';
type FieldEl = HTMLInputElement | HTMLTextAreaElement;

export type CaretMode = 'caret' | 'visual';
/** Entry kinds — `visual-line` resolves to visual mode with `lineWise`. */
export type CaretEntry = CaretMode | 'visual-line';

/**
 * One spoken selection command — the structured twin of the keyboard movement
 * keys. `extend`/`shrink` carry a granularity (+ optional direction/count);
 * `flip`/`copy`/`exit` are bare. Built from the discrete `select_*` catalog
 * commands' params (command-catalog.ts) and dispatched via `applyVoice`. See
 * notes/DESIGN_VOICE_SELECTION_BOUNDS.md.
 */
export interface SelectionCommand {
  op: 'extend' | 'shrink' | 'flip' | 'copy' | 'exit';
  granularity?: SelectGranularity;
  direction?: Dir;
  count?: number;
}

function isEditable(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return (el as HTMLElement).isContentEditable;
}

// Inputs whose text supports setSelectionRange (others — number/email/checkbox —
// throw or have no text selection, so they're not field-selection targets).
const SELECTABLE_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'password', '']);
function isSelectableField(el: Element | null): el is FieldEl {
  if (!el) return false;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName !== 'INPUT') return false;
  return SELECTABLE_INPUT_TYPES.has((el as HTMLInputElement).type.toLowerCase());
}

// The nearest block-level ancestor of a node — the unit a "paragraph" text
// object selects, and the flat-index root for word/sentence (so a sentence with
// inline <b>/<a> children is one cross-node span, not clipped at a node edge).
function nearestBlock(node: Node): HTMLElement | null {
  let el: HTMLElement | null =
    node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement);
  while (el) {
    if (el === document.body) return el;
    const d = getComputedStyle(el).display;
    if (d === 'block' || d === 'list-item' || d === 'table-cell' || d === 'flow-root') return el;
    el = el.parentElement;
  }
  return null;
}

/** Selection movement primitives over the live document selection. */
class Movement {
  alter: Alter;
  readonly sel: Selection;

  constructor(alter: Alter, sel: Selection) {
    this.alter = alter;
    this.sel = sel;
  }

  run(dir: Dir, gran: Gran): void {
    this.sel.modify(this.alter, dir, gran);
  }

  /** Extend the selection one character; return the signed length change. */
  extendByOneCharacter(dir: Dir): number {
    const before = this.sel.toString().length;
    this.sel.modify('extend', dir, 'character');
    return this.sel.toString().length - before;
  }

  /** Forward if the focus is at/after the anchor, else backward. Probes by
   *  extending a character and measuring, then restores. */
  getDirection(): Dir {
    for (const dir of ['forward', 'backward'] as Dir[]) {
      const change = this.extendByOneCharacter(dir);
      if (change) {
        this.extendByOneCharacter(opposite(dir));
        return change > 0 ? dir : opposite(dir);
      }
    }
    return 'forward';
  }

  collapseToAnchor(): void {
    if (this.sel.toString().length === 0) return;
    if (this.getDirection() === 'backward') this.sel.collapseToEnd();
    else this.sel.collapseToStart();
  }

  collapseToFocus(): void {
    if (this.sel.toString().length === 0) return;
    if (this.getDirection() === 'forward') this.sel.collapseToEnd();
    else this.sel.collapseToStart();
  }

  /** Swap the anchor and focus ends (Vimium `o`). Page-selection only (the
   *  editable fallback Vimium keeps is out of scope — caret mode is for reading
   *  page text). */
  reverse(): void {
    if (this.sel.rangeCount === 0) return;
    const dir = this.getDirection();
    const original = this.sel.getRangeAt(0).cloneRange();
    const collapsed = original.cloneRange();
    collapsed.collapse(dir === 'backward'); // keep the far end as the new anchor
    this.sel.removeAllRanges();
    this.sel.addRange(collapsed);
    if (dir === 'forward') this.sel.extend(original.startContainer, original.startOffset);
    else this.sel.extend(original.endContainer, original.endOffset);
  }

  scrollFocusIntoView(): void {
    const node = this.sel.focusNode;
    if (!node) return;
    const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
    (el as HTMLElement | null)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }
}

/**
 * As a heuristic for caret mode with no existing selection, anchor at the first
 * non-whitespace character of the first "big" visible text node (≥50 non-ws
 * chars — skips banners), skipping editables and off-screen nodes. Ported from
 * Vimium's establishInitialSelectionAnchor.
 */
function establishInitialAnchor(sel: Selection): boolean {
  if (!document.body) return false;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.textContent ?? '';
    if (text.trim().length < 50) continue;
    const el = node.parentElement;
    if (!el || isEditable(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (rect.bottom < 0 || rect.top > window.innerHeight) continue; // roughly in view
    const offset = text.length - text.replace(/^\s+/, '').length;
    const range = document.createRange();
    range.setStart(node, offset);
    range.setEnd(node, offset);
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  }
  return false;
}

/** The Vim movement keys → (direction, granularity). `w`/`e` both go forward a
 *  word (the vim `w`/`e` distinction is a follow-up); `b` goes back a word. */
const MOVES: Record<string, [Dir, Gran]> = {
  h: ['backward', 'character'],
  l: ['forward', 'character'],
  j: ['forward', 'line'],
  k: ['backward', 'line'],
  w: ['forward', 'word'],
  e: ['forward', 'word'],
  b: ['backward', 'word'],
  '0': ['backward', 'lineboundary'],
  $: ['forward', 'lineboundary'],
  ')': ['forward', 'sentence'],
  '(': ['backward', 'sentence'],
  '}': ['forward', 'paragraph'],
  '{': ['backward', 'paragraph'],
  G: ['forward', 'documentboundary'],
};

function suppress(e: KeyboardEvent): true {
  e.preventDefault();
  e.stopPropagation();
  return true;
}

export interface CaretOptions {
  /** Notified with the active mode ('caret'|'visual') on enter/switch, and null
   *  on exit — drives the KeyHandler mode + chip. */
  onModeChange: (mode: CaretMode | null) => void;
}

export class CaretController {
  private movement: Movement | null = null;
  private mode: CaretMode | null = null;
  private lineWise = false;
  private pendingG = false;
  private pendingA = false; // `a` prefix for the aw/as/ap text objects (around)
  private pendingI = false; // `i` prefix for the iw/is/ip text objects (inner)
  /** Which way the focus has been growing away from the anchor. Tracked
   *  explicitly because `Selection.direction` is unreliable (research pitfall) —
   *  drives "shrink" (extend toward the anchor) and is inverted by "flip". */
  private growthDir: Dir = 'forward';
  /** Set when the selection lives inside an editable field (input/textarea),
   *  where the document Selection can't reach — movement then runs over
   *  `value` + `selectionStart/End` via the Segmenter helpers. */
  private fieldEl: FieldEl | null = null;
  /** The caret anchor captured when `/` opens find from caret mode. Focusing the
   *  find input can drop/relocate the live document Selection, so the anchor for
   *  the find→select extend is taken from here, not `window.getSelection()`. */
  private savedAnchor: { node: Node; offset: number } | null = null;
  /** The last page caret anchor, remembered ACROSS exits so re-entering caret
   *  mode returns to where you were rather than a fresh first-text-node anchor.
   *  Persists until the node disconnects (SPA nav / DOM churn) — validated on
   *  restore, so a stale entry silently falls back to the initial anchor. */
  private lastCaretPos: { node: Node; offset: number } | null = null;

  constructor(private opts: CaretOptions) {}

  isActive(): boolean {
    return this.mode !== null;
  }

  getMode(): CaretMode | null {
    return this.mode;
  }

  /** Normal-mode `v`: extend a pre-existing selection in visual mode, else drop
   *  to caret mode. Mirrors Vimium / Vimium-C's enterVisualMode (which falls back
   *  to caret when there's no usable selection). */
  enterFromNormal(): void {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && sel.type === 'Range' && !sel.isCollapsed) {
      this.enter('visual');
    } else {
      this.enter('caret');
    }
  }

  /** Enter caret mode anchored at a specific element (Vimium's hint→caret). The
   *  caret lands on the first non-whitespace character of the element's first
   *  text node — used by the `select {hint}` verb (voice + keyboard). */
  enterAt(el: HTMLElement): void {
    // An editable field's text lives outside the document Selection — drive it
    // via value + selectionStart/End instead (the Segmenter field path).
    if (isSelectableField(el)) {
      this.enterField(el);
      return;
    }
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const node = walker.nextNode();
    if (node) {
      const text = node.textContent ?? '';
      const offset = text.length - text.replace(/^\s+/, '').length;
      range.setStart(node, offset);
      range.setEnd(node, offset);
    } else {
      range.setStart(el, 0);
      range.setEnd(el, 0);
    }
    sel.removeAllRanges();
    sel.addRange(range);
    this.movement = new Movement('move', sel);
    this.growthDir = 'forward';
    this.applyKind('caret');
  }

  /** Start a voice/keyboard selection inside an editable field. Field selection
   *  is a visual selection over `value` (the document Selection can't reach it),
   *  seeded as the word at the caret; movement runs through the Segmenter field
   *  helpers. Reachable via `select {hint}` on a text field. */
  private enterField(el: FieldEl): void {
    el.focus();
    const value = el.value ?? '';
    const caret = el.selectionStart ?? 0;
    const end = nextStop(value, 'word', caret, 'forward', 1);
    writeFieldRange(el, { anchor: caret, focus: end });
    this.fieldEl = el;
    this.movement = null;
    this.mode = 'visual';
    this.lineWise = false;
    this.growthDir = 'forward';
    this.opts.onModeChange('visual');
  }

  /** Enter from Normal mode. Establishes a caret position if there's no usable
   *  selection; aborts with a toast if the page has no selectable text. */
  enter(kind: CaretEntry): void {
    const sel = window.getSelection();
    if (!sel) return;
    if (sel.rangeCount === 0 || sel.type === 'None') {
      // Prefer the remembered caret from the last session; fall back to the
      // first-big-text-node heuristic only when there's nothing to restore.
      if (!this.restoreLastCaret(sel) && !establishInitialAnchor(sel)) {
        flashToast('No text to select here');
        return;
      }
    }
    this.movement = new Movement(kind === 'caret' ? 'move' : 'extend', sel);
    this.growthDir = 'forward';
    this.applyKind(kind);
  }

  /** Seed the selection at the remembered caret position, if it's still valid.
   *  Returns false when there's nothing remembered or the node has since
   *  detached / the offset no longer fits (→ caller uses the initial anchor). */
  private restoreLastCaret(sel: Selection): boolean {
    const pos = this.lastCaretPos;
    if (!pos || !pos.node.isConnected) return false;
    const range = document.createRange();
    try {
      range.setStart(pos.node, pos.offset);
      range.setEnd(pos.node, pos.offset);
    } catch {
      return false; // offset out of range (text changed) — fall back
    }
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  }

  handleKey(e: KeyboardEvent): boolean {
    if (!this.mode) return false;
    // Field selection has its own (smaller) key map — the document Selection
    // movement below doesn't reach input/textarea text.
    if (this.fieldEl) return this.handleFieldKey(e);
    const m = this.movement;
    if (!m) return false;

    // Two-key `gg` (to document top).
    if (this.pendingG) {
      this.pendingG = false;
      if (e.key === 'g') {
        this.applyMove('backward', 'documentboundary');
        return suppress(e);
      }
      // Not `gg` — fall through and treat this key normally.
    }

    // Text objects: `a`/`i` then w/s/p selects a whole word/sentence/paragraph
    // around the caret. `a` = "around" (keeps the trailing space, Vim's `aw`);
    // `i` = "inner" (trimmed, Vim's `iw`) — the tighter grab you usually want
    // for copying. The caret can be anywhere inside the entity.
    if (this.pendingA || this.pendingI) {
      const inner = this.pendingI;
      this.pendingA = false;
      this.pendingI = false;
      const entity: Entity | null =
        e.key === 'w' ? 'word' : e.key === 's' ? 'sentence' : e.key === 'p' ? 'paragraph' : null;
      if (entity) {
        this.selectLexicalEntity(entity, inner);
        return suppress(e);
      }
      // Not a text object — fall through.
    }

    switch (e.key) {
      case 'Escape':
        this.escape();
        return suppress(e);
      case 'g':
        this.pendingG = true;
        return suppress(e);
      case 'a':
        this.pendingA = true;
        return suppress(e);
      case 'i':
        this.pendingI = true;
        return suppress(e);
      case '/':
        // Save the anchor NOW (before the find input steals focus and can drop
        // the live selection), so committing the search extends from the caret
        // to the match — not from wherever the selection ended up. See
        // extendToCurrentMatch.
        this.savedAnchor = this.currentAnchor();
        openFindMode();
        return suppress(e);
      case 'n':
        this.findExtend(1);
        return suppress(e);
      case 'N':
        this.findExtend(-1);
        return suppress(e);
      case 'y':
        this.yank();
        return suppress(e);
      case 'Y':
        this.selectLine();
        this.yank();
        return suppress(e);
      case 'C': // yank but stay in the mode (Vimium-C YankWithoutExit)
        this.yank(false);
        return suppress(e);
      case 'o':
        this.flip();
        return suppress(e);
      case 'v':
        this.applyKind('visual');
        return suppress(e);
      case 'V':
        this.applyKind('visual-line');
        return suppress(e);
      case 'c':
        this.applyKind('caret');
        return suppress(e);
      default: {
        const move = MOVES[e.key];
        if (move) {
          this.applyMove(move[0], move[1]);
        }
        // Own every bare key while active (modal capture) — an unmapped key is
        // swallowed, never leaked to the page.
        return suppress(e);
      }
    }
  }

  /** Staged Escape — peel the layers in the reverse order they were added:
   *  **search → visual → caret → Normal**. Each Escape undoes exactly the last
   *  thing:
   *   1. Search on top (a committed find over the selection): clear the find
   *      highlight + pill, but KEEP the visual selection.
   *   2. Visual: collapse the selection back to the caret at its anchor (the spot
   *      it started from), staying in caret mode.
   *   3. Caret: exit to Normal.
   *  Search always sits above visual (a committed find can only extend an
   *  existing/created selection), so this fixed order matches the entry order for
   *  every real flow. Field selection has no layers — Escape exits. */
  private escape(): void {
    const m = this.movement;
    if (!m || this.fieldEl) { this.exit(); return; }
    if (isFindActive()) { closeFindMode(); return; }
    if (this.mode === 'visual' && !m.sel.isCollapsed) { this.collapseToCaret(); return; }
    this.exit();
  }

  /** Collapse the selection to its anchor and re-enter caret mode there. The
   *  anchor is the fixed end (where the caret started), so this returns to the
   *  original caret position rather than the far end. */
  private collapseToCaret(): void {
    const m = this.movement;
    if (!m) return;
    if (m.sel.anchorNode) m.sel.collapse(m.sel.anchorNode, m.sel.anchorOffset);
    this.growthDir = 'forward';
    this.applyKind('caret'); // repaints the 1-char caret + sets mode/chip
  }

  exit(): void {
    if (!this.mode) return;
    // A full exit (yank, "stop selecting", or the final Escape) clears any find
    // committed while selecting so its pill/highlights don't linger. Staged
    // Escape peels find first (see escape); this covers the other exits. No-op
    // when find isn't active.
    closeFindMode();
    if (this.fieldEl) {
      // Collapse to the focus so no highlighted block lingers; leave the field
      // focused so the user can resume typing.
      const r = readFieldRange(this.fieldEl);
      this.fieldEl.setSelectionRange(r.focus, r.focus);
      this.fieldEl = null;
    } else {
      // Remember the caret's anchor so a later `v` returns here (see enter).
      const sel = this.movement?.sel;
      if (sel && sel.anchorNode) {
        this.lastCaretPos = { node: sel.anchorNode, offset: sel.anchorOffset };
      }
      this.movement?.sel.removeAllRanges();
    }
    this.movement = null;
    this.mode = null;
    this.lineWise = false;
    this.pendingG = false;
    this.pendingA = false;
    this.pendingI = false;
    this.savedAnchor = null;
    this.growthDir = 'forward';
    this.opts.onModeChange(null);
  }

  /** Switch/establish a mode on the current position (enter and `v`/`V`/`c`). */
  private applyKind(kind: CaretEntry): void {
    const m = this.movement;
    if (!m) return;
    if (kind === 'caret') {
      m.alter = 'move';
      this.mode = 'caret';
      this.lineWise = false;
      m.collapseToAnchor();
      m.extendByOneCharacter('forward'); // paint the 1-char caret
    } else {
      m.alter = 'extend';
      this.mode = 'visual';
      this.lineWise = kind === 'visual-line';
      if (m.sel.isCollapsed) m.extendByOneCharacter('forward');
      if (this.lineWise) this.selectLine();
    }
    m.scrollFocusIntoView();
    this.opts.onModeChange(this.mode);
  }

  private applyMove(dir: Dir, gran: Gran): void {
    const m = this.movement;
    if (!m) return;
    if (this.mode === 'caret') {
      m.collapseToAnchor();
      m.run(dir, gran);
      m.extendByOneCharacter('forward'); // re-paint the caret
    } else {
      m.run(dir, gran);
      if (this.lineWise) this.selectLine();
    }
    m.scrollFocusIntoView();
  }

  /** Extend the selection to whole line boundaries at both ends. Forces extend
   *  (caret mode is "move") and seeds a char so it works from a bare caret —
   *  used by visual-line and by `Y` (yank line). */
  private selectLine(): void {
    const m = this.movement;
    if (!m) return;
    m.alter = 'extend';
    if (m.sel.isCollapsed) m.extendByOneCharacter('forward');
    m.run('forward', 'lineboundary');
    m.reverse();
    m.run('backward', 'lineboundary');
    m.reverse();
  }

  /** Select the word/sentence/paragraph around the caret (`aw`/`as`/`ap`, or the
   *  inner `iw`/`is`/`ip`). The caret may sit anywhere inside the entity: collapse
   *  to it, walk back to the entity start, then forward to its end. `inner` trims
   *  the surrounding whitespace (Vim's "inner text object" — what you usually want
   *  for a clean copy). Ported from Vimium's selectLexicalEntity; always yields a
   *  visual-mode range. */
  private selectLexicalEntity(entity: Entity, inner = false): void {
    const m = this.movement;
    if (!m) return;
    const sel = m.sel;
    const node = sel.focusNode;
    if (!node) return;
    // Deterministic whole-entity grab over the block's flat (cross-node) text —
    // NOT native Selection.modify, whose sentence/paragraph granularities are
    // flaky in Chrome (the reported "strange ap selection"). A paragraph = the
    // whole block; a word/sentence = the Segmenter span around the caret. The
    // caret may sit anywhere inside the entity.
    const block = nearestBlock(node);
    if (!block) return;
    const idx = buildBlockIndex(block);
    const caret = idx.posOf(node, sel.focusOffset);
    if (caret == null) return;
    let start: number;
    let end: number;
    if (entity === 'paragraph') {
      start = 0;
      end = idx.text.length;
    } else {
      ({ start, end } = entitySpan(idx.text, entity, caret));
    }
    if (inner) ({ start, end } = trimSpan(idx.text, start, end));
    const range = idx.rangeFor(start, end);
    if (!range) return;
    sel.removeAllRanges();
    sel.addRange(range);
    m.alter = 'extend';
    this.mode = 'visual';
    this.lineWise = false;
    this.growthDir = 'forward';
    m.scrollFocusIntoView();
    this.opts.onModeChange('visual');
  }

  /** Extend the selection to the next/previous find match, entering visual mode
   *  (Vimium's find-in-visual). Reuses the last committed find query — press `/`
   *  first to set one. */
  private findExtend(delta: number): void {
    if (!this.movement) return;
    if (!hasActiveMatches()) {
      flashToast('No search — press / first');
      return;
    }
    const range = findNavigate(delta);
    if (!range) {
      flashToast('No matches');
      return;
    }
    this.extendToMatchRange(range);
  }

  /** Extend the selection to the CURRENT find match, WITHOUT advancing — the
   *  auto-extend fired when a search commits while caret mode is active, so
   *  "/ query Enter" selects straight to the match instead of the user pressing
   *  `n` (which skips to the *next* occurrence — the reported "funky" behavior).
   *  `n`/`N` then adjust to other matches deliberately.
   *
   *  Anchors on the caret position saved at `/` (setBaseAndExtent), NOT the live
   *  Selection — focusing the find input can collapse/relocate it, which was
   *  producing a selection that started at the match instead of the caret. */
  extendToCurrentMatch(): void {
    const m = this.movement;
    if (!this.isActive() || !m) return;
    const range = getCurrentMatchRange();
    if (!range) return;
    const anchor = this.savedAnchor;
    this.savedAnchor = null;
    if (anchor && anchor.node.isConnected) {
      m.alter = 'extend';
      this.mode = 'visual';
      this.lineWise = false;
      this.growthDir = 'forward';
      m.sel.removeAllRanges();
      // Deterministic anchor→match span (handles a match before OR after the
      // caret; setBaseAndExtent builds the backward selection itself).
      m.sel.setBaseAndExtent(anchor.node, anchor.offset, range.endContainer, range.endOffset);
      m.scrollFocusIntoView();
      this.opts.onModeChange('visual');
    } else {
      this.extendToMatchRange(range);
    }
  }

  /** The current selection's fixed (anchor) end, or null — captured at `/` time
   *  so the find→select extend anchors on the caret, not the post-focus state. */
  private currentAnchor(): { node: Node; offset: number } | null {
    const sel = this.movement?.sel;
    if (!sel || sel.rangeCount === 0 || !sel.anchorNode) return null;
    return { node: sel.anchorNode, offset: sel.anchorOffset };
  }

  /** Keep the anchor, move the focus to a match Range (entering visual). Selects
   *  the match itself if the live selection was dropped (e.g. the find input
   *  stole focus). Shared by findExtend and extendToCurrentMatch. */
  private extendToMatchRange(range: Range): void {
    const m = this.movement;
    if (!m) return;
    m.alter = 'extend';
    this.mode = 'visual';
    this.lineWise = false;
    this.growthDir = 'forward';
    if (m.sel.rangeCount === 0) {
      const r = document.createRange();
      r.setStart(range.startContainer, range.startOffset);
      r.setEnd(range.endContainer, range.endOffset);
      m.sel.removeAllRanges();
      m.sel.addRange(r);
    } else {
      m.sel.extend(range.endContainer, range.endOffset);
    }
    m.scrollFocusIntoView();
    this.opts.onModeChange('visual');
  }

  /** Ensure we're in visual (extend) mode, seeding a 1-char selection from a
   *  bare caret so the first extend has an anchor. Field mode is already an
   *  extend-only visual selection, so nothing to do there. */
  private ensureVisual(): void {
    if (this.fieldEl) return;
    const m = this.movement;
    if (!m || this.mode === 'visual') return;
    m.alter = 'extend';
    this.mode = 'visual';
    this.lineWise = false;
    if (m.sel.isCollapsed) m.extendByOneCharacter('forward');
    this.opts.onModeChange('visual');
  }

  /** Voice-driven selection while caret mode is active — the spoken twin of the
   *  keyboard movement/yank keys. One command = one `Selection.modify` (grammar
   *  in selection-grammar.ts). No-op when caret mode isn't active (a stray "copy
   *  that" outside selection does nothing). See notes/DESIGN_VOICE_SELECTION_BOUNDS.md. */
  applyVoice(cmd: SelectionCommand): void {
    if (!this.isActive()) return;
    switch (cmd.op) {
      case 'copy': this.yank(); return;
      case 'exit': this.exit(); return;
      case 'flip': this.flip(); return;
      case 'extend':
      case 'shrink': {
        this.ensureVisual();
        const plan = planModify(
          cmd.op, cmd.granularity ?? 'word', cmd.direction, cmd.count ?? 1, this.growthDir,
        );
        this.modify(plan);
        this.growthDir = nextGrowthDir(cmd.op, cmd.direction, this.growthDir);
        return;
      }
    }
  }

  /** Apply one `Selection.modify`-equivalent to whichever surface holds the
   *  selection (page document Selection, or an editable field). */
  private modify(plan: ModifyPlan): void {
    if (this.fieldEl) this.fieldModify(plan);
    else this.pageModify(plan);
  }

  /** Page path: run native `Selection.modify` `count` times, then fall back to
   *  the Segmenter when native was inert for a granularity Firefox lacks. */
  private pageModify(plan: ModifyPlan): void {
    const m = this.movement;
    if (!m) return;
    m.alter = 'extend';
    const before = m.sel.toString().length;
    for (let i = 0; i < plan.count; i++) m.run(plan.direction, plan.granularity as Gran);
    if (nativeModifyWasInert(plan.granularity, before, m.sel.toString().length)) {
      this.segmenterFallback(plan);
    }
    m.scrollFocusIntoView();
  }

  /** Cross-engine fallback for sentence/paragraph/lineboundary where native
   *  `Selection.modify` is a no-op (Firefox). Re-derives the focus offset with
   *  the Segmenter over the focus text node. Single-node (cross-node prose is a
   *  degrade); good enough to keep the granularity working off Chrome. */
  private segmenterFallback(plan: ModifyPlan): void {
    const m = this.movement;
    const node = m?.sel.focusNode;
    if (!m || !node || node.nodeType !== Node.TEXT_NODE) return;
    const text = node.textContent ?? '';
    const cur = m.sel.focusOffset;
    let offset: number;
    if (plan.granularity === 'lineboundary') {
      offset = lineBoundary(text, cur, plan.direction);
    } else if (plan.granularity === 'sentence' || plan.granularity === 'paragraph') {
      offset = nextStop(text, plan.granularity as FallbackGranularity, cur, plan.direction, plan.count);
    } else {
      return;
    }
    m.sel.extend(node, offset);
  }

  /** Field path: move the field selection's focus via the Segmenter helpers
   *  (input/textarea text is outside the document Selection). */
  private fieldModify(plan: ModifyPlan): void {
    const el = this.fieldEl;
    if (!el) return;
    writeFieldRange(el, applyFieldModify(el.value ?? '', readFieldRange(el), plan));
  }

  /** Swap the anchor and focus ends ("flip" / "other end" / keyboard `o`), so
   *  the user can adjust the *other* end after over-extending. Inverts the
   *  tracked growth direction. Works on both the page and field selections. */
  private flip(): void {
    if (this.fieldEl) {
      const r = readFieldRange(this.fieldEl);
      writeFieldRange(this.fieldEl, { anchor: r.focus, focus: r.anchor });
    } else if (this.mode === 'visual') {
      this.movement?.reverse();
      this.movement?.scrollFocusIntoView();
    } else {
      return; // nothing to flip from a bare caret
    }
    this.growthDir = opposite(this.growthDir);
  }

  /** The smaller field key map (input/textarea): movement keys extend the field
   *  selection, `y` yanks, `o` flips, Escape exits. Bare keys are swallowed so
   *  they don't type into the field — the mode owns them, like visual mode. */
  private handleFieldKey(e: KeyboardEvent): boolean {
    const el = this.fieldEl;
    if (!el) return false;
    switch (e.key) {
      case 'Escape': this.exit(); return suppress(e);
      case 'y': this.yank(); return suppress(e);
      case 'C': this.yank(false); return suppress(e);
      case 'o': this.flip(); return suppress(e);
      default: {
        const move = MOVES[e.key];
        if (move) {
          const [dir, gran] = move;
          if (gran === 'documentboundary') {
            writeFieldRange(el, { anchor: readFieldRange(el).anchor, focus: dir === 'forward' ? (el.value?.length ?? 0) : 0 });
          } else {
            this.fieldModify({ alter: 'extend', direction: dir, granularity: gran, count: 1 });
          }
          this.growthDir = dir;
        }
        return suppress(e);
      }
    }
  }

  // --- Find → selection handoff (Phase B, notes/DESIGN_VOICE_SELECTION_BOUNDS.md) ---

  /** Promote the current find match to a live visual selection so it becomes the
   *  extendable anchor (Vimium auto-promotes caret→visual on a non-empty match) —
   *  the user finds, then immediately grows/shrinks the span. Returns false when
   *  there's no active match to promote. */
  enterFromFind(): boolean {
    const match = getCurrentMatchRange();
    const sel = window.getSelection();
    if (!match || !sel) return false;
    this.fieldEl = null;
    const r = document.createRange();
    r.setStart(match.startContainer, match.startOffset);
    r.setEnd(match.endContainer, match.endOffset);
    sel.removeAllRanges();
    sel.addRange(r);
    this.movement = new Movement('extend', sel);
    this.mode = 'visual';
    this.lineWise = false;
    this.growthDir = 'forward';
    this.movement.scrollFocusIntoView();
    this.opts.onModeChange('visual');
    return true;
  }

  /** "extend to <phrase>" / "select to <phrase>" — find the phrase (cross-node,
   *  voice-tolerant) and extend the far bound to it in one utterance (Vimium C
   *  `f`). With no live selection it selects the phrase itself; otherwise it
   *  keeps the anchor and moves the focus to the phrase. The phrase rides the
   *  platform dictated-argument path (same as "search"), so `phrase` is real
   *  page text, not a Sherpa grammar capture. */
  extendToPhrase(phrase: string): void {
    const range = findFirstRange(phrase);
    if (!range) { flashToast('Phrase not found'); return; }
    const sel = window.getSelection();
    if (!sel) return;
    this.fieldEl = null; // a page phrase targets the document, not a field
    const haveAnchor = this.isActive() && sel.rangeCount > 0 && !sel.isCollapsed;
    if (!haveAnchor) {
      const r = document.createRange();
      r.setStart(range.startContainer, range.startOffset);
      r.setEnd(range.endContainer, range.endOffset);
      sel.removeAllRanges();
      sel.addRange(r);
      this.movement = new Movement('extend', sel);
    } else {
      this.movement = this.movement ?? new Movement('extend', sel);
      this.movement.alter = 'extend';
      sel.extend(range.endContainer, range.endOffset);
    }
    this.mode = 'visual';
    this.lineWise = false;
    this.growthDir = 'forward';
    this.movement.scrollFocusIntoView();
    this.opts.onModeChange('visual');
  }

  /** The current selection's text, from whichever surface holds it. */
  private selectedText(): string {
    if (this.fieldEl) {
      return (this.fieldEl.value ?? '').slice(
        this.fieldEl.selectionStart ?? 0, this.fieldEl.selectionEnd ?? 0,
      );
    }
    return this.movement?.sel.toString() ?? '';
  }

  private yank(exit = true): void {
    const text = this.selectedText();
    if (exit) this.exit();
    if (!text) {
      flashToast('Nothing selected');
      return;
    }
    void copyText(text).then((ok) => {
      if (!ok) { flashToast('Copy failed'); return; }
      const n = text.length;
      // Show a short preview — with no visible cursor, a voice user needs to see
      // WHAT was copied, not just how much (notes/DESIGN_VOICE_SELECTION_BOUNDS.md).
      const preview = text.replace(/\s+/g, ' ').trim().slice(0, 40);
      const ellipsis = text.trim().length > 40 ? '…' : '';
      flashToast(`Yanked ${n} character${n === 1 ? '' : 's'}: ${preview}${ellipsis}`);
    });
  }
}
