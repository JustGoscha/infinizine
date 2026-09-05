// Pointer handling: pen draws, fingers pan/pinch-zoom (Notes-style),
// mouse works for desktop/browser verification. Coalesced events used
// for high-frequency stroke sampling.

import { Camera, baseZoom } from './camera';
import { Store } from './store';
import { AnimArea, Stroke, FillShape, Element, ImageBox, Page, TextBox, uid } from './types';
import { hitElement, elementsInLasso, denoise, denoiseClosed, pressure } from './geometry';
import { isPixelPattern } from './patterns';
import { layoutText, layoutHeight } from './text';

const CLIP_KEY = 'infinizine-clipboard';
export const CLIP_PENDING_KEY = 'infinizine-clip-pending'; // '1' while the clip hasn't been pasted yet
// Big selections blow the ~5MB localStorage quota; the in-memory clipboard
// always holds the last copy so same-tab (and cross-zine) paste never fails.
let memClip: string | null = null;

const PEN_KEY = 'infinizine-pen-seen';
const TOOL_MEM_KEY = 'infinizine-tool-memory';
const REMEMBER_TOOLS = new Set(['pen', 'pencil', 'sketch', 'fineliner', 'marker', 'lasso-fill', 'text']);
const FINGER_KEY = 'infinizine-finger-mode';
function readPref(k: string): string | null {
  try { return localStorage.getItem(k); } catch { return null; }
}
export function writePref(k: string, v: string) {
  try { localStorage.setItem(k, v); } catch { /* ignore */ }
}
export { FINGER_KEY };

/** Lean direction (azimuth) in radians, screen plane. Safari: azimuthAngle; others: from tiltX/Y. */
function azimuthOf(e: PointerEvent): number | undefined {
  if (e.pointerType !== 'pen') return undefined;
  const az = (e as PointerEvent & { azimuthAngle?: number }).azimuthAngle;
  if (typeof az === 'number') return az;
  if (typeof e.tiltX === 'number' && (e.tiltX || e.tiltY)) return Math.atan2(e.tiltY, e.tiltX);
  return undefined;
}

/** Pencil tilt 0 (upright) … 1 (flat). Safari gives altitudeAngle; others tiltX/Y. */
function tiltOf(e: PointerEvent): number | undefined {
  if (e.pointerType !== 'pen') return undefined;
  const alt = (e as PointerEvent & { altitudeAngle?: number }).altitudeAngle;
  if (typeof alt === 'number') return Math.max(0, Math.min(1, 1 - alt / (Math.PI / 2)));
  if (typeof e.tiltX === 'number' && (e.tiltX || e.tiltY)) return Math.min(1, Math.hypot(e.tiltX, e.tiltY) / 90);
  return undefined;
}

function toast(msg: string) {
  window.dispatchEvent(new CustomEvent('izine-toast', { detail: msg }));
}

export type Tool = 'pen' | 'pencil' | 'sketch' | 'fineliner' | 'marker' | 'eraser' | 'cursor' | 'lasso-select' | 'lasso-fill' | 'text' | 'anim' | 'hand';

/** While an anim area is selected, only the active frame's elements (and the
 * area's timed live-ink strokes) are editable; otherwise only untagged ones. */
export function frameEditable(el: Element, state: InputState): boolean {
  const area = el.kind === 'stroke' ? el.area : undefined;
  if (state.activeAreaId) return el.frame === state.activeFrameId || area === state.activeAreaId;
  return !el.frame && !area;
}

function translateElement(el: Element, dx: number, dy: number) {
  if (el.kind === 'text' || el.kind === 'image') {
    el.x += dx;
    el.y += dy;
  } else {
    for (const p of el.points) { p.x += dx; p.y += dy; }
  }
}

const ERASER_RADIUS = 6; // world units at zoom 1 (scaled by 1/zoom at use)

/** Move-handle box at a box's top-left corner (world coords). */
export function moveHandleRect(x: number, y: number, zoom: number) {
  const s = 22 / zoom;
  return { x: x - s - 4 / zoom, y: y - s - 4 / zoom, s };
}

/** Second grabber on anim areas: moves the frame WITH its content. Below the move handle. */
export function moveAllHandleRect(x: number, y: number, zoom: number) {
  const s = 22 / zoom;
  return { x: x - s - 4 / zoom, y: y + 2 / zoom, s };
}

/** Page preview eye: below the two grabbers. */
export function eyeHandleRect(x: number, y: number, zoom: number) {
  const s = 22 / zoom;
  return { x: x - s - 4 / zoom, y: y + s + 8 / zoom, s };
}

/** Delete-handle box at a box's top-right corner, away from the move handle. */
export function deleteHandleRect(x: number, y: number, w: number, zoom: number) {
  const s = 22 / zoom;
  return { x: x + w + 4 / zoom, y: y - s - 4 / zoom, s };
}

function inRect(w: { x: number; y: number }, r: { x: number; y: number; s: number }): boolean {
  return w.x >= r.x && w.x <= r.x + r.s && w.y >= r.y && w.y <= r.y + r.s;
}

/** Move-handle box at a textbox's top-left corner (world coords). */
export function textHandleRect(el: TextBox, zoom: number) {
  return moveHandleRect(el.x, el.y, zoom);
}

export class InputState {
  private _tool: Tool = (() => {
    const t = readPref('infinizine-last-tool');
    return t && REMEMBER_TOOLS.has(t) ? (t as Tool) : 'pen'; // drawing tools only; never boot into eraser/anim
  })();
  /** per-tool colour + size memory: switching tools brings back what you last used with each */
  private toolMem: Partial<Record<Tool, { color: string; baseWidth: number }>> = (() => {
    try { return JSON.parse(readPref(TOOL_MEM_KEY) ?? '{}'); } catch { return {}; }
  })();
  get tool(): Tool { return this._tool; }
  set tool(t: Tool) {
    if (t === this._tool) return;
    this.rememberTool();
    this._tool = t;
    const m = this.toolMem[t];
    if (m) { this.color = m.color; this.baseWidth = m.baseWidth; }
    if (REMEMBER_TOOLS.has(t)) writePref('infinizine-last-tool', t);
  }
  /** store the current colour/size under the current tool (called on switch and on edits) */
  rememberTool() {
    if (!REMEMBER_TOOLS.has(this._tool)) return;
    this.toolMem[this._tool] = { color: this.color, baseWidth: this.baseWidth };
    writePref(TOOL_MEM_KEY, JSON.stringify(this.toolMem));
  }
  color = '#1a1a1a';
  /** fill tool: active pattern (screentone, dither, …) drawn in `color`; null = solid */
  fillPattern: string | null = (() => {
    const p = readPref('infinizine-fill-pattern');
    return p && p.startsWith('pattern:') ? p : null;
  })();
  /** ink coverage for pattern fills (CMYK-style tint): 1 = solid ink, lower lets paper through so overlaps mix */
  inkDensity = (() => { const v = Number(readPref('infinizine-ink-density')); return v >= 0.3 && v <= 1 ? v : 0.8; })();
  baseWidth = 1.6; // world units at 100% (2 per mm)
  adaptiveSize = readPref('infinizine-adaptive-size') === '1'; // keep on-screen size across zoom
  /** brush width in world units for a stroke started at this zoom */
  effectiveWidth(zoom: number): number {
    return this.adaptiveSize ? this.baseWidth * (baseZoom() / zoom) : this.baseWidth;
  }
  paintBehind = false; // 'back' layer toggle for new strokes/fills
  font = 'franklin'; // typeface for new textboxes
  textSize = 8; // world units; Title 18 / Heading 12 / Body 8 / Sub 6
  live: Stroke | null = null;
  lasso: { x: number; y: number }[] | null = null;
  selection = new Set<string>();
  hidden = new Set<string>();
  // remembered across sessions: once a pen has been seen, fingers pan by default
  penDetected = readPref(PEN_KEY) === '1';
  fingerMode: 'draw' | 'pan' | 'select' = (() => {
    const m = readPref(FINGER_KEY);
    if (m === 'draw' || m === 'pan' || m === 'select') return m;
    return readPref(PEN_KEY) === '1' ? 'pan' : 'draw';
  })();
  fingerDraws = this.fingerMode === 'draw'; // legacy flag, kept in sync with fingerMode === 'draw'
  zoomLocked = readPref('infinizine-zoom-lock') !== '0'; // Notes-style: paint with what you've got; unlock to zoom
  armedPageDrag: Page | null = null; // set by the page menu's Move action
  presenting = false; // presentation mode: render only page content
  presentPage: Page | null = null; // the single page shown while presenting
  onToolChange: () => void = () => {};
  /** set while the text editor is open: a colour pick recolours the text being edited */
  onEditColor: ((c: string) => void) | null = null;
  onPageMenu: (page: Page, clientX: number, clientY: number) => void = () => {};
  onPagePreview: (page: Page) => void = () => {};
  textRect: { x: number; y: number; w: number; h: number } | null = null; // rect being drawn with the text tool
  hoverText: string | null = null; // textbox under the mouse (shows its move handle)
  hoverArea: string | null = null; // anim area under the mouse (shows its handles)
  hoverPage: string | null = null; // page under the mouse (shows its grabbers)
  hoverImage: string | null = null; // image under the mouse (shows its handles)
  lastDrawTool: Tool = this._tool; // remembered so e.g. area creation can bounce back to it
  onAnimClose: () => void = () => {};
  toolCursor = 'crosshair'; // css cursor for the current tool (set by the UI)
  updateCursor: () => void = () => {};
  marquee: { x: number; y: number; w: number; h: number } | null = null; // cursor-tool rect select
  // animation mode
  areaRect: { x: number; y: number; w: number; h: number } | null = null; // area being drawn
  activeAreaId: string | null = null; // timeline open for this area
  activeFrameId: string | null = null;
  activeLayerId: string | null = null;
  onionSkin = true; // on by default; 3 frames back (red) and 3 forward (green)
  liveInkLife = 6; // ticks a stroke drawn during playback stays visible
  liveInkTaper = true; // its tail eats away over its lifetime
  showLiveInk = false; // show live-ink strokes while editing (they always show in playback)
  blinkLayerId: string | null = null; // layer briefly opacity-blinking (selection feedback)
  blinkStart = 0;
  playingAreas = false;
  playEpoch = 0; // performance.now()/1000 when playback started
  onAnimOpen: (area: import('./types').AnimArea) => void = () => {};
  onTextEdit: (
    target: import('./types').TextBox | null,
    rect: { x: number; y: number; w: number; h: number },
    auto?: boolean, // tap-created: width follows the content
  ) => void = () => {};
}

interface TouchInfo { x: number; y: number }

// A modal drawing surface (pressure playground) owns the keyboard/wheel while
// it's open; the main canvas' global handlers stand down.
let modalOpen = false;
export function setModalOpen(v: boolean) { modalOpen = v; }

export function attachInput(
  canvas: HTMLCanvasElement,
  camera: Camera,
  store: Store,
  state: InputState,
  invalidate: () => void,
  scope: 'main' | 'modal' = 'main',
) {
  const inScope = () => (scope === 'modal') === modalOpen;
  const touches = new Map<number, TouchInfo>();
  // multi-finger gestures: 2-finger tap = undo, 3-finger tap = redo,
  // 2-finger hold (no motion) then horizontal swipe = scrub through history
  let gesture: { fingers: number; t: number; moved: number; mid: { x: number; y: number } } | null = null;
  let scrub: { x: number } | null = null; // active undo/redo scrub, last stepped x
  let scrubTimer = 0;
  const SCRUB_HOLD_MS = 380;
  const SCRUB_STEP_PX = 36;
  const TAP_MAX_MS = 320;
  const TAP_MAX_PX = 14;
  function armScrub() {
    window.clearTimeout(scrubTimer);
    scrubTimer = window.setTimeout(() => {
      if (!gesture || touches.size !== 2 || gesture.moved > TAP_MAX_PX || scrub) return;
      const [a, b] = [...touches.values()];
      scrub = { x: (a.x + b.x) / 2 };
      toast('← undo · redo →');
    }, SCRUB_HOLD_MS);
  }
  let drawingPointer: number | null = null;
  let strokeStart = 0;
  let textDragStart = { x: 0, y: 0 };
  // area move/resize via the same handle set as textboxes
  let resizeArea: AnimArea | null = null;
  let resizeAreaMode: 'move' | 'move-all' | 'w-left' | 'w-right' | 'h-bottom' | 'corner' = 'move';
  let resizeAreaStart = { x: 0, y: 0, w: 0, h: 0, wx: 0, wy: 0 };
  let moveAllIds: string[] = [];
  let moveAllApplied = { x: 0, y: 0 };
  // page move-with-content drag
  let dragPageAll = false;
  let pageAllIds: string[] = [];
  let pageAllAreaIds: string[] = [];
  let pageAllApplied = { x: 0, y: 0 };
  // image resize handles
  let resizeImg: ImageBox | null = null;
  let imgMode: 'w-left' | 'w-right' | 'h-bottom' | 'corner' = 'corner';
  let imgStart = { x: 0, y: 0, w: 0, h: 0, wx: 0, wy: 0 };
  // textbox resize/scale (Excalidraw-style handles on a hovered/selected textbox)
  let resizeText: TextBox | null = null;
  let resizeMode: 'width' | 'width-left' | 'height' | 'scale' = 'width';
  let resizeStart = { x: 0, w: 0, h: 0, fontSize: 0, wx: 0, wy: 0 };
  // positions are recorded raw; all smoothing happens after the fact
  // (screen-space denoise, see geometry.denoise) so nothing lags the tip
  let ema: { x: number; y: number } | null = null;
  const EMA_FACTOR = 1;
  // pressure conditioning (ported from Doodely): Apple Pencil reports noisy
  // pressure and an exact 0.5 when it hasn't measured yet → carry the last
  // valid value, back-fill the uncertain head once a real reading arrives,
  // and low-pass the rest so the outline width doesn't shiver.
  let pEma: number | null = null;
  let lastValidP: number | null = null;
  let rawPMax: number | null = null; // peak raw pressure of the stroke (taps become dots at this)
  const P_EMA = () => pressure[state.live?.tool ?? 'pen'].pSmooth;
  const MIN_DIST_PX = 1.2; // screen px; drops stacked samples at slow speed
  let minDistSq = 0; // world-space square of MIN_DIST_PX, fixed at stroke start
  let strokeZoom = 1; // zoom at drawing time → denoise radius on commit
  let lastEventT = 0;

  function conditionPressure(e: PointerEvent): number {
    if (e.pointerType !== 'pen') return 0.5;
    const raw = e.pressure;
    const uncertain = raw <= 0 || raw === 0.5;
    if (!uncertain) {
      rawPMax = Math.max(rawPMax ?? 0, raw);
      if (lastValidP === null && state.live) {
        // first real reading: back-fill the uncertain head of the stroke
        for (const pt of state.live.points) pt.p = raw;
        pEma = raw;
      }
      lastValidP = raw;
    }
    const target = uncertain ? (lastValidP ?? 0.5) : raw;
    pEma = pEma === null ? target : pEma + P_EMA() * (target - pEma);
    return pEma;
  }

  function smooth(w: { x: number; y: number }): { x: number; y: number } {
    if (!ema) {
      ema = { x: w.x, y: w.y };
      return w;
    }
    ema = {
      x: ema.x + EMA_FACTOR * (w.x - ema.x),
      y: ema.y + EMA_FACTOR * (w.y - ema.y),
    };
    return ema;
  }
  let erased: Element[] = [];
  let panLast: { x: number; y: number } | null = null;
  let panStart: { x: number; y: number; t: number } | null = null; // one-finger pan origin (tap detection)
  let pinchDist = 0;
  let pinchMid: { x: number; y: number } | null = null;

  // dragging pages / areas / selection
  let dragArea: AnimArea | null = null;
  let dragAreaStart = { x: 0, y: 0 };
  let dragPage: Page | null = null;
  let dragPageStart = { x: 0, y: 0 };
  let dragDesired = { x: 0, y: 0 }; // un-snapped position the finger implies
  let dragSelection = false;
  let dragStartWorld = { x: 0, y: 0 };
  let dragTotal = { x: 0, y: 0 };

  /** Snap a dragged page to other pages: edge alignment, flush contact, and standard-gap placement. */
  function snapPage(page: Page, desired: { x: number; y: number }): { x: number; y: number } {
    const T = 10 / camera.zoom; // snap threshold in world units
    const GAP = 60; // standard padding between pages
    let bestX: number | null = null, bxd = T;
    let bestY: number | null = null, byd = T;
    for (const o of store.doc.pages) {
      if (o.id === page.id) continue;
      const xCands = [
        o.x, o.x + o.w - page.w, // align left / right edges
        o.x + o.w, o.x - page.w, // flush contact
        o.x + o.w + GAP, o.x - page.w - GAP, // standard gap
      ];
      for (const c of xCands) {
        const d = Math.abs(desired.x - c);
        if (d < bxd) { bxd = d; bestX = c; }
      }
      const yCands = [
        o.y, o.y + o.h - page.h,
        o.y + o.h, o.y - page.h,
        o.y + o.h + GAP, o.y - page.h - GAP,
      ];
      for (const c of yCands) {
        const d = Math.abs(desired.y - c);
        if (d < byd) { byd = d; bestY = c; }
      }
    }
    return { x: bestX ?? desired.x, y: bestY ?? desired.y };
  }

  const vw = () => canvas.clientWidth;
  const vh = () => canvas.clientHeight;
  const toWorld = (e: { clientX: number; clientY: number }) => {
    const r = canvas.getBoundingClientRect();
    return camera.screenToWorld(e.clientX - r.left, e.clientY - r.top, vw(), vh());
  };

  function isDrawPointer(e: PointerEvent): boolean {
    if (e.pointerType === 'pen') return true;
    if (e.pointerType === 'mouse') return e.buttons === 1;
    return state.fingerMode === 'draw' && touches.size <= 1;
  }

  function areaLabelAt(w: { x: number; y: number }): AnimArea | null {
    const z = camera.zoom;
    for (const a of [...store.doc.areas].reverse()) {
      if (w.x >= a.x && w.x <= a.x + 160 / z && w.y >= a.y - 26 / z && w.y <= a.y) return a;
    }
    return null;
  }

  function pageLabelAt(w: { x: number; y: number }): Page | null {
    const z = camera.zoom;
    for (const p of [...store.doc.pages].reverse()) {
      if (w.x >= p.x && w.x <= p.x + 140 / z && w.y >= p.y - 26 / z && w.y <= p.y) return p;
    }
    return null;
  }

  function startAction(e: PointerEvent, toolOverride?: Tool) {
    const activeTool = toolOverride ?? state.tool;
    // Presentation mode: any drag pans, no drawing/tools
    if (state.presenting) {
      panLast = { x: e.clientX, y: e.clientY };
      return;
    }
    const w = toWorld(e);

    // Image handles (any tool, on hovered/selected image)
    for (const el of store.doc.elements) {
      if (el.kind !== 'image') continue;
      if (state.hoverImage !== el.id && !state.selection.has(el.id)) continue;
      const z = camera.zoom;
      if (inRect(w, deleteHandleRect(el.x, el.y, el.w, z))) {
        state.selection.delete(el.id);
        if (state.hoverImage === el.id) state.hoverImage = null;
        store.deleteElements([el]);
        return;
      }
      if (inRect(w, moveHandleRect(el.x, el.y, z))) {
        state.selection = new Set([el.id]);
        dragSelection = true;
        dragStartWorld = w;
        dragTotal = { x: 0, y: 0 };
        invalidate();
        return;
      }
      const r = 12 / z;
      const grabImg = (mode: typeof imgMode) => {
        state.selection = new Set([el.id]);
        resizeImg = el;
        imgMode = mode;
        imgStart = { x: el.x, y: el.y, w: el.w, h: el.h, wx: w.x, wy: w.y };
        invalidate();
      };
      if (Math.hypot(w.x - (el.x + el.w), w.y - (el.y + el.h)) < r) { grabImg('corner'); return; }
      if (Math.abs(w.y - (el.y + el.h)) < r && Math.abs(w.x - (el.x + el.w / 2)) < r) { grabImg('h-bottom'); return; }
      if (Math.abs(w.x - (el.x + el.w)) < r && Math.abs(w.y - (el.y + el.h / 2)) < r) { grabImg('w-right'); return; }
      if (Math.abs(w.x - el.x) < r && Math.abs(w.y - (el.y + el.h / 2)) < r) { grabImg('w-left'); return; }
    }

    // Textbox handles (any tool, on hovered/selected box):
    // top-left = move, bottom-right = scale, left/right edge = width
    for (const el of store.doc.elements) {
      if (el.kind !== 'text') continue;
      if (state.hoverText !== el.id && !state.selection.has(el.id)) continue;
      const z = camera.zoom;
      if (inRect(w, deleteHandleRect(el.x, el.y, el.w, z))) {
        state.selection.delete(el.id);
        if (state.hoverText === el.id) state.hoverText = null;
        store.deleteElements([el]);
        return;
      }
      const hr = textHandleRect(el, z);
      if (inRect(w, hr)) {
        state.selection = new Set([el.id]);
        dragSelection = true;
        dragStartWorld = w;
        dragTotal = { x: 0, y: 0 };
        invalidate();
        return;
      }
      const r = 12 / z;
      const grab = (mode: typeof resizeMode) => {
        state.selection = new Set([el.id]);
        resizeText = el;
        resizeMode = mode;
        resizeStart = { x: el.x, w: el.w, h: el.h, fontSize: el.fontSize, wx: w.x, wy: w.y };
        invalidate();
      };
      if (Math.hypot(w.x - (el.x + el.w), w.y - (el.y + el.h)) < r) { grab('scale'); return; }
      if (Math.abs(w.y - (el.y + el.h)) < r && Math.abs(w.x - (el.x + el.w / 2)) < r) { grab('height'); return; }
      if (Math.abs(w.x - (el.x + el.w)) < r && Math.abs(w.y - (el.y + el.h / 2)) < r) { grab('width'); return; }
      if (Math.abs(w.x - el.x) < r && Math.abs(w.y - (el.y + el.h / 2)) < r) { grab('width-left'); return; }
    }

    // Area handles (same set as textboxes) on the hovered/active area
    for (const a of store.doc.areas) {
      if (state.hoverArea !== a.id && state.activeAreaId !== a.id) continue;
      const z = camera.zoom;
      const r = 12 / z;
      if (inRect(w, deleteHandleRect(a.x, a.y, a.w, z))) {
        const wasActive = state.activeAreaId === a.id;
        if (state.hoverArea === a.id) state.hoverArea = null;
        store.deleteArea(a);
        if (wasActive) state.onAnimClose();
        return;
      }
      const mh = moveHandleRect(a.x, a.y, z);
      const mha = moveAllHandleRect(a.x, a.y, z);
      let mode: typeof resizeAreaMode | null = null;
      if (inRect(w, mh)) mode = 'move';
      else if (inRect(w, mha)) mode = 'move-all';
      else if (Math.hypot(w.x - (a.x + a.w), w.y - (a.y + a.h)) < r) mode = 'corner';
      else if (Math.abs(w.y - (a.y + a.h)) < r && Math.abs(w.x - (a.x + a.w / 2)) < r) mode = 'h-bottom';
      else if (Math.abs(w.x - (a.x + a.w)) < r && Math.abs(w.y - (a.y + a.h / 2)) < r) mode = 'w-right';
      else if (Math.abs(w.x - a.x) < r && Math.abs(w.y - (a.y + a.h / 2)) < r) mode = 'w-left';
      if (mode) {
        resizeArea = a;
        resizeAreaMode = mode;
        resizeAreaStart = { x: a.x, y: a.y, w: a.w, h: a.h, wx: w.x, wy: w.y };
        if (mode === 'move-all') {
          moveAllIds = store.areaContentIds(a.id);
          moveAllApplied = { x: 0, y: 0 };
        }
        return;
      }
    }

    // Page grabbers (hover): outlined = frame only, filled = frame with content
    for (const p of store.doc.pages) {
      if (state.hoverPage !== p.id) continue;
      const z = camera.zoom;
      const mh = moveHandleRect(p.x, p.y, z);
      const mha = moveAllHandleRect(p.x, p.y, z);
      if (inRect(w, eyeHandleRect(p.x, p.y, z))) {
        state.onPagePreview(p);
        return;
      }
      const all = inRect(w, mha);
      if (inRect(w, mh) || all) {
        dragPage = p;
        dragPageStart = { x: p.x, y: p.y };
        dragDesired = { x: p.x, y: p.y };
        dragStartWorld = w;
        dragPageAll = all;
        if (all) {
          pageAllAreaIds = store.pageAreaIds(p.id);
          // areas take their entire animation content along
          pageAllIds = [
            ...store.pageContentIds(p.id),
            ...pageAllAreaIds.flatMap((aid) => store.areaContentIds(aid)),
          ];
          pageAllApplied = { x: 0, y: 0 };
        }
        return;
      }
    }

    // Animation area label: tap opens its timeline, drag moves the area frame
    const areaHit = areaLabelAt(w);
    if (areaHit) {
      dragArea = areaHit;
      dragAreaStart = { x: areaHit.x, y: areaHit.y };
      dragStartWorld = w;
      return;
    }

    // Page label tab (or a Move armed from the page menu): drag moves the frame,
    // a motionless tap opens the page menu instead (see endAction).
    const page = state.armedPageDrag ?? pageLabelAt(w);
    state.armedPageDrag = null;
    if (page) {
      dragPage = page;
      dragPageStart = { x: page.x, y: page.y };
      dragDesired = { x: page.x, y: page.y };
      dragStartWorld = w;
      return;
    }

    switch (activeTool) {
      case 'hand':
        panLast = { x: e.clientX, y: e.clientY };
        return;
      case 'pen':
      case 'pencil':
      case 'sketch':
      case 'fineliner':
      case 'marker': {
        strokeStart = performance.now() / 1000;
        ema = null;
        pEma = null;
        lastValidP = null;
        rawPMax = null;
        lastEventT = e.timeStamp;
        strokeZoom = camera.zoom;
        minDistSq = (MIN_DIST_PX / camera.zoom) ** 2;
        smooth(w);
        // drawing into a PLAYING area records a timed stroke on the loop clock
        const playingArea =
          state.activeAreaId && state.playingAreas
            ? store.doc.areas.find((a) => a.id === state.activeAreaId)
            : undefined;
        let anim: Partial<Stroke> = {
          frame: state.activeFrameId ?? undefined,
          alayer: state.activeFrameId ? state.activeLayerId ?? undefined : undefined,
        };
        if (playingArea) {
          const total = Math.max(
            1,
            ...playingArea.layers.map((l) => l.frames.reduce((a, f) => a + f.duration, 0)),
          );
          let tick = Math.floor((performance.now() / 1000 - state.playEpoch) * playingArea.fps);
          tick = playingArea.loop ? ((tick % total) + total) % total : Math.min(tick, total - 1);
          anim = {
            area: playingArea.id,
            animStart: tick,
            animLife: state.liveInkLife,
            animTaper: state.liveInkTaper,
          };
        }
        state.live = {
          id: uid('st'), kind: 'stroke', tool: activeTool as import('./types').ToolKind,
          color: state.color,
          baseWidth: state.effectiveWidth(camera.zoom) / (activeTool === 'fineliner' ? 1.4 : 1),
          opacity: activeTool === 'marker' ? 0.45 : 1,
          layer: state.paintBehind ? 'back' : 'front',
          ...anim,
          points: [{ x: w.x, y: w.y, p: 0.5, t: 0, a: tiltOf(e), r: azimuthOf(e) }],
          startTime: Date.now() / 1000,
        };
        conditionPressure(e);
        state.live.points[0].p = pEma ?? 0.5;
        return;
      }
      case 'eraser':
        erased = [];
        eraseAt(w);
        return;
      case 'cursor':
      case 'lasso-select': {
        // Clicking outside the active anim area deselects it (closes the timeline)
        if (state.activeAreaId) {
          const a = store.doc.areas.find((x) => x.id === state.activeAreaId);
          if (a && (w.x < a.x || w.x > a.x + a.w || w.y < a.y || w.y > a.y + a.h)) {
            state.onAnimClose();
          }
        }
        // Tap directly on a textbox selects it
        const tapped = [...store.doc.elements].reverse().find(
          (el) => el.kind === 'text' && frameEditable(el, state) && hitElement(el, w.x, w.y, 4 / camera.zoom),
        );
        if (tapped && !state.selection.has(tapped.id)) {
          state.selection = new Set([tapped.id]);
          invalidate();
          return;
        }
        // Drag inside current selection moves it; otherwise start a new lasso/marquee.
        if (state.selection.size && hitsSelection(w)) {
          dragSelection = true;
          dragStartWorld = w;
          dragTotal = { x: 0, y: 0 };
        } else if (activeTool === 'cursor') {
          state.selection.clear();
          textDragStart = w;
          state.marquee = { x: w.x, y: w.y, w: 0, h: 0 };
        } else {
          state.selection.clear();
          state.lasso = [w];
        }
        return;
      }
      case 'lasso-fill':
        state.lasso = [w];
        return;
      case 'anim': {
        // Tap an existing area to open its timeline; otherwise drag a rectangle for a new one
        const hitArea = [...store.doc.areas].reverse().find(
          (a) => w.x >= a.x && w.x <= a.x + a.w && w.y >= a.y && w.y <= a.y + a.h,
        );
        if (hitArea) {
          state.onAnimOpen(hitArea);
          invalidate();
          return;
        }
        textDragStart = w;
        state.areaRect = { x: w.x, y: w.y, w: 0, h: 0 };
        return;
      }
      case 'text': {
        // Tap an existing textbox to edit it; otherwise drag a rectangle for a new one
        const target = [...store.doc.elements].reverse().find(
          (el): el is import('./types').TextBox =>
            el.kind === 'text' &&
            w.x >= el.x && w.x <= el.x + el.w && w.y >= el.y && w.y <= el.y + el.h,
        );
        if (target) {
          state.onTextEdit(target, { x: target.x, y: target.y, w: target.w, h: target.h });
          return;
        }
        textDragStart = w;
        state.textRect = { x: w.x, y: w.y, w: 0, h: 0 };
        return;
      }
    }
  }

  function hitsSelection(w: { x: number; y: number }): boolean {
    const r = 10 / camera.zoom;
    return store.doc.elements.some(
      (el) => state.selection.has(el.id) && hitElement(el, w.x, w.y, r),
    );
  }

  function eraseAt(w: { x: number; y: number }) {
    const r = ERASER_RADIUS / Math.min(1, camera.zoom) + ERASER_RADIUS;
    for (const el of store.doc.elements) {
      if (state.hidden.has(el.id)) continue;
      if (!frameEditable(el, state)) continue;
      if (hitElement(el, w.x, w.y, r)) {
        state.hidden.add(el.id);
        erased.push(el);
      }
    }
    if (erased.length) invalidate();
  }

  function moveAction(e: PointerEvent) {
    const w = toWorld(e);

    if (dragArea) {
      dragArea.x += w.x - dragStartWorld.x;
      dragArea.y += w.y - dragStartWorld.y;
      dragStartWorld = w;
      invalidate();
      return;
    }
    if (dragPage) {
      dragDesired.x += w.x - dragStartWorld.x;
      dragDesired.y += w.y - dragStartWorld.y;
      const snapped = snapPage(dragPage, dragDesired);
      dragPage.x = snapped.x;
      dragPage.y = snapped.y;
      if (dragPageAll) {
        const dx = dragPage.x - dragPageStart.x;
        const dy = dragPage.y - dragPageStart.y;
        const stepX = dx - pageAllApplied.x;
        const stepY = dy - pageAllApplied.y;
        pageAllApplied = { x: dx, y: dy };
        const idSet = new Set(pageAllIds);
        for (const el of store.doc.elements) {
          if (!idSet.has(el.id)) continue;
          translateElement(el, stepX, stepY);
          dropCache(el.id);
        }
        for (const aid of pageAllAreaIds) {
          const ar = store.area(aid);
          if (ar) { ar.x += stepX; ar.y += stepY; }
        }
      }
      dragStartWorld = w;
      invalidate();
      return;
    }
    if (dragSelection) {
      const dx = w.x - dragStartWorld.x, dy = w.y - dragStartWorld.y;
      for (const el of store.doc.elements) {
        if (!state.selection.has(el.id)) continue;
        translateElement(el, dx, dy);
        dropCache(el.id);
      }
      dragTotal.x += dx; dragTotal.y += dy;
      dragStartWorld = w;
      invalidate();
      return;
    }
    if (panLast) {
      camera.panScreen(e.clientX - panLast.x, e.clientY - panLast.y);
      panLast = { x: e.clientX, y: e.clientY };
      invalidate();
      return;
    }
    if (state.live) {
      const events = e.getCoalescedEvents?.() ?? [e];
      for (const ce of events) {
        // drop out-of-order coalesced samples (loop-back artifacts)
        if (ce.timeStamp && ce.timeStamp < lastEventT) continue;
        if (ce.timeStamp) lastEventT = ce.timeStamp;
        const cw = smooth(toWorld(ce));
        const last = state.live.points[state.live.points.length - 1];
        const dx = cw.x - last.x, dy = cw.y - last.y;
        const p = conditionPressure(ce as PointerEvent);
        const a = tiltOf(ce as PointerEvent);
        const r = azimuthOf(ce as PointerEvent);
        if (dx * dx + dy * dy < minDistSq) {
          last.p = p; // keep the freshest pressure, no new vertex
          if (a !== undefined) last.a = a;
          if (r !== undefined) last.r = r;
          continue;
        }
        state.live.points.push({
          x: cw.x, y: cw.y, p,
          t: performance.now() / 1000 - strokeStart,
          a, r,
        });
      }
      return; // renderer redraws while live is set
    }
    if (state.tool === 'eraser' && erased !== null && e.buttons !== 0) {
      eraseAt(w);
      return;
    }
    if (resizeArea) {
      const a = resizeArea;
      const dx = w.x - resizeAreaStart.wx;
      const dy = w.y - resizeAreaStart.wy;
      const MIN = 40;
      switch (resizeAreaMode) {
        case 'move':
          a.x = resizeAreaStart.x + dx;
          a.y = resizeAreaStart.y + dy;
          break;
        case 'move-all': {
          a.x = resizeAreaStart.x + dx;
          a.y = resizeAreaStart.y + dy;
          const stepX = dx - moveAllApplied.x;
          const stepY = dy - moveAllApplied.y;
          moveAllApplied = { x: dx, y: dy };
          const idSet = new Set(moveAllIds);
          for (const el of store.doc.elements) {
            if (!idSet.has(el.id)) continue;
            translateElement(el, stepX, stepY);
            dropCache(el.id);
          }
          break;
        }
        case 'w-right':
          a.w = Math.max(MIN, resizeAreaStart.w + dx);
          break;
        case 'w-left': {
          const d = Math.min(dx, resizeAreaStart.w - MIN);
          a.x = resizeAreaStart.x + d;
          a.w = resizeAreaStart.w - d;
          break;
        }
        case 'h-bottom':
          a.h = Math.max(MIN, resizeAreaStart.h + dy);
          break;
        case 'corner':
          a.w = Math.max(MIN, resizeAreaStart.w + dx);
          a.h = Math.max(MIN, resizeAreaStart.h + dy);
          break;
      }
      invalidate();
      return;
    }
    if (resizeImg) {
      const el = resizeImg;
      const dx = w.x - imgStart.wx;
      const dy = w.y - imgStart.wy;
      const MIN = 10;
      switch (imgMode) {
        case 'corner': {
          const f = Math.max(0.05, (imgStart.w + dx) / imgStart.w);
          el.w = Math.max(MIN, imgStart.w * f);
          el.h = Math.max(MIN, imgStart.h * f);
          break;
        }
        case 'w-right':
          el.w = Math.max(MIN, imgStart.w + dx);
          break;
        case 'w-left': {
          const d = Math.min(dx, imgStart.w - MIN);
          el.x = imgStart.x + d;
          el.w = imgStart.w - d;
          break;
        }
        case 'h-bottom':
          el.h = Math.max(MIN, imgStart.h + dy);
          break;
      }
      invalidateStatic();
      return;
    }
    if (resizeText) {
      const el = resizeText;
      const dx = w.x - resizeStart.wx;
      const dy = w.y - resizeStart.wy;
      let f = 1;
      if (resizeMode === 'width') {
        el.w = Math.max(30, resizeStart.w + dx);
      } else if (resizeMode === 'width-left') {
        const d = Math.min(dx, resizeStart.w - 30);
        el.x = resizeStart.x + d;
        el.w = resizeStart.w - d;
      } else if (resizeMode === 'scale') {
        f = Math.max(0.15, (resizeStart.w + dx) / resizeStart.w);
        el.w = resizeStart.w * f;
        el.fontSize = resizeStart.fontSize * f;
      }
      const contentH = layoutHeight(layoutText(el.text, el.font ?? 'franklin', el.fontSize, el.w));
      el.h =
        resizeMode === 'height'
          ? Math.max(contentH, resizeStart.h + dy)
          : Math.max(contentH, resizeStart.h * f);
      invalidateStatic();
      return;
    }
    if (state.textRect) {
      state.textRect = {
        x: Math.min(textDragStart.x, w.x),
        y: Math.min(textDragStart.y, w.y),
        w: Math.abs(w.x - textDragStart.x),
        h: Math.abs(w.y - textDragStart.y),
      };
      invalidate();
      return;
    }
    if (state.marquee) {
      state.marquee = {
        x: Math.min(textDragStart.x, w.x),
        y: Math.min(textDragStart.y, w.y),
        w: Math.abs(w.x - textDragStart.x),
        h: Math.abs(w.y - textDragStart.y),
      };
      invalidate();
      return;
    }
    if (state.areaRect) {
      state.areaRect = {
        x: Math.min(textDragStart.x, w.x),
        y: Math.min(textDragStart.y, w.y),
        w: Math.abs(w.x - textDragStart.x),
        h: Math.abs(w.y - textDragStart.y),
      };
      invalidate();
      return;
    }
    if (state.lasso) {
      state.lasso.push(w);
      invalidate();
    }
  }

  function endAction(e?: PointerEvent) {
    if (dragArea) {
      const a = dragArea;
      dragArea = null;
      const dx = a.x - dragAreaStart.x, dy = a.y - dragAreaStart.y;
      const tap = Math.abs(dx) < 3 / camera.zoom && Math.abs(dy) < 3 / camera.zoom;
      a.x = dragAreaStart.x; a.y = dragAreaStart.y;
      if (tap) {
        state.onAnimOpen(a);
        invalidate();
      } else {
        store.moveArea(a.id, dx, dy);
      }
      return;
    }
    if (dragPage) {
      const p = dragPage;
      const dx = p.x - dragPageStart.x, dy = p.y - dragPageStart.y;
      const wasAll = dragPageAll;
      dragPage = null;
      dragPageAll = false;
      const tapThreshold = 3 / camera.zoom;
      if (!wasAll && Math.abs(dx) < tapThreshold && Math.abs(dy) < tapThreshold && e) {
        // A tap, not a drag: open the page menu
        p.x = dragPageStart.x; p.y = dragPageStart.y;
        state.onPageMenu(p, e.clientX, e.clientY);
        invalidate();
        return;
      }
      // revert live mutation, then commit as a single undoable op
      p.x = dragPageStart.x; p.y = dragPageStart.y;
      if (wasAll) {
        const idSet = new Set(pageAllIds);
        for (const el of store.doc.elements) {
          if (!idSet.has(el.id)) continue;
          translateElement(el, -dx, -dy);
          dropCache(el.id);
        }
        for (const aid of pageAllAreaIds) {
          const ar = store.area(aid);
          if (ar) { ar.x -= dx; ar.y -= dy; }
        }
        store.movePageWithContent(p.id, pageAllIds, pageAllAreaIds, dx, dy);
        pageAllIds = [];
        pageAllAreaIds = [];
      } else {
        store.movePage(p.id, dx, dy);
      }
      return;
    }
    if (dragSelection) {
      const ids = [...state.selection];
      for (const el of store.doc.elements) {
        if (!state.selection.has(el.id)) continue;
        translateElement(el, -dragTotal.x, -dragTotal.y);
        dropCache(el.id);
      }
      store.moveElements(ids, dragTotal.x, dragTotal.y);
      dragSelection = false;
      return;
    }
    panLast = null;
    if (state.live) {
      const s = state.live;
      state.live = null;
      let travel = 0;
      for (let i = 1; i < s.points.length; i++) {
        travel += Math.hypot(s.points[i].x - s.points[i - 1].x, s.points[i].y - s.points[i - 1].y);
      }
      if (travel < Math.max(s.baseWidth * 0.6, 5 / strokeZoom)) {
        // a tap: one point at the centroid, carrying the peak pressure of the
        // touch → renders as a perfect round dot (see geometry.dotOutline)
        const n = s.points.length;
        const cx = s.points.reduce((a, p) => a + p.x, 0) / n;
        const cy = s.points.reduce((a, p) => a + p.y, 0) / n;
        s.points = [{ x: cx, y: cy, p: rawPMax ?? s.points[0].p, t: 0, a: s.points[0].a, r: s.points[0].r }];
      } else {
        // digitiser quantisation is ~1 screen px; smooth it away in world units
        // scaled by the zoom you drew at, so zoomed-out lines don't kink when
        // you zoom back in and zoomed-in lines keep every intended wiggle
        s.points = denoise(s.points, pressure[s.tool].smooth / strokeZoom);
      }
      if (s.area) {
        // live ink: every stroke gets its own live layer with its own cycle
        store.addLiveLayer(s.area, s, 'continuous');
      } else {
        store.addElement(s);
      }
      return;
    }
    if (erased.length) {
      const els = erased;
      erased = [];
      state.hidden.clear();
      store.deleteElements(els);
      return;
    }
    if (resizeArea) {
      const a = resizeArea;
      resizeArea = null;
      const st = resizeAreaStart;
      if (resizeAreaMode === 'move' || resizeAreaMode === 'move-all') {
        const dx = a.x - st.x, dy = a.y - st.y;
        a.x = st.x; a.y = st.y;
        if (resizeAreaMode === 'move-all') {
          const idSet = new Set(moveAllIds);
          for (const el of store.doc.elements) {
            if (!idSet.has(el.id)) continue;
            translateElement(el, -dx, -dy);
            dropCache(el.id);
          }
          store.moveAreaWithContent(a.id, moveAllIds, dx, dy);
          moveAllIds = [];
        } else {
          store.moveArea(a.id, dx, dy);
        }
      } else {
        const after = { x: a.x, y: a.y, w: a.w, h: a.h };
        a.x = st.x; a.y = st.y; a.w = st.w; a.h = st.h;
        store.resizeArea(a.id, { x: st.x, y: st.y, w: st.w, h: st.h }, after);
      }
      return;
    }
    if (resizeImg) {
      const el = resizeImg;
      resizeImg = null;
      const after = { x: el.x, y: el.y, w: el.w, h: el.h };
      el.x = imgStart.x; el.y = imgStart.y; el.w = imgStart.w; el.h = imgStart.h;
      store.resizeImage(el.id, { x: imgStart.x, y: imgStart.y, w: imgStart.w, h: imgStart.h }, after);
      return;
    }
    if (resizeText) {
      const el = resizeText;
      resizeText = null;
      // resizing by hand fixes the size: the box stops following its content
      const after = { x: el.x, w: el.w, h: el.h, fontSize: el.fontSize, auto: false };
      // revert live mutation, commit as one undoable op
      el.x = resizeStart.x; el.w = resizeStart.w; el.h = resizeStart.h; el.fontSize = resizeStart.fontSize;
      store.resizeText(el.id, { x: resizeStart.x, w: resizeStart.w, h: resizeStart.h, fontSize: resizeStart.fontSize, auto: el.auto }, after);
      return;
    }
    erased = [];
    if (state.marquee) {
      const m = state.marquee;
      state.marquee = null;
      const editable = store.doc.elements.filter((el) => frameEditable(el, state));
      if (m.w < 3 / camera.zoom && m.h < 3 / camera.zoom) {
        // a click: select the topmost element under the cursor
        const hit = [...editable].reverse().find((el) => hitElement(el, m.x, m.y, 6 / camera.zoom));
        state.selection = hit ? new Set([hit.id]) : new Set();
      } else {
        const poly = [
          { x: m.x, y: m.y }, { x: m.x + m.w, y: m.y },
          { x: m.x + m.w, y: m.y + m.h }, { x: m.x, y: m.y + m.h },
        ];
        state.selection = new Set(elementsInLasso(editable, poly).map((el) => el.id));
      }
      invalidate();
      return;
    }
    if (state.areaRect) {
      let r = state.areaRect;
      state.areaRect = null;
      if (r.w < 20 || r.h < 20) r = { x: textDragStart.x, y: textDragStart.y, w: 300, h: 300 };
      const area = store.addArea(r);
      state.onAnimOpen(area);
      state.tool = state.lastDrawTool;
      state.onToolChange();
      invalidate();
      return;
    }
    if (state.textRect) {
      let r = state.textRect;
      state.textRect = null;
      let auto = false;
      if (r.w < 12 || r.h < 12) {
        // a tap: an auto-sizing box that grows with what you type
        r = { x: textDragStart.x, y: textDragStart.y, w: 40, h: 30 };
        auto = true;
      }
      state.onTextEdit(null, r, auto);
      invalidate();
      return;
    }
    if (state.lasso) {
      const lasso = state.lasso;
      state.lasso = null;
      if (state.tool === 'lasso-select') {
        state.selection = new Set(elementsInLasso(store.doc.elements, lasso).map((e) => e.id));
      } else if (state.tool === 'lasso-fill' && lasso.length > 2) {
        const fill: FillShape = {
          id: uid('fl'), kind: 'fill', color: state.color, opacity: 1,
          pattern: state.fillPattern ?? undefined,
          ink: state.fillPattern ? state.inkDensity : undefined,
          // every tone fill gets its own angle so neighbouring fills don't line up like wallpaper
          patternAngle: state.fillPattern && !isPixelPattern(state.fillPattern) ? Math.floor(Math.random() * 36) * 5 : undefined,
          layer: state.paintBehind ? 'back' : 'front',
          frame: state.activeFrameId ?? undefined,
          alayer: state.activeLayerId ?? undefined,
          // same screen-space smoothing as the brushes (3px at drawing zoom)
          points: denoiseClosed(lasso.map((p) => ({ x: p.x, y: p.y })), 3 / camera.zoom),
        };
        store.addElement(fill);
      }
      invalidate();
    }
  }

  // ---- copy / cut / paste (works across zines via localStorage) ----
  function copySelection(): boolean {
    let payload: unknown = null;
    if (state.selection.size) {
      const els = store.doc.elements.filter((el) => state.selection.has(el.id));
      if (els.length) payload = { app: 'infinizine-clip', kind: 'elements', elements: els };
    } else if (state.activeAreaId) {
      const area = store.doc.areas.find((a) => a.id === state.activeAreaId);
      if (area) {
        const ids = new Set(store.areaContentIds(area.id));
        payload = {
          app: 'infinizine-clip',
          kind: 'area',
          area,
          elements: store.doc.elements.filter((el) => ids.has(el.id)),
        };
      }
    }
    if (!payload) {
      toast('Nothing selected to copy');
      return false;
    }
    const json = JSON.stringify(payload);
    memClip = json;
    try {
      localStorage.setItem(CLIP_KEY, json);
    } catch {
      // too big for localStorage — drop the stale entry so other tabs don't paste old content
      try { localStorage.removeItem(CLIP_KEY); } catch { /* ignore */ }
    }
    try { localStorage.setItem(CLIP_PENDING_KEY, '1'); } catch { /* ignore */ }
    navigator.clipboard?.writeText(json).catch(() => {});
    const p = payload as { kind: string; elements: Element[] };
    toast(p.kind === 'area' ? 'Copied animation area' : `Copied ${p.elements.length} element${p.elements.length === 1 ? '' : 's'}`);
    return true;
  }

  function cutSelection() {
    if (!copySelection()) return;
    const els = store.doc.elements.filter((el) => state.selection.has(el.id));
    if (els.length) {
      state.selection.clear();
      store.deleteElements(els);
      toast(`Cut ${els.length} element${els.length === 1 ? '' : 's'}`);
    } else if (state.activeAreaId) {
      const area = store.doc.areas.find((a) => a.id === state.activeAreaId);
      if (area) {
        store.deleteArea(area);
        state.onAnimClose();
        toast('Cut animation area');
      }
    }
    invalidate();
  }

  function addImageFromDataURL(dataURL: string) {
    const img = new Image();
    img.onload = () => {
      const MAX = 260; // world units
      const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(10, img.naturalWidth * scale);
      const h = Math.max(10, img.naturalHeight * scale);
      const el: ImageBox = {
        id: uid('img'),
        kind: 'image',
        x: camera.x - w / 2,
        y: camera.y - h / 2,
        w,
        h,
        src: dataURL,
        frame: state.activeFrameId ?? undefined,
        alayer: state.activeFrameId ? state.activeLayerId ?? undefined : undefined,
      };
      store.addElement(el);
      state.selection = new Set([el.id]);
      state.tool = 'cursor';
      state.onToolChange();
      toast('Pasted image');
      invalidate();
    };
    img.src = dataURL;
  }

  function addTextFromString(text: string) {
    const wBox = 220;
    const h = Math.max(30, layoutHeight(layoutText(text, state.font, state.textSize, wBox)));
    const el: Element = {
      id: uid('tx'),
      kind: 'text',
      x: camera.x - wBox / 2,
      y: camera.y - h / 2,
      w: wBox,
      h,
      color: state.color,
      fontSize: state.textSize,
      font: state.font,
      text,
      frame: state.activeFrameId ?? undefined,
      alayer: state.activeFrameId ? state.activeLayerId ?? undefined : undefined,
    };
    store.addElement(el);
    state.selection = new Set([el.id]);
    state.tool = 'cursor';
    state.onToolChange();
    toast('Pasted text');
    invalidate();
  }

  /** Smart paste: image from system clipboard → image element; plain text →
   * textbox; zine content (ours) → elements/area. Falls back to the internal
   * clipboard when the system one is unreadable. */
  async function pasteSmart() {
    try {
      if (navigator.clipboard?.read) {
        const items = await navigator.clipboard.read();
        for (const it of items) {
          const imgType = it.types.find((t) => t.startsWith('image/'));
          if (imgType) {
            const blob = await it.getType(imgType);
            const fr = new FileReader();
            fr.onload = () => addImageFromDataURL(fr.result as string);
            fr.readAsDataURL(blob);
            return;
          }
        }
      }
      const txt = await navigator.clipboard?.readText?.();
      if (txt && txt.trim()) {
        try {
          const p = JSON.parse(txt);
          if (p && p.app === 'infinizine-clip') {
            memClip = txt;
            try { localStorage.setItem(CLIP_KEY, txt); } catch { /* ignore */ }
            pasteClipboard();
            toast('Pasted');
            return;
          }
        } catch { /* not ours — plain text */ }
        addTextFromString(txt);
        return;
      }
    } catch { /* clipboard unreadable (permissions) — fall back */ }
    const had = memClip !== null ||
      (() => { try { return !!localStorage.getItem(CLIP_KEY); } catch { return false; } })();
    if (had) {
      pasteClipboard();
      toast('Pasted');
    } else {
      toast('Clipboard is empty');
    }
  }

  function pasteClipboard() {
    let raw: string | null = memClip;
    if (!raw) {
      try {
        raw = localStorage.getItem(CLIP_KEY);
      } catch { /* ignore */ }
    }
    if (!raw) return;
    let payload: {
      app?: string;
      kind?: string;
      elements?: Element[];
      area?: AnimArea;
    };
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    if (payload.app !== 'infinizine-clip' || !payload.elements) return;

    // paste centered on the current view, slightly offset
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const grow = (x: number, y: number) => {
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    };
    for (const el of payload.elements) {
      if (el.kind === 'text' || el.kind === 'image') {
        grow(el.x, el.y);
        grow(el.x + el.w, el.y + el.h);
      } else {
        for (const pt of el.points) grow(pt.x, pt.y);
      }
    }
    if (payload.kind === 'area' && payload.area) {
      grow(payload.area.x, payload.area.y);
      grow(payload.area.x + payload.area.w, payload.area.y + payload.area.h);
    }
    if (minX === Infinity) { minX = 0; minY = 0; maxX = 0; maxY = 0; }
    const dx = camera.x - (minX + maxX) / 2 + 20;
    const dy = camera.y - (minY + maxY) / 2 + 20;

    if (payload.kind === 'area' && payload.area) {
      // remap every id so the pasted area is fully independent
      const area = structuredClone(payload.area) as AnimArea;
      const idMap = new Map<string, string>();
      const remap = (old: string) => {
        let n = idMap.get(old);
        if (!n) { n = uid('cp'); idMap.set(old, n); }
        return n;
      };
      area.id = remap(area.id);
      area.x += dx; area.y += dy;
      for (const l of area.layers) {
        l.id = remap(l.id);
        l.frames = l.frames.map((f) => ({ ...f, id: remap(f.id) }));
      }
      const els = payload.elements.map((el) => {
        const c = structuredClone(el) as Element;
        c.id = uid('cp');
        translateElement(c, dx, dy);
        if (c.frame) c.frame = remap(c.frame);
        if (c.alayer) c.alayer = remap(c.alayer);
        if (c.kind === 'stroke' && c.area) c.area = remap(c.area);
        return c;
      });
      store.addAreaWithContent(area, els);
      state.selection.clear();
      state.onAnimOpen(area); // activate the pasted area so it can be moved right away
    } else {
      const els = payload.elements.map((el) => {
        const c = structuredClone(el) as Element;
        c.id = uid('cp');
        translateElement(c, dx, dy);
        // plain-element pastes drop animation ties; retag to the open frame if any
        c.frame = state.activeFrameId ?? undefined;
        c.alayer = state.activeFrameId ? state.activeLayerId ?? undefined : undefined;
        if (c.kind === 'stroke') {
          c.area = undefined;
          c.animStart = undefined;
          c.animLife = undefined;
          c.animTaper = undefined;
        }
        return c;
      });
      store.addElements(els);
      state.selection = new Set(els.map((el) => el.id));
      // land in the cursor tool so the pasted elements can be moved immediately
      state.tool = 'cursor';
      state.onToolChange();
    }
    try { localStorage.setItem(CLIP_PENDING_KEY, '0'); } catch { /* ignore */ }
    invalidate();
  }

  let dropCache: (id: string) => void = () => {};
  // live mutations of text/image boxes (resize previews) aren't store changes:
  // the renderer's static layer must be told to rebuild so the preview shows
  const invalidateStatic = () => { dropCache('*'); invalidate(); };
  const api = {
    setDropCache(fn: (id: string) => void) { dropCache = fn; },
    copySelection,
    cutSelection,
    pasteSmart,
  };

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    if (e.pointerType === 'pen' && !state.penDetected) {
      state.penDetected = true;
      state.fingerMode = 'pan';
      state.fingerDraws = false;
      writePref(PEN_KEY, '1');
      writePref(FINGER_KEY, 'pan');
      state.onToolChange();
    }
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) {
        // Second finger: cancel any in-progress touch action, start pinch
        if (state.live && drawingPointer !== null) state.live = null;
        state.lasso = null;
        drawingPointer = null;
        panLast = null;
        const [a, b] = [...touches.values()];
        pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
        pinchMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        gesture = { fingers: 2, t: performance.now(), moved: 0, mid: { ...pinchMid } };
        scrub = null;
        armScrub();
        invalidate();
        return;
      }
      if (touches.size > 2) {
        if (gesture) gesture.fingers = Math.max(gesture.fingers, touches.size);
        window.clearTimeout(scrubTimer);
        scrub = null;
        return;
      }
      if (!isDrawPointer(e)) {
        // pencil users: double-tap the canvas with one finger to flip eraser/draw
        if (state.fingerMode === 'pan' && state.penDetected && !state.presenting && touches.size === 1) {
          const now = performance.now();
          if (
            now - fingerTap.t < 300 &&
            Math.hypot(e.clientX - fingerTap.x, e.clientY - fingerTap.y) < 30
          ) {
            state.tool = state.tool === 'eraser' ? state.lastDrawTool : 'eraser';
            state.onToolChange();
            fingerTap = { t: 0, x: 0, y: 0 };
          } else {
            fingerTap = { t: now, x: e.clientX, y: e.clientY };
          }
        }
        if (state.fingerMode === 'select' && !state.presenting) {
          // one finger selects (cursor semantics); two fingers pan/zoom
          drawingPointer = e.pointerId;
          startAction(e, 'cursor');
          return;
        }
        panLast = { x: e.clientX, y: e.clientY };
        panStart = { x: e.clientX, y: e.clientY, t: performance.now() };
        return;
      }
    }
    if (e.pointerType === 'mouse' && (e.button === 1 || e.button === 2)) {
      panLast = { x: e.clientX, y: e.clientY };
      return;
    }
    drawingPointer = e.pointerId;
    startAction(e);
  });

  canvas.addEventListener('pointermove', (e) => {
    // hover tracking for textbox move handles + cursor feedback (mouse only, not while dragging)
    if (e.pointerType === 'mouse' && e.buttons === 0 && !state.presenting) {
      const w = toWorld(e);
      const z = camera.zoom;
      let hover: string | null = null;
      let cursor = '';
      for (const el of [...store.doc.elements].reverse()) {
        if (el.kind !== 'text' || !frameEditable(el, state)) continue;
        const hr = textHandleRect(el, z);
        const inHandle = w.x >= hr.x && w.x <= hr.x + hr.s && w.y >= hr.y && w.y <= hr.y + hr.s;
        const inDel = inRect(w, deleteHandleRect(el.x, el.y, el.w, z));
        const inBox = w.x >= el.x && w.x <= el.x + el.w && w.y >= el.y && w.y <= el.y + el.h;
        // resize handles straddle the border: their outer half must keep the box hovered
        const r = 12 / z;
        const nearResize =
          Math.hypot(w.x - (el.x + el.w), w.y - (el.y + el.h)) < r ||
          (Math.abs(w.y - (el.y + el.h)) < r && Math.abs(w.x - (el.x + el.w / 2)) < r) ||
          (Math.abs(w.y - (el.y + el.h / 2)) < r && (Math.abs(w.x - el.x) < r || Math.abs(w.x - (el.x + el.w)) < r));
        if (inHandle || inBox || inDel || nearResize) {
          hover = el.id;
          if (inHandle) cursor = 'grab';
          if (inDel) cursor = 'pointer';
          if (Math.hypot(w.x - (el.x + el.w), w.y - (el.y + el.h)) < r) cursor = 'nwse-resize';
          else if (Math.abs(w.y - (el.y + el.h)) < r && Math.abs(w.x - (el.x + el.w / 2)) < r) cursor = 'ns-resize';
          else if (Math.abs(w.y - (el.y + el.h / 2)) < r &&
            (Math.abs(w.x - el.x) < r || Math.abs(w.x - (el.x + el.w)) < r)) cursor = 'ew-resize';
          break;
        }
      }
      // image hover + handle cursors
      let hoverImage: string | null = null;
      if (!cursor) {
        for (const el of [...store.doc.elements].reverse()) {
          if (el.kind !== 'image' || !frameEditable(el, state)) continue;
          const r = 12 / z;
          const inBox = w.x >= el.x && w.x <= el.x + el.w && w.y >= el.y && w.y <= el.y + el.h;
          const inMove = inRect(w, moveHandleRect(el.x, el.y, z));
          const inDel = inRect(w, deleteHandleRect(el.x, el.y, el.w, z));
          const nearResize =
            Math.hypot(w.x - (el.x + el.w), w.y - (el.y + el.h)) < r ||
            (Math.abs(w.y - (el.y + el.h)) < r && Math.abs(w.x - (el.x + el.w / 2)) < r) ||
            (Math.abs(w.y - (el.y + el.h / 2)) < r && (Math.abs(w.x - el.x) < r || Math.abs(w.x - (el.x + el.w)) < r));
          if (inBox || inMove || inDel || nearResize) {
            hoverImage = el.id;
            if (inMove) cursor = 'grab';
            else if (inDel) cursor = 'pointer';
            else if (Math.hypot(w.x - (el.x + el.w), w.y - (el.y + el.h)) < r) cursor = 'nwse-resize';
            else if (Math.abs(w.y - (el.y + el.h)) < r && Math.abs(w.x - (el.x + el.w / 2)) < r) cursor = 'ns-resize';
            else if (Math.abs(w.y - (el.y + el.h / 2)) < r &&
              (Math.abs(w.x - el.x) < r || Math.abs(w.x - (el.x + el.w)) < r)) cursor = 'ew-resize';
            break;
          }
        }
      }
      if (hoverImage !== state.hoverImage) {
        state.hoverImage = hoverImage;
        invalidate();
      }
      // area handles hover
      let hoverArea: string | null = null;
      if (!cursor) {
        for (const a of [...store.doc.areas].reverse()) {
          const r = 12 / z;
          const mh = moveHandleRect(a.x, a.y, z);
          const nearLabel = w.x >= a.x && w.x <= a.x + 160 / z && w.y >= a.y - 26 / z && w.y <= a.y;
          const inMove = w.x >= mh.x && w.x <= mh.x + mh.s && w.y >= mh.y && w.y <= mh.y + mh.s;
          const inMoveAll = inRect(w, moveAllHandleRect(a.x, a.y, z));
          const inDel = inRect(w, deleteHandleRect(a.x, a.y, a.w, z));
          const nearEdge =
            (Math.abs(w.x - a.x) < r || Math.abs(w.x - (a.x + a.w)) < r) &&
              w.y > a.y - r && w.y < a.y + a.h + r ||
            (Math.abs(w.y - a.y) < r || Math.abs(w.y - (a.y + a.h)) < r) &&
              w.x > a.x - r && w.x < a.x + a.w + r;
          if (nearLabel || inMove || inMoveAll || inDel || nearEdge || state.activeAreaId === a.id) {
            if (nearLabel || inMove || inMoveAll || inDel || nearEdge) hoverArea = a.id;
            if (hoverArea || state.activeAreaId === a.id) {
              if (inMove || inMoveAll) cursor = 'grab';
              else if (inDel) cursor = 'pointer';
              else if (Math.hypot(w.x - (a.x + a.w), w.y - (a.y + a.h)) < r) cursor = 'nwse-resize';
              else if (Math.abs(w.y - (a.y + a.h)) < r && Math.abs(w.x - (a.x + a.w / 2)) < r) cursor = 'ns-resize';
              else if (Math.abs(w.y - (a.y + a.h / 2)) < r &&
                (Math.abs(w.x - a.x) < r || Math.abs(w.x - (a.x + a.w)) < r)) cursor = 'ew-resize';
              else if (nearLabel) cursor = 'pointer'; // tap opens the timeline
            }
            if (hoverArea) break;
          }
        }
      }
      if (hoverArea !== state.hoverArea) {
        state.hoverArea = hoverArea;
        invalidate();
      }
      // page hover: near the label, the grabbers, or the border
      let hoverPage: string | null = null;
      if (!cursor && !hoverArea) {
        for (const p of [...store.doc.pages].reverse()) {
          const r = 10 / z;
          const mh = moveHandleRect(p.x, p.y, z);
          const mha = moveAllHandleRect(p.x, p.y, z);
          const nearLabel = w.x >= p.x && w.x <= p.x + 140 / z && w.y >= p.y - 26 / z && w.y <= p.y;
          const inGrab = inRect(w, mh) || inRect(w, mha);
          const inEye = inRect(w, eyeHandleRect(p.x, p.y, z));
          const nearEdge =
            ((Math.abs(w.x - p.x) < r || Math.abs(w.x - (p.x + p.w)) < r) &&
              w.y > p.y - r && w.y < p.y + p.h + r) ||
            ((Math.abs(w.y - p.y) < r || Math.abs(w.y - (p.y + p.h)) < r) &&
              w.x > p.x - r && w.x < p.x + p.w + r);
          if (nearLabel || inGrab || inEye || nearEdge) {
            hoverPage = p.id;
            if (inGrab) cursor = 'grab';
            else if (inEye || nearLabel) cursor = 'pointer';
            break;
          }
        }
      }
      if (hoverPage !== state.hoverPage) {
        state.hoverPage = hoverPage;
        invalidate();
      }
      // anything selected under the cursor is grabbable
      if (!cursor && state.selection.size && hitsSelection(w)) cursor = 'grab';
      canvas.style.cursor = cursor || state.toolCursor;
      if (hover !== state.hoverText) {
        state.hoverText = hover;
        invalidate();
      }
    }
    if (e.pointerType === 'mouse' && e.buttons !== 0 && (dragSelection || dragPage)) {
      canvas.style.cursor = 'grabbing';
    }
    if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) {
        const [a, b] = [...touches.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const r = canvas.getBoundingClientRect();
        if (gesture) {
          gesture.moved = Math.max(gesture.moved, Math.hypot(mid.x - gesture.mid.x, mid.y - gesture.mid.y));
          if (gesture.moved > TAP_MAX_PX && !scrub) window.clearTimeout(scrubTimer);
        }
        if (scrub) {
          // history scrub: every step left undoes, every step right redoes
          let steps = Math.trunc((mid.x - scrub.x) / SCRUB_STEP_PX);
          if (steps !== 0) {
            scrub.x += steps * SCRUB_STEP_PX;
            for (; steps < 0; steps++) store.undo();
            for (; steps > 0; steps--) store.redo();
            invalidate();
          }
          pinchDist = dist;
          pinchMid = mid;
          return;
        }
        if (pinchMid) camera.panScreen(mid.x - pinchMid.x, mid.y - pinchMid.y);
        if (pinchDist > 0 && !state.zoomLocked) {
          camera.zoomAt(dist / pinchDist, mid.x - r.left, mid.y - r.top, vw(), vh());
          state.updateCursor();
        }
        pinchDist = dist;
        pinchMid = mid;
        invalidate();
        return;
      }
    }
    if (drawingPointer === e.pointerId || panLast || dragPage || dragArea || dragSelection || resizeArea || resizeImg) {
      e.preventDefault();
      moveAction(e);
    }
  });

  const finish = (e: PointerEvent) => {
    touches.delete(e.pointerId);
    if (touches.size < 2) { pinchDist = 0; pinchMid = null; }
    if (e.pointerType === 'touch' && gesture && touches.size === 0) {
      window.clearTimeout(scrubTimer);
      const g = gesture;
      gesture = null;
      const wasScrub = !!scrub;
      scrub = null;
      if (!wasScrub && performance.now() - g.t < TAP_MAX_MS && g.moved < TAP_MAX_PX && !state.presenting) {
        if (g.fingers === 2) { store.undo(); toast('Undo'); }
        else if (g.fingers >= 3) { store.redo(); toast('Redo'); }
        invalidate();
      }
    }
    // a motionless one-finger tap in pan mode still selects what's under it
    if (e.pointerType === 'touch' && panLast && panStart && !state.presenting) {
      const moved = Math.hypot(e.clientX - panStart.x, e.clientY - panStart.y);
      if (moved < 10 && performance.now() - panStart.t < 300) {
        const w = toWorld(e);
        const editable = store.doc.elements.filter((el) => frameEditable(el, state));
        const hit = [...editable].reverse().find((el) => hitElement(el, w.x, w.y, 8 / camera.zoom));
        state.selection = hit ? new Set([hit.id]) : new Set();
        invalidate();
      }
    }
    panStart = null;
    if (drawingPointer === e.pointerId || dragPage || dragArea || dragSelection || panLast || resizeArea || resizeImg) {
      drawingPointer = null;
      endAction(e);
    }
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);
  // Safari runs its double-tap gesture recogniser on the raw touch events and
  // swallows the second quick Pencil tap unless these are cancelled here
  // (touch-action:none alone isn't enough) — same trick Doodely uses.
  for (const t of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
    canvas.addEventListener(t, (e) => e.preventDefault(), { passive: false });
  }

  // Double-click / double-tap a textbox in cursor modes (select/hand) jumps into editing
  const CURSOR_TOOLS: Tool[] = ['cursor', 'lasso-select', 'hand', 'text'];
  function textAt(w: { x: number; y: number }): TextBox | null {
    return (
      [...store.doc.elements]
        .reverse()
        .find(
          (el): el is TextBox =>
            el.kind === 'text' && frameEditable(el, state) &&
            w.x >= el.x && w.x <= el.x + el.w && w.y >= el.y && w.y <= el.y + el.h,
        ) ?? null
    );
  }
  function openEditor(el: TextBox) {
    state.selection.clear();
    state.onTextEdit(el, { x: el.x, y: el.y, w: el.w, h: el.h });
    invalidate();
  }
  canvas.addEventListener('dblclick', (e) => {
    if (state.presenting || !CURSOR_TOOLS.includes(state.tool)) return;
    const el = textAt(toWorld(e));
    if (el) openEditor(el);
  });
  let lastTap = { t: 0, x: 0, y: 0 };
  let fingerTap = { t: 0, x: 0, y: 0 };
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || state.presenting || !CURSOR_TOOLS.includes(state.tool)) return;
    const now = performance.now();
    const isDouble =
      now - lastTap.t < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 24;
    lastTap = { t: now, x: e.clientX, y: e.clientY };
    if (!isDouble) return;
    const el = textAt(toWorld(e));
    if (el) openEditor(el);
  });

  // Document-level: pinch/ctrl-wheel over UI elements must zoom the canvas,
  // never the browser page. Plain scrolling over UI (e.g. palette list) stays native.
  document.addEventListener('wheel', (e) => {
    if (!inScope()) return;
    const zooming = e.ctrlKey || e.metaKey;
    if (e.target !== canvas && !zooming) return;
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    if (zooming) {
      if (!state.zoomLocked) {
        camera.zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top, vw(), vh());
        state.updateCursor();
      }
    } else {
      camera.panScreen(-e.deltaX, -e.deltaY);
    }
    invalidate();
  }, { passive: false });

  // Safari page pinch-zoom (gesture events) — block it everywhere; canvas pinch
  // is handled through pointer events.
  if (scope === 'main') {
    for (const t of ['gesturestart', 'gesturechange', 'gestureend']) {
      document.addEventListener(t, (e) => e.preventDefault());
    }
  }

  window.addEventListener('keydown', (e) => {
    if (!inScope()) return;
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement).isContentEditable) return;
    if (e.key === 'Escape' && !state.presenting && state.selection.size) {
      state.selection.clear();
      invalidate();
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selection.size) {
      e.preventDefault();
      const els = store.doc.elements.filter((el) => state.selection.has(el.id));
      state.selection.clear();
      store.deleteElements(els);
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === 'c') {
      if (copySelection()) e.preventDefault();
      return;
    }
    if (mod && e.key === 'x') {
      e.preventDefault();
      cutSelection();
      return;
    }
    if (mod && e.key === 'v') {
      e.preventDefault();
      void pasteSmart();
      return;
    }
    if (mod && e.key === 'z') {
      e.preventDefault();
      e.shiftKey ? store.redo() : store.undo();
      return;
    }
    if (mod && e.key === '0') {
      e.preventDefault();
      camera.zoom = baseZoom();
      state.updateCursor();
      state.onToolChange();
      invalidate();
      return;
    }
    if (mod) return;
    const map: Record<string, Tool> = {
      p: 'pen', f: 'fineliner', m: 'marker', e: 'eraser',
      b: 'pencil', v: 'cursor', s: 'lasso-select', g: 'lasso-fill', t: 'text', a: 'anim', h: 'hand',
    };
    const tool = map[e.key.toLowerCase()];
    if (tool) {
      state.tool = tool;
      state.onToolChange();
    }
  });

  return api;
}

