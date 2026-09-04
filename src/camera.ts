// Viewport: world <-> screen mapping. Zoom clamped to 1%–500% per SPEC.

export const MIN_ZOOM = 0.01;

/** 100% = true physical scale: world units are 2/mm, so an A4 page at 100%
 * should measure a real 210×297mm. Browsers can't report physical size —
 * CSS assumes 96px/inch, but an iPad is ~132 CSS px/inch (264ppi at 2×), so we
 * guess per device class and let the user calibrate against a credit card. */
const CAL_KEY = 'infinizine-pxmm';
let pxMm: number | null = null;

export function detectPxPerMm(): number {
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  if (iOS) {
    if (/iPhone/.test(ua)) return (devicePixelRatio >= 3 ? 460 / 3 : 326 / 2) / 25.4;
    const long = Math.max(screen.width, screen.height); // CSS px
    // iPad mini (326ppi) has a 1133px long side; every other iPad is 264ppi
    return (long >= 1120 && long <= 1140 ? 163 : 132) / 25.4;
  }
  return 96 / 25.4;
}

export function pxPerMm(): number {
  if (pxMm === null) {
    let stored = NaN;
    try { stored = Number(localStorage.getItem(CAL_KEY)); } catch { /* ignore */ }
    pxMm = stored > 0 ? stored : detectPxPerMm();
  }
  return pxMm;
}

/** null = back to the device guess */
export function setPxPerMm(v: number | null) {
  pxMm = v ?? detectPxPerMm();
  try {
    if (v) localStorage.setItem(CAL_KEY, String(v));
    else localStorage.removeItem(CAL_KEY);
  } catch { /* ignore */ }
}

export function baseZoom(): number {
  return pxPerMm() / 2; // css px per mm ÷ world units per mm
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
