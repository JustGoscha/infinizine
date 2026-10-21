/// <reference types="@webgpu/types" />
// The WebGPU backend of the GPU engine (planning: gpuplan.ts): the paper, its grid and every still element drawn on the GPU each
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
// Far out over a crowded zine the view comes from tiles instead: 512 px bitmaps the GPU renders
// the ink into once and keeps (which, and when: gpuplan.ts).

import type { TextBox } from './types';
import type { BBox } from './geometry';
import { STAMP_F, type Compiled, type GItem, type GBlend, type SceneSource, type RGB } from './gpuscene';
import { GPU_TILE as TILE, type FrameCmd, type GpuBackend, type TileRef } from './gpuplan';
import { patternTile } from './patterns';
import { paintTextBox, layoutText, layoutWidth, layoutHeight, boxFamily, wrapWidth } from './text';

const SAMPLES = 4;
const STENCIL: GPUTextureFormat = 'stencil8';
const ITEM_BYTES = 64;
const STAMP_WORDS = STAMP_F + 1; // + the item index
const DOT_WORDS = 3; // x, y, item

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
// the paper's dots / lines / grid: marks centred on the cell corners, box-filtered over the pixel —
// two levels, the coarse (2·sp) always, the in-between ones (sp) at t (see gridSpacing in render.ts)
fn gridCov(q: vec2f, sp: f32) -> f32 {
  let f = q - round(q / sp) * sp;
  if (g.gridKind.x == 1.0) {
    let m = g.grid.w;
    let ov = clamp(vec2f(m * 0.5 + 0.5) - abs(f), vec2f(0.0), vec2f(min(m, 1.0)));
    return ov.x * ov.y;
  }
  let lw = g.gridKind.y;
  let h = clamp(lw * 0.5 + 0.5 - abs(f.y), 0.0, min(lw, 1.0));
  var v = 0.0;
  if (g.gridKind.x == 3.0) { v = clamp(lw * 0.5 + 0.5 - abs(f.x), 0.0, min(lw, 1.0)); }
  return max(h, v);
}
@fragment fn fs_grid(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let q = pos.xy - g.grid.yz;
  let cov = max(gridCov(q, 2.0 * g.grid.x), g.gridKind.z * gridCov(q, g.grid.x));
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
  texts?: Map<number, { tex: GPUTexture; group: GPUBindGroup; pad: number }>; // a text box's bitmaps by scale (the view's and the far tiles')
  box: BBox; // for batching (world, without the drag offset)
}
interface El { refs: Ref[]; off: [number, number] }
/** a far-out tile's bitmap, and its item (its world rect, for drawing it) */
interface FarTex { tex: GPUTexture; group: GPUBindGroup; slot: number }

const BLENDS: Record<GBlend, GPUBlendState> = {
  over: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } },
  // over an opaque paper: ink × paper, like Canvas 2D's multiply there
  multiply: { color: { srcFactor: 'dst', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } },
  screen: { color: { srcFactor: 'one', dstFactor: 'one-minus-src' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } },
};

export class WebGPUBackend implements GpuBackend {
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
  private els = new Map<number, El>();
  private patTex = new Map<string, GPUTexture>();
  private nibTex: GPUTexture | null = null;
  private nibGroup: GPUBindGroup | null = null;
  private far = new Map<string, FarTex>();
  private tileMsaa: GPUTexture | null = null;
  private tileStencil: GPUTexture | null = null;
  private tileBuffers: GPUBuffer[] = [];
  lost = false;
  /** a bitmap couldn't be made yet (an image still decoding) */
  wantsFrame = false;
  /** draw calls last frame */
  draws = 0;
  /** ms encoding the last frame */
  encodeMs = 0;

  static async create(canvas: HTMLCanvasElement, src: SceneSource & { nibs(): HTMLCanvasElement[] }): Promise<WebGPUBackend | null> {
    try {
      if (!navigator.gpu) return null;
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return null;
      // (as big as the adapter allows: a crowded zine's geometry can pass the 256 MB default)
      const device = await adapter.requestDevice({ requiredLimits: { maxBufferSize: adapter.limits.maxBufferSize, maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize } });
      device.addEventListener('uncapturederror', (e) => console.warn('[InfiniZine] WebGPU error', (e as GPUUncapturedErrorEvent).error.message));
      const r = new WebGPUBackend(canvas, device, src);
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

  usage() { return { fill: this.fanA.used, stamps: this.stampA.used }; }
  describe(): string {
    const mb = (n: number) => (n / 1e6).toFixed(0);
    return `fill ${mb(this.fanA.used * 8)}/${mb(this.fanA.cap * 8)}MB · stamps ${mb(this.stampA.used * STAMP_WORDS * 4)}/${mb(this.stampA.cap * STAMP_WORDS * 4)}MB · dots ${mb(this.dotA.used * DOT_WORDS * 4)}MB · items ${this.itemsA.used} · encode ${this.encodeMs.toFixed(1)}ms`;
  }

  // ---- scene ----

  add(h: number, c: Compiled) { this.els.set(h, { refs: this.build(c), off: [0, 0] }); }
  remove(h: number) {
    const e = this.els.get(h);
    if (!e) return;
    for (const r of e.refs) this.freeRef(r);
    this.els.delete(h);
  }
  move(h: number, dx: number, dy: number) {
    const e = this.els.get(h);
    if (!e) return;
    e.off = [dx, dy];
    const off = new Float32Array([dx, dy, 0, 0]);
    const put = (r: Ref) => { this.device.queue.writeBuffer(this.itemsA.buf, r.slot * ITEM_BYTES + 48, off); if (r.tint) put(r.tint); };
    e.refs.forEach(put);
  }
  stretch(h: number, box: BBox) {
    const e = this.els.get(h);
    if (!e) return;
    for (const r of e.refs) {
      if (r.item.k !== 'tex') continue;
      const text = r.item.src.kind === 'text';
      const pad = text && r.item.src.kind === 'text' ? r.item.src.el.fontSize * 0.4 : 0;
      const w = text ? r.item.rect.w : box.maxX - box.minX, h = text ? r.item.rect.h : box.maxY - box.minY;
      const b = { minX: box.minX - pad, minY: box.minY - pad, maxX: box.minX + w + pad, maxY: box.minY + h + pad };
      this.device.queue.writeBuffer(this.itemsA.buf, r.slot * ITEM_BYTES + 16, new Float32Array([b.minX, b.minY, b.maxX, b.maxY]));
      r.box = b;
    }
    // (stretched in place: no drag offset on top)
    this.move(h, 0, 0);
  }
  dropTile(key: string) {
    const t = this.far.get(key);
    if (!t) return;
    t.tex.destroy();
    this.itemsA.release(t.slot, 1);
    this.far.delete(key);
  }
  private freeRef(r: Ref) {
    this.itemsA.release(r.slot, 1);
    if (r.vn) this.fanA.release(r.v!, r.vn);
    if (r.n) (r.item.k === 'stamps' ? this.stampA : this.dotA).release(r.inst!, r.n);
    r.tex?.destroy();
    for (const t of r.texts?.values() ?? []) t.tex.destroy();
    if (r.tint) this.freeRef(r.tint);
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

  private build(c: Compiled): Ref[] {
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
    return refs;
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
  private textCanvas(el: TextBox, scale: number): { c: HTMLCanvasElement; pad: number; bw: number; bh: number } {
    const pad = el.fontSize * 0.4; // italics and descenders spill past the measured box
    // (lines can run past the box — a box made smaller than its text: the bitmap holds all of it)
    const lines = layoutText(el.text, boxFamily(el), el.fontSize, wrapWidth(el));
    const bw = Math.max(el.w, layoutWidth(lines, boxFamily(el))), bh = Math.max(el.h, layoutHeight(lines));
    let s = scale;
    while ((bw + 2 * pad) * s > 4096 || (bh + 2 * pad) * s > 4096) s /= 2;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil((bw + 2 * pad) * s));
    c.height = Math.max(1, Math.ceil((bh + 2 * pad) * s));
    const g = c.getContext('2d')!;
    g.setTransform(s, 0, 0, s, (pad - el.x) * s, (pad - el.y) * s);
    paintTextBox(g, el);
    return { c, pad, bw, bh };
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
        const { c, pad, bw, bh } = this.textCanvas(src.el, scale);
        const tex = this.upload(c, c.width, c.height, undefined, false);
        t = { tex, group: this.texGroup(tex, this.linearClamp), pad };
        r.texts.set(scale, t);
        // (two scales kept: the view's and the far tiles')
        if (r.texts.size > 2) { const [k0, t0] = r.texts.entries().next().value!; if (k0 !== scale) { t0.tex.destroy(); r.texts.delete(k0); } }
        if (r.texKey === undefined) {
          r.texKey = 'text';
          const q = it.rect;
          this.device.queue.writeBuffer(this.itemsA.buf, r.slot * ITEM_BYTES + 16, new Float32Array([q.x - pad, q.y - pad, q.x + bw + pad, q.y + bh + pad]));
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
  private group0(globals: GPUBuffer = this.globals): GPUBindGroup {
    if (globals !== this.globals) return this.device.createBindGroup({ layout: this.gLayout, entries: [{ binding: 0, resource: { buffer: globals } }, { binding: 1, resource: { buffer: this.itemsA.buf } }] });
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
  private list(hs: number[]): El[] {
    const out: El[] = [];
    for (const h of hs) { const e = this.els.get(h); if (e) out.push(e); }
    return out;
  }

  frame(cmd: FrameCmd) {
    if (this.lost) return;
    const d = this.device;
    const t0 = performance.now();
    this.ensureTargets(cmd.W, cmd.H);
    const paper = cmd.paper;
    const gr = cmd.grid;
    const gridColor = gr ? (gr.dark ? [1, 1, 1, gr.kind === 1 ? 0.14 : 0.07] : [120 / 255, 105 / 255, 80 / 255, gr.kind === 1 ? 0.18 : 0.1]) : [0, 0, 0, 0];
    d.queue.writeBuffer(this.globals, 0, new Float32Array([
      cmd.s, cmd.ox, cmd.oy, cmd.dim,
      cmd.W, cmd.H, cmd.dpr, 0.75,
      gr ? gr.sp * cmd.dpr : 1, gr ? gr.x * cmd.dpr : 0, gr ? gr.y * cmd.dpr : 0, 2 * cmd.dpr,
      gr ? gr.kind : 0, cmd.dpr, gr ? gr.t : 0, 0,
      ...gridColor,
    ]));
    const main = cmd.els ? this.list(cmd.els) : [];
    const builds = cmd.build.map((b) => ({ t: b, list: this.list(b.els) }));
    // every part draws at most one cover-type instance: room for all of them before encoding
    let bound = 8 + cmd.show.length;
    for (const e of main) bound += e.refs.length;
    for (const b of builds) for (const e of b.list) bound += e.refs.length;
    if (bound > this.coverCap) {
      this.coverBuf.destroy();
      while (this.coverCap < bound) this.coverCap *= 2;
      this.coverBuf = d.createBuffer({ size: this.coverCap * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    }
    this.coverN = 0;
    this.wantsFrame = false;
    const enc = d.createCommandEncoder();
    // (far tiles first: a pass can't open inside another)
    for (const b of builds) this.encodeTile(enc, b.t, b.list, cmd);
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.msaa!.createView(), resolveTarget: this.context.getCurrentTexture().createView(), clearValue: { r: paper[0], g: paper[1], b: paper[2], a: 1 }, loadOp: 'clear', storeOp: 'discard' }],
      depthStencilAttachment: { view: this.stencil!.createView(), stencilClearValue: 0, stencilLoadOp: 'clear', stencilStoreOp: 'discard' },
    });
    pass.setBindGroup(0, this.group0());
    let draws = 0;
    if (!cmd.els) {
      // far: the tiles (opaque: paper and ink), then the paper's marks over them
      pass.setPipeline(this.p['tex-over']);
      pass.setVertexBuffer(0, this.coverBuf);
      for (const t of cmd.show) {
        const f = this.far.get(t.key);
        if (!f) continue;
        pass.setBindGroup(1, f.group);
        pass.draw(4, 1, 0, this.pushCover(f.slot));
        draws++;
      }
      if (gr && gr.kind) { pass.setPipeline(gr.dark ? this.p.gridScreen : this.p.gridMultiply); pass.draw(3); draws++; }
    } else {
      if (gr && gr.kind) { pass.setPipeline(this.p.grid); pass.draw(3); draws++; }
      draws += this.encode(pass, main, cmd.s);
    }
    pass.end();
    // (the cover indices were gathered while encoding: they go up before the commands run)
    d.queue.writeBuffer(this.coverBuf, 0, this.cover.subarray(0, this.coverN));
    d.queue.submit([enc.finish()]);
    for (const b of this.tileBuffers) b.destroy();
    this.tileBuffers = [];
    this.draws = draws;
    this.encodeMs = performance.now() - t0;
  }

  /** Render a far tile's elements into its bitmap (one pass, its own camera). */
  private encodeTile(enc: GPUCommandEncoder, t: TileRef, list: El[], cmd: FrameCmd) {
    const d = this.device;
    if (!this.tileMsaa) {
      this.tileMsaa = d.createTexture({ size: [TILE, TILE], format: this.format, sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT });
      this.tileStencil = d.createTexture({ size: [TILE, TILE], format: STENCIL, sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    }
    let f = this.far.get(t.key);
    if (!f) {
      const tex = d.createTexture({ size: [TILE, TILE], format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
      const x = (t.i * TILE) / t.L, y = (t.j * TILE) / t.L, w = TILE / t.L;
      f = { tex, group: this.texGroup(tex, this.linearClamp), slot: this.newItem([0, 0, 0], 1, { minX: x, minY: y, maxX: x + w, maxY: y + w }) };
      this.far.set(t.key, f);
    }
    const gl = d.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(gl, 0, new Float32Array([t.L, -t.i * TILE, -t.j * TILE, 1, TILE, TILE, cmd.dpr, 0.75, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    this.tileBuffers.push(gl);
    const paper = cmd.paper;
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.tileMsaa.createView(), resolveTarget: f.tex.createView(), clearValue: { r: paper[0], g: paper[1], b: paper[2], a: 1 }, loadOp: 'clear', storeOp: 'discard' }],
      depthStencilAttachment: { view: this.tileStencil!.createView(), stencilClearValue: 0, stencilLoadOp: 'clear', stencilStoreOp: 'discard' },
    });
    pass.setBindGroup(0, this.group0(gl));
    this.encode(pass, list, t.L);
    pass.end();
  }

  /** Encode elements into a pass (bind group 0 set). Fills that don't overlap are batched: their
   * windings all go into the stencil, then one instanced cover colours them all. */
  private encode(pass: GPURenderPassEncoder, list: El[], s: number): number {
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
          if (!this.readyTex(r, s)) { this.wantsFrame = true; continue; }
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
    for (const h of [...this.els.keys()]) this.remove(h);
    for (const k of [...this.far.keys()]) this.dropTile(k);
    for (const t of this.patTex.values()) t.destroy();
    this.patTex.clear();
    this.nibTex?.destroy();
    this.msaa?.destroy(); this.stencil?.destroy();
    this.device.destroy();
  }
}
