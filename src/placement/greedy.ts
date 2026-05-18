import { HintBadge } from '../hints';
import { ElementWrapper } from '../element-wrapper';
import { getCachedRect } from '../layout-cache';
import { PlacementStrategy } from './strategy';

interface CandidateRect {
  x: number;
  y: number;
  width: number;
  height: number;
  position: number;
}

const CELL_SIZE = 8;

class OccupancyBitmap {
  private cells: Uint8Array;
  private cols: number;
  private rows: number;

  constructor(viewportWidth: number, viewportHeight: number) {
    this.cols = Math.ceil(Math.max(viewportWidth, 0) / CELL_SIZE) || 0;
    this.rows = Math.ceil(Math.max(viewportHeight, 0) / CELL_SIZE) || 0;
    this.cells = new Uint8Array(this.cols * this.rows);
  }

  mark(rect: { x: number; y: number; width: number; height: number }): void {
    const [c0, r0, c1, r1] = this.clampCells(rect);
    for (let r = r0; r < r1; r++) {
      const row = r * this.cols;
      for (let c = c0; c < c1; c++) {
        this.cells[row + c] = 1;
      }
    }
  }

  test(rect: { x: number; y: number; width: number; height: number }): boolean {
    const [c0, r0, c1, r1] = this.clampCells(rect);
    if (c0 >= c1 || r0 >= r1) return false;
    for (let r = r0; r < r1; r++) {
      const row = r * this.cols;
      for (let c = c0; c < c1; c++) {
        if (this.cells[row + c]) return true;
      }
    }
    return false;
  }

  clear(): void {
    this.cells.fill(0);
  }

  private clampCells(rect: { x: number; y: number; width: number; height: number }): [number, number, number, number] {
    const x0 = Math.max(0, Math.floor(rect.x / CELL_SIZE));
    const y0 = Math.max(0, Math.floor(rect.y / CELL_SIZE));
    const x1 = Math.min(this.cols, Math.ceil((rect.x + rect.width) / CELL_SIZE));
    const y1 = Math.min(this.rows, Math.ceil((rect.y + rect.height) / CELL_SIZE));
    return [x0, y0, x1, y1];
  }
}

function generateCandidates(
  targetRect: { left: number; right: number; top: number; bottom: number },
  badgeSize: { w: number; h: number },
): CandidateRect[] {
  const { w, h } = badgeSize;
  return [
    { x: targetRect.left - w * 0.3,  y: targetRect.top + 2,            width: w, height: h, position: 1 },
    { x: targetRect.left,            y: targetRect.top - h - 2,        width: w, height: h, position: 2 },
    { x: targetRect.right - w,       y: targetRect.top - h - 2,        width: w, height: h, position: 3 },
    { x: targetRect.left,            y: targetRect.bottom + 2,         width: w, height: h, position: 4 },
    { x: targetRect.right - w,       y: targetRect.bottom + 2,         width: w, height: h, position: 5 },
    { x: targetRect.right + 4,       y: targetRect.bottom + 2,         width: w, height: h, position: 6 },
  ];
}

const BASE_Z = 2147483000;

function placeWithBitmap(
  wrapper: ElementWrapper,
  bitmap: OccupancyBitmap,
  zIndex: number,
): void {
  const hint = wrapper.hint!;
  const targetRect = getCachedRect(wrapper.element);
  const size = hint.badgeSize;
  const candidates = generateCandidates(targetRect, size);

  let chosen: CandidateRect | null = null;
  for (const c of candidates) {
    if (!bitmap.test(c)) {
      chosen = c;
      break;
    }
  }
  if (!chosen) chosen = candidates[0];

  bitmap.mark(chosen);
  hint.updatePosition(chosen);
  hint.host.style.zIndex = String(zIndex);

  if (chosen.position === 1) {
    hint.hideLeader();
  } else {
    hint.setLeader(targetRect, chosen);
  }
}

export class GreedyStrategy implements PlacementStrategy {
  name = 'greedy';
  private bitmap: OccupancyBitmap | null = null;

  placeAll(wrappers: ElementWrapper[]): void {
    this.bitmap = new OccupancyBitmap(window.innerWidth, window.innerHeight);

    const sorted = [...wrappers].sort((a, b) => {
      const ra = getCachedRect(a.element);
      const rb = getCachedRect(b.element);
      return (ra.top - rb.top) || (ra.left - rb.left);
    });

    for (let i = 0; i < sorted.length; i++) {
      if (!sorted[i].hint) continue;
      placeWithBitmap(sorted[i], this.bitmap, BASE_Z + i);
    }
  }

  placeOne(wrapper: ElementWrapper, readingIndex: number): void {
    if (!wrapper.hint) return;
    if (!this.bitmap) this.bitmap = new OccupancyBitmap(window.innerWidth, window.innerHeight);
    placeWithBitmap(wrapper, this.bitmap, BASE_Z + readingIndex);
  }

  clear(): void {
    this.bitmap = null;
  }
}

export { OccupancyBitmap, generateCandidates };
