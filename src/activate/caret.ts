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
import { openFindMode, hasActiveMatches, findNavigate } from '../scan/find';

type Dir = 'forward' | 'backward';
type Gran =
  | 'character' | 'word' | 'line' | 'lineboundary'
  | 'sentence' | 'paragraph' | 'documentboundary';
/** Text objects for `aw`/`as`/`ap`. */
type Entity = 'word' | 'sentence' | 'paragraph';
type Alter = 'move' | 'extend';

export type CaretMode = 'caret' | 'visual';
/** Entry kinds — `visual-line` resolves to visual mode with `lineWise`. */
export type CaretEntry = CaretMode | 'visual-line';
/** Voice-driven selection ops (extend the selection, then copy) — the spoken
 *  twin of the keyboard movement keys. See notes/DESIGN_HINT_ACTION_MODES.md. */
export type CaretVoiceOp = 'word' | 'line' | 'sentence' | 'end' | 'start' | 'copy' | 'exit';

const opposite = (d: Dir): Dir => (d === 'forward' ? 'backward' : 'forward');

function isEditable(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return (el as HTMLElement).isContentEditable;
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
  private pendingA = false; // `a` prefix for the aw/as/ap text objects

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
    this.applyKind('caret');
  }

  /** Enter from Normal mode. Establishes a caret position if there's no usable
   *  selection; aborts with a toast if the page has no selectable text. */
  enter(kind: CaretEntry): void {
    const sel = window.getSelection();
    if (!sel) return;
    if (sel.rangeCount === 0 || sel.type === 'None') {
      if (!establishInitialAnchor(sel)) {
        flashToast('No text to select here');
        return;
      }
    }
    this.movement = new Movement(kind === 'caret' ? 'move' : 'extend', sel);
    this.applyKind(kind);
  }

  handleKey(e: KeyboardEvent): boolean {
    const m = this.movement;
    if (!m || !this.mode) return false;

    // Two-key `gg` (to document top).
    if (this.pendingG) {
      this.pendingG = false;
      if (e.key === 'g') {
        this.applyMove('backward', 'documentboundary');
        return suppress(e);
      }
      // Not `gg` — fall through and treat this key normally.
    }

    // Text objects: `a` then w/s/p selects a whole word/sentence/paragraph.
    if (this.pendingA) {
      this.pendingA = false;
      const entity: Entity | null =
        e.key === 'w' ? 'word' : e.key === 's' ? 'sentence' : e.key === 'p' ? 'paragraph' : null;
      if (entity) {
        this.selectLexicalEntity(entity);
        return suppress(e);
      }
      // Not a text object — fall through.
    }

    switch (e.key) {
      case 'Escape':
        this.exit();
        return suppress(e);
      case 'g':
        this.pendingG = true;
        return suppress(e);
      case 'a':
        this.pendingA = true;
        return suppress(e);
      case '/':
        // Open find; the search runs with the bar focused, then `n`/`N` extend
        // the selection to matches (BranchKit find is Range-based, so caret mode
        // syncs its selection to the current match — see findExtend).
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
        if (this.mode === 'visual') {
          m.reverse();
          m.scrollFocusIntoView();
        }
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

  exit(): void {
    if (!this.mode) return;
    this.movement?.sel.removeAllRanges();
    this.movement = null;
    this.mode = null;
    this.lineWise = false;
    this.pendingG = false;
    this.pendingA = false;
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

  /** Select the word/sentence/paragraph around the caret (`aw`/`as`/`ap`).
   *  Ported from Vimium's selectLexicalEntity; always yields a visual-mode
   *  range. */
  private selectLexicalEntity(entity: Entity): void {
    const m = this.movement;
    if (!m) return;
    m.alter = 'extend';
    this.mode = 'visual';
    this.lineWise = false;
    m.collapseToFocus();
    if (entity === 'word') m.run('forward', 'character'); // vim-like nudge
    m.run('backward', entity);
    m.collapseToFocus();
    m.run('forward', entity);
    m.scrollFocusIntoView();
    this.opts.onModeChange('visual');
  }

  /** Extend the selection to the next/previous find match, entering visual mode
   *  (Vimium's find-in-visual). Reuses the last committed find query — press `/`
   *  first to set one. */
  private findExtend(delta: number): void {
    const m = this.movement;
    if (!m) return;
    if (!hasActiveMatches()) {
      flashToast('No search — press / first');
      return;
    }
    const range = findNavigate(delta);
    if (!range) {
      flashToast('No matches');
      return;
    }
    m.alter = 'extend';
    this.mode = 'visual';
    this.lineWise = false;
    if (m.sel.rangeCount === 0) {
      // The selection was dropped (e.g. focusing the find input) — select the
      // match itself as the new range.
      const r = document.createRange();
      r.setStart(range.startContainer, range.startOffset);
      r.setEnd(range.endContainer, range.endOffset);
      m.sel.removeAllRanges();
      m.sel.addRange(r);
    } else {
      // Keep the anchor; move the focus to the match end.
      m.sel.extend(range.endContainer, range.endOffset);
    }
    m.scrollFocusIntoView();
    this.opts.onModeChange('visual');
  }

  /** Ensure we're in visual (extend) mode, seeding a 1-char selection from a
   *  bare caret so the first extend has an anchor. */
  private ensureVisual(): void {
    const m = this.movement;
    if (!m || this.mode === 'visual') return;
    m.alter = 'extend';
    this.mode = 'visual';
    this.lineWise = false;
    if (m.sel.isCollapsed) m.extendByOneCharacter('forward');
    this.opts.onModeChange('visual');
  }

  /** Voice-driven selection while caret mode is active — the spoken twin of the
   *  keyboard movement/yank keys. No-op when caret mode isn't active (a stray
   *  "copy that" outside selection does nothing). See DESIGN_HINT_ACTION_MODES.md. */
  applyVoice(op: CaretVoiceOp): void {
    if (!this.isActive() || !this.movement) return;
    if (op === 'copy') { this.yank(); return; }
    if (op === 'exit') { this.exit(); return; }
    this.ensureVisual();
    if (op === 'line') {
      this.selectLine();
      this.movement.scrollFocusIntoView();
      return;
    }
    const dir = op === 'start' ? 'backward' : 'forward';
    const gran = op === 'word' ? 'word' : op === 'sentence' ? 'sentence' : 'lineboundary';
    this.applyMove(dir, gran);
  }

  private yank(exit = true): void {
    const text = this.movement?.sel.toString() ?? '';
    if (exit) this.exit();
    if (!text) {
      flashToast('Nothing selected');
      return;
    }
    void copyText(text).then((ok) => {
      if (!ok) { flashToast('Copy failed'); return; }
      const n = text.length;
      flashToast(`Yanked ${n} character${n === 1 ? '' : 's'}`);
    });
  }
}
