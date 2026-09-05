// Export every page as a PNG, bundled in a zip.
import type { Store } from './store';
import type { Renderer } from './render';
import { UNITS_PER_MM } from './types';
import { makeZip } from './zip';

const toast = (msg: string) => window.dispatchEvent(new CustomEvent('izine-toast', { detail: msg }));

export async function exportPagesPNG(store: Store, renderer: Renderer, dpi = 300) {
  const pages = [...store.doc.pages].sort((a, b) => a.order - b.order);
  if (!pages.length) { toast('No pages to export'); return; }
  toast(`Rendering ${pages.length} page${pages.length === 1 ? '' : 's'} at ${dpi} dpi…`);
  const files: { name: string; data: Uint8Array }[] = [];
  const safe = (store.doc.name || 'zine').replace(/[^\w\-]+/g, '_');
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    // px per world unit at the requested dpi, capped so the bitmap stays under 8k on a side
    let scale = dpi / 25.4 / UNITS_PER_MM;
    const longest = Math.max(page.w, page.h);
    if (longest * scale > 8192) scale = 8192 / longest;
    const canvas = renderer.renderPage(page, scale);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
    if (!blob) continue;
    files.push({ name: `${safe}-page-${String(i + 1).padStart(2, '0')}.png`, data: new Uint8Array(await blob.arrayBuffer()) });
    await new Promise((r) => setTimeout(r, 0)); // let the UI breathe between pages
  }
  const zip = makeZip(files);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(zip);
  a.download = `${safe}-pages.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast(`Exported ${files.length} page${files.length === 1 ? '' : 's'} as PNG`);
}
