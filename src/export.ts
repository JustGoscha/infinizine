// Exports: pages (in reading order) or the whole canvas, as PNGs in a zip, a
// PDF, animated GIFs, a standalone HTML viewer, or the .zine file itself.
import type { Store } from './store';
import type { Renderer } from './render';
import { UNITS_PER_MM } from './types';
import { makeZip } from './zip';
import { makePdf, type PdfPage } from './pdf';
import { makeGif, type GifFrame } from './gif';

const toast = (msg: string) => window.dispatchEvent(new CustomEvent('izine-toast', { detail: msg }));

export type ExportScope = 'pages' | 'canvas';
export type ExportFormat = 'png' | 'pdf' | 'gif' | 'html' | 'zine';
export interface ExportOptions {
  scope: ExportScope;
  format: ExportFormat;
  dpi: number; // 150 | 300
  paperPattern: boolean; // include the paper's dot/grid pattern
}

type Region = { name: string; x: number; y: number; w: number; h: number };
const MAX_SIDE = 8192;

function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const breathe = () => new Promise((r) => setTimeout(r, 0));
const toBlob = (c: HTMLCanvasElement, type: string, q?: number) => new Promise<Blob | null>((res) => c.toBlob(res, type, q));

/** What to render: every page in reading order, or one rectangle around everything. */
function regions(store: Store, scope: ExportScope): Region[] {
  if (scope === 'pages') {
    return store.orderedPages().map((p, i) => ({ name: `page-${String(i + 1).padStart(2, '0')}`, x: p.x, y: p.y, w: p.w, h: p.h }));
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x0: number, y0: number, x1: number, y1: number) => { minX = Math.min(minX, x0); minY = Math.min(minY, y0); maxX = Math.max(maxX, x1); maxY = Math.max(maxY, y1); };
  for (const p of store.doc.pages) grow(p.x, p.y, p.x + p.w, p.y + p.h);
  for (const a of store.doc.areas) grow(a.x, a.y, a.x + a.w, a.y + a.h);
  for (const el of store.doc.elements) {
    if (el.kind === 'text' || el.kind === 'image') grow(el.x, el.y, el.x + el.w, el.y + el.h);
    else for (const q of el.points) grow(q.x, q.y, q.x, q.y);
  }
  if (!Number.isFinite(minX)) return [];
  const pad = 10; // 5 mm of paper around everything
  return [{ name: 'canvas', x: minX - pad, y: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad }];
}

/** px per world unit for `dpi`, capped so no side exceeds MAX_SIDE. */
function scaleFor(r: Region, dpi: number) {
  let scale = dpi / 25.4 / UNITS_PER_MM;
  const longest = Math.max(r.w, r.h);
  if (longest * scale > MAX_SIDE) scale = MAX_SIDE / longest;
  return scale;
}

/** Frames of a region's animation as raw RGBA, at most ~10 s and 120 frames. */
function gifFrames(renderer: Renderer, r: Region, scale: number, paperPattern: boolean): { w: number; h: number; frames: GifFrame[] } | null {
  const info = renderer.animInfo(r);
  if (!info) return null;
  const fps = Math.min(30, info.fps);
  const count = Math.max(1, Math.min(120, Math.ceil(Math.min(info.seconds, 10) * fps)));
  const frames: GifFrame[] = [];
  let w = 0, h = 0;
  for (let i = 0; i < count; i++) {
    const c = renderer.renderRegion(r, scale, { time: i / fps, paperPattern });
    w = c.width; h = c.height;
    frames.push({ data: c.getContext('2d')!.getImageData(0, 0, w, h).data, delayMs: 1000 / fps });
  }
  return { w, h, frames };
}

export async function exportZine(store: Store, renderer: Renderer, opts: ExportOptions) {
  const safe = (store.doc.name || 'zine').replace(/[^\w\-]+/g, '_');
  if (opts.format === 'zine') {
    download(new Blob([store.exportJSON()], { type: 'application/json' }), `${store.doc.name || 'zine'}.zine`);
    return;
  }
  const regs = regions(store, opts.scope);
  if (!regs.length) { toast(opts.scope === 'pages' ? 'No pages to export' : 'Nothing on the canvas yet'); return; }
  const { paperPattern } = opts;
  toast(`Rendering ${regs.length === 1 ? regs[0].name : `${regs.length} pages`} at ${opts.dpi} dpi…`);
  await breathe();

  if (opts.format === 'png') {
    const files: { name: string; data: Uint8Array }[] = [];
    for (const r of regs) {
      const blob = await toBlob(renderer.renderRegion(r, scaleFor(r, opts.dpi), { paperPattern }), 'image/png');
      if (blob) files.push({ name: `${safe}-${r.name}.png`, data: new Uint8Array(await blob.arrayBuffer()) });
      await breathe();
    }
    if (files.length === 1) download(new Blob([files[0].data as BlobPart]), files[0].name);
    else download(makeZip(files), `${safe}-pages.zip`);
    toast(`Exported ${files.length} PNG${files.length === 1 ? '' : 's'}`);
    return;
  }

  if (opts.format === 'pdf') {
    const pages: PdfPage[] = [];
    for (const r of regs) {
      const scale = Math.min(scaleFor(r, opts.dpi), scaleFor(r, 300));
      const c = renderer.renderRegion(r, scale, { paperPattern });
      const blob = await toBlob(c, 'image/jpeg', 0.92);
      if (!blob) continue;
      const pt = 72 / 25.4 / UNITS_PER_MM; // points per world unit
      pages.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), wPx: c.width, hPx: c.height, wPt: r.w * pt, hPt: r.h * pt });
      await breathe();
    }
    download(makePdf(pages, store.doc.name), `${safe}.pdf`);
    toast(`Exported ${pages.length} page${pages.length === 1 ? '' : 's'} as PDF`);
    return;
  }

  if (opts.format === 'gif') {
    // GIFs are heavy: cap at 1200 px on the long side whatever the dpi asks for
    const files: { name: string; data: Uint8Array }[] = [];
    for (const r of regs) {
      const scale = Math.min(scaleFor(r, opts.dpi), 1200 / Math.max(r.w, r.h));
      const g = gifFrames(renderer, r, scale, paperPattern);
      if (!g) continue;
      files.push({ name: `${safe}-${r.name}.gif`, data: new Uint8Array(await makeGif(g.w, g.h, g.frames).arrayBuffer()) });
      await breathe();
    }
    if (!files.length) { toast(opts.scope === 'pages' ? 'No page has an animation' : 'Nothing animated on the canvas'); return; }
    if (files.length === 1) download(new Blob([files[0].data as BlobPart], { type: 'image/gif' }), files[0].name);
    else download(makeZip(files), `${safe}-gifs.zip`);
    toast(`Exported ${files.length} animated GIF${files.length === 1 ? '' : 's'}`);
    return;
  }

  // standalone HTML viewer: every region embedded (GIF where it animates), nothing to install
  const items: { name: string; src: string; w: number; h: number }[] = [];
  for (const r of regs) {
    const scale = Math.min(scaleFor(r, opts.dpi), 2000 / Math.max(r.w, r.h));
    const g = gifFrames(renderer, r, Math.min(scale, 1200 / Math.max(r.w, r.h)), paperPattern);
    if (g) {
      items.push({ name: r.name, src: await blobToDataURL(makeGif(g.w, g.h, g.frames)), w: r.w, h: r.h });
    } else {
      const blob = await toBlob(renderer.renderRegion(r, scale, { paperPattern }), 'image/png');
      if (blob) items.push({ name: r.name, src: await blobToDataURL(blob), w: r.w, h: r.h });
    }
    await breathe();
  }
  download(new Blob([viewerHtml(store.doc.name || 'Zine', store.doc.paper ?? '#F7F4EC', items)], { type: 'text/html' }), `${safe}.html`);
  toast(`Exported ${items.length} page${items.length === 1 ? '' : 's'} as an HTML viewer`);
}

const blobToDataURL = (b: Blob) => new Promise<string>((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result as string); fr.readAsDataURL(b); });

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function viewerHtml(title: string, paper: string, items: { name: string; src: string; w: number; h: number }[]): string {
  const single = items.length === 1;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  html, body { margin: 0; min-height: 100%; background: #2a2622; color: #f5efe6; font: 14px/1.4 -apple-system, system-ui, sans-serif; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 16px; position: sticky; top: 0; background: rgba(42,38,34,0.92); backdrop-filter: blur(8px); }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; }
  header .nav { display: ${single ? 'none' : 'flex'}; gap: 6px; align-items: center; }
  header button { background: transparent; color: inherit; border: 1px solid rgba(255,255,255,0.3); border-radius: 4px; padding: 4px 10px; font: inherit; cursor: pointer; }
  header button.on { background: rgba(255,255,255,0.15); }
  main { display: flex; flex-direction: column; align-items: center; gap: 28px; padding: 20px 12px 60px; }
  main.book { gap: 0; }
  main.book figure { display: none; }
  main.book figure.cur { display: block; }
  figure { margin: 0; max-width: min(100%, 900px); }
  figure img { display: block; width: 100%; height: auto; background: ${paper}; box-shadow: 0 6px 30px rgba(0,0,0,0.45); border-radius: 2px; }
  figcaption { text-align: center; opacity: 0.55; font-size: 12px; margin-top: 8px; }
  .zone { position: fixed; top: 60px; bottom: 0; width: 35%; cursor: pointer; display: none; }
  main.book ~ .zone { display: block; }
  .zone.l { left: 0; } .zone.r { right: 0; }
</style></head><body>
<header><h1>${escapeHtml(title)}</h1><div class="nav"><button id="scroll" class="on">Scroll</button><button id="book">Pages</button><span id="counter"></span></div></header>
<main id="main">
${items.map((it, i) => `<figure><img src="${it.src}" alt="${escapeHtml(it.name)}" width="${Math.round(it.w)}" height="${Math.round(it.h)}"><figcaption>${i + 1} / ${items.length}</figcaption></figure>`).join('\n')}
</main>
<div class="zone l" id="prev"></div><div class="zone r" id="next"></div>
<script>
(function(){
  var main=document.getElementById('main'),figs=[].slice.call(main.children),cur=0,counter=document.getElementById('counter');
  function show(i){cur=Math.max(0,Math.min(figs.length-1,i));figs.forEach(function(f,k){f.classList.toggle('cur',k===cur)});counter.textContent=main.classList.contains('book')?(cur+1)+' / '+figs.length:''}
  function mode(book){main.classList.toggle('book',book);document.getElementById('book').classList.toggle('on',book);document.getElementById('scroll').classList.toggle('on',!book);show(cur)}
  document.getElementById('book').onclick=function(){mode(true)};document.getElementById('scroll').onclick=function(){mode(false)};
  document.getElementById('next').onclick=function(){show(cur+1)};document.getElementById('prev').onclick=function(){show(cur-1)};
  document.addEventListener('keydown',function(e){if(!main.classList.contains('book'))return;if(e.key==='ArrowRight'||e.key===' ')show(cur+1);if(e.key==='ArrowLeft')show(cur-1)});
  show(0);
})();
</script>
</body></html>`;
}
