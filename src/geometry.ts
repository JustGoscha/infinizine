// World-space geometry: sample denoising, the blob lasso closure, bounding
// boxes, hit-testing for eraser / lasso / selection, element translation.

import type { StrokePoint, Element } from './types';
import { pressure } from './pressure';

/** Shift an element in world space (boxes by origin, strokes/fills by every point). */
export function translateElement(el: Element, dx: number, dy: number) {
  if (el.kind === 'text' || el.kind === 'image') {
    el.x += dx;
    el.y += dy;
  } else {
    for (const p of el.points) { p.x += dx; p.y += dy; }
  }
}

/** Spatial Gaussian denoise along the polyline. `sigma` is in world units —
 * pass ~1.2 screen px worth (1.2 / zoom at drawing time) so quantisation
 * jitter from the digitiser is removed identically at every zoom level.
 * The line is mirrored across both endpoints so the window stays symmetric
 * all the way to the ends: no backward pull at the tip, endpoints exact. */
export function denoise(points: StrokePoint[], sigma: number): StrokePoint[] {
  const n = points.length;
  if (n < 3 || sigma <= 0) return points;
  const arc = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    arc[i] = arc[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  const last = n - 1;
  const total = arc[last];
  // mirrored access: j < 0 reflects around the start, j > last around the end
  const px = (j: number) => (j < 0 ? 2 * points[0].x - points[-j].x : j > last ? 2 * points[last].x - points[2 * last - j].x : points[j].x);
  const py = (j: number) => (j < 0 ? 2 * points[0].y - points[-j].y : j > last ? 2 * points[last].y - points[2 * last - j].y : points[j].y);
  const pa = (j: number) => (j < 0 ? -arc[-j] : j > last ? 2 * total - arc[2 * last - j] : arc[j]);
  const reach = sigma * 3;
  const inv = 1 / (2 * sigma * sigma);
  const out: StrokePoint[] = new Array(n);
  out[0] = points[0];
  out[last] = points[last];
  let lo = 0;
  for (let i = 1; i < last; i++) {
    while (lo < i && arc[i] - arc[lo] > reach) lo++;
    // near the start the window reaches into the mirrored region (j < 0)
    let jStart = lo;
    if (lo === 0 && arc[i] < reach) {
      let m = 0;
      while (m < last && arc[m + 1] <= reach - arc[i]) m++;
      jStart = -m;
    }
    let sx = 0, sy = 0, sw = 0;
    for (let j = jStart; j <= 2 * last; j++) {
      const d = pa(j) - arc[i];
      if (d > reach) break;
      const w = Math.exp(-d * d * inv);
      sx += px(j) * w; sy += py(j) * w; sw += w;
    }
    out[i] = { ...points[i], x: sx / sw, y: sy / sw };
  }
  return out;
}

/** denoise() for a closed loop (lasso fill): wrap-pads both ends so the seam
 * between last and first point is smoothed like everywhere else. */
export function denoiseClosed(points: { x: number; y: number }[], sigma: number): { x: number; y: number }[] {
  const n = points.length;
  if (n < 4 || sigma <= 0) return points;
  const m = Math.min(n, 24);
  const asPts = (arr: { x: number; y: number }[]) => arr.map((q) => ({ x: q.x, y: q.y, p: 0.5, t: 0 }));
  const padded = asPts([...points.slice(n - m), ...points, ...points.slice(0, m)]);
  return denoise(padded, sigma).slice(m, m + n).map((q) => ({ x: q.x, y: q.y }));
}

/** Incremental denoise for the stroke being drawn: points further than the
 * Gaussian reach behind the tip can never change again, so they're kept;
 * each frame only the tail is recomputed. Same result as denoise() on commit. */
/** Blob lasso closure. A lasso ends where the pen lifts; the plain fill closes it with a
 * straight cut from there back to the start. The blob closes along a cubic Bézier that leaves
 * the end the way the pen was travelling and arrives at the start the way it set off — with
 * both directions leaned toward the cut and short handles, so the curve bulges gently the way
 * the hand was going and never swings out and back (that left a nook at each corner). The
 * drawn part is returned untouched. */
export function closeBlob(pts: { x: number; y: number }[]): { x: number; y: number }[] {
  const n = pts.length;
  if (n < 4) return pts;
  const first = pts[0], last = pts[n - 1];
  const gap = Math.hypot(first.x - last.x, first.y - last.y);
  let drawn = 0;
  for (let i = 1; i < n; i++) drawn += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  if (gap < (drawn / (n - 1)) * 2) return pts; // already closed
  const unit = (dx: number, dy: number) => { const l = Math.hypot(dx, dy) || 1; return { x: dx / l, y: dy / l }; };
  // travel direction over a run of samples about half the gap long (the lift-off wobble is noise)
  const reach = Math.max(gap * 0.5, 2);
  const runFrom = (i: number, step: 1 | -1) => {
    let j = i, len = 0;
    while (j + step >= 0 && j + step < n && len < reach) {
      len += Math.hypot(pts[j + step].x - pts[j].x, pts[j + step].y - pts[j].y);
      j += step;
    }
    return pts[j];
  };
  const tail = runFrom(n - 1, -1), head = runFrom(0, 1);
  const chord = unit(first.x - last.x, first.y - last.y); // the cut, end → start
  const lean = (t: { x: number; y: number }) => unit(t.x * 0.5 + chord.x * 0.5, t.y * 0.5 + chord.y * 0.5);
  const tEnd = lean(unit(last.x - tail.x, last.y - tail.y)); // leave the end carrying on
  const tStart = lean(unit(head.x - first.x, head.y - first.y)); // arrive at the start the way it set off
  const h = gap * 0.35;
  const c1 = { x: last.x + tEnd.x * h, y: last.y + tEnd.y * h };
  const c2 = { x: first.x - tStart.x * h, y: first.y - tStart.y * h };
  const k = Math.max(6, Math.min(48, Math.round(gap / 3)));
  const out = pts.slice();
  for (let i = 1; i < k; i++) {
    const t = i / k, u = 1 - t;
    out.push({
      x: u * u * u * last.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * first.x,
      y: u * u * u * last.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * first.y,
    });
  }
  return out;
}

export class LiveDenoiser {
  private id = '';
  private final: StrokePoint[] = [];
  private arc: number[] = [];
  /** how many leading points are final (their smoothing window is complete) */
  get settled(): number { return this.final.length; }
  update(id: string, points: StrokePoint[], sigma: number): StrokePoint[] {
    const n = points.length;
    if (id !== this.id || this.arc.length > n) { this.id = id; this.final = []; this.arc = []; }
    if (n < 3 || sigma <= 0) return points;
    for (let i = this.arc.length; i < n; i++) {
      this.arc[i] = i ? this.arc[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y) : 0;
    }
    const arc = this.arc;
    const reach = sigma * 3;
    const f = this.final.length;
    let s = f;
    while (s > 0 && arc[f] - arc[s] < reach) s--;
    const out = denoise(points.slice(s), sigma);
    const result = f ? this.final.concat(out.slice(f - s)) : out;
    // settle everything at least `reach` behind the tip (its window is complete)
    let nf = f;
    while (nf < n && arc[n - 1] - arc[nf] >= reach) nf++;
    for (let i = f; i < nf; i++) this.final.push(result[i]);
    return result;
  }
}

export interface BBox { minX: number; minY: number; maxX: number; maxY: number }

export function elementBBox(el: Element): BBox {
  if (el.kind === 'text' || el.kind === 'image') {
    return { minX: el.x - 2, minY: el.y - 2, maxX: el.x + el.w + 2, maxY: el.y + el.h + 2 };
  }
  const pts: { x: number; y: number }[] = el.points;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  // pencil strokes can fan out far beyond the base width when tilted
  const pad =
    el.kind === 'stroke'
      ? el.baseWidth * (el.tool === 'pencil' ? Math.max(2.5, 0.8 * pressure.pencil.tilt + 1) : 2.5)
      : 2;
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

export function bboxIntersects(b: BBox, r: { x: number; y: number; w: number; h: number }): boolean {
  return b.maxX >= r.x && b.minX <= r.x + r.w && b.maxY >= r.y && b.minY <= r.y + r.h;
}

/** Eraser hit-test: does any segment of the element pass within `radius` of (x,y)? */
export function hitElement(el: Element, x: number, y: number, radius: number): boolean {
  const b = elementBBox(el);
  if (x < b.minX - radius || x > b.maxX + radius || y < b.minY - radius || y > b.maxY + radius) return false;
  if (el.kind === 'text' || el.kind === 'image') return true; // bbox hit suffices for boxes
  const pts = el.points;
  const r =
    radius + (el.kind === 'stroke' ? el.baseWidth * (el.tool === 'marker' ? 1.4 : 0.7) : 0);
  if (el.kind === 'fill' && pointInPolygon(x, y, pts)) return true;
  const r2 = r * r;
  for (let i = 0; i < pts.length - 1; i++) {
    if (distSqToSegment(x, y, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y) <= r2) return true;
  }
  if (pts.length === 1) {
    const dx = x - pts[0].x, dy = y - pts[0].y;
    return dx * dx + dy * dy <= r2;
  }
  return false;
}

function distSqToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  const ex = px - cx, ey = py - cy;
  return ex * ex + ey * ey;
}

/** Non-zero winding test: a point covered by a fold of the polygon still counts as inside
 * (the even-odd rule would punch holes where a stroke outline overlaps itself). */
export function pointInPolygonNZ(x: number, y: number, poly: { x: number; y: number }[]): boolean {
  let wn = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (yj <= y) {
      if (yi > y && (xi - xj) * (y - yj) - (x - xj) * (yi - yj) > 0) wn++;
    } else if (yi <= y && (xi - xj) * (y - yj) - (x - xj) * (yi - yj) < 0) wn--;
  }
  return wn !== 0;
}

export function pointInPolygon(x: number, y: number, poly: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Lasso select: whole elements with any point inside the lasso polygon (SPEC). */
export function elementsInLasso(elements: Element[], lasso: { x: number; y: number }[]): Element[] {
  if (lasso.length < 3) return [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of lasso) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  return elements.filter((el) => {
    const b = elementBBox(el);
    if (!bboxIntersects(b, { x: minX, y: minY, w: maxX - minX, h: maxY - minY })) return false;
    const pts =
      el.kind === 'text' || el.kind === 'image'
        ? [
            { x: el.x, y: el.y }, { x: el.x + el.w, y: el.y },
            { x: el.x, y: el.y + el.h }, { x: el.x + el.w, y: el.y + el.h },
            { x: el.x + el.w / 2, y: el.y + el.h / 2 },
          ]
        : el.points;
    return pts.some((p) => pointInPolygon(p.x, p.y, lasso));
  });
}
