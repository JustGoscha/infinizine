// The GPU engine's planning half, shared by its backends (WebGPU in the page, Metal in the iPad
// app): which elements a frame draws, compiling them (gpuscene.ts) within a time budget, keeping
// track of moves and changes, the far-out tiles (which exist, which are stale, which to render
// this frame, centre out) and letting go of geometry nobody has drawn for a while. A backend only
// holds what it's handed — geometry by handle, tile bitmaps by key — and draws the frame it's told.

import type { Element } from './types';
import type { BBox } from './geometry';
import { compile, shapeSig, anchorOf, type Compiled, type SceneSource, type RGB } from './gpuscene';

export const GPU_TILE = 512; // far-out tiles, device px

export interface GpuFrame {
  W: number; H: number; dpr: number;
  s: number; ox: number; oy: number; // world → device px
  dim: number; // focus dimming (1 = none)
  paper: string;
  grid: GridParams | null;
  els: Element[]; // in drawing order (empty when crowded)
  /** the still ink in a world rect, in drawing order (for tiles) */
  query: (r: { x: number; y: number; w: number; h: number }) => Element[];
  /** a crowded view (far out over a big zine): tiles, not elements */
  crowded: boolean;
  moving: boolean;
  detail: number;
  budget: number; // ms of compiling this frame
}
/** the paper's marks: kind 1 dots · 2 lines · 3 grid; spacing and origin in CSS px */
export interface GridParams { kind: 0 | 1 | 2 | 3; sp: number; t: number; x: number; y: number; dark: boolean }

export interface TileRef { key: string; L: number; i: number; j: number }
/** One frame for a backend to draw. */
export interface FrameCmd {
  W: number; H: number; dpr: number; s: number; ox: number; oy: number; dim: number;
  paper: RGB; grid: GridParams | null;
  /** direct: the elements (handles) in drawing order — or null when the view comes from tiles */
  els: number[] | null;
  /** far tiles to render (again) this frame, each with its elements */
  build: (TileRef & { els: number[] })[];
  /** far: the tiles to show, bottom first */
  show: TileRef[];
}

export interface GpuBackend {
  readonly ok: boolean;
  /** take an element's compiled geometry under a handle */
  add(h: number, c: Compiled): void;
  remove(h: number): void;
  /** an element moved (drag): its geometry drawn shifted */
  move(h: number, dx: number, dy: number): void;
  /** a text box / image being resized: an image's bitmap stretched over this box (world), a text's
   * moved with its corner at its old size (stretched text would only look wrong: it re-wraps) */
  stretch(h: number, box: BBox): void;
  dropTile(key: string): void;
  frame(cmd: FrameCmd): void;
  /** held geometry, in fill vertices and Pencil stamps (what eviction goes by) */
  usage(): { fill: number; stamps: number };
  describe(): string;
  draws: number;
  /** something it holds is still on its way (an image decoding): draw again even if nothing changed */
  readonly wantsFrame: boolean;
}

const FILL_BUDGET = 8_000_000; // fill vertices kept (~64 MB); past it the least recently used elements go
const STAMP_BUDGET = 3_000_000; // Pencil stamps kept (~84 MB)

interface El { h: number; c: Compiled; off: [number, number]; used: number; stampArea: number }
interface Tile extends TileRef { stale: boolean; used: number }

export class GpuEngine {
  private els = new Map<string, El>();
  private nextH = 1;
  private tiles = new Map<string, Tile>();
  private frameNo = 0;
  /** elements not drawn last frame (still compiling) */
  pending = 0;
  /** far-out tiles still to render for the view (0 = complete) */
  farPending = 0;
  /** profiling: ms spent compiling and elements compiled, by kind */
  stats = { compileMs: {} as Record<string, number>, compiled: {} as Record<string, number> };

  constructor(readonly backend: GpuBackend, private src: SceneSource) {}

  get ok(): boolean { return this.backend.ok; }
  /** more to do next frame: compiling, far tiles, resized boxes to settle */
  get busy(): boolean { return this.pending > 0 || this.farPending > 0 || this.stretched.size > 0; }
  get draws(): number { return this.backend.draws; }

  memory(): string {
    return `els ${this.els.size} · far tiles ${this.tiles.size} · ${this.backend.describe()} · draws ${this.backend.draws}`;
  }

  /** Forget elements (changed, deleted) — or everything. */
  drop(ids?: Iterable<string>) {
    if (!ids) {
      for (const key of this.tiles.keys()) this.backend.dropTile(key);
      this.tiles.clear();
      for (const id of [...this.els.keys()]) this.dropEl(id, false);
      return;
    }
    for (const id of ids) this.dropEl(id);
  }
  private dropEl(id: string, stale = true) {
    const e = this.els.get(id);
    if (!e) return;
    this.changed = true;
    if (stale && this.tiles.size) this.staleRects([this.boxNow(e)]);
    this.backend.remove(e.h);
    this.els.delete(id);
  }
  private boxNow(e: El): BBox {
    const b = e.c.bbox, [dx, dy] = e.off;
    return { minX: b.minX + dx, minY: b.minY + dy, maxX: b.maxX + dx, maxY: b.maxY + dy };
  }

  /** text / image boxes being resized: their bitmaps stretched since (ms), compiled again once they rest */
  private stretched = new Map<string, number>();

  /** An element changed: a pure move keeps its geometry (drawn shifted); anything else compiles again.
   * `live` (a drag in progress): a resized text box or image keeps its bitmap, stretched, for now. */
  touch(el: Element, patternsToo = false, live = false) {
    const e = this.els.get(el.id);
    if (!e) return;
    if (live && (el.kind === 'text' || el.kind === 'image') && e.c.sig !== shapeSig(el)) {
      if (this.tiles.size) this.staleRects([this.boxNow(e), { minX: el.x, minY: el.y, maxX: el.x + el.w, maxY: el.y + el.h }]);
      this.backend.stretch(e.h, { minX: el.x, minY: el.y, maxX: el.x + el.w, maxY: el.y + el.h });
      e.off = [0, 0];
      this.stretched.set(el.id, performance.now());
      this.changed = true;
      return;
    }
    this.stretched.delete(el.id);
    if (this.tiles.size) this.staleRects([this.boxNow(e)]); // (where it was)
    const movable = !(patternsToo && el.kind === 'fill' && el.pattern); // (a moved pattern re-anchors to the world once dropped)
    if (movable && e.c.sig === shapeSig(el)) {
      const a = anchorOf(el);
      const dx = a.x - e.c.anchor.x, dy = a.y - e.c.anchor.y;
      if (dx !== e.off[0] || dy !== e.off[1]) { e.off = [dx, dy]; this.backend.move(e.h, dx, dy); this.changed = true; }
      return;
    }
    this.dropEl(el.id);
  }

  /** Tiles under these world boxes are rendered again (the old picture shows until then). */
  staleRects(boxes: BBox[]) {
    this.changed = true;
    for (const t of this.tiles.values()) {
      const x0 = (t.i * GPU_TILE) / t.L, y0 = (t.j * GPU_TILE) / t.L, x1 = ((t.i + 1) * GPU_TILE) / t.L, y1 = ((t.j + 1) * GPU_TILE) / t.L;
      if (boxes.some((b) => b.minX < x1 && b.maxX > x0 && b.minY < y1 && b.maxY > y0)) t.stale = true;
    }
  }

  private compileTimed(el: Element, detail: number): El {
    const t0 = performance.now();
    const c = compile(el, detail, this.src);
    const h = this.nextH++;
    this.changed = true;
    this.backend.add(h, c);
    const k = el.kind === 'stroke' ? el.tool : el.kind === 'fill' ? (el.pattern ? el.pattern.replace(/-\d+$/, '') : 'fill') : el.kind;
    this.stats.compileMs[k] = (this.stats.compileMs[k] ?? 0) + performance.now() - t0;
    this.stats.compiled[k] = (this.stats.compiled[k] ?? 0) + 1;
    let stampArea = 0;
    for (const it of c.items) if (it.k === 'stamps') stampArea += it.area;
    return { h, c, off: [0, 0], used: this.frameNo, stampArea };
  }

  /** The elements' handles, compiling what's missing while the budget lasts. */
  private gather(els: Element[], f: GpuFrame, b: { spent: number; pending: number }): number[] {
    const out: number[] = [];
    for (const el of els) {
      let e = this.els.get(el.id);
      if (e && !e.c.zoomFree && e.c.detail !== f.detail && b.spent < f.budget) {
        // finer (or coarser) outlines for this zoom, while there's time (the old ones draw meanwhile)
        const t0 = performance.now();
        const moved = e.off[0] || e.off[1];
        this.dropEl(el.id, false);
        e = this.compileTimed(el, f.detail);
        this.els.set(el.id, e);
        if (moved) this.touch(el);
        b.spent += performance.now() - t0;
      }
      if (!e) {
        if (b.spent >= f.budget) { b.pending++; continue; }
        const t0 = performance.now();
        e = this.compileTimed(el, f.detail);
        this.els.set(el.id, e);
        b.spent += performance.now() - t0;
      }
      e.used = this.frameNo;
      out.push(e.h);
    }
    return out;
  }

  /** Let go of the geometry of elements unused the longest while over budget (their tiles keep the picture). */
  private evict() {
    const u = this.backend.usage();
    if (u.fill <= FILL_BUDGET && u.stamps <= STAMP_BUDGET) return;
    const old = [...this.els.entries()].filter(([, e]) => e.used < this.frameNo).sort((a, b) => a[1].used - b[1].used);
    for (const [id] of old) {
      const v = this.backend.usage();
      if (v.fill <= FILL_BUDGET * 0.75 && v.stamps <= STAMP_BUDGET * 0.75) break;
      this.dropEl(id, false);
    }
  }

  /** The tile level for a scale: √2 steps at or above it, so a tile is drawn at most √2 smaller. */
  static level(s: number): number { return Math.pow(2, Math.ceil(Math.log2(s) * 2 - 1e-9) / 2); }

  /** what the last frame drew (a frame that would draw the same is skipped: the picture stays) */
  private lastSig = '';
  private changed = true;
  /** in tiles because the view's Pencil is heavy (kept until it's clearly lighter: no flip-flopping) */
  private heavy = false;

  render(f: GpuFrame) {
    if (!this.backend.ok) return;
    this.frameNo++;
    // resized boxes that rest: rendered at their size again
    for (const [id, t] of this.stretched) if (performance.now() - t > 150) { this.stretched.delete(id); this.dropEl(id); }
    if (this.stretched.size) this.changed = true; // (come back to settle them)
    const b = { spent: 0, pending: 0 };
    const cmd: FrameCmd = {
      W: f.W, H: f.H, dpr: f.dpr, s: f.s, ox: f.ox, oy: f.oy, dim: f.dim, paper: hexRGB(f.paper), grid: f.grid,
      els: null, build: [], show: [],
    };
    let tiles = f.crowded;
    let hs: number[] = [];
    if (!tiles) {
      hs = this.gather(f.els, f, b);
      // up close over a lot of Pencil, restamping it all every frame is ~10 layers of nib over most
      // of the screen: tiles instead (rendered once, then a blit each frame)
      let px = 0;
      for (const el of f.els) { const e = this.els.get(el.id); if (e) px += e.stampArea; }
      px *= f.s * f.s;
      const screen = f.W * f.H;
      this.heavy = px > (this.heavy ? 2 : 3) * screen;
      tiles = this.heavy;
    } else this.heavy = false;
    if (tiles) this.planFar(f, cmd, b);
    else { cmd.els = hs; this.farPending = 0; }
    this.pending = b.pending;
    // the same frame as last time (nothing of ours moved or changed — e.g. while a live stroke is drawn
    // on the page above): skip it, the GPU's picture stays up
    let sig = `${f.W}|${f.H}|${f.s}|${f.ox}|${f.oy}|${f.dim}|${f.paper}|${f.grid ? `${f.grid.kind}|${f.grid.sp}|${f.grid.t}|${f.grid.x}|${f.grid.y}` : ''}|${cmd.build.length}|${cmd.show.length}|${hs.length}`;
    let k = 0;
    for (const h of hs) k = (k * 31 + h) | 0;
    for (const t of cmd.show) k = (k * 31 + t.i * 7 + t.j) | 0;
    sig += `|${k}`;
    if (!this.changed && !cmd.build.length && sig === this.lastSig && !this.backend.wantsFrame) { this.evict(); return; }
    this.lastSig = sig;
    this.changed = false;
    this.backend.frame(cmd);
    this.evict();
  }

  /** The far view: the tiles it shows, and the ones to render now (centre out, within budget). */
  private planFar(f: GpuFrame, cmd: FrameCmd, b: { spent: number; pending: number }) {
    const T0 = GPU_TILE;
    const L = GpuEngine.level(f.s);
    const T = T0 * (f.s / L); // a level tile on screen, device px
    const i0 = Math.floor(-f.ox / T), i1 = Math.floor((f.W - 1 - f.ox) / T);
    const j0 = Math.floor(-f.oy / T), j1 = Math.floor((f.H - 1 - f.oy) / T);
    const cx = (f.W / 2 - f.ox) / T, cy = (f.H / 2 - f.oy) / T;
    const want: [number, number, number][] = [];
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) want.push([i, j, Math.hypot(i + 0.5 - cx, j + 0.5 - cy)]);
    want.sort((a, c) => a[2] - c[2]);
    let partsLeft = f.moving ? 4000 : 20000; // element parts rendered into tiles this frame
    let missing = 0;
    for (const [i, j] of want) {
      const key = `${L}|${i},${j}`;
      let t = this.tiles.get(key);
      if (t && !t.stale) { t.used = this.frameNo; continue; }
      missing++;
      if (partsLeft <= 0 || b.spent >= f.budget) continue;
      const els = f.query({ x: (i * T0) / L, y: (j * T0) / L, w: T0 / L, h: T0 / L });
      const before = b.pending;
      const hs = this.gather(els, f, b);
      if (b.pending > before) continue; // (not all compiled yet: next frame)
      if (!t) { t = { key, L, i, j, stale: true, used: this.frameNo }; this.tiles.set(key, t); }
      t.stale = false;
      t.used = this.frameNo;
      partsLeft -= hs.length;
      cmd.build.push({ key, L, i, j, els: hs });
      missing--;
    }
    this.farPending = missing;
    // what to show: under the gaps other levels' tiles (coarse first, sharper on top), then this level's
    const view = { minX: -f.ox / f.s, minY: -f.oy / f.s, maxX: (f.W - f.ox) / f.s, maxY: (f.H - f.oy) / f.s };
    if (missing) {
      const others = [...this.tiles.values()].filter((t) => t.L !== L && (t.i * T0) / t.L < view.maxX && ((t.i + 1) * T0) / t.L > view.minX && (t.j * T0) / t.L < view.maxY && ((t.j + 1) * T0) / t.L > view.minY);
      cmd.show.push(...others.sort((a, c) => a.L - c.L));
    }
    for (const [i, j] of want) { const t = this.tiles.get(`${L}|${i},${j}`); if (t) cmd.show.push(t); } // (a stale one shows its old picture till it's redone)
    // forget tiles of levels far from this one, and this level's well off screen
    for (const [key, t] of this.tiles) {
      const off = t.L === L ? (t.i < i0 - 3 || t.i > i1 + 3 || t.j < j0 - 3 || t.j > j1 + 3) : (t.L > L * 2.9 || t.L < L / 2.9);
      if (off && t.used < this.frameNo - 30) { this.backend.dropTile(key); this.tiles.delete(key); }
    }
  }
}

export function hexRGB(c: string): RGB {
  const m = /^#([0-9a-f]{6})$/i.exec(c);
  const n = m ? parseInt(m[1], 16) : 0xf7f4ec;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
