// Pointer handling: pen draws, fingers pan/pinch-zoom (Notes-style),
// mouse works for desktop/browser verification. Coalesced events used
// for high-frequency stroke sampling.
//
// Around this file: state.ts (InputState, tool memory, prefs), handles.ts
// (grabber rects), hover.ts (mouse hover), clipboard.ts (copy/paste),
// dice.ts (typeface roll). attachInput wires the canvas events; startAction /
// moveAction / endAction are the per-gesture state machine.

import { Camera, baseZoom } from './camera';
import { Store } from './store';
import { AnimArea, Stroke, FillShape, Element, ImageBox, Page, TextBox, uid } from './types';
import { hitElement, elementsInLasso, denoise, denoiseClosed, closeBlob, translateElement } from './geometry';
import { pressure } from './pressure';
import { strokeOutline } from './outline';
import { animClock } from './clock';
import { isPixelPattern } from './patterns';
import { layoutText, layoutHeight, boxFamily } from './text';
import { InputState, Tool, FILL_TOOLS, frameEditable, writePref, PEN_KEY, FINGER_KEY } from './state';
import { inRect, moveHandleRect, moveAllHandleRect, eyeHandleRect, deleteHandleRect, copyHandleRect, diceHandleRect, copyStyleHandleRect, pasteStyleHandleRect, textHandleRect } from './handles';
import { createClipboard } from './clipboard';
import { rollTextFace } from './dice';
import { hoverAt } from './hover';



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




interface TouchInfo { x: number; y: number; t: number; big: boolean }

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
  // palm rejection for the finger gestures: no gesture while the pen is down or
  // just lifted, when a contact is palm-sized, or when the two fingers didn't
  // arrive together (a resting palm + a finger is not a two-finger tap)
  const PEN_QUIET_MS = 700;
  const TOGETHER_MS = 300; // two fingers of one hand land within this
  const PALM_PX = 70; // finger contacts report ~20–50 px on iPad; a palm is far wider
  let lastPenAt = -1e9;
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
  let resizeStart = { x: 0, w: 0, h: 0, fontSize: 0, wx: 0, wy: 0, auto: undefined as boolean | undefined };
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
  let dragCopy: string[] | null = null; // ids of the originals when the drag moves fresh duplicates
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

  /** an area's dashed border (a hand's width), for tap-selecting it with a finger or pen */
  function areaBorderAt(w: { x: number; y: number }): AnimArea | null {
    const r = 10 / camera.zoom;
    for (const a of [...store.doc.areas].reverse()) {
      const onX = (Math.abs(w.x - a.x) < r || Math.abs(w.x - (a.x + a.w)) < r) && w.y > a.y - r && w.y < a.y + a.h + r;
      const onY = (Math.abs(w.y - a.y) < r || Math.abs(w.y - (a.y + a.h)) < r) && w.x > a.x - r && w.x < a.x + a.w + r;
      if (onX || onY) return a;
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

  /** Chrome on the canvas: grabbers, resize handles, bins, labels of boxes / areas / pages.
   * Any pointer may work these (a finger in pan mode included). Returns true when the
   * press landed on one and an action (drag or tap) started. */
  function startHandleAction(e: PointerEvent, w: { x: number; y: number }): boolean {
    // Image handles (any tool, on hovered/selected image)
    for (const el of store.doc.elements) {
      if (el.kind !== 'image') continue;
      if (state.hoverImage !== el.id && !state.selection.has(el.id)) continue;
      const z = camera.zoom;
      if (inRect(w, deleteHandleRect(el.x, el.y, el.w, z))) {
        state.selection.delete(el.id);
        if (state.hoverImage === el.id) state.hoverImage = null;
        store.deleteElements([el]);
        return true;
      }
      if (inRect(w, moveHandleRect(el.x, el.y, z)) || inRect(w, copyHandleRect(el.x, el.y, z))) {
        state.selection = new Set([el.id]);
        if (e.altKey || inRect(w, copyHandleRect(el.x, el.y, z))) duplicateSelection();
        dragSelection = true;
        dragStartWorld = w;
        dragTotal = { x: 0, y: 0 };
        invalidate();
        return true;
      }
      const r = 12 / z;
      const grabImg = (mode: typeof imgMode) => {
        state.selection = new Set([el.id]);
        resizeImg = el;
        imgMode = mode;
        imgStart = { x: el.x, y: el.y, w: el.w, h: el.h, wx: w.x, wy: w.y };
        invalidate();
      };
      if (Math.hypot(w.x - (el.x + el.w), w.y - (el.y + el.h)) < r) { grabImg('corner'); return true; }
      if (Math.abs(w.y - (el.y + el.h)) < r && Math.abs(w.x - (el.x + el.w / 2)) < r) { grabImg('h-bottom'); return true; }
      if (Math.abs(w.x - (el.x + el.w)) < r && Math.abs(w.y - (el.y + el.h / 2)) < r) { grabImg('w-right'); return true; }
      if (Math.abs(w.x - el.x) < r && Math.abs(w.y - (el.y + el.h / 2)) < r) { grabImg('w-left'); return true; }
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
        return true;
      }
      if (inRect(w, diceHandleRect(el.x, el.y, el.w, z))) {
        state.selection = new Set([el.id]);
        void rollTextFace(store, state, invalidate, el);
        return true;
      }
      if (inRect(w, copyStyleHandleRect(el.x, el.y, el.w, z))) {
        state.selection = new Set([el.id]);
        state.onCopyStyle(el, e.clientX, e.clientY);
        invalidate();
        return true;
      }
      if (state.stylePasteFor(el) && inRect(w, pasteStyleHandleRect(el.x, el.y, el.w, z))) {
        state.selection = new Set([el.id]);
        state.onPasteStyle(el, e.clientX, e.clientY);
        return true;
      }
      const hr = textHandleRect(el, z);
      if (inRect(w, hr) || inRect(w, copyHandleRect(el.x, el.y, z))) {
        state.selection = new Set([el.id]);
        if (e.altKey || inRect(w, copyHandleRect(el.x, el.y, z))) duplicateSelection();
        dragSelection = true;
        dragStartWorld = w;
        dragTotal = { x: 0, y: 0 };
        invalidate();
        return true;
      }
      const r = 12 / z;
      const grab = (mode: typeof resizeMode) => {
        state.selection = new Set([el.id]);
        resizeText = el;
        resizeMode = mode;
        resizeStart = { x: el.x, w: el.w, h: el.h, fontSize: el.fontSize, wx: w.x, wy: w.y, auto: el.auto };
        el.auto = false; // sizing by hand: the box stops hugging its content (live; committed on release)
        invalidate();
      };
      if (Math.hypot(w.x - (el.x + el.w), w.y - (el.y + el.h)) < r) { grab('scale'); return true; }
      if (Math.abs(w.y - (el.y + el.h)) < r && Math.abs(w.x - (el.x + el.w / 2)) < r) { grab('height'); return true; }
      if (Math.abs(w.x - (el.x + el.w)) < r && Math.abs(w.y - (el.y + el.h / 2)) < r) { grab('width'); return true; }
      if (Math.abs(w.x - el.x) < r && Math.abs(w.y - (el.y + el.h / 2)) < r) { grab('width-left'); return true; }
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
        return true;
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
        return true;
      }
    }

    // Page grabbers (hovered or selected page): outlined = frame only, filled = frame with content
    for (const p of store.doc.pages) {
      if (state.hoverPage !== p.id && state.selectedPageId !== p.id) continue;
      const z = camera.zoom;
      const mh = moveHandleRect(p.x, p.y, z);
      const mha = moveAllHandleRect(p.x, p.y, z);
      if (inRect(w, eyeHandleRect(p.x, p.y, z))) {
        state.onPagePreview(p);
        return true;
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
        return true;
      }
    }

    // Animation area label or border: tap opens its timeline, drag moves the area frame
    const areaHit = areaLabelAt(w) ?? areaBorderAt(w);
    if (areaHit) {
      dragArea = areaHit;
      dragAreaStart = { x: areaHit.x, y: areaHit.y };
      dragStartWorld = w;
      return true;
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
      return true;
    }

    return false;
  }

  function startAction(e: PointerEvent, toolOverride?: Tool) {
    const activeTool = toolOverride ?? state.tool;
    dragCopy = null;
    // Presentation mode: any drag pans, no drawing/tools
    if (state.presenting) {
      panLast = { x: e.clientX, y: e.clientY };
      return;
    }
    const w = toWorld(e);

    if (startHandleAction(e, w)) return;
    // a press on the canvas itself drops the page selection
    if (state.selectedPageId) { state.selectedPageId = null; invalidate(); }

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
          let tick = Math.floor((animClock.now() - state.playEpoch) * playingArea.fps);
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
        state.liveToneAngle = state.fillPattern && !isPixelPattern(state.fillPattern) && state.toneRandom ? Math.floor(Math.random() * 36) * 5 : 0;
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
          if (!e.altKey) return; // alt: fall through and drag a copy right away
        }
        // Drag inside current selection moves it (alt-drag moves a duplicate); otherwise start a new lasso/marquee.
        if (state.selection.size && hitsSelection(w)) {
          if (e.altKey) duplicateSelection();
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
      case 'lasso-blob':
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

  /** Clone the selected elements in place (same frame/layer) and select the clones, so a
   * drag that follows moves the copies and leaves the originals put. */
  function duplicateSelection() {
    const els = store.doc.elements
      .filter((el) => state.selection.has(el.id))
      .map((el) => Object.assign(structuredClone(el) as Element, { id: uid('cp') }));
    if (!els.length) return;
    dragCopy = [...state.selection];
    store.addElements(els); // provisional: the drag's pointerup re-commits copy + move as one step
    state.selection = new Set(els.map((el) => el.id));
    if (state.hoverText && !state.selection.has(state.hoverText)) state.hoverText = null;
    if (state.hoverImage && !state.selection.has(state.hoverImage)) state.hoverImage = null;
  }

  function hitsSelection(w: { x: number; y: number }): boolean {
    const r = 10 / camera.zoom;
    return store.doc.elements.some(
      (el) => state.selection.has(el.id) && hitElement(el, w.x, w.y, r),
    );
  }

  function eraseAt(w: { x: number; y: number }) {
    const r = state.eraserRadius(camera.zoom);
    state.eraserAt = w;
    invalidate();
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
      state.lastSampleAt = e.timeStamp || performance.now(); // for the input→paint readout
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
      const contentH = layoutHeight(layoutText(el.text, boxFamily(el), el.fontSize, el.w));
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
        // A tap, not a drag: select the page (its grabbers show) and open the page menu
        p.x = dragPageStart.x; p.y = dragPageStart.y;
        state.selectedPageId = p.id;
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
      if (dragCopy) {
        // copy + move is one undo step: take back the provisional in-place copies and
        // add them where they were dropped (a copy that didn't move is discarded)
        const originals = dragCopy;
        dragCopy = null;
        const clones = store.doc.elements.filter((el) => state.selection.has(el.id));
        store.undo();
        if (Math.hypot(dragTotal.x, dragTotal.y) > 0.5) {
          for (const c of clones) translateElement(c, dragTotal.x, dragTotal.y);
          store.addElements(clones);
        } else {
          state.selection = new Set(originals);
        }
      } else {
        store.moveElements(ids, dragTotal.x, dragTotal.y);
      }
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
      } else if (state.patternInk()) {
        // pattern brush: commit the stroke's outline as a fill in the active pattern
        const outline = strokeOutline(s, 1).map(([x, y]) => ({ x, y }));
        if (outline.length >= 3) {
          const fill: FillShape = {
            id: uid('fl'), kind: 'fill', color: s.color, opacity: s.opacity,
            pattern: state.fillPattern!, ink: state.inkDensity,
            patternAngle: state.liveToneAngle || undefined,
            blend: state.fillBlend !== 'multiply' ? state.fillBlend : undefined,
            layer: s.layer, frame: s.frame, alayer: s.alayer, points: outline,
          };
          store.addElement(fill);
        }
      } else {
        store.addElement(s);
      }
      return;
    }
    if (state.eraserAt && e?.pointerType !== 'mouse') { state.eraserAt = null; invalidate(); }
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
      el.x = resizeStart.x; el.w = resizeStart.w; el.h = resizeStart.h; el.fontSize = resizeStart.fontSize; el.auto = resizeStart.auto;
      store.resizeText(el.id, { x: resizeStart.x, w: resizeStart.w, h: resizeStart.h, fontSize: resizeStart.fontSize, auto: resizeStart.auto }, after);
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
      // a tap: a box that grows with what you type, never wrapping; a drawn rectangle
      // wraps at its width but likewise hugs the text (until resized by hand)
      const tap = r.w < 12 || r.h < 12;
      if (tap) r = { x: textDragStart.x, y: textDragStart.y, w: 40, h: 30 };
      state.onTextEdit(null, r, tap);
      invalidate();
      return;
    }
    if (state.lasso) {
      const lasso = state.lasso;
      state.lasso = null;
      if (state.tool === 'lasso-select') {
        state.selection = new Set(elementsInLasso(store.doc.elements, lasso).map((e) => e.id));
      } else if (FILL_TOOLS.has(state.tool) && lasso.length > 2) {
        // blob: the loop closes along a curve that carries the pen's motion on, not a straight cut
        const blob = state.tool === 'lasso-blob';
        const loop = blob ? closeBlob(lasso) : lasso;
        const fill: FillShape = {
          id: uid('fl'), kind: 'fill', color: state.color, opacity: 1,
          pattern: state.fillPattern ?? undefined,
          ink: state.fillPattern ? state.inkDensity : undefined,
          blend: state.fillPattern && state.fillBlend !== 'multiply' ? state.fillBlend : undefined,
          // every tone fill gets its own angle so neighbouring fills don't line up like wallpaper
          patternAngle: state.fillPattern && !isPixelPattern(state.fillPattern) && state.toneRandom ? Math.floor(Math.random() * 36) * 5 : undefined,
          layer: state.paintBehind ? 'back' : 'front',
          frame: state.activeFrameId ?? undefined,
          alayer: state.activeLayerId ?? undefined,
          // same screen-space smoothing as the brushes (3px at drawing zoom; the blob rounds off more)
          points: denoiseClosed(loop.map((p) => ({ x: p.x, y: p.y })), (blob ? 5 : 3) / camera.zoom),
        };
        store.addElement(fill);
      }
      invalidate();
    }
  }




  let dropCache: (id: string) => void = () => {};
  // live mutations of text/image boxes (resize previews) aren't store changes:
  // the renderer's static layer must be told to rebuild so the preview shows
  const invalidateStatic = () => { dropCache('*'); invalidate(); };
  const clip = createClipboard(store, state, camera, invalidate);
  const api = {
    setDropCache(fn: (id: string) => void) { dropCache = fn; },
    copySelection: clip.copySelection,
    cutSelection: clip.cutSelection,
    pasteSmart: clip.pasteSmart,
  };

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    if (e.pointerType === 'pen') lastPenAt = performance.now();
    if (e.pointerType === 'pen' && !state.penDetected) {
      state.penDetected = true;
      state.fingerMode = 'pan';
      state.fingerDraws = false;
      writePref(PEN_KEY, '1');
      writePref(FINGER_KEY, 'pan');
      state.onToolChange();
    }
    if (e.pointerType === 'touch') {
      const now = performance.now();
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY, t: now, big: e.width > PALM_PX || e.height > PALM_PX });
      if (touches.size === 2) {
        // Second finger: cancel any in-progress touch action, start pinch
        if (state.live && drawingPointer !== null) state.live = null;
        state.lasso = null;
        drawingPointer = null;
        panLast = null;
        panStart = null; // a two-finger gesture is never a one-finger tap (no eraser flip, no select)
        fingerTap = { t: 0, x: 0, y: 0 };
        const [a, b] = [...touches.values()];
        pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
        pinchMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const palm = a.big || b.big || now - a.t > TOGETHER_MS || now - lastPenAt < PEN_QUIET_MS;
        gesture = state.fingerUndo && !palm ? { fingers: 2, t: now, moved: 0, mid: { ...pinchMid } } : null;
        scrub = null;
        if (gesture) armScrub();
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
        // a finger works the canvas chrome too: grabbers, area / page labels and borders
        if (state.fingerMode === 'pan' && !state.presenting && touches.size === 1 && startHandleAction(e, toWorld(e))) {
          drawingPointer = e.pointerId;
          return;
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
    // hover tracking for box/area/page handles + cursor feedback (mouse only, not while dragging)
    if (e.pointerType === 'mouse' && e.buttons === 0 && !state.presenting) {
      const h = hoverAt(toWorld(e), camera.zoom, store, state);
      let changed = false;
      if (h.image !== state.hoverImage) { state.hoverImage = h.image; changed = true; }
      if (h.area !== state.hoverArea) { state.hoverArea = h.area; changed = true; }
      if (h.page !== state.hoverPage) { state.hoverPage = h.page; changed = true; }
      if (h.text !== state.hoverText) { state.hoverText = h.text; changed = true; }
      canvas.style.cursor = h.cursor || state.toolCursor;
      if (changed) invalidate();
    }
    if (e.pointerType === 'mouse' && e.buttons !== 0 && (dragSelection || dragPage)) {
      canvas.style.cursor = 'grabbing';
    }
    if (e.pointerType === 'pen') lastPenAt = performance.now();
    // no cursor on glass: the eraser's size shows as a ring under a hovering or erasing pen
    if (e.pointerType !== 'mouse' && state.tool === 'eraser' && !state.presenting && drawingPointer === null) {
      state.eraserAt = toWorld(e);
      invalidate();
    }
    if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
      const ti = touches.get(e.pointerId)!;
      ti.x = e.clientX; ti.y = e.clientY;
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
    if (e.pointerType === 'pen') lastPenAt = performance.now();
    touches.delete(e.pointerId);
    if (touches.size < 2) { pinchDist = 0; pinchMid = null; }
    if (e.pointerType === 'touch' && gesture && touches.size === 0) {
      window.clearTimeout(scrubTimer);
      const g = gesture;
      gesture = null;
      const wasScrub = !!scrub;
      scrub = null;
      const penMeanwhile = lastPenAt > g.t; // the pen touched down during the "tap": it was a palm
      if (!wasScrub && !penMeanwhile && performance.now() - g.t < TAP_MAX_MS && g.moved < TAP_MAX_PX && !state.presenting) {
        if (g.fingers === 2) { store.undo(); toast('Undo'); }
        else if (g.fingers >= 3) { store.redo(); toast('Redo'); }
        invalidate();
      }
    }
    // a motionless one-finger tap in pan mode still selects what's under it;
    // two such taps in a row (pencil users) flip between the eraser and the last ink tool
    if (e.pointerType === 'touch' && panLast && panStart && !state.presenting) {
      const moved = Math.hypot(e.clientX - panStart.x, e.clientY - panStart.y);
      const now = performance.now();
      if (moved < 10 && now - panStart.t < 300) {
        const w = toWorld(e);
        const editable = store.doc.elements.filter((el) => frameEditable(el, state));
        const hit = [...editable].reverse().find((el) => hitElement(el, w.x, w.y, 8 / camera.zoom));
        state.selection = hit ? new Set([hit.id]) : new Set();
        if (state.selectedPageId) state.selectedPageId = null;
        if (state.penDetected && now - fingerTap.t < 350 && Math.hypot(e.clientX - fingerTap.x, e.clientY - fingerTap.y) < 30) {
          state.tool = state.tool === 'eraser' ? state.lastDrawTool : 'eraser';
          state.onToolChange();
          toast(state.tool === 'eraser' ? 'Eraser' : 'Ink');
          fingerTap = { t: 0, x: 0, y: 0 };
        } else {
          fingerTap = { t: now, x: e.clientX, y: e.clientY };
        }
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
    // the text editor and its bars float over the canvas: scrolling there pans too (the
    // overlay tracks the camera), so editing never traps the trackpad
    const overEditor = !!(e.target as HTMLElement).closest?.('.text-editor, .font-bar, .weight-pop');
    if (e.target !== canvas && !zooming && !overEditor) return;
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
      if (clip.copySelection()) e.preventDefault();
      return;
    }
    if (mod && e.key === 'x') {
      e.preventDefault();
      clip.cutSelection();
      return;
    }
    if (mod && e.key === 'v') {
      e.preventDefault();
      void clip.pasteSmart();
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
      b: 'pencil', v: 'cursor', s: 'lasso-select', g: 'lasso-fill', o: 'lasso-blob', t: 'text', a: 'anim', h: 'hand',
    };
    const tool = map[e.key.toLowerCase()];
    if (tool) {
      state.tool = tool;
      state.onToolChange();
    }
  });

  return api;
}

