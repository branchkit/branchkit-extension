import { ElementWrapper } from '../element-wrapper';
import { getCachedRect } from '../layout-cache';
import { PlacementStrategy } from './strategy';

const CELL_SIZE = 8;
const BASE_Z = 2147483000;
const MAX_SEARCH_DIST = 400;

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

const CONTENT_PADDING = 4;

function padRect(r: { x: number; y: number; width: number; height: number }): { x: number; y: number; width: number; height: number } {
  return {
    x: r.x - CONTENT_PADDING,
    y: r.y - CONTENT_PADDING,
    width: r.width + CONTENT_PADDING * 2,
    height: r.height + CONTENT_PADDING * 2,
  };
}

function markPageContent(bitmap: OccupancyBitmap): void {
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const range = document.createRange();

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (!node.textContent?.trim()) continue;
    const parent = node.parentElement;
    if (!parent) continue;
    if ((parent as HTMLElement).hasAttribute?.('data-branchkit-hint')) continue;
    const pr = parent.getBoundingClientRect();
    if (pr.bottom < 0 || pr.top > vh || pr.right < 0 || pr.left > vw) continue;

    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      if (rect.width > 0 && rect.height > 0) {
        bitmap.mark(padRect(rect));
      }
    }
  }

  const replaced = document.querySelectorAll('img, video, canvas, svg, input, select, textarea, button, iframe, hr');
  for (const el of replaced) {
    if ((el as HTMLElement).hasAttribute?.('data-branchkit-hint')) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) continue;
    bitmap.mark(padRect(rect));
  }
}

function findWhitespace(
  bitmap: OccupancyBitmap,
  targetCenterX: number,
  targetCenterY: number,
  badgeW: number,
  badgeH: number,
): { x: number; y: number } | null {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const MIN_SEARCH_DIST = 48;
  for (let dist = MIN_SEARCH_DIST; dist <= MAX_SEARCH_DIST; dist += CELL_SIZE) {
    // Top edge of ring: y = -dist, x from -dist to +dist
    for (let dx = -dist; dx <= dist; dx += CELL_SIZE) {
      const x = targetCenterX + dx - badgeW / 2;
      const y = targetCenterY - dist - badgeH / 2;
      if (x >= 0 && y >= 0 && x + badgeW <= vw && y + badgeH <= vh) {
        if (!bitmap.test({ x, y, width: badgeW, height: badgeH })) {
          return { x, y };
        }
      }
    }
    // Left edge of ring: x = -dist, y from -dist+step to +dist
    for (let dy = -dist + CELL_SIZE; dy <= dist; dy += CELL_SIZE) {
      const x = targetCenterX - dist - badgeW / 2;
      const y = targetCenterY + dy - badgeH / 2;
      if (x >= 0 && y >= 0 && x + badgeW <= vw && y + badgeH <= vh) {
        if (!bitmap.test({ x, y, width: badgeW, height: badgeH })) {
          return { x, y };
        }
      }
    }
    // Right edge of ring: x = +dist, y from -dist+step to +dist
    for (let dy = -dist + CELL_SIZE; dy <= dist; dy += CELL_SIZE) {
      const x = targetCenterX + dist - badgeW / 2;
      const y = targetCenterY + dy - badgeH / 2;
      if (x >= 0 && y >= 0 && x + badgeW <= vw && y + badgeH <= vh) {
        if (!bitmap.test({ x, y, width: badgeW, height: badgeH })) {
          return { x, y };
        }
      }
    }
    // Bottom edge of ring: y = +dist, x from -dist to +dist
    for (let dx = -dist; dx <= dist; dx += CELL_SIZE) {
      const x = targetCenterX + dx - badgeW / 2;
      const y = targetCenterY + dist - badgeH / 2;
      if (x >= 0 && y >= 0 && x + badgeW <= vw && y + badgeH <= vh) {
        if (!bitmap.test({ x, y, width: badgeW, height: badgeH })) {
          return { x, y };
        }
      }
    }
  }
  return null;
}

export class WhitespaceStrategy implements PlacementStrategy {
  name = 'whitespace';
  private bitmap: OccupancyBitmap | null = null;

  placeAll(wrappers: ElementWrapper[]): void {
    this.bitmap = new OccupancyBitmap(window.innerWidth, window.innerHeight);
    markPageContent(this.bitmap);

    const sorted = [...wrappers].sort((a, b) => {
      const ra = getCachedRect(a.element);
      const rb = getCachedRect(b.element);
      return (ra.top - rb.top) || (ra.left - rb.left);
    });

    for (let i = 0; i < sorted.length; i++) {
      const w = sorted[i];
      if (!w.hint) continue;

      const targetRect = getCachedRect(w.element);
      const size = w.hint.badgeSize;
      const cx = targetRect.left + targetRect.width / 2;
      const cy = targetRect.top + targetRect.height / 2;

      const spot = findWhitespace(this.bitmap, cx, cy, size.w, size.h);
      if (spot) {
        this.bitmap.mark({ x: spot.x, y: spot.y, width: size.w, height: size.h });
        w.hint.updatePosition(spot);
        w.hint.setLeader(targetRect, { x: spot.x, y: spot.y, width: size.w, height: size.h });
      } else {
        w.hint.updatePosition();
        w.hint.hideLeader();
      }
      w.hint.host.style.zIndex = String(BASE_Z + i);
    }
  }

  placeOne(wrapper: ElementWrapper, readingIndex: number): void {
    if (!wrapper.hint) return;
    if (!this.bitmap) {
      this.bitmap = new OccupancyBitmap(window.innerWidth, window.innerHeight);
      markPageContent(this.bitmap);
    }

    const targetRect = getCachedRect(wrapper.element);
    const size = wrapper.hint.badgeSize;
    const cx = targetRect.left + targetRect.width / 2;
    const cy = targetRect.top + targetRect.height / 2;

    const spot = findWhitespace(this.bitmap, cx, cy, size.w, size.h);
    if (spot) {
      this.bitmap.mark({ x: spot.x, y: spot.y, width: size.w, height: size.h });
      wrapper.hint.updatePosition(spot);
      wrapper.hint.setLeader(targetRect, { x: spot.x, y: spot.y, width: size.w, height: size.h });
    } else {
      wrapper.hint.updatePosition();
      wrapper.hint.hideLeader();
    }
    wrapper.hint.host.style.zIndex = String(BASE_Z + readingIndex);
  }

  clear(): void {
    this.bitmap = null;
  }
}
