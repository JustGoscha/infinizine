// Text engine: typefaces, markdown parsing (# headings, - bullets, **bold**,
// *italic*), wrapping layout shared by the canvas renderer and the editor.

const mctx = document.createElement('canvas').getContext('2d')!;

export const LINE_HEIGHT = 1.3;

/** Five roles a text box can use; each role maps to one of several faces the
 * user picks in settings. Documents store the role, so swapping a face
 * restyles every box of that role. All faces are bundled (see fonts.ts). */
export type FontRole = 'franklin' | 'serif' | 'mono' | 'comic' | 'shout';
export interface Face { id: string; name: string; css: string; licence: string; weights?: [number, number] }
export const FACES: Record<FontRole, Face[]> = {
  franklin: [
    { id: 'hanken', name: 'Hanken Grotesk', css: '"Hanken Grotesk Variable", sans-serif', licence: 'OFL', weights: [100, 900] },
    { id: 'inter', name: 'Inter', css: '"Inter Variable", sans-serif', licence: 'OFL', weights: [100, 900] },
    { id: 'atkinson', name: 'Atkinson Hyperlegible', css: '"Atkinson Hyperlegible", sans-serif', licence: 'OFL' },
    { id: 'nunito', name: 'Nunito', css: '"Nunito Variable", sans-serif', licence: 'OFL', weights: [200, 900] },
    { id: 'worksans', name: 'Work Sans', css: '"Work Sans Variable", sans-serif', licence: 'OFL', weights: [100, 900] },
    { id: 'librefranklin', name: 'Libre Franklin', css: '"Libre Franklin Variable", sans-serif', licence: 'OFL', weights: [100, 900] },
  ],
  serif: [
    { id: 'fraunces', name: 'Fraunces', css: '"Fraunces Variable", serif', licence: 'OFL', weights: [100, 900] },
    { id: 'lora', name: 'Lora', css: '"Lora Variable", serif', licence: 'OFL', weights: [400, 700] },
    { id: 'baskerville', name: 'Libre Baskerville', css: '"Libre Baskerville", serif', licence: 'OFL' },
    { id: 'crimson', name: 'Crimson Pro', css: '"Crimson Pro Variable", serif', licence: 'OFL', weights: [200, 900] },
    { id: 'garamond', name: 'EB Garamond', css: '"EB Garamond Variable", serif', licence: 'OFL', weights: [400, 800] },
  ],
  mono: [
    { id: 'plexmono', name: 'IBM Plex Mono', css: '"IBM Plex Mono", monospace', licence: 'OFL' },
    { id: 'jetbrains', name: 'JetBrains Mono', css: '"JetBrains Mono Variable", monospace', licence: 'OFL', weights: [100, 800] },
    { id: 'firamono', name: 'Fira Mono', css: '"Fira Mono", monospace', licence: 'OFL' },
    { id: 'spacemono', name: 'Space Mono', css: '"Space Mono", monospace', licence: 'OFL' },
    { id: 'courierprime', name: 'Courier Prime', css: '"Courier Prime", monospace', licence: 'OFL' },
  ],
  comic: [
    { id: 'kalam', name: 'Kalam', css: '"Kalam", cursive', licence: 'OFL' },
    { id: 'patrick', name: 'Patrick Hand', css: '"Patrick Hand", cursive', licence: 'OFL' },
    { id: 'comicneue', name: 'Comic Neue', css: '"Comic Neue", cursive', licence: 'OFL' },
    { id: 'architects', name: 'Architects Daughter', css: '"Architects Daughter", cursive', licence: 'OFL' },
    { id: 'gloria', name: 'Gloria Hallelujah', css: '"Gloria Hallelujah", cursive', licence: 'OFL' },
  ],
  shout: [
    { id: 'bangers', name: 'Bangers', css: '"Bangers", sans-serif', licence: 'OFL' },
    { id: 'anton', name: 'Anton', css: '"Anton", sans-serif', licence: 'OFL' },
    { id: 'bebas', name: 'Bebas Neue', css: '"Bebas Neue", sans-serif', licence: 'OFL' },
    { id: 'luckiest', name: 'Luckiest Guy', css: '"Luckiest Guy", sans-serif', licence: 'Apache 2.0' },
    { id: 'alfaslab', name: 'Alfa Slab One', css: '"Alfa Slab One", serif', licence: 'OFL' },
  ],
};
const ROLE_NAMES: Record<FontRole, string> = { franklin: 'Sans', serif: 'Serif', mono: 'Mono', comic: 'Comic', shout: 'Shout' };
const FACES_KEY = 'infinizine-faces';
const DEFAULT_FACES: Record<FontRole, string> = { franklin: 'hanken', serif: 'fraunces', mono: 'plexmono', comic: 'kalam', shout: 'bangers' };
/** app-wide picks (this device) */
export const appFaces: Record<FontRole, string> = (() => {
  const d = { ...DEFAULT_FACES };
  try {
    const saved = JSON.parse(localStorage.getItem(FACES_KEY) ?? '{}') as Partial<Record<FontRole, string>>;
    for (const r of Object.keys(d) as FontRole[]) {
      if (saved[r] && FACES[r].some((f) => f.id === saved[r])) d[r] = saved[r]!;
    }
  } catch { /* ignore */ }
  return d;
})();
/** the open zine's overrides (saved in the document) */
export let docFaces: Partial<Record<FontRole, string>> = {};
/** effective picks: zine override, else app-wide */
export const chosenFaces: Record<FontRole, string> = { ...appFaces };
export function faceOf(role: FontRole): Face {
  return FACES[role].find((f) => f.id === chosenFaces[role]) ?? FACES[role][0];
}
/** role → { name, css } for the current picks (the editor's font bar and the renderer read this) */
export const FONTS: Record<string, { name: string; css: string }> = {} as Record<string, { name: string; css: string }>;
function refreshFonts() {
  for (const r of Object.keys(FACES) as FontRole[]) {
    const ov = docFaces[r];
    chosenFaces[r] = ov && FACES[r].some((f) => f.id === ov) ? ov : appFaces[r];
    FONTS[r] = { name: ROLE_NAMES[r], css: faceOf(r).css };
  }
}
refreshFonts();
/** app-wide pick (device setting) */
export function setFace(role: FontRole, id: string) {
  if (!FACES[role].some((f) => f.id === id)) return;
  appFaces[role] = id;
  try { localStorage.setItem(FACES_KEY, JSON.stringify(appFaces)); } catch { /* ignore */ }
  refreshFonts();
}
/** install the open zine's overrides (call when a document loads/switches/changes) */
export function setDocFaces(faces: Record<string, string> | undefined) {
  docFaces = { ...(faces ?? {}) } as Partial<Record<FontRole, string>>;
  refreshFonts();
}

/** Weight range a role's current face supports (undefined = just 400/700). */
export function weightRange(role: string): [number, number] | undefined {
  return faceOf((role in FACES ? role : 'franklin') as FontRole).weights;
}
export function fontFor(family: string, size: number, bold = false, italic = false, weight?: number): string {
  const css = (FONTS[family] ?? FONTS.franklin).css;
  // an explicit weight wins; bold on top of it pushes heavier
  const w = weight !== undefined ? (bold ? Math.min(900, weight + 300) : weight) : bold ? 700 : 400;
  return `${italic ? 'italic ' : ''}${w} ${size}px ${css}`;
}

export interface Seg { t: string; b: boolean; i: boolean; u?: boolean; f?: string; w?: number }
export interface RichLine { segs: Seg[]; size: number }

export const ROLE_IDS = ['franklin', 'serif', 'mono', 'comic', 'shout'] as const;
const SPAN_OPEN = /^\{([a-z0-9 ]+)\|/;

/** Inline markdown in one pass: **bold**, *italic*, __underline__, and
 * `{attrs|text}` spans where attrs are a role (comic, serif, …) and/or a
 * weight (w100…w900); spans nest, inner attrs override, marks flow across. */
export function parseInline(s: string): Seg[] {
  const segs: Seg[] = [];
  let b = false, i = false, u = false, buf = '';
  const stack: { f?: string; w?: number }[] = [];
  const cur = () => stack[stack.length - 1] ?? {};
  const flush = () => {
    if (!buf) return;
    const c = cur();
    segs.push({ t: buf, b, i, u: u || undefined, f: c.f, w: c.w });
    buf = '';
  };
  for (let k = 0; k < s.length; k++) {
    if (s[k] === '{') {
      const m = SPAN_OPEN.exec(s.slice(k));
      if (m) {
        flush();
        const c = { ...cur() };
        for (const a of m[1].split(' ')) {
          if ((ROLE_IDS as readonly string[]).includes(a)) c.f = a;
          else if (/^w[1-9]00$/.test(a)) c.w = Number(a.slice(1));
        }
        stack.push(c);
        k += m[0].length - 1;
        continue;
      }
    }
    if (s[k] === '}' && stack.length) { flush(); stack.pop(); continue; }
    if (s.startsWith('**', k)) { flush(); b = !b; k++; continue; }
    if (s.startsWith('__', k)) { flush(); u = !u; k++; continue; }
    if (s[k] === '*') { flush(); i = !i; continue; }
    buf += s[k];
  }
  flush();
  return segs;
}

/** Full layout: block markdown + inline styles + greedy wrap to maxW. */
export function layoutText(text: string, family: string, fontSize: number, maxW: number): RichLine[] {
  const out: RichLine[] = [];
  for (const raw of text.split('\n')) {
    let s = raw;
    let mult = 1;
    let forceBold = false;
    let bullet = false;
    if (s.startsWith('# ')) { s = s.slice(2); mult = 1.6; forceBold = true; }
    else if (s.startsWith('## ')) { s = s.slice(3); mult = 1.35; forceBold = true; }
    else if (s.startsWith('### ')) { s = s.slice(4); mult = 1.18; forceBold = true; }
    else if (s.startsWith('- ') || s.startsWith('* ')) { s = s.slice(2); bullet = true; }
    const size = fontSize * mult;
    if (!s) { out.push({ segs: [], size }); continue; }

    // tokenize into styled words (keeping trailing spaces)
    const tokens: Seg[] = [];
    for (const g of parseInline(s)) {
      const words = g.t.split(' ');
      words.forEach((wd, idx) => {
        const t = idx < words.length - 1 ? `${wd} ` : wd;
        if (t) tokens.push({ t, b: g.b || forceBold, i: g.i, u: g.u, f: g.f, w: g.w });
      });
    }

    const width = (seg: Seg) => {
      mctx.font = fontFor(seg.f ?? family, size, seg.b, seg.i, seg.w);
      return mctx.measureText(seg.t).width;
    };
    const lead: Seg[] = bullet ? [{ t: '•  ', b: false, i: false }] : [];
    const contLead: Seg[] = bullet ? [{ t: '    ', b: false, i: false }] : [];
    let line: Seg[] = [...lead];
    let lw = line.reduce((a, sgm) => a + width(sgm), 0);
    for (const tk of tokens) {
      const wpx = width(tk);
      if (lw + wpx > maxW && line.length > lead.length) {
        out.push({ segs: line, size });
        line = [...contLead];
        lw = line.reduce((a, sgm) => a + width(sgm), 0);
      }
      line.push(tk);
      lw += wpx;
    }
    out.push({ segs: line, size });
  }
  return out;
}

export function layoutHeight(lines: RichLine[]): number {
  return lines.reduce((a, l) => a + l.size * LINE_HEIGHT, 0);
}

/** Widest line, for auto-sized boxes (lay out with a huge maxW first). */
export function layoutWidth(lines: RichLine[], family: string): number {
  let w = 0;
  for (const line of lines) {
    let lw = 0;
    for (const seg of line.segs) lw += segWidth(family, line, seg);
    w = Math.max(w, lw);
  }
  return w;
}

export function segWidth(family: string, line: RichLine, seg: Seg): number {
  mctx.font = fontFor(seg.f ?? family, line.size, seg.b, seg.i, seg.w);
  return mctx.measureText(seg.t).width;
}
