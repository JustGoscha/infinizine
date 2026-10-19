// The GPU scene: each element compiled once into GPU-ready pieces — plain typed arrays and
// texture sources, nothing tied to one graphics API — so the WebGPU renderer (web, and the
// iPad app's web view) and the native Metal one (the iPad app) draw the same zine from the
// same data. The 2D renderer's own geometry is the source: the same outlines, Pencil stamps,
// tone dots and pixel cells, so the GPU picture matches it.
//
// Fills are triangle fans over each contour, meant for stencil-then-cover: the fan counts
// windings into the stencil, the cover pass colours where the count isn't zero — the same
// non-zero rule as Canvas 2D, self-crossing outlines included.

import type { Element, FillShape, Stroke, TextBox, ImageBox } from './types';
import { elementBBox, type BBox } from './geometry';
import { strokeOutline, pencilOutlines, markerPolys } from './outline';
import { isPixelPattern, motifCoverage, motifDots, patternCellSize, patternTileSize, pixelCoverage } from './patterns';

export type GBlend = 'over' | 'multiply' | 'screen';
export type RGB = [number, number, number];

/** Non-zero filled contours (triangle fans: x, y per vertex, three per triangle) in one colour. */
export interface FanItem { k: 'fan'; tri: Float32Array; color: RGB; alpha: number; blend: GBlend; bbox: BBox }
/** The same, filled with a repeating pattern tile (its alpha) in the colour, anchored to the world origin. */
export interface PatItem { k: 'pat'; tri: Float32Array; color: RGB; alpha: number; blend: GBlend; bbox: BBox; pattern: string; angle: number; T: number }
/** Pencil: nib stamps, STAMP_F floats each (x, y, radius, rotation, alpha, nib 0–15). */
export interface StampItem { k: 'stamps'; data: Float32Array; n: number; color: RGB; alpha: number; bbox: BBox }
/** Dot tones: whole dots (centres x, y) of one radius, their union filled; far out the tint stands in. */
export interface DotItem { k: 'dots'; xy: Float32Array; n: number; r: number; color: RGB; alpha: number; blend: GBlend; bbox: BBox; tint: FanItem }
/** A bitmap over a world rect: an image, a text box (rasterised per zoom), a pixel fill's cells (one px per cell). */
export interface TexItem { k: 'tex'; src: { kind: 'image'; img: HTMLImageElement } | { kind: 'text'; el: TextBox } | { kind: 'canvas'; canvas: HTMLCanvasElement }; rect: { x: number; y: number; w: number; h: number }; alpha: number; blend: GBlend; cell?: number; tint?: FanItem }
export type GItem = FanItem | PatItem | StampItem | DotItem | TexItem;

export interface Compiled { id: string; bbox: BBox; detail: number; zoomFree: boolean; items: GItem[]; anchor: { x: number; y: number }; sig: string }

export const STAMP_F = 6;

/** What the compiler borrows from the 2D renderer (its Pencil engine and caches). */
export interface SceneSource {
  stamps(el: Stroke, put: (x: number, y: number, r: number, rot: number, alpha: number, nib: number) => void): void;
  cellImage(el: FillShape): { c: HTMLCanvasElement; c0: number; r0: number; cols: number; rows: number; cell: number } | null;
  image(src: string): HTMLImageElement;
}

const colorCache = new Map<string, RGB>();
let colorCtx: CanvasRenderingContext2D | null = null;
export function rgbOf(c: string): RGB {
  let v = colorCache.get(c);
  if (v) return v;
  const m = /^#([0-9a-f]{6})$/i.exec(c);
  let hex = m ? m[1] : null;
  if (!hex) {
    // anything else CSS understands: let a canvas normalise it
    colorCtx ??= document.createElement('canvas').getContext('2d')!;
    colorCtx.fillStyle = '#000';
    colorCtx.fillStyle = c;
    const n = String(colorCtx.fillStyle);
    hex = /^#([0-9a-f]{6})$/i.exec(n)?.[1] ?? '000000';
  }
  const n = parseInt(hex, 16);
  v = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  colorCache.set(c, v);
  return v;
}

function blendOf(b: string | undefined): GBlend {
  return b === 'source-over' ? 'over' : b === 'screen' ? 'screen' : 'multiply'; // (darken / difference: closest is multiply)
}

/** Triangle fans of contours ([x, y] lists), one Float32Array. */
export function fans(contours: number[][][]): Float32Array {
  let n = 0;
  for (const c of contours) if (c.length >= 3) n += (c.length - 2) * 6;
  const out = new Float32Array(n);
  let k = 0;
  for (const c of contours) {
    if (c.length < 3) continue;
    const x0 = c[0][0], y0 = c[0][1];
    for (let i = 1; i < c.length - 1; i++) {
      out[k++] = x0; out[k++] = y0;
      out[k++] = c[i][0]; out[k++] = c[i][1];
      out[k++] = c[i + 1][0]; out[k++] = c[i + 1][1];
    }
  }
  return out;
}

function boxOf(contours: number[][][]): BBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of contours) for (const [x, y] of c) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  return { minX, minY, maxX, maxY };
}

/** Where an element is and what shape it has, so a pure move can be told from a reshape. */
export function anchorOf(el: Element): { x: number; y: number } {
  if (el.kind === 'text' || el.kind === 'image') return { x: el.x, y: el.y };
  const p = el.points[0];
  return p ? { x: p.x, y: p.y } : { x: 0, y: 0 };
}
export function shapeSig(el: Element): string {
  if (el.kind === 'text') return `t|${el.w}|${el.h}|${el.text}|${el.color}|${el.fontSize}|${el.font}|${el.face}|${el.wrapW}|${el.layer}`;
  if (el.kind === 'image') return `i|${el.w}|${el.h}|${el.src.length}|${el.layer}`;
  const pts = el.points, n = pts.length, a = pts[0] ?? { x: 0, y: 0 };
  // a few points relative to the first: equal for a pure translation
  const rel = [1, n >> 2, n >> 1, (3 * n) >> 2, n - 1].filter((i) => i > 0 && i < n).map((i) => `${(pts[i].x - a.x).toFixed(3)},${(pts[i].y - a.y).toFixed(3)}`).join(';');
  const style = el.kind === 'stroke' ? `${el.tool}|${el.baseWidth}|${el.opacity}` : `${el.pattern}|${el.patternAngle}|${el.ink}|${el.blend}|${el.opacity}`;
  return `${el.kind}|${n}|${el.color}|${style}|${el.layer}|${rel}`;
}

export function compile(el: Element, detail: number, src: SceneSource): Compiled {
  const items: GItem[] = [];
  let zoomFree = true;
  if (el.kind === 'stroke') {
    const color = rgbOf(el.color);
    if (el.tool === 'pencil') {
      let data = new Float32Array(STAMP_F * 1024), n = 0;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      src.stamps(el, (x, y, r, rot, a, nib) => {
        if ((n + 1) * STAMP_F > data.length) { const g = new Float32Array(data.length * 2); g.set(data); data = g; }
        const k = n * STAMP_F;
        data[k] = x; data[k + 1] = y; data[k + 2] = r; data[k + 3] = rot; data[k + 4] = a; data[k + 5] = nib;
        n++;
        const m = r * 1.5;
        if (x - m < minX) minX = x - m; if (x + m > maxX) maxX = x + m; if (y - m < minY) minY = y - m; if (y + m > maxY) maxY = y + m;
      });
      if (n) items.push({ k: 'stamps', data: data.subarray(0, n * STAMP_F), n, color, alpha: 1, bbox: { minX, minY, maxX, maxY } });
    } else if (el.tool === 'sketch') {
      zoomFree = false;
      for (const pass of pencilOutlines(el, detail)) {
        items.push({ k: 'fan', tri: fans([pass]), color, alpha: 0.42 * el.opacity, blend: 'multiply', bbox: boxOf([pass]) });
      }
    } else if (el.tool === 'marker') {
      zoomFree = false;
      const { polys } = markerPolys(el.points, el.baseWidth, detail);
      items.push({ k: 'fan', tri: fans(polys), color, alpha: el.opacity, blend: 'over', bbox: boxOf(polys) });
    } else {
      zoomFree = false;
      const o = strokeOutline(el, detail);
      items.push({ k: 'fan', tri: fans([o]), color, alpha: el.opacity, blend: 'over', bbox: boxOf([o]) });
    }
  } else if (el.kind === 'fill') {
    const color = rgbOf(el.color);
    const poly = [el.points.map((p) => [p.x, p.y])];
    const bbox = boxOf(poly);
    const pat = el.pattern;
    const alpha = el.opacity * (el.ink ?? 1);
    if (!pat) {
      items.push({ k: 'fan', tri: fans(poly), color, alpha, blend: el.blend === undefined ? 'over' : blendOf(el.blend), bbox });
    } else {
      const blend = blendOf(el.blend ?? 'multiply');
      const cells = patternCellSize(pat) ? src.cellImage(el) : null;
      const dots = !cells && /^pattern:(tone|sand)-/.test(pat) ? motifDots(el.points, pat, el.patternAngle ?? 0) : null;
      if (cells) {
        // (far out, cells under about half a pixel: the pattern's tint over the shape instead)
        const tint: FanItem = { k: 'fan', tri: fans(poly), color, alpha: alpha * pixelCoverage(pat), blend, bbox };
        items.push({ k: 'tex', src: { kind: 'canvas', canvas: cells.c }, rect: { x: cells.c0 * cells.cell, y: cells.r0 * cells.cell, w: cells.cols * cells.cell, h: cells.rows * cells.cell }, alpha, blend, cell: cells.cell, tint });
      } else if (dots && dots.n) {
        const tint: FanItem = { k: 'fan', tri: fans(poly), color, alpha: alpha * motifCoverage(pat), blend, bbox };
        items.push({ k: 'dots', xy: dots.xy.subarray(0, dots.n * 2), n: dots.n, r: dots.r, color, alpha, blend, bbox, tint });
      } else if (!dots) {
        items.push({ k: 'pat', tri: fans(poly), color, alpha, blend, bbox, pattern: pat, angle: isPixelPattern(pat) ? 0 : el.patternAngle ?? 0, T: patternTileSize(pat) });
      }
    }
  } else if (el.kind === 'text') {
    items.push({ k: 'tex', src: { kind: 'text', el }, rect: { x: el.x, y: el.y, w: el.w, h: el.h }, alpha: 1, blend: 'over' });
  } else {
    const im = el as ImageBox;
    items.push({ k: 'tex', src: { kind: 'image', img: src.image(im.src) }, rect: { x: im.x, y: im.y, w: im.w, h: im.h }, alpha: 1, blend: 'over' });
  }
  const bbox = items.length ? items.map((i) => (i.k === 'tex' ? { minX: i.rect.x, minY: i.rect.y, maxX: i.rect.x + i.rect.w, maxY: i.rect.y + i.rect.h } : i.bbox)).reduce((a, b) => ({ minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) })) : elementBBox(el);
  return { id: el.id, bbox, detail, zoomFree, items, anchor: anchorOf(el), sig: shapeSig(el) };
}
