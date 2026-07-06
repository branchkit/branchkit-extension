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

type Dir = 'forward' | 'backward';
type Gran = 'character' | 'word' | 'line' | 'lineboundary' | 'documentboundary';
type Alter = 'move' | 'extend';

export type CaretMode = 'caret' | 'visual';
/** Entry kinds — `visual-line` resolves to visual mode with `lineWise`. */
export type CaretEntry = CaretMode | 'visual-line';

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

  constructor(private opts: CaretOptions) {}

  isActive(): boolean {
    return this.mode !== null;
  }

  getMode(): CaretMode | null {
    return this.mode;
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

    switch (e.key) {
      case 'Escape':
        this.exit();
        return suppress(e);
      case 'g':
        this.pendingG = true;
        return suppress(e);
      case 'y':
        this.yank();
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

  /** Extend the selection to whole line boundaries at both ends (visual-line). */
  private selectLine(): void {
    const m = this.movement;
    if (!m || m.sel.isCollapsed) return;
    m.run('forward', 'lineboundary');
    m.reverse();
    m.run('backward', 'lineboundary');
    m.reverse();
  }

  private yank(): void {
    const text = this.movement?.sel.toString() ?? '';
    this.exit();
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
