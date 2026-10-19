// Canvas renderer: desk background, page frames, elements (with viewport
// culling + cached outlines), live stroke, lasso/selection overlays.

import { GLPencil, STAMP_FLOATS } from './glpencil';
import { WebGPUBackend } from './webgpu';
import { GpuEngine } from './gpuplan';
import { MetalBridge } from './metal';
import type { SceneSource } from './gpuscene';
import { SpatialGrid } from './spatial';
import { Camera, baseZoom } from './camera';
import { AnimArea, Element, FillShape, Page, Stroke, StrokePoint, TextBox } from './types';
import { elementBBox, bboxIntersects, LiveDenoiser, denoiseClosed, closeBlob, BBox } from './geometry';
import { strokeOutline, pencilOutlines, markerPaths, outlineToPath, densify, filterPressure, LiveOutliner, hasPressure, widthAt } from './outline';
import { easeP, easeTilt, pressure } from './pressure';
import { paintTextBox } from './text';
import { moveHandleRect, moveAllHandleRect, deleteHandleRect, eyeHandleRect, diceHandleRect, copyHandleRect, copyStyleHandleRect, pasteStyleHandleRect } from './handles';
import { FILL_TOOLS, type InputState } from './state';
import { animClock } from './clock';
import { Store, ChangeInfo } from './store';
import { formatLabel } from './formats';
import { patternTile, patternTileSize, patternCellSize, cellPath, cellMask, motifPath, motifDots, motifCoverage, motifRadius, isPixelPattern, PIXEL_CELL } from './patterns';
import { reportCrash } from './crash';
import { nativeApp, postNative, perfToNative } from './native';

type View = { x: number; y: number; w: number; h: number }; // camera viewport, world coords
export interface RegionOpts { time?: number; paperPattern?: boolean }
/** the keyframe showing at `tick` (clamped to the track's end) */
function frameAtTick(frames: { id: string; duration: number }[], tick: number): string | null {
  const total = frames.reduce((a, f) => a + f.duration, 0);
  if (!total) return null;
  let t = Math.min(tick, total - 1);
  for (const f of frames) { t -= f.duration; if (t < 0) return f.id; }
  return frames[frames.length - 1].id;
}
const TILE = 512; // static tile side, device px
const TILE_POOL = 16;
const DRAFT_PX = 8_000_000; // the draft (whole-zine overview) at most this many px (~32 MB)
const PREFETCH = 2; // rings of tiles built around the screen in spare time while the view moves
const PREFETCH_IDLE = 4; // … and once it rests (about a page around, at typical zooms)
const TILE_BUDGET = 160; // sharp tiles kept across levels (~1–2 MB each): beyond it, the farthest go // spare tile bitmaps kept for reuse (iOS is slow to allocate and slow to free canvases)
const FILL_RASTER_MAX = 4_000_000; // px: bigger pattern fills are filled directly
const FILL_RASTER_BUDGET = 8_000_000; // px across baked pattern fills away from the screen (~32 MB)
/** dot tones (sand, screentone): thousands of tiny dots — redrawn as paths in every tile they
 * touch they were the costliest thing on a page, so they're baked once per zoom too */
const isMotif = (id: string) => /^pattern:(tone|sand)-/.test(id);
/** WebKit records canvas drawing and replays it later in another process, so timing a draw
 * sees only the recording; reading a pixel makes it draw now and the clock honest. Elsewhere
 * (Chrome) a read would move the canvas off the GPU and change how it rasterises: skipped. */
const DEFERRED_CANVAS = /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg|Android/.test(navigator.userAgent);
const flushCanvas = (g: CanvasRenderingContext2D) => { if (DEFERRED_CANVAS) g.getImageData(0, 0, 1, 1); };
const PENCIL_RASTER_BUDGET = 12_000_000; // px across all cached pencil rasters (~48 MB); oldest go first
// `stale`: drawn with a stand-in raster, rebuild when there's time; `redo`: its content changed, rebuild now
// `born`: when it was first completed (fades in from then)
// `mips`: pre-shrunk copies (by size, per layer), made the first time it's drawn that small
interface Tile { i: number; j: number; back: HTMLCanvasElement; front: HTMLCanvasElement | null; stale: boolean; redo?: boolean; born?: number; mips?: Map<string, HTMLCanvasElement> }

/** How the static ink gets onto the screen — alternatives to compare per device (hardware differs:
 * a desktop can draw a whole screen of tiles in a frame, an iPad can't). */
export interface RenderOpts {
  /** when missing tiles get built: 'sync' all at once (stalls a frame, fills instantly) · 'sliced'
   * a budget per frame (never stalls, fills over frames) · 'adaptive' sync when this device's
   * measured tile cost says they fit in about a frame, else sliced */
  schedule: 'sync' | 'sliced' | 'adaptive';
  /** tiles at fixed zoom levels √2 apart (drawn slightly shrunk in between), kept for a couple of
   * levels — like map tiles: most zooms re-render nothing; off: tiles at the exact zoom */
  levels: boolean;
  /** new tiles fade in (~150 ms) instead of popping square by square */
  fade: boolean;
  /** while the view moves, keep the frame for smoothness; sharpen hard once it stops */
  motion: boolean;
  /** build ahead in the direction the view is moving */
  prefetchDir: boolean;
  /** the whole-zine overview under everything (what shows where no tile is ready) */
  draft: boolean;
  /** the paper's dot grid drawn live each frame (off: no grid) */
  grid: boolean;
  /** how: 'layer' a background layer behind the canvas moved by a compositor transform ·
   * 'position' the same layer moved by its background position · 'canvas' painted into the canvas */
  gridMode: 'layer' | 'position' | 'canvas';
  /** draw the screen straight from vectors instead of tiles when only cheap ink is in view and it
   * fits the frame on this device ('auto'), never, or always */
  vector: 'auto' | 'never' | 'always';
  /** where sharp tiles meet ones not ready yet, blend over a soft band instead of a hard square
   * edge (off: each tile fades in as a square) */
  feather: boolean;
  /** what draws the still ink: 'canvas' the 2D renderer (tiles / vectors, all of the above) ·
   * 'webgpu' everything on the GPU every frame (see webgpu.ts), where the browser has WebGPU ·
   * 'metal' the same, drawn by a native Metal view in the iPad app (see metal.ts) */
  engine: 'canvas' | 'webgpu' | 'metal';
  /** animated areas' keyframes from bitmaps rendered once (and ahead), instead of redrawn every frame */
  frames: boolean;
}
export const RENDER_DEFAULTS: RenderOpts = { schedule: 'adaptive', levels: true, fade: true, motion: true, prefetchDir: true, draft: true, grid: true, gridMode: 'canvas', vector: 'auto', feather: true, engine: 'canvas', frames: true };
const FADE_MS = 300;
const FRAME_BITMAP_BUDGET = 16_000_000; // px of keyframe bitmaps kept (~64 MB)
/** elements in view past which the view counts as crowded: the 2D renderer stops listing them per
 * frame (it can't draw that many straight from vectors anyway), the GPU one draws its far tiles */
const CANVAS_CROWD = 3000;
const GPU_CROWD = 5000;
/** coverage-mask px per tile (feathering): the soft edge is two of them, a quarter tile */
const FEATHER_N = 8;
/** each screen tile's coverage (row-major from the top-left screen tile at x, y; T px per tile) and the band to feather */
interface Coverage { v: Float32Array; cols: number; rows: number; x: number; y: number; T: number; rect: { x: number; y: number; w: number; h: number } }
/** a new tile's opacity `age` ms after it was built: eased in and out, so detail arrives softly */
const fadeAlpha = (age: number) => { const u = Math.max(0, Math.min(1, age / FADE_MS)); return u * u * (3 - 2 * u); };
/** a tile being built a slice per frame: its elements by layer, where it got to (element k of
 * pass 0 = back, 1 = front; within a long pencil stroke, the next stamp) */
interface TileJob {
  i: number; j: number; back: HTMLCanvasElement; front: HTMLCanvasElement | null; spent: number;
  layers: [Element[], Element[]]; pass: number; k: number;
  stamp: { next: number; state: { sinceX: number; sinceY: number; skipped: number } } | null;
  stale: boolean;
}
/** `jobs`: its tiles still being built; `draft`: the quick low-detail layer (see drawStatic) */
interface TileSet { content: string; zoom: number; s: number; tiles: Map<string, Tile>; jobs: Map<string, TileJob>; draft?: boolean }
interface StampOpts {
  minSpacing?: number; // world units: closer stamps merge (alpha-compensated)
  cache?: boolean; // keep the stamp list (committed strokes)
  until?: number; // performance.now() deadline: stop there and return where to resume
  limit?: number; // or stop at this stamp index
  state?: { sinceX: number; sinceY: number; skipped: number }; // the merging, carried across resumes
  cull?: View; // world rect: stamps outside it aren't drawn (a tile takes only its own)
}
/** a pencil raster being stamped a slice per frame */
interface PencilJob { el: Stroke; bucket: number; bbox: BBox; c: HTMLCanvasElement; g: CanvasRenderingContext2D; next: number; state: { sinceX: number; sinceY: number; skipped: number } }
interface CacheEntry { solid?: boolean; zoomFree?: boolean; path: Path2D; bbox: BBox; passes?: Path2D[]; core?: Path2D; detail: number }

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private cache = new Map<string, CacheEntry>();
  // Static tiles: everything committed and not animated, rasterised in 512-device-px
  // tiles anchored to the world at the current zoom. A pan only moves the tiles
  // (blitted at whole device pixels) and builds the few that scroll into view; a
  // ring around the screen is prefetched in idle frames. Each tile has two bitmaps:
  // `back` holds paper + the 'back' layer, `front` the rest (null when empty), so a
  // paint-behind live stroke can slip between them without repainting anything.
  private tileSet: TileSet | null = null;
  /** other zoom levels' tiles (most recent first): kept so zooming back finds them, and drawn
   * (scaled) into the gaps while the current level's tiles build */
  private levels: TileSet[] = [];
  /** The element index (kept up to date on changes, never rebuilt per frame): the still ink in a
   * spatial grid, each element's drawing order, lookups by id, and the animated ink by keyframe
   * and by area — so a frame touches only what it draws, however big the zine. */
  private ix = {
    doc: null as Element[] | null, // the elements array it was built from (a zine switch replaces it)
    stale: true,
    still: new SpatialGrid<Element>(),
    order: new Map<string, number>(), // drawing order (kept for deleted ids: an undo puts them back in place)
    next: 0,
    byId: new Map<string, Element>(),
    byFrame: new Map<string, Element[]>(),
    byArea: new Map<string, Element[]>(), // timed live-ink strokes, by area
  };
  private index() {
    const ix = this.ix, els = this.store.doc.elements;
    if (!ix.stale && ix.doc === els) return ix;
    ix.doc = els; ix.stale = false;
    ix.still.clear(); ix.order.clear(); ix.byId.clear(); ix.byFrame.clear(); ix.byArea.clear();
    els.forEach((el, k) => {
      ix.order.set(el.id, k);
      ix.byId.set(el.id, el);
      this.indexEl(el);
    });
    ix.next = els.length;
    return ix;
  }
  private indexEl(el: Element) {
    const ix = this.ix;
    if (el.frame) { let l = ix.byFrame.get(el.frame); if (!l) ix.byFrame.set(el.frame, (l = [])); l.push(el); }
    else if (el.kind === 'stroke' && el.area) { let l = ix.byArea.get(el.area); if (!l) ix.byArea.set(el.area, (l = [])); l.push(el); }
    else ix.still.insert(el, this.elBox(el));
  }
  /** After a local change: re-index just the touched elements (`present`: the doc's current
   * elements with those ids). Animated ones rebuild their (small) lists in order. */
  private reindex(ids: string[], present: Map<string, Element>) {
    const ix = this.ix;
    if (ix.stale || ix.doc !== this.store.doc.elements) { ix.stale = true; return; }
    let animated = false;
    for (const id of ids) {
      const old = ix.byId.get(id);
      if (old) {
        if (old.frame || (old.kind === 'stroke' && old.area)) animated = true;
        else ix.still.remove(old);
        ix.byId.delete(id);
      }
      const el = present.get(id);
      if (!el) continue;
      if (!ix.order.has(id)) ix.order.set(id, ix.next++); // (appended: drawn on top)
      ix.byId.set(id, el);
      if (el.frame || (el.kind === 'stroke' && el.area)) animated = true;
      else ix.still.insert(el, this.elBox(el));
    }
    if (animated) {
      ix.byFrame.clear(); ix.byArea.clear();
      for (const el of this.store.doc.elements) if (el.frame || (el.kind === 'stroke' && el.area)) this.indexEl(el);
    }
  }
  /** For input (eraser, hit tests): elements near a world rect — the still ink there (hidden ones
   * too) plus every animated element (few; the eraser filters by frame). */
  elementsNear(r: View): Element[] {
    const ix = this.index();
    const out = this.stillIn(r, false);
    for (const l of ix.byFrame.values()) out.push(...l);
    for (const l of ix.byArea.values()) out.push(...l);
    return out;
  }
  elementById(id: string): Element | undefined { return this.index().byId.get(id); }

  /** The still ink intersecting `r`, in drawing order (hidden and dragged ones left out). */
  private stillIn(r: View, skipHidden = true): Element[] {
    const ix = this.index();
    const out: Element[] = [];
    const hidden = this.input.hidden;
    ix.still.query({ minX: r.x, minY: r.y, maxX: r.x + r.w, maxY: r.y + r.h }, (el) => {
      if (skipHidden && hidden.has(el.id)) return;
      const f = this.floating.get(el.id);
      if (f && !f.landing) return;
      out.push(el);
    });
    const order = ix.order;
    out.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    return out;
  }
  /** elements being dragged: out of the tiles, drawn as a bitmap rendered once at the drag's start
   * and moved with them; `landing` once dropped, until the tiles under them have them again */
  private floating = new Map<string, { snap: HTMLCanvasElement | null; x: number; y: number; s: number; ax: number; ay: number; w: number; h: number; touched: number; landing: boolean }>();
  // ---- the GPU engine (opts.engine 'webgpu') ----
  private gpu: GpuEngine | null = null;
  private gpuState: 'off' | 'starting' | 'on' | 'failed' = 'off';
  private gpuKind: 'webgpu' | 'metal' | null = null;
  private gpuCanvas: HTMLCanvasElement | null = null;
  private gpuShown = false;
  private gpuHidden = new Set<string>();
  /** what the GPU compiler borrows from this renderer: the Pencil engine, pixel cells, images */
  private sceneSource: SceneSource & { nibs(): HTMLCanvasElement[] } = {
    stamps: (el, put) => { this.eachStamp(el, el.opacity, 0, { cache: true }, put); },
    cellImage: (el) => this.cellImage(el),
    image: (src) => this.image(src),
    nibs: () => { const n = this.nibs('#000000'); return [...n.grain, ...n.dense]; },
  };
  /** True when the GPU draws the still ink this frame (starting it the first time it's asked for). */
  private gpuActive(): boolean {
    const e = this.opts.engine;
    const kind = this.canvas.id !== 'canvas' ? null : e === 'webgpu' ? 'webgpu' : e === 'metal' && nativeApp ? 'metal' : null;
    if (kind !== this.gpuKind && this.gpuState !== 'starting') {
      // switched: the old engine goes, the new one starts
      if (this.gpu) {
        this.gpu.drop();
        const b = this.gpu.backend as { stop?(): void; destroy?(): void };
        b.stop?.(); b.destroy?.();
        this.gpu = null;
      }
      this.gpuState = 'off';
      this.gpuKind = kind;
      this.setGpuShown(false);
    }
    if (kind && this.gpuState === 'off') {
      this.gpuState = 'starting';
      if (kind === 'metal') {
        this.gpu = new GpuEngine(new MetalBridge(this.sceneSource), this.sceneSource);
        this.gpuState = 'on';
      } else {
        if (!this.gpuCanvas) {
          const c = document.createElement('canvas');
          c.id = 'gpu';
          c.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;display:none';
          this.canvas.parentElement!.insertBefore(c, this.canvas);
          this.gpuCanvas = c;
        }
        void WebGPUBackend.create(this.gpuCanvas, this.sceneSource).then((b) => {
          this.gpu = b ? new GpuEngine(b, this.sceneSource) : null;
          this.gpuState = b ? 'on' : 'failed';
          this.invalidate();
        });
      }
    }
    const on = !!kind && this.gpuState === 'on' && !!this.gpu?.ok;
    this.setGpuShown(on);
    return on;
  }
  private setGpuShown(on: boolean) {
    if (on === this.gpuShown) return;
    this.gpuShown = on;
    // webgpu: its canvas under this one · metal: the native view under the whole (now see-through) page
    if (this.gpuCanvas) this.gpuCanvas.style.display = on && this.gpuKind === 'webgpu' ? 'block' : 'none';
    document.documentElement.classList.toggle('native-gpu', on && this.gpuKind === 'metal');
    if (!on) this.gpu?.drop(); // (the 2D renderer takes over: free the GPU copies)
  }
  /** Which engine is drawing now (for the benchmark and the settings readout). */
  engineNow(): string { return this.gpuShown ? this.gpuKind ?? 'canvas' : 'canvas'; }

  /** The GPU engine's memory and draw counts (benchmark). */
  gpuMemory(): string { return this.gpu?.memory() ?? 'no gpu'; }

  opts: RenderOpts = (() => {
    let o: RenderOpts;
    try { o = { ...RENDER_DEFAULTS, ...JSON.parse(localStorage.getItem('izine-render-opts') ?? '{}') }; } catch { o = { ...RENDER_DEFAULTS }; }
    if (nativeApp?.engine) o.engine = nativeApp.engine as RenderOpts['engine']; // (app launched with -izineEngine)
    return o;
  })();
  /** ms a sharp tile takes to build here (smoothed): what 'adaptive' scheduling goes by */
  private tileCost = 16;
  /** vector mode: on now (hysteresis), and what one cheap element costs to draw directly (ms, learnt) */
  private vectorMode = false;
  private vecCost = DEFERRED_CANVAS ? 0.025 : 0.003;
  private vecFrames = 0;
  private tileCostS = 4; // the tile scale it was measured at (a tile further out holds (s₀/s)² as much)
  private syncBuilt = 0; // sharp tiles built all at once last frame (their real cost shows in the next frame's interval)
  private camPrev = { x: 0, y: 0, zoom: 0, t: 0 };
  private movingUntil = 0;
  private vel = { x: 0, y: 0 }; // screen px per ms the view is moving (content moves the other way)
  /** the draft: an overview of the whole zine at one fixed, modest scale with light detail (pencil
   * outlines in a graphite tone, dot tones as their tint), built once in the background and kept
   * up to date — it doesn't depend on the zoom, so any pan or zoom finds it ready: what shows
   * where a sharp tile isn't (rather than bare paper), until the sharp tiles cover it */
  private draft: TileSet | null = null;
  private draftExtent: { key: string; box: BBox | null; s: number } = { key: '', box: null, s: 1 };
  /** the still ink's extent and the draft's scale (a power of two, so it changes rarely as the zine grows) */
  private draftScale(): { box: BBox | null; s: number } {
    const key = `${this.tileGen}|${this.store.doc.elements.length}`;
    if (this.draftExtent.key === key) return this.draftExtent;
    let box: BBox | null = null;
    for (const el of this.store.doc.elements) {
      if (!this.isStill(el)) continue;
      const b = this.elBox(el);
      box = box ? { minX: Math.min(box.minX, b.minX), minY: Math.min(box.minY, b.minY), maxX: Math.max(box.maxX, b.maxX), maxY: Math.max(box.maxY, b.maxY) } : { ...b };
    }
    const area = box ? Math.max(1, (box.maxX - box.minX) * (box.maxY - box.minY)) : 1;
    const s = Math.pow(2, Math.floor(Math.log2(Math.min(2, Math.sqrt(DRAFT_PX / area)))));
    this.draftExtent = { key, box, s };
    return this.draftExtent;
  }
  private tilePool: HTMLCanvasElement[] = [];
  private tileGen = 0; // bumped whenever committed ink changes in a way tiles can't patch
  /** device px per world unit while a tile is being painted (pattern fills then come from fillRasters) */
  private tileScale: number | null = null;
  // non-solid pattern fills (hatching, lines, waves…) baked once per zoom at device
  // resolution, aligned to the device pixel grid: tiles blit them instead of
  // re-filling a rotated pattern per tile. LRU by insertion order.
  private fillRasters = new Map<string, { c: HTMLCanvasElement; s: number; x: number; y: number }>();
  private fillRasterPx = 0;
  private pencilRasterPx = 0;
  private boxCache = new Map<string, BBox>(); // element bboxes (zoom-independent) before their outline exists
  /** world rect of the screen + the prefetch ring: rasters of strokes in it are never evicted */
  private keepRect: View | null = null;
  /** each still element's box as last painted into the tiles: where to repaint when it changes or hides */
  private tileBoxes = new Map<string, BBox>();
  /** the eraser's hidden set as the tiles last saw it */
  private tileHidden = new Set<string>();
  /** rAF interval (ms), smoothed: 8.3 at 120 Hz (the iPad app), 16.7 at 60 Hz (Safari) */
  private framePeriod = 16.7;
  /** pencil stamps drawn per ms, measured with the drawing forced to finish (WebKit replays canvas
   * drawing later in another process, so the clock alone sees only the recording) */
  private stampRate = 20; // sharp tiles (where most of a stroke's stamps fall outside and cost nothing)
  private draftStampRate = 20; // draft tiles: bigger, so most stamps get drawn
  private lastTileEl: Element | null = null;
  private lastTileDraft = false;
  private lastFrameT = 0;
  // pencil stamp lists are zoom-independent: computed once per stroke
  private stampCache = new Map<string, { n: number; stamps: { x: number; y: number; p: number; a?: number }[] }>();
  // zoom gestures: keep drawing stale rasters (scaled) and rebuild only when the
  // zoom settles, a few milliseconds per frame, so pinch-zoom stays fluid
  private lastZoom = 0;
  private lastZoomChangeAt = 0;
  private rasterBudgetUntil = 0; // performance.now() deadline for raster builds this frame
  private rastersPending = false;
  private fillPatterns = new Map<string, CanvasPattern>();
  /** world-anchored fill pattern (screentone / dither) at the current zoom bucket */
  private fillPattern(id: string, color: string, angle = 0): CanvasPattern | string {
    const T = patternTileSize(id);
    const dpr = window.devicePixelRatio || 1;
    const px = Math.max(8, Math.min(1024, Math.round(T * this.detail() * baseZoom() * dpr)));
    const key = `${id}|${color}|${px}`;
    let pat = this.fillPatterns.get(key);
    if (!pat) {
      const made = this.ctx.createPattern(patternTile(id, color, px), 'repeat');
      if (!made) return color;
      pat = made;
      this.fillPatterns.set(key, pat);
    }
    // px tile → T world units, rotated, anchored to the world origin (set per use: the object is shared)
    pat.setTransform(new DOMMatrix().rotate(angle).scale(T / px));
    return pat;
  }
  private liveSmooth = new LiveDenoiser(); // vector live stroke
  private liveOutliner = new LiveOutliner(); // chunked outline of the live stroke
  private lastInkAt = -1e9; // wall-clock ms of the last frame with a live stroke / lasso
  private pausedClock = false; // this renderer holds the animation clock paused
  /** the deselected areas, frozen at the paused clock, as one bitmap (built once per pause + camera) */
  private animBake: { canvas: HTMLCanvasElement; key: string } = { canvas: document.createElement('canvas'), key: '' };
  // performance readout: input→paint latency (event timestamp → end of the frame that showed it), live cost, frame cost
  private perfLat: number[] = [];
  private perfLive = 0;
  private perfFrame = 0;
  private perfText = '';
  private perfAt = 0;
  private livePencilSmooth = new LiveDenoiser(); // pencil live stroke (separate: stamped incrementally)
  private dirty = true;
  private fps = 0;
  private fpsFrames = 0;
  private fpsT = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private store: Store,
    private camera: Camera,
    private input: InputState,
  ) {
    this.ctx = canvas.getContext('2d')!;
    // the settings' renderer switch
    if (canvas.id === 'canvas') window.addEventListener('izine-engine', (e) => { this.opts.engine = (e as CustomEvent).detail; this.invalidate(); });
    const loop = () => {
      this.frame(performance.now());
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  /** One tick of the render loop (rAF-driven; callable directly for tests). */
  frame(t: number) {
    const dt = t - this.lastFrameT;
    this.lastFrameT = t;
    if (dt > 4 && dt < 40) this.framePeriod += (dt - this.framePeriod) * 0.1;
    // a frame that built tiles all at once and came late: that's what a tile really costs here
    // (the clock alone sees only the recording where the browser draws later — Chrome, WebKit)
    if (this.syncBuilt && dt > 0 && dt < 2000) {
      const real = Math.max(0, dt - this.framePeriod) / this.syncBuilt;
      this.tileCost += (real - this.tileCost) * (real > this.tileCost ? 0.7 : 0.2);
    }
    this.syncBuilt = 0;
    // fps debug: rAF cadence — drops when the main thread struggles
    this.fpsFrames++;
    if (t - this.fpsT >= 500) {
      this.fps = Math.round((this.fpsFrames * 1000) / (t - this.fpsT));
      this.fpsFrames = 0;
      this.fpsT = t;
    }
    // Playback pauses while ink is being laid down and for a moment after, unless the
    // edited area is deliberately playing (watching / recording live lines): the pen gets
    // the whole frame budget and the frozen areas are blitted from a bitmap (see draw).
    const inking = !!this.input.live || !!this.input.lasso;
    if (inking) this.lastInkAt = t;
    // (the clock is shared; only the renderer that paused it resumes it — the playground's
    // scratch renderer must not wake it up while the main canvas is being inked)
    const wantPause = !this.input.playingAreas && (inking || t - this.lastInkAt < 200) && this.anyAreaInView();
    if (wantPause && !animClock.paused) { animClock.pause(); this.pausedClock = true; }
    else if (!wantPause && this.pausedClock) { this.pausedClock = false; animClock.resume(); this.dirty = true; }
    // areas animate continuously — but only the ones actually in view cost frames
    const playing = !animClock.paused && this.anyAreaInView();
    if (this.dirty || this.input.live || playing) {
      this.dirty = false;
      try {
        this.draw();
      } catch (err) {
        // keep the loop alive: drop the stroke being drawn (the usual culprit),
        // flush caches, and show what happened
        this.input.live = null;
        this.clearCache();
        reportCrash('render', err);
      }
    }
  }

  invalidate() { this.dirty = true; }

  /** ms per frame for building tiles / rasters: about a third of the frame, so the
   * frame itself (areas, the live stroke) still fits — 120 Hz frames get half of 60 Hz's */
  private buildBudget(): number { return Math.max(2.5, Math.min(6, this.framePeriod * 0.36)); }

  // decoded-image cache for image elements
  private imageCache = new Map<string, HTMLImageElement>();
  private image(src: string): HTMLImageElement {
    let img = this.imageCache.get(src);
    if (!img) {
      img = new Image();
      img.onload = () => this.invalidate();
      img.src = src;
      this.imageCache.set(src, img);
    }
    return img;
  }
  /** An element is being moved / resized in place (drags): it floats — see `floating`. ('*': everything changed.) */
  dropFromCache(id: string) {
    if (id === '*') { this.clearCache(); this.invalidate(); return; }
    const el = this.index().byId.get(id);
    if (!el) return;
    if (this.gpuShown && this.gpu) {
      // the GPU draws it where it is now: a move just shifts its geometry, a reshape compiles it again
      this.gpu.touch(el);
      this.dropElementCaches(id);
      this.invalidate();
      return;
    }
    const f = this.floating.get(id);
    if (f && !f.landing) {
      f.touched = performance.now();
      // resized (text box / image handles), not just moved: render it again — those are cheap
      if (el.kind === 'text' || el.kind === 'image') {
        const b = elementBBox(el);
        if (Math.abs(b.maxX - b.minX - f.w) > 0.01 || Math.abs(b.maxY - b.minY - f.h) > 0.01) {
          if (f.snap) f.snap.width = f.snap.height = 0;
          const a = anchorOf(el);
          Object.assign(f, this.snapshot(el), { ax: a.x, ay: a.y, w: b.maxX - b.minX, h: b.maxY - b.minY });
        }
      }
      this.invalidate();
      return;
    }
    // drag starts (or picks up again mid-landing): render it once, take it out of the tiles
    const old = this.tileBoxes.get(id);
    this.dropElementCaches(id);
    const snap = this.snapshot(el);
    const a = anchorOf(el), bb = elementBBox(el);
    this.floating.set(id, { ...snap, ax: a.x, ay: a.y, w: bb.maxX - bb.minX, h: bb.maxY - bb.minY, touched: performance.now(), landing: false });
    this.redoTiles([old ?? this.elBox(el)]);
    this.invalidate();
  }

  private dropElementCaches(id: string) {
    this.cache.delete(id); this.boxCache.delete(id); this.dotCache.delete(id); this.dropDotBake(id); this.dropCellImage(id);
    this.dropPencilRaster(id); this.dropPencilJob(id); this.stampCache.delete(id); this.dropFillRaster(id);
  }

  /** One element rendered alone into a bitmap at screen resolution (capped), for moving it around. */
  private snapshot(el: Element): { snap: HTMLCanvasElement | null; x: number; y: number; s: number } {
    const b = elementBBox(el);
    const pad = 4;
    const x = b.minX - pad, y = b.minY - pad, w = b.maxX - b.minX + 2 * pad, h = b.maxY - b.minY + 2 * pad;
    let sc = this.camera.zoom * (window.devicePixelRatio || 1);
    while ((w * sc > 4096 || h * sc > 4096) && sc > 1 / 64) sc /= 2;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w * sc));
    c.height = Math.max(1, Math.ceil(h * sc));
    const g = c.getContext('2d');
    if (!g) return { snap: null, x, y, s: sc };
    const saved = this.ctx;
    this.ctx = g;
    this.tileScale = sc;
    try {
      g.setTransform(sc, 0, 0, sc, -x * sc, -y * sc);
      this.paintElement(el, { x, y, w, h }, this.camera.zoom, 1);
    } finally {
      this.ctx = saved;
      this.tileScale = null;
    }
    return { snap: c, x, y, s: sc };
  }

  /** The floating elements, each its bitmap moved by how far it's been dragged (main ctx, world transform). */
  private drawFloating() {
    const ctx = this.ctx;
    for (const [id, f] of this.floating) {
      const el = this.index().byId.get(id);
      if (!el || !f.snap) continue;
      const a = anchorOf(el);
      ctx.save();
      ctx.globalAlpha = 1;
      // (a fill overprints like it does in the tiles)
      ctx.globalCompositeOperation = el.kind === 'fill' ? el.blend ?? (el.pattern ? 'multiply' : 'source-over') : 'source-over';
      ctx.drawImage(f.snap, f.x + a.x - f.ax, f.y + a.y - f.ay, f.snap.width / f.s, f.snap.height / f.s);
      ctx.restore();
    }
  }

  /** Dragging stopped (dropped, or no move for a while): back into the tiles; the bitmap stays up
   * until the tiles under it are rebuilt, then goes. */
  private updateFloating(now: number, noTiles = false) {
    if (!this.floating.size) return;
    const set = this.tileSet;
    if (noTiles) {
      // vector mode draws them straight from the doc once dropped: no tiles to wait for
      for (const [id, f] of this.floating) {
        if (!f.landing && now - f.touched <= 300) continue;
        const el = this.index().byId.get(id);
        if (el) { const a = anchorOf(el); if (a.x !== f.ax || a.y !== f.ay) this.dropElementCaches(id); if (this.isStill(el)) this.ix.still.insert(el, this.elBox(el)); }
        if (f.snap) f.snap.width = f.snap.height = 0;
        this.floating.delete(id);
        this.redoTiles(el ? [this.elBox(el)] : []);
      }
      this.dirty = true;
      return;
    }
    for (const [id, f] of this.floating) {
      const el = this.index().byId.get(id);
      if (!el) { this.floating.delete(id); continue; }
      if (!f.landing && now - f.touched > 300) {
        f.landing = true;
        const a = anchorOf(el);
        if (a.x !== f.ax || a.y !== f.ay) this.dropElementCaches(id); // (moved: its outlines are stale)
        if (this.isStill(el)) this.ix.still.insert(el, this.elBox(el)); // (re-filed where it is now)
        this.redoTiles([this.elBox(el)]);
      }
      if (f.landing && set) {
        const b = this.elBox(el);
        let ready = true;
        for (const t of set.tiles.values()) if (t.redo && bboxIntersects(b, this.tileView(t.i, t.j, set.s))) { ready = false; break; }
        if (ready) for (const j of set.jobs.values()) if (bboxIntersects(b, this.tileView(j.i, j.j, set.s))) { ready = false; break; }
        if (ready) { if (f.snap) f.snap.width = f.snap.height = 0; this.floating.delete(id); }
      }
    }
    this.dirty = true;
  }
  clearCache() {
    this.cache.clear(); this.stampCache.clear(); this.boxCache.clear(); this.dotCache.clear();
    for (const id of [...this.dotBakes.keys()]) this.dropDotBake(id);
    for (const id of [...this.cellImages.keys()]) this.dropCellImage(id);
    for (const id of [...this.pencilCache.keys()]) this.dropPencilRaster(id);
    for (const id of [...this.pencilJobs.keys()]) this.dropPencilJob(id);
    for (const id of [...this.fillRasters.keys()]) this.dropFillRaster(id);
    for (const fid of [...this.frameBitmaps.keys()]) this.dropFrameBitmap(fid);
    this.gpu?.drop();
    this.tileGen++;
  }

  /** Document changed: drop only the touched elements' caches; keep the static
   * tiles when the change is a fresh append we can paint on top of. */
  docChanged(info?: ChangeInfo) {
    this.animBake.key = ''; // frozen areas may have changed
    // keyframe bitmaps of the frames touched (before and after the change)
    if (!info) { for (const fid of [...this.frameBitmaps.keys()]) this.dropFrameBitmap(fid); }
    else {
      for (const id of info.ids) { const f = this.ix.byId.get(id)?.frame; if (f) this.dropFrameBitmap(f); }
      for (const el of info.added ?? []) if (el.frame) this.dropFrameBitmap(el.frame);
    }
    if (!info) { this.ix.stale = true; this.clearCache(); this.invalidate(); return; }
    // where the touched elements were painted, before their caches go
    const before = info.ids.map((id) => this.tileBoxes.get(id));
    for (const id of info.ids) { const f = this.floating.get(id); if (f) f.landing = true; } // (dropped: back into the tiles)
    for (const id of info.ids) { this.cache.delete(id); this.boxCache.delete(id); this.dotCache.delete(id); this.dropDotBake(id); this.dropCellImage(id); this.dropPencilRaster(id); this.dropPencilJob(id); this.stampCache.delete(id); this.dropFillRaster(id); }
    // the index, from the fresh geometry (full rebuild for changes that reorder)
    if (!info.local) this.ix.stale = true;
    else {
      const present = new Map<string, Element>();
      if (info.added) for (const el of info.added) present.set(el.id, el);
      else if (info.ids.length) { const want = new Set(info.ids); for (const el of this.store.doc.elements) if (want.has(el.id)) present.set(el.id, el); }
      this.reindex(info.ids, present);
    }
    if (this.gpu) {
      // (a pure move keeps its GPU geometry; a pattern fill re-anchors its pattern to the world)
      const ix = this.index();
      for (const id of info.ids) {
        const el = ix.byId.get(id);
        if (el) { this.gpu.touch(el, true); this.gpu.staleRects([this.elBox(el)]); } else this.gpu.drop([id]);
      }
      // (re-ordering needs nothing: the order is the index's; new faces need new text bitmaps)
      if (!info.local) this.gpu.drop(this.store.doc.elements.filter((e) => e.kind === 'text').map((e) => e.id));
    }
    const set = this.tileSet;
    const current = !!set && set.content === this.contentKey() && set.s === this.levelFor(this.camera.zoom);
    const canAppend = current && info.added && info.added.length && info.added.every((el) => this.isStill(el));
    if (canAppend) {
      const boxes = info.added!.map((el) => this.elBox(el));
      this.dropTileJobs(boxes); // unfinished tiles would miss it
      this.paintOntoTiles(info.added!);
      for (const t of this.draft?.tiles.values() ?? []) if (boxes.some((b) => bboxIntersects(b, this.tileView(t.i, t.j, this.draft!.s)))) t.redo = true;
    } else if (current && info.local) {
      // repaint only the tiles under the touched elements, where they were and where they are now
      const ids = new Set(info.ids);
      const boxes: BBox[] = [];
      info.ids.forEach((id, k) => {
        const b = before[k];
        if (b && !this.tileHidden.has(id)) boxes.push(b); // erased: those tiles already left it out
        this.tileHidden.delete(id);
        this.tileBoxes.delete(id);
      });
      for (const id of ids) {
        const el = this.ix.byId.get(id);
        if (el && this.isStill(el) && !this.input.hidden.has(el.id)) boxes.push(this.elBox(el));
      }
      this.redoTiles(boxes);
    } else {
      this.tileGen++;
    }
    this.invalidate();
  }

  /** Mark the current tiles under `boxes` for rebuilding this frame (their stand-ins would be stale too). */
  private redoTiles(boxes: BBox[]) {
    const set = this.tileSet;
    if (!set || !boxes.length) return;
    this.dropTileJobs(boxes);
    this.dropLevelTiles(boxes);
    for (const ts of [set, this.draft]) {
      if (!ts) continue;
      for (const t of ts.tiles.values()) {
        const view = this.tileView(t.i, t.j, ts.s);
        if (boxes.some((b) => bboxIntersects(b, view))) t.redo = true;
      }
    }
  }

  private isStill(el: Element): boolean {
    return !el.frame && !(el.kind === 'stroke' && el.area);
  }

  private areaInView(a: { x: number; y: number; w: number; h: number }, view: View): boolean {
    // grown by half its size: live ink may spill outside the frame when not clipped
    const gx = a.w * 0.5, gy = a.h * 0.5;
    return bboxIntersects({ minX: a.x - gx, minY: a.y - gy, maxX: a.x + a.w + gx, maxY: a.y + a.h + gy }, view);
  }
  private anyAreaInView(): boolean {
    const areas = this.store.doc.areas;
    if (!areas.length) return false;
    const view = this.camera.viewport(this.canvas.clientWidth, this.canvas.clientHeight);
    return areas.some((a) => this.areaInView(a, view));
  }

  private focusAreaId(): string | null {
    return this.input.activeAreaId && !this.input.presenting ? this.input.activeAreaId : null;
  }
  /** what the static tiles depend on besides the camera */
  private contentKey(): string {
    const d = this.store.doc;
    // (not the focused area: the dimming around it is applied when the tiles are blitted)
    return [this.tileGen, window.devicePixelRatio || 1, d.paper ?? '', d.pattern ?? ''].join('|');
  }
  /** content + camera + viewport: what a screen-sized bitmap depends on */
  private viewKey(): string {
    const { camera, canvas } = this;
    return [this.contentKey(), camera.x, camera.y, camera.zoom, canvas.clientWidth, canvas.clientHeight].join('|');
  }
  /** World → device px for the screen: zoom × dpr, offset rounded to whole device
   * pixels so the static tiles (pixel-aligned) and everything drawn live agree exactly. */
  private worldMatrix(vw: number, vh: number, dpr: number): { s: number; ox: number; oy: number } {
    const { camera } = this;
    const s = camera.zoom * dpr;
    return { s, ox: Math.round((vw * dpr) / 2 - camera.x * s), oy: Math.round((vh * dpr) / 2 - camera.y * s) };
  }

  /** Render one page to an offscreen canvas (see renderRegion). */
  renderPage(page: Page, scale: number, opts: RegionOpts = {}): HTMLCanvasElement {
    return this.renderRegion({ x: page.x, y: page.y, w: page.w, h: page.h }, scale, opts);
  }

  /** Render a world rectangle to an offscreen canvas at `scale` px per world
   * unit: paper (optionally with its dot/grid pattern), every still element and
   * the animations — at `time` seconds into playback, or, without a time, each
   * layer's first keyframe with live ink drawn complete. */
  renderRegion(rect: View, scale: number, opts: RegionOpts = {}): HTMLCanvasElement {
    const w = Math.max(1, Math.round(rect.w * scale)), h = Math.max(1, Math.round(rect.h * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d')!;
    const saved = this.ctx;
    const savedDetail = this.detailOverride;
    this.ctx = g;
    this.detailOverride = Math.min(16, Math.max(0.25, 2 ** Math.round(Math.log2(scale / baseZoom()))));
    try {
      const paper = this.store.doc.paper ?? '#F7F4EC';
      g.fillStyle = paper;
      g.fillRect(0, 0, w, h);
      g.scale(scale, scale);
      g.translate(-rect.x, -rect.y);
      if (opts.paperPattern) this.paintPaperPattern(g, rect, paper);
      const view = rect;
      const els = this.store.doc.elements;
      const still = els.filter((el) => this.isStill(el));
      for (const el of still) if (el.layer === 'back') this.paintElement(el, view, scale, 1);
      for (const el of still) if (el.layer !== 'back') this.paintElement(el, view, scale, 1);
      for (const area of this.store.doc.areas) {
        if (!this.areaInView(area, view)) continue;
        if (area.clip) { g.save(); g.beginPath(); g.rect(area.x, area.y, area.w, area.h); g.clip(); }
        const total = this.areaLength(area);
        const raw = opts.time === undefined ? null : Math.floor(opts.time * area.fps);
        const tick = raw === null ? null : area.loop ? ((raw % total) + total) % total : Math.min(raw, total - 1);
        for (const layer of area.layers) {
          if (layer.hidden) continue;
          if (layer.kind === 'live') {
            if (area.hideLive) continue;
            for (const el of els) {
              if (el.kind !== 'stroke' || el.alayer !== layer.id) continue;
              if (raw === null) this.paintElement(el, view, scale, 1);
              else this.paintTimed(el, { tick: tick!, raw, fps: area.fps, areaLoop: area.loop }, layer.loop !== false, view, scale);
            }
            continue;
          }
          if (area.hideFrames) continue;
          const fid = tick === null ? layer.frames[0]?.id : frameAtTick(layer.frames, tick);
          if (!fid) continue;
          for (const el of els) if (el.frame === fid) this.paintElement(el, view, scale, 1);
        }
        if (area.clip) g.restore();
      }
      g.globalAlpha = 1;
    } finally {
      this.ctx = saved;
      this.detailOverride = savedDetail;
      // caches were built at the export detail: let them rebuild for the screen
      this.clearCache();
      this.invalidate();
    }
    return c;
  }

  /** Playback length of an area in ticks: its longest keyframe track, and every
   * non-looping live line's end (start + drawing + decay). Same rule as the screen. */
  private areaLength(area: AnimArea): number {
    let total = Math.max(1, ...area.layers.map((l) => l.frames.reduce((a, f) => a + f.duration, 0)));
    for (const l of area.layers) {
      if (l.kind !== 'live' || l.loop !== false) continue;
      for (const el of this.store.doc.elements) {
        if (el.kind !== 'stroke' || el.alayer !== l.id) continue;
        const drawn = (el.points[el.points.length - 1]?.t ?? 0) * area.fps;
        total = Math.max(total, Math.ceil((el.animStart ?? 0) + drawn + Math.max(1, el.animLife ?? 6)));
      }
    }
    return total;
  }

  /** Animation inside a rectangle, for exports: frame rate and length in seconds (null = nothing moves there). */
  animInfo(rect: View): { fps: number; seconds: number } | null {
    const areas = this.store.doc.areas.filter((a) => this.areaInView(a, rect) && a.layers.some((l) => !l.hidden));
    if (!areas.length) return null;
    const fps = Math.max(...areas.map((a) => a.fps));
    const seconds = Math.max(...areas.map((a) => this.areaLength(a) / a.fps));
    return { fps, seconds };
  }

  /** A live-ink stroke at a moment of playback: each point lives `animLife`
   * ticks after it was drawn (mirrors the screen's drawTimed). */
  private paintTimed(
    el: Stroke,
    tk: { tick: number; raw: number; fps: number; areaLoop: boolean },
    looping: boolean,
    view: View,
    scale: number,
  ) {
    const ctx = this.ctx;
    const start = el.animStart ?? 0;
    const life = Math.max(1, el.animLife ?? 6);
    const drawnTicks = (el.points[el.points.length - 1]?.t ?? 0) * tk.fps;
    const cycle = Math.max(1, Math.ceil(start + drawnTicks + life));
    const r = looping ? (tk.areaLoop ? ((tk.raw % cycle) + cycle) % cycle : tk.raw) : tk.tick;
    const ageOf = (t: number) => r - start - t * tk.fps;
    if (!el.animTaper) {
      if (el.points.some((pt) => { const a = ageOf(pt.t); return a >= 0 && a < life; })) this.paintElement(el, view, scale, 1);
      return;
    }
    const pts: StrokePoint[] = [];
    for (const pt of el.points) {
      const age = ageOf(pt.t);
      if (age >= 0 && age < life) pts.push({ ...pt, p: pt.p * (0.08 + 0.92 * (1 - age / life)) });
    }
    if (pts.length < 3 && !(el.points.length === 1 && pts.length === 1)) return;
    if (el.tool === 'pencil') { this.stampStroke(ctx, { ...el, points: pts }, el.opacity); return; }
    ctx.globalAlpha = el.opacity;
    ctx.fillStyle = this.inkStyle(el, scale);
    if (el.tool === 'marker') ctx.fill(markerPaths(pts, el.baseWidth, this.detail()).fill);
    else ctx.fill(outlineToPath(strokeOutline({ ...el, points: pts }, this.detail())));
    ctx.globalAlpha = 1;
  }

  /** The paper's dot/grid/lines pattern in world space (exports): 5 mm cells, anchored at the origin. */
  private paintPaperPattern(g: CanvasRenderingContext2D, rect: View, paper: string) {
    const pattern = this.store.doc.pattern ?? 'dots';
    if (pattern === 'blank') return;
    const dark = darkPaper(paper);
    const s = 10; // 5 mm
    const x0 = Math.floor(rect.x / s) * s, y0 = Math.floor(rect.y / s) * s;
    if (pattern === 'dots') {
      g.fillStyle = dark ? 'rgba(255,255,255,0.14)' : 'rgba(120,105,80,0.18)';
      for (let x = x0; x <= rect.x + rect.w; x += s) for (let y = y0; y <= rect.y + rect.h; y += s) g.fillRect(x - 0.25, y - 0.25, 0.5, 0.5);
      return;
    }
    g.strokeStyle = dark ? 'rgba(255,255,255,0.07)' : 'rgba(120,105,80,0.1)';
    g.lineWidth = 0.25;
    g.beginPath();
    if (pattern === 'grid') for (let x = x0; x <= rect.x + rect.w; x += s) { g.moveTo(x, rect.y); g.lineTo(x, rect.y + rect.h); }
    for (let y = y0; y <= rect.y + rect.h; y += s) { g.moveTo(rect.x, y); g.lineTo(rect.x + rect.w, y); }
    g.stroke();
  }

  // ── Static tiles ──────────────────────────────────────────────────────────

  private takeCanvas(): HTMLCanvasElement {
    const c = this.tilePool.pop() ?? document.createElement('canvas');
    if (c.width !== TILE || c.height !== TILE) { c.width = TILE; c.height = TILE; }
    const g = c.getContext('2d')!;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    return c;
  }
  private recycle(c: HTMLCanvasElement | null) {
    if (!c) return;
    if (this.tilePool.length < TILE_POOL) this.tilePool.push(c);
    else { c.width = 0; c.height = 0; } // frees the backing store now (Safari holds on to it otherwise)
  }
  private dropTile(t: Tile | undefined) { if (t) { this.recycle(t.back); this.recycle(t.front); } }
  private dropSet(set: TileSet | null) {
    if (!set) return;
    for (const t of set.tiles.values()) this.dropTile(t);
    for (const j of set.jobs.values()) { this.recycle(j.back); this.recycle(j.front); }
    set.jobs.clear();
  }

  /** The tile scale (device px per world unit) for a zoom: a level √2 apart at or above it
   * (drawn ≤ 1.41× shrunk, so always sharp), or the exact zoom with levels off. */
  levelFor(zoom: number): number {
    const x = zoom * (window.devicePixelRatio || 1);
    return this.opts.levels ? Math.pow(2, Math.ceil(Math.log2(x) * 2 - 1e-9) / 2) : x;
  }

  /** Expensive to draw from vectors every frame: pencil stamps, dot tones, line patterns (pixel
   * patterns are one image blit: cheap). */
  private static expensive(el: Element): boolean {
    if (el.kind === 'stroke') return el.tool === 'pencil';
    if (el.kind === 'fill') return !!el.pattern && !patternCellSize(el.pattern);
    return false;
  }

  /** This frame: straight from vectors, or tiles? (`inView`: the still ink in view, in order) */
  private decideVector(inView: Element[]): boolean {
    const mode = this.opts.vector;
    if (mode !== 'auto') return (this.vectorMode = mode === 'always');
    if (inView.some(Renderer.expensive)) return (this.vectorMode = false);
    const est = inView.length * this.vecCost, f = this.framePeriod;
    const was = this.vectorMode;
    this.vectorMode = false;
    const tilesReady = this.screenCoverage().sharp >= 1;
    this.vectorMode = was;
    if (this.vectorMode) this.vectorMode = est <= (tilesReady ? 0.6 : 1) * f;
    else this.vectorMode = est <= 0.35 * f;
    return this.vectorMode;
  }

  /** Benchmarks: how much of the screen has a sharp tile, and how much has anything (sharp, another level, the draft). */
  screenCoverage(): { sharp: number; any: number } {
    if (this.gpuShown && this.gpu) { const done = this.gpu.pending ? 0 : 1; return { sharp: done, any: done }; } // (all of it, every frame, once compiled)
    if (this.vectorMode) return { sharp: 1, any: 1 }; // (drawn straight from vectors: all of it, every frame)
    const set = this.tileSet, d = this.draft;
    const dpr = window.devicePixelRatio || 1, z = this.camera.zoom;
    if (!set || set.s !== this.levelFor(z)) return { sharp: 0, any: 0 };
    const W = this.canvas.clientWidth * dpr, H = this.canvas.clientHeight * dpr;
    const { ox, oy } = this.worldMatrix(this.canvas.clientWidth, this.canvas.clientHeight, dpr);
    const T = (TILE * z * dpr) / set.s;
    const i0 = Math.floor(-ox / T), i1 = Math.floor((W - 1 - ox) / T), j0 = Math.floor(-oy / T), j1 = Math.floor((H - 1 - oy) / T);
    let n = 0, sharp = 0, any = 0;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      n++;
      const wx = ((i + 0.5) * TILE) / set.s, wy = ((j + 0.5) * TILE) / set.s;
      const covered = (ts: TileSet | null) => !!ts && ts.tiles.has(`${Math.floor((wx * ts.s) / TILE)},${Math.floor((wy * ts.s) / TILE)}`);
      if (set.tiles.has(`${i},${j}`)) { sharp++; any++; } else if (covered(d) || this.levels.some(covered)) any++;
    }
    return { sharp: sharp / n, any: any / n };
  }

  /** world rect of tile (i, j) at `s` device px per world unit */
  private tileView(i: number, j: number, s: number): View {
    return { x: (i * TILE) / s, y: (j * TILE) / s, w: TILE / s, h: TILE / s };
  }
  /** bbox for culling: any cached entry's (bboxes don't depend on zoom), so off-screen
   * outlines aren't rebuilt just to be culled when the detail bucket changes */
  private elBox(el: Element): BBox {
    // (from the points, not by building the outline: the tile planner asks for every element
    // around the screen, and building pattern fills' shapes all at once stalled a frame)
    if (el.kind === 'text' || el.kind === 'image') return elementBBox(el);
    const hit = this.cache.get(el.id)?.bbox ?? this.boxCache.get(el.id);
    if (hit) return hit;
    const b = elementBBox(el);
    this.boxCache.set(el.id, b);
    return b;
  }

  /** Paint `els` (in order) onto a tile bitmap; helpers (pattern, pencil, grain) draw through this.ctx. */
  private paintTile(c: HTMLCanvasElement, i: number, j: number, s: number, els: Element[]) {
    const g = c.getContext('2d')!;
    const saved = this.ctx;
    this.ctx = g;
    this.tileScale = s;
    try {
      g.setTransform(s, 0, 0, s, -i * TILE, -j * TILE);
      const view = this.tileView(i, j, s);
      const dim = 1; // (focus dimming happens at the blit)
      for (const el of els) {
        this.tileBoxes.set(el.id, this.elBox(el));
        this.paintElement(el, view, this.camera.zoom, dim);
      }
    } finally {
      g.globalAlpha = 1;
      g.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx = saved;
      this.tileScale = null;
    }
  }

  /** Build tile (i, j) a slice at a time, until `until`: its elements in order, a long pencil
   * stroke stamp by stamp, straight into the tile (only the stamps that land on it — no
   * per-stroke bitmap, whose bounding boxes added up to hundreds of MB). Returns the tile
   * once complete; until then whatever was there (the old tile, the old zoom's, paper) shows. */
  private runTileJob(set: TileSet, i: number, j: number, until: number): Tile | null {
    const key = `${i},${j}`;
    const view = this.tileView(i, j, set.s);
    let job = set.jobs.get(key);
    if (!job) {
      const paper = this.store.doc.paper ?? '#F7F4EC';
      const back = this.takeCanvas();
      const g = back.getContext('2d')!;
      g.clearRect(0, 0, TILE, TILE); // (transparent: the paper is the page behind the canvas)
      // (no paper marks: the grid is drawn live over the back layer every frame — baked into tiles it
      // jumped between levels, the overview and scaled stand-ins)
      // its elements, straight from the index (only this tile's area: cheap at any zine size)
      const back_: Element[] = [], front_: Element[] = [];
      for (const el of this.stillIn(view)) (el.layer === 'back' ? back_ : front_).push(el);
      job = { i, j, back, front: null, spent: 0, layers: [back_, front_], pass: 0, k: 0, stamp: null, stale: false };
      set.jobs.set(key, job);
    }
    const pending = this.rastersPending;
    this.rastersPending = false;
    const t0 = performance.now();
    const done = this.advanceTileJob(job, set, view, until);
    job.spent += performance.now() - t0;
    job.stale ||= this.rastersPending; // a pattern fill drawn from another zoom's bake: rebuild once it's ready
    this.rastersPending ||= pending;
    if (!done) return null;
    set.jobs.delete(key);
    // what a tile costs on this device — only where the clock sees the drawing (WebKit, flushed);
    // elsewhere it's learnt from late frames (see frame)
    if (!set.draft && DEFERRED_CANVAS) { this.tileCost += (job.spent - this.tileCost) * 0.2; this.tileCostS += (set.s - this.tileCostS) * 0.2; }
    return { i, j, back: job.back, front: job.front, stale: job.stale };
  }

  private advanceTileJob(job: TileJob, set: TileSet, view: View, until: number): boolean {
    const dim = 1; // (focus dimming happens at the blit)
    const z = this.camera.zoom;
    while (job.pass < 2) {
      const els = job.layers[job.pass];
      if (job.pass === 1 && !job.front) {
        if (!els.length) break;
        job.front = this.takeCanvas();
        job.front.getContext('2d')!.clearRect(0, 0, TILE, TILE);
      }
      const g = (job.pass === 0 ? job.back : job.front!).getContext('2d')!;
      let sinceFlush = 0;
      const saved = this.ctx;
      this.ctx = g;
      this.tileScale = set.s;
      try {
        g.setTransform(set.s, 0, 0, set.s, -job.i * TILE, -job.j * TILE);
        while (job.k < els.length) {
          const el = els[job.k];
          this.lastTileEl = el; this.lastTileDraft = !!set.draft; // (the pan benchmark's profiler reads these)
          this.tileBoxes.set(el.id, this.elBox(el));
          if (el.kind === 'stroke' && el.tool === 'pencil' && !job.stamp && this.gpuStampTile(g, el, el.opacity * dim, set, view, job.i, job.j)) {
            // the whole stroke's stamps on this tile in one GPU draw
          } else if (el.kind === 'stroke' && el.tool === 'pencil') {
            const st = job.stamp ??= { next: 0, state: { sinceX: NaN, sinceY: NaN, skipped: 0 } };
            // as many stamps as the time left allows at the measured rate; then make WebKit draw
            // them now, so the time spent is real and the rate stays honest
            const t0 = performance.now(), from = st.next;
            const rate = set.draft ? this.draftStampRate : this.stampRate;
            const limit = from + Math.max(32, Math.floor(rate * Math.max(0.5, until - t0)));
            // (stamps closer than ~0.7 device px are invisible: merged, alpha-compensated;
            // the overview merges a little more — a third of the nib apart)
            const minSpacing = set.draft ? Math.max(0.7 / set.s, el.baseWidth * 0.33) : 0.7 / set.s;
            st.next = this.stampStroke(g, el, el.opacity * dim, st.next, { minSpacing, cache: true, until, limit, state: st.state, cull: view });
            flushCanvas(g);
            const dt = performance.now() - t0, done = st.next - from;
            if (done >= 32 && dt > 0.3) {
              if (set.draft) this.draftStampRate += (done / dt - this.draftStampRate) * 0.3;
              else this.stampRate += (done / dt - this.stampRate) * 0.3;
            }
            if (st.next < this.stampsFor(el, true).length) return false;
            job.stamp = null;
          } else {
            if (el.kind === 'fill' && el.pattern && isMotif(el.pattern) && (set.draft || motifRadius(el.pattern) * set.s < 0.35)) {
              // (dots under ~⅓ px can't be seen one by one: their tint is what the eye gets)
              // draft: a dot tone as its tint (same ink coverage, no dots)
              g.save();
              g.globalCompositeOperation = el.blend ?? 'multiply';
              g.globalAlpha = el.opacity * dim * (el.ink ?? 1) * motifCoverage(el.pattern);
              g.fillStyle = el.color;
              g.fill(polygonPath(el.points));
              g.restore();
            } else {
              // a dot-tone fill bakes first, a slice at a time (the tile waits for it)
              if (el.kind === 'fill' && el.pattern && isMotif(el.pattern) && !this.bakeDotsUntil(el, this.elBox(el), set.s, until)) return false;
              this.paintElement(el, view, z, dim);
            }
          }
          job.k++;
          // WebKit draws what's recorded later: every few elements make it draw now, so the
          // deadline sees real cost (recording 50 strokes takes no time; drawing them can take 100 ms).
          // (Chrome too, less often: far out over a crowded zine a tile holds thousands of elements,
          // and unflushed a frame paid over a second for them at once)
          if (++sinceFlush >= (DEFERRED_CANVAS ? 6 : 48)) { g.getImageData(0, 0, 1, 1); sinceFlush = 0; }
          if (job.k < els.length && performance.now() > until) return false;
        }
      } finally {
        g.globalAlpha = 1;
        g.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx = saved;
        this.tileScale = null;
      }
      job.pass++;
      job.k = 0;
    }
    return true;
  }

  /** Other levels' tiles under `boxes` are out of date: forget them (they're rebuilt if that level comes back). */
  private dropLevelTiles(boxes: BBox[]) {
    for (const l of this.levels) {
      for (const [key, t] of l.tiles) if (boxes.some((b) => bboxIntersects(b, this.tileView(t.i, t.j, l.s)))) { this.dropTile(t); l.tiles.delete(key); }
      for (const [key, job] of l.jobs) if (boxes.some((b) => bboxIntersects(b, this.tileView(job.i, job.j, l.s)))) { this.recycle(job.back); this.recycle(job.front); l.jobs.delete(key); }
    }
  }

  /** Forget unfinished tiles (all, or those under `boxes`): their element lists are out of date. */
  private dropTileJobs(boxes?: BBox[]) {
    for (const set of [this.tileSet, this.draft]) {
      if (!set) continue;
      for (const [key, job] of set.jobs) {
        if (boxes && !boxes.some((b) => bboxIntersects(b, this.tileView(job.i, job.j, set.s)))) continue;
        this.recycle(job.back);
        this.recycle(job.front);
        set.jobs.delete(key);
      }
    }
  }

  /** A tile's layer pre-shrunk to the next mip size at or above `px` (128 or 32 px), made once:
   * shrinking a 512 px tile to a few pixels every frame cost WebKit seconds far out. */
  private mipsMade = 0; // this frame (a few a frame: the first far-out frame used to make dozens at once)
  private mipFrame = 0;
  private mip(t: Tile, layer: 'back' | 'front', c: HTMLCanvasElement, px: number, force = false): HTMLCanvasElement | null {
    const size = px > 32 ? 128 : 32;
    const key = `${layer}${size}`;
    let m = t.mips?.get(key);
    if (!m) {
      if (this.mipFrame !== this.lastFrameT) { this.mipFrame = this.lastFrameT; this.mipsMade = 0; }
      if (!force && this.mipsMade >= 3) { this.dirty = true; return null; } // (drawn full size this once)
      this.mipsMade++;
      const src = size === 32 ? this.mip(t, layer, c, 128, true)! : c; // (in steps: smoother, and cheap)
      m = document.createElement('canvas');
      m.width = m.height = size;
      const g = m.getContext('2d')!;
      g.imageSmoothingQuality = 'high';
      g.drawImage(src, 0, 0, size, size);
      (t.mips ??= new Map()).set(key, m);
    }
    return m;
  }

  /** The coverage mask: FEATHER_N px per screen tile, its alpha the tile's coverage (0 none, 1
   * sharp and settled, between: fading in), eased down over the two px along each edge that meets
   * a less finished tile — drawn scaled up with smoothing, that's a soft ramp a quarter tile wide
   * inside the finished tile instead of a hard edge. Off-screen neighbours count as finished (a
   * tile at the screen's edge doesn't soften towards what isn't shown). */
  private coverMask(cv: Coverage) {
    const N = FEATHER_N, { cols, rows, v } = cv;
    const w = cols * N, h = rows * N;
    const m = (this.coverCanvas ??= document.createElement('canvas'));
    const u = (this.uncoverCanvas ??= document.createElement('canvas'));
    for (const c of [m, u]) if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const img = new ImageData(w, h), d = img.data;
    const inv = new ImageData(w, h), di = inv.data;
    const at = (i: number, j: number) => (i < 0 || j < 0 || i >= cols || j >= rows ? 1 : v[j * cols + i]);
    // weight of the tile's own value N px in from an edge: 0 at the edge px, ½ next, then 1
    const wt = (l: number) => (l === 0 || l === N - 1 ? 0 : l === 1 || l === N - 2 ? 0.5 : 1);
    for (let py = 0; py < h; py++) {
      const j = (py / N) | 0, ly = py - j * N;
      const dy = ly < N / 2 ? -1 : 1, wy = wt(ly);
      for (let px = 0; px < w; px++) {
        const i = (px / N) | 0, lx = px - i * N;
        const dx = lx < N / 2 ? -1 : 1, wx = wt(lx);
        const a = at(i, j);
        let o = a;
        if (wx < 1) { const n = at(i + dx, j); if (n < a) o = Math.min(o, n + (a - n) * wx); }
        if (wy < 1) { const n = at(i, j + dy); if (n < a) o = Math.min(o, n + (a - n) * wy); }
        if (wx < 1 && wy < 1) { const n = at(i + dx, j + dy); if (n < a) o = Math.min(o, n + (a - n) * Math.max(wx, wy)); }
        const q = Math.round(o * 255);
        d[(py * w + px) * 4 + 3] = q;
        di[(py * w + px) * 4 + 3] = 255 - q;
      }
    }
    m.getContext('2d')!.putImageData(img, 0, 0);
    u.getContext('2d')!.putImageData(inv, 0, 0);
  }
  private coverCanvas: HTMLCanvasElement | null = null; // coverage
  private uncoverCanvas: HTMLCanvasElement | null = null; // 1 − coverage
  private coverFor: Coverage | null = null;
  private featherCanvases = new Map<string, HTMLCanvasElement>();

  /** Draw the band `cv.rect`: the stand-ins (`under`) masked to 1 − coverage, then the sharp tiles
   * (`sharp`) masked to coverage, each composed in a scratch canvas and laid on the screen.
   * Each layer and pass has its own scratch canvas: one canvas cleared and redrawn after it was
   * drawn onto the screen, within the frame, made WebKit copy it whole each time (~270 ms a frame
   * on the iPad simulator). The stand-ins are soft anyway: they're composed at half resolution. */
  private featherBlit(cv: Coverage, layer: 'back' | 'front', under: (w: number, h: number, dx: number, dy: number) => void, sharp: (w: number, h: number, dx: number, dy: number) => void) {
    const main = this.ctx, R = cv.rect;
    if (this.coverFor !== cv) { this.coverMask(cv); this.coverFor = cv; } // (once a frame, for both layers)
    const scale = cv.T / FEATHER_N;
    const mx = cv.x - R.x, my = cv.y - R.y;
    for (const pass of [under, sharp]) {
      const half = pass === under ? 0.5 : 1;
      const key = `${layer}${half}`;
      let sc = this.featherCanvases.get(key);
      if (!sc) this.featherCanvases.set(key, (sc = document.createElement('canvas')));
      const w = Math.ceil(R.w * half), h = Math.ceil(R.h * half);
      if (sc.width < w || sc.height < h) { sc.width = Math.max(sc.width, w); sc.height = Math.max(sc.height, h); }
      const g = sc.getContext('2d')!;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;
      g.clearRect(0, 0, w, h);
      g.setTransform(half, 0, 0, half, 0, 0);
      this.ctx = g;
      try { pass(R.w, R.h, -R.x, -R.y); } finally { this.ctx = main; }
      // (erasing with the opposite mask: WebKit draws destination-in through a whole-canvas buffer)
      g.globalCompositeOperation = 'destination-out';
      g.imageSmoothingEnabled = true;
      g.drawImage(pass === under ? this.coverCanvas! : this.uncoverCanvas!, mx, my, this.coverCanvas!.width * scale, this.coverCanvas!.height * scale);
      main.drawImage(sc, 0, 0, w, h, R.x, R.y, R.w, R.h);
    }
  }

  /** Blit a tile set's back or front bitmaps (device-px space; scaled when the set is from another zoom). */
  private blitTiles(set: TileSet, layer: 'back' | 'front', W: number, H: number, ox: number, oy: number, now = -1, skip?: { x: number; y: number; w: number; h: number }) {
    const ctx = this.ctx;
    const k = (this.camera.zoom * (window.devicePixelRatio || 1)) / set.s;
    const base = ctx.globalAlpha;
    for (const t of set.tiles.values()) {
      const c = layer === 'back' ? t.back : t.front;
      if (!c) continue;
      // edges rounded on their own, so neighbours always meet without a gap
      const x0 = Math.round(t.i * TILE * k) + ox, x1 = Math.round((t.i + 1) * TILE * k) + ox;
      const y0 = Math.round(t.j * TILE * k) + oy, y1 = Math.round((t.j + 1) * TILE * k) + oy;
      if (x1 <= 0 || y1 <= 0 || x0 >= W || y0 >= H) continue;
      if (skip && Math.max(x0, 0) >= skip.x && Math.max(y0, 0) >= skip.y && Math.min(x1, W) <= skip.x + skip.w && Math.min(y1, H) <= skip.y + skip.h) continue;
      const age = now >= 0 && t.born !== undefined ? now - t.born : FADE_MS;
      ctx.globalAlpha = age < FADE_MS ? base * fadeAlpha(age) : base;
      if (k === 1) ctx.drawImage(c, x0, y0);
      else if (k >= 0.3) ctx.drawImage(c, x0, y0, x1 - x0, y1 - y0);
      else ctx.drawImage(this.mip(t, layer, c, x1 - x0) ?? c, x0, y0, x1 - x0, y1 - y0);
    }
    ctx.globalAlpha = base;
  }

  /** The view's motion (for motion-aware budgets and prefetching ahead), once a frame. */
  private trackMotion(frameStart: number, dpr: number) {
    const { camera } = this;
    const pc = this.camPrev;
    if (camera.x !== pc.x || camera.y !== pc.y || camera.zoom !== pc.zoom) {
      const dt = Math.max(1, frameStart - pc.t), z = camera.zoom * dpr;
      if (pc.t && camera.zoom === pc.zoom) {
        this.vel.x += (((camera.x - pc.x) * z) / dt - this.vel.x) * 0.5;
        this.vel.y += (((camera.y - pc.y) * z) / dt - this.vel.y) * 0.5;
      }
      this.movingUntil = frameStart + 120;
    } else if (frameStart > this.movingUntil) {
      this.vel.x = this.vel.y = 0;
    }
    this.camPrev = { x: camera.x, y: camera.y, zoom: camera.zoom, t: frameStart };
  }

  /** Static ink for this frame: build the tiles that scrolled into view (and, with
   * time to spare, a ring around them), blit the back bitmaps, and return the
   * front blit, which runs after a paint-behind live stroke. */
  /** `show` false (vector mode): keep the tiles and the overview building in the background, at a
   * low budget, without drawing them — so they're ready the moment the view needs tiles. */
  private drawStatic(vw: number, vh: number, dpr: number, frameStart: number, show = true): () => void {
    const { camera } = this;
    const ctx = this.ctx;
    const opts = this.opts;
    const content = this.contentKey();
    const level = this.levelFor(camera.zoom);
    const zooming = frameStart - this.lastZoomChangeAt < 180;
    const moving = frameStart < this.movingUntil;

    this.levels = this.levels.filter((l) => { if (l.content === content) return true; this.dropSet(l); return false; });
    if (this.tileSet && this.tileSet.content !== content) { this.dropSet(this.tileSet); this.tileSet = null; }
    let set = this.tileSet;
    // (a level we still have comes back at once; a new one waits for the zoom gesture to settle)
    if (set && set.s !== level && (!zooming || this.levels.some((l) => l.s === level))) {
      // the zoom settled on another level: this one joins the cache; a cached set of the new level comes back
      this.levels.unshift(set);
      const hit = this.levels.findIndex((l) => l.s === level);
      set = hit >= 0 ? this.levels.splice(hit, 1)[0] : null;
      while (this.levels.length > 3) this.dropSet(this.levels.pop()!); // three other zoom levels kept
    }
    if (!set) set = { content, zoom: camera.zoom, s: level, tiles: new Map(), jobs: new Map() };
    this.tileSet = set;
    const fine: TileSet = set;
    const ext = this.draftScale();
    let draft = this.draft;
    if (draft && (draft.content !== content || draft.s !== ext.s || !opts.draft)) { this.dropSet(draft); draft = this.draft = null; }
    if (!draft && opts.draft) draft = this.draft = { content, zoom: 0, s: ext.s, tiles: new Map(), jobs: new Map(), draft: true };
    const coarse = draft;
    const settled = fine.s === level;
    // the eraser hides elements as it goes: repaint just the tiles they were on (and back, if un-hidden)
    const hidden = this.input.hidden;
    if (settled && (hidden.size || this.tileHidden.size)) {
      const changed: BBox[] = [];
      for (const id of hidden) if (!this.tileHidden.has(id)) { const b = this.tileBoxes.get(id); if (b) changed.push(b); }
      for (const id of this.tileHidden) {
        if (hidden.has(id)) continue;
        const el = this.index().byId.get(id);
        if (el && this.isStill(el)) changed.push(this.elBox(el));
      }
      this.tileHidden = new Set(hidden);
      this.redoTiles(changed);
    }
    const { ox, oy } = this.worldMatrix(vw, vh, dpr);
    const W = vw * dpr, H = vh * dpr;
    const k = (camera.zoom * dpr) / fine.s, T = TILE * k; // a sharp tile on screen, device px
    const holes = new Path2D(); // screen rects without a settled sharp tile (missing or still fading in)
    const missingHoles = new Path2D(); // … of those, the ones with no tile at all
    const fadingRects: [number, number, number, number, number][] = []; // x, y, w, h, the tile's opacity now
    let holed = false;
    let anyMissing = false;
    let fading = false;
    let cover: Coverage | null = null; // (feathering) how far each screen tile is along, and where
    if (settled) {
      const tiles = fine.tiles;
      const i0 = Math.floor(-ox / T), i1 = Math.floor((W - 1 - ox) / T);
      const j0 = Math.floor(-oy / T), j1 = Math.floor((H - 1 - oy) / T);
      const view = camera.viewport(vw, vh);
      const eb = ext.box;
      // (one more ring on the side the view is heading)
      const lead = opts.prefetchDir && moving ? { x: Math.sign(Math.round(this.vel.x * 4)), y: Math.sign(Math.round(this.vel.y * 4)) } : { x: 0, y: 0 };
      const ri0 = i0 - PREFETCH - (lead.x < 0 ? 1 : 0), ri1 = i1 + PREFETCH + (lead.x > 0 ? 1 : 0);
      const rj0 = j0 - PREFETCH - (lead.y < 0 ? 1 : 0), rj1 = j1 + PREFETCH + (lead.y > 0 ? 1 : 0);
      { // the screen + prefetch rings: bakes of what's in here aren't evicted
        const a = this.tileView(ri0, rj0, fine.s), b = this.tileView(ri1, rj1, fine.s);
        this.keepRect = { x: a.x, y: a.y, w: b.x + b.w - a.x, h: b.y + b.h - a.y };
      }
      const build = (ts: TileSet, i: number, j: number, until: number): boolean => {
        const tile = this.runTileJob(ts, i, j, until);
        if (!tile) return false;
        if (ts === coarse) for (const layer of ['back', 'front'] as const) { const c = layer === 'back' ? tile.back : tile.front; if (c) this.mip(tile, layer, c, 8, true); }
        const key = `${i},${j}`;
        const old = ts.tiles.get(key);
        // a tile appearing where there was none fades in; a rebuild of one already showing just swaps
        if (opts.fade && ts === fine && !old) tile.born = performance.now();
        this.dropTile(old);
        ts.tiles.set(key, tile);
        return true;
      };
      // a sharper cached level (we zoomed out) covering a tile: it can wait — shrunk, those stay crisp
      const coveredBySharper = (i: number, j: number) => {
        const v = this.tileView(i, j, fine.s);
        return this.levels.some((l) => {
          if (l.s <= fine.s) return false;
          const a0 = Math.floor((v.x * l.s) / TILE), a1 = Math.floor(((v.x + v.w) * l.s - 1e-6) / TILE);
          const b0 = Math.floor((v.y * l.s) / TILE), b1 = Math.floor(((v.y + v.h) * l.s - 1e-6) / TILE);
          for (let b = b0; b <= b1; b++) for (let a = a0; a <= a1; a++) if (!l.tiles.has(`${a},${b}`)) return false;
          return true;
        });
      };
      let missing = 0;
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (!tiles.has(`${i},${j}`) && !coveredBySharper(i, j)) missing++;
      // when to build: all at once if that fits about a frame on this device (or always, with 'sync'),
      // else a budget per frame — most of the frame while gaps show and the view is still, a third
      // of it while it moves (smoothness first) or for prefetching
      // (adaptive: only small gaps — the edge a slow pan reveals — and only when they fit a frame here)
      const expected = this.tileCost * Math.max(1, (this.tileCostS / fine.s) ** 2); // per tile at this level
      const syncNow = opts.schedule === 'sync' || (opts.schedule === 'adaptive' && missing > 0 && missing <= 4 && missing * expected <= this.framePeriod);
      const slice = this.buildBudget();
      const deadline = frameStart + (!show ? slice * 0.5 : missing && !(opts.motion && moving) ? Math.max(slice, this.framePeriod * 0.75) : slice);
      let built = 0;
      let pending = false;
      const cx = (W / 2 - ox) / T - 0.5, cy = (H / 2 - oy) / T - 0.5;
      const order: [TileSet, number, number, number, boolean][] = []; // set, i, j, priority, on screen
      if (coarse) {
        // the draft: over the screen first while sharp tiles are missing there, then the rest of
        // the zine in spare time (so later pans and zooms find it ready)
        const ds = coarse.s;
        const di0 = Math.floor((view.x * ds) / TILE), di1 = Math.floor(((view.x + view.w) * ds) / TILE);
        const dj0 = Math.floor((view.y * ds) / TILE), dj1 = Math.floor(((view.y + view.h) * ds) / TILE);
        const ei0 = eb ? Math.floor((eb.minX * ds) / TILE) : 0, ei1 = eb ? Math.floor((eb.maxX * ds) / TILE) : -1;
        const ej0 = eb ? Math.floor((eb.minY * ds) / TILE) : 0, ej1 = eb ? Math.floor((eb.maxY * ds) / TILE) : -1;
        const dcx = ((view.x + view.w / 2) * ds) / TILE - 0.5, dcy = ((view.y + view.h / 2) * ds) / TILE - 0.5;
        // (only where the zine is: far out the screen spans thousands of empty overview tiles)
        for (let j = ej0; j <= ej1; j++) {
          for (let i = ei0; i <= ei1; i++) {
            const on = i >= di0 && i <= di1 && j >= dj0 && j <= dj1;
            if (coarse.tiles.has(`${i},${j}`)) continue;
            order.push([coarse, i, j, (on && missing && !syncNow ? 0 : 1500) + Math.hypot(i - dcx, j - dcy), on && missing > 0 && !syncNow]);
          }
        }
        for (const [key, t] of coarse.tiles) if (t.redo) order.push([coarse, t.i, t.j, 1500, false]), void key;
      }
      for (let j = rj0; j <= rj1; j++) {
        for (let i = ri0; i <= ri1; i++) {
          const on = i >= i0 && i <= i1 && j >= j0 && j <= j1;
          const wait = on && coveredBySharper(i, j);
          // ahead of the motion first (the side about to come into view)
          const ahead = lead.x || lead.y ? -0.6 * ((i - cx) * lead.x + (j - cy) * lead.y) : 0;
          order.push([fine, i, j, (on ? (wait ? 800 : 100) : 1000) + Math.hypot(i - cx, j - cy) + ahead, on]);
        }
      }
      order.sort((a, b) => a[3] - b[3]);
      for (const [ts, i, j, , onScreen] of order) {
        const t = ts.tiles.get(`${i},${j}`);
        if (t && !t.redo && (!t.stale || !onScreen || ts === coarse)) continue;
        // while the view moves, only what's on screen (and the first prefetch ring): background
        // work — the far overview, outer rings — waits until it rests
        if (moving && !onScreen && (ts === coarse || Math.max(i0 - i, i - i1, j0 - j, j - j1) > 1)) { pending = true; continue; }
        const sync = syncNow && ts === fine && onScreen;
        const now = performance.now();
        if (!sync && now > deadline && (built || !onScreen)) { pending = true; if (onScreen) continue; break; }
        built++;
        if (sync) this.syncBuilt++;
        // (the first tile of a frame always gets a couple of ms, so something always progresses)
        if (!build(ts, i, j, sync ? Infinity : built === 1 ? Math.max(deadline, now + 2) : deadline)) pending = true;
      }
      // forget tiles (and half-built ones) that scrolled well away
      const far = (ts: TileSet, i: number, j: number) => ts === fine
        ? i < ri0 - 1 || i > ri1 + 1 || j < rj0 - 1 || j > rj1 + 1
        : !eb || i < Math.floor((eb.minX * ts.s) / TILE) - 1 || i > Math.floor((eb.maxX * ts.s) / TILE) + 1 || j < Math.floor((eb.minY * ts.s) / TILE) - 1 || j > Math.floor((eb.maxY * ts.s) / TILE) + 1;
      for (const ts of coarse ? [fine, coarse] : [fine]) {
        for (const [key, t] of ts.tiles) if (far(ts, t.i, t.j)) { this.dropTile(t); ts.tiles.delete(key); }
        for (const [key, job] of ts.jobs) if (far(ts, job.i, job.j)) { this.recycle(job.back); this.recycle(job.front); ts.jobs.delete(key); }
      }
      const nowMs = performance.now();
      const cols = i1 - i0 + 1, rows = j1 - j0 + 1;
      const v = opts.feather ? new Float32Array(cols * rows) : null;
      let ci0 = Infinity, ci1 = -Infinity, cj0 = Infinity, cj1 = -Infinity;
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const t = tiles.get(`${i},${j}`);
          const fadingIn = !!t && t.born !== undefined && nowMs - t.born < FADE_MS;
          if (v) {
            const a = !t ? 0 : fadingIn ? fadeAlpha(nowMs - t.born!) : 1;
            v[(j - j0) * cols + (i - i0)] = a;
            if (a < 1) { ci0 = Math.min(ci0, i); ci1 = Math.max(ci1, i); cj0 = Math.min(cj0, j); cj1 = Math.max(cj1, j); }
          }
          if (!t || fadingIn) {
            const x0 = Math.round(i * T) + ox, y0 = Math.round(j * T) + oy;
            const w = Math.round((i + 1) * T) + ox - x0, h = Math.round((j + 1) * T) + oy - y0;
            holes.rect(x0, y0, w, h);
            holed = true;
            if (!t) { missingHoles.rect(x0, y0, w, h); anyMissing = true; }
            else { fadingRects.push([x0, y0, w, h, fadeAlpha(nowMs - t.born!)]); fading = true; }
          }
        }
      }
      if (v && ci0 <= ci1) {
        // the band: the unfinished tiles and the ring of tiles around them (their edges soften)
        const x0 = Math.max(0, Math.round((ci0 - 1) * T) + ox), x1 = Math.min(W, Math.round((ci1 + 2) * T) + ox);
        const y0 = Math.max(0, Math.round((cj0 - 1) * T) + oy), y1 = Math.min(H, Math.round((cj1 + 2) * T) + oy);
        if (x1 > x0 && y1 > y0) cover = { v, cols, rows, x: i0 * T + ox, y: j0 * T + oy, T, rect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
      }
      if (pending || fading) this.dirty = true;
    } else {
      this.dirty = true; // mid-zoom across levels: what we have, scaled, until the gesture settles
    }
    // editing an area dims everything else: the tiles go down faded over bare paper
    const dimmed = !!this.focusAreaId();
    // other levels as stand-ins, sharper on top — but not ones far sharper than needed: shrinking
    // hundreds of their tiles to a few pixels each, every frame, took a far-out frame past a second
    // (the overview covers there instead; they stay cached for zooming back)
    const others = this.levels.filter((l) => (camera.zoom * dpr) / l.s >= 0.3).sort((a, b) => a.s - b.s);
    const blit = (layer: 'back' | 'front') => {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      if (layer === 'back') {
        // the main canvas is transparent (the paper layer shows through); scratch canvases paint their own
        if (this.canvas.id === 'canvas') ctx.clearRect(0, 0, W, H);
        else { ctx.fillStyle = this.store.doc.paper ?? '#F7F4EC'; ctx.fillRect(0, 0, W, H); }
        if (this.opts.grid && this.opts.gridMode === 'canvas') {
          // the paper marks first, the ink over them (no blending needed — measured: the multiply
          // over the ink was what cost WebKit a third of its frame rate)
          ctx.save();
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          this.drawPaperGrid(vw, vh, this.store.doc.paper ?? '#F7F4EC', 'source-over');
          ctx.restore();
        }
      }
      if (dimmed) ctx.globalAlpha = 0.3;
      const under = (w = W, h = H, x = ox, y = oy) => {
        if (coarse?.tiles.size) this.blitTiles(coarse, layer, w, h, x, y);
        for (const l of others) this.blitTiles(l, layer, w, h, x, y);
      };
      if (!settled) {
        under(); // mid-zoom across levels: what we have, scaled
      } else if (cover) {
        // feathered: in the band, sharp × coverage over the stand-ins × (1 − coverage), the
        // coverage a soft mask (one value per tile, eased across edges); elsewhere the sharp tiles
        // (the passes draw shifted by the band's offset: dx, dy)
        this.featherBlit(cover, layer, (w, h, dx, dy) => under(w, h, ox + dx, oy + dy), (w, h, dx, dy) => this.blitTiles(fine, layer, w, h, ox + dx, oy + dy));
        // (skipping the band's tiles, not clipping around it: WebKit masks every draw under a clip with a hole)
        this.blitTiles(fine, layer, W, H, ox, oy, -1, cover.rect);
        ctx.restore();
        return;
      } else if (holed) {
        // under the gaps: the draft, then other levels' tiles, sharper on top. Under tiles fading
        // in: the same, fading out as they fade in (the back layer is opaque, so there it's covered
        // anyway; the front layer would otherwise show its ink twice, darker, mid-fade)
        const dim0 = ctx.globalAlpha;
        if (anyMissing) {
          ctx.save();
          ctx.clip(missingHoles);
          under();
          ctx.restore();
        }
        {
          for (const [x, y, w, h, a] of fadingRects) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(x, y, w, h);
            ctx.clip();
            ctx.globalAlpha = dim0 * (1 - a);
            under();
            ctx.restore();
          }
        }
      }
      this.blitTiles(fine, layer, W, H, ox, oy, performance.now());
      ctx.restore();
    };
    if (!show) return () => {};
    blit('back');
    // (alpha reset inside: a live back-layer marker leaves the context at its 0.45 and would fade the whole front layer)
    return () => blit('front');
  }

  /** Append freshly committed elements onto the built tiles. */
  private paintOntoTiles(els: Element[]) {
    const set = this.tileSet!;
    this.dropLevelTiles(els.map((el) => this.elBox(el))); // other levels' tiles there would miss the new ink
    const back = els.filter((el) => el.layer === 'back');
    const front = els.filter((el) => el.layer !== 'back');
    for (const t of set.tiles.values()) {
      const view = this.tileView(t.i, t.j, set.s);
      if (back.some((el) => bboxIntersects(this.elBox(el), view))) this.paintTile(t.back, t.i, t.j, set.s, back);
      if (front.some((el) => bboxIntersects(this.elBox(el), view))) {
        if (!t.front) {
          t.front = this.takeCanvas();
          t.front.getContext('2d')!.clearRect(0, 0, TILE, TILE);
        }
        this.paintTile(t.front, t.i, t.j, set.s, front);
      }
    }
  }

  /** Paint one element's body (no handles/selection) through this.ctx. Returns false if culled. */
  private paintElement(el: Element, view: View, z: number, dim: number): boolean {
    const ctx = this.ctx;
    if (el.kind === 'text') {
      const b = elementBBox(el);
      if (!bboxIntersects(b, view)) return false;
      ctx.globalAlpha = dim;
      paintTextBox(ctx, el);
      return true;
    }
    if (el.kind === 'image') {
      const b = elementBBox(el);
      if (!bboxIntersects(b, view)) return false;
      const img = this.image(el.src);
      if (img.complete && img.naturalWidth) {
        ctx.globalAlpha = dim;
        ctx.drawImage(img, el.x, el.y, el.w, el.h);
      }
      return true;
    }
    if (el.kind === 'fill' && el.pattern && patternCellSize(el.pattern)) {
      // pixel patterns: one image pixel per cell, scaled up without smoothing — sharp pixels at
      // every zoom for one blit, instead of a path of thousands of squares
      const img = this.cellImage(el);
      if (img) {
        if (!bboxIntersects(this.elBox(el), view)) return false;
        ctx.save();
        ctx.globalCompositeOperation = el.blend ?? 'multiply';
        ctx.globalAlpha = el.opacity * dim * (el.ink ?? 1);
        // sharp pixels — unless the cells are under ~1.5 px on screen, where averaging them reads truer than aliasing
        const sc = this.tileScale ?? this.camera.zoom * (window.devicePixelRatio || 1);
        ctx.imageSmoothingEnabled = img.cell * sc < 1.5;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img.c, img.c0 * img.cell, img.r0 * img.cell, img.cols * img.cell, img.rows * img.cell);
        ctx.restore();
        return true;
      }
    }
    if (el.kind === 'fill' && el.pattern && isMotif(el.pattern) && this.tileScale !== null) {
      // a dot tone that's baked at this scale: blit it (its path of dots isn't needed at all)
      const fr = this.fillRasters.get(el.id);
      if (fr && fr.s === this.tileScale) {
        if (!bboxIntersects(this.elBox(el), view)) return false;
        ctx.save();
        ctx.globalCompositeOperation = el.blend ?? 'multiply';
        ctx.globalAlpha = el.opacity * dim * (el.ink ?? 1);
        const m = ctx.getTransform();
        ctx.setTransform(1, 0, 0, 1, m.e, m.f);
        ctx.drawImage(fr.c, fr.x, fr.y);
        ctx.restore();
        return true;
      }
    }
    const e = this.entry(el);
    if (!bboxIntersects(e.bbox, view)) return false;
    if (el.kind === 'stroke' && el.tool === 'pencil') {
      if (this.tileScale !== null) {
        // into a tile (appending fresh ink): its stamps straight in, only those that land here
        this.stampStroke(ctx, el, el.opacity * dim, 0, { minSpacing: 0.7 / this.tileScale, cache: true, cull: view });
        return true;
      }
      const pr = this.pencilRaster(el, z);
      if (pr) {
        ctx.globalAlpha = el.opacity * dim;
        ctx.drawImage(pr.c, pr.bbox.minX, pr.bbox.minY, pr.c.width / pr.bucket, pr.c.height / pr.bucket);
      } else {
        // its raster is still being stamped: the outline in graphite grain stands in
        ctx.globalAlpha = el.opacity * dim * 0.6;
        ctx.fillStyle = this.grainPattern(el.color, z);
        ctx.fill(e.path);
      }
    } else if (el.kind === 'stroke' && el.tool === 'sketch' && e.passes) {
      ctx.save();
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = el.color;
      for (const pass of e.passes) {
        ctx.globalAlpha = 0.42 * el.opacity * dim;
        ctx.fill(pass);
      }
      ctx.restore();
    } else {
      ctx.globalAlpha = el.opacity * dim;
      const patterned = el.kind === 'fill' && !!el.pattern;
      ctx.fillStyle = patterned && !e.solid
        ? this.fillPattern(el.pattern!, el.color, isPixelPattern(el.pattern!) ? 0 : el.patternAngle ?? 0) // dithers never rotate
        : el.color;
      // fills can overprint like process ink: multiply at the fill's ink coverage —
      // paper × (1 − ink·(1 − colour)) — so overlaps mix and darken (CMYK-like).
      // Pattern fills do so by default; solid fills only when they say so (older solid fills are opaque).
      const op = el.kind === 'fill' ? el.blend ?? (patterned ? 'multiply' : 'source-over') : 'source-over';
      const ink = el.kind === 'fill' ? el.ink ?? 1 : 1;
      const blending = op !== 'source-over' || ink < 1;
      // tiles blit pattern fills from a bitmap baked at their resolution (see fillRaster)
      const baked = patterned && (!e.solid || isMotif(el.pattern!)) && this.tileScale ? this.fillRaster(el as FillShape, e, this.tileScale) : null;
      if (blending || baked) {
        ctx.save();
        ctx.globalCompositeOperation = op;
        ctx.globalAlpha = el.opacity * dim * ink;
      }
      if (baked) {
        const m = ctx.getTransform(); // tile: scale s, whole-pixel offset
        ctx.setTransform(1, 0, 0, 1, m.e, m.f);
        const k = this.tileScale! / baked.s; // 1 unless another zoom's bake stands in
        if (k === 1) ctx.drawImage(baked.c, baked.x, baked.y);
        else ctx.drawImage(baked.c, baked.x * k, baked.y * k, baked.c.width * k, baked.c.height * k);
      } else {
        ctx.fill(e.path);
      }
      if (blending || baked) ctx.restore();
    }
    return true;
  }

  /** A non-solid pattern fill rasterised at `s` device px per world unit, its origin on
   * the device pixel grid, so a tile can blit it pixel for pixel. Null when too big. */
  private fillRaster(el: FillShape, e: CacheEntry, s: number) {
    const hit = this.fillRasters.get(el.id);
    if (hit && hit.s === s) {
      this.fillRasters.delete(el.id); // most recently used goes last
      this.fillRasters.set(el.id, hit);
      return hit;
    }
    if (hit) {
      // another zoom's bake stands in (scaled) while the zoom settles or this frame's
      // raster time is spent; the tile is rebuilt once it's ready (see runTileJob)
      const now = performance.now();
      if (now - this.lastZoomChangeAt < 180 || now > this.rasterBudgetUntil) {
        this.rastersPending = true;
        return hit;
      }
    }
    this.dropFillRaster(el.id);
    const x = Math.floor(e.bbox.minX * s) - 1, y = Math.floor(e.bbox.minY * s) - 1;
    const w = Math.ceil(e.bbox.maxX * s) + 1 - x, h = Math.ceil(e.bbox.maxY * s) + 1 - y;
    if (w * h > FILL_RASTER_MAX) return null;
    // (the budget is for fills away from the screen: evicting one in view would only bake it again)
    for (const [id, r] of this.fillRasters) {
      if (this.fillRasterPx + w * h <= FILL_RASTER_BUDGET) break;
      if (this.keepRect && bboxIntersects(this.cache.get(id)?.bbox ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 }, this.keepRect) && r.s === s) continue;
      this.dropFillRaster(id);
    }
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    if (!g) { c.width = c.height = 0; return null; } // out of canvas memory: fill directly
    if (isMotif(el.pattern!)) {
      c.width = c.height = 0; // (baked by bakeDotsUntil instead)
      this.bakeDotsUntil(el, e.bbox, s, Infinity);
      return this.fillRasters.get(el.id)?.s === s ? this.fillRasters.get(el.id)! : null;
    } else {
      g.setTransform(s, 0, 0, s, -x, -y);
      g.fillStyle = this.fillPattern(el.pattern!, el.color, isPixelPattern(el.pattern!) ? 0 : el.patternAngle ?? 0);
      g.fill(e.path);
    }
    const r = { c, s, x, y };
    this.fillRasters.set(el.id, r);
    this.fillRasterPx += w * h;
    return r;
  }
  /** Dot-tone bakes in progress: the same dots as the fill's path, drawn a chunk per slice
   * (a big sand fill is tens of thousands of arcs — too much for one frame). */
  private dotCache = new Map<string, { xy: Float32Array; n: number; r: number } | null>();
  private dotBakes = new Map<string, { s: number; x: number; y: number; c: HTMLCanvasElement; g: CanvasRenderingContext2D; next: number }>();
  private dotRate = 2000; // dots per ms, measured with the drawing forced to finish
  /** Advance (or start) the bake of dot-tone fill `el` at scale `s` until `until`; true once it's in fillRasters. */
  private bakeDotsUntil(el: FillShape, box: BBox, s: number, until: number): boolean {
    const have = this.fillRasters.get(el.id);
    if (have && have.s === s) return true;
    // another zoom's bake stands in while a zoom gesture is in flight (fillRaster scales it)
    if (have && performance.now() - this.lastZoomChangeAt < 180) return true;
    let dots = this.dotCache.get(el.id);
    if (dots === undefined) {
      dots = motifDots(el.points, el.pattern!, el.patternAngle ?? 0);
      if (dots) { // sorted by y: a band of the bake finds its dots by binary search
        const idx = Array.from({ length: dots.n }, (_, k) => k).sort((a, b) => dots!.xy[a * 2 + 1] - dots!.xy[b * 2 + 1]);
        const xy = new Float32Array(dots.n * 2);
        idx.forEach((k, i) => { xy[i * 2] = dots!.xy[k * 2]; xy[i * 2 + 1] = dots!.xy[k * 2 + 1]; });
        dots = { xy, n: dots.n, r: dots.r };
      }
      this.dotCache.set(el.id, dots);
    }
    if (!dots) return true; // (too many dots: drawn as a clipped pattern by fillRaster)
    let job = this.dotBakes.get(el.id);
    if (job && job.s !== s) { job.c.width = job.c.height = 0; this.dotBakes.delete(el.id); job = undefined; }
    if (!job) {
      const x = Math.floor(box.minX * s) - 1, y = Math.floor(box.minY * s) - 1;
      const w = Math.ceil(box.maxX * s) + 1 - x, h = Math.ceil(box.maxY * s) + 1 - y;
      if (w * h > FILL_RASTER_MAX) return true; // fillRaster declines: filled directly
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const g = c.getContext('2d');
      if (!g) { c.width = c.height = 0; return true; }
      g.setTransform(s, 0, 0, s, -x, -y);
      g.fillStyle = el.color;
      job = { s, x, y, c, g, next: 0 };
      this.dotBakes.set(el.id, job);
    }
    // band by band (rows of the bake, device px): every dot touching a band goes into one path
    // clipped to it, so each pixel gets all its dots in one fill — same coverage as the whole
    // path in one go (separate fills would darken where dots overlap)
    const H = job.c.height, d = dots;
    const firstAtOrAbove = (y: number) => { let lo = 0, hi = d.n; while (lo < hi) { const m = (lo + hi) >> 1; if (d.xy[m * 2 + 1] < y) lo = m + 1; else hi = m; } return lo; };
    const perRow = d.n / Math.max(1, H);
    while (job.next < H) {
      const t0 = performance.now();
      const rows = until === Infinity ? H : Math.max(4, Math.floor((this.dotRate * Math.max(0.5, until - t0)) / Math.max(1e-3, perRow)));
      const r0 = job.next, r1 = Math.min(H, r0 + rows);
      const wy0 = (job.y + r0) / s, wy1 = (job.y + r1) / s; // band in world y
      const reach = d.r + 2 / s; // a dot's antialiased edge spills a pixel or so past its radius
      const a = firstAtOrAbove(wy0 - reach), b = firstAtOrAbove(wy1 + reach);
      if (b > a) {
        const path = new Path2D();
        for (let k = a; k < b; k++) {
          const x = d.xy[k * 2], y = d.xy[k * 2 + 1];
          path.moveTo(x + d.r, y);
          path.arc(x, y, d.r, 0, Math.PI * 2);
        }
        job.g.save();
        job.g.beginPath();
        job.g.rect((job.x) / s - 1, wy0, job.c.width / s + 2, wy1 - wy0);
        job.g.clip();
        job.g.fill(path);
        job.g.restore();
        flushCanvas(job.g); // make WebKit draw it now: the time (and the rate) is real
        const dt = performance.now() - t0;
        if (b - a >= 200 && dt > 0.3) this.dotRate += ((b - a) / dt - this.dotRate) * 0.3;
      }
      job.next = r1;
      if (job.next < H && performance.now() > until) return false;
    }
    this.dotBakes.delete(el.id);
    this.dropFillRaster(el.id);
    for (const [id, r] of this.fillRasters) {
      if (this.fillRasterPx + job.c.width * job.c.height <= FILL_RASTER_BUDGET) break;
      if (this.keepRect && bboxIntersects(this.cache.get(id)?.bbox ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 }, this.keepRect) && r.s === s) continue;
      this.dropFillRaster(id);
    }
    this.fillRasters.set(el.id, { c: job.c, s, x: job.x, y: job.y });
    this.fillRasterPx += job.c.width * job.c.height;
    return true;
  }

  /** A pixel-pattern fill as an image with one pixel per cell, in its colour (zoom-free). */
  private cellImages = new Map<string, { c: HTMLCanvasElement; c0: number; r0: number; cols: number; rows: number; cell: number } | null>();
  private cellImage(el: FillShape) {
    let hit = this.cellImages.get(el.id);
    if (hit !== undefined) return hit;
    hit = null;
    const m = cellMask(el.points, el.pattern!);
    const rgb = /^#([0-9a-f]{6})$/i.exec(el.color);
    if (m && rgb) {
      const c = document.createElement('canvas');
      c.width = m.cols;
      c.height = m.rows;
      const g = c.getContext('2d');
      if (g) {
        const v = parseInt(rgb[1], 16), R = (v >> 16) & 255, G = (v >> 8) & 255, B = v & 255;
        const img = g.createImageData(m.cols, m.rows), d = img.data;
        for (let i = 0; i < m.mask.length; i++) if (m.mask[i]) { const o = i * 4; d[o] = R; d[o + 1] = G; d[o + 2] = B; d[o + 3] = 255; }
        g.putImageData(img, 0, 0);
        hit = { c, c0: m.c0, r0: m.r0, cols: m.cols, rows: m.rows, cell: m.cell };
      }
    }
    this.cellImages.set(el.id, hit);
    return hit;
  }
  private dropCellImage(id: string) {
    const h = this.cellImages.get(id);
    if (h) h.c.width = h.c.height = 0;
    this.cellImages.delete(id);
  }

  private dropDotBake(id: string) {
    const b = this.dotBakes.get(id);
    if (b) { b.c.width = b.c.height = 0; this.dotBakes.delete(id); }
  }

  private dropFillRaster(id: string) {
    const r = this.fillRasters.get(id);
    if (!r) return;
    this.fillRasterPx -= r.c.width * r.c.height;
    r.c.width = r.c.height = 0;
    this.fillRasters.delete(id);
  }

  /** Handles + selection outline for one element (main ctx, world transform). */
  private paintElementUi(el: Element, z: number) {
    const ctx = this.ctx;
    const selected = this.input.selection.has(el.id);
    if (this.input.presenting) return;
    if (el.kind === 'text' || el.kind === 'image') {
      const hovered = el.kind === 'text' ? this.input.hoverText === el.id : this.input.hoverImage === el.id;
      if (hovered || selected) this.drawBoxHandles(el.x, el.y, el.w, el.h, z, true);
      if (el.kind === 'text' && (hovered || selected || this.input.rolling.has(el.id))) this.drawDice(el.x, el.y, el.w, z, this.input.rolling.get(el.id));
      if (el.kind === 'text' && (hovered || selected)) this.drawStyleHandles(el, z);
      if (selected) {
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = '#E8590C';
        ctx.lineWidth = 1.5 / z;
        ctx.strokeRect(el.x - 2, el.y - 2, el.w + 4, el.h + 4);
      }
      return;
    }
    if (selected) {
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = '#E8590C';
      ctx.lineWidth = 1.5 / z;
      // (a fill's outline is the shape drawn — its pattern path would outline every cell / dot)
      if (el.kind === 'fill') ctx.stroke(polygonPath(el.points));
      else { const e = this.entry(el); ctx.stroke(e.core ?? e.path); }
    }
  }

  /** Outline detail bucket for the current zoom: 1 at 100%, doubling per
   * zoom octave. Cached outlines are rebuilt when the bucket changes so a
   * stroke has the same screen-space smoothness at every zoom level. */
  private detailOverride: number | null = null; // set while rendering an export
  private detail(): number {
    if (this.detailOverride !== null) return this.detailOverride;
    const rel = this.camera.zoom / baseZoom();
    return Math.min(16, Math.max(0.25, 2 ** Math.round(Math.log2(rel))));
  }

  /** per-frame painting (animated areas) may use an outline from another zoom's detail while
   * warmAreas rebuilds it in the background — rebuilding every frame's outlines in the frame the
   * zoom changes froze it */
  private staleOk = false;
  private entry(el: Stroke | FillShape): CacheEntry {
    const detail = this.detail();
    let e = this.cache.get(el.id);
    if (!e || (e.detail !== detail && !e.zoomFree && !this.staleOk)) {
      let path: Path2D, core: Path2D | undefined;
      if (el.kind === 'stroke' && el.tool === 'marker') {
        const mp = markerPaths(el.points, el.baseWidth, detail);
        path = mp.fill; core = mp.hull;
      } else if (el.kind === 'fill' && el.pattern && patternCellSize(el.pattern)) {
        // pixel patterns: solid geometry of the "on" cells inside the shape — whole cells,
        // no repeating tile, so no seams between pixels (zoom-independent)
        const cells = cellPath(el.points, el.pattern); // the pixel grid is fixed: what you see at 100% is what it is
        path = cells ?? polygonPath(el.points);
        e = { path, bbox: elementBBox(el), detail, zoomFree: true, solid: !!cells };
        this.cache.set(el.id, e);
        return e;
      } else if (el.kind === 'fill' && el.pattern && (path = motifPath(el.points, el.pattern, el.patternAngle ?? 0)!)) {
        // dot tones: whole dots only — the path IS the dots, filled solid (zoom-independent)
        e = { path, bbox: elementBBox(el), detail, solid: true, zoomFree: true };
        this.cache.set(el.id, e);
        return e;
      } else if (el.kind === 'fill') {
        path = polygonPath(el.points);
        e = { path, bbox: elementBBox(el), detail, zoomFree: true };
        this.cache.set(el.id, e);
        return e;
      } else {
        path = outlineToPath(strokeOutline(el, detail)); // strokes (fills were handled above)
      }
      e = { path, bbox: elementBBox(el), detail, core };
      if (el.kind === 'stroke' && el.tool === 'sketch') {
        e.passes = pencilOutlines(el, detail).map(outlineToPath);
      }
      this.cache.set(el.id, e);
    }
    return e;
  }

  // Graphite grain tile (kept for timed live-ink trails where stamping is too hot)
  private grainCache = new Map<string, CanvasPattern>();
  private grainPattern(color: string, z: number): CanvasPattern | string {
    let pat = this.grainCache.get(color);
    if (!pat) {
      const tile = document.createElement('canvas');
      tile.width = tile.height = 64;
      const c = tile.getContext('2d')!;
      c.fillStyle = color;
      // paper tooth: clustered specks + short directional streaks, uneven alpha
      for (let i = 0; i < 2200; i++) {
        c.globalAlpha = 0.2 + Math.random() * 0.75;
        c.fillRect(Math.random() * 64, Math.random() * 64, 1, 1);
      }
      for (let i = 0; i < 420; i++) {
        c.globalAlpha = 0.15 + Math.random() * 0.5;
        c.fillRect(Math.random() * 64, Math.random() * 64, 2 + Math.random() * 3, 1);
      }
      const made = this.ctx.createPattern(tile, 'repeat');
      if (!made) return color;
      pat = made;
      this.grainCache.set(color, pat);
    }
    pat.setTransform(new DOMMatrix().scale(1.3 / z));
    return pat;
  }

  private inkStyle(el: Stroke, z: number): CanvasPattern | string {
    return el.tool === 'pencil' || el.tool === 'sketch' ? this.grainPattern(el.color, z) : el.color;
  }

  // ---- pencil: stamp-based rendering (real brush-engine technique) ----
  // A soft grainy nib is stamped along the vector samples; low-alpha stamps
  // overlap and build up like graphite. Strokes are rasterized once per zoom
  // bucket and cached; the vector data stays the source of truth.
  // several nib variants per color — reusing one tile creates visible repeats
  private nibCache = new Map<string, { grain: HTMLCanvasElement[]; dense: HTMLCanvasElement[] }>();
  /** Two nib families per color: `grain` = toothy speckle for light pressure,
   * `dense` = soft solid disc with a little tooth for hard pressure. Stamps
   * cross-fade between them with pressure, so a hard line reads as an
   * almost solid graphite stroke instead of a darker cloud of dots. */
  private nibs(color: string) {
    let set = this.nibCache.get(color);
    if (!set) {
      set = { grain: [], dense: [] };
      // seeded: the same grain in every colour, every session and every engine (the GPU ones
      // stamp one colourless copy of these)
      let seed = 0x2f6b1d;
      const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
      for (let v = 0; v < 8; v++) {
        const n = document.createElement('canvas');
        n.width = n.height = 64;
        const c = n.getContext('2d')!;
        c.fillStyle = color;
        for (let i = 0; i < 1500; i++) {
          // radial falloff × speckle = soft toothy dot
          const r = Math.sqrt(random()) * 31;
          const ang = random() * Math.PI * 2;
          const fall = Math.pow(1 - r / 32, 1.4);
          c.globalAlpha = fall * (0.25 + random() * 0.75);
          c.fillRect(32 + Math.cos(ang) * r, 32 + Math.sin(ang) * r, 1.3, 1.3);
        }
        set.grain.push(n);

        const d = document.createElement('canvas');
        d.width = d.height = 64;
        const dc = d.getContext('2d')!;
        dc.fillStyle = color;
        // stacked soft rings → solid core, feathered rim
        for (let k = 0; k < 14; k++) {
          const rr = 30 * (1 - k / 14);
          dc.globalAlpha = 0.16;
          dc.beginPath();
          dc.arc(32 + (random() - 0.5) * 1.2, 32 + (random() - 0.5) * 1.2, rr, 0, Math.PI * 2);
          dc.fill();
        }
        // a little tooth so it still reads as graphite, not marker
        dc.globalCompositeOperation = 'destination-out';
        for (let i = 0; i < 260; i++) {
          const r = Math.sqrt(random()) * 30;
          const ang = random() * Math.PI * 2;
          dc.globalAlpha = 0.25 + random() * 0.5;
          dc.fillRect(32 + Math.cos(ang) * r, 32 + Math.sin(ang) * r, 1.2, 1.2);
        }
        set.dense.push(d);
      }
      this.nibCache.set(color, set);
    }
    return set;
  }

  /** Stamp positions for a stroke (zoom-independent), cached for committed strokes. */
  private stampsFor(el: Stroke, useCache: boolean) {
    const hit = useCache ? this.stampCache.get(el.id) : undefined;
    if (hit && hit.n === el.points.length) return hit.stamps;
    // same fast-ramping pressure response as the vector tools; pressure is
    // additionally smoothed along the line so stamp density doesn't flicker
    // with the Pencil's sample-to-sample pressure noise
    const raw = densify(filterPressure(el.points));
    const pts = raw.map((pt, i) => {
      let sum = 0, cnt = 0;
      for (let k = -4; k <= 4; k++) {
        const j = i + k;
        if (j >= 0 && j < raw.length) { sum += raw[j].p; cnt++; }
      }
      return { ...pt, p: easeP(sum / cnt, 'pencil') };
    });
    const wBase = el.baseWidth;
    const rnd = (i: number, salt: number) => {
      const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
      return x - Math.floor(x);
    };
    const spacingAt = (p: number) => Math.max(0.2, wBase * 0.3 * (1.35 - p * 0.9));
    const stamps: { x: number; y: number; p: number; a?: number }[] = [];
    if (pts.length === 1) {
      const c = pts[0];
      const R = wBase * 0.6;
      const n = Math.round(14 + c.p * 30);
      for (let i = 0; i < n; i++) {
        const a = rnd(i, 7) * Math.PI * 2;
        const d = Math.sqrt(rnd(i, 8)) * R;
        stamps.push({ x: c.x + Math.cos(a) * d, y: c.y + Math.sin(a) * d, p: c.p, a: c.a });
      }
    }
    let carry = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (!len) continue;
      let d = carry;
      while (d < len) {
        const t = d / len;
        const p = a.p + (b.p - a.p) * t;
        const tl = a.a !== undefined && b.a !== undefined ? a.a + (b.a - a.a) * t : a.a ?? b.a;
        stamps.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, p, a: tl });
        d += spacingAt(p);
      }
      carry = d - len;
    }
    if (useCache) this.stampCache.set(el.id, { n: el.points.length, stamps });
    return stamps;
  }

  /** Draw a pencil stroke's stamps. `minSpacing` (world units) skips stamps
   * closer than that — set to ~0.7 device px so zoomed-out rasters cost a
   * fraction of the draws; alpha is boosted to keep the same darkness. */
  private stampStroke(
    target: CanvasRenderingContext2D, el: Stroke, alphaScale = 1, fromIndex = 0,
    opts: StampOpts = {},
  ): number {
    const nib = this.nibs(el.color);
    const cull = opts.cull;
    const n = this.eachStamp(el, alphaScale, fromIndex, opts, (x, y, r, rot, alpha, layer) => {
      if (cull) {
        const m = r * 1.5; // rotated square's reach
        if (x + m < cull.x || y + m < cull.y || x - m > cull.x + cull.w || y - m > cull.y + cull.h) return;
      }
      target.save();
      target.translate(x, y);
      target.rotate(rot);
      target.globalAlpha = alpha;
      target.drawImage(layer < 8 ? nib.grain[layer] : nib.dense[layer - 8], -r, -r, r * 2, r * 2);
      target.restore();
    });
    target.globalAlpha = 1;
    return n;
  }

  /** The stamp engine: every nib stamp of a stroke (from `fromIndex`) as centre, radius,
   * rotation, alpha and nib (0–7 grain, 8–15 dense), in world units. Shared by the Canvas 2D
   * stamper and the GPU one. Returns the stroke's stamp count. */
  private eachStamp(
    el: Stroke, alphaScale: number, fromIndex: number, opts: StampOpts,
    put: (x: number, y: number, r: number, rot: number, alpha: number, layer: number) => void,
  ): number {
    const stamps = this.stampsFor(el, opts.cache ?? false);
    const minSpacing = opts.minSpacing ?? 0;
    const wBase = el.baseWidth;
    // deterministic per-stamp randomness: variant, rotation, jitter — kills the
    // repeated-texture chain look of reusing one tile in one orientation
    const rnd = (i: number, salt: number) => {
      const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
      return x - Math.floor(x);
    };
    // (resumable: `state` carries the merging across calls, `until` stops at a deadline;
    // returns the index to resume from — the stamp count when done)
    const run = opts.state ?? { sinceX: NaN, sinceY: NaN, skipped: 0 };
    let { sinceX, sinceY, skipped } = run;
    for (let i = fromIndex; i < stamps.length; i++) {
      if ((opts.limit !== undefined && i >= opts.limit) || (opts.until !== undefined && (i & 31) === 0 && i > fromIndex && performance.now() > opts.until)) {
        run.sinceX = sinceX; run.sinceY = sinceY; run.skipped = skipped;
        return i;
      }
      const st = stamps[i];
      if (minSpacing > 0 && !Number.isNaN(sinceX) && Math.hypot(st.x - sinceX, st.y - sinceY) < minSpacing) {
        skipped++;
        continue;
      }
      sinceX = st.x; sinceY = st.y;
      const boost = 1 + skipped; // stamps merged into this one
      skipped = 0;
      // graphite sharpens as you press: the faint halo is widest at light
      // pressure, the solid core that takes over is narrower than the halo
      // a flat Pencil lays the side of the graphite down: light strokes get
      // much wider and fainter (shading); pressing hard sharpens back to a line
      const tiltMul = 1 + (pressure.pencil.tilt - 1) * easeTilt(st.a ?? 0, 'pencil') * (1 - st.p);
      // min/max width from the playground shape the effective width (st.p is already eased)
      const kp = pressure.pencil;
      const wEff = wBase * kp.max * (kp.min + (1 - kp.min) * st.p);
      const r = wEff * (0.72 - st.p * 0.12) * tiltMul * (0.98 + rnd(i, 3) * 0.04);
      const jx = (rnd(i, 1) - 0.5) * r * 0.07;
      const jy = (rnd(i, 2) - 0.5) * r * 0.07;
      const wobble = 0.9 + rnd(i, 4) * 0.2;
      const rot = rnd(i, 5) * Math.PI * 2;
      // grain: present from the lightest touch, fades back as the core takes over
      const grainA = (0.16 + st.p * 0.3) * (1 - Math.max(0, st.p - 0.55) * 0.9) / Math.sqrt(tiltMul);
      // (n merged stamps of alpha a lay down 1 − (1 − a)ⁿ, not n·a — linear made far zooms darker)
      const merge = (a: number) => (boost === 1 ? Math.min(1, a) : 1 - Math.pow(1 - Math.min(1, a), boost));
      put(st.x + jx, st.y + jy, r, rot, merge(alphaScale * grainA * wobble), Math.floor(rnd(i, 6) * 8));
      // dense core: kicks in past mid pressure, near-solid at full
      const core = Math.max(0, (st.p - 0.4) / 0.6);
      if (core > 0) {
        const rc = wEff * (0.62 - core * 0.2) * (0.98 + rnd(i, 3) * 0.04);
        put(st.x + jx, st.y + jy, rc, rot, merge(alphaScale * Math.pow(core, 1.3) * 0.9 * wobble), 8 + Math.floor(rnd(i, 9) * 8));
      }
    }
    run.sinceX = sinceX; run.sinceY = sinceY; run.skipped = skipped;
    return stamps.length;
  }

  /** A pencil stroke's stamps that land on tile (i, j), drawn on the GPU in one go and composited
   * into the tile. False → stamp it in 2D. */
  private gpuStampTile(g: CanvasRenderingContext2D, el: Stroke, alpha: number, set: TileSet, view: View, i: number, j: number): boolean {
    if (this.glPencil === undefined) {
      this.glPencil = GLPencil.create();
      try {
        localStorage.setItem('izine-gpu-pencil', this.glPencil ? 'running' : 'off');
        if (this.glPencil) {
          // only a death in the foreground counts: going to the background (or away) clears the flag
          const mark = (on: boolean) => { try { if (on) localStorage.setItem('izine-gpu-pencil', 'running'); else localStorage.removeItem('izine-gpu-pencil'); } catch { /* ignore */ } };
          window.addEventListener('pagehide', () => mark(false));
          document.addEventListener('visibilitychange', () => mark(document.visibilityState === 'visible'));
        }
      } catch { /* ignore */ }
    }
    const gp = this.glPencil;
    if (!gp || !gp.ok) return false;
    const s = set.s, ox = i * TILE, oy = j * TILE;
    const minSpacing = set.draft ? Math.max(0.7 / s, el.baseWidth * 0.5) : 0.7 / s;
    let n = 0;
    this.eachStamp(el, alpha, 0, { minSpacing, cache: true }, (x, y, r, rot, a, layer) => {
      const m = r * 1.5;
      if (x + m < view.x || y + m < view.y || x - m > view.x + view.w || y - m > view.y + view.h) return;
      if ((n + 1) * STAMP_FLOATS > this.glStamps.length) {
        const grown = new Float32Array(this.glStamps.length * 2);
        grown.set(this.glStamps);
        this.glStamps = grown;
      }
      const d = this.glStamps, k = n * STAMP_FLOATS;
      d[k] = x * s - ox; d[k + 1] = y * s - oy; d[k + 2] = r * s; d[k + 3] = rot; d[k + 4] = a; d[k + 5] = layer;
      n++;
    });
    if (!n) return true;
    const nib = this.nibs(el.color);
    return gp.stampInto(g, TILE, TILE, el.color, [...nib.grain, ...nib.dense], this.glStamps, n);
  }

  /** A committed pencil stroke rasterised on the GPU (see glpencil.ts); null → stamp in 2D. */
  // GPU pencil (see glpencil.ts): on unless a session died while it was on — WebKit once dropped
  // the page with it (then, per-stroke bitmaps were eating ~800 MB). The guard flag is set while
  // the page runs with it and cleared when the page goes away cleanly.
  private glPencil: GLPencil | null | undefined = (() => {
    try {
      // (opt-in: in WebKit a 2D canvas rasterises on the CPU, so every GPU result has to be read
      // back to land in a tile — slower than stamping in 2D. Kept for experiments: set 'on')
      const st = localStorage.getItem('izine-gpu-pencil');
      if (st === 'running') { localStorage.setItem('izine-gpu-pencil', 'off'); return null; }
      return st === 'on' ? undefined : null;
    } catch { return null; }
  })();
  private glStamps = new Float32Array(STAMP_FLOATS * 4096);
  private gpuPencilRaster(el: Stroke, w: number, h: number, bucket: number, bbox: BBox): HTMLCanvasElement | null {
    if (this.glPencil === undefined) this.glPencil = GLPencil.create();
    const gp = this.glPencil;
    if (!gp || !gp.ok) return null;
    let n = 0;
    const ox = bbox.minX, oy = bbox.minY;
    this.eachStamp(el, 1, 0, { minSpacing: 0.7 / bucket, cache: true }, (x, y, r, rot, alpha, layer) => {
      if ((n + 1) * STAMP_FLOATS > this.glStamps.length) {
        const grown = new Float32Array(this.glStamps.length * 2);
        grown.set(this.glStamps);
        this.glStamps = grown;
      }
      const d = this.glStamps, k = n * STAMP_FLOATS;
      d[k] = (x - ox) * bucket; d[k + 1] = (y - oy) * bucket; d[k + 2] = r * bucket; d[k + 3] = rot;
      d[k + 4] = alpha; d[k + 5] = layer;
      n++;
    });
    const nib = this.nibs(el.color);
    return gp.render(w, h, el.color, [...nib.grain, ...nib.dense], this.glStamps, n);
  }

  // incremental live-pencil raster: only NEW stamps are drawn each frame, so
  // long strokes never truncate while drawing
  private liveStamp: {
    canvas: HTMLCanvasElement;
    strokeId: string;
    count: number;
    cam: { x: number; y: number; zoom: number };
  } | null = null;

  private drawLivePencil(live: Stroke, vw: number, vh: number, dpr: number) {
    const { ctx, camera } = this;
    const camNow = { x: camera.x, y: camera.y, zoom: camera.zoom };
    let ls = this.liveStamp;
    const stale =
      !ls ||
      ls.strokeId !== live.id ||
      ls.canvas.width !== vw * dpr ||
      ls.canvas.height !== vh * dpr ||
      ls.cam.x !== camNow.x || ls.cam.y !== camNow.y || ls.cam.zoom !== camNow.zoom;
    if (stale) {
      const canvas = ls?.canvas ?? document.createElement('canvas');
      canvas.width = vw * dpr;
      canvas.height = vh * dpr;
      ls = { canvas, strokeId: live.id, count: 0, cam: camNow };
      this.liveStamp = ls;
    }
    const oc = ls!.canvas.getContext('2d')!;
    oc.setTransform(dpr, 0, 0, dpr, 0, 0);
    oc.translate(vw / 2, vh / 2);
    oc.scale(camNow.zoom, camNow.zoom);
    oc.translate(-camNow.x, -camNow.y);
    const shown = live.points.length > 2
      ? { ...live, points: this.livePencilSmooth.update(live.id, live.points, pressure[live.tool].smooth / camNow.zoom, this.input.liveStable) }
      : live;
    ls!.count = this.stampStroke(oc, shown, live.opacity, ls!.count);
    // blit in screen space (we're inside the world transform here)
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.drawImage(ls!.canvas, 0, 0, vw, vh);
    ctx.restore();
  }

  /** Spare time in a frame: build the outlines / pencil rasters of the in-view areas' frames
   * that aren't showing yet. Each frame is otherwise built the first time it shows (and again
   * after every zoom), so the first loop stutters and drops frames before it settles. */
  private warmed = '';
  private warmAreas(view: View, z: number, until: number) {
    const areas = this.store.doc.areas.filter((a) => this.areaInView(a, view));
    if (!areas.length) return;
    const key = [this.detail(), Math.round(Math.log2(Math.max(1 / 64, Math.min(8, z)))), this.store.doc.elements.length, ...areas.map((a) => a.id)].join('|');
    if (key === this.warmed) return; // everything here is built for this zoom already
    const frames = new Set<string>(), ids = new Set<string>();
    for (const a of areas) { ids.add(a.id); for (const l of a.layers) for (const f of l.frames) frames.add(f.id); }
    for (const el of this.store.doc.elements) {
      if (el.kind !== 'stroke' && el.kind !== 'fill') continue;
      if (!(el.frame && frames.has(el.frame))) continue; // (timed live ink is built per frame anyway)
      if (performance.now() > until) { this.dirty = true; return; }
      this.entry(el);
      if (el.kind === 'stroke' && el.tool === 'pencil') {
        if (!this.pencilRaster(el, z)) { this.dirty = true; return; } // still stamping: next frame
      }
    }
    this.warmed = key;
  }

  /** Keyframe bitmaps: each keyframe of a playing area rendered once at the zoom level (√2 steps,
   * like the tiles), drawn scaled in between; a frame's bitmap is redone when its ink changes or
   * the zoom settles on another level. Playback is then a blit per layer, however heavy the ink. */
  private frameBitmaps = new Map<string, { c: HTMLCanvasElement; x: number; y: number; w: number; h: number; s: number; key: string }>();
  private frameBitmapPx = 0;
  private frameKey(els: Element[]): string { return `${this.contentKey()}|${els.length}`; }
  /** Draw keyframe `fid` from its bitmap (made now if missing and there's time); false → draw it the usual way. */
  private blitFrame(fid: string, els: Element[], dim: number): boolean {
    let b = this.frameBitmaps.get(fid);
    const s = this.levelFor(this.camera.zoom);
    const zooming = performance.now() - this.lastZoomChangeAt < 180;
    const key = this.frameKey(els);
    if (!b || b.key !== key || (b.s !== s && !zooming)) {
      if (b && b.key === key && zooming) { /* (mid-zoom: the old level, scaled) */ } else {
        b = this.renderFrame(fid, els, s) ?? undefined;
        if (!b) return false;
      }
    }
    if (!b.c.width) return true; // (an empty frame)
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = dim;
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(b.c, b.x, b.y, b.w, b.h);
    ctx.restore();
    // (most recently used last)
    this.frameBitmaps.delete(fid);
    this.frameBitmaps.set(fid, b);
    return true;
  }
  private renderFrame(fid: string, els: Element[], level: number) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const el of els) { const b = this.elBox(el); minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY); maxX = Math.max(maxX, b.maxX); maxY = Math.max(maxY, b.maxY); }
    this.dropFrameBitmap(fid);
    const key = this.frameKey(els);
    if (!els.length) { const e = { c: document.createElement('canvas'), x: 0, y: 0, w: 0, h: 0, s: level, key }; e.c.width = 0; this.frameBitmaps.set(fid, e); return e; }
    let s = level;
    const pad = 2 / s;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    while (((maxX - minX) * s > 4096 || (maxY - minY) * s > 4096) && s > 1 / 64) s /= 2;
    const x = Math.floor(minX * s) / s, y = Math.floor(minY * s) / s;
    const W = Math.ceil((maxX - x) * s), H = Math.ceil((maxY - y) * s);
    const px = W * H;
    // room for it: the least recently used go (frames in view were just used: they stay)
    for (const [id, b] of this.frameBitmaps) {
      if (this.frameBitmapPx + px <= FRAME_BITMAP_BUDGET) break;
      this.frameBitmapPx -= b.c.width * b.c.height; b.c.width = b.c.height = 0; this.frameBitmaps.delete(id);
    }
    if (this.frameBitmapPx + px > FRAME_BITMAP_BUDGET) return null; // (too big to keep: drawn straight)
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    if (!g) return null;
    const saved = this.ctx;
    this.ctx = g;
    this.tileScale = s;
    try {
      g.setTransform(s, 0, 0, s, -x * s, -y * s);
      const view = { x, y, w: W / s, h: H / s };
      for (const el of els) this.paintElement(el, view, this.camera.zoom, 1);
    } finally {
      this.ctx = saved;
      this.tileScale = null;
      g.setTransform(1, 0, 0, 1, 0, 0);
    }
    const e = { c, x, y, w: W / s, h: H / s, s: level, key };
    this.frameBitmaps.set(fid, e);
    this.frameBitmapPx += px;
    return e;
  }
  private dropFrameBitmap(fid: string) {
    const b = this.frameBitmaps.get(fid);
    if (!b) return;
    this.frameBitmapPx -= b.c.width * b.c.height;
    b.c.width = b.c.height = 0;
    this.frameBitmaps.delete(fid);
  }
  /** With time to spare: the keyframes of the playing areas in view that have no bitmap yet,
   * the ones coming up soonest first (about the next two seconds of every layer). */
  private preRenderFrames(view: View, until: number, frameEls: (fid: string) => Element[]) {
    if (performance.now() > until || performance.now() - this.lastZoomChangeAt < 180) return;
    const s = this.levelFor(this.camera.zoom);
    const now = animClock.now();
    for (const area of this.store.doc.areas) {
      if (!this.areaInView(area, view) || (area.id === this.input.activeAreaId && !this.input.playingAreas)) continue;
      const tick = Math.floor((now - this.input.playEpoch) * area.fps);
      for (const layer of area.layers) {
        if (layer.hidden || layer.kind === 'live' || !layer.frames.length) continue;
        const total = layer.frames.reduce((a, f) => a + f.duration, 0);
        // walk the next ~2 s of this layer's timeline, in order
        for (let k = 0, seen = 0; k < Math.min(total, area.fps * 2) && seen < layer.frames.length; k++) {
          const fid = frameAtTick(layer.frames, ((tick + k) % total + total) % total);
          if (!fid) continue;
          const els = frameEls(fid);
          const b = this.frameBitmaps.get(fid);
          if (b && b.key === this.frameKey(els) && b.s === s) continue;
          seen++;
          if (!this.renderFrame(fid, els, s)) return;
          if (performance.now() > until) { this.dirty = true; return; }
        }
      }
    }
  }

  /** iPad app: tell the native ink overlay how the live stroke looks and what has been painted,
   * so it draws only the newest piece (see ios/InfiniZine/InkOverlay.swift). */
  private inkReported = '';
  private reportInk(live: Stroke | null) {
    if (!live) {
      if (this.inkReported) postNative({ type: 'ink', active: false }); // (the stroke's done: overlay off)
      this.inkReported = '';
      return;
    }
    if (live.id !== this.inkReported) {
      this.inkReported = live.id;
      // opaque ink only: the overlay overlapping translucent ink (marker, pencil grain) would show
      const ok = (live.tool === 'pen' || live.tool === 'fineliner') && live.opacity >= 1 && !live.area && !this.input.patternInk();
      const widths = ok ? Array.from({ length: 11 }, (_, i) => widthAt(live.tool, live.baseWidth, i / 10) * this.camera.zoom) : [];
      postNative({ type: 'ink', active: ok, color: live.color, widths });
    }
    postNative({ type: 'painted', t: perfToNative(this.input.lastSampleAt) });
  }

  private pencilCache = new Map<string, { c: HTMLCanvasElement; bucket: number; bbox: BBox }>();
  /** A committed pencil stroke as a bitmap at the current zoom bucket. Stamping one can take
   * hundreds of ms on an iPad, so it's a job stamped a slice per frame (see advancePencilJob);
   * until it's done this returns the previous zoom's raster (drawn scaled) or null (the
   * caller draws a quick vector stand-in), and the tiles under it are refreshed when it lands. */
  private pencilJobs = new Map<string, PencilJob>();
  private pencilRaster(el: Stroke, z: number): { c: HTMLCanvasElement; bucket: number; bbox: BBox } | null {
    // raster resolution = zoom bucket × device pixel ratio, so a cached pencil
    // stroke is as sharp on a retina screen as the live one being drawn
    const dpr = window.devicePixelRatio || 1;
    // (down to 1/64: zoomed far out the whole zine is on screen, and every stroke's raster
    // at a coarser floor would be many times the pixels shown — iOS kills the page for it)
    let bucket = Math.pow(2, Math.round(Math.log2(Math.max(1 / 64, Math.min(8, z))))) * dpr;
    const hit = this.pencilCache.get(el.id);
    if (hit && hit.bucket === bucket) {
      this.pencilCache.delete(el.id); // most recently used goes last
      this.pencilCache.set(el.id, hit);
      return hit;
    }
    const exporting = this.detailOverride !== null; // exports and thumbnails: always the real thing, now
    // mid-zoom: keep drawing the old one scaled; rebuild once the zoom settles
    if (hit && !exporting && performance.now() - this.lastZoomChangeAt < 180) { this.rastersPending = true; return hit; }
    const bbox = elementBBox(el);
    let w = Math.max(1, Math.ceil((bbox.maxX - bbox.minX) * bucket));
    let h = Math.max(1, Math.ceil((bbox.maxY - bbox.minY) * bucket));
    while ((w > 4096 || h > 4096) && bucket > 1 / 64) {
      bucket /= 2;
      w = Math.max(1, Math.ceil((bbox.maxX - bbox.minX) * bucket));
      h = Math.max(1, Math.ceil((bbox.maxY - bbox.minY) * bucket));
    }
    if (hit && hit.bucket === bucket) return hit;
    let job = this.pencilJobs.get(el.id);
    if (job && job.bucket !== bucket) { this.dropPencilJob(el.id); job = undefined; }
    if (!job) {
      // the cap is for strokes away from the screen: evicting one in view would only have it
      // stamped again (and evict another…)
      for (const [id, r] of this.pencilCache) {
        if (this.pencilRasterPx + w * h <= PENCIL_RASTER_BUDGET) break;
        if (id === el.id || (this.keepRect && bboxIntersects(r.bbox, this.keepRect))) continue;
        this.dropPencilRaster(id);
      }
      const gpu = this.gpuPencilRaster(el, w, h, bucket, bbox); // (opt-in, see glPencil)
      if (gpu) return this.installPencilRaster(el.id, gpu, bucket, bbox);
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const g = c.getContext('2d');
      if (!g) {
        // out of canvas memory: free what we can and draw a stand-in this time
        c.width = c.height = 0;
        for (const id of [...this.pencilCache.keys()]) this.dropPencilRaster(id);
        return null;
      }
      job = { el, bucket, bbox, c, g, next: 0, state: { sinceX: NaN, sinceY: NaN, skipped: 0 } };
      this.pencilJobs.set(el.id, job);
    }
    if (this.advancePencilJob(job, exporting ? Infinity : this.rasterBudgetUntil)) return this.pencilCache.get(el.id)!;
    return hit ?? null;
  }

  /** Stamp a pencil job until `until`; true once it's done and in the cache. */
  private advancePencilJob(job: PencilJob, until: number): boolean {
    const { el, g, bucket, bbox } = job;
    g.setTransform(bucket, 0, 0, bucket, -bbox.minX * bucket, -bbox.minY * bucket);
    // stamps closer than ~0.7 device px are invisible: skip them (alpha-compensated)
    job.next = this.stampStroke(g, el, 1, job.next, { minSpacing: 0.7 / bucket, cache: true, until, state: job.state });
    if (job.next < this.stampsFor(el, true).length) return false;
    this.pencilJobs.delete(el.id);
    this.installPencilRaster(el.id, job.c, bucket, bbox);
    this.dirty = true;
    return true;
  }

  private installPencilRaster(id: string, c: HTMLCanvasElement, bucket: number, bbox: BBox) {
    this.dropPencilRaster(id);
    const entry = { c, bucket, bbox };
    this.pencilCache.set(id, entry);
    this.pencilRasterPx += c.width * c.height;
    return entry;
  }

  /** Spare time in a frame (at least `min` ms): carry on with the pencil jobs, oldest first
   * (they were started centre-out with the tiles). */
  private advancePencilJobs(min: number) {
    const until = Math.max(this.rasterBudgetUntil, performance.now() + min);
    for (const job of [...this.pencilJobs.values()]) {
      if (performance.now() > until) break;
      this.advancePencilJob(job, until);
    }
    if (this.pencilJobs.size) this.dirty = true;
  }

  private dropPencilJob(id: string) {
    const job = this.pencilJobs.get(id);
    if (!job) return;
    job.c.width = job.c.height = 0;
    this.pencilJobs.delete(id);
  }

  private dropPencilRaster(id: string) {
    const r = this.pencilCache.get(id);
    if (!r) return;
    this.pencilRasterPx -= r.c.width * r.c.height;
    r.c.width = r.c.height = 0; // frees the backing store now
    this.pencilCache.delete(id);
  }

  private draw() {
    const { canvas, camera } = this;
    const mainCtx = this.ctx;
    let ctx = mainCtx; // closures below draw through this; swapped to the bake bitmap while freezing areas
    const dpr = window.devicePixelRatio || 1;
    const vw = canvas.clientWidth, vh = canvas.clientHeight;
    if (!vw || !vh) return; // hidden (e.g. the playground's scratch canvas while closed)
    const frameStart = performance.now();
    if (camera.zoom !== this.lastZoom) { this.lastZoom = camera.zoom; this.lastZoomChangeAt = frameStart; }
    this.rasterBudgetUntil = frameStart + this.buildBudget(); // ms of raster (re)building per frame
    this.rastersPending = false;
    if (canvas.width !== vw * dpr || canvas.height !== vh * dpr) {
      canvas.width = vw * dpr;
      canvas.height = vh * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const presenting = this.input.presenting;
    const paper = this.store.doc.paper ?? '#F7F4EC';
    const live = this.input.live;

    // Static layers for the committed, non-animated content. Skipped while
    // presenting (page clip); elements the eraser hides are left out of their tiles.
    // The back bitmap goes down now; the front one after a paint-behind live stroke.
    const viewNow = camera.viewport(vw, vh);
    this.trackMotion(frameStart, dpr);
    const gpuOn = this.gpuActive() && !presenting;
    // a crowded view (far out over a big zine) isn't listed element by element each frame: the
    // 2D renderer can't draw it straight from vectors anyway, the GPU one switches to its tiles
    const crowd = gpuOn ? GPU_CROWD : this.opts.vector === 'always' ? Infinity : CANVAS_CROWD;
    const crowded = !presenting && crowd !== Infinity && this.index().still.count({ minX: viewNow.x, minY: viewNow.y, maxX: viewNow.x + viewNow.w, maxY: viewNow.y + viewNow.h }, crowd) >= crowd;
    const inViewNow = presenting || crowded ? [] : this.stillIn(viewNow);
    const vector = !presenting && !gpuOn && !crowded && this.decideVector(inViewNow);
    if (crowded && !gpuOn) this.vectorMode = false;
    const useStatic = !presenting && !vector;
    let blitFront: () => void = () => {};
    if (gpuOn) {
      // the GPU draws the paper, its grid and all the still ink underneath; this canvas only what moves
      // (what the eraser hides or brings back: its far tiles there are rendered again)
      const hid = this.input.hidden;
      if (hid.size || this.gpuHidden.size) {
        const boxes: BBox[] = [];
        for (const id of hid) if (!this.gpuHidden.has(id)) { const el = this.ix.byId.get(id); if (el) boxes.push(this.elBox(el)); }
        for (const id of this.gpuHidden) if (!hid.has(id)) { const el = this.ix.byId.get(id); if (el) boxes.push(this.elBox(el)); }
        if (boxes.length) { this.gpu!.staleRects(boxes); this.gpuHidden = new Set(hid); }
      }
      this.updatePaper(vw, vh, paper, false);
      ctx.clearRect(0, 0, vw, vh);
      const wm0 = this.worldMatrix(vw, vh, dpr);
      const pat = this.store.doc.pattern ?? 'dots';
      let sp = 10 * camera.zoom;
      while (sp < 8) sp *= 2;
      while (sp > 120) sp /= 2;
      const o = camera.worldToScreen(0, 0, vw, vh);
      const els = inViewNow.filter((el) => el.layer === 'back').concat(inViewNow.filter((el) => el.layer !== 'back'));
      const gpu = this.gpu!;
      gpu.render({
        W: vw * dpr, H: vh * dpr, dpr, s: wm0.s, ox: wm0.ox, oy: wm0.oy,
        dim: this.focusAreaId() ? 0.3 : 1, paper,
        grid: this.opts.grid && pat !== 'blank' ? { kind: pat === 'dots' ? 1 : pat === 'lines' ? 2 : 3, sp, x: o.x, y: o.y, dark: darkPaper(paper) } : null,
        els, far: crowded ? (r: View) => { const l = this.stillIn(r); return l.filter((el) => el.layer === 'back').concat(l.filter((el) => el.layer !== 'back')); } : undefined,
        moving: frameStart < this.movingUntil, detail: this.detail(), budget: Math.max(4, this.buildBudget()),
      });
      if (gpu.pending || gpu.farPending) this.dirty = true;
    } else if (useStatic) {
      this.updatePaper(vw, vh, paper, true);
      blitFront = this.drawStatic(vw, vh, dpr, frameStart);
    } else if (vector) {
      // vector mode: the paper behind, its grid first, the ink drawn straight over it below
      // (tiles keep building unseen, for when the view gets busier)
      this.drawStatic(vw, vh, dpr, frameStart, false);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.updatePaper(vw, vh, paper, true);
      ctx.clearRect(0, 0, vw, vh);
      if (this.opts.grid) this.drawPaperGrid(vw, vh, paper, 'source-over');
    } else {
      this.updatePaper(vw, vh, paper, false);
      // Desk (chosen paper color)
      ctx.fillStyle = paper;
      ctx.fillRect(0, 0, vw, vh);
    }

    const view = camera.viewport(vw, vh);
    const z = camera.zoom;

    // World transform (offset at whole device pixels, like the static tiles)
    const wm = this.worldMatrix(vw, vh, dpr);
    ctx.save();
    ctx.setTransform(wm.s, 0, 0, wm.s, wm.ox, wm.oy);

    // When presenting, clip all ink to the current page (frames aren't drawn)
    if (presenting) {
      const p = this.input.presentPage;
      const clip = new Path2D();
      if (p) clip.rect(p.x, p.y, p.w, p.h);
      ctx.clip(clip);
    }

    // Elements, culled; 'back' layer first, then 'front' (paint-behind toggle)
    const selected = this.input.selection;
    // focus mode: while an area is being edited, everything outside it dims
    const focusAreaId = this.focusAreaId();
    let dimFactor = 1;
    const drawEl = (el: Element) => {
      if (this.paintElement(el, view, z, dimFactor)) this.paintElementUi(el, z);
    };
    const drawLive = () => {
      if (!live) return;
      // a live-ink stroke previews with a stroke-local trailing window:
      // the tail eats away behind the pen and never resets at the loop point
      if (live.area) {
        const tk = areaTick.get(live.area);
        if (tk) {
          const lastT = live.points[live.points.length - 1]?.t ?? 0;
          drawTimedWith(live, (t) => (lastT - t) * tk.fps);
          return;
        }
      }
      if (this.input.patternInk()) {
        // pattern brush preview: the outline filled with the pattern as it will commit
        // (pixel patterns snapped to grid cells; tones clipped, dots whole on commit)
        const pat = this.input.fillPattern!;
        const shown: Stroke = live.points.length > 2
          ? { ...live, points: this.liveSmooth.update(live.id, live.points, pressure[live.tool].smooth / this.camera.zoom, this.input.liveStable) }
          : live;
        const outline = strokeOutline(shown, 1, true).map(([x, y]) => ({ x, y }));
        let path: Path2D | null = null;
        if (isPixelPattern(pat)) {
          const b = elementBBox({ ...shown, points: outline.map((q) => ({ ...q, p: 1, t: 0 })) });
          const work = ((b.maxX - b.minX) / PIXEL_CELL) * ((b.maxY - b.minY) / PIXEL_CELL) * outline.length;
          if (work < 4e6) path = cellPath(outline, pat); // huge scribbles preview as vector
        }
        ctx.save();
        ctx.globalCompositeOperation = this.input.fillBlend;
        ctx.globalAlpha = live.opacity * this.input.inkDensity;
        ctx.fillStyle = path || isPixelPattern(pat) ? live.color : this.fillPattern(pat, live.color, this.input.liveToneAngle);
        ctx.fill(path ?? outlineToPath(strokeOutline(shown, this.detail(), true)));
        ctx.restore();
        return;
      }
      if (live.tool === 'pencil') {
        this.drawLivePencil(live, vw, vh, dpr);
        return;
      }
      // same screen-space denoise the stroke gets on commit, so the live line
      // looks like the final one and the tip never flickers on sample jitter
      const smoothed = live.points.length > 2
        ? this.liveSmooth.update(live.id, live.points, pressure[live.tool].smooth / this.camera.zoom, this.input.liveStable)
        : live.points;
      // run ahead to where the browser predicts the pen is going (never committed; replaced every event)
      const ahead = this.input.livePredicted;
      const shown: Stroke = { ...live, points: ahead.length ? smoothed.concat(ahead) : smoothed };
      if (live.tool === 'sketch') {
        ctx.save();
        ctx.globalCompositeOperation = 'multiply';
        ctx.fillStyle = live.color;
        for (const pass of pencilOutlines(shown, this.detail())) {
          ctx.globalAlpha = 0.42 * live.opacity;
          ctx.fill(outlineToPath(pass));
        }
        ctx.restore();
        return;
      }
      ctx.globalAlpha = live.opacity;
      ctx.fillStyle = this.inkStyle(live, z);
      const detail = this.detail();
      if (live.tool === 'marker' || live.tool === 'fineliner' || hasPressure(shown.points)) {
        // pressure outlines: only the tail is recomputed each frame (see LiveOutliner)
        const outline = live.tool === 'marker'
          ? (pts: StrokePoint[]) => markerPaths(pts, live.baseWidth, detail).fill
          : (pts: StrokePoint[]) => outlineToPath(strokeOutline({ ...live, points: pts }, detail, true));
        ctx.fill(this.liveOutliner.path(shown, this.liveSmooth.settled, detail, outline));
      } else {
        ctx.fill(outlineToPath(strokeOutline(shown, detail, true))); // pressureless (finger/mouse): perfect-freehand
      }
    };
    const drawLiveRaw = drawLive;
    const drawLiveTimed = () => { const t0 = performance.now(); drawLiveRaw(); this.perfLive = performance.now() - t0; };
    // Animation: each layer runs its own timeline. Deselected areas always play;
    // in the edited area, the active layer holds on the active frame and the other
    // layers hold at the same tick position.
    const now = animClock.now(); // playback time (frozen while inking)
    const realNow = performance.now() / 1000; // UI feedback (blink) keeps running
    const frameVis = new Map<string, boolean>();
    const areaTick = new Map<string, { tick: number; rawTick: number; total: number; loop: boolean; fps: number }>();
    // standard onion colors: previous frames red, next frame green
    const onionFrames = new Map<string, { alpha: number; color: string }>();

    const frameAtTick = (frames: { id: string; duration: number }[], tick: number, loop: boolean) => {
      const total = frames.reduce((a, f) => a + f.duration, 0);
      if (!total) return null;
      let t = loop ? ((tick % total) + total) % total : Math.min(tick, total - 1);
      for (const f of frames) {
        t -= f.duration;
        if (t < 0) return f.id;
      }
      return frames[frames.length - 1].id;
    };

    for (const area of this.store.doc.areas) {
      const editing =
        area.id === this.input.activeAreaId && !this.input.playingAreas && !this.input.presenting;
      // the area pipeline spans its longest keyframe track AND every non-looping
      // live line's end (start + drawing + decay); self-looping lines don't extend it
      let areaTotal = Math.max(1, ...area.layers.map((l) => l.frames.reduce((a, f) => a + f.duration, 0)));
      const areaStrokes = this.index().byArea.get(area.id) ?? [];
      for (const l of area.layers) {
        if (l.kind !== 'live' || l.loop !== false) continue;
        for (const el of areaStrokes) {
          if (el.kind !== 'stroke' || el.alayer !== l.id) continue;
          const drawn = (el.points[el.points.length - 1]?.t ?? 0) * area.fps;
          areaTotal = Math.max(
            areaTotal,
            Math.ceil((el.animStart ?? 0) + drawn + Math.max(1, el.animLife ?? 6)),
          );
        }
      }
      const rawTick = Math.floor((now - this.input.playEpoch) * area.fps);
      let playTick = rawTick;
      playTick = area.loop ? ((playTick % areaTotal) + areaTotal) % areaTotal : Math.min(playTick, areaTotal - 1);
      areaTick.set(area.id, { tick: playTick, rawTick, total: areaTotal, loop: area.loop, fps: area.fps });

      // edit position: the flipped-to tick, else the active frame's start (other layers hold there)
      let editTick = 0;
      let activeLayerId: string | null = null;
      if (editing && this.input.activeFrameId) {
        for (const l of area.layers) {
          let acc = 0;
          for (const f of l.frames) {
            if (f.id === this.input.activeFrameId) {
              editTick = acc;
              activeLayerId = l.id;
              break;
            }
            acc += f.duration;
          }
          if (activeLayerId) break;
        }
        if (this.input.editTick !== null) editTick = Math.max(0, Math.min(areaTotal - 1, this.input.editTick));
      }

      for (const l of area.layers) {
        let visId: string | null;
        if (editing && l.id === activeLayerId) {
          visId = this.input.activeFrameId;
          if (this.input.onionSkin && !this.input.onionMuted && visId) {
            // 3 back in red, 3 forward in green, fading with distance;
            // when looping, "forward" wraps around to the first frames
            const idx = l.frames.findIndex((f) => f.id === visId);
            const len = l.frames.length;
            const alphas = [0.35, 0.18, 0.08];
            for (let k = 1; k <= 3; k++) {
              // when looping, the frames before the first are the last ones
              const prevIdx = area.loop ? (((idx - k) % len) + len) % len : idx - k;
              if (prevIdx >= 0 && prevIdx !== idx && !onionFrames.has(l.frames[prevIdx].id)) {
                onionFrames.set(l.frames[prevIdx].id, { alpha: alphas[k - 1], color: '#D6336C' });
              }
              const nextIdx = area.loop ? (idx + k) % len : idx + k;
              if (nextIdx !== idx && nextIdx < len && !onionFrames.has(l.frames[nextIdx].id)) {
                onionFrames.set(l.frames[nextIdx].id, { alpha: alphas[k - 1] * 0.85, color: '#2F9E44' });
              }
            }
          }
        } else if (editing) {
          visId = frameAtTick(l.frames, editTick, false);
        } else {
          visId = frameAtTick(l.frames, playTick, false);
        }
        for (const f of l.frames) frameVis.set(f.id, f.id === visId);
      }
      if (editing) {
        const t = areaTick.get(area.id)!;
        areaTick.set(area.id, { ...t, tick: editTick, rawTick: editTick });
      }
    }

    // (no per-frame pass over the whole zine: the index hands out what each part draws)
    const ixNow = this.index();
    const hiddenNow = this.input.hidden;
    const frameEls = (fid: string) => (ixNow.byFrame.get(fid) ?? []).filter((el) => !hiddenNow.has(el.id));

    // Timed live-ink strokes. Each point lives `animLife` ticks after the moment
    // it was drawn. `ageOf` maps a point's draw-time to its current age in ticks:
    // stroke-local & continuous while drawing (never resets at the loop point),
    // wrapped onto the loop clock during playback.
    const drawTimedWith = (el: Stroke, ageOf: (t: number) => number, lifeOverride?: number) => {
      const life = Math.max(1, lifeOverride ?? el.animLife ?? 6);
      if (!el.animTaper) {
        // untapered: the whole stroke shows while any part of it is alive
        const anyAlive = el.points.some((pt) => {
          const a = ageOf(pt.t);
          return a >= 0 && a < life;
        });
        if (anyAlive) drawEl(el);
        return;
      }
      // tapered: keep only living points; the oldest shrink toward nothing
      const pts: StrokePoint[] = [];
      for (const pt of el.points) {
        const age = ageOf(pt.t);
        if (age >= 0 && age < life) {
          const k = 1 - age / life; // 1 = fresh, 0 = about to die
          pts.push({ ...pt, p: pt.p * (0.08 + 0.92 * k) });
        }
      }
      if (pts.length < 3 && !(el.points.length === 1 && pts.length === 1)) return; // dots survive
      if (el.tool === 'pencil') {
        // same stamp engine as static pencil, on the living slice
        this.stampStroke(ctx, { ...el, points: pts }, el.opacity * dimFactor);
        return;
      }
      ctx.globalAlpha = el.opacity * dimFactor;
      ctx.fillStyle = this.inkStyle(el, z);
      if (el.tool === 'marker') ctx.fill(markerPaths(pts, el.baseWidth, this.detail()).fill);
      else ctx.fill(outlineToPath(strokeOutline({ ...el, points: pts }, this.detail())));
      ctx.globalAlpha = 1;
    };

    // Live-line replay:
    // - loop ON (default): the line loops immediately on its OWN cycle
    //   (lead-in + drawing + decay), independent of the area loop.
    // - loop OFF: the line rides the area pipeline — starts at its start time,
    //   plays once, repeats only when the whole area loop restarts.
    const drawTimed = (
      el: Stroke,
      tk: { tick: number; rawTick: number; total: number; loop: boolean; fps: number },
      looping: boolean,
    ) => {
      const start = el.animStart ?? 0;
      const life = Math.max(1, el.animLife ?? 6);
      const drawnTicks = (el.points[el.points.length - 1]?.t ?? 0) * tk.fps;
      const cycle = Math.max(1, Math.ceil(start + drawnTicks + life));
      const r = looping
        ? tk.loop
          ? ((tk.rawTick % cycle) + cycle) % cycle
          : tk.rawTick
        : tk.tick; // area pipeline clock (wrapped/clamped by the area loop)
      drawTimedWith(el, (t) => r - start - t * tk.fps);
    };

    if (live?.layer === 'back') drawLiveTimed(); // live back-ink previews behind existing front ink
    if (useStatic) {
      blitFront(); // the front layer covers the live back-stroke, as committed ink would
      if (!gpuOn) {
        this.updateFloating(frameStart);
        this.drawFloating();
      }
      // bodies are in the static tiles; only handles/selection outlines here — for just the
      // elements that have them
      const uiIds = new Set<string>(selected);
      if (this.input.hoverText) uiIds.add(this.input.hoverText);
      if (this.input.hoverImage) uiIds.add(this.input.hoverImage);
      for (const id of this.input.rolling.keys()) uiIds.add(id);
      for (const id of uiIds) {
        const el = ixNow.byId.get(id);
        if (el && this.isStill(el) && !hiddenNow.has(id) && bboxIntersects(elementBBox(el), view)) this.paintElementUi(el, z);
      }
    } else {
      dimFactor = focusAreaId ? 0.3 : 1;
      const inView = vector ? inViewNow : this.stillIn(view);
      const t0 = performance.now();
      for (const el of inView) if (el.layer === 'back') drawEl(el);
      for (const el of inView) if (el.layer !== 'back') drawEl(el);
      // what a cheap element costs here, now and then (WebKit: with the drawing made to finish)
      if (vector && inView.length >= 20 && ++this.vecFrames % 30 === 0) {
        if (DEFERRED_CANVAS) ctx.getImageData(0, 0, 1, 1);
        const per = (performance.now() - t0) / inView.length;
        this.vecCost += (per - this.vecCost) * 0.3;
      }
      dimFactor = 1;
      if (vector) {
        this.updateFloating(frameStart, true);
        this.drawFloating();
      }
    }

    // Animated elements: per area, per layer (bottom first); frame ownership decides the layer
    const paintAreas = (only: (area: AnimArea) => boolean) => {
      for (const area of this.store.doc.areas) {
        if (!only(area) || !this.areaInView(area, view)) continue; // off-screen areas cost nothing
        dimFactor = focusAreaId && area.id !== focusAreaId ? 0.3 : 1;
        if (area.clip) {
          ctx.save();
          const cp = new Path2D();
          cp.rect(area.x, area.y, area.w, area.h);
          ctx.clip(cp);
        }
        for (const layer of area.layers) {
          if (layer.hidden) continue;
          if (layer.kind === 'live' ? area.hideLive : area.hideFrames) continue;
          const fids = new Set(layer.frames.map((f) => f.id));
          for (const [fid, onion] of onionFrames) {
            if (!fids.has(fid)) continue;
            ctx.save();
            ctx.globalAlpha = onion.alpha;
            ctx.fillStyle = onion.color;
            for (const el of frameEls(fid)) {
              const cached = el.kind === 'text' || el.kind === 'image' ? null : this.entry(el);
              if (cached) ctx.fill(cached.path);
            }
            ctx.restore();
          }
          // a playing area's keyframes come from bitmaps rendered once (and ahead of time: see preRenderFrames);
          // the area being edited is drawn straight (its frames change as you draw)
          const live = area.id === this.input.activeAreaId && !this.input.playingAreas && !this.input.presenting;
          for (const f of layer.frames) {
            if (frameVis.get(f.id) !== true) continue;
            const els = frameEls(f.id);
            if (live || !this.opts.frames || !this.blitFrame(f.id, els, dimFactor)) for (const el of els) drawEl(el);
            else for (const el of els) this.paintElementUi(el, z);
          }
          // live ink is motion — hidden while editing unless explicitly shown;
          // the ACTIVE live layer shows its strokes in full so you can identify them
          const editingArea =
            area.id === this.input.activeAreaId && !this.input.playingAreas && !this.input.presenting;
          const activeLive = editingArea && layer.kind === 'live' && layer.id === this.input.activeLayerId;
          const tk = editingArea && !this.input.showLiveInk && !activeLive ? undefined : areaTick.get(area.id);
          // selection feedback: recently-picked live layer blinks hard
          const prevDim = dimFactor;
          let blinkPulse = 0;
          if (this.input.blinkLayerId === layer.id) {
            const bt = realNow - this.input.blinkStart;
            if (bt < 1.4) {
              blinkPulse = Math.abs(Math.sin(bt * Math.PI * 2.5));
              dimFactor = prevDim * (0.05 + 0.95 * blinkPulse);
              this.dirty = true; // keep animating the blink
            } else {
              this.input.blinkLayerId = null;
            }
          }
          if (activeLive || tk) {
            const looping = layer.loop !== false;
            for (const el of ixNow.byArea.get(area.id) ?? []) {
              if (hiddenNow.has(el.id)) continue;
              if (
                el.kind === 'stroke' &&
                (el.alayer === layer.id || (!el.alayer && layer === area.layers[0]))
              ) {
                if (activeLive) drawEl(el);
                else if (tk) drawTimed(el, tk, looping);
                if (blinkPulse > 0) {
                  // pulsing accent outline so the pick is unmissable
                  ctx.save();
                  ctx.globalAlpha = blinkPulse;
                  ctx.strokeStyle = '#E8590C';
                  ctx.lineWidth = 5 / z;
                  const en = this.entry(el);
                  ctx.stroke(en.core ?? en.path);
                  ctx.restore();
                }
              }
            }
          }
          dimFactor = prevDim;
        }
        if (area.clip) ctx.restore();
        dimFactor = 1;
      }
    };
    const isEditing = (area: AnimArea) => area.id === this.input.activeAreaId && !this.input.playingAreas && !this.input.presenting;
    if (animClock.paused && useStatic) {
      // frozen: every deselected area comes from one bitmap painted at the pause; only the
      // edited area (onion skin, dimming, live layer feedback) is painted per frame
      const bake = this.animBake;
      const key = [this.viewKey(), animClock.stamp, this.input.hidden.size].join('|');
      if (bake.key !== key) {
        const c = bake.canvas;
        if (c.width !== vw * dpr || c.height !== vh * dpr) { c.width = vw * dpr; c.height = vh * dpr; }
        const g = c.getContext('2d')!;
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.clearRect(0, 0, c.width, c.height);
        g.save();
        g.setTransform(wm.s, 0, 0, wm.s, wm.ox, wm.oy);
        ctx = g; this.ctx = g;
        this.staleOk = true;
        try { paintAreas((a) => !isEditing(a)); } finally { ctx = mainCtx; this.ctx = mainCtx; this.staleOk = false; }
        g.restore();
        bake.key = key;
      }
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(bake.canvas, 0, 0);
      ctx.restore();
      this.staleOk = true;
      try { paintAreas(isEditing); } finally { this.staleOk = false; }
    } else {
      this.staleOk = true;
      try { paintAreas(() => true); } finally { this.staleOk = false; }
    }
    if (live && live.layer !== 'back') drawLiveTimed();
    if (nativeApp && !presenting) this.reportInk(live);
    ctx.globalAlpha = 1;
    if (!animClock.paused) this.warmAreas(view, z, frameStart + this.buildBudget());
    if (!animClock.paused && this.opts.frames) this.preRenderFrames(view, frameStart + this.buildBudget(), frameEls);
    if (this.pencilJobs.size) this.advancePencilJobs(1);

    // Page borders sit on top of everything
    if (!presenting) {
      for (const page of this.store.doc.pages) {
        this.drawPage(page, z);
        const pageSelected = this.input.selectedPageId === page.id;
        if (pageSelected) {
          ctx.globalAlpha = 0.9;
          ctx.strokeStyle = '#E8590C';
          ctx.lineWidth = 2 / z;
          ctx.strokeRect(page.x, page.y, page.w, page.h);
          ctx.globalAlpha = 1;
        }
        if (this.input.hoverPage === page.id || pageSelected) {
          // outlined grabber: frame only
          const mh = moveHandleRect(page.x, page.y, z);
          ctx.fillStyle = '#FDFCF8';
          ctx.strokeStyle = 'rgba(90,75,50,0.5)';
          ctx.lineWidth = 1.2 / z;
          ctx.fillRect(mh.x, mh.y, mh.s, mh.s);
          ctx.strokeRect(mh.x, mh.y, mh.s, mh.s);
          ctx.strokeStyle = '#2A241A';
          this.drawMoveCross(mh.x, mh.y, mh.s);
          // filled grabber: frame with content
          const ma = moveAllHandleRect(page.x, page.y, z);
          ctx.fillStyle = '#2A241A';
          ctx.fillRect(ma.x, ma.y, ma.s, ma.s);
          ctx.strokeStyle = '#FDFCF8';
          ctx.lineWidth = 1.6 / z;
          this.drawMoveCross(ma.x, ma.y, ma.s);
          // preview eye: quickly present just this page
          const ey = eyeHandleRect(page.x, page.y, z);
          ctx.fillStyle = '#FDFCF8';
          ctx.strokeStyle = 'rgba(90,75,50,0.5)';
          ctx.lineWidth = 1.2 / z;
          ctx.fillRect(ey.x, ey.y, ey.s, ey.s);
          ctx.strokeRect(ey.x, ey.y, ey.s, ey.s);
          ctx.strokeStyle = '#2A241A';
          ctx.beginPath();
          const ecx = ey.x + ey.s / 2, ecy = ey.y + ey.s / 2;
          ctx.ellipse(ecx, ecy, ey.s * 0.32, ey.s * 0.2, 0, 0, Math.PI * 2);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(ecx, ecy, ey.s * 0.09, 0, Math.PI * 2);
          ctx.fillStyle = '#2A241A';
          ctx.fill();
        }
      }
    }

    // Animation areas (frames + label), edit mode only
    if (!presenting) {
      for (const area of this.store.doc.areas) {
        const active = area.id === this.input.activeAreaId;
        ctx.setLineDash([7 / z, 5 / z]);
        ctx.lineWidth = (active ? 2 : 1.2) / z;
        ctx.strokeStyle = active ? '#7048E8' : 'rgba(112,72,232,0.45)';
        ctx.strokeRect(area.x, area.y, area.w, area.h);
        ctx.setLineDash([]);
        ctx.font = `500 ${11 / z}px "Libre Franklin Variable", sans-serif`;
        ctx.fillStyle = 'rgba(112,72,232,0.8)';
        ctx.textAlign = 'left';
        ctx.fillText(`${area.name} · ${area.fps}fps`, area.x + 2 / z, area.y - 6 / z);
        if (active || area.id === this.input.hoverArea) {
          this.drawBoxHandles(area.x, area.y, area.w, area.h, z);
          // second grabber: move frame WITH content (filled box + cross)
          const ma = moveAllHandleRect(area.x, area.y, z);
          ctx.fillStyle = '#2A241A';
          ctx.fillRect(ma.x, ma.y, ma.s, ma.s);
          ctx.strokeStyle = '#FDFCF8';
          ctx.lineWidth = 1.6 / z;
          this.drawMoveCross(ma.x, ma.y, ma.s);
        }
      }
      const ar = this.input.areaRect;
      if (ar) {
        ctx.setLineDash([7 / z, 5 / z]);
        ctx.lineWidth = 1.5 / z;
        ctx.strokeStyle = '#7048E8';
        ctx.strokeRect(ar.x, ar.y, ar.w, ar.h);
        ctx.setLineDash([]);
      }
    }

    // Cursor-tool marquee (rect select)
    const mq = this.input.marquee;
    if (mq) {
      ctx.setLineDash([6 / z, 5 / z]);
      ctx.lineWidth = 1.5 / z;
      ctx.strokeStyle = '#E8590C';
      ctx.save();
      ctx.globalAlpha = 0.08;
      ctx.fillStyle = '#E8590C';
      ctx.fillRect(mq.x, mq.y, mq.w, mq.h);
      ctx.restore();
      ctx.strokeRect(mq.x, mq.y, mq.w, mq.h);
      ctx.setLineDash([]);
    }

    // Text rectangle being drawn
    const tr = this.input.textRect;
    if (tr) {
      ctx.setLineDash([6 / z, 5 / z]);
      ctx.lineWidth = 1.5 / z;
      ctx.strokeStyle = '#E8590C';
      ctx.strokeRect(tr.x, tr.y, tr.w, tr.h);
      ctx.setLineDash([]);
    }

    // Lasso in progress
    const lassoRaw = this.input.lasso;
    if (lassoRaw && lassoRaw.length > 1) {
      // preview with the same smoothing the fill gets on commit
      const filling = FILL_TOOLS.has(this.input.tool);
      const lasso = filling && lassoRaw.length > 3
        ? denoiseClosed(this.input.tool === 'lasso-blob' ? closeBlob(lassoRaw) : lassoRaw, 3 / camera.zoom)
        : lassoRaw;
      ctx.beginPath();
      ctx.moveTo(lasso[0].x, lasso[0].y);
      for (const p of lasso) ctx.lineTo(p.x, p.y);
      ctx.setLineDash([6 / z, 5 / z]);
      ctx.lineWidth = 1.5 / z;
      ctx.strokeStyle = filling ? this.input.color : '#E8590C';
      if (filling) {
        ctx.save();
        ctx.globalAlpha = 0.25 * this.input.inkDensity;
        ctx.fillStyle = this.input.fillPattern ? this.fillPattern(this.input.fillPattern, this.input.color) : this.input.color;
        ctx.fill();
        ctx.restore();
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Eraser size ring under a pen or finger (a mouse has the cursor ring)
    const er = this.input.eraserAt;
    if (er && this.input.tool === 'eraser' && !presenting) {
      const r = this.input.eraserRadius(z);
      ctx.beginPath();
      ctx.arc(er.x, er.y, r, 0, Math.PI * 2);
      ctx.lineWidth = 2.6 / z;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.stroke();
      ctx.lineWidth = 1.2 / z;
      ctx.strokeStyle = 'rgba(42,36,26,0.9)';
      ctx.stroke();
    }

    ctx.restore();

    // Presentation: darken everything outside the current page
    if (presenting && this.input.presentPage) {
      const p = this.input.presentPage;
      const tl = camera.worldToScreen(p.x, p.y, vw, vh);
      const br = camera.worldToScreen(p.x + p.w, p.y + p.h, vw, vh);
      const veil = new Path2D();
      veil.rect(0, 0, vw, vh);
      veil.rect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
      ctx.fillStyle = '#000000';
      ctx.fill(veil, 'evenodd');
    }

    // stale pencil rasters were shown: come back next frame and keep rebuilding (stale tiles rebuild themselves)
    if (this.rastersPending) this.dirty = true;

    // Zoom badge: 100% = the first page fits the screen (+ performance readout when enabled)
    if (!presenting) {
      const pct = Math.round((z / baseZoom()) * 100);
      let extra = '';
      if (this.input.perfHud) {
        const now = performance.now();
        this.perfFrame = now - frameStart;
        if (live && this.input.lastSampleAt) this.perfLat.push(now - this.input.lastSampleAt);
        if (now - this.perfAt > 500) {
          this.perfAt = now;
          const lat = this.perfLat.sort((a, b) => a - b);
          const med = lat.length ? lat[lat.length >> 1] : 0, worst = lat.length ? lat[lat.length - 1] : 0;
          this.perfText = `${this.fps} fps   in→paint ${med.toFixed(0)} / ${worst.toFixed(0)} ms   live ${this.perfLive.toFixed(1)} ms   frame ${this.perfFrame.toFixed(1)} ms${this.input.penInput ? `   pen ${this.input.penInput}` : ''}`;
          this.perfLat = [];
        }
        this.input.perfLine = this.perfText; // shown by the UI in its own readout, not under the toolbar
        this.dirty = true; // keep the numbers fresh
      }
      ctx.font = '600 11px "Libre Franklin Variable", sans-serif';
      ctx.fillStyle = 'rgba(42,36,26,0.55)';
      ctx.textAlign = 'right';
      // bottom centre-right: the undo/redo bar owns the corner
      ctx.fillText(`${this.fps}fps · ${pct}%${this.input.zoomLocked ? ' locked' : ''}${extra}`, vw - 96, vh - 12);
    }
  }

  /** Four-direction move cross with arrowheads, centered in a handle box. */
  private drawMoveCross(bx: number, by: number, size: number) {
    const { ctx } = this;
    const c = size / 2;
    const cx = bx + c, cy = by + c;
    const L = size * 0.32;
    const a = size * 0.12;
    ctx.beginPath();
    ctx.moveTo(cx, cy - L); ctx.lineTo(cx, cy + L);
    ctx.moveTo(cx - L, cy); ctx.lineTo(cx + L, cy);
    // arrowheads
    ctx.moveTo(cx - a, cy - L + a); ctx.lineTo(cx, cy - L); ctx.lineTo(cx + a, cy - L + a);
    ctx.moveTo(cx - a, cy + L - a); ctx.lineTo(cx, cy + L); ctx.lineTo(cx + a, cy + L - a);
    ctx.moveTo(cx - L + a, cy - a); ctx.lineTo(cx - L, cy); ctx.lineTo(cx - L + a, cy + a);
    ctx.moveTo(cx + L - a, cy - a); ctx.lineTo(cx + L, cy); ctx.lineTo(cx + L - a, cy + a);
    ctx.stroke();
  }

  /** Move box (top-left) + width/height/corner handles with arrow icons.
   * `copy` adds the copy grabber under the move box (elements; areas use that slot for move-all). */
  private drawBoxHandles(x: number, y: number, w: number, h: number, z: number, copy = false) {
    const { ctx } = this;
    const mh = moveHandleRect(x, y, z);
    ctx.fillStyle = '#FDFCF8';
    ctx.strokeStyle = 'rgba(90,75,50,0.5)';
    ctx.lineWidth = 1.2 / z;
    ctx.fillRect(mh.x, mh.y, mh.s, mh.s);
    ctx.strokeRect(mh.x, mh.y, mh.s, mh.s);
    ctx.strokeStyle = '#2A241A';
    this.drawMoveCross(mh.x, mh.y, mh.s);
    if (copy) {
      // two offset squares: "drag a copy"
      const ch = copyHandleRect(x, y, z);
      ctx.fillStyle = '#FDFCF8';
      ctx.strokeStyle = 'rgba(90,75,50,0.5)';
      ctx.fillRect(ch.x, ch.y, ch.s, ch.s);
      ctx.strokeRect(ch.x, ch.y, ch.s, ch.s);
      ctx.strokeStyle = '#2A241A';
      const u = ch.s / 24;
      ctx.beginPath();
      ctx.rect(ch.x + 9 * u, ch.y + 9 * u, 10 * u, 10 * u);
      ctx.moveTo(ch.x + 6 * u, ch.y + 15 * u);
      ctx.lineTo(ch.x + 5 * u, ch.y + 15 * u);
      ctx.lineTo(ch.x + 5 * u, ch.y + 5 * u);
      ctx.lineTo(ch.x + 15 * u, ch.y + 5 * u);
      ctx.lineTo(ch.x + 15 * u, ch.y + 6 * u);
      ctx.stroke();
    }
    const hs = 13 / z;
    const arrow = (cx: number, cy: number, dx: number, dy: number) => {
      const L = hs * 0.3;
      const ax = dx * L, ay = dy * L;
      const px = -dy, py = dx;
      const a = hs * 0.13;
      ctx.beginPath();
      ctx.moveTo(cx - ax, cy - ay);
      ctx.lineTo(cx + ax, cy + ay);
      ctx.moveTo(cx + ax - dx * a + px * a, cy + ay - dy * a + py * a);
      ctx.lineTo(cx + ax, cy + ay);
      ctx.lineTo(cx + ax - dx * a - px * a, cy + ay - dy * a - py * a);
      ctx.moveTo(cx - ax + dx * a + px * a, cy - ay + dy * a + py * a);
      ctx.lineTo(cx - ax, cy - ay);
      ctx.lineTo(cx - ax + dx * a - px * a, cy - ay + dy * a - py * a);
      ctx.stroke();
    };
    const D = Math.SQRT1_2;
    const handles: [number, number, number, number][] = [
      [x, y + h / 2, 1, 0],
      [x + w, y + h / 2, 1, 0],
      [x + w / 2, y + h, 0, 1],
      [x + w, y + h, D, D],
    ];
    for (const [hx, hy, dx, dy] of handles) {
      ctx.fillStyle = '#FDFCF8';
      ctx.strokeStyle = 'rgba(90,75,50,0.5)';
      ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
      ctx.strokeRect(hx - hs / 2, hy - hs / 2, hs, hs);
      ctx.strokeStyle = '#2A241A';
      arrow(hx, hy, dx, dy);
    }
    // delete handle: top-right, away from the move handle — a small bin (an X means "close" elsewhere)
    const dh = deleteHandleRect(x, y, w, z);
    ctx.fillStyle = '#FDFCF8';
    ctx.strokeStyle = '#D6336C';
    ctx.fillRect(dh.x, dh.y, dh.s, dh.s);
    ctx.strokeRect(dh.x, dh.y, dh.s, dh.s);
    const u = dh.s / 24, bx = dh.x + dh.s * 0.15, by = dh.y + dh.s * 0.15, k = 0.7 * dh.s / 24;
    const P = (px: number, py: number) => [bx + px * k * (1 / u) * u, by + py * k * (1 / u) * u] as const;
    ctx.beginPath();
    let p = P(4, 7); ctx.moveTo(p[0], p[1]); p = P(20, 7); ctx.lineTo(p[0], p[1]);
    p = P(9, 7); ctx.moveTo(p[0], p[1]); p = P(9.5, 4); ctx.lineTo(p[0], p[1]); p = P(14.5, 4); ctx.lineTo(p[0], p[1]); p = P(15, 7); ctx.lineTo(p[0], p[1]);
    p = P(6.5, 7); ctx.moveTo(p[0], p[1]); p = P(7.5, 20); ctx.lineTo(p[0], p[1]); p = P(16.5, 20); ctx.lineTo(p[0], p[1]); p = P(17.5, 7); ctx.lineTo(p[0], p[1]);
    ctx.stroke();
  }

  /** Typeface dice under the bin on a textbox. `pip` is set while a roll is in flight: the
   * die shows that face and tilts, so the wait for the download reads as rolling. */
  private drawDice(x: number, y: number, w: number, z: number, pip?: number) {
    const { ctx } = this;
    const r = diceHandleRect(x, y, w, z);
    const cx = r.x + r.s / 2, cy = r.y + r.s / 2;
    ctx.save();
    ctx.translate(cx, cy);
    if (pip !== undefined) ctx.rotate(((pip * 37) % 24 - 12) * Math.PI / 180);
    const d = r.s * 0.82, rad = d * 0.2;
    ctx.fillStyle = '#FDFCF8';
    ctx.strokeStyle = pip !== undefined ? '#E8590C' : 'rgba(90,75,50,0.6)';
    ctx.lineWidth = 1.2 / z;
    ctx.beginPath();
    ctx.roundRect(-d / 2, -d / 2, d, d, rad);
    ctx.fill();
    ctx.stroke();
    // pips
    const n = pip ?? 5;
    const o = d * 0.25, pr = d * 0.095;
    const spots: [number, number][] = [];
    if (n % 2 === 1) spots.push([0, 0]);
    if (n >= 2) spots.push([-o, -o], [o, o]);
    if (n >= 4) spots.push([o, -o], [-o, o]);
    if (n === 6) spots.push([-o, 0], [o, 0]);
    ctx.fillStyle = pip !== undefined ? '#E8590C' : '#2A241A';
    for (const [px, py] of spots) {
      ctx.beginPath();
      ctx.arc(px, py, pr, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /** Style handles on a text box: an eyedropper picks the style up; when a picked-up style
   * would change this box, a paint roller below it applies it. */
  private static ICON_PIPETTE = new Path2D('M2 22l1-1h3l9-9 M3 21v-3l9-9 M15 6l3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z');
  private static ICON_ROLLER = new Path2D('M4 2h12a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z M10 16v-2a2 2 0 0 1 2-2h8a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2 M9 16h2a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1Z');
  private drawStyleHandles(el: TextBox, z: number) {
    const { ctx } = this;
    const draw = (r: { x: number; y: number; s: number }, icon: Path2D, paste: boolean) => {
      ctx.save();
      ctx.fillStyle = paste ? '#7048e8' : '#FDFCF8';
      ctx.strokeStyle = paste ? '#7048e8' : 'rgba(90,75,50,0.6)';
      ctx.lineWidth = 1.2 / z;
      ctx.beginPath();
      ctx.roundRect(r.x, r.y, r.s, r.s, r.s * 0.16);
      ctx.fill();
      ctx.stroke();
      // the 24-unit icon, inset
      const k = (r.s * 0.7) / 24;
      ctx.translate(r.x + r.s * 0.15, r.y + r.s * 0.15);
      ctx.scale(k, k);
      ctx.strokeStyle = paste ? '#fff' : '#2A241A';
      ctx.lineWidth = 1.8;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke(icon);
      ctx.restore();
    };
    draw(copyStyleHandleRect(el.x, el.y, el.w, z), Renderer.ICON_PIPETTE, false);
    if (this.input.stylePasteFor(el)) draw(pasteStyleHandleRect(el.x, el.y, el.w, z), Renderer.ICON_ROLLER, true);
  }

  /** The paper behind the canvas: its colour, and its dots / grid / lines as a CSS background moved
   * and scaled by a compositor transform — every pan and zoom costs nothing; the background is only
   * re-drawn when the cell size steps (doubling / halving in mm steps). */
  private paperEl: HTMLElement | null | undefined;
  private paperState = '';
  private updatePaper(vw: number, vh: number, paper: string, on: boolean) {
    if (this.paperEl === undefined) this.paperEl = document.getElementById('paper');
    const el = this.paperEl;
    if (!el || this.canvas.id !== 'canvas') return; // (scratch renderers have no paper layer)
    const mode = this.opts.gridMode;
    const pattern = on && this.opts.grid && mode !== 'canvas' ? this.store.doc.pattern ?? 'dots' : 'blank';
    const { camera } = this;
    let sp = 10 * camera.zoom; // 5 mm cells, CSS px
    let base = sp;
    while (base < 8) base *= 2;
    while (base > 120) base /= 2;
    // the background's cell is a power-of-two step; the transform covers the rest (×1 … ×2)
    const B = Math.pow(2, Math.floor(Math.log2(base)));
    const k = base / B;
    sp = base;
    const o = camera.worldToScreen(0, 0, vw, vh);
    const tx = (((o.x % sp) + sp) % sp) - sp, ty = (((o.y % sp) + sp) % sp) - sp;
    const dark = darkPaper(paper);
    const grid = el.firstElementChild as HTMLElement;
    const look = `${paper}|${pattern}|${B}|${dark}|${vw}|${vh}`;
    if (look !== this.paperState) {
      this.paperState = look;
      el.style.background = paper;
      if (pattern === 'blank') { grid.style.backgroundImage = 'none'; }
      else {
        const c = dark ? 'rgba(255,255,255,0.14)' : 'rgba(120,105,80,0.18)';
        const l = dark ? 'rgba(255,255,255,0.07)' : 'rgba(120,105,80,0.1)';
        const svg = pattern === 'dots'
          ? `<rect x='0' y='0' width='1' height='1' fill='${c}'/><rect x='${B - 1}' y='0' width='1' height='1' fill='${c}'/><rect x='0' y='${B - 1}' width='1' height='1' fill='${c}'/><rect x='${B - 1}' y='${B - 1}' width='1' height='1' fill='${c}'/>`
          : `<rect x='0' y='0' width='${B}' height='1' fill='${l}'/>` + (pattern === 'grid' ? `<rect x='0' y='0' width='1' height='${B}' fill='${l}'/>` : '');
        grid.style.backgroundImage = `url("data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='${B}' height='${B}'>${svg}</svg>`)}")`;
        grid.style.backgroundSize = `${B}px ${B}px`;
      }
      grid.style.width = `${Math.ceil(vw / 1 + 3 * B)}px`;
      grid.style.height = `${Math.ceil(vh / 1 + 3 * B)}px`;
    }
    if (mode === 'position') {
      grid.style.transform = '';
      grid.style.backgroundSize = `${sp}px ${sp}px`;
      grid.style.backgroundPosition = `${(tx + sp).toFixed(2)}px ${(ty + sp).toFixed(2)}px`;
      grid.style.width = `${vw}px`; grid.style.height = `${vh}px`;
    } else {
      grid.style.backgroundPosition = '0 0';
      grid.style.backgroundSize = `${B}px ${B}px`;
      grid.style.transform = `translate3d(${tx.toFixed(2)}px, ${ty.toFixed(2)}px, 0) scale(${k.toFixed(4)})`;
    }
  }

  /** The paper's dots / grid / lines, live, over the back layer: one fill with a repeating
   * one-cell pattern (scaled exactly with the zoom), blended so it marks the paper like before
   * and vanishes into dark ink (multiply on light paper, screen on dark). */
  private gridTile: { key: string; pat: CanvasPattern } | null = null;
  private drawPaperGrid(vw: number, vh: number, paper: string, op?: GlobalCompositeOperation) {
    const pattern = this.store.doc.pattern ?? 'dots';
    if (pattern === 'blank') return;
    const { camera, ctx } = this;
    const dark = darkPaper(paper);
    let sp = 10 * camera.zoom; // 5 mm cells, CSS px; doubled / halved in mm steps like drawPattern
    while (sp < 8) sp *= 2;
    while (sp > 120) sp /= 2;
    const N = 64; // tile px for one cell, scaled to the real cell size by the pattern transform
    const key = `${pattern}|${dark}|${Math.round((2 / sp) * N * 4)}`;
    if (this.gridTile?.key !== key) {
      const c = document.createElement('canvas');
      c.width = c.height = N;
      const g = c.getContext('2d')!;
      const mark = (2 / sp) * N; // 2 CSS px marks
      if (pattern === 'dots') {
        g.fillStyle = dark ? 'rgba(255,255,255,0.14)' : 'rgba(120,105,80,0.18)';
        g.fillRect(0, 0, mark / 2, mark / 2); g.fillRect(N - mark / 2, 0, mark / 2, mark / 2);
        g.fillRect(0, N - mark / 2, mark / 2, mark / 2); g.fillRect(N - mark / 2, N - mark / 2, mark / 2, mark / 2);
      } else {
        g.fillStyle = dark ? 'rgba(255,255,255,0.07)' : 'rgba(120,105,80,0.1)';
        const lw = (1 / sp) * N;
        g.fillRect(0, 0, N, lw / 2); g.fillRect(0, N - lw / 2, N, lw / 2);
        if (pattern === 'grid') { g.fillRect(0, 0, lw / 2, N); g.fillRect(N - lw / 2, 0, lw / 2, N); }
      }
      const pat = ctx.createPattern(c, 'repeat');
      if (!pat) return;
      this.gridTile = { key, pat };
    }
    const o = camera.worldToScreen(0, 0, vw, vh); // cells anchored to the world origin
    const pat = this.gridTile.pat;
    pat.setTransform(new DOMMatrix().translate(o.x, o.y).scale(sp / N));
    ctx.save();
    ctx.globalCompositeOperation = op ?? (dark ? 'screen' : 'multiply');
    ctx.globalAlpha = 1;
    ctx.fillStyle = pat;
    ctx.fillRect(0, 0, vw, vh);
    ctx.restore();
  }

  private drawPattern(vw: number, vh: number, paper: string) {
    const pattern = this.store.doc.pattern ?? 'dots';
    if (pattern === 'blank') return;
    const { camera, ctx } = this;
    const dark = darkPaper(paper);
    // world-anchored: 5mm cells (10 world units) like real paper, scaling with zoom;
    // double/halve in mm steps only when cells get too dense/sparse on screen
    const spacingWorld = 10; // 5mm
    let s = spacingWorld * camera.zoom;
    while (s < 8) s *= 2;
    while (s > 120) s /= 2;
    const originScreen = camera.worldToScreen(0, 0, vw, vh);
    const ox = ((originScreen.x % s) + s) % s;
    const oy = ((originScreen.y % s) + s) % s;
    if (pattern === 'dots') {
      ctx.fillStyle = dark ? 'rgba(255,255,255,0.14)' : 'rgba(120,105,80,0.18)';
      for (let x = ox; x < vw; x += s) {
        for (let y = oy; y < vh; y += s) {
          ctx.fillRect(x - 1, y - 1, 2, 2);
        }
      }
      return;
    }
    ctx.strokeStyle = dark ? 'rgba(255,255,255,0.07)' : 'rgba(120,105,80,0.1)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (pattern === 'grid') {
      for (let x = ox; x < vw; x += s) { ctx.moveTo(x, 0); ctx.lineTo(x, vh); }
    }
    for (let y = oy; y < vh; y += s) { ctx.moveTo(0, y); ctx.lineTo(vw, y); }
    ctx.stroke();
  }

  private drawPage(page: Page, z: number) {
    const { ctx } = this;
    // No fill — a page is just a thin frame on the canvas
    ctx.strokeStyle = 'rgba(90,75,50,0.35)';
    ctx.lineWidth = 1 / z;
    ctx.strokeRect(page.x, page.y, page.w, page.h);
    // Label + drag tab
    ctx.font = `500 ${11 / z}px "Libre Franklin Variable", sans-serif`;
    ctx.fillStyle = 'rgba(90,75,50,0.6)';
    ctx.textAlign = 'left';
    ctx.fillText(`${page.name} · ${page.format ?? formatLabel(page.w, page.h)}`, page.x + 2 / z, page.y - 6 / z);
  }
}

/** light marks on dark paper, dark marks on light paper */
/** Where an element is (to tell how far it's moved since a bitmap of it was made). */
function anchorOf(el: Element): { x: number; y: number } {
  if (el.kind === 'text' || el.kind === 'image') return { x: el.x, y: el.y };
  const p = el.points[0];
  return p ? { x: p.x, y: p.y } : { x: 0, y: 0 };
}

function darkPaper(paper: string): boolean {
  const n = parseInt(paper.slice(1), 16);
  return ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114 < 128;
}

function polygonPath(points: { x: number; y: number }[]): Path2D {
  const path = new Path2D();
  if (!points.length) return path;
  path.moveTo(points[0].x, points[0].y);
  for (const p of points) path.lineTo(p.x, p.y);
  path.closePath();
  return path;
}
