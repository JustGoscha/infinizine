// Stroke geometry: perfect-freehand outlines, pressure artifact filtering,
// hit-testing for eraser and lasso. All in world coordinates.

import { getStroke } from 'perfect-freehand';
import type { Stroke, StrokePoint, Element } from './types';

/** Filter Apple-Pencil-style pressure spikes: clamp per-sample delta. */
export function filterPressure(points: StrokePoint[]): StrokePoint[] {
  if (points.length < 3) return points;
  const out = points.map((p) => ({ ...p }));
  const MAX_DELTA = 0.08; // max pressure change between consecutive samples
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1].p;
    const d = out[i].p - prev;
    if (Math.abs(d) > MAX_DELTA) out[i].p = prev + Math.sign(d) * MAX_DELTA;
  }
  // Kill lone extreme first/last samples (classic Pencil artifact)
  if (out.length > 4) {
    out[0].p = out[1].p;
    out[out.length - 1].p = out[out.length - 2].p;
  }
  return out;
}

// Catmull-Rom in-betweening (ported from Doodely): inserts interpolated
// points on sparse segments so fast strokes don't render angular.
function cr(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

export function densify(points: StrokePoint[], spacing = 2.2): StrokePoint[] {
  if (points.length < 3) return points;
  const SPACING = spacing; // world units between in-betweens
  const out: StrokePoint[] = [points[0]];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const n = Math.min(64, Math.floor(dist / SPACING));
    for (let j = 1; j <= n; j++) {
      const t = j / (n + 1);
      out.push({
        x: cr(p0.x, p1.x, p2.x, p3.x, t),
        y: cr(p0.y, p1.y, p2.y, p3.y, t),
        p: p1.p + (p2.p - p1.p) * t,
        t: p1.t + (p2.t - p1.t) * t,
      });
    }
    out.push(p2);
  }
  return out;
}

// Raised-cosine pressure response (from Doodely): gentle at the light and
// heavy ends, most responsive mid-range — hides pressure noise where the
// Pencil is noisiest and stops the "spaghetti" width swings.
const easeP = (t: number) => 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, t)));

/** Spatial Gaussian denoise along the polyline. `sigma` is in world units —
 * pass ~1.2 screen px worth (1.2 / zoom at drawing time) so quantisation
 * jitter from the digitiser is removed identically at every zoom level:
 * zoomed out, the screen-pixel steps are huge in world space and get
 * averaged away; zoomed in, sigma is tiny and the line is left untouched. */
export function denoise(points: StrokePoint[], sigma: number): StrokePoint[] {
  const n = points.length;
  if (n < 3 || sigma <= 0) return points;
  const arc = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    arc[i] = arc[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  const reach = sigma * 3;
  const inv = 1 / (2 * sigma * sigma);
  const out: StrokePoint[] = new Array(n);
  out[0] = points[0];
  out[n - 1] = points[n - 1];
  let lo = 0;
  for (let i = 1; i < n - 1; i++) {
    while (arc[i] - arc[lo] > reach) lo++;
    let sx = 0, sy = 0, sw = 0;
    for (let j = lo; j < n && arc[j] - arc[i] <= reach; j++) {
      const d = arc[j] - arc[i];
      const w = Math.exp(-d * d * inv);
      sx += points[j].x * w; sy += points[j].y * w; sw += w;
    }
    out[i] = { ...points[i], x: sx / sw, y: sy / sw };
  }
  return out;
}

const TOOL_OPTIONS = {
  pencil: (w: number) => ({
    size: w,
    thinning: 0.45,
    smoothing: 0.35,
    streamline: 0.4,
    easing: easeP,
    simulatePressure: false,
    start: { taper: w * 1.2, cap: true },
    end: { taper: w * 2.0, cap: true },
  }),
  sketch: (w: number) => ({
    size: w,
    thinning: 0.4,
    smoothing: 0.35,
    streamline: 0.4,
    easing: easeP,
    simulatePressure: false,
    start: { taper: w * 1.2, cap: true },
    end: { taper: w * 2.0, cap: true },
  }),
  pen: (w: number) => ({
    size: w,
    thinning: 0.38, // Notes-like: visible swell, no spaghetti
    smoothing: 0.35,
    streamline: 0.45,
    easing: easeP,
    simulatePressure: false,
    start: { taper: w * 1.2, cap: true },
    end: { taper: w * 1.8, cap: true },
  }),
  fineliner: (w: number) => ({
    size: w,
    thinning: 0.1, // near-constant width
    smoothing: 0.35,
    streamline: 0.45,
    easing: easeP,
    simulatePressure: false,
    start: { cap: true },
    end: { cap: true },
  }),
  marker: (w: number) => ({
    size: w * 2.4,
    thinning: 0.06,
    smoothing: 0.35,
    streamline: 0.45,
    simulatePressure: false,
    start: { cap: false, taper: 0 },
    end: { cap: false, taper: 0 },
  }),
};

/** Pencil rendering (Here-Dragons-Abound style, adapted to vectors): several
 * displaced copies of the stroke, drawn at low opacity with multiply blending.
 * Low-frequency wobble = wandering graphite line; high-frequency = rough edges. */
export function pencilOutlines(stroke: Stroke, detail = 1): number[][][] {
  let seed = 0;
  for (let i = 0; i < stroke.id.length; i++) seed = (seed * 31 + stroke.id.charCodeAt(i)) % 9973;
  const base = densify(filterPressure(stroke.points), 2.2 / detail);
  const noPressure = stroke.points.every((p) => Math.abs(p.p - 0.5) < 0.001);
  const widths = [0.95, 0.78, 0.62];
  const passes: number[][][] = [];
  for (let k = 0; k < 3; k++) {
    const s1 = seed * 0.13 + k * 7.3;
    const s2 = seed * 0.31 + k * 3.1;
    const s3 = seed * 0.7 + k * 11.7;
    const amp = stroke.baseWidth * 0.36;
    const pts = base.map((p, i) => [
      p.x + (Math.sin(i * 0.31 + s1) * 0.6 + Math.sin(i * 1.37 + s2) * 0.3) * amp,
      p.y + (Math.sin(i * 0.27 + s2) * 0.6 + Math.sin(i * 1.51 + s3) * 0.3) * amp,
      p.p,
    ]);
    const opts = { ...TOOL_OPTIONS.sketch(stroke.baseWidth * widths[k]) };
    opts.smoothing /= detail;
    if (noPressure) opts.simulatePressure = true;
    passes.push(getStroke(pts, opts));
  }
  return passes;
}

/** Variable-width outline polygon for a stroke (world coords).
 * `detail` = zoom relative to 100% (bucketed by the renderer): in-between
 * spacing and outline vertex density scale with it so a stroke has the same
 * screen-space smoothness whether you're at 25% or 800%. */
export function strokeOutline(stroke: Stroke, detail = 1): number[][] {
  const pts = densify(filterPressure(stroke.points), 2.2 / detail).map((p) => [p.x, p.y, p.p]);
  const opts = { ...TOOL_OPTIONS[stroke.tool](stroke.baseWidth) };
  // perfect-freehand's `smoothing` is really a vertex-skip distance (size × smoothing);
  // shrink it with zoom so round tips stay round instead of turning polygonal
  opts.smoothing /= detail;
  // pencil emulation for pressureless input (mouse/finger): synthesize
  // pressure from stroke velocity so lines still swell and taper
  if (
    (stroke.tool === 'pen' || stroke.tool === 'pencil' || stroke.tool === 'sketch') &&
    stroke.points.every((p) => Math.abs(p.p - 0.5) < 0.001)
  ) {
    opts.simulatePressure = true;
  }
  return getStroke(pts, opts);
}

export function outlineToPath(outline: number[][]): Path2D {
  const path = new Path2D();
  if (outline.length < 2) return path;
  path.moveTo(outline[0][0], outline[0][1]);
  for (let i = 1; i < outline.length; i++) path.lineTo(outline[i][0], outline[i][1]);
  path.closePath();
  return path;
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
  const pad = el.kind === 'stroke' ? el.baseWidth * 2.5 : 2;
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
