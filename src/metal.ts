// The Metal backend of the GPU engine, page side: in the iPad app the still ink can be drawn by
// a native Metal view under the (then transparent) web view. The planning stays here (gpuplan.ts:
// the same compiled geometry, the same far-tile decisions as the WebGPU backend); this packs what
// the native side needs — new geometry, textures, moves, and each frame's camera and draw list —
// into one binary packet per frame, sent to the app over its own URL scheme (a POST to izine://gpu/,
// a few MB in a few ms). The native view (ios/InfiniZine/MetalInk.swift) draws it.
//
// Packet: records of [u32 type][u32 byte length][payload], little-endian, 4-byte aligned.

import type { TextBox } from './types';
import { STAMP_F, type Compiled, type GBlend, type GItem, type SceneSource } from './gpuscene';
import type { FrameCmd, GpuBackend } from './gpuplan';
import { patternTile } from './patterns';
import { paintTextBox, layoutText, layoutWidth, layoutHeight, boxFamily, wrapWidth } from './text';
import { postNative } from './native';

const enum R { Add = 1, Remove = 2, Move = 3, Tex = 4, TexSet = 5, TexFree = 6, DropTile = 7, Frame = 8 }
const enum K { Fan = 0, Pat = 1, Stamps = 2, Dots = 3, Tex = 4 }
const BLEND: Record<GBlend, number> = { over: 0, multiply: 1, screen: 2 };

/** A growable little-endian byte writer. */
class Writer {
  buf = new ArrayBuffer(1 << 16);
  dv = new DataView(this.buf);
  n = 0;
  private need(k: number) {
    if (this.n + k <= this.buf.byteLength) return;
    let cap = this.buf.byteLength * 2;
    while (cap < this.n + k) cap *= 2;
    const nb = new ArrayBuffer(cap);
    new Uint8Array(nb).set(new Uint8Array(this.buf, 0, this.n));
    this.buf = nb; this.dv = new DataView(nb);
  }
  u32(v: number) { this.need(4); this.dv.setUint32(this.n, v >>> 0, true); this.n += 4; }
  f32(v: number) { this.need(4); this.dv.setFloat32(this.n, v, true); this.n += 4; }
  floats(a: Float32Array) {
    this.u32(a.length);
    this.need(a.length * 4);
    new Float32Array(this.buf, this.n, a.length).set(a); // (aligned: everything is 4-byte words)
    this.n += a.length * 4;
  }
  bytes(a: Uint8Array | Uint8ClampedArray) {
    const pad = (4 - (a.length & 3)) & 3;
    this.need(a.length + pad);
    new Uint8Array(this.buf, this.n, a.length).set(a);
    this.n += a.length + pad;
  }
  /** a record: type, then its payload (length patched in afterwards) */
  record(type: number, body: () => void) {
    this.u32(type);
    const at = this.n;
    this.u32(0);
    body();
    this.dv.setUint32(at, this.n - at - 4, true);
  }
  take(): ArrayBuffer { const out = this.buf.slice(0, this.n); this.n = 0; return out; }
}

interface Part { item: GItem; tex?: number; texKey?: string }
interface El { parts: Part[] }

export class MetalBridge implements GpuBackend {
  private w = new Writer();
  private els = new Map<number, El>();
  private nextTex = 1;
  private patTex = new Map<string, number>();
  private nibTex = 0;
  private sent = 0;
  private seq = 0;
  private fill = 0;
  private stamps = 0;
  ok = true;
  draws = 0;
  wantsFrame = false;
  private bytesLast = 0;

  constructor(private src: SceneSource & { nibs(): HTMLCanvasElement[] }) {
    postNative({ type: 'gpu', on: true });
  }

  usage() { return { fill: this.fill, stamps: this.stamps }; }
  describe(): string { return `metal · ${this.els.size} els · ${(this.bytesLast / 1024).toFixed(0)} KB/frame · ${(this.sent / 1e6).toFixed(1)} MB sent`; }

  /** The native view goes away (engine switched off). */
  stop() {
    this.ok = false;
    postNative({ type: 'gpu', on: false });
  }

  // ---- textures ----

  /** Bitmap → premultiplied RGBA bytes in a Tex record; returns its id. */
  private sendTex(srcs: (HTMLCanvasElement | HTMLImageElement)[], w: number, h: number, mips: boolean): number {
    const id = this.nextTex++;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    this.w.record(R.Tex, () => {
      this.w.u32(id); this.w.u32(w); this.w.u32(h); this.w.u32(srcs.length); this.w.u32(mips ? 1 : 0);
      for (const s of srcs) {
        g.clearRect(0, 0, w, h);
        g.drawImage(s, 0, 0, w, h);
        const d = g.getImageData(0, 0, w, h).data;
        for (let i = 0; i < d.length; i += 4) { const a = d[i + 3]; if (a < 255) { d[i] = (d[i] * a + 127) / 255; d[i + 1] = (d[i + 1] * a + 127) / 255; d[i + 2] = (d[i + 2] * a + 127) / 255; } }
        this.w.bytes(d);
      }
    });
    return id;
  }
  private freeTex(id: number) {
    this.w.record(R.TexFree, () => this.w.u32(id));
  }
  private nibs(): number {
    if (!this.nibTex) this.nibTex = this.sendTex(this.src.nibs(), 64, 64, true);
    return this.nibTex;
  }
  private patternTex(id: string, px: number): number {
    const key = `${id}|${px}`;
    let t = this.patTex.get(key);
    if (!t) { t = this.sendTex([patternTile(id, '#000000', px)], px, px, true); this.patTex.set(key, t); }
    return t;
  }
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
  /** The texture a part should draw with at scale s (sent / swapped as needed). */
  private readyTex(h: number, k: number, p: Part, s: number) {
    const it = p.item;
    let key: string, make: () => { id: number; rect?: [number, number, number, number] } | null;
    if (it.k === 'pat') {
      const px = Math.max(16, Math.min(1024, 2 ** Math.ceil(Math.log2(Math.max(1, it.T * s)))));
      key = `p${px}`;
      make = () => ({ id: this.patternTex(it.pattern, px) });
    } else if (it.k === 'tex' && it.src.kind === 'text') {
      const scale = 2 ** Math.ceil(Math.log2(Math.max(1 / 64, s)));
      key = `t${scale}`;
      const el = it.src.el;
      make = () => {
        const { c, pad, bw, bh } = this.textCanvas(el, scale);
        const q = it.rect;
        return { id: this.sendTex([c], c.width, c.height, false), rect: [q.x - pad, q.y - pad, q.x + bw + pad, q.y + bh + pad] };
      };
    } else if (it.k === 'tex') {
      key = 'img';
      const src = it.src;
      const img = src.kind === 'image' ? src.img : (src as { canvas: HTMLCanvasElement }).canvas;
      make = () => {
        const w = img instanceof HTMLImageElement ? img.naturalWidth : img.width;
        const hh = img instanceof HTMLImageElement ? img.naturalHeight : img.height;
        if (!w || !hh || (img instanceof HTMLImageElement && !img.complete)) return null;
        return { id: this.sendTex([img], w, hh, src.kind === 'image') };
      };
    } else return;
    if (p.texKey === key) return;
    const made = make();
    if (!made) { this.wantsFrame = true; return; }
    const old = p.tex;
    p.tex = made.id; p.texKey = key;
    this.w.record(R.TexSet, () => {
      this.w.u32(h); this.w.u32(k); this.w.u32(made.id);
      const r = made.rect;
      this.w.u32(r ? 1 : 0);
      if (r) for (const v of r) this.w.f32(v);
    });
    if (old && it.k !== 'pat') this.freeTex(old); // (pattern tiles are shared: kept)
  }

  // ---- scene ----

  add(h: number, c: Compiled) {
    const parts: Part[] = c.items.map((item) => ({ item }));
    this.els.set(h, { parts });
    const w = this.w;
    const fan = (f: { tri: Float32Array }) => { w.floats(f.tri); this.fill += f.tri.length / 2; };
    w.record(R.Add, () => {
      w.u32(h); w.u32(parts.length);
      for (const { item: it } of parts) {
        const kind = it.k === 'fan' ? K.Fan : it.k === 'pat' ? K.Pat : it.k === 'stamps' ? K.Stamps : it.k === 'dots' ? K.Dots : K.Tex;
        w.u32(kind);
        w.u32(it.k === 'stamps' ? 0 : BLEND[it.blend]);
        const color = it.k === 'tex' ? [0, 0, 0] : it.color;
        w.f32(color[0]); w.f32(color[1]); w.f32(color[2]); w.f32(it.alpha);
        const b = it.k === 'tex' ? { minX: it.rect.x, minY: it.rect.y, maxX: it.rect.x + it.rect.w, maxY: it.rect.y + it.rect.h } : it.bbox;
        w.f32(b.minX); w.f32(b.minY); w.f32(b.maxX); w.f32(b.maxY);
        if (it.k === 'fan') fan(it);
        else if (it.k === 'pat') { const a = (it.angle * Math.PI) / 180; w.f32(Math.cos(a)); w.f32(Math.sin(a)); w.f32(1 / it.T); fan(it); }
        else if (it.k === 'stamps') { w.u32(it.n); w.floats(it.data.subarray(0, it.n * STAMP_F)); this.stamps += it.n; }
        else if (it.k === 'dots') { w.f32(it.r); w.floats(it.xy.subarray(0, it.n * 2)); w.f32(it.tint.alpha); fan(it.tint); }
        else { w.f32(it.cell ?? 0); w.f32(it.tint?.alpha ?? 0); if (it.tint) fan(it.tint); else w.u32(0); }
      }
    });
  }
  remove(h: number) {
    const e = this.els.get(h);
    if (!e) return;
    for (const p of e.parts) {
      const it = p.item;
      if (it.k === 'fan' || it.k === 'pat') this.fill -= it.tri.length / 2;
      if (it.k === 'dots') this.fill -= it.tint.tri.length / 2;
      if (it.k === 'tex' && it.tint) this.fill -= it.tint.tri.length / 2;
      if (it.k === 'stamps') this.stamps -= it.n;
      if (p.tex && it.k !== 'pat') this.freeTex(p.tex);
    }
    this.els.delete(h);
    this.w.record(R.Remove, () => this.w.u32(h));
  }
  move(h: number, dx: number, dy: number) {
    this.w.record(R.Move, () => { this.w.u32(h); this.w.f32(dx); this.w.f32(dy); });
  }
  stretch(h: number, box: { minX: number; minY: number; maxX: number; maxY: number }) {
    const e = this.els.get(h);
    if (!e) return;
    e.parts.forEach((p, k) => {
      const it = p.item;
      if (it.k !== 'tex' || !p.tex) return;
      const text = it.src.kind === 'text';
      const pad = it.src.kind === 'text' ? it.src.el.fontSize * 0.4 : 0;
      const w = text ? it.rect.w : box.maxX - box.minX, hh = text ? it.rect.h : box.maxY - box.minY;
      this.w.record(R.TexSet, () => {
        this.w.u32(h); this.w.u32(k); this.w.u32(p.tex!); this.w.u32(1);
        for (const v of [box.minX - pad, box.minY - pad, box.minX + w + pad, box.minY + hh + pad]) this.w.f32(v);
      });
    });
    this.move(h, 0, 0);
  }
  private tileIds = new Map<string, number>();
  private nextTile = 1;
  private tileId(key: string): number {
    let id = this.tileIds.get(key);
    if (!id) { id = this.nextTile++; this.tileIds.set(key, id); }
    return id;
  }
  dropTile(key: string) {
    const id = this.tileIds.get(key);
    if (!id) return;
    this.tileIds.delete(key);
    this.w.record(R.DropTile, () => this.w.u32(id));
  }

  // ---- frame ----

  frame(cmd: FrameCmd) {
    if (!this.ok) return;
    const w = this.w;
    // textures the frame's parts need at this scale (tiles: at theirs)
    const ready = (hs: number[], s: number) => {
      for (const h of hs) {
        const e = this.els.get(h);
        if (!e) continue;
        e.parts.forEach((p, k) => { if (p.item.k === 'pat' || p.item.k === 'tex') this.readyTex(h, k, p, s); });
        if (e.parts.some((p) => p.item.k === 'stamps')) this.nibs();
      }
    };
    this.wantsFrame = false;
    if (cmd.els) ready(cmd.els, cmd.s);
    for (const b of cmd.build) ready(b.els, b.L);
    let draws = 0;
    w.record(R.Frame, () => {
      w.u32(this.seq++);
      w.f32(cmd.W); w.f32(cmd.H); w.f32(cmd.dpr); w.f32(cmd.s); w.f32(cmd.ox); w.f32(cmd.oy); w.f32(cmd.dim);
      w.f32(cmd.paper[0]); w.f32(cmd.paper[1]); w.f32(cmd.paper[2]);
      const g = cmd.grid;
      w.u32(g ? g.kind : 0); w.f32(g?.sp ?? 1); w.f32(g?.x ?? 0); w.f32(g?.y ?? 0); w.u32(g?.dark ? 1 : 0); w.f32(g?.t ?? 0);
      w.u32(this.nibTex);
      w.u32(cmd.els ? 1 : 0);
      const els = cmd.els ?? [];
      w.u32(els.length); for (const h of els) w.u32(h);
      draws += els.length;
      w.u32(cmd.build.length);
      for (const b of cmd.build) {
        w.u32(this.tileId(b.key)); w.f32(b.L); w.u32(b.i | 0); w.u32(b.j | 0);
        w.u32(b.els.length); for (const h of b.els) w.u32(h);
      }
      w.u32(cmd.show.length);
      for (const t of cmd.show) { w.u32(this.tileId(t.key)); w.f32(t.L); w.u32(t.i | 0); w.u32(t.j | 0); }
      draws += cmd.show.length;
    });
    this.draws = draws;
    const body = w.take();
    this.bytesLast = body.byteLength;
    this.sent += body.byteLength;
    void fetch('izine://gpu/', { method: 'POST', body }).catch((e) => { postNative({ type: 'log', msg: `metal: packet not delivered (${e}) — back to the 2D renderer` }); this.ok = false; });
  }
}
