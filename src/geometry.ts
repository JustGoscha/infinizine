// Stroke geometry: perfect-freehand outlines, pressure artifact filtering,
// hit-testing for eraser and lasso. All in world coordinates.

import { getStroke } from 'perfect-freehand';
import type { Stroke, StrokePoint, Element } from './types';
import { baseZoom } from './camera';

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
        a: p1.a !== undefined && p2.a !== undefined ? p1.a + (p2.a - p1.a) * t : p1.a ?? p2.a,
      });
    }
    out.push(p2);
  }
  return out;
}

/** Pressure response. Nobody presses an Apple Pencil anywhere near its
 * maximum, so the curve saturates early, with a soft start so feather-light
 * touches stay light:  10% → 14%, 25% → 42%, 50% → 79%, 75% → 97%. */
export type ToolKind = Stroke['tool'];
/** Piecewise cubic Bézier through anchors from (0,0) to (1,1). Handles are
 * relative to their anchor: `o` leaves toward the next anchor, `i` arrives
 * from the previous. `s` = smooth (handles mirrored) vs corner. */
export interface CurveNode { x: number; y: number; i: [number, number]; o: [number, number]; s: boolean }
export type Curve = CurveNode[];
/** Two-handle shorthand → anchors, as the editor used to store it. */
export function curveFromHandles(h: [number, number, number, number]): Curve {
  return [
    { x: 0, y: 0, i: [0, 0], o: [h[0], h[1]], s: false },
    { x: 1, y: 1, i: [h[2] - 1, h[3] - 1], o: [0, 0], s: false },
  ];
}
function normalizeCurve(c: unknown, fallback: Curve): Curve {
  if (Array.isArray(c) && c.length >= 2) {
    if (typeof c[0] === 'number') return curveFromHandles(c as [number, number, number, number]);
    if (typeof c[0] === 'object' && c[0] && 'x' in c[0]) {
      return (c as CurveNode[]).map((n) => ({ x: n.x, y: n.y, i: [...(n.i ?? [0, 0])] as [number, number], o: [...(n.o ?? [0, 0])] as [number, number], s: !!n.s }));
    }
  }
  return structuredClone(fallback);
}
/** y at x: locate the segment by anchor x, solve the segment's cubic for t by bisection. */
export function curveAt(c: Curve, x: number): number {
  x = Math.max(0, Math.min(1, x));
  let k = 0;
  while (k < c.length - 2 && x > c[k + 1].x) k++;
  const a = c[k], b = c[k + 1];
  const p0x = a.x, p0y = a.y, p1x = a.x + a.o[0], p1y = a.y + a.o[1];
  const p2x = b.x + b.i[0], p2y = b.y + b.i[1], p3x = b.x, p3y = b.y;
  if (p3x - p0x < 1e-9) return Math.max(0, Math.min(1, x <= p0x ? p0y : p3y));
  let lo = 0, hi = 1, t = 0.5;
  for (let it = 0; it < 24; it++) {
    t = (lo + hi) / 2;
    const u = 1 - t;
    const bx = u * u * u * p0x + 3 * u * u * t * p1x + 3 * u * t * t * p2x + t * t * t * p3x;
    if (bx < x) lo = t; else hi = t;
  }
  const u = 1 - t;
  const y = u * u * u * p0y + 3 * u * u * t * p1y + 3 * u * t * t * p2y + t * t * t * p3y;
  return Math.max(0, Math.min(1, y));
}

export interface ToolPressure {
  curve: Curve; // pressure → effect
  smooth: number; // position denoise radius in screen px (applied after drawing, live + commit)
  pSmooth: number; // pressure low-pass factor 0..1 (1 = raw)
  min: number; // width at zero pressure as a fraction of max
  max: number; // max width as × baseWidth
  tilt: number; // pencil: how much a flat Pencil widens a light stroke (1 = ignore tilt, 3 = up to 3×)
  tiltCurve: Curve; // tilt (0 upright … 1 flat) → tilt effect 0..1
}
export type PressureParams = Record<ToolKind, ToolPressure>;
const base = {
  curve: curveFromHandles([0.55, 0.9, 0.5, 0.95]),
  smooth: 2,
  pSmooth: 0.3,
  tilt: 1,
  // flat-ish angles count, near-upright barely: eases in, then ramps
  tiltCurve: curveFromHandles([0.6, 0.05, 0.7, 1]),
};
const fresh = () => structuredClone(base);
export const DEFAULT_PRESSURE: PressureParams = {
  pen: { ...fresh(), min: 0.22, max: 1.6 },
  fineliner: { ...fresh(), min: 0.86, max: 1.3 },
  pencil: { ...fresh(), min: 0.8, max: 1, tilt: 2.4 },
  sketch: { ...fresh(), min: 0.45, max: 1.4 },
  marker: { ...fresh(), min: 1, max: 2.4 },
};
const PRESSURE_KEY = 'infinizine-pressure-v3';
export const pressure: PressureParams = (() => {
  const out = structuredClone(DEFAULT_PRESSURE);
  try {
    const raw = localStorage.getItem(PRESSURE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<PressureParams>;
      for (const t of Object.keys(out) as ToolKind[]) {
        if (!p[t]) continue;
        Object.assign(out[t], p[t], {
          curve: normalizeCurve(p[t]!.curve, out[t].curve),
          tiltCurve: normalizeCurve(p[t]!.tiltCurve, out[t].tiltCurve),
        });
      }
    }
  } catch { /* ignore */ }
  return out;
})();
export function savePressure() {
  try { localStorage.setItem(PRESSURE_KEY, JSON.stringify(pressure)); } catch { /* ignore */ }
}
/** Back to defaults in memory only — the playground's Save persists it. */
export function resetPressure(tool?: ToolKind) {
  const tools = tool ? [tool] : (Object.keys(pressure) as ToolKind[]);
  for (const t of tools) Object.assign(pressure[t], structuredClone(DEFAULT_PRESSURE[t]));
}
/** Replace the in-memory params wholesale (used to revert unsaved edits). */
export function loadPressure(from: PressureParams) {
  for (const t of Object.keys(pressure) as ToolKind[]) Object.assign(pressure[t], from[t]);
}

/** y of the cubic Bézier (0,0)-(x1,y1)-(x2,y2)-(1,1) at a given x. Handles are
 * kept inside x∈[0,1] so x(t) is monotone; solved by bisection. */
export function bezierAt(c: [number, number, number, number], x: number): number {
  const [x1, y1, x2, y2] = c;
  x = Math.max(0, Math.min(1, x));
  let lo = 0, hi = 1, t = x;
  for (let i = 0; i < 24; i++) {
    t = (lo + hi) / 2;
    const u = 1 - t;
    const bx = 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t;
    if (bx < x) lo = t; else hi = t;
  }
  const u = 1 - t;
  return Math.max(0, Math.min(1, 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t));
}

export const easeP = (t: number, tool: ToolKind = 'pen') => curveAt(pressure[tool].curve, t);
/** tilt 0..1 → effect 0..1 through the tool's tilt curve */
export const easeTilt = (a: number, tool: ToolKind = 'pencil') => curveAt(pressure[tool].tiltCurve, a);

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

/** Incremental denoise for the stroke being drawn: points further than the
 * Gaussian reach behind the tip can never change again, so they're kept;
 * each frame only the tail is recomputed. Same result as denoise() on commit. */
export class LiveDenoiser {
  private id = '';
  private final: StrokePoint[] = [];
  private arc: number[] = [];
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

const TOOL_OPTIONS = {
  pencil: (w: number) => ({
    size: w,
    thinning: 0.45,
    smoothing: 0.35,
    streamline: 0.3,
    easing: easeP,
    simulatePressure: false,
    start: { taper: w * 1.2, cap: true },
    end: { taper: w * 2.0, cap: true },
  }),
  sketch: (w: number) => ({
    size: w,
    thinning: 0.4,
    smoothing: 0.35,
    streamline: 0.3,
    easing: easeP,
    simulatePressure: false,
    start: { taper: w * 1.2, cap: true },
    end: { taper: w * 2.0, cap: true },
  }),
  pen: (w: number) => ({
    size: w,
    thinning: 0.6, // pressure does the tapering (see strokeOutline); fast curve keeps mid-range calm
    smoothing: 0.35,
    streamline: 0.3,
    easing: easeP,
    simulatePressure: false,
    start: { taper: w * 1.2, cap: true },
    end: { taper: w * 1.8, cap: true },
  }),
  fineliner: (w: number) => ({
    size: w,
    thinning: 0.1, // near-constant width
    smoothing: 0.35,
    streamline: 0.3,
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
/** Has a real pressure signal (pen), as opposed to the flat 0.5 of mouse/finger. */
export function hasPressure(points: StrokePoint[]): boolean {
  return points.some((p) => Math.abs(p.p - 0.5) >= 0.001);
}

/** Stroke diameter (world units) at pressure p for a tool — our own mapping,
 * pressure already through easeP. Max is a fixed multiple of baseWidth so the
 * size presets mean what they say. */
export function widthAt(tool: Stroke['tool'], baseWidth: number, p: number): number {
  const w = pressure[tool];
  if (tool === 'marker') return baseWidth * w.max;
  return baseWidth * w.max * (w.min + (1 - w.min) * easeP(p, tool));
}

function arc(out: number[][], cx: number, cy: number, r: number, a0: number, a1: number, detail: number) {
  // sweep from a0 to a1 (signed), vertex count from on-screen radius
  const n = Math.max(4, Math.min(40, Math.ceil(Math.abs(a1 - a0) * Math.sqrt(r * detail * baseZoom()) * 1.4)));
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
}

/** Our own variable-width outliner (replaces perfect-freehand for pressure
 * input). Denoised, in-betweened centreline → per-sample radius from pressure
 * → offset both sides along smoothed normals; corner fans where the path
 * turns hard; round caps. No minimum length, no dropped points: a 2px
 * scribble at 800% renders exactly like a 2cm one at 100%. */
export function pressureOutline(
  points: StrokePoint[],
  tool: Stroke['tool'],
  baseWidth: number,
  detail: number,
  widthScale = 1,
): number[][] {
  // in-between so normals are stable; drop exact duplicates
  const dense = densify(filterPressure(points), 2.2 / detail);
  const pts: StrokePoint[] = [dense[0]];
  for (let i = 1; i < dense.length; i++) {
    const a = pts[pts.length - 1], b = dense[i];
    if ((b.x - a.x) ** 2 + (b.y - a.y) ** 2 > 1e-6) pts.push(b);
  }
  const n = pts.length;
  if (n < 2) {
    const c = pts[0];
    const r = (widthAt(tool, baseWidth, c.p) * widthScale) / 2;
    const out: number[][] = [];
    arc(out, c.x, c.y, r, 0, Math.PI * 2, detail);
    return out;
  }
  // tangents (central differences), radii
  const tx = new Float64Array(n), ty = new Float64Array(n), rad = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let dx = b.x - a.x, dy = b.y - a.y;
    const l = Math.hypot(dx, dy) || 1;
    tx[i] = dx / l; ty[i] = dy / l;
    rad[i] = Math.max(0.02, (widthAt(tool, baseWidth, pts[i].p) * widthScale) / 2);
  }
  // steady the ends: the last 1–2 samples (pen lifting/landing) wander, which
  // would swing the cap — especially a chisel end. Average the direction over
  // the last ~one radius of travel and use it for every sample in that window.
  const steady = (from: number, dir: 1 | -1) => {
    const r = Math.max(rad[from] * 1.2, 0.5 / detail);
    let j = from, dist = 0;
    while (j - dir >= 0 && j - dir < n && dist < r) {
      dist += Math.hypot(pts[j].x - pts[j - dir].x, pts[j].y - pts[j - dir].y);
      j -= dir;
    }
    if (j === from) return;
    let dx = (pts[from].x - pts[j].x) * dir, dy = (pts[from].y - pts[j].y) * dir;
    const l = Math.hypot(dx, dy);
    if (l < 1e-6) return;
    dx /= l; dy /= l;
    for (let i = j; i !== from + dir; i += dir) { tx[i] = dx; ty[i] = dy; }
  };
  if (n > 2) { steady(n - 1, 1); steady(0, -1); }
  const left: number[][] = [], right: number[][] = [];
  const TURN = 0.45; // rad; sharper than this gets a fan so the outer edge stays round
  for (let i = 0; i < n; i++) {
    const nx = -ty[i], ny = tx[i], r = rad[i];
    if (i > 0) {
      const px = -ty[i - 1], py = tx[i - 1];
      const cross = px * ny - py * nx;
      const dot = Math.max(-1, Math.min(1, px * nx + py * ny));
      const turn = Math.atan2(cross, dot);
      if (Math.abs(turn) > TURN) {
        const a0 = Math.atan2(py, px), a1 = a0 + turn;
        const rr = (rad[i - 1] + r) / 2;
        const fanL: number[][] = [], fanR: number[][] = [];
        arc(fanL, pts[i].x, pts[i].y, rr, a0, a1, detail);
        arc(fanR, pts[i].x, pts[i].y, rr, a0 + Math.PI, a1 + Math.PI, detail);
        left.push(...fanL);
        right.push(...fanR);
      }
    }
    left.push([pts[i].x + nx * r, pts[i].y + ny * r]);
    right.push([pts[i].x - nx * r, pts[i].y - ny * r]);
  }
  // assemble: left forward, end cap, right backward, start cap
  // (marker = chisel tip: flat ends, the sides simply close)
  const flat = tool === 'marker';
  const out: number[][] = [...left];
  const e = n - 1;
  if (!flat) {
    const aEnd = Math.atan2(tx[e], -ty[e]); // angle of the left normal at the end
    arc(out, pts[e].x, pts[e].y, rad[e], aEnd, aEnd - Math.PI, detail);
  }
  for (let i = right.length - 1; i >= 0; i--) out.push(right[i]);
  if (!flat) {
    const aStart = Math.atan2(tx[0], -ty[0]);
    arc(out, pts[0].x, pts[0].y, rad[0], aStart + Math.PI, aStart, detail);
  }
  return out;
}

export function pencilOutlines(stroke: Stroke, detail = 1): number[][][] {
  let seed = 0;
  for (let i = 0; i < stroke.id.length; i++) seed = (seed * 31 + stroke.id.charCodeAt(i)) % 9973;
  const widths = [0.95, 0.78, 0.62];
  if (stroke.points.length === 1) {
    const j = stroke.baseWidth * 0.18;
    return widths.map((wk, k) =>
      dotOutline(stroke, detail, wk, Math.sin(seed + k * 2.1) * j, Math.cos(seed * 0.7 + k * 1.3) * j));
  }
  const pressured = hasPressure(stroke.points);
  const base = pressured
    ? filterPressure(stroke.points) // pressureOutline in-betweens itself
    : densify(filterPressure(stroke.points), 2.2 / detail);
  const passes: number[][][] = [];
  for (let k = 0; k < 3; k++) {
    const s1 = seed * 0.13 + k * 7.3;
    const s2 = seed * 0.31 + k * 3.1;
    const s3 = seed * 0.7 + k * 11.7;
    const amp = stroke.baseWidth * 0.36;
    const wob = base.map((p, i) => ({
      ...p,
      x: p.x + (Math.sin(i * 0.31 + s1) * 0.6 + Math.sin(i * 1.37 + s2) * 0.3) * amp,
      y: p.y + (Math.sin(i * 0.27 + s2) * 0.6 + Math.sin(i * 1.51 + s3) * 0.3) * amp,
    }));
    if (pressured) {
      passes.push(pressureOutline(wob, 'sketch', stroke.baseWidth, detail, widths[k]));
    } else {
      const opts = { ...TOOL_OPTIONS.sketch(stroke.baseWidth * widths[k]) };
      opts.smoothing /= detail;
      opts.simulatePressure = true;
      passes.push(getStroke(wob.map((p) => [p.x, p.y, p.p]), opts));
    }
  }
  return passes;
}

/** A tap: one point → a perfect circle at the width that pressure gives. */
export function dotRadius(stroke: Stroke): number {
  const p = stroke.points[0]?.p ?? 0.5;
  if (hasPressure(stroke.points) || stroke.tool === 'marker' || stroke.tool === 'fineliner') {
    return Math.max(0.05, widthAt(stroke.tool, stroke.baseWidth, p) / 2);
  }
  const o = TOOL_OPTIONS[stroke.tool](stroke.baseWidth) as { size: number; thinning: number; easing?: (t: number) => number };
  const ease = o.easing ?? ((t: number) => t);
  return Math.max(0.05, o.size * ease(0.5 - o.thinning * (0.5 - p)));
}

function dotOutline(stroke: Stroke, detail: number, radiusScale = 1, dx = 0, dy = 0): number[][] {
  const c = stroke.points[0];
  const r = dotRadius(stroke) * radiusScale;
  const out: number[][] = [];
  if (stroke.tool === 'marker') {
    // chisel tip touched down: a flat square dab
    return [[c.x - r, c.y - r * 0.6], [c.x + r, c.y - r * 0.6], [c.x + r, c.y + r * 0.6], [c.x - r, c.y + r * 0.6]];
  }
  arc(out, c.x + dx, c.y + dy, r, 0, Math.PI * 2, detail);
  return out;
}

/** Outline polygon for a stroke (world coords).
 * `detail` = zoom relative to 100% (bucketed by the renderer): in-between
 * spacing and outline vertex density scale with it so a stroke has the same
 * screen-space smoothness whether you're at 25% or 800%.
 * Pressure input → our pressureOutline. Pressureless mouse/finger strokes →
 * perfect-freehand with simulated pressure (velocity-based swell). */
export function strokeOutline(stroke: Stroke, detail = 1, live = false): number[][] {
  if (stroke.points.length === 1) return dotOutline(stroke, detail);
  if (hasPressure(stroke.points) || stroke.tool === 'marker' || stroke.tool === 'fineliner') {
    return pressureOutline(stroke.points, stroke.tool, stroke.baseWidth, detail);
  }
  const pts = densify(filterPressure(stroke.points), 2.2 / detail).map((p) => [p.x, p.y, p.p]);
  const opts = { ...TOOL_OPTIONS[stroke.tool](stroke.baseWidth) };
  opts.smoothing /= detail;
  const maxTaper = 7 / (detail * baseZoom());
  const o = opts as unknown as {
    start?: { cap?: boolean; taper?: number | boolean };
    end?: { cap?: boolean; taper?: number | boolean };
    last?: boolean;
  };
  if (typeof o.start?.taper === 'number') o.start = { ...o.start, taper: Math.min(o.start.taper, maxTaper) };
  if (typeof o.end?.taper === 'number') o.end = { ...o.end, taper: Math.min(o.end.taper, maxTaper) };
  o.last = true;
  if (live) o.end = { cap: true, taper: 0 };
  opts.simulatePressure = true;
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
