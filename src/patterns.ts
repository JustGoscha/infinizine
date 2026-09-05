// Fill patterns: manga screentones (dots, hatching) and digital dithers
// (Bayer, scanlines). A pattern is a "colour" like `pattern:tone-3`; only the
// fill tool paints it — strokes and text using a pattern swatch just get ink.

import { pointInPolygon } from './geometry';

export const PATTERN_INK = '#1a1a1a';
export const isPattern = (c: string) => c.startsWith('pattern:');
/** what a stroke/text gets when a pattern swatch is active */
export const inkOf = (c: string) => (isPattern(c) ? PATTERN_INK : c);

type Family =
  | 'tone' | 'hatch' | 'cross' | 'lines' | 'grid' | 'sand' | 'waves' | 'scales' // manga (vector tiles)
  | 'bayer' | 'cluster' | 'pixdots' | 'checker' | 'scan' | 'vscan' | 'stairs' | 'xhatch' | 'zigzag' | 'brick' | 'pixnoise'; // digital (pixel grid)
const FAMILIES: Family[] = [
  'tone', 'hatch', 'cross', 'lines', 'grid', 'sand', 'waves', 'scales',
  'bayer', 'cluster', 'pixdots', 'checker', 'scan', 'vscan', 'stairs', 'xhatch', 'zigzag', 'brick', 'pixnoise',
];
const PIXEL: Set<string> = new Set(['bayer', 'cluster', 'pixdots', 'checker', 'scan', 'vscan', 'stairs', 'xhatch', 'zigzag', 'brick', 'pixnoise']);
const parse = (id: string): { fam: Family; k: number } | null => {
  const m = /^pattern:([a-z]+)-([1-5])$/.exec(id);
  if (!m || !FAMILIES.includes(m[1] as Family)) return null;
  return { fam: m[1] as Family, k: Number(m[2]) };
};
/** the 5 densities of a pattern's family, lightest → heaviest (its "shades") */
export function patternVariants(id: string): string[] {
  const p = parse(id);
  return p ? [1, 2, 3, 4, 5].map((k) => `pattern:${p.fam}-${k}`) : [];
}
const NAMES: Record<Family, string> = {
  tone: 'Screentone', hatch: 'Hatching', cross: 'Cross-hatch', lines: 'Ruled lines', grid: 'Grid',
  sand: 'Sand tone', waves: 'Waves', scales: 'Scales',
  bayer: 'Ordered dither', cluster: 'Halftone dither', pixdots: 'Pixel dots', checker: 'Checker',
  scan: 'Scanlines', vscan: 'Vertical lines', stairs: 'Pixel diagonal', xhatch: 'Pixel crosshatch',
  zigzag: 'Zigzag', brick: 'Bricks', pixnoise: 'Pixel noise',
};
export function patternLabel(id: string): string {
  const p = parse(id);
  return p ? `${NAMES[p.fam]} ${p.k}` : id;
}

/** One pixel of every digital pattern, in world units (2 units = 1mm → 0.6mm cells).
 * Every pixel family shares this grid, anchored at the world origin, so dithers
 * drawn next to each other line up pixel for pixel. */
export const PIXEL_CELL = 1.2;
/** cells per repeat of the pixel tile (the LCM of every family's period) */
const PIXEL_TILE_CELLS = 24;

/** tile size in world units: tones repeat every 1.5mm; pixel families every 24 cells */
export function patternTileSize(id: string): number {
  const p = parse(id);
  if (!p) return 3;
  if (PIXEL.has(p.fam)) return PIXEL_CELL * PIXEL_TILE_CELLS;
  switch (p.fam) {
    case 'sand': return 14; // big tile so the stipple doesn't visibly repeat
    case 'waves': case 'scales': return 4;
    default: return 3;
  }
}

/** Pixel families: cell size in world units (fills snap their outline to this grid). */
export function patternCellSize(id: string): number | null {
  const p = parse(id);
  return p && PIXEL.has(p.fam) ? PIXEL_CELL : null;
}
export const isPixelPattern = (id: string) => patternCellSize(id) !== null;

const mod = (a: number, n: number) => ((a % n) + n) % n;
// deterministic hash of a cell → [0,1): the noise never repeats, at any coordinate
const hash2 = (i: number, j: number) => {
  let h = (i * 374761393 + j * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];
// clustered-dot ordered dither (4×4 spiral): dots grow from the centre like a halftone
const CLUSTER = [
  [12, 5, 6, 13],
  [4, 0, 1, 7],
  [11, 3, 2, 8],
  [15, 10, 9, 14],
];

/** Pixel families as a cell predicate: is cell (row i, column j) inked? */
function cellRule(id: string): ((i: number, j: number) => boolean) | null {
  const p = parse(id);
  if (!p || !PIXEL.has(p.fam)) return null;
  const { fam, k } = p;
  switch (fam) {
    case 'bayer': { const level = [2, 5, 8, 11, 14][k - 1]; return (i, j) => BAYER[mod(i, 4)][mod(j, 4)] < level; }
    case 'cluster': { const level = [2, 5, 8, 11, 14][k - 1]; return (i, j) => CLUSTER[mod(i, 4)][mod(j, 4)] < level; }
    case 'pixdots':
      // the classic 8-bit ramp: lone pixels every 4, 3, 2 → checker → everything but every other pixel
      return [
        (i: number, j: number) => mod(i, 4) === 0 && mod(j, 4) === 0,
        (i: number, j: number) => mod(i, 3) === 0 && mod(j, 3) === 0,
        (i: number, j: number) => mod(i, 2) === 0 && mod(j, 2) === 0,
        (i: number, j: number) => mod(i + j, 2) === 0,
        (i: number, j: number) => !(mod(i, 2) === 0 && mod(j, 2) === 0),
      ][k - 1];
    case 'checker': { const s = [1, 2, 3, 4, 6][k - 1]; return (i, j) => mod(Math.floor(i / s) + Math.floor(j / s), 2) === 0; }
    case 'scan': return [(i: number) => mod(i, 4) === 0, (i: number) => mod(i, 3) === 0, (i: number) => mod(i, 2) === 0, (i: number) => mod(i, 3) !== 0, (i: number) => mod(i, 4) !== 0][k - 1];
    case 'vscan': return [(_: number, j: number) => mod(j, 4) === 0, (_: number, j: number) => mod(j, 3) === 0, (_: number, j: number) => mod(j, 2) === 0, (_: number, j: number) => mod(j, 3) !== 0, (_: number, j: number) => mod(j, 4) !== 0][k - 1];
    case 'stairs': return [(i: number, j: number) => mod(i + j, 4) === 0, (i: number, j: number) => mod(i + j, 3) === 0, (i: number, j: number) => mod(i + j, 2) === 0, (i: number, j: number) => mod(i + j, 3) !== 0, (i: number, j: number) => mod(i + j, 4) !== 0][k - 1];
    case 'xhatch': {
      const P = [8, 6, 4, 3, 4][k - 1], thick = k === 5 ? 2 : 1;
      return (i, j) => mod(i + j, P) < thick || mod(i - j, P) < thick;
    }
    case 'zigzag': {
      // a pixel zigzag line (rise 3 over 3, fall 3 over 3) every S rows
      const S = [8, 6, 5, 4, 3][k - 1];
      return (i, j) => { const t = mod(j, 6); const h = t < 3 ? t : 6 - t; return mod(i - h, S) === 0; };
    }
    case 'brick': {
      // mortar lines of a staggered brick wall; level 5 is the wall itself with paper mortar
      const [W, H] = [[8, 4], [6, 3], [4, 2], [3, 2], [6, 3]][k - 1];
      const mortar = (i: number, j: number) => mod(i, H) === 0 || mod(j + (mod(Math.floor(i / H), 2) ? Math.floor(W / 2) : 0), W) === 0;
      return k === 5 ? (i, j) => !mortar(i, j) : mortar;
    }
    case 'pixnoise': { const pr = [0.1, 0.22, 0.38, 0.55, 0.72][k - 1]; return (i, j) => hash2(i, j) < pr; }
    default: return null;
  }
}

/** Pixel-pattern fill as solid geometry: every "on" cell whose centre is inside
 * the polygon, merged into horizontal runs. No repeating tile → no resampling
 * seams between pixels at any zoom; whole cells only at the edge.
 * `m` scales the grid (zoom-stepped tones: coarser pixels when zoomed far out). */
export function cellPath(points: { x: number; y: number }[], id: string, m = 1): Path2D | null {
  const rule = cellRule(id);
  const cell = (patternCellSize(id) ?? 0) * m;
  if (!rule || !cell || points.length < 3) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const q of points) { minX = Math.min(minX, q.x); minY = Math.min(minY, q.y); maxX = Math.max(maxX, q.x); maxY = Math.max(maxY, q.y); }
  const c0 = Math.floor(minX / cell), c1 = Math.ceil(maxX / cell);
  const r0 = Math.floor(minY / cell), r1 = Math.ceil(maxY / cell);
  if ((c1 - c0) * (r1 - r0) > 600_000) return null;
  const path = new Path2D();
  const eps = cell * 0.02; // hairline overlap between runs so rows never show antialias seams
  for (let r = r0; r < r1; r++) {
    const cy = (r + 0.5) * cell;
    let run: number | null = null; // start column of the current run (columns may be negative)
    for (let c = c0; c <= c1; c++) {
      const inside = c < c1 && rule(r, c) && pointInPolygon((c + 0.5) * cell, cy, points);
      if (inside && run === null) run = c;
      if (!inside && run !== null) {
        path.rect(run * cell - eps, r * cell - eps, (c - run) * cell + 2 * eps, cell + 2 * eps);
        run = null;
      }
    }
  }
  return path;
}

/** A polygon snapped to a cell grid anchored at the world origin: every cell
 * whose centre lies inside is included whole — the fill's edge becomes pixel
 * steps, never a cell cut in half. Rows are emitted as horizontal runs. */
export function snapPolygonToCells(points: { x: number; y: number }[], cell: number): Path2D | null {
  if (points.length < 3) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const q of points) { minX = Math.min(minX, q.x); minY = Math.min(minY, q.y); maxX = Math.max(maxX, q.x); maxY = Math.max(maxY, q.y); }
  const c0 = Math.floor(minX / cell), c1 = Math.ceil(maxX / cell);
  const r0 = Math.floor(minY / cell), r1 = Math.ceil(maxY / cell);
  if ((c1 - c0) * (r1 - r0) > 600_000) return null; // absurdly large: fall back to the smooth outline
  const path = new Path2D();
  for (let r = r0; r < r1; r++) {
    const cy = (r + 0.5) * cell;
    let run: number | null = null;
    for (let c = c0; c <= c1; c++) {
      const inside = c < c1 && pointInPolygon((c + 0.5) * cell, cy, points);
      if (inside && run === null) run = c;
      if (!inside && run !== null) { path.rect(run * cell, r * cell, (c - run) * cell, cell); run = null; }
    }
  }
  return path;
}

/** Dot families (screentone, sand): the fill is built from WHOLE motifs — a dot
 * is in when its centre is inside the polygon, so the edge never shows half
 * dots. Returns null for line-like families (those clip the pattern instead).
 * `m` scales the tile (zoom-stepped tones). */
export function motifPath(points: { x: number; y: number }[], id: string, angleDeg: number, m = 1): Path2D | null {
  const p = parse(id);
  if (!p || (p.fam !== 'tone' && p.fam !== 'sand') || points.length < 3) return null;
  const T = patternTileSize(id) * m;
  const a = (angleDeg * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
  // polygon bbox → pattern-space bbox (inverse rotation of the corners)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const q of points) { minX = Math.min(minX, q.x); minY = Math.min(minY, q.y); maxX = Math.max(maxX, q.x); maxY = Math.max(maxY, q.y); }
  let pu0 = Infinity, pv0 = Infinity, pu1 = -Infinity, pv1 = -Infinity;
  for (const [x, y] of [[minX, minY], [maxX, minY], [minX, maxY], [maxX, maxY]]) {
    const u = x * ca + y * sa, v = -x * sa + y * ca; // world → pattern space
    pu0 = Math.min(pu0, u); pv0 = Math.min(pv0, v); pu1 = Math.max(pu1, u); pv1 = Math.max(pv1, v);
  }
  const i0 = Math.floor(pu0 / T) - 1, i1 = Math.ceil(pu1 / T) + 1;
  const j0 = Math.floor(pv0 / T) - 1, j1 = Math.ceil(pv1 / T) + 1;
  const motifs: [number, number][] = p.fam === 'tone'
    ? [[0, 0], [T / 2, T / 2]]
    : Array.from({ length: Math.round([10, 22, 40, 65, 100][p.k - 1] * (T * T) / 16 / (m * m)) }, (_, i) => [rnd(i, 1) * T, rnd(i, 2) * T] as [number, number]);
  const r = p.fam === 'tone' ? Math.sqrt(([0.08, 0.18, 0.3, 0.45, 0.62][p.k - 1] * T * T) / 2 / Math.PI) : 0.13 * m;
  if ((i1 - i0) * (j1 - j0) * motifs.length > 400_000) return null; // too many dots: clip the pattern instead
  const path = new Path2D();
  for (let i = i0; i < i1; i++) for (let j = j0; j < j1; j++) {
    for (const [mu, mv] of motifs) {
      const u = i * T + mu, v = j * T + mv;
      const x = u * ca - v * sa, y = u * sa + v * ca; // pattern → world
      if (x < minX - r || x > maxX + r || y < minY - r || y > maxY + r) continue;
      if (!pointInPolygon(x, y, points)) continue;
      path.moveTo(x + r, y);
      path.arc(x, y, r, 0, Math.PI * 2);
    }
  }
  return path;
}

// deterministic per-tile randomness so a tile is identical every time it's built
const rnd = (i: number, salt: number) => {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/** Draw one seamless tile of `id` in `color`, `px` pixels square. */
export function patternTile(id: string, color: string, px: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = px;
  const g = c.getContext('2d')!;
  const p = parse(id);
  if (!p) return c;
  const T = patternTileSize(id);
  const s = px / T; // px per world unit
  g.scale(s, s);
  g.fillStyle = color;
  g.strokeStyle = color;
  const { fam, k } = p;
  const rule = cellRule(id);
  if (rule) {
    // pixel families: the tile is PIXEL_TILE_CELLS² cells of the shared grid
    const cell = PIXEL_CELL;
    for (let i = 0; i < PIXEL_TILE_CELLS; i++) {
      let run: number | null = null;
      for (let j = 0; j <= PIXEL_TILE_CELLS; j++) {
        const on = j < PIXEL_TILE_CELLS && rule(i, j);
        if (on && run === null) run = j;
        if (!on && run !== null) { g.fillRect(run * cell, i * cell, (j - run) * cell + 0.01, cell + 0.01); run = null; }
      }
    }
  } else if (fam === 'tone') {
    const d = [0.08, 0.18, 0.3, 0.45, 0.62][k - 1];
    const r = Math.sqrt((d * T * T) / 2 / Math.PI);
    for (const [x, y] of [[0, 0], [T, 0], [0, T], [T, T], [T / 2, T / 2]]) {
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
  } else if (fam === 'hatch' || fam === 'cross') {
    g.lineWidth = [0.22, 0.36, 0.55, 0.8, 1.15][k - 1];
    g.lineCap = 'butt';
    // lines run far past the tile: the canvas edge clips them, not a butt cap,
    // so the repeat is seamless (a cap on the border leaves a notch)
    const diag = (dir: 1 | -1) => {
      for (const off of [-2 * T, -T, 0, T, 2 * T]) {
        g.beginPath();
        if (dir === 1) { g.moveTo(off - T, 2 * T); g.lineTo(off + 2 * T, -T); }
        else { g.moveTo(off - T, -T); g.lineTo(off + 2 * T, 2 * T); }
        g.stroke();
      }
    };
    diag(1);
    if (fam === 'cross') diag(-1);
  } else if (fam === 'lines') {
    // horizontal ruled lines (one per tile), thicker with each level
    g.fillRect(-1, T / 2 - [0.15, 0.25, 0.4, 0.6, 0.9][k - 1] / 2, T + 2, [0.15, 0.25, 0.4, 0.6, 0.9][k - 1]);
  } else if (fam === 'grid') {
    const w = [0.12, 0.2, 0.3, 0.45, 0.65][k - 1];
    g.fillRect(-1, T / 2 - w / 2, T + 2, w);
    g.fillRect(T / 2 - w / 2, -1, w, T + 2);
  } else if (fam === 'sand') {
    // stipple: seeded scatter, more grains per level; drawn also wrapped so the tile is seamless
    const n = Math.round([10, 22, 40, 65, 100][k - 1] * (T * T) / 16); // same grain density as before, over the bigger tile
    const r = 0.13;
    for (let i = 0; i < n; i++) {
      const x = rnd(i, 1) * T, y = rnd(i, 2) * T;
      for (const [ox, oy] of [[0, 0], [T, 0], [-T, 0], [0, T], [0, -T]]) {
        g.beginPath(); g.arc(x + ox, y + oy, r, 0, Math.PI * 2); g.fill();
      }
    }
  } else if (fam === 'waves') {
    // two wavy rows per tile, one full period across → seamless
    g.lineWidth = [0.14, 0.22, 0.32, 0.45, 0.62][k - 1];
    for (const y0 of [T / 4, (3 * T) / 4]) {
      g.beginPath();
      for (let i = -4; i <= 44; i++) {
        const x = (i / 40) * T;
        const y = y0 + Math.sin((x / T) * Math.PI * 2) * 0.35;
        i === -4 ? g.moveTo(x, y) : g.lineTo(x, y);
      }
      g.stroke();
    }
  } else if (fam === 'scales') {
    // fish scales: staggered semicircles; heavier = thicker outline
    g.lineWidth = [0.12, 0.2, 0.3, 0.42, 0.58][k - 1];
    const R = T / 4;
    for (let row = -1; row <= 2; row++) {
      const y = row * (T / 2);
      const shift = row % 2 ? R : 0;
      for (let col = -1; col <= 2; col++) {
        g.beginPath(); g.arc(col * 2 * R + shift, y, R, Math.PI, 0); g.stroke();
      }
    }
  }
  return c;
}

const previewCache = new Map<string, string>();
/** CSS background for a swatch, at `scale` CSS px per world unit — every
 * pattern previews at the same magnification, so a coarse checker really
 * looks coarser than a fine one (rendered 2× for retina). */
export function patternPreviewCSS(id: string, color = PATTERN_INK, scale = 3): string {
  const key = `${id}|${color}|${scale}`;
  let url = previewCache.get(key);
  const T = patternTileSize(id);
  const px = T * scale;
  if (!url) {
    url = patternTile(id, color, Math.round(px * 2)).toDataURL();
    previewCache.set(key, url);
  }
  return `url(${url}) 0 0 / ${px}px ${px}px repeat, #FDFCF8`;
}

/** Catalogue for the pattern picker: categories → families (5 densities each). */
export const PATTERN_CATEGORIES: { label: string; families: { fam: string; label: string }[] }[] = [
  {
    label: 'Manga',
    families: [
      { fam: 'tone', label: 'Screentone' }, { fam: 'hatch', label: 'Hatching' }, { fam: 'cross', label: 'Cross-hatch' },
      { fam: 'lines', label: 'Ruled lines' }, { fam: 'grid', label: 'Grid' }, { fam: 'sand', label: 'Sand' },
      { fam: 'waves', label: 'Waves' }, { fam: 'scales', label: 'Scales' },
    ],
  },
  {
    label: 'Digital · one pixel grid',
    families: [
      { fam: 'bayer', label: 'Ordered' }, { fam: 'cluster', label: 'Halftone' }, { fam: 'pixdots', label: 'Pixel dots' },
      { fam: 'checker', label: 'Checker' }, { fam: 'scan', label: 'Scanlines' }, { fam: 'vscan', label: 'Vertical' },
      { fam: 'stairs', label: 'Diagonal' }, { fam: 'xhatch', label: 'Crosshatch' }, { fam: 'zigzag', label: 'Zigzag' },
      { fam: 'brick', label: 'Bricks' }, { fam: 'pixnoise', label: 'Noise' },
    ],
  },
];

/** Hues for the two pattern palettes (ink, paper, then swatches per family). */
export const MANGA_HUES = [
  PATTERN_INK, '#FDFCF8',
  'pattern:tone-3', 'pattern:hatch-2', 'pattern:sand-3', 'pattern:waves-2', 'pattern:scales-2', 'pattern:grid-2',
];
export const DIGITAL_HUES = [
  PATTERN_INK, '#FDFCF8',
  'pattern:bayer-3', 'pattern:scan-3', 'pattern:checker-2', 'pattern:pixnoise-3', 'pattern:stairs-2',
];
