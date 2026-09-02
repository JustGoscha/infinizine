// Pointer handling: pen draws, fingers pan/pinch-zoom (Notes-style),
// mouse works for desktop/browser verification. Coalesced events used
// for high-frequency stroke sampling.

import { Camera } from './camera';
import { Store } from './store';
import { AnimArea, Stroke, FillShape, Element, Page, TextBox, uid } from './types';
import { hitElement, elementsInLasso } from './geometry';
import { layoutText, layoutHeight } from './text';

export type Tool = 'pen' | 'fineliner' | 'marker' | 'eraser' | 'cursor' | 'lasso-select' | 'lasso-fill' | 'text' | 'anim' | 'hand';

/** While an anim area is selected, only the active frame's elements (and the
 * area's timed live-ink strokes) are editable; otherwise only untagged ones. */
export function frameEditable(el: Element, state: InputState): boolean {
  const area = el.kind === 'stroke' ? el.area : undefined;
  if (state.activeAreaId) return el.frame === state.activeFrameId || area === state.activeAreaId;
  return !el.frame && !area;
}

function translateElement(el: Element, dx: number, dy: number) {
  if (el.kind === 'text') {
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
  tool: Tool = 'pen';
  color = '#1a1a1a';
  baseWidth = 3.5;
  paintBehind = false; // 'back' layer toggle for new strokes/fills
  font = 'franklin'; // typeface for new textboxes
  textSize = 8; // world units; Title 18 / Heading 12 / Body 8 / Sub 6
  live: Stroke | null = null;
  lasso: { x: number; y: number }[] | null = null;
  selection = new Set<string>();
  hidden = new Set<string>();
  penDetected = false;
  fingerDraws = true; // auto-disabled once a pen is seen
  armedPageDrag: Page | null = null; // set by the page menu's Move action
  presenting = false; // presentation mode: render only page content
  presentPage: Page | null = null; // the single page shown while presenting
  onToolChange: () => void = () => {};
  onPageMenu: (page: Page, clientX: number, clientY: number) => void = () => {};
  textRect: { x: number; y: number; w: number; h: number } | null = null; // rect being drawn with the text tool
  hoverText: string | null = null; // textbox under the mouse (shows its move handle)
  hoverArea: string | null = null; // anim area under the mouse (shows its handles)
  lastDrawTool: Tool = 'pen'; // remembered so e.g. area creation can bounce back to it
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
  playingAreas = false;
  playEpoch = 0; // performance.now()/1000 when playback started
  onAnimOpen: (area: import('./types').AnimArea) => void = () => {};
  onTextEdit: (
    target: import('./types').TextBox | null,
    rect: { x: number; y: number; w: number; h: number },
  ) => void = () => {};
}

interface TouchInfo { x: number; y: number }

export function attachInput(
  canvas: HTMLCanvasElement,
  camera: Camera,
  store: Store,
  state: InputState,
  invalidate: () => void,
) {
  const touches = new Map<number, TouchInfo>();
  let drawingPointer: number | null = null;
  let strokeStart = 0;
  let textDragStart = { x: 0, y: 0 };
  // area move/resize via the same handle set as textboxes
  let resizeArea: AnimArea | null = null;
  let resizeAreaMode: 'move' | 'w-left' | 'w-right' | 'h-bottom' | 'corner' = 'move';
  let resizeAreaStart = { x: 0, y: 0, w: 0, h: 0, wx: 0, wy: 0 };
  // textbox resize/scale (Excalidraw-style handles on a hovered/selected textbox)
  let resizeText: TextBox | null = null;
  let resizeMode: 'width' | 'width-left' | 'height' | 'scale' = 'width';
  let resizeStart = { x: 0, w: 0, h: 0, fontSize: 0, wx: 0, wy: 0 };
  let ema: { x: number; y: number } | null = null; // input smoothing (Doodely-style EMA)
  const EMA_FACTOR = 0.6; // higher = more responsive, lower = smoother

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
  let pinchDist = 0;

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
    return state.fingerDraws && !state.penDetected && touches.size <= 1;
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

  function startAction(e: PointerEvent) {
    // Presentation mode: any drag pans, no drawing/tools
    if (state.presenting) {
      panLast = { x: e.clientX, y: e.clientY };
      return;
    }
    const w = toWorld(e);

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
      let mode: typeof resizeAreaMode | null = null;
      if (inRect(w, mh)) mode = 'move';
      else if (Math.hypot(w.x - (a.x + a.w), w.y - (a.y + a.h)) < r) mode = 'corner';
      else if (Math.abs(w.y - (a.y + a.h)) < r && Math.abs(w.x - (a.x + a.w / 2)) < r) mode = 'h-bottom';
      else if (Math.abs(w.x - (a.x + a.w)) < r && Math.abs(w.y - (a.y + a.h / 2)) < r) mode = 'w-right';
      else if (Math.abs(w.x - a.x) < r && Math.abs(w.y - (a.y + a.h / 2)) < r) mode = 'w-left';
      if (mode) {
        resizeArea = a;
        resizeAreaMode = mode;
        resizeAreaStart = { x: a.x, y: a.y, w: a.w, h: a.h, wx: w.x, wy: w.y };
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

    switch (state.tool) {
      case 'hand':
        panLast = { x: e.clientX, y: e.clientY };
        return;
      case 'pen':
      case 'fineliner':
      case 'marker': {
        strokeStart = performance.now() / 1000;
        ema = null;
        smooth(w);
        // drawing into a PLAYING area records a timed stroke on the loop clock
        const playingArea =
          state.activeAreaId && state.playingAreas
            ? store.doc.areas.find((a) => a.id === state.activeAreaId)
            : undefined;
        let anim: Partial<Stroke> = {
          frame: state.activeFrameId ?? undefined,
          alayer: state.activeLayerId ?? undefined,
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
            alayer: state.activeLayerId ?? undefined,
            animStart: tick,
            animLife: state.liveInkLife,
            animTaper: state.liveInkTaper,
          };
        }
        state.live = {
          id: uid('st'), kind: 'stroke', tool: state.tool,
          color: state.color,
          baseWidth: state.baseWidth / (state.tool === 'fineliner' ? 1.4 : 1),
          opacity: state.tool === 'marker' ? 0.45 : 1,
          layer: state.paintBehind ? 'back' : 'front',
          ...anim,
          points: [{ x: w.x, y: w.y, p: pressureOf(e), t: 0 }],
          startTime: Date.now() / 1000,
        };
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
        } else if (state.tool === 'cursor') {
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
        const cw = smooth(toWorld(ce));
        state.live.points.push({
          x: cw.x, y: cw.y, p: pressureOf(ce as PointerEvent),
          t: performance.now() / 1000 - strokeStart,
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
      invalidate();
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
      dragPage = null;
      const tapThreshold = 3 / camera.zoom;
      if (Math.abs(dx) < tapThreshold && Math.abs(dy) < tapThreshold && e) {
        // A tap, not a drag: open the page menu
        p.x = dragPageStart.x; p.y = dragPageStart.y;
        state.onPageMenu(p, e.clientX, e.clientY);
        invalidate();
        return;
      }
      // revert live mutation, then commit as a single undoable op
      p.x = dragPageStart.x; p.y = dragPageStart.y;
      store.movePage(p.id, dx, dy);
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
      if (s.points.length === 1) {
        const p0 = s.points[0];
        s.points.push({ ...p0, x: p0.x + 0.15, t: 0.01 }); // dot
      }
      store.addElement(s);
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
      if (resizeAreaMode === 'move') {
        const dx = a.x - st.x, dy = a.y - st.y;
        a.x = st.x; a.y = st.y;
        store.moveArea(a.id, dx, dy);
      } else {
        const after = { x: a.x, y: a.y, w: a.w, h: a.h };
        a.x = st.x; a.y = st.y; a.w = st.w; a.h = st.h;
        store.resizeArea(a.id, { x: st.x, y: st.y, w: st.w, h: st.h }, after);
      }
      return;
    }
    if (resizeText) {
      const el = resizeText;
      resizeText = null;
      const after = { x: el.x, w: el.w, h: el.h, fontSize: el.fontSize };
      // revert live mutation, commit as one undoable op
      el.x = resizeStart.x; el.w = resizeStart.w; el.h = resizeStart.h; el.fontSize = resizeStart.fontSize;
      store.resizeText(el.id, { x: resizeStart.x, w: resizeStart.w, h: resizeStart.h, fontSize: resizeStart.fontSize }, after);
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
      if (r.w < 12 || r.h < 12) {
        // a tap: give a sensible default box at the tap point
        r = { x: textDragStart.x, y: textDragStart.y, w: 220, h: 60 };
      }
      state.onTextEdit(null, r);
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
          layer: state.paintBehind ? 'back' : 'front',
          frame: state.activeFrameId ?? undefined,
          alayer: state.activeLayerId ?? undefined,
          points: lasso.map((p) => ({ x: p.x, y: p.y })),
        };
        store.addElement(fill);
      }
      invalidate();
    }
  }

  let dropCache: (id: string) => void = () => {};
  const api = { setDropCache(fn: (id: string) => void) { dropCache = fn; } };

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    if (e.pointerType === 'pen' && !state.penDetected) {
      state.penDetected = true;
      state.fingerDraws = false;
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
        invalidate();
        return;
      }
      if (touches.size > 2) return;
      if (!isDrawPointer(e)) {
        panLast = { x: e.clientX, y: e.clientY };
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
        if (inHandle || inBox || inDel) {
          hover = el.id;
          if (inHandle) cursor = 'grab';
          if (inDel) cursor = 'pointer';
          const r = 12 / z;
          if (Math.hypot(w.x - (el.x + el.w), w.y - (el.y + el.h)) < r) cursor = 'nwse-resize';
          else if (Math.abs(w.y - (el.y + el.h)) < r && Math.abs(w.x - (el.x + el.w / 2)) < r) cursor = 'ns-resize';
          else if (Math.abs(w.y - (el.y + el.h / 2)) < r &&
            (Math.abs(w.x - el.x) < r || Math.abs(w.x - (el.x + el.w)) < r)) cursor = 'ew-resize';
          break;
        }
      }
      // area handles hover
      let hoverArea: string | null = null;
      if (!cursor) {
        for (const a of [...store.doc.areas].reverse()) {
          const r = 12 / z;
          const mh = moveHandleRect(a.x, a.y, z);
          const nearLabel = w.x >= a.x && w.x <= a.x + 160 / z && w.y >= a.y - 26 / z && w.y <= a.y;
          const inMove = w.x >= mh.x && w.x <= mh.x + mh.s && w.y >= mh.y && w.y <= mh.y + mh.s;
          const inDel = inRect(w, deleteHandleRect(a.x, a.y, a.w, z));
          const nearEdge =
            (Math.abs(w.x - a.x) < r || Math.abs(w.x - (a.x + a.w)) < r) &&
              w.y > a.y - r && w.y < a.y + a.h + r ||
            (Math.abs(w.y - a.y) < r || Math.abs(w.y - (a.y + a.h)) < r) &&
              w.x > a.x - r && w.x < a.x + a.w + r;
          if (nearLabel || inMove || inDel || nearEdge || state.activeAreaId === a.id) {
            if (nearLabel || inMove || inDel || nearEdge) hoverArea = a.id;
            if (hoverArea || state.activeAreaId === a.id) {
              if (inMove) cursor = 'grab';
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
        if (pinchDist > 0) {
          camera.zoomAt(dist / pinchDist, mid.x - r.left, mid.y - r.top, vw(), vh());
          state.updateCursor();
        }
        pinchDist = dist;
        invalidate();
        return;
      }
    }
    if (drawingPointer === e.pointerId || panLast || dragPage || dragArea || dragSelection || resizeArea) {
      e.preventDefault();
      moveAction(e);
    }
  });

  const finish = (e: PointerEvent) => {
    touches.delete(e.pointerId);
    if (touches.size < 2) pinchDist = 0;
    if (drawingPointer === e.pointerId || dragPage || dragArea || dragSelection || panLast || resizeArea) {
      drawingPointer = null;
      endAction(e);
    }
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);

  // Double-click / double-tap a textbox in cursor modes (select/hand) jumps into editing
  const CURSOR_TOOLS: Tool[] = ['lasso-select', 'hand', 'text'];
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
    const zooming = e.ctrlKey || e.metaKey;
    if (e.target !== canvas && !zooming) return;
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    if (zooming) {
      camera.zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top, vw(), vh());
      state.updateCursor();
    } else {
      camera.panScreen(-e.deltaX, -e.deltaY);
    }
    invalidate();
  }, { passive: false });

  // Safari page pinch-zoom (gesture events) — block it everywhere; canvas pinch
  // is handled through pointer events.
  for (const t of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(t, (e) => e.preventDefault());
  }

  window.addEventListener('keydown', (e) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement).isContentEditable) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selection.size) {
      e.preventDefault();
      const els = store.doc.elements.filter((el) => state.selection.has(el.id));
      state.selection.clear();
      store.deleteElements(els);
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === 'z') {
      e.preventDefault();
      e.shiftKey ? store.redo() : store.undo();
      return;
    }
    if (mod) return;
    const map: Record<string, Tool> = {
      p: 'pen', f: 'fineliner', m: 'marker', e: 'eraser',
      v: 'cursor', s: 'lasso-select', g: 'lasso-fill', t: 'text', a: 'anim', h: 'hand',
    };
    const tool = map[e.key.toLowerCase()];
    if (tool) {
      state.tool = tool;
      state.onToolChange();
    }
  });

  return api;
}

function pressureOf(e: PointerEvent): number {
  if (e.pointerType !== 'pen') return 0.5;
  // 0 or exactly 0.5 usually means "not reported"
  return e.pressure > 0 ? e.pressure : 0.5;
}
