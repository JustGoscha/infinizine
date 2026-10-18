import './style.css';
import './fonts';
import { Camera, baseZoom } from './camera';
import { Store } from './store';
import { attachInput } from './input';
import { InputState } from './state';
import { Renderer } from './render';
import { buildUI } from './ui';
import { installCrashScreen } from './crash';
import { exportZine } from './export';
import { attachNativePen, nativeApp, postNative } from './native';

installCrashScreen();

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const ui = document.getElementById('ui') as HTMLElement;

const camera = new Camera();
const store = new Store();
const state = new InputState();

const renderer = new Renderer(canvas, store, camera, state);
attachNativePen(canvas); // iPad app: full-precision Pencil (before input.ts, which it feeds)
const input = attachInput(canvas, camera, store, state, () => renderer.invalidate());
input.setDropCache((id) => renderer.dropFromCache(id));
input.setIndex((id) => renderer.elementById(id), (r) => renderer.elementsNear(r));

const uiHooks = buildUI(ui, state, store, camera, () => renderer.invalidate(), {
  copy: () => input.copySelection(),
  cut: () => input.cutSelection(),
  paste: () => void input.pasteSmart(),
  exportZine: (opts) => exportZine(store, renderer, opts),
  pageThumb: (page, width) => renderer.renderPage(page, width / page.w),
});

// ?bench (web): compare the render strategies on the open zine, results on screen (nothing uploaded,
// the zine untouched; only the view moves, and it's put back)
if (!nativeApp && new URLSearchParams(location.search).has('bench')) {
  void store.ready.then(async () => {
    await new Promise((r) => setTimeout(r, 1500));
    const pre = document.createElement('pre');
    pre.style.cssText = 'position:fixed;left:8px;right:8px;bottom:8px;max-height:60vh;overflow:auto;z-index:99999;margin:0;padding:10px;font:11px/1.45 ui-monospace,monospace;white-space:pre-wrap;background:rgba(255,255,255,0.94);border:1px solid #999;border-radius:8px;user-select:text;-webkit-user-select:text';
    pre.textContent = `render bench — ${navigator.userAgent}\n${screen.width}×${screen.height} @${devicePixelRatio} · ${store.doc.elements.length} elements\n`;
    document.body.appendChild(pre);
    const cam = { x: camera.x, y: camera.y, zoom: camera.zoom };
    const { runRenderBench, runVectorBench, runStressBench } = await import('./pentest');
    const which = new URLSearchParams(location.search).get('bench') || 'all';
    const out = (m: string) => { pre.textContent += m + '\n'; };
    if (which === 'stress') await runStressBench(store, camera, renderer, out);
    if (which === 'vector' || which === 'all') await runVectorBench(store, camera, renderer, out);
    if (which === 'pan' || which === 'all' || which === '') await runRenderBench(store, camera, renderer, out);
    Object.assign(camera, cam);
    renderer.invalidate();
    pre.textContent += 'done — select and copy this text';
  });
}

if (nativeApp) {
  // iPad app: a .zine opened from Files / the share sheet
  // (after the library has loaded: an import during startup was overridden by the zine that was open last)
  (window as unknown as { __izineImport: (text: string) => Promise<boolean> }).__izineImport = (text) => store.ready.then(() => store.importJSON(text));
  // debug builds launched with -izineTest: the scripted Pencil benchmark
  if (nativeApp.test === 'pan' || nativeApp.test === 'vector' || nativeApp.test === 'all' || nativeApp.test === 'stress') {
    // every zine that exists before the import: the bench never touches (or deletes) these
    const existing = new Set(store.listDocs().map((m) => m.id));
    void import('./pentest').then((m) => m.runPanBench(store, camera, renderer, existing, nativeApp!.test!));
  }
  else if (nativeApp.test) void import('./pentest').then((m) => m.installPenTest(store, camera, state, canvas, nativeApp!.test!));
  // automation hooks (cross-play checks, simulator runs)
  (window as unknown as { __izineDebug: unknown }).__izineDebug = {
    exportZine: () => exportZine(store, renderer, { scope: 'all', format: 'zine', dpi: 150, paperPattern: false } as unknown as Parameters<typeof exportZine>[2]),
    summary: () => ({ name: store.doc.name, elements: store.doc.elements.length, pages: store.doc.pages.length, app: store.doc.app }),
    listDocs: () => store.listDocs().map((m) => `${m.id} "${m.name}" ${new Date(m.updated).toISOString()}`),
    deleteDocs: (ids: string[]) => { for (const id of ids) store.deleteDoc(id); return store.listDocs().length; },
  };
}

store.onChange = (info) => {
  if (nativeApp?.logStrokes) for (const el of info?.added ?? []) {
    if (el.kind === 'stroke') postNative({ type: 'log', msg: `stroke ${el.tool} ${el.points.length} pts · ${state.penInput}` });
  }
  renderer.docChanged(info); // targeted: only touched elements leave the caches
  uiHooks.docChanged();
};

// the document arrives from IndexedDB asynchronously
store.ready.then(() => {
  // First run: start with one A4 page waiting (the journaler's greeting)
  if (store.doc.pages.length === 0 && store.doc.elements.length === 0) {
    store.addPage({ w: 420, h: 594 }, { x: 0, y: 0 }); // A4
  }
  // Back where you left off in this zine; otherwise 100% centered on the first page
  if (!restoreCamera(store.docId)) {
    const page = store.doc.pages[0];
    camera.zoom = baseZoom();
    if (page) {
      camera.x = page.x + page.w / 2;
      camera.y = page.y + page.h / 2;
    }
  }
  state.updateCursor();
  renderer.clearCache();
  renderer.invalidate();
});

// ---- remember the camera per zine (restored on reload / when switching back) ----
const CAM_KEY = (id: string) => `infinizine-cam-${id}`;
function restoreCamera(id: string): boolean {
  try {
    const raw = localStorage.getItem(CAM_KEY(id));
    if (!raw) return false;
    const c = JSON.parse(raw) as { x: number; y: number; zoom: number };
    if (![c.x, c.y, c.zoom].every(Number.isFinite) || c.zoom <= 0) return false;
    camera.x = c.x; camera.y = c.y; camera.zoom = c.zoom;
    return true;
  } catch {
    return false;
  }
}
let camSaved = '';
let camDocId = store.docId;
setInterval(() => {
  if (store.docId !== camDocId) {
    // switched zines: land where that zine was last viewed, or on its first page
    camDocId = store.docId;
    if (!restoreCamera(camDocId)) {
      const page = store.doc.pages[0];
      camera.zoom = baseZoom();
      if (page) { camera.x = page.x + page.w / 2; camera.y = page.y + page.h / 2; }
    }
    state.updateCursor();
    renderer.invalidate();
    camSaved = '';
  }
  const snap = JSON.stringify({ x: Math.round(camera.x * 100) / 100, y: Math.round(camera.y * 100) / 100, zoom: camera.zoom });
  if (snap !== camSaved) {
    camSaved = snap;
    try { localStorage.setItem(CAM_KEY(camDocId), snap); } catch { /* ignore */ }
  }
}, 400);
window.addEventListener('resize', () => renderer.invalidate());
// canvas text is measured/drawn with web fonts: redraw once they've arrived
document.fonts?.ready.then(() => { renderer.clearCache(); renderer.invalidate(); });
// pressure playground changed the curves: every cached outline is stale
window.addEventListener('izine-restyle', () => { renderer.clearCache(); renderer.invalidate(); });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
// dev hook: poke at the live app from the console
(window as unknown as { __izine: unknown }).__izine = { store, renderer, camera, state };
