// Stroke outlines: raw samples → filled polygons. Pressure/tilt outlines for
// the pens, the broad-nib marker, pencil passes, dots for taps, and the
// incremental live outliner. All in world coordinates.

import { getStroke } from 'perfect-freehand';
import type { Stroke, StrokePoint } from './types';
import { baseZoom } from './camera';
import { pressure, easeP } from './pressure';

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

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
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
        r: p1.r !== undefined && p2.r !== undefined ? lerpAngle(p1.r, p2.r, t) : p1.r ?? p2.r,
      });
    }
    out.push(p2);
  }
  return out;
}

/** Incremental live outline. The stroke is outlined in overlapping chunks of
 * samples; chunks well behind the tip — past the denoiser's settled point, so
 * they can't change any more — are frozen as Path2Ds and only the tail is
 * outlined again each frame. Everything goes into one Path2D filled with the
 * non-zero rule, so the overlaps never double-cover (a translucent marker stays
 * flat). Cost per frame is constant however long the stroke gets. */
export class LiveOutliner {
  private id = '';
  private detail = 0;
  private frozen: Path2D[] = [];
  private start = 0; // first sample of the live tail
  private static readonly CHUNK = 24;
  private static readonly OVERLAP = 6;
  path(stroke: Stroke, settled: number, detail: number, outline: (pts: StrokePoint[]) => Path2D): Path2D {
    if (stroke.id !== this.id || detail !== this.detail) {
      this.id = stroke.id; this.detail = detail; this.frozen = []; this.start = 0;
    }
    const pts = stroke.points, n = pts.length;
    const { CHUNK, OVERLAP } = LiveOutliner;
    if (this.start > n) { this.frozen = []; this.start = 0; } // stroke shrank (shouldn't happen): start over
    while (n - this.start > 2 * CHUNK && this.start + CHUNK + OVERLAP <= settled) {
      this.frozen.push(outline(pts.slice(this.start, this.start + CHUNK + OVERLAP)));
      this.start += CHUNK;
    }
    const out = new Path2D();
    for (const f of this.frozen) out.addPath(f);
    out.addPath(outline(pts.slice(this.start))); // the tail overlaps the last frozen chunk by OVERLAP samples
    return out;
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
    // blend toward the averaged direction as we approach the end — a hard
    // switch would register as a sharp turn and spawn a corner fan there
    let d = 0;
    for (let i = from; i !== j - dir; i -= dir) {
      if (i !== from) d += Math.hypot(pts[i].x - pts[i + dir].x, pts[i].y - pts[i + dir].y);
      const w = Math.max(0, 1 - d / dist);
      let bx = tx[i] + (dx - tx[i]) * w, by = ty[i] + (dy - ty[i]) * w;
      const bl = Math.hypot(bx, by) || 1;
      tx[i] = bx / bl; ty[i] = by / bl;
    }
  };
  if (n > 2) { steady(n - 1, 1); steady(0, -1); }
  // offset both sides. At a hard turn the OUTER side gets a fan of arc points
  // so the edge stays round; the INNER side folds back on itself — those
  // backward-travelling points are dropped (cusp removal) so the polygon never
  // reverses direction, which would punch winding holes (white gaps) in the fill.
  type Pt = { x: number; y: number; tx: number; ty: number; fan?: boolean };
  const leftRaw: Pt[] = [], rightRaw: Pt[] = [];
  const TURN = 0.45; // rad; sharper than this gets a fan on the outer side
  const fanInto = (side: Pt[], cx: number, cy: number, rr: number, a0: number, a1: number, txx: number, tyy: number) => {
    const tmp: number[][] = [];
    arc(tmp, cx, cy, rr, a0, a1, detail);
    for (const [x, y] of tmp) side.push({ x, y, tx: txx, ty: tyy, fan: true });
  };
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
        // the new tangent leans toward the old left normal → the path turned left → left is inner
        const turnedLeft = tx[i] * px + ty[i] * py > 0;
        if (turnedLeft) fanInto(rightRaw, pts[i].x, pts[i].y, rr, a0 + Math.PI, a1 + Math.PI, tx[i], ty[i]);
        else fanInto(leftRaw, pts[i].x, pts[i].y, rr, a0, a1, tx[i], ty[i]);
      }
    }
    leftRaw.push({ x: pts[i].x + nx * r, y: pts[i].y + ny * r, tx: tx[i], ty: ty[i] });
    rightRaw.push({ x: pts[i].x - nx * r, y: pts[i].y - ny * r, tx: tx[i], ty: ty[i] });
  }
  const clean = (side: Pt[]): number[][] => {
    const out: number[][] = [[side[0].x, side[0].y]];
    let last = side[0];
    for (let k = 1; k < side.length; k++) {
      const p = side[k];
      if (!p.fan && k < side.length - 1) {
        // inside a cusp: the step from the last kept point doesn't advance along
        // this point's own direction (needs > ~70° alignment). Judged only
        // against the point's own tangent so the chain recovers right after a
        // hairpin instead of skipping to the end of the stroke.
        const dx = p.x - last.x, dy = p.y - last.y;
        if (dx * p.tx + dy * p.ty < 0.3 * Math.hypot(dx, dy)) continue;
      }
      out.push([p.x, p.y]);
      last = p;
    }
    return out;
  };
  const left = clean(leftRaw), right = clean(rightRaw);
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

/** Broad-nib marker. The nib is a flat edge swept along the path; its
 * direction per sample follows the pen's lean (azimuth, when the device
 * reports it) or, failing that, stays perpendicular to the travel direction.
 * Width therefore follows how you move against the nib, and direction
 * changes give hard cuts (mitre wedges), never round fans. Fill = union of
 * consistently-oriented quads; hull = selection outline. */
export function markerPaths(points: StrokePoint[], baseWidth: number, detail: number): { fill: Path2D; hull: Path2D } {
  const w = widthAt('marker', baseWidth, 0.5);
  const half = w / 2;
  const k = pressure.marker;
  const offset = (k.nib * Math.PI) / 180;
  const th = Math.max(w * 0.08, 0.3 / detail) / 2; // nib thickness: along-nib moves still mark
  const raw = points.length > 2 ? densify(points, 2.2 / detail) : points;
  const pts: StrokePoint[] = [raw[0]];
  for (let i = 1; i < raw.length; i++) {
    const a = pts[pts.length - 1], b = raw[i];
    if ((b.x - a.x) ** 2 + (b.y - a.y) ** 2 > 1e-6) pts.push(b);
  }
  const n = pts.length;
  const tx = new Float64Array(n), ty = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1;
    tx[i] = dx / l; ty[i] = dy / l;
  }
  if (n === 1) { tx[0] = 1; ty[0] = 0; }
  const useAz = k.nibMode === 'azimuth' && pts.some((p) => p.r !== undefined);
  const nxs = new Float64Array(n), nys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const ang = useAz && pts[i].r !== undefined
      ? pts[i].r! + offset // chisel edge lies along the lean direction
      : Math.atan2(ty[i], tx[i]) + Math.PI / 2 + offset; // across the travel direction
    nxs[i] = Math.cos(ang) * half; nys[i] = Math.sin(ang) * half;
  }
  const fill = new Path2D();
  const poly = (q: number[][]) => {
    // orient every polygon the same way so overlaps add up instead of cancelling
    let area = 0;
    for (let i = 0; i < q.length; i++) { const a = q[i], b = q[(i + 1) % q.length]; area += a[0] * b[1] - b[0] * a[1]; }
    const o = area >= 0 ? q : [...q].reverse();
    fill.moveTo(o[0][0], o[0][1]);
    for (let i = 1; i < o.length; i++) fill.lineTo(o[i][0], o[i][1]);
    fill.closePath();
  };
  const foot = (i: number) => {
    // the nib itself: a thin rotated bar (dots, hairlines, flat ends)
    const p = pts[i], nx = nxs[i], ny = nys[i];
    const px = (-ny / half) * th, py = (nx / half) * th;
    poly([[p.x + nx + px, p.y + ny + py], [p.x - nx + px, p.y - ny + py], [p.x - nx - px, p.y - ny - py], [p.x + nx - px, p.y + ny - py]]);
  };
  foot(0);
  for (let i = 1; i < n; i++) {
    const a = pts[i - 1], b = pts[i];
    poly([[a.x + nxs[i - 1], a.y + nys[i - 1]], [b.x + nxs[i], b.y + nys[i]], [b.x - nxs[i], b.y - nys[i]], [a.x - nxs[i - 1], a.y - nys[i - 1]]]);
    // hard mitre wedges where the nib direction jumps between samples
    if (i < n - 1) {
      const dot = nxs[i - 1] * nxs[i] + nys[i - 1] * nys[i];
      if (dot < half * half * 0.985) {
        poly([[b.x, b.y], [b.x + nxs[i - 1], b.y + nys[i - 1]], [b.x + nxs[i], b.y + nys[i]]]);
        poly([[b.x, b.y], [b.x - nxs[i - 1], b.y - nys[i - 1]], [b.x - nxs[i], b.y - nys[i]]]);
      }
    }
  }
  foot(n - 1);
  const hull = new Path2D();
  hull.moveTo(pts[0].x + nxs[0], pts[0].y + nys[0]);
  for (let i = 1; i < n; i++) hull.lineTo(pts[i].x + nxs[i], pts[i].y + nys[i]);
  for (let i = n - 1; i >= 0; i--) hull.lineTo(pts[i].x - nxs[i], pts[i].y - nys[i]);
  hull.closePath();
  return { fill, hull };
}

export function outlineToPath(outline: number[][]): Path2D {
  const path = new Path2D();
  if (outline.length < 2) return path;
  path.moveTo(outline[0][0], outline[0][1]);
  for (let i = 1; i < outline.length; i++) path.lineTo(outline[i][0], outline[i][1]);
  path.closePath();
  return path;
}
