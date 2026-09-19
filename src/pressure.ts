// Pressure response: per-tool curves (pressure → width, tilt → widening),
// smoothing amounts, persisted brush settings. The playground edits these.

import type { Stroke } from './types';

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
/** y at x. Handles may overshoot past neighbouring anchors (x(t) non-monotone,
 * the curve loops back), so instead of solving for t we rasterise the whole
 * path into a 256-entry lookup by x — later parts of the path win where it
 * folds — and interpolate. Cached per curve object until its shape changes. */
const lutCache = new WeakMap<Curve, { sig: string; lut: Float32Array }>();
export function curveAt(c: Curve, x: number): number {
  const sig = JSON.stringify(c);
  let e = lutCache.get(c);
  if (!e || e.sig !== sig) {
    const N = 256;
    const lut = new Float32Array(N).fill(NaN);
    for (let k = 0; k < c.length - 1; k++) {
      const a = c[k], b = c[k + 1];
      const p0x = a.x, p0y = a.y, p1x = a.x + a.o[0], p1y = a.y + a.o[1];
      const p2x = b.x + b.i[0], p2y = b.y + b.i[1], p3x = b.x, p3y = b.y;
      for (let i = 0; i <= 1024; i++) {
        const t = i / 1024, u = 1 - t;
        const bx = u * u * u * p0x + 3 * u * u * t * p1x + 3 * u * t * t * p2x + t * t * t * p3x;
        const by = u * u * u * p0y + 3 * u * u * t * p1y + 3 * u * t * t * p2y + t * t * t * p3y;
        if (bx < 0 || bx > 1) continue;
        lut[Math.round(bx * (N - 1))] = Math.max(0, Math.min(1, by));
      }
    }
    // fill gaps by linear interpolation between known entries
    let prev = -1;
    for (let i = 0; i < N; i++) {
      if (Number.isNaN(lut[i])) continue;
      if (prev < 0) { for (let j = 0; j < i; j++) lut[j] = lut[i]; }
      else for (let j = prev + 1; j < i; j++) lut[j] = lut[prev] + ((lut[i] - lut[prev]) * (j - prev)) / (i - prev);
      prev = i;
    }
    if (prev < 0) lut.fill(0);
    else for (let j = prev + 1; j < N; j++) lut[j] = lut[prev];
    e = { sig, lut };
    lutCache.set(c, e);
  }
  const f = Math.max(0, Math.min(1, x)) * 255;
  const i = Math.floor(f), frac = f - i;
  return i >= 255 ? e.lut[255] : e.lut[i] + (e.lut[i + 1] - e.lut[i]) * frac;
}

export interface ToolPressure {
  curve: Curve; // pressure → effect
  smooth: number; // position denoise radius in screen px (applied after drawing, live + commit)
  pSmooth: number; // pressure low-pass factor 0..1 (1 = raw)
  min: number; // width at zero pressure as a fraction of max
  max: number; // max width as × baseWidth
  tilt: number; // pencil: how much a flat Pencil widens a light stroke (1 = ignore tilt, 3 = up to 3×)
  tiltCurve: Curve; // tilt (0 upright … 1 flat) → tilt effect 0..1
  nib: number; // marker: nib angle offset in degrees (azimuth mode: relative to the pen's lean; travel mode: relative to the stroke normal)
  nibMode: 'travel' | 'azimuth'; // marker: nib follows the stroke direction, or the pen's lean (falls back to travel without a pen)
}
export type PressureParams = Record<ToolKind, ToolPressure>;
// Tuned on an iPad with an Apple Pencil (exported from the playground) — these are the defaults.
export const DEFAULT_PRESSURE: PressureParams = {
  pen: {
    curve: [
      { x: 0, y: 0.429, i: [0, 0], o: [0.187, 0.006], s: false },
      { x: 0.342, y: 0.931, i: [-0.095, -0.007], o: [0.367, 0.026], s: true },
      { x: 1, y: 0.578, i: [-0.297, -0.01], o: [0, 0], s: false },
    ],
    tiltCurve: [
      { x: 0, y: 0, i: [0, 0], o: [0.6, 0.05], s: false },
      { x: 1, y: 1, i: [-0.3, 0], o: [0, 0], s: false },
    ],
    smooth: 3.1,
    pSmooth: 1,
    tilt: 1,
    min: 0.22,
    max: 1.6,
    nib: 0,
    nibMode: 'azimuth',
  },
  fineliner: {
    curve: [
      { x: 0, y: 0, i: [0, 0], o: [0.007, 0.808], s: false },
      { x: 1, y: 1, i: [-0.79, -0], o: [0, 0], s: false },
    ],
    tiltCurve: [
      { x: 0, y: 0, i: [0, 0], o: [0.6, 0.05], s: false },
      { x: 1, y: 1, i: [-0.3, 0], o: [0, 0], s: false },
    ],
    smooth: 3.3,
    pSmooth: 0.3,
    tilt: 1,
    min: 0.83,
    max: 1.3,
    nib: 0,
    nibMode: 'azimuth',
  },
  pencil: {
    curve: [
      { x: 0, y: 0, i: [0, 0], o: [-0.008, 0.322], s: false },
      { x: 1, y: 1, i: [-0.727, -0], o: [0, 0], s: false },
    ],
    tiltCurve: [
      { x: 0, y: 0, i: [0, 0], o: [0.088, -0.009], s: false },
      { x: 0.515, y: 0.036, i: [-0.119, -0.052], o: [0.285, 0.003], s: false },
      { x: 1, y: 1, i: [-0.131, -0.004], o: [0, 0], s: false },
    ],
    smooth: 2.7,
    pSmooth: 0.3,
    tilt: 40,
    min: 0.56,
    max: 1,
    nib: 0,
    nibMode: 'azimuth',
  },
  sketch: {
    curve: [
      { x: 0, y: 0, i: [0, 0], o: [0.55, 0.9], s: false },
      { x: 1, y: 1, i: [-0.5, -0.05], o: [0, 0], s: false },
    ],
    tiltCurve: [
      { x: 0, y: 0, i: [0, 0], o: [0.6, 0.05], s: false },
      { x: 1, y: 1, i: [-0.3, 0], o: [0, 0], s: false },
    ],
    smooth: 2,
    pSmooth: 0.3,
    tilt: 1,
    min: 0.45,
    max: 1.4,
    nib: 0,
    nibMode: 'azimuth',
  },
  marker: {
    curve: [
      { x: 0, y: 0, i: [0, 0], o: [0.36, 0.938], s: false },
      { x: 1, y: 1, i: [-0.504, 0.026], o: [0, 0], s: false },
    ],
    tiltCurve: [
      { x: 0, y: 0, i: [0, 0], o: [0.6, 0.05], s: false },
      { x: 1, y: 1, i: [-0.3, 0], o: [0, 0], s: false },
    ],
    smooth: 3,
    pSmooth: 0.3,
    tilt: 1,
    min: 1,
    max: 2.4,
    nib: 0,
    nibMode: 'azimuth',
  },
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
        // a briefly-shipped default of 45° compensated a formula bug; the formula is fixed
        if (t === 'marker' && (p[t] as { nib?: number }).nib === 45) out[t].nib = 0;
      }
    }
  } catch { /* ignore */ }
  return out;
})();
export function savePressure() {
  try { localStorage.setItem(PRESSURE_KEY, JSON.stringify(pressure)); } catch { /* ignore */ }
}
/** Back to defaults in memory only — the playground's Save persists it. */
/** Import a brush-settings file (as written by exportPressure). In memory only. */
export function exportPressure(): string {
  return JSON.stringify({ app: 'infinizine-brushes', version: 1, tools: pressure }, null, 2);
}
export function importPressure(text: string): boolean {
  try {
    const p = JSON.parse(text) as { app?: string; tools?: Partial<PressureParams> };
    const tools = p.app === 'infinizine-brushes' ? p.tools : (p as unknown as Partial<PressureParams>);
    if (!tools || typeof tools !== 'object') return false;
    let any = false;
    for (const t of Object.keys(pressure) as ToolKind[]) {
      const src = tools[t];
      if (!src) continue;
      any = true;
      Object.assign(pressure[t], DEFAULT_PRESSURE[t], src, {
        curve: normalizeCurve(src.curve, DEFAULT_PRESSURE[t].curve),
        tiltCurve: normalizeCurve(src.tiltCurve, DEFAULT_PRESSURE[t].tiltCurve),
      });
    }
    return any;
  } catch {
    return false;
  }
}
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
