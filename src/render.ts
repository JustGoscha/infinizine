// Canvas renderer: desk background, page frames, elements (with viewport
// culling + cached outlines), live stroke, lasso/selection overlays.

import { Camera, baseZoom } from './camera';
import { Element, FillShape, Page, Stroke, StrokePoint } from './types';
import { strokeOutline, pencilOutlines, outlineToPath, elementBBox, bboxIntersects, densify, filterPressure, easeP, easeTilt, LiveDenoiser, pressure, BBox } from './geometry';
import { layoutText, fontFor, segWidth, LINE_HEIGHT } from './text';
import { moveHandleRect, moveAllHandleRect, deleteHandleRect, eyeHandleRect, type InputState } from './input';
import { Store } from './store';

interface CacheEntry { path: Path2D; bbox: BBox; passes?: Path2D[]; core?: Path2D; detail: number }

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private cache = new Map<string, CacheEntry>();
  private liveSmooth = new LiveDenoiser(); // vector live stroke
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
      // fps debug: rAF cadence — drops when the main thread struggles
      this.fpsFrames++;
      const t = performance.now();
      if (t - this.fpsT >= 500) {
        this.fps = Math.round((this.fpsFrames * 1000) / (t - this.fpsT));
        this.fpsFrames = 0;
        this.fpsT = t;
      }
      // areas animate continuously (deselected ones always play)
      const playing = this.store.doc.areas.length > 0;
      if (this.dirty || this.input.live || playing) {
        this.dirty = false;
        this.draw();
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  invalidate() { this.dirty = true; }

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
  dropFromCache(id: string) { this.cache.delete(id); this.pencilCache.delete(id); }
  clearCache() { this.cache.clear(); this.pencilCache.clear(); }

  /** Outline detail bucket for the current zoom: 1 at 100%, doubling per
   * zoom octave. Cached outlines are rebuilt when the bucket changes so a
   * stroke has the same screen-space smoothness at every zoom level. */
  private detail(): number {
    const rel = this.camera.zoom / baseZoom();
    return Math.min(16, Math.max(0.25, 2 ** Math.round(Math.log2(rel))));
  }

  private entry(el: Stroke | FillShape): CacheEntry {
    const detail = this.detail();
    let e = this.cache.get(el.id);
    if (!e || e.detail !== detail) {
      const path =
        el.kind === 'stroke'
          ? outlineToPath(strokeOutline(el, detail))
          : polygonPath(el.points);
      e = { path, bbox: elementBBox(el), detail };
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

  private stampStroke(target: CanvasRenderingContext2D, el: Stroke, alphaScale = 1, fromIndex = 0): number {
    const nib = this.nibs(el.color);
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
    // deterministic per-stamp randomness: variant, rotation, jitter — kills the
    // repeated-texture chain look of reusing one tile in one orientation
    const rnd = (i: number, salt: number) => {
      const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
      return x - Math.floor(x);
    };
    // graphite: pressure barely widens the line — it packs more, darker
    // stamps into the same width (spacing shrinks ~3× from light to hard)
    const spacingAt = (p: number) => Math.max(0.2, wBase * 0.3 * (1.35 - p * 0.9));
    const stamps: { x: number; y: number; p: number; a?: number }[] = [];
    if (pts.length === 1) {
      // a tap: a dense disc of stamps at the tap pressure
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
    for (let i = fromIndex; i < stamps.length; i++) {
      const st = stamps[i];
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
      target.save();
      target.translate(st.x + jx, st.y + jy);
      target.rotate(rnd(i, 5) * Math.PI * 2);
      // grain: present from the lightest touch, fades back as the core takes over
      const grainA = (0.16 + st.p * 0.3) * (1 - Math.max(0, st.p - 0.55) * 0.9) / Math.sqrt(tiltMul);
      target.globalAlpha = alphaScale * grainA * wobble;
      target.drawImage(nib.grain[Math.floor(rnd(i, 6) * 8)], -r, -r, r * 2, r * 2);
      // dense core: kicks in past mid pressure, near-solid at full
      const core = Math.max(0, (st.p - 0.4) / 0.6);
      if (core > 0) {
        const rc = wEff * (0.62 - core * 0.2) * (0.98 + rnd(i, 3) * 0.04);
        target.globalAlpha = alphaScale * Math.pow(core, 1.3) * 0.9 * wobble;
        target.drawImage(nib.dense[Math.floor(rnd(i, 9) * 8)], -rc, -rc, rc * 2, rc * 2);
      }
      target.restore();
    }
    target.globalAlpha = 1;
    return stamps.length;
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
      ? { ...live, points: this.livePencilSmooth.update(live.id, live.points, pressure[live.tool].smooth / camNow.zoom) }
      : live;
    ls!.count = this.stampStroke(oc, shown, live.opacity, ls!.count);
    // blit in screen space (we're inside the world transform here)
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.drawImage(ls!.canvas, 0, 0, vw, vh);
    ctx.restore();
  }

  private pencilCache = new Map<string, { c: HTMLCanvasElement; bucket: number; bbox: BBox }>();
  private pencilRaster(el: Stroke, z: number) {
    // raster resolution = zoom bucket × device pixel ratio, so a cached pencil
    // stroke is as sharp on a retina screen as the live one being drawn
    const dpr = window.devicePixelRatio || 1;
    let bucket = Math.pow(2, Math.round(Math.log2(Math.max(0.25, Math.min(8, z))))) * dpr;
    const hit = this.pencilCache.get(el.id);
    if (hit && hit.bucket === bucket) return hit;
    const bbox = elementBBox(el);
    let w = Math.max(1, Math.ceil((bbox.maxX - bbox.minX) * bucket));
    let h = Math.max(1, Math.ceil((bbox.maxY - bbox.minY) * bucket));
    while ((w > 4096 || h > 4096) && bucket > 0.25) {
      bucket /= 2;
      w = Math.max(1, Math.ceil((bbox.maxX - bbox.minX) * bucket));
      h = Math.max(1, Math.ceil((bbox.maxY - bbox.minY) * bucket));
    }
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const cc = c.getContext('2d')!;
    cc.scale(bucket, bucket);
    cc.translate(-bbox.minX, -bbox.minY);
    this.stampStroke(cc, el);
    const entry = { c, bucket, bbox };
    this.pencilCache.set(el.id, entry);
    return entry;
  }

  private draw() {
    const { canvas, ctx, camera } = this;
    const dpr = window.devicePixelRatio || 1;
    const vw = canvas.clientWidth, vh = canvas.clientHeight;
    if (canvas.width !== vw * dpr || canvas.height !== vh * dpr) {
      canvas.width = vw * dpr;
      canvas.height = vh * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const presenting = this.input.presenting;
    const paper = this.store.doc.paper ?? '#F7F4EC';

    // Desk (chosen paper color)
    ctx.fillStyle = paper;
    ctx.fillRect(0, 0, vw, vh);
    if (!presenting) this.drawPattern(vw, vh, paper);

    const view = camera.viewport(vw, vh);
    const z = camera.zoom;

    // World transform
    ctx.save();
    ctx.translate(vw / 2, vh / 2);
    ctx.scale(z, z);
    ctx.translate(-camera.x, -camera.y);

    // When presenting, clip all ink to the current page (frames aren't drawn)
    if (presenting) {
      const p = this.input.presentPage;
      const clip = new Path2D();
      if (p) clip.rect(p.x, p.y, p.w, p.h);
      ctx.clip(clip);
    }

    // Elements, culled; 'back' layer first, then 'front' (paint-behind toggle)
    const selected = this.input.selection;
    const live = this.input.live;
    // focus mode: while an area is being edited, everything outside it dims
    const focusAreaId =
      this.input.activeAreaId && !this.input.presenting ? this.input.activeAreaId : null;
    let dimFactor = 1;
    const drawEl = (el: Element) => {
      if (el.kind === 'text') {
        const b = elementBBox(el);
        if (!bboxIntersects(b, view)) return;
        ctx.globalAlpha = dimFactor;
        ctx.fillStyle = el.color;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        const family = el.font ?? 'franklin';
        let ty = el.y;
        for (const line of layoutText(el.text, family, el.fontSize, el.w)) {
          let tx = el.x;
          for (const seg of line.segs) {
            ctx.font = fontFor(family, line.size, seg.b, seg.i);
            ctx.fillText(seg.t, tx, ty);
            tx += segWidth(family, line, seg);
          }
          ty += line.size * LINE_HEIGHT;
        }
        if ((this.input.hoverText === el.id || selected.has(el.id)) && !this.input.presenting) {
          this.drawBoxHandles(el.x, el.y, el.w, el.h, z);
        }
        if (selected.has(el.id) && !presenting) {
          ctx.strokeStyle = '#E8590C';
          ctx.lineWidth = 1.5 / z;
          ctx.strokeRect(el.x - 2, el.y - 2, el.w + 4, el.h + 4);
        }
        return;
      }
      if (el.kind === 'image') {
        const b = elementBBox(el);
        if (!bboxIntersects(b, view)) return;
        const img = this.image(el.src);
        if (img.complete && img.naturalWidth) {
          ctx.globalAlpha = dimFactor;
          ctx.drawImage(img, el.x, el.y, el.w, el.h);
        }
        if ((this.input.hoverImage === el.id || selected.has(el.id)) && !this.input.presenting) {
          this.drawBoxHandles(el.x, el.y, el.w, el.h, z);
        }
        if (selected.has(el.id) && !presenting) {
          ctx.globalAlpha = 0.9;
          ctx.strokeStyle = '#E8590C';
          ctx.lineWidth = 1.5 / z;
          ctx.strokeRect(el.x - 2, el.y - 2, el.w + 4, el.h + 4);
        }
        return;
      }
      const e = this.entry(el);
      if (!bboxIntersects(e.bbox, view)) return;
      if (el.kind === 'stroke' && el.tool === 'pencil') {
        const pr = this.pencilRaster(el, z);
        ctx.globalAlpha = el.opacity * dimFactor;
        ctx.drawImage(
          pr.c,
          pr.bbox.minX,
          pr.bbox.minY,
          pr.c.width / pr.bucket,
          pr.c.height / pr.bucket,
        );
      } else if (el.kind === 'stroke' && el.tool === 'sketch' && e.passes) {
        ctx.save();
        ctx.globalCompositeOperation = 'multiply';
        ctx.fillStyle = el.color;
        for (const pass of e.passes) {
          ctx.globalAlpha = 0.42 * el.opacity * dimFactor;
          ctx.fill(pass);
        }
        ctx.restore();
      } else {
        ctx.globalAlpha = el.opacity * dimFactor;
        ctx.fillStyle = el.color;
        ctx.fill(e.path);
      }
      // selection outline applies to every stroke flavor
      if (selected.has(el.id) && !presenting) {
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = '#E8590C';
        ctx.lineWidth = 1.5 / z;
        ctx.stroke(e.path);
      }
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
      if (live.tool === 'pencil') {
        this.drawLivePencil(live, vw, vh, dpr);
        return;
      }
      // same screen-space denoise the stroke gets on commit, so the live line
      // looks like the final one and the tip never flickers on sample jitter
      const shown: Stroke = live.points.length > 2
        ? { ...live, points: this.liveSmooth.update(live.id, live.points, pressure[live.tool].smooth / this.camera.zoom) }
        : live;
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
      ctx.fill(outlineToPath(strokeOutline(shown, this.detail(), true)));
    };
    // Animation: each layer runs its own timeline. Deselected areas always play;
    // in the edited area, the active layer holds on the active frame and the other
    // layers hold at the same tick position.
    const now = performance.now() / 1000;
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

      // tick position of the active frame's start (for holding other layers in edit mode)
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
      }

      for (const l of area.layers) {
        let visId: string | null;
        if (editing && l.id === activeLayerId) {
          visId = this.input.activeFrameId;
          if (this.input.onionSkin && visId) {
            // 3 back in red, 3 forward in green, fading with distance;
            // when looping, "forward" wraps around to the first frames
            const idx = l.frames.findIndex((f) => f.id === visId);
            const len = l.frames.length;
            const alphas = [0.35, 0.18, 0.08];
            for (let k = 1; k <= 3; k++) {
              if (idx - k >= 0) onionFrames.set(l.frames[idx - k].id, { alpha: alphas[k - 1], color: '#D6336C' });
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
      ctx.fill(outlineToPath(strokeOutline({ ...el, points: pts }, this.detail())));
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

    if (live?.layer === 'back') drawLive(); // live back-ink previews behind existing back-ink
    dimFactor = focusAreaId ? 0.3 : 1;
    for (const el of still) if (el.layer === 'back') drawEl(el);
    for (const el of still) if (el.layer !== 'back') drawEl(el);
    dimFactor = 1;

    // Animated elements: per area, per layer (bottom first); frame ownership decides the layer
    for (const area of this.store.doc.areas) {
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
          const bt = now - this.input.blinkStart;
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
                ctx.stroke(this.entry(el).path);
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
    if (live && live.layer !== 'back') drawLive();
    ctx.globalAlpha = 1;

    // Page borders sit on top of everything
    if (!presenting) {
      for (const page of this.store.doc.pages) {
        this.drawPage(page, z);
        if (this.input.hoverPage === page.id) {
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
        ctx.font = `500 ${11 / z}px "Libre Franklin", sans-serif`;
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
    const lasso = this.input.lasso;
    if (lasso && lasso.length > 1) {
      ctx.beginPath();
      ctx.moveTo(lasso[0].x, lasso[0].y);
      for (const p of lasso) ctx.lineTo(p.x, p.y);
      ctx.setLineDash([6 / z, 5 / z]);
      ctx.lineWidth = 1.5 / z;
      ctx.strokeStyle = this.input.tool === 'lasso-fill' ? this.input.color : '#E8590C';
      if (this.input.tool === 'lasso-fill') {
        ctx.save();
        ctx.globalAlpha = 0.25;
        ctx.fillStyle = this.input.color;
        ctx.fill();
        ctx.restore();
      }
      ctx.stroke();
      ctx.setLineDash([]);
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

    // Zoom badge: 100% = the first page fits the screen
    if (!presenting) {
      const pct = Math.round((z / baseZoom()) * 100);
      ctx.font = '600 11px "Libre Franklin", sans-serif';
      ctx.fillStyle = 'rgba(42,36,26,0.55)';
      ctx.textAlign = 'right';
      ctx.fillText(`${this.fps}fps · ${this.input.zoomLocked ? '🔒 ' : ''}${pct}%`, vw - 14, vh - 12);
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

  /** Move box (top-left) + width/height/corner handles with arrow icons. */
  private drawBoxHandles(x: number, y: number, w: number, h: number, z: number) {
    const { ctx } = this;
    const mh = moveHandleRect(x, y, z);
    ctx.fillStyle = '#FDFCF8';
    ctx.strokeStyle = 'rgba(90,75,50,0.5)';
    ctx.lineWidth = 1.2 / z;
    ctx.fillRect(mh.x, mh.y, mh.s, mh.s);
    ctx.strokeRect(mh.x, mh.y, mh.s, mh.s);
    ctx.strokeStyle = '#2A241A';
    this.drawMoveCross(mh.x, mh.y, mh.s);
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
    // delete handle: top-right, away from the move handle
    const dh = deleteHandleRect(x, y, w, z);
    ctx.fillStyle = '#FDFCF8';
    ctx.strokeStyle = '#D6336C';
    ctx.fillRect(dh.x, dh.y, dh.s, dh.s);
    ctx.strokeRect(dh.x, dh.y, dh.s, dh.s);
    ctx.beginPath();
    ctx.moveTo(dh.x + dh.s * 0.3, dh.y + dh.s * 0.3);
    ctx.lineTo(dh.x + dh.s * 0.7, dh.y + dh.s * 0.7);
    ctx.moveTo(dh.x + dh.s * 0.7, dh.y + dh.s * 0.3);
    ctx.lineTo(dh.x + dh.s * 0.3, dh.y + dh.s * 0.7);
    ctx.stroke();
  }

  private drawPattern(vw: number, vh: number, paper: string) {
    const pattern = this.store.doc.pattern ?? 'dots';
    if (pattern === 'blank') return;
    const { camera, ctx } = this;
    // light marks on dark paper, dark marks on light paper
    const n = parseInt(paper.slice(1), 16);
    const lum = ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114;
    const dark = lum < 128;
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
    ctx.font = `500 ${11 / z}px "Libre Franklin", sans-serif`;
    ctx.fillStyle = 'rgba(90,75,50,0.6)';
    ctx.textAlign = 'left';
    ctx.fillText(page.name, page.x + 2 / z, page.y - 6 / z);
  }
}

function polygonPath(points: { x: number; y: number }[]): Path2D {
  const path = new Path2D();
  if (!points.length) return path;
  path.moveTo(points[0].x, points[0].y);
  for (const p of points) path.lineTo(p.x, p.y);
  path.closePath();
  return path;
}
