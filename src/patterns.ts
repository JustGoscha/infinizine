// Fill patterns: manga screentones (dots, hatching) and digital dithers
// (Bayer, scanlines). A pattern is a "colour" like `pattern:tone-3`; only the
// fill tool paints it — strokes and text using a pattern swatch just get ink.

import { pointInPolygon } from './geometry';

export const PATTERN_INK = '#1a1a1a';
export const isPattern = (c: string) => c.startsWith('pattern:');
/** what a stroke/text gets when a pattern swatch is active */
export const inkOf = (c: string) => (isPattern(c) ? PATTERN_INK : c);

type Family =
  | 'tone' | 'hatch' | 'cross' | 'lines' | 'grid' | 'sand' | 'waves' | 'scales' // manga
  | 'bayer' | 'scan' | 'checker' | 'pixnoise' | 'stairs'; // digital
const FAMILIES: Family[] = ['tone', 'hatch', 'cross', 'lines', 'grid', 'sand', 'waves', 'scales', 'bayer', 'scan', 'checker', 'pixnoise', 'stairs'];
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
export function patternLabel(id: string): string {
  const p = parse(id);
  if (!p) return id;
  const names: Record<Family, string> = {
    tone: 'Screentone', hatch: 'Hatching', cross: 'Cross-hatch', lines: 'Ruled lines', grid: 'Grid',
    sand: 'Sand tone', waves: 'Waves', scales: 'Scales',
    bayer: 'Dither', scan: 'Scanlines', checker: 'Checker', pixnoise: 'Pixel noise', stairs: 'Pixel stairs',
  };
  return `${names[p.fam]} ${p.k}`;
}

/** tile size in world units (2 units = 1mm): tones repeat every 1.5mm, dither cells are 0.6mm */
export function patternTileSize(id: string): number {
  const p = parse(id);
  if (!p) return 3;
  switch (p.fam) {
    case 'bayer': case 'stairs': return 4.8; // 8 × 0.6mm cells (stairs: 4)
    case 'pixnoise': return 12; // 20 × 0.6mm cells: random-looking, repeat not noticeable
    case 'scan': return 2.4;
    case 'checker': return 2 * [0.5, 0.7, 0.9, 1.2, 1.6][p.k - 1];
    case 'sand': return 14; // big tile so the stipple doesn't visibly repeat
    case 'waves': case 'scales': return 4;
    default: return 3;
  }
}

/** Pixel families: cell size in world units (fills snap their outline to this grid). */
export function patternCellSize(id: string): number | null {
  const p = parse(id);
  if (!p) return null;
  const T = patternTileSize(id);
  switch (p.fam) {
    case 'bayer': case 'stairs': return T / 4;
    case 'pixnoise': return T / 20;
    case 'checker': case 'scan': return T / 2;
    default: return null;
  }
}
export const isPixelPattern = (id: string) => patternCellSize(id) !== null;

/** Pixel families as a cell predicate + per-cell drawn height fraction (scanlines are thin rows). */
function cellRule(id: string): { on: (i: number, j: number) => boolean; hFrac: number } | null {
  const p = parse(id);
  if (!p) return null;
  const { fam, k } = p;
  switch (fam) {
    case 'bayer': { const level = [2, 5, 8, 11, 14][k - 1]; return { on: (i, j) => BAYER[((i % 4) + 4) % 4][((j % 4) + 4) % 4] < level, hFrac: 1 }; }
    case 'stairs': return { on: (i, j) => ((((i + j) % 4) + 4) % 4) < Math.min(k, 3), hFrac: 1 };
    case 'checker': return { on: (i, j) => ((((i + j) % 2) + 2) % 2) === 0, hFrac: 1 };
    case 'pixnoise': { const pr = [0.1, 0.22, 0.38, 0.55, 0.72][k - 1]; return { on: (i, j) => rnd((((i % 20) + 20) % 20) * 20 + (((j % 20) + 20) % 20), 5) < pr, hFrac: 1 }; }
    case 'scan': return { on: (i) => (((i % 2) + 2) % 2) === 0, hFrac: [0.25, 0.4, 0.55, 0.7, 0.85][k - 1] };
    default: return null;
  }
}

/** Pixel-pattern fill as solid geometry: every "on" cell whose centre is inside
 * the polygon, merged into horizontal runs. No repeating tile → no resampling
 * seams between pixels at any zoom; whole cells only at the edge. */
export function cellPath(points: { x: number; y: number }[], id: string): Path2D | null {
  const rule = cellRule(id);
  const cell = patternCellSize(id);
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
    let run = -1;
    for (let c = c0; c <= c1; c++) {
      const inside = c < c1 && rule.on(r, c) && pointInPolygon((c + 0.5) * cell, cy, points);
      if (inside && run < 0) run = c;
      if (!inside && run >= 0) {
        path.rect(run * cell - eps, r * cell - eps, (c - run) * cell + 2 * eps, cell * rule.hFrac + (rule.hFrac === 1 ? 2 * eps : 0));
        run = -1;
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
    let run = -1;
    for (let c = c0; c <= c1; c++) {
      const inside = c < c1 && pointInPolygon((c + 0.5) * cell, cy, points);
      if (inside && run < 0) run = c;
      if (!inside && run >= 0) { path.rect(run * cell, r * cell, (c - run) * cell, cell); run = -1; }
    }
  }
  return path;
}

/** Dot families (screentone, sand): the fill is built from WHOLE motifs — a dot
 * is in when its centre is inside the polygon, so the edge never shows half
 * dots. Returns null for line-like families (those clip the pattern instead). */
export function motifPath(points: { x: number; y: number }[], id: string, angleDeg: number): Path2D | null {
  const p = parse(id);
  if (!p || (p.fam !== 'tone' && p.fam !== 'sand') || points.length < 3) return null;
  const T = patternTileSize(id);
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
    : Array.from({ length: Math.round([10, 22, 40, 65, 100][p.k - 1] * (T * T) / 16) }, (_, i) => [rnd(i, 1) * T, rnd(i, 2) * T] as [number, number]);
  const r = p.fam === 'tone' ? Math.sqrt(([0.08, 0.18, 0.3, 0.45, 0.62][p.k - 1] * T * T) / 2 / Math.PI) : 0.13;
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

const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

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
  if (fam === 'tone') {
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
  } else if (fam === 'checker') {
    const c = T / 2;
    g.fillRect(0, 0, c + 0.01, c + 0.01);
    g.fillRect(c, c, c + 0.01, c + 0.01);
  } else if (fam === 'pixnoise') {
    const N = 20, cell = T / N;
    const p = [0.1, 0.22, 0.38, 0.55, 0.72][k - 1];
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      if (rnd(i * N + j, 5) < p) g.fillRect(j * cell, i * cell, cell + 0.01, cell + 0.01);
    }
  } else if (fam === 'stairs') {
    // pixel diagonal: a 1-cell-wide staircase per 4 cells, thicker with level
    const cell = T / 4;
    const thick = k; // 1..5 cells wide out of 8? keep within the 4-cell period
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
      if (((i + j) % 4) < Math.min(thick, 3)) g.fillRect(j * cell, i * cell, cell + 0.01, cell + 0.01);
    }
  } else if (fam === 'bayer') {
    const level = [2, 5, 8, 11, 14][k - 1];
    const cell = T / 4;
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
      if (BAYER[i][j] < level) g.fillRect(j * cell, i * cell, cell + 0.01, cell + 0.01);
    }
  } else if (fam === 'scan') {
    const cell = T / 2;
    const h = [0.25, 0.4, 0.55, 0.7, 0.85][k - 1] * cell;
    g.fillRect(0, 0, T + 0.01, h);
    g.fillRect(0, cell, T + 0.01, h);
  }
  return c;
}

const previewCache = new Map<string, string>();
/** CSS background for a swatch: the tile as a data URL (repeat it at `px`) */
export function patternPreviewCSS(id: string, color = PATTERN_INK, px = 14): string {
  const key = `${id}|${color}|${px}`;
  let url = previewCache.get(key);
  if (!url) {
    url = patternTile(id, color, px * 2).toDataURL();
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
    label: 'Digital',
    families: [
      { fam: 'bayer', label: 'Dither' }, { fam: 'scan', label: 'Scanlines' }, { fam: 'checker', label: 'Checker' },
      { fam: 'pixnoise', label: 'Pixel noise' }, { fam: 'stairs', label: 'Pixel stairs' },
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
