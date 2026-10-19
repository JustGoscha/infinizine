/// <reference types="@webgpu/types" />
// The WebGPU renderer: the paper, its grid and every still element drawn on the GPU each
// frame, straight from geometry kept on the GPU (see gpuscene.ts) — the Figma way: no tiles
// to fill in after a pan or a zoom, and Pencil is thousands of stamps in one draw.
// It sits under the 2D canvas, which keeps drawing what moves (animated areas, the live
// stroke, handles and frames). Runs wherever WebGPU does (Chrome, Safari 26, the iPad app on
// iPadOS 26); elsewhere the 2D renderer carries on alone.
//
// Built to stay cheap per element: all geometry lives in a few shared buffers (one for fill
// triangles, one for Pencil stamps, one for dots) and every element's colour, box and offset
// in one table the shaders index — so a draw is just "these vertices, item n", no per-element
// state to bind. Neighbouring fills that don't overlap share one cover pass.
//
// Far out over a crowded zine (thousands of elements in view), drawing every element every
// frame stops paying: the view comes from tiles instead — 512 px bitmaps the GPU renders the
// ink into once (at zoom levels √2 apart), a few each frame from the centre out, and keeps;
// a change re-renders just the tiles under it. Elements whose geometry hasn't been used for a
// while are let go (their tiles keep the picture), so memory stays bounded however big the zine.

import type { Element, TextBox } from './types';
import type { BBox } from './geometry';
import { compile, shapeSig, anchorOf, STAMP_F, type Compiled, type GItem, type GBlend, type SceneSource, type RGB } from './gpuscene';
import { patternTile } from './patterns';
import { paintTextBox } from './text';

const SAMPLES = 4;
const STENCIL: GPUTextureFormat = 'stencil8';
const ITEM_BYTES = 64;
const STAMP_WORDS = STAMP_F + 1; // + the item index
const DOT_WORDS = 3; // x, y, item
const TILE = 512; // far-out tiles, device px
const FAN_BUDGET = 8_000_000; // fill vertices kept (~64 MB); past it, the least recently used elements go
const STAMP_BUDGET = 3_000_000; // Pencil stamps kept (~84 MB)

const HEADER = /* wgsl */ `
struct G { view: vec4f, size: vec4f, grid: vec4f, gridKind: vec4f, gridColor: vec4f };
// per element part: colour (rgb, alpha) · box (world) · extras (pattern: cos, sin, 1/T · dots: radius) · drag offset
struct Item { color: vec4f, bbox: vec4f, p: vec4f, off: vec4f };
@group(0) @binding(0) var<uniform> g: G;
@group(0) @binding(1) var<storage, read> items: array<Item>;
// world → clip: the element's drag offset, then the camera (device px), then the viewport
fn toClip(w: vec2f, it: Item) -> vec4f {
  let d = (w + it.off.xy) * g.view.x + g.view.yz;
  return vec4f(d.x / g.size.x * 2.0 - 1.0, 1.0 - d.y / g.size.y * 2.0, 0.0, 1.0);
}
// the item's colour at coverage a, premultiplied (alpha × the focus dimming)
fn premul(it: Item, a: f32) -> vec4f { let k = it.color.a * g.view.w * a; return vec4f(it.color.rgb * k, k); }
fn quad(i: u32) -> vec2f { return vec2f(f32(i & 1u), f32(i >> 1u)); }
struct CoverOut { @builtin(position) pos: vec4f, @location(0) world: vec2f, @location(1) @interpolate(flat) idx: u32 };
@vertex fn vs_cover(@builtin(vertex_index) i: u32, @location(0) idx: u32) -> CoverOut {
  let it = items[idx];
  let pad = 1.0 / g.view.x; // a pixel round the box: its antialiased edge is in
  let w = mix(it.bbox.xy - pad, it.bbox.zw + pad, quad(i));
  var o: CoverOut; o.pos = toClip(w, it); o.world = w; o.idx = idx; return o;
}
@fragment fn fs_none() -> @location(0) vec4f { return vec4f(0.0); }
`;

const PLAIN = HEADER + /* wgsl */ `
// fill triangles: the item comes in as the instance index (draw(n, 1, first, item))
@vertex fn vs_fan(@location(0) p: vec2f, @builtin(instance_index) ii: u32) -> @builtin(position) vec4f { return toClip(p, items[ii]); }
@fragment fn fs_solid(i: CoverOut) -> @location(0) vec4f { return premul(items[i.idx], 1.0); }

struct DOut { @builtin(position) pos: vec4f, @location(0) @interpolate(perspective, sample) local: vec2f, @location(1) @interpolate(flat) idx: u32 };
@vertex fn vs_dot(@builtin(vertex_index) i: u32, @location(0) c: vec2f, @location(1) idx: u32) -> DOut {
  let it = items[idx];
  let ext = it.p.x + 1.5 / g.view.x;
  let k = quad(i) * 2.0 - 1.0;
  var o: DOut; o.pos = toClip(c + k * ext, it); o.local = k * ext; o.idx = idx; return o;
}
// per sample: in or out of the dot (the stencil lets each sample take one dot: the union, like a path)
@fragment fn fs_dot(i: DOut) -> @location(0) vec4f {
  let it = items[i.idx];
  if (dot(i.local, i.local) > it.p.x * it.p.x) { discard; }
  return premul(it, 1.0);
}

@vertex fn vs_full(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
// the paper's dots / lines / grid: marks centred on the cell corners, box-filtered over the pixel
@fragment fn fs_grid(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let sp = g.grid.x;
  let q = pos.xy - g.grid.yz;
  let f = q - round(q / sp) * sp;
  var cov = 0.0;
  if (g.gridKind.x == 1.0) {
    let m = g.grid.w;
    let ov = clamp(vec2f(m * 0.5 + 0.5) - abs(f), vec2f(0.0), vec2f(min(m, 1.0)));
    cov = ov.x * ov.y;
  } else {
    let lw = g.gridKind.y;
    let h = clamp(lw * 0.5 + 0.5 - abs(f.y), 0.0, min(lw, 1.0));
    var v = 0.0;
    if (g.gridKind.x == 3.0) { v = clamp(lw * 0.5 + 0.5 - abs(f.x), 0.0, min(lw, 1.0)); }
    cov = max(h, v);
  }
  let a = g.gridColor.a * cov;
  return vec4f(g.gridColor.rgb * a, a);
}
`;

const TEXTURED = HEADER + /* wgsl */ `
@group(1) @binding(0) var ttex: texture_2d<f32>;
@group(1) @binding(1) var tsamp: sampler;
// a repeating pattern tile, anchored to the world origin, turned by the fill's angle
@fragment fn fs_pat(i: CoverOut) -> @location(0) vec4f {
  let it = items[i.idx];
  let w = i.world;
  let uv = vec2f(w.x * it.p.x + w.y * it.p.y, -w.x * it.p.y + w.y * it.p.x) * it.p.z;
  return premul(it, textureSample(ttex, tsamp, uv).a);
}
struct TOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) @interpolate(flat) idx: u32 };
@vertex fn vs_tex(@builtin(vertex_index) i: u32, @location(0) idx: u32) -> TOut {
  let it = items[idx];
  let c = quad(i);
  var o: TOut; o.pos = toClip(mix(it.bbox.xy, it.bbox.zw, c), it); o.uv = c; o.idx = idx; return o;
}
@fragment fn fs_tex(i: TOut) -> @location(0) vec4f {
  return textureSample(ttex, tsamp, i.uv) * (items[i.idx].color.a * g.view.w); // (the bitmap is premultiplied)
}
`;

const STAMPS = HEADER + /* wgsl */ `
@group(1) @binding(0) var nibs: texture_2d_array<f32>;
@group(1) @binding(1) var nsamp: sampler;
struct SOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) @interpolate(flat) layer: i32, @location(2) a: f32, @location(3) @interpolate(flat) idx: u32 };
@vertex fn vs_stamp(@builtin(vertex_index) i: u32, @location(0) s: vec4f, @location(1) la: vec2f, @location(2) idx: u32) -> SOut {
  let it = items[idx];
  let k = quad(i) * 2.0 - 1.0;
  var r = s.z;
  var a = la.x;
  // a stamp under a pixel or so would fall between the pixels' samples: drawn that big, fainter
  let rpx = r * g.view.x;
  if (rpx < g.size.w) { a = a * (rpx / g.size.w) * (rpx / g.size.w); r = g.size.w / g.view.x; }
  let c = cos(s.w);
  let sn = sin(s.w);
  let l = k * r;
  var o: SOut;
  o.pos = toClip(s.xy + vec2f(c * l.x - sn * l.y, sn * l.x + c * l.y), it);
  o.uv = k * 0.5 + 0.5; o.layer = i32(la.y); o.a = a; o.idx = idx;
  return o;
}
@fragment fn fs_stamp(i: SOut) -> @location(0) vec4f {
  return premul(items[i.idx], textureSample(nibs, nsamp, i.uv, i.layer).a * i.a);
}
`;

/** A first-fit allocator over a growable GPU buffer (units of `unit` bytes). */
class Arena {
  buf: GPUBuffer;
  cap: number;
  gen = 0; // bumped when the buffer is replaced (bind groups over it must be made again)
  private free: [number, number][];
  used = 0;
  constructor(private device: GPUDevice, private unit: number, private usage: number, cap: number) {
    this.cap = cap;
    this.buf = device.createBuffer({ size: cap * unit, usage: usage | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    this.free = [[0, cap]];
  }
  alloc(n: number): number {
    if (n <= 0) return 0;
    for (let k = 0; k < this.free.length; k++) {
      const [s, l] = this.free[k];
      if (l < n) continue;
      if (l === n) this.free.splice(k, 1); else this.free[k] = [s + n, l - n];
      this.used += n;
      return s;
    }
    // grow (at least double), keeping what's there
    const old = this.buf, oldCap = this.cap;
    let cap = oldCap * 2;
    while (cap - oldCap < n) cap *= 2;
    this.buf = this.device.createBuffer({ size: cap * this.unit, usage: this.usage | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(old, 0, this.buf, 0, oldCap * this.unit);
    this.device.queue.submit([enc.finish()]);
    old.destroy();
    this.cap = cap;
    this.gen++;
    this.release(oldCap, cap - oldCap, false);
    return this.alloc(n);
  }
  release(s: number, n: number, counted = true) {
    if (n <= 0) return;
    if (counted) this.used -= n;
    const f = this.free;
    let k = 0;
    while (k < f.length && f[k][0] < s) k++;
    f.splice(k, 0, [s, n]);
    // merge with the neighbours
    if (k + 1 < f.length && f[k][0] + f[k][1] === f[k + 1][0]) { f[k][1] += f[k + 1][1]; f.splice(k + 1, 1); }
    if (k > 0 && f[k - 1][0] + f[k - 1][1] === f[k][0]) { f[k - 1][1] += f[k][1]; f.splice(k, 1); }
  }
  write(at: number, data: ArrayBufferView) {
    this.device.queue.writeBuffer(this.buf, at * this.unit, data as ArrayBufferView<ArrayBuffer>);
  }
}

interface Ref {
  item: GItem;
  slot: number; // in the item table
  v?: number; vn?: number; // fill triangles (vertices) in the fan arena
  inst?: number; n?: number; // stamps / dots in theirs
  tint?: Ref;
  texKey?: string; tex?: GPUTexture; group?: GPUBindGroup; nearest?: GPUBindGroup;
  texts?: Map<number, { tex: GPUTexture; group: GPUBindGroup }>; // a text box's bitmaps by scale (the view's and the far tiles')
  box: BBox; // for batching (world, without the drag offset)
}
interface GpuEl { c: Compiled; refs: Ref[]; off: [number, number]; used: number }
/** a far-out tile: the ink of world rect (i, j) at L device px per world unit */
interface FarTile { i: number; j: number; L: number; tex: GPUTexture; group: GPUBindGroup; slot: number; stale: boolean; used: number }
type View = { x: number; y: number; w: number; h: number };

export interface GpuFrame {
  W: number; H: number; dpr: number;
  s: number; ox: number; oy: number; // world → device px
  dim: number; // focus dimming (1 = none)
  paper: string;
  grid: { kind: 0 | 1 | 2 | 3; sp: number; x: number; y: number; dark: boolean } | null; // CSS px
  els: Element[]; // in drawing order
  /** crowded far-out view: tiles instead of elements — the still ink in a world rect, in drawing order */
  far?: (r: View) => Element[];
  moving: boolean;
  detail: number;
  budget: number; // ms of compiling this frame
}

const BLENDS: Record<GBlend, GPUBlendState> = {
  over: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } },
  // over an opaque paper: ink × paper, like Canvas 2D's multiply there
  multiply: { color: { srcFactor: 'dst', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } },
  screen: { color: { srcFactor: 'one', dstFactor: 'one-minus-src' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } },
};

export class WebGPURenderer {
  private context: GPUCanvasContext;
  private format: GPUTextureFormat;
  private msaa: GPUTexture | null = null;
  private stencil: GPUTexture | null = null;
  private globals: GPUBuffer;
  private gLayout: GPUBindGroupLayout;
  private globalsGroup: GPUBindGroup | null = null;
  private groupGen = -1;
  private texLayout: GPUBindGroupLayout;
  private nibLayout: GPUBindGroupLayout;
  private p: Record<string, GPURenderPipeline> = {};
  private linearRepeat: GPUSampler;
  private linearClamp: GPUSampler;
  private nearestClamp: GPUSampler;
  private itemsA: Arena;
  private fanA: Arena;
  private stampA: Arena;
  private dotA: Arena;
  private coverBuf: GPUBuffer;
  private coverCap = 4096;
  private cover = new Uint32Array(4096);
  private coverN = 0;
  private els = new Map<string, GpuEl>();
  private patTex = new Map<string, GPUTexture>();
  private nibTex: GPUTexture | null = null;
  private nibGroup: GPUBindGroup | null = null;
  private far = new Map<string, FarTile>(); // key `${L}|${i},${j}`
  private tileMsaa: GPUTexture | null = null;
  private tileStencil: GPUTexture | null = null;
  private frameNo = 0;
  lost = false;
  /** far-out tiles still to render for the view (0 = complete) */
  farPending = 0;
  /** elements not drawn last frame (still compiling) */
  pending = 0;
  /** draw calls last frame */
  draws = 0;
  /** profiling: ms spent compiling (by element kind) and elements compiled; ms encoding the last frame */
  stats = { compileMs: {} as Record<string, number>, compiled: {} as Record<string, number>, encodeMs: 0 };

  static async create(canvas: HTMLCanvasElement, src: SceneSource & { nibs(): HTMLCanvasElement[] }): Promise<WebGPURenderer | null> {
    try {
      if (!navigator.gpu) return null;
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return null;
      // (as big as the adapter allows: a crowded zine's geometry can pass the 256 MB default)
      const device = await adapter.requestDevice({ requiredLimits: { maxBufferSize: adapter.limits.maxBufferSize, maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize } });
      device.addEventListener('uncapturederror', (e) => console.warn('[InfiniZine] WebGPU error', (e as GPUUncapturedErrorEvent).error.message));
      const r = new WebGPURenderer(canvas, device, src);
      device.lost.then(() => { r.lost = true; });
      return r;
    } catch (e) {
      console.warn('[InfiniZine] WebGPU unavailable', e);
      return null;
    }
  }

  private constructor(private canvas: HTMLCanvasElement, private device: GPUDevice, private src: SceneSource & { nibs(): HTMLCanvasElement[] }) {
    this.context = canvas.getContext('webgpu')!;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device, format: this.format, alphaMode: 'opaque' });
    const d = device;
    this.globals = d.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.itemsA = new Arena(d, ITEM_BYTES, GPUBufferUsage.STORAGE, 4096);
    this.fanA = new Arena(d, 8, GPUBufferUsage.VERTEX, 1 << 18);
    this.stampA = new Arena(d, STAMP_WORDS * 4, GPUBufferUsage.VERTEX, 1 << 16);
    this.dotA = new Arena(d, DOT_WORDS * 4, GPUBufferUsage.VERTEX, 1 << 14);
    this.coverBuf = d.createBuffer({ size: this.coverCap * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    const vf = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    this.gLayout = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: vf, buffer: {} }, { binding: 1, visibility: vf, buffer: { type: 'read-only-storage' } }] });
    this.texLayout = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} }, { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} }] });
    this.nibLayout = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } }, { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} }] });
    this.linearRepeat = d.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat' });
    this.linearClamp = d.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
    this.nearestClamp = d.createSampler({ magFilter: 'nearest', minFilter: 'nearest', mipmapFilter: 'nearest' });
    const plain = d.createShaderModule({ code: PLAIN });
    const textured = d.createShaderModule({ code: TEXTURED });
    const stamps = d.createShaderModule({ code: STAMPS });
    const stencilState = (compare: GPUCompareFunction, pass: GPUStencilOperation, back?: GPUStencilOperation): GPUDepthStencilState => ({
      format: STENCIL,
      stencilFront: { compare, passOp: pass, failOp: 'keep' },
      stencilBack: { compare, passOp: back ?? pass, failOp: 'keep' },
    });
    const idxBuf: GPUVertexBufferLayout = { arrayStride: 4, stepMode: 'instance', attributes: [{ shaderLocation: 0, offset: 0, format: 'uint32' }] };
    const pipe = (o: { module: GPUShaderModule; vs: string; fs: string; group1?: GPUBindGroupLayout; blend?: GPUBlendState; write?: boolean; buffers?: GPUVertexBufferLayout[]; topology?: GPUPrimitiveTopology; stencil: GPUDepthStencilState }) =>
      d.createRenderPipeline({
        layout: d.createPipelineLayout({ bindGroupLayouts: o.group1 ? [this.gLayout, o.group1] : [this.gLayout] }),
        vertex: { module: o.module, entryPoint: o.vs, buffers: o.buffers ?? [] },
        fragment: { module: o.module, entryPoint: o.fs, targets: [{ format: this.format, blend: o.blend, writeMask: o.write === false ? 0 : GPUColorWrite.ALL }] },
        primitive: { topology: o.topology ?? 'triangle-strip', cullMode: 'none' },
        depthStencil: o.stencil,
        multisample: { count: SAMPLES },
      });
    this.p.fanStencil = pipe({
      module: plain, vs: 'vs_fan', fs: 'fs_none', write: false, topology: 'triangle-list',
      buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] }],
      stencil: stencilState('always', 'increment-wrap', 'decrement-wrap'),
    });
    this.p.stencilClear = pipe({ module: plain, vs: 'vs_cover', fs: 'fs_none', write: false, buffers: [idxBuf], stencil: stencilState('always', 'zero') });
    for (const b of Object.keys(BLENDS) as GBlend[]) {
      this.p[`cover-${b}`] = pipe({ module: plain, vs: 'vs_cover', fs: 'fs_solid', blend: BLENDS[b], buffers: [idxBuf], stencil: stencilState('not-equal', 'zero') });
      this.p[`pat-${b}`] = pipe({ module: textured, vs: 'vs_cover', fs: 'fs_pat', group1: this.texLayout, blend: BLENDS[b], buffers: [idxBuf], stencil: stencilState('not-equal', 'zero') });
      this.p[`dots-${b}`] = pipe({
        module: plain, vs: 'vs_dot', fs: 'fs_dot', blend: BLENDS[b], stencil: stencilState('not-equal', 'replace'),
        buffers: [{ arrayStride: DOT_WORDS * 4, stepMode: 'instance', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }, { shaderLocation: 1, offset: 8, format: 'uint32' }] }],
      });
      this.p[`tex-${b}`] = pipe({ module: textured, vs: 'vs_tex', fs: 'fs_tex', group1: this.texLayout, blend: BLENDS[b], buffers: [idxBuf], stencil: stencilState('always', 'keep') });
    }
    this.p.stamps = pipe({
      module: stamps, vs: 'vs_stamp', fs: 'fs_stamp', group1: this.nibLayout, blend: BLENDS.over, stencil: stencilState('always', 'keep'),
      buffers: [{ arrayStride: STAMP_WORDS * 4, stepMode: 'instance', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }, { shaderLocation: 1, offset: 16, format: 'float32x2' }, { shaderLocation: 2, offset: 24, format: 'uint32' }] }],
    });
    this.p.grid = pipe({ module: plain, vs: 'vs_full', fs: 'fs_grid', blend: BLENDS.over, topology: 'triangle-list', stencil: stencilState('always', 'keep') });
    // (over far tiles, which hold the paper too: the marks blended in like ink)
    this.p.gridMultiply = pipe({ module: plain, vs: 'vs_full', fs: 'fs_grid', blend: BLENDS.multiply, topology: 'triangle-list', stencil: stencilState('always', 'keep') });
    this.p.gridScreen = pipe({ module: plain, vs: 'vs_full', fs: 'fs_grid', blend: BLENDS.screen, topology: 'triangle-list', stencil: stencilState('always', 'keep') });
  }

  get ok(): boolean { return !this.lost; }
  /** what's held on the GPU (for the benchmark) */
  memory(): string {
    const mb = (n: number) => (n / 1e6).toFixed(0);
    return `els ${this.els.size} · fill ${mb(this.fanA.used * 8)}/${mb(this.fanA.cap * 8)}MB · stamps ${mb(this.stampA.used * STAMP_WORDS * 4)}/${mb(this.stampA.cap * STAMP_WORDS * 4)}MB · dots ${mb(this.dotA.used * 12)}MB · items ${this.itemsA.used} · far tiles ${this.far.size} · draws ${this.draws}`;
  }

  // ---- scene ----

  /** Forget elements (changed, deleted) — or all of them. */
  drop(ids?: Iterable<string>) {
    if (!ids) { this.dropTiles(); for (const id of [...this.els.keys()]) this.dropEl(id, false); return; }
    for (const id of ids) this.dropEl(id);
  }
  private dropEl(id: string, stale = true) {
    const e = this.els.get(id);
    if (!e) return;
    if (stale && this.far.size) this.staleRects([this.boxNow(e)]);
    for (const r of e.refs) this.freeRef(r);
    this.els.delete(id);
  }
  private freeRef(r: Ref) {
    this.itemsA.release(r.slot, 1);
    if (r.vn) this.fanA.release(r.v!, r.vn);
    if (r.n) (r.item.k === 'stamps' ? this.stampA : this.dotA).release(r.inst!, r.n);
    r.tex?.destroy();
    for (const t of r.texts?.values() ?? []) t.tex.destroy();
    if (r.tint) this.freeRef(r.tint);
  }

  private boxNow(e: GpuEl): BBox {
    const b = e.c.bbox, [dx, dy] = e.off;
    return { minX: b.minX + dx, minY: b.minY + dy, maxX: b.maxX + dx, maxY: b.maxY + dy };
  }

  /** An element changed: a pure move keeps its geometry (drawn shifted); anything else compiles again. */
  touch(el: Element, patternsToo = false) {
    const e = this.els.get(el.id);
    if (!e) return;
    if (this.far.size) this.staleRects([this.boxNow(e)]); // (where it was)
    const movable = !(patternsToo && el.kind === 'fill' && el.pattern); // (a moved pattern re-anchors to the world once dropped)
    if (movable && e.c.sig === shapeSig(el)) {
      const a = anchorOf(el);
      const dx = a.x - e.c.anchor.x, dy = a.y - e.c.anchor.y;
      if (dx !== e.off[0] || dy !== e.off[1]) {
        e.off = [dx, dy];
        const off = new Float32Array([dx, dy, 0, 0]);
        const put = (r: Ref) => { this.device.queue.writeBuffer(this.itemsA.buf, r.slot * ITEM_BYTES + 48, off); if (r.tint) put(r.tint); };
        e.refs.forEach(put);
      }
      return;
    }
    this.dropEl(el.id);
  }

  private newItem(color: RGB, alpha: number, box: BBox, p: [number, number, number, number] = [0, 0, 0, 0]): number {
    const slot = this.itemsA.alloc(1);
    this.itemsA.write(slot, new Float32Array([color[0], color[1], color[2], alpha, box.minX, box.minY, box.maxX, box.maxY, ...p, 0, 0, 0, 0]));
    return slot;
  }
  private fanRef(it: GItem & { tri: Float32Array; color: RGB; alpha: number; bbox: BBox }, p?: [number, number, number, number]): Ref {
    const vn = it.tri.length / 2;
    const v = this.fanA.alloc(vn);
    this.fanA.write(v, it.tri);
    return { item: it, slot: this.newItem(it.color, it.alpha, it.bbox, p), v, vn, box: it.bbox };
  }

  private build(c: Compiled): GpuEl {
    const refs: Ref[] = [];
    for (const it of c.items) {
      if (it.k === 'fan') refs.push(this.fanRef(it));
      else if (it.k === 'pat') {
        const a = (it.angle * Math.PI) / 180;
        refs.push(this.fanRef(it, [Math.cos(a), Math.sin(a), 1 / it.T, 0]));
      } else if (it.k === 'stamps') {
        const slot = this.newItem(it.color, it.alpha, it.bbox);
        const buf = new ArrayBuffer(it.n * STAMP_WORDS * 4), f = new Float32Array(buf), u = new Uint32Array(buf);
        for (let i = 0; i < it.n; i++) {
          for (let k = 0; k < STAMP_F; k++) f[i * STAMP_WORDS + k] = it.data[i * STAMP_F + k];
          u[i * STAMP_WORDS + STAMP_F] = slot;
        }
        const inst = this.stampA.alloc(it.n);
        this.stampA.write(inst, f);
        refs.push({ item: it, slot, inst, n: it.n, box: it.bbox });
      } else if (it.k === 'dots') {
        const slot = this.newItem(it.color, it.alpha, it.bbox, [it.r, 0, 0, 0]);
        const buf = new ArrayBuffer(it.n * DOT_WORDS * 4), f = new Float32Array(buf), u = new Uint32Array(buf);
        for (let i = 0; i < it.n; i++) { f[i * 3] = it.xy[i * 2]; f[i * 3 + 1] = it.xy[i * 2 + 1]; u[i * 3 + 2] = slot; }
        const inst = this.dotA.alloc(it.n);
        this.dotA.write(inst, f);
        refs.push({ item: it, slot, inst, n: it.n, box: it.bbox, tint: this.fanRef(it.tint) });
      } else {
        const r = it.rect, box = { minX: r.x, minY: r.y, maxX: r.x + r.w, maxY: r.y + r.h };
        refs.push({ item: it, slot: this.newItem([0, 0, 0], it.alpha, box), box, tint: it.tint ? this.fanRef(it.tint) : undefined });
      }
    }
    return { c, refs, off: [0, 0], used: this.frameNo };
  }

  private compileTimed(el: Element, detail: number): GpuEl {
    const t0 = performance.now();
    const e = this.build(compile(el, detail, this.src));
    const k = el.kind === 'stroke' ? el.tool : el.kind === 'fill' ? (el.pattern ? el.pattern.replace(/-\d+$/, '') : 'fill') : el.kind;
    this.stats.compileMs[k] = (this.stats.compileMs[k] ?? 0) + performance.now() - t0;
    this.stats.compiled[k] = (this.stats.compiled[k] ?? 0) + 1;
    return e;
  }

  // ---- textures ----

  /** A texture from a bitmap, with its mip chain (halved on the CPU) for what's drawn much smaller
   * than its size: images, pattern tiles, nibs. (Text and pixel cells are made for the scale they're
   * drawn at: no chain — making one per element cost far-out tiles most of their time.) */
  private upload(src: HTMLCanvasElement | HTMLImageElement, w: number, h: number, layers?: (HTMLCanvasElement | HTMLImageElement)[], mips = true): GPUTexture {
    const levels = mips ? Math.floor(Math.log2(Math.max(w, h))) + 1 : 1;
    const list = layers ?? [src];
    const tex = this.device.createTexture({
      size: [w, h, list.length], format: 'rgba8unorm', mipLevelCount: levels,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    list.forEach((layer, z) => {
      let cur: HTMLCanvasElement | HTMLImageElement = layer;
      let cw = w, ch = h;
      for (let lv = 0; lv < levels; lv++) {
        if (lv > 0) {
          const nw = Math.max(1, cw >> 1), nh = Math.max(1, ch >> 1);
          const c = document.createElement('canvas');
          c.width = nw; c.height = nh;
          const g = c.getContext('2d')!;
          g.imageSmoothingQuality = 'high';
          g.drawImage(cur, 0, 0, nw, nh);
          cur = c; cw = nw; ch = nh;
        }
        this.device.queue.copyExternalImageToTexture({ source: cur }, { texture: tex, mipLevel: lv, origin: [0, 0, z], premultipliedAlpha: true }, [cw, ch, 1]);
      }
    });
    return tex;
  }
  private texGroup(tex: GPUTexture, sampler: GPUSampler) {
    return this.device.createBindGroup({ layout: this.texLayout, entries: [{ binding: 0, resource: tex.createView() }, { binding: 1, resource: sampler }] });
  }

  private nibs(): GPUBindGroup {
    if (!this.nibGroup) {
      const n = this.src.nibs();
      this.nibTex = this.upload(n[0], 64, 64, n);
      this.nibGroup = this.device.createBindGroup({ layout: this.nibLayout, entries: [{ binding: 0, resource: this.nibTex.createView({ dimension: '2d-array' }) }, { binding: 1, resource: this.linearClamp }] });
    }
    return this.nibGroup;
  }

  /** A pattern's tile, `px` px across (alpha only: coloured in the shader). */
  private patternTexture(id: string, px: number): GPUTexture {
    const key = `${id}|${px}`;
    let t = this.patTex.get(key);
    if (!t) {
      t = this.upload(patternTile(id, '#000000', px), px, px);
      this.patTex.set(key, t);
    }
    return t;
  }

  /** A text box rasterised at `scale` px per world unit (a power of two, so it's redone only per octave of zoom). */
  private textCanvas(el: TextBox, scale: number): { c: HTMLCanvasElement; pad: number } {
    const pad = el.fontSize * 0.4; // italics and descenders spill past the measured box
    let s = scale;
    while ((el.w + 2 * pad) * s > 4096 || (el.h + 2 * pad) * s > 4096) s /= 2;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil((el.w + 2 * pad) * s));
    c.height = Math.max(1, Math.ceil((el.h + 2 * pad) * s));
    const g = c.getContext('2d')!;
    g.setTransform(s, 0, 0, s, (pad - el.x) * s, (pad - el.y) * s);
    paintTextBox(g, el);
    return { c, pad };
  }

  /** Make sure a bitmap item has its texture (and the right resolution of it); false if it can't draw yet. */
  private readyTex(r: Ref, s: number): boolean {
    const it = r.item;
    if (it.k === 'pat') {
      const px = Math.max(16, Math.min(1024, 2 ** Math.ceil(Math.log2(Math.max(1, it.T * s)))));
      const key = String(px);
      if (r.texKey !== key) { r.texKey = key; r.group = this.texGroup(this.patternTexture(it.pattern, px), this.linearRepeat); }
      return true;
    }
    if (it.k !== 'tex') return true;
    const src = it.src;
    if (src.kind === 'text') {
      const scale = 2 ** Math.ceil(Math.log2(Math.max(1 / 64, s)));
      r.texts ??= new Map();
      let t = r.texts.get(scale);
      if (!t) {
        const { c, pad } = this.textCanvas(src.el, scale);
        const tex = this.upload(c, c.width, c.height, undefined, false);
        t = { tex, group: this.texGroup(tex, this.linearClamp) };
        r.texts.set(scale, t);
        // (two scales kept: the view's and the far tiles')
        if (r.texts.size > 2) { const [k0, t0] = r.texts.entries().next().value!; if (k0 !== scale) { t0.tex.destroy(); r.texts.delete(k0); } }
        if (r.texKey === undefined) {
          r.texKey = 'text';
          const q = it.rect;
          this.device.queue.writeBuffer(this.itemsA.buf, r.slot * ITEM_BYTES + 16, new Float32Array([q.x - pad, q.y - pad, q.x + q.w + pad, q.y + q.h + pad]));
        }
      }
      r.group = t.group;
      return true;
    }
    if (!r.tex) {
      const img = src.kind === 'image' ? src.img : src.canvas;
      const w = img instanceof HTMLImageElement ? img.naturalWidth : img.width;
      const h = img instanceof HTMLImageElement ? img.naturalHeight : img.height;
      if (!w || !h || (img instanceof HTMLImageElement && !img.complete)) return false;
      r.tex = this.upload(img, w, h, undefined, src.kind === 'image');
      r.group = this.texGroup(r.tex, this.linearClamp);
      if (it.cell) r.nearest = this.texGroup(r.tex, this.nearestClamp);
    }
    return true;
  }

  // ---- frame ----

  private ensureTargets(W: number, H: number) {
    if (this.canvas.width !== W || this.canvas.height !== H || !this.msaa) {
      this.canvas.width = W; this.canvas.height = H;
      this.msaa?.destroy(); this.stencil?.destroy();
      this.msaa = this.device.createTexture({ size: [W, H], format: this.format, sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT });
      this.stencil = this.device.createTexture({ size: [W, H], format: STENCIL, sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    }
  }
  private group0(): GPUBindGroup {
    if (!this.globalsGroup || this.groupGen !== this.itemsA.gen) {
      this.groupGen = this.itemsA.gen;
      this.globalsGroup = this.device.createBindGroup({ layout: this.gLayout, entries: [{ binding: 0, resource: { buffer: this.globals } }, { binding: 1, resource: { buffer: this.itemsA.buf } }] });
    }
    return this.globalsGroup;
  }
  /** Queue an item index for an instanced cover-type draw; returns its position. */
  private pushCover(slot: number): number {
    if (this.coverN >= this.cover.length) { const g = new Uint32Array(this.cover.length * 2); g.set(this.cover); this.cover = g; }
    this.cover[this.coverN] = slot;
    return this.coverN++;
  }

  /** The elements' compiled parts (compiling what's missing while the budget lasts). */
  private gather(f: GpuFrame): GpuEl[] {
    const b = { spent: 0, pending: 0 };
    const out = this.gatherEls(f.els, f, b);
    this.pending = b.pending;
    return out;
  }
  private gatherEls(els: Element[], f: GpuFrame, b: { spent: number; pending: number }): GpuEl[] {
    const out: GpuEl[] = [];
    let { spent, pending } = b;
    for (const el of els) {
      let e = this.els.get(el.id);
      if (e && !e.c.zoomFree && e.c.detail !== f.detail && spent < f.budget) {
        // finer (or coarser) outlines for this zoom, while there's time (the old ones draw meanwhile)
        const t0 = performance.now();
        const moved = e.off[0] || e.off[1];
        this.dropEl(el.id, false);
        e = this.compileTimed(el, f.detail);
        this.els.set(el.id, e);
        if (moved) this.touch(el);
        spent += performance.now() - t0;
      }
      if (!e) {
        if (spent >= f.budget) { pending++; continue; }
        const t0 = performance.now();
        e = this.compileTimed(el, f.detail);
        this.els.set(el.id, e);
        spent += performance.now() - t0;
      }
      e.used = this.frameNo;
      out.push(e);
    }
    b.spent = spent; b.pending = pending;
    return out;
  }

  /** Let go of the geometry of elements unused the longest while over budget (their tiles keep the picture). */
  private evict() {
    if (this.fanA.used <= FAN_BUDGET && this.stampA.used <= STAMP_BUDGET) return;
    const old = [...this.els.entries()].filter(([, e]) => e.used < this.frameNo).sort((a, b) => a[1].used - b[1].used);
    for (const [id] of old) {
      if (this.fanA.used <= FAN_BUDGET * 0.75 && this.stampA.used <= STAMP_BUDGET * 0.75) break;
      this.dropEl(id, false);
    }
  }

  // ---- far-out tiles ----

  /** The tile level for a scale: √2 steps at or above it, so a tile is drawn at most √2 smaller. */
  private static level(s: number): number { return Math.pow(2, Math.ceil(Math.log2(s) * 2 - 1e-9) / 2); }

  /** Tiles under these world boxes are rendered again (the old picture shows until then). */
  staleRects(boxes: BBox[]) {
    for (const t of this.far.values()) {
      const x0 = (t.i * TILE) / t.L, y0 = (t.j * TILE) / t.L, x1 = ((t.i + 1) * TILE) / t.L, y1 = ((t.j + 1) * TILE) / t.L;
      if (boxes.some((b) => b.minX < x1 && b.maxX > x0 && b.minY < y1 && b.maxY > y0)) t.stale = true;
    }
  }
  /** Forget every far tile (paper or grid changed, a big edit). */
  dropTiles() {
    for (const t of this.far.values()) { t.tex.destroy(); this.itemsA.release(t.slot, 1); }
    this.far.clear();
  }

  /** Plan this frame's far view: which tiles it shows, and the ones to render now (centre out, within budget). */
  private planFar(f: GpuFrame): { show: FarTile[]; build: { t: FarTile; list: GpuEl[] }[] } {
    const L = WebGPURenderer.level(f.s);
    const k = f.s / L; // a level tile on screen: TILE·k device px
    const T = TILE * k;
    const i0 = Math.floor(-f.ox / T), i1 = Math.floor((f.W - 1 - f.ox) / T);
    const j0 = Math.floor(-f.oy / T), j1 = Math.floor((f.H - 1 - f.oy) / T);
    const cx = (f.W / 2 - f.ox) / T, cy = (f.H / 2 - f.oy) / T;
    const want: [number, number, number][] = [];
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) want.push([i, j, Math.hypot(i + 0.5 - cx, j + 0.5 - cy)]);
    want.sort((a, b) => a[2] - b[2]);
    const build: { t: FarTile; list: GpuEl[] }[] = [];
    const b = { spent: 0, pending: 0 };
    let drawsLeft = f.moving ? 4000 : 20000; // element parts rendered into tiles this frame
    let missing = 0;
    for (const [i, j] of want) {
      const key = `${L}|${i},${j}`;
      let t = this.far.get(key);
      if (t && !t.stale) { t.used = this.frameNo; continue; }
      missing++;
      if (drawsLeft <= 0 || b.spent >= f.budget) continue;
      const rect = { x: (i * TILE) / L, y: (j * TILE) / L, w: TILE / L, h: TILE / L };
      const els = f.far!(rect);
      const before = b.pending;
      const list = this.gatherEls(els, f, b);
      if (b.pending > before) continue; // (not all compiled yet: next frame)
      if (!t) {
        const tex = this.device.createTexture({ size: [TILE, TILE], format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
        t = { i, j, L, tex, group: this.texGroup(tex, this.linearClamp), slot: this.newItem([0, 0, 0], 1, { minX: rect.x, minY: rect.y, maxX: rect.x + rect.w, maxY: rect.y + rect.h }), stale: true, used: this.frameNo };
        this.far.set(key, t);
      }
      t.stale = false;
      t.used = this.frameNo;
      for (const e of list) drawsLeft -= e.refs.length;
      build.push({ t, list });
      missing--;
    }
    this.farPending = missing;
    this.pending = b.pending;
    // what to show: this level's tiles, and under the gaps other levels' (coarse first, sharper on top)
    const show: FarTile[] = [];
    const view = { minX: -f.ox / f.s, minY: -f.oy / f.s, maxX: (f.W - f.ox) / f.s, maxY: (f.H - f.oy) / f.s };
    const others = [...this.far.values()].filter((t) => t.L !== L && (t.i * TILE) / t.L < view.maxX && ((t.i + 1) * TILE) / t.L > view.minX && (t.j * TILE) / t.L < view.maxY && ((t.j + 1) * TILE) / t.L > view.minY);
    if (missing) show.push(...others.sort((a, b) => a.L - b.L));
    for (const [i, j] of want) { const t = this.far.get(`${L}|${i},${j}`); if (t) show.push(t); }
    // forget tiles of levels far from this one, and this level's well off screen
    for (const [key, t] of this.far) {
      const off = t.L === L ? (t.i < i0 - 3 || t.i > i1 + 3 || t.j < j0 - 3 || t.j > j1 + 3) : (t.L > L * 2.9 || t.L < L / 2.9);
      if (off && t.used < this.frameNo - 30) { t.tex.destroy(); this.itemsA.release(t.slot, 1); this.far.delete(key); }
    }
    return { show, build };
  }

  /** Render a tile's elements into its texture (one pass, its own camera). */
  private encodeTile(enc: GPUCommandEncoder, t: FarTile, list: GpuEl[], f: GpuFrame) {
    const d = this.device;
    if (!this.tileMsaa) {
      this.tileMsaa = d.createTexture({ size: [TILE, TILE], format: this.format, sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT });
      this.tileStencil = d.createTexture({ size: [TILE, TILE], format: STENCIL, sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    }
    const gl = d.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(gl, 0, new Float32Array([t.L, -t.i * TILE, -t.j * TILE, 1, TILE, TILE, f.dpr, 0.75, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    const group = d.createBindGroup({ layout: this.gLayout, entries: [{ binding: 0, resource: { buffer: gl } }, { binding: 1, resource: { buffer: this.itemsA.buf } }] });
    const paper = rgb(f.paper);
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.tileMsaa.createView(), resolveTarget: t.tex.createView(), clearValue: { r: paper[0], g: paper[1], b: paper[2], a: 1 }, loadOp: 'clear', storeOp: 'discard' }],
      depthStencilAttachment: { view: this.tileStencil!.createView(), stencilClearValue: 0, stencilLoadOp: 'clear', stencilStoreOp: 'discard' },
    });
    pass.setBindGroup(0, group);
    this.encode(pass, list, t.L);
    pass.end();
    this.tileBuffers.push(gl);
  }
  private tileBuffers: GPUBuffer[] = [];

  render(f: GpuFrame) {
    if (this.lost) return;
    const d = this.device;
    this.frameNo++;
    this.ensureTargets(f.W, f.H);
    const farPlan = f.far ? this.planFar(f) : null;
    const list = farPlan ? [] : this.gather(f);
    if (!farPlan) this.farPending = 0;
    const tEnc = performance.now();
    const paper = rgb(f.paper);
    const gr = f.grid;
    const gridColor = gr ? (gr.dark ? [1, 1, 1, gr.kind === 1 ? 0.14 : 0.07] : [120 / 255, 105 / 255, 80 / 255, gr.kind === 1 ? 0.18 : 0.1]) : [0, 0, 0, 0];
    d.queue.writeBuffer(this.globals, 0, new Float32Array([
      f.s, f.ox, f.oy, f.dim,
      f.W, f.H, f.dpr, 0.75,
      gr ? gr.sp * f.dpr : 1, gr ? gr.x * f.dpr : 0, gr ? gr.y * f.dpr : 0, 2 * f.dpr,
      gr ? gr.kind : 0, f.dpr, 0, 0,
      ...gridColor,
    ]));
    // every part draws at most one cover-type instance: make room for all of them before encoding
    let bound = 8 + (farPlan?.show.length ?? 0);
    for (const e of list) bound += e.refs.length;
    for (const b of farPlan?.build ?? []) for (const e of b.list) bound += e.refs.length;
    if (bound > this.coverCap) {
      this.coverBuf.destroy();
      while (this.coverCap < bound) this.coverCap *= 2;
      this.coverBuf = d.createBuffer({ size: this.coverCap * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    }
    this.coverN = 0;
    const enc = d.createCommandEncoder();
    // (far tiles first: a pass can't open inside another)
    for (const b of farPlan?.build ?? []) this.encodeTile(enc, b.t, b.list, f);
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.msaa!.createView(), resolveTarget: this.context.getCurrentTexture().createView(), clearValue: { r: paper[0], g: paper[1], b: paper[2], a: 1 }, loadOp: 'clear', storeOp: 'discard' }],
      depthStencilAttachment: { view: this.stencil!.createView(), stencilClearValue: 0, stencilLoadOp: 'clear', stencilStoreOp: 'discard' },
    });
    pass.setBindGroup(0, this.group0());
    let draws = 0;
    if (farPlan) {
      // far: the tiles (opaque: paper and ink), then the paper's marks over them
      pass.setPipeline(this.p['tex-over']);
      pass.setVertexBuffer(0, this.coverBuf);
      for (const t of farPlan.show) { pass.setBindGroup(1, t.group); pass.draw(4, 1, 0, this.pushCover(t.slot)); draws++; }
      if (gr && gr.kind) { pass.setPipeline(gr.dark ? this.p.gridScreen : this.p.gridMultiply); pass.draw(3); draws++; }
    } else {
      if (gr && gr.kind) { pass.setPipeline(this.p.grid); pass.draw(3); draws++; }
      draws += this.encode(pass, list, f.s);
    }
    pass.end();
    // (the cover indices were gathered while encoding: they go up before the commands run)
    d.queue.writeBuffer(this.coverBuf, 0, this.cover.subarray(0, this.coverN));
    d.queue.submit([enc.finish()]);
    this.draws = draws;
    for (const b of this.tileBuffers) b.destroy();
    this.tileBuffers = [];
    this.stats.encodeMs = performance.now() - tEnc;
    this.evict();
  }

  /** Encode elements into a pass (bind group 0 set). Fills that don't overlap are batched: their
   * windings all go into the stencil, then one instanced cover colours them all. */
  private encode(pass: GPURenderPassEncoder, list: GpuEl[], s: number): number {
    let draws = 0;
    let cur: GPURenderPipeline | null = null;
    const use = (p: GPURenderPipeline) => { if (p !== cur) { pass.setPipeline(p); cur = p; } };
    let vb: GPUBuffer | null = null;
    const vbuf = (b: GPUBuffer) => { if (vb !== b) { pass.setVertexBuffer(0, b); vb = b; } };
    // the batch of fills waiting for their cover
    const batch: { r: Ref; dx: number; dy: number }[] = [];
    let batchBlend: GBlend = 'over';
    const pad = 2 / s;
    const flush = () => {
      if (!batch.length) return;
      use(this.p.fanStencil);
      vbuf(this.fanA.buf);
      for (const b of batch) { pass.draw(b.r.vn!, 1, b.r.v!, b.r.slot); draws++; }
      const first = this.coverN;
      for (const b of batch) this.pushCover(b.r.slot);
      use(this.p[`cover-${batchBlend}`]);
      vbuf(this.coverBuf);
      pass.draw(4, batch.length, 0, first);
      draws++;
      batch.length = 0;
    };
    const overlaps = (r: Ref, dx: number, dy: number) => {
      const a = r.box;
      for (const b of batch) {
        const q = b.r.box;
        if (a.minX + dx - pad < q.maxX + b.dx && a.maxX + dx + pad > q.minX + b.dx && a.minY + dy - pad < q.maxY + b.dy && a.maxY + dy + pad > q.minY + b.dy) return true;
      }
      return false;
    };
    const addFan = (r: Ref, blend: GBlend, dx: number, dy: number) => {
      if (batch.length && (blend !== batchBlend || batch.length >= 256 || overlaps(r, dx, dy))) flush();
      batchBlend = blend;
      batch.push({ r, dx, dy });
    };
    for (const e of list) {
      const [dx, dy] = e.off;
      for (const r of e.refs) {
        const it = r.item;
        if (it.k === 'fan') { addFan(r, it.blend, dx, dy); continue; }
        if (it.k === 'dots' && it.r * s < 0.35) { addFan(r.tint!, it.blend, dx, dy); continue; } // (dots under a third of a pixel: their tint)
        if (it.k === 'tex' && it.cell && it.cell * s < 0.6) { addFan(r.tint!, it.blend, dx, dy); continue; } // (pixel cells under about half a pixel: theirs)
        flush();
        if (it.k === 'pat') {
          this.readyTex(r, s);
          use(this.p.fanStencil);
          vbuf(this.fanA.buf);
          pass.draw(r.vn!, 1, r.v!, r.slot);
          use(this.p[`pat-${it.blend}`]);
          pass.setBindGroup(1, r.group!);
          vbuf(this.coverBuf);
          pass.draw(4, 1, 0, this.pushCover(r.slot));
          draws += 2;
        } else if (it.k === 'stamps') {
          use(this.p.stamps);
          pass.setBindGroup(1, this.nibs());
          vbuf(this.stampA.buf);
          pass.draw(4, r.n!, 0, r.inst!);
          draws++;
        } else if (it.k === 'dots') {
          use(this.p[`dots-${it.blend}`]);
          pass.setStencilReference(1);
          vbuf(this.dotA.buf);
          pass.draw(4, r.n!, 0, r.inst!);
          use(this.p.stencilClear);
          vbuf(this.coverBuf);
          pass.draw(4, 1, 0, this.pushCover(r.slot));
          pass.setStencilReference(0);
          draws += 2;
        } else {
          if (!this.readyTex(r, s)) continue;
          use(this.p[`tex-${it.blend}`]);
          // pixel cells: sharp while a cell is a pixel and a half or more, averaged below that
          pass.setBindGroup(1, it.cell && it.cell * s >= 1.5 && r.nearest ? r.nearest : r.group!);
          vbuf(this.coverBuf);
          pass.draw(4, 1, 0, this.pushCover(r.slot));
          draws++;
        }
      }
    }
    flush();
    return draws;
  }

  /** Free everything GPU-side. */
  destroy() {
    this.drop();
    this.dropTiles();
    for (const t of this.patTex.values()) t.destroy();
    this.patTex.clear();
    this.nibTex?.destroy();
    this.msaa?.destroy(); this.stencil?.destroy();
    this.device.destroy();
  }
}

function rgb(c: string): RGB {
  const m = /^#([0-9a-f]{6})$/i.exec(c);
  const n = m ? parseInt(m[1], 16) : 0xf7f4ec;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
