// Fill patterns: manga screentones (dots, hatching) and digital dithers
// (Bayer, scanlines). A pattern is a "colour" like `pattern:tone-3`; only the
// fill tool paints it — strokes and text using a pattern swatch just get ink.

export const PATTERN_INK = '#1a1a1a';
export const isPattern = (c: string) => c.startsWith('pattern:');
/** what a stroke/text gets when a pattern swatch is active */
export const inkOf = (c: string) => (isPattern(c) ? PATTERN_INK : c);

type Family = 'tone' | 'hatch' | 'cross' | 'bayer' | 'scan';
const FAMILIES: Family[] = ['tone', 'hatch', 'cross', 'bayer', 'scan'];
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
  const names: Record<Family, string> = { tone: 'Screentone', hatch: 'Hatching', cross: 'Cross-hatch', bayer: 'Dither', scan: 'Scanlines' };
  return `${names[p.fam]} ${p.k}`;
}

/** tile size in world units (2 units = 1mm): tones repeat every 1.5mm, dither cells are 0.6mm */
export function patternTileSize(id: string): number {
  const p = parse(id);
  if (!p) return 3;
  return p.fam === 'bayer' ? 4.8 : p.fam === 'scan' ? 2.4 : 3;
}

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
    const diag = (dir: 1 | -1) => {
      for (const off of [-T, 0, T]) {
        g.beginPath();
        if (dir === 1) { g.moveTo(off, T); g.lineTo(off + T, 0); }
        else { g.moveTo(off, 0); g.lineTo(off + T, T); }
        g.stroke();
      }
    };
    diag(1);
    if (fam === 'cross') diag(-1);
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

/** Hues for the two pattern palettes (ink, paper, then swatches per family). */
export const MANGA_HUES = [PATTERN_INK, '#FDFCF8', 'pattern:tone-2', 'pattern:tone-4', 'pattern:hatch-2', 'pattern:cross-3'];
export const DIGITAL_HUES = [PATTERN_INK, '#FDFCF8', 'pattern:bayer-1', 'pattern:bayer-3', 'pattern:bayer-4', 'pattern:scan-3'];
