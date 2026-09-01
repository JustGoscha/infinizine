// Preset palettes: 8 hues each; 6 gradations per hue are derived in HSL.
// Adjustable per document later (SPEC: presets + per-doc tweaks).

export interface PalettePreset {
  id: string;
  name: string;
  hues: string[];
  drama?: number; // 0..1: how extreme the painterly hue-shift in shades is (default 0.5)
}

// Each palette: 5–6 colors — whitish, blackish, neutralish, then 2–3 accents.
// Accents are curated per palette, not derived from shared hues.
// Lighter/darker gradations of each color live in the hover/long-press flyout.
export const PALETTES: PalettePreset[] = [
  {
    id: 'ink',
    drama: 0.3,
    name: 'Classic Ink',
    hues: ['#FAF7F0', '#191713', '#9C9282', '#2B5A9E', '#C24329'],
  },
  {
    id: 'pastel',
    drama: 0.35,
    name: 'Pastel',
    hues: ['#FDFAF5', '#57524B', '#C9BFB2', '#EFA9B8', '#9BBBDD', '#A9D8BF'],
  },
  {
    id: 'vibrant',
    drama: 0.75,
    name: 'Vibrant',
    hues: ['#FFFFFF', '#141414', '#B3ADA1', '#FF3B30', '#0A84FF', '#FFC800'],
  },
  {
    id: 'autumn',
    drama: 0.7,
    name: 'Autumn',
    hues: ['#F8F1E3', '#2E2016', '#A78A63', '#B5471D', '#5A6B2F'],
  },
  {
    id: 'riso',
    drama: 0.9,
    name: 'Riso',
    hues: ['#FFFDF6', '#1F2A44', '#B9B3A8', '#FF48B0', '#0078BF'],
  },
  {
    id: 'ocean',
    drama: 0.6,
    name: 'Ocean',
    hues: ['#F4FAFA', '#0E2A32', '#8FA9AD', '#0E7C86', '#F4A259'],
  },
  {
    id: 'forest',
    drama: 0.6,
    name: 'Forest',
    hues: ['#F7F7EF', '#1E2A1C', '#9AA487', '#3E6B48', '#C97B3D'],
  },
  {
    id: 'bauhaus',
    drama: 0.5,
    name: 'Bauhaus',
    hues: ['#F5F1E6', '#191919', '#A8A29A', '#D02E2E', '#2B5BA8', '#E8B62E'],
  },
  {
    id: 'newsprint',
    drama: 0.25,
    name: 'Newsprint',
    hues: ['#F6F4EE', '#232323', '#8F8B85', '#C22F2F', '#3A66A0'],
  },
  {
    id: 'sunset',
    drama: 0.85,
    name: 'Sunset',
    hues: ['#FFF8F0', '#33202A', '#B08D8A', '#E2725B', '#8A4F7D', '#F2B95F'],
  },
  {
    id: 'blueprint',
    drama: 0.4,
    name: 'Blueprint',
    hues: ['#EAF0F6', '#12233D', '#7E93AC', '#1F5FBF', '#E0533D'],
  },
  // all-color palettes — no whites, blacks, or neutrals
  {
    id: 'markers',
    drama: 0.8,
    name: 'Marker Set',
    hues: ['#FF6B35', '#004E89', '#1B998B', '#FFBC42', '#D7263D', '#6A4C93'],
  },
  {
    id: 'fauve',
    drama: 1.0,
    name: 'Fauvist',
    hues: ['#E84545', '#2B6CB0', '#2F9E44', '#F2B705', '#8A4F7D'],
  },
  {
    id: 'gelato',
    drama: 0.45,
    name: 'Gelato',
    hues: ['#FF8FA3', '#FFD166', '#8ECAE6', '#B5E48C', '#CDB4DB'],
  },
  {
    id: 'jungle',
    drama: 0.7,
    name: 'Jungle',
    hues: ['#1E5128', '#4E9F3D', '#D8973C', '#A63C06', '#256D85'],
  },
];

export function getPalette(id: string): PalettePreset {
  return PALETTES.find((p) => p.id === id) ?? PALETTES[0];
}

/** 6 gradations light→dark for a hue. Index 3 ≈ the base color.
 * `drama` scales how far the painterly hue-shift goes (per palette). */
export function shades(hex: string, drama = 0.5): string[] {
  const { h, s, l } = hexToHsl(hex);
  // Whitish colors: stay whitish — a ramp of lights and neutral greys, never saturated hues
  if (l > 0.9) {
    return [0.99, 0.965, 0.93, 0.88, 0.82, 0.74].map((tl) => hslToHex(h, Math.min(s, 0.12), tl));
  }
  // Near-black / grey hues: neutral ramp
  if (s < 0.08) {
    return [0.85, 0.68, 0.5, 0.34, 0.2, 0.08].map((tl) => hslToHex(h, s, tl));
  }
  // Painterly ramp: monotonic light→dark, but hue drifts the way artists shade —
  // tints lean warm (toward yellow), shades lean cool (toward blue-violet),
  // with saturation easing in the lights and deepening in the darks.
  const hi = Math.min(0.9, l + 0.35);
  const lo = Math.max(0.1, l - 0.35);
  const WARM = 55 / 360;
  const COOL = 255 / 360;
  const shiftHue = (from: number, to: number, amount: number) => {
    let d = to - from;
    d -= Math.round(d); // shortest way around the wheel
    return (from + d * amount + 1) % 1;
  };
  return [0, 1, 2, 3, 4, 5].map((i) => {
    const L = hi + ((lo - hi) * i) / 5;
    const k = drama / 0.5; // 0.5 = the baseline amount
    if (L > l) {
      const t = (L - l) / Math.max(0.001, hi - l);
      return hslToHex(shiftHue(h, WARM, Math.min(0.85, t * 0.22 * k)), s * (1 - Math.min(0.6, 0.25 * t * k)), L);
    }
    const t = (l - L) / Math.max(0.001, l - lo);
    return hslToHex(shiftHue(h, COOL, Math.min(0.85, t * 0.3 * k)), Math.min(1, s * (1 + 0.2 * t * k)), L);
  });
}

function hexToHsl(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return { h, s, l };
}

function hslToHex(h: number, s: number, l: number): string {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}
