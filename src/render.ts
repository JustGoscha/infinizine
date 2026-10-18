// Canvas renderer: desk background, page frames, elements (with viewport
// culling + cached outlines), live stroke, lasso/selection overlays.

import { GLPencil, STAMP_FLOATS } from './glpencil';
import { Camera, baseZoom } from './camera';
import { AnimArea, Element, FillShape, Page, Stroke, StrokePoint, TextBox } from './types';
import { elementBBox, bboxIntersects, LiveDenoiser, denoiseClosed, closeBlob, BBox } from './geometry';
import { strokeOutline, pencilOutlines, markerPaths, outlineToPath, densify, filterPressure, LiveOutliner, hasPressure, widthAt } from './outline';
import { easeP, easeTilt, pressure } from './pressure';
import { layoutText, fontFor, segWidth, LINE_HEIGHT, boxFamily, segFamily, wrapWidth } from './text';
import { moveHandleRect, moveAllHandleRect, deleteHandleRect, eyeHandleRect, diceHandleRect, copyHandleRect, copyStyleHandleRect, pasteStyleHandleRect } from './handles';
import { FILL_TOOLS, type InputState } from './state';
import { animClock } from './clock';
import { Store, ChangeInfo } from './store';
import { formatLabel } from './formats';
import { patternTile, patternTileSize, patternCellSize, cellPath, cellMask, motifPath, motifDots, motifCoverage, isPixelPattern, PIXEL_CELL } from './patterns';
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
const PREFETCH = 2; // rings of tiles built around the screen in spare time (kept up to one more) // spare tile bitmaps kept for reuse (iOS is slow to allocate and slow to free canvases)
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
interface Tile { i: number; j: number; back: HTMLCanvasElement; front: HTMLCanvasElement | null; stale: boolean; redo?: boolean }
/** a tile being built a slice per frame: its elements by layer, where it got to (element k of
 * pass 0 = back, 1 = front; within a long pencil stroke, the next stamp) */
interface TileJob {
  i: number; j: number; back: HTMLCanvasElement; front: HTMLCanvasElement | null;
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
  /** the previous zoom's tiles: scaled into the gaps while the new zoom's tiles build */
  private prevTiles: TileSet | null = null;
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
  dropFromCache(id: string) {
    this.cache.delete(id); this.dropPencilRaster(id); this.dropPencilJob(id); this.stampCache.delete(id); this.dropFillRaster(id);
    this.tileGen++;
  }
  clearCache() {
    this.cache.clear(); this.stampCache.clear(); this.boxCache.clear(); this.dotCache.clear();
    for (const id of [...this.dotBakes.keys()]) this.dropDotBake(id);
    for (const id of [...this.cellImages.keys()]) this.dropCellImage(id);
    for (const id of [...this.pencilCache.keys()]) this.dropPencilRaster(id);
    for (const id of [...this.pencilJobs.keys()]) this.dropPencilJob(id);
    for (const id of [...this.fillRasters.keys()]) this.dropFillRaster(id);
    this.tileGen++;
  }

  /** Document changed: drop only the touched elements' caches; keep the static
   * tiles when the change is a fresh append we can paint on top of. */
  docChanged(info?: ChangeInfo) {
    this.animBake.key = ''; // frozen areas may have changed
    if (!info) { this.clearCache(); this.invalidate(); return; }
    // where the touched elements were painted, before their caches go
    const before = info.ids.map((id) => this.tileBoxes.get(id));
    for (const id of info.ids) { this.cache.delete(id); this.boxCache.delete(id); this.dotCache.delete(id); this.dropDotBake(id); this.dropCellImage(id); this.dropPencilRaster(id); this.dropPencilJob(id); this.stampCache.delete(id); this.dropFillRaster(id); }
    const set = this.tileSet;
    const current = !!set && set.content === this.contentKey() && set.zoom === this.camera.zoom;
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
      for (const el of this.store.doc.elements) {
        if (ids.has(el.id) && this.isStill(el) && !this.input.hidden.has(el.id)) boxes.push(this.elBox(el));
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
    this.dropSet(this.prevTiles);
    this.prevTiles = null;
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
  private runTileJob(set: TileSet, i: number, j: number, near: { back: Element[]; front: Element[] }, until: number): Tile | null {
    const key = `${i},${j}`;
    const view = this.tileView(i, j, set.s);
    let job = set.jobs.get(key);
    if (!job) {
      const paper = this.store.doc.paper ?? '#F7F4EC';
      const back = this.takeCanvas();
      const g = back.getContext('2d')!;
      g.fillStyle = paper;
      g.fillRect(0, 0, TILE, TILE);
      if (!set.draft) this.paintPaperTile(g, i, j, paper); // (the draft is zoom-free: no zoom-stepped paper marks)
      const here = (el: Element) => bboxIntersects(this.elBox(el), view);
      job = { i, j, back, front: null, layers: [near.back.filter(here), near.front.filter(here)], pass: 0, k: 0, stamp: null, stale: false };
      set.jobs.set(key, job);
    }
    const pending = this.rastersPending;
    this.rastersPending = false;
    const done = this.advanceTileJob(job, set, view, until);
    job.stale ||= this.rastersPending; // a pattern fill drawn from another zoom's bake: rebuild once it's ready
    this.rastersPending ||= pending;
    if (!done) return null;
    set.jobs.delete(key);
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
          if (el.kind === 'stroke' && el.tool === 'pencil' && set.draft) {
            // draft: the stroke's outline in an averaged graphite tone — no stamps at all
            g.save();
            g.globalAlpha = el.opacity * dim * 0.28; // (soft graphite reads lighter than its outline)
            g.fillStyle = el.color;
            g.fill(this.entry(el).path);
            g.restore();
          } else if (el.kind === 'stroke' && el.tool === 'pencil' && !job.stamp && this.gpuStampTile(g, el, el.opacity * dim, set, view, job.i, job.j)) {
            // the whole stroke's stamps on this tile in one GPU draw
          } else if (el.kind === 'stroke' && el.tool === 'pencil') {
            const st = job.stamp ??= { next: 0, state: { sinceX: NaN, sinceY: NaN, skipped: 0 } };
            // as many stamps as the time left allows at the measured rate; then make WebKit draw
            // them now, so the time spent is real and the rate stays honest
            const t0 = performance.now(), from = st.next;
            const rate = set.draft ? this.draftStampRate : this.stampRate;
            const limit = from + Math.max(32, Math.floor(rate * Math.max(0.5, until - t0)));
            // (stamps closer than ~0.7 device px are invisible: merged, alpha-compensated;
            // the draft merges far more — half the nib apart)
            const minSpacing = set.draft ? Math.max(0.7 / set.s, el.baseWidth * 0.5) : 0.7 / set.s;
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
            if (el.kind === 'fill' && el.pattern && isMotif(el.pattern) && set.draft) {
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
          // deadline sees real cost (recording 50 strokes takes no time; drawing them can take 100 ms)
          if (DEFERRED_CANVAS && ++sinceFlush >= 6) { flushCanvas(g); sinceFlush = 0; }
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

  /** The paper's dot/grid/lines marks on tile (i, j): the same world-anchored cells as drawPattern. */
  private paintPaperTile(g: CanvasRenderingContext2D, i: number, j: number, paper: string, coarse = 1) {
    const pattern = this.store.doc.pattern ?? 'dots';
    if (pattern === 'blank') return;
    // (`coarse`: a draft tile's pixels are this many screen pixels: marks drawn that much smaller)
    const dpr = (window.devicePixelRatio || 1) / coarse;
    const dark = darkPaper(paper);
    let sp = 10 * this.camera.zoom; // 5 mm, in CSS px; doubled/halved like drawPattern
    while (sp < 8) sp *= 2;
    while (sp > 120) sp /= 2;
    const d = sp * dpr;
    const x0 = i * TILE, y0 = j * TILE;
    const k0 = Math.floor(x0 / d), k1 = Math.ceil((x0 + TILE) / d);
    const l0 = Math.floor(y0 / d), l1 = Math.ceil((y0 + TILE) / d);
    if (pattern === 'dots') {
      g.fillStyle = dark ? 'rgba(255,255,255,0.14)' : 'rgba(120,105,80,0.18)';
      // one shape, not a fillRect per dot (a draft tile has thousands; WebKit replays each one)
      const dots = new Path2D();
      for (let k = k0; k <= k1; k++) for (let l = l0; l <= l1; l++) dots.rect(k * d - x0 - dpr, l * d - y0 - dpr, 2 * dpr, 2 * dpr);
      g.fill(dots);
      return;
    }
    g.strokeStyle = dark ? 'rgba(255,255,255,0.07)' : 'rgba(120,105,80,0.1)';
    g.lineWidth = dpr;
    g.beginPath();
    if (pattern === 'grid') for (let k = k0; k <= k1; k++) { g.moveTo(k * d - x0, 0); g.lineTo(k * d - x0, TILE); }
    for (let l = l0; l <= l1; l++) { g.moveTo(0, l * d - y0); g.lineTo(TILE, l * d - y0); }
    g.stroke();
  }

  /** Blit a tile set's back or front bitmaps (device-px space; scaled when the set is from another zoom). */
  private blitTiles(set: TileSet, layer: 'back' | 'front', W: number, H: number, ox: number, oy: number) {
    const ctx = this.ctx;
    const k = (this.camera.zoom * (window.devicePixelRatio || 1)) / set.s;
    for (const t of set.tiles.values()) {
      const c = layer === 'back' ? t.back : t.front;
      if (!c) continue;
      // edges rounded on their own, so neighbours always meet without a gap
      const x0 = Math.round(t.i * TILE * k) + ox, x1 = Math.round((t.i + 1) * TILE * k) + ox;
      const y0 = Math.round(t.j * TILE * k) + oy, y1 = Math.round((t.j + 1) * TILE * k) + oy;
      if (x1 <= 0 || y1 <= 0 || x0 >= W || y0 >= H) continue;
      if (k === 1) ctx.drawImage(c, x0, y0);
      else ctx.drawImage(c, x0, y0, x1 - x0, y1 - y0);
    }
  }

  /** Static ink for this frame: build the tiles that scrolled into view (and, with
   * time to spare, a ring around them), blit the back bitmaps, and return the
   * front blit, which runs after a paint-behind live stroke. */
  private drawStatic(vw: number, vh: number, dpr: number, frameStart: number): () => void {
    const { camera } = this;
    const ctx = this.ctx;
    const content = this.contentKey();
    const zooming = frameStart - this.lastZoomChangeAt < 180;
    if (this.prevTiles && this.prevTiles.content !== content) { this.dropSet(this.prevTiles); this.prevTiles = null; }
    if (this.tileSet && this.tileSet.content !== content) { this.dropSet(this.tileSet); this.tileSet = null; }
    let set = this.tileSet;
    if (set && set.zoom !== camera.zoom && !zooming) {
      // the zoom settled: these stand in, scaled, while the new zoom's tiles build
      this.dropSet(this.prevTiles);
      this.prevTiles = set;
      set = null;
    }
    if (!set) set = this.tileSet = { content, zoom: camera.zoom, s: camera.zoom * dpr, tiles: new Map(), jobs: new Map() };
    const fine: TileSet = set;
    const ext = this.draftScale();
    let draft = this.draft;
    if (draft && (draft.content !== content || draft.s !== ext.s)) { this.dropSet(draft); draft = this.draft = null; }
    if (!draft) draft = this.draft = { content, zoom: 0, s: ext.s, tiles: new Map(), jobs: new Map(), draft: true };
    const coarse: TileSet = draft;
    // the eraser hides elements as it goes: repaint just the tiles they were on (and back, if un-hidden)
    const hidden = this.input.hidden;
    if (fine.zoom === camera.zoom && (hidden.size || this.tileHidden.size)) {
      const changed: BBox[] = [];
      for (const id of hidden) if (!this.tileHidden.has(id)) { const b = this.tileBoxes.get(id); if (b) changed.push(b); }
      for (const id of this.tileHidden) {
        if (hidden.has(id)) continue;
        const el = this.store.doc.elements.find((e) => e.id === id);
        if (el && this.isStill(el)) changed.push(this.elBox(el));
      }
      this.tileHidden = new Set(hidden);
      this.redoTiles(changed);
    }
    const { ox, oy } = this.worldMatrix(vw, vh, dpr);
    const W = vw * dpr, H = vh * dpr;
    const holes = new Path2D(); // screen rects still without a sharp tile of this zoom
    let holed = false;
    if (fine.zoom === camera.zoom) {
      const tiles = fine.tiles;
      const i0 = Math.floor(-ox / TILE), i1 = Math.floor((W - 1 - ox) / TILE);
      const j0 = Math.floor(-oy / TILE), j1 = Math.floor((H - 1 - oy) / TILE);
      // the draft tiles over the screen, and over the whole zine
      const view = camera.viewport(vw, vh), ds = coarse.s;
      const di0 = Math.floor((view.x * ds) / TILE), di1 = Math.floor(((view.x + view.w) * ds) / TILE);
      const dj0 = Math.floor((view.y * ds) / TILE), dj1 = Math.floor(((view.y + view.h) * ds) / TILE);
      const eb = ext.box;
      const ei0 = eb ? Math.floor((eb.minX * ds) / TILE) : 0, ei1 = eb ? Math.floor((eb.maxX * ds) / TILE) : -1;
      const ej0 = eb ? Math.floor((eb.minY * ds) / TILE) : 0, ej1 = eb ? Math.floor((eb.maxY * ds) / TILE) : -1;
      // still elements around a region, by layer (once per frame per layer)
      const nearOf = (rect: View) => {
        const near = { back: [] as Element[], front: [] as Element[] };
        for (const el of this.store.doc.elements) {
          if (!this.isStill(el) || hidden.has(el.id) || !bboxIntersects(this.elBox(el), rect)) continue;
          (el.layer === 'back' ? near.back : near.front).push(el);
        }
        return near;
      };
      type Near = { back: Element[]; front: Element[] };
      let nearFine: Near | null = null, nearDraft: Near | null = null;
      const build = (ts: TileSet, i: number, j: number, until: number): boolean => {
        let near: Near;
        if (ts === fine) {
          if (!nearFine) {
            const ring = this.tileView(i0 - PREFETCH, j0 - PREFETCH, fine.s);
            ring.w *= i1 - i0 + 1 + 2 * PREFETCH;
            ring.h *= j1 - j0 + 1 + 2 * PREFETCH;
            this.keepRect = ring;
            nearFine = nearOf(ring);
          }
          near = nearFine;
        } else {
          if (!nearDraft) nearDraft = nearOf(eb ? { x: eb.minX, y: eb.minY, w: eb.maxX - eb.minX, h: eb.maxY - eb.minY } : view);
          near = nearDraft;
        }
        const tile = this.runTileJob(ts, i, j, near, until);
        if (!tile) return false;
        const key = `${i},${j}`;
        this.dropTile(ts.tiles.get(key));
        ts.tiles.set(key, tile);
        return true;
      };
      const fallback = this.prevTiles;
      const sharpMissingNow = () => {
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (!tiles.has(`${i},${j}`) && !(fallback && fallback.s > fine.s && coveredByPrevEarly(i, j))) return true;
        return false;
      };
      const coveredByPrevEarly = (i: number, j: number) => {
        const p = fallback!, v = this.tileView(i, j, fine.s), k = p.s;
        const a0 = Math.floor((v.x * k) / TILE), a1 = Math.floor(((v.x + v.w) * k - 1e-6) / TILE);
        const b0 = Math.floor((v.y * k) / TILE), b1 = Math.floor(((v.y + v.h) * k - 1e-6) / TILE);
        for (let b = b0; b <= b1; b++) for (let a = a0; a <= a1; a++) if (!p.tiles.has(`${a},${b}`)) return false;
        return true;
      };
      // ms of tile building per frame: most of the frame while there are gaps on screen (they look
      // broken), a third of it for the prefetch otherwise
      const deadline = frameStart + (sharpMissingNow() ? Math.max(this.buildBudget(), this.framePeriod * 0.75) : this.buildBudget());
      let built = 0;
      let pending = false;
      // what to build, most needed first: the draft over the screen while sharp tiles are missing
      // there (and no old zoom's tiles stand in) → the sharp tiles, centre out → a draft ring
      // around the screen (a fling lands on draft, not paper) → the sharp prefetch rings
      let sharpMissing = false;
      for (let j = j0; j <= j1 && !sharpMissing; j++) for (let i = i0; i <= i1; i++) if (!tiles.has(`${i},${j}`)) { sharpMissing = true; break; }
      const cx = (W / 2 - ox) / TILE - 0.5, cy = (H / 2 - oy) / TILE - 0.5;
      const order: [TileSet, number, number, number, boolean][] = []; // set, i, j, priority, on screen
      // the draft: over the screen first while sharp tiles are missing there, then the rest of
      // the zine in spare time (so later pans and zooms find it ready)
      const dcx = ((view.x + view.w / 2) * ds) / TILE - 0.5, dcy = ((view.y + view.h / 2) * ds) / TILE - 0.5;
      for (let j = Math.min(dj0, ej0); j <= Math.max(dj1, ej1); j++) {
        for (let i = Math.min(di0, ei0); i <= Math.max(di1, ei1); i++) {
          const on = i >= di0 && i <= di1 && j >= dj0 && j <= dj1;
          const inZine = i >= ei0 && i <= ei1 && j >= ej0 && j <= ej1;
          if (!inZine && !on) continue;
          if (on && !sharpMissing && coarse.tiles.has(`${i},${j}`)) continue;
          order.push([coarse, i, j, (on && sharpMissing ? 0 : 1500) + Math.hypot(i - dcx, j - dcy), on && sharpMissing]);
        }
      }
      // zoomed out: the old zoom's tiles are sharper than needed, and shrunk they stay crisp —
      // where they cover a tile it can wait (built exactly later, in spare time)
      const sharpPrev = fallback && fallback.s > fine.s ? fallback : null;
      const coveredByPrev = (i: number, j: number) => {
        if (!sharpPrev) return false;
        const v = this.tileView(i, j, fine.s), k = sharpPrev.s;
        const a0 = Math.floor((v.x * k) / TILE), a1 = Math.floor(((v.x + v.w) * k - 1e-6) / TILE);
        const b0 = Math.floor((v.y * k) / TILE), b1 = Math.floor(((v.y + v.h) * k - 1e-6) / TILE);
        for (let b = b0; b <= b1; b++) for (let a = a0; a <= a1; a++) if (!sharpPrev.tiles.has(`${a},${b}`)) return false;
        return true;
      };
      for (let j = j0 - PREFETCH; j <= j1 + PREFETCH; j++) {
        for (let i = i0 - PREFETCH; i <= i1 + PREFETCH; i++) {
          const on = i >= i0 && i <= i1 && j >= j0 && j <= j1;
          const wait = on && coveredByPrev(i, j);
          order.push([fine, i, j, (on ? (wait ? 800 : 100) : 1000) + Math.hypot(i - cx, j - cy), on]);
        }
      }
      order.sort((a, b) => a[3] - b[3]);
      for (const [ts, i, j, , onScreen] of order) {
        const t = ts.tiles.get(`${i},${j}`);
        if (t && !t.redo && (!t.stale || !onScreen || ts === coarse)) continue;
        // interaction first: whatever doesn't fit this frame's budget waits for the next one;
        // the first tile of a frame always gets a couple of ms, so something always progresses
        const now = performance.now();
        if (built && now > deadline) { pending = true; if (onScreen) continue; break; }
        built++;
        if (!build(ts, i, j, built === 1 ? Math.max(deadline, now + 2) : deadline)) pending = true;
      }
      // forget tiles (and half-built ones) that scrolled well away
      const far = (ts: TileSet, i: number, j: number) => ts === fine
        ? i < i0 - PREFETCH - 1 || i > i1 + PREFETCH + 1 || j < j0 - PREFETCH - 1 || j > j1 + PREFETCH + 1
        : (i < ei0 || i > ei1 || j < ej0 || j > ej1) && (i < di0 - 1 || i > di1 + 1 || j < dj0 - 1 || j > dj1 + 1); // (the draft keeps the whole zine)
      for (const ts of [fine, coarse]) {
        for (const [key, t] of ts.tiles) if (far(ts, t.i, t.j)) { this.dropTile(t); ts.tiles.delete(key); }
        for (const [key, job] of ts.jobs) if (far(ts, job.i, job.j)) { this.recycle(job.back); this.recycle(job.front); ts.jobs.delete(key); }
      }
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          if (!tiles.has(`${i},${j}`)) { holes.rect(i * TILE + ox, j * TILE + oy, TILE, TILE); holed = true; }
        }
      }
      if (!holed && fallback) { this.dropSet(fallback); this.prevTiles = null; }
      if (pending) this.dirty = true;
    } else {
      this.dirty = true; // mid-zoom: the last zoom's tiles, scaled, until the gesture settles
    }
    const prev = holed ? this.prevTiles : null;
    // editing an area dims everything else: the tiles go down faded over bare paper
    const dimmed = !!this.focusAreaId();
    const blit = (layer: 'back' | 'front') => {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      if (layer === 'back' && (holed || dimmed || fine.zoom !== camera.zoom)) {
        ctx.fillStyle = this.store.doc.paper ?? '#F7F4EC';
        ctx.fillRect(0, 0, W, H);
      }
      if (dimmed) ctx.globalAlpha = 0.3;
      if (fine.zoom !== camera.zoom) {
        // mid-zoom: the draft everywhere, the last zoom's tiles (scaled) over it where they reach
        if (coarse.tiles.size) this.blitTiles(coarse, layer, W, H, ox, oy);
      } else if (holed) {
        // where a sharp tile isn't ready: the draft, and over it the old zoom's tiles where they reach
        ctx.save();
        ctx.clip(holes);
        if (coarse.tiles.size) this.blitTiles(coarse, layer, W, H, ox, oy);
        if (prev) this.blitTiles(prev, layer, W, H, ox, oy);
        ctx.restore();
      }
      this.blitTiles(fine, layer, W, H, ox, oy);
      ctx.restore();
    };
    blit('back');
    // (alpha reset inside: a live back-layer marker leaves the context at its 0.45 and would fade the whole front layer)
    return () => blit('front');
  }

  /** Append freshly committed elements onto the built tiles. */
  private paintOntoTiles(els: Element[]) {
    const set = this.tileSet!;
    this.dropSet(this.prevTiles); // stand-ins would miss the new ink
    this.prevTiles = null;
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
      ctx.fillStyle = el.color;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      const family = boxFamily(el);
      let ty = el.y;
      for (const line of layoutText(el.text, family, el.fontSize, wrapWidth(el))) {
        let tx = el.x;
        for (const seg of line.segs) {
          ctx.font = fontFor(segFamily(seg, family), line.size, seg.b, seg.i, seg.w);
          ctx.fillText(seg.t, tx, ty);
          const sw = segWidth(family, line, seg);
          if (seg.u) ctx.fillRect(tx, ty + line.size * 1.02, sw, Math.max(0.5, line.size * 0.06));
          tx += sw;
        }
        ty += line.size * LINE_HEIGHT;
      }
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
        ctx.imageSmoothingEnabled = false;
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
      const e = this.entry(el);
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = '#E8590C';
      ctx.lineWidth = 1.5 / z;
      ctx.stroke(e.core ?? e.path);
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

  private entry(el: Stroke | FillShape): CacheEntry {
    const detail = this.detail();
    let e = this.cache.get(el.id);
    if (!e || (e.detail !== detail && !e.zoomFree)) {
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
      for (let v = 0; v < 8; v++) {
        const n = document.createElement('canvas');
        n.width = n.height = 64;
        const c = n.getContext('2d')!;
        c.fillStyle = color;
        for (let i = 0; i < 1500; i++) {
          // radial falloff × speckle = soft toothy dot
          const r = Math.sqrt(Math.random()) * 31;
          const ang = Math.random() * Math.PI * 2;
          const fall = Math.pow(1 - r / 32, 1.4);
          c.globalAlpha = fall * (0.25 + Math.random() * 0.75);
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
          dc.arc(32 + (Math.random() - 0.5) * 1.2, 32 + (Math.random() - 0.5) * 1.2, rr, 0, Math.PI * 2);
          dc.fill();
        }
        // a little tooth so it still reads as graphite, not marker
        dc.globalCompositeOperation = 'destination-out';
        for (let i = 0; i < 260; i++) {
          const r = Math.sqrt(Math.random()) * 30;
          const ang = Math.random() * Math.PI * 2;
          dc.globalAlpha = 0.25 + Math.random() * 0.5;
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
      put(st.x + jx, st.y + jy, r, rot, Math.min(1, alphaScale * grainA * wobble * boost), Math.floor(rnd(i, 6) * 8));
      // dense core: kicks in past mid pressure, near-solid at full
      const core = Math.max(0, (st.p - 0.4) / 0.6);
      if (core > 0) {
        const rc = wEff * (0.62 - core * 0.2) * (0.98 + rnd(i, 3) * 0.04);
        put(st.x + jx, st.y + jy, rc, rot, Math.min(1, alphaScale * Math.pow(core, 1.3) * 0.9 * wobble * boost), 8 + Math.floor(rnd(i, 9) * 8));
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

  /** iPad app: tell the native ink overlay how the live stroke looks and what has been painted,
   * so it draws only the newest piece (see ios/InfiniZine/InkOverlay.swift). */
  private inkReported = '';
  private reportInk(live: Stroke | null) {
    if (!live) { this.inkReported = ''; return; }
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
    const useStatic = !presenting;
    let blitFront: () => void = () => {};
    if (useStatic) {
      blitFront = this.drawStatic(vw, vh, dpr, frameStart);
    } else {
      // Desk (chosen paper color)
      ctx.fillStyle = paper;
      ctx.fillRect(0, 0, vw, vh);
      if (!presenting) this.drawPattern(vw, vh, paper);
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
      for (const l of area.layers) {
        if (l.kind !== 'live' || l.loop !== false) continue;
        for (const el of this.store.doc.elements) {
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

    const visible = this.store.doc.elements.filter((el) => !this.input.hidden.has(el.id));
    const still = visible.filter((el) => !el.frame && !(el.kind === 'stroke' && el.area));

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
      // bodies are in the static tiles; only handles/selection outlines here
      for (const el of still) {
        const ui = selected.has(el.id) || this.input.hoverText === el.id || this.input.hoverImage === el.id || this.input.rolling.has(el.id);
        if (ui && bboxIntersects(elementBBox(el), view)) this.paintElementUi(el, z);
      }
    } else {
      dimFactor = focusAreaId ? 0.3 : 1;
      for (const el of still) if (el.layer === 'back') drawEl(el);
      for (const el of still) if (el.layer !== 'back') drawEl(el);
      dimFactor = 1;
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
            for (const el of visible) {
              if (el.frame === fid) {
                const cached = el.kind === 'text' || el.kind === 'image' ? null : this.entry(el);
                if (cached) ctx.fill(cached.path);
              }
            }
            ctx.restore();
          }
          for (const el of visible) {
            if (el.frame && fids.has(el.frame) && frameVis.get(el.frame) === true) drawEl(el);
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
            for (const el of visible) {
              if (
                el.kind === 'stroke' && el.area === area.id &&
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
        try { paintAreas((a) => !isEditing(a)); } finally { ctx = mainCtx; this.ctx = mainCtx; }
        g.restore();
        bake.key = key;
      }
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(bake.canvas, 0, 0);
      ctx.restore();
      paintAreas(isEditing);
    } else {
      paintAreas(() => true);
    }
    if (live && live.layer !== 'back') drawLiveTimed();
    if (nativeApp && !presenting) this.reportInk(live);
    ctx.globalAlpha = 1;
    if (!animClock.paused) this.warmAreas(view, z, frameStart + this.buildBudget());
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
