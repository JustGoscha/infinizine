// Spatial index: a hierarchical ("loose") grid, the game-engine structure for many objects that
// come, go and move. Several levels of square cells, each level 8× coarser than the last; an item
// lives in the finest level where it spans at most 2 × 2 cells, so inserting, moving and removing
// touch at most four cells, and a query visits only the cells around its rect on each level —
// the same few microseconds whether the zine has a thousand elements or a million.

import type { BBox } from './geometry';

const BASE = 64; // world units: the finest cells
const FACTOR = 8;
const LEVELS = 8; // 64 … 64·8⁷ ≈ 134M world units
const OFF = 1 << 20; // cell coordinates are offset to stay positive in the key

interface Entry { level: number; keys: number[]; b: BBox }

export class SpatialGrid<T> {
  private cells: Map<number, T[]>[] = Array.from({ length: LEVELS }, () => new Map());
  private counts = new Array<number>(LEVELS).fill(0);
  private where = new Map<T, Entry>();
  private seen = new Set<T>();

  get size(): number { return this.where.size; }

  private static key(cx: number, cy: number): number { return (cx + OFF) * 2 * OFF + (cy + OFF); }

  insert(item: T, b: BBox) {
    if (this.where.has(item)) this.remove(item);
    const span = Math.max(b.maxX - b.minX, b.maxY - b.minY);
    let level = 0, size = BASE;
    while (level < LEVELS - 1 && span > size) { level++; size *= FACTOR; }
    const x0 = Math.floor(b.minX / size), x1 = Math.floor(b.maxX / size);
    const y0 = Math.floor(b.minY / size), y1 = Math.floor(b.maxY / size);
    const keys: number[] = [];
    const cells = this.cells[level];
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const k = SpatialGrid.key(cx, cy);
        let list = cells.get(k);
        if (!list) cells.set(k, (list = []));
        list.push(item);
        keys.push(k);
      }
    }
    this.counts[level]++;
    this.where.set(item, { level, keys, b: { ...b } });
  }

  remove(item: T) {
    const e = this.where.get(item);
    if (!e) return;
    const cells = this.cells[e.level];
    for (const k of e.keys) {
      const list = cells.get(k);
      if (!list) continue;
      const i = list.indexOf(item);
      if (i >= 0) { list[i] = list[list.length - 1]; list.pop(); }
      if (!list.length) cells.delete(k);
    }
    this.counts[e.level]--;
    this.where.delete(item);
  }

  has(item: T): boolean { return this.where.has(item); }
  bbox(item: T): BBox | undefined { return this.where.get(item)?.b; }

  clear() {
    for (const c of this.cells) c.clear();
    this.counts.fill(0);
    this.where.clear();
  }

  /** Every item whose box intersects `r` (each once, in no particular order). */
  query(r: BBox, out: (item: T) => void) {
    const seen = this.seen;
    seen.clear();
    let size = BASE;
    for (let level = 0; level < LEVELS; level++, size *= FACTOR) {
      if (!this.counts[level]) continue;
      const cells = this.cells[level];
      // (an item may reach a cell beyond its own box's cells only by being up to `size` big:
      // the 2 × 2 rule — so the rect, grown by nothing, finds it through the cells it touches)
      const x0 = Math.floor(r.minX / size), x1 = Math.floor(r.maxX / size);
      const y0 = Math.floor(r.minY / size), y1 = Math.floor(r.maxY / size);
      const range = (x1 - x0 + 1) * (y1 - y0 + 1);
      const visit = (list: T[]) => {
        for (const item of list) {
          if (seen.has(item)) continue;
          seen.add(item);
          const b = this.where.get(item)!.b;
          if (b.maxX < r.minX || b.minX > r.maxX || b.maxY < r.minY || b.minY > r.maxY) continue;
          out(item);
        }
      };
      if (range > cells.size) {
        // a huge rect (far out): walk the occupied cells instead of the empty ones
        for (const [k, list] of cells) {
          const cx = Math.floor(k / (2 * OFF)) - OFF, cy = (k % (2 * OFF)) - OFF;
          if (cx < x0 || cx > x1 || cy < y0 || cy > y1) continue;
          visit(list);
        }
      } else {
        for (let cy = y0; cy <= y1; cy++) {
          for (let cx = x0; cx <= x1; cx++) {
            const list = cells.get(SpatialGrid.key(cx, cy));
            if (list) visit(list);
          }
        }
      }
    }
  }
}
