// Viewport: world <-> screen mapping. Zoom clamped to 1%–500% per SPEC.

export const MIN_ZOOM = 0.01;

/** 100% = true physical scale: world units are 2/mm, and CSS defines 96px/inch,
 * so an A4 page at 100% measures a real 210×297mm (on a standard-density display).
 * The same convention print/design apps use for their 100%. */
export function baseZoom(): number {
  return 96 / 25.4 / 2; // css px per mm ÷ world units per mm ≈ 1.89
}
export const MAX_ZOOM = 20; // 2000%

export class Camera {
  x = 0; // world coord at screen center
  y = 0;
  zoom = 1;

  screenToWorld(sx: number, sy: number, vw: number, vh: number) {
    return {
      x: this.x + (sx - vw / 2) / this.zoom,
      y: this.y + (sy - vh / 2) / this.zoom,
    };
  }

  worldToScreen(wx: number, wy: number, vw: number, vh: number) {
    return {
      x: (wx - this.x) * this.zoom + vw / 2,
      y: (wy - this.y) * this.zoom + vh / 2,
    };
  }

  panScreen(dx: number, dy: number) {
    this.x -= dx / this.zoom;
    this.y -= dy / this.zoom;
  }

  /** Zoom keeping the given screen point fixed. */
  zoomAt(factor: number, sx: number, sy: number, vw: number, vh: number) {
    const before = this.screenToWorld(sx, sy, vw, vh);
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * factor));
    const after = this.screenToWorld(sx, sy, vw, vh);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
  }

  /** Visible world rect. */
  viewport(vw: number, vh: number) {
    const w = vw / this.zoom;
    const h = vh / this.zoom;
    return { x: this.x - w / 2, y: this.y - h / 2, w, h };
  }
}
