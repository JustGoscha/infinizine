// Canvas renderer: desk background, page frames, elements (with viewport
// culling + cached outlines), live stroke, lasso/selection overlays.

import { Camera } from './camera';
import { Element, FillShape, Page, Stroke } from './types';
import { strokeOutline, outlineToPath, elementBBox, bboxIntersects, BBox } from './geometry';
import { layoutText, fontFor, segWidth, LINE_HEIGHT } from './text';
import { textHandleRect, moveHandleRect, type InputState } from './input';
import { Store } from './store';

interface CacheEntry { path: Path2D; bbox: BBox }

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private cache = new Map<string, CacheEntry>();
  private dirty = true;

  constructor(
    private canvas: HTMLCanvasElement,
    private store: Store,
    private camera: Camera,
    private input: InputState,
  ) {
    this.ctx = canvas.getContext('2d')!;
    const loop = () => {
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
  dropFromCache(id: string) { this.cache.delete(id); }
  clearCache() { this.cache.clear(); }

  private entry(el: Stroke | FillShape): CacheEntry {
    let e = this.cache.get(el.id);
    if (!e) {
      const path =
        el.kind === 'stroke'
          ? outlineToPath(strokeOutline(el))
          : polygonPath(el.points);
      e = { path, bbox: elementBBox(el) };
      this.cache.set(el.id, e);
    }
    return e;
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

    // Pages under ink; when presenting, no frames — instead clip all ink to the pages
    if (presenting) {
      // Only the current page — nothing outside it
      const p = this.input.presentPage;
      const clip = new Path2D();
      if (p) clip.rect(p.x, p.y, p.w, p.h);
      ctx.clip(clip); // same desk ground as edit mode — only the ink gets clipped
    } else {
      for (const page of this.store.doc.pages) this.drawPage(page, z);
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
        // Move handle (top-left icon box) on hover or selection
        if ((this.input.hoverText === el.id || selected.has(el.id)) && !this.input.presenting) {
          const hr = textHandleRect(el, z);
          ctx.fillStyle = '#FDFCF8';
          ctx.strokeStyle = 'rgba(90,75,50,0.5)';
          ctx.lineWidth = 1.2 / z;
          ctx.fillRect(hr.x, hr.y, hr.s, hr.s);
          ctx.strokeRect(hr.x, hr.y, hr.s, hr.s);
          // move cross
          ctx.strokeStyle = '#2A241A';
          ctx.beginPath();
          ctx.moveTo(hr.x + hr.s * 0.5, hr.y + hr.s * 0.18);
          ctx.lineTo(hr.x + hr.s * 0.5, hr.y + hr.s * 0.82);
          ctx.moveTo(hr.x + hr.s * 0.18, hr.y + hr.s * 0.5);
          ctx.lineTo(hr.x + hr.s * 0.82, hr.y + hr.s * 0.5);
          ctx.stroke();
          // resize handles: edges = width, bottom = height, corner = scale — with arrow icons
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
            [el.x, el.y + el.h / 2, 1, 0],
            [el.x + el.w, el.y + el.h / 2, 1, 0],
            [el.x + el.w / 2, el.y + el.h, 0, 1],
            [el.x + el.w, el.y + el.h, D, D],
          ];
          for (const [hx, hy, dx, dy] of handles) {
            ctx.fillStyle = '#FDFCF8';
            ctx.strokeStyle = 'rgba(90,75,50,0.5)';
            ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
            ctx.strokeRect(hx - hs / 2, hy - hs / 2, hs, hs);
            ctx.strokeStyle = '#2A241A';
            arrow(hx, hy, dx, dy);
          }
        }
        if (selected.has(el.id)) {
          ctx.strokeStyle = '#E8590C';
          ctx.lineWidth = 1.5 / z;
          ctx.strokeRect(el.x - 2, el.y - 2, el.w + 4, el.h + 4);
        }
        return;
      }
      const e = this.entry(el);
      if (!bboxIntersects(e.bbox, view)) return;
      ctx.globalAlpha = el.opacity * dimFactor;
      ctx.fillStyle = el.color;
      ctx.fill(e.path);
      if (selected.has(el.id)) {
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = '#E8590C';
        ctx.lineWidth = 1.5 / z;
        ctx.stroke(e.path);
      }
    };
    const drawLive = () => {
      if (!live) return;
      ctx.globalAlpha = live.opacity;
      ctx.fillStyle = live.color;
      ctx.fill(outlineToPath(strokeOutline(live)));
    };
    // Animation: each layer runs its own timeline. Deselected areas always play;
    // in the edited area, the active layer holds on the active frame and the other
    // layers hold at the same tick position.
    const now = performance.now() / 1000;
    const frameVis = new Map<string, boolean>();
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
      const playTick = Math.floor((now - this.input.playEpoch) * area.fps);

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
            // 3 back in red, 3 forward in green, fading with distance
            const idx = l.frames.findIndex((f) => f.id === visId);
            const alphas = [0.35, 0.18, 0.08];
            for (let k = 1; k <= 3; k++) {
              if (idx - k >= 0) onionFrames.set(l.frames[idx - k].id, { alpha: alphas[k - 1], color: '#D6336C' });
              if (idx + k < l.frames.length) {
                onionFrames.set(l.frames[idx + k].id, { alpha: alphas[k - 1] * 0.85, color: '#2F9E44' });
              }
            }
          }
        } else if (editing) {
          visId = frameAtTick(l.frames, editTick, true);
        } else {
          visId = frameAtTick(l.frames, playTick, area.loop);
        }
        for (const f of l.frames) frameVis.set(f.id, f.id === visId);
      }
    }

    const visible = this.store.doc.elements.filter((el) => !this.input.hidden.has(el.id));
    const still = visible.filter((el) => !el.frame);
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
        const fids = new Set(layer.frames.map((f) => f.id));
        for (const [fid, onion] of onionFrames) {
          if (!fids.has(fid)) continue;
          ctx.save();
          ctx.globalAlpha = onion.alpha;
          ctx.fillStyle = onion.color;
          for (const el of visible) {
            if (el.frame === fid) {
              const cached = el.kind === 'text' ? null : this.entry(el);
              if (cached) ctx.fill(cached.path);
            }
          }
          ctx.restore();
        }
        for (const el of visible) {
          if (el.frame && fids.has(el.frame) && frameVis.get(el.frame) === true) drawEl(el);
        }
      }
      if (area.clip) ctx.restore();
      dimFactor = 1;
    }
    if (live && live.layer !== 'back') drawLive();
    ctx.globalAlpha = 1;

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

    // Zoom badge
    if (!presenting) {
      ctx.font = '600 11px "Libre Franklin", sans-serif';
      ctx.fillStyle = 'rgba(42,36,26,0.55)';
      ctx.textAlign = 'right';
      ctx.fillText(`${Math.round(z * 100)}%`, vw - 14, vh - 12);
    }
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
    ctx.beginPath();
    ctx.moveTo(mh.x + mh.s * 0.5, mh.y + mh.s * 0.18);
    ctx.lineTo(mh.x + mh.s * 0.5, mh.y + mh.s * 0.82);
    ctx.moveTo(mh.x + mh.s * 0.18, mh.y + mh.s * 0.5);
    ctx.lineTo(mh.x + mh.s * 0.82, mh.y + mh.s * 0.5);
    ctx.stroke();
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
