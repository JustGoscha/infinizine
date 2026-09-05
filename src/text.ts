// Text engine: typefaces, markdown parsing (# headings, - bullets, **bold**,
// *italic*), wrapping layout shared by the canvas renderer and the editor.

const mctx = document.createElement('canvas').getContext('2d')!;

export const LINE_HEIGHT = 1.3;

export const FONTS: Record<string, { name: string; css: string }> = {
  franklin: { name: 'Sans', css: '"Hanken Grotesk", sans-serif' },
  serif: { name: 'Serif', css: '"Fraunces", serif' },
  mono: { name: 'Mono', css: '"IBM Plex Mono", monospace' },
  comic: { name: 'Comic', css: '"Kalam", cursive' },
  shout: { name: 'Shout', css: '"Bangers", sans-serif' },
};

export function fontFor(family: string, size: number, bold = false, italic = false): string {
  const css = (FONTS[family] ?? FONTS.franklin).css;
  return `${italic ? 'italic ' : ''}${bold ? 700 : 400} ${size}px ${css}`;
}

export interface Seg { t: string; b: boolean; i: boolean }
export interface RichLine { segs: Seg[]; size: number }

/** Inline markdown: **bold** and *italic*. */
function parseInline(s: string): Seg[] {
  const segs: Seg[] = [];
  let bold = false;
  for (const part of s.split('**')) {
    let italic = false;
    for (const p of part.split('*')) {
      if (p) segs.push({ t: p, b: bold, i: italic });
      italic = !italic;
    }
    bold = !bold;
  }
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
        if (t) tokens.push({ t, b: g.b || forceBold, i: g.i });
      });
    }

    const width = (seg: Seg) => {
      mctx.font = fontFor(family, size, seg.b, seg.i);
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
  mctx.font = fontFor(family, line.size, seg.b, seg.i);
  return mctx.measureText(seg.t).width;
}
