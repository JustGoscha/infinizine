// Input state: the current tool and its remembered styles, finger/pen modes,
// selection, hover and the hooks the UI plugs into. Preferences live in
// localStorage under the infinizine-* keys.

import { baseZoom } from './camera';
import { Stroke, Page, TextBox, Element, AnimArea, FillBlend } from './types';
import { migratePatternId } from './patterns';

export const PEN_KEY = 'infinizine-pen-seen';
const TOOL_MEM_KEY = 'infinizine-tool-memory';
// tools that keep their own colour / size / pattern between switches (the eraser keeps a size)
const REMEMBER_TOOLS = new Set(['pen', 'pencil', 'sketch', 'fineliner', 'marker', 'lasso-fill', 'lasso-blob', 'text', 'eraser']);
const BRUSH_TOOLS = new Set(['pen', 'pencil', 'sketch', 'fineliner', 'marker']);
const ERASER_DEFAULT_WIDTH = 1.2; // world units: a small nib, like the S brush
export const FINGER_KEY = 'infinizine-finger-mode';
export function readPref(k: string): string | null {
  try { return localStorage.getItem(k); } catch { return null; }
}
export function writePref(k: string, v: string) {
  try { localStorage.setItem(k, v); } catch { /* ignore */ }
}

export type Tool = 'pen' | 'pencil' | 'sketch' | 'fineliner' | 'marker' | 'eraser' | 'cursor' | 'lasso-select' | 'lasso-fill' | 'lasso-blob' | 'text' | 'anim' | 'hand';
/** the two lasso fills: hard cut closes with a straight edge, blob rounds the closing off */
export const FILL_TOOLS = new Set<Tool>(['lasso-fill', 'lasso-blob']);

/** While an anim area is selected, only the active frame's elements (and the
 * area's timed live-ink strokes) are editable; otherwise only untagged ones. */
export function frameEditable(el: Element, state: InputState): boolean {
  const area = el.kind === 'stroke' ? el.area : undefined;
  if (state.activeAreaId) return el.frame === state.activeFrameId || area === state.activeAreaId;
  return !el.frame && !area;
}

export class InputState {
  private _tool: Tool = (() => {
    const t = readPref('infinizine-last-tool');
    return t && REMEMBER_TOOLS.has(t) && t !== 'eraser' ? (t as Tool) : 'pen'; // drawing tools only; never boot into eraser/anim
  })();
  /** per-tool colour + size + pattern memory: switching tools brings back what you last used with each
   * (`pattern` undefined = a memory from before patterns were kept: the current pattern stays) */
  private toolMem: Partial<Record<Tool, { color: string; baseWidth: number; behind?: boolean; pattern?: string | null }>> = (() => {
    try { return JSON.parse(readPref(TOOL_MEM_KEY) ?? '{}'); } catch { return {}; }
  })();
  get tool(): Tool { return this._tool; }
  set tool(t: Tool) {
    if (t === this._tool) return;
    this.rememberTool();
    this._tool = t;
    const m = this.toolMem[t];
    if (t === 'eraser') {
      // the eraser only keeps a size; colour and pattern stay with the ink tools
      this.baseWidth = m?.baseWidth ?? ERASER_DEFAULT_WIDTH;
      return;
    }
    if (m) {
      this.color = m.color;
      this.baseWidth = m.baseWidth;
      if (m.pattern !== undefined) this.fillPattern = m.pattern;
    }
    // paint-behind is remembered per tool too; the marker highlights behind ink by default
    if (REMEMBER_TOOLS.has(t)) { this.paintBehind = m?.behind ?? t === 'marker'; writePref('infinizine-last-tool', t); }
  }
  /** store the current colour/size/pattern under the current tool (called on switch and on edits) */
  rememberTool() {
    if (!REMEMBER_TOOLS.has(this._tool)) return;
    const prev = this.toolMem[this._tool];
    this.toolMem[this._tool] = this._tool === 'eraser'
      ? { color: prev?.color ?? this.color, baseWidth: this.baseWidth }
      : { color: this.color, baseWidth: this.baseWidth, behind: this.paintBehind, pattern: this.fillPattern };
    writePref(TOOL_MEM_KEY, JSON.stringify(this.toolMem));
  }
  /** what a tool would draw with right now: its remembered colour/size/pattern, or the current ones */
  toolStyle(t: Tool): { color: string; baseWidth: number; pattern: string | null } {
    if (t === this._tool) return { color: this.color, baseWidth: this.baseWidth, pattern: this.fillPattern };
    const m = this.toolMem[t];
    return { color: m?.color ?? this.color, baseWidth: m?.baseWidth ?? this.baseWidth, pattern: m?.pattern === undefined ? this.fillPattern : m.pattern };
  }
  /** eraser radius in world units at `zoom` (its size is the brush size; never thinner than ~1.5 screen px) */
  eraserRadius(zoom: number): number {
    const w = this.tool === 'eraser' ? this.baseWidth : this.toolMem.eraser?.baseWidth ?? ERASER_DEFAULT_WIDTH;
    return Math.max((this.adaptiveSize ? w * (baseZoom() / zoom) : w) / 2, 1.5 / zoom);
  }
  color = '#1a1a1a';
  /** fill tool: active pattern (screentone, dither, …) drawn in `color`; null = solid */
  fillPattern: string | null = (() => {
    let p = readPref('infinizine-fill-pattern3');
    if (p === null) {
      // pre-format-3 preference: five levels per family → the finer ramp
      const old = readPref('infinizine-fill-pattern');
      p = old ? migratePatternId(old) : '';
      writePref('infinizine-fill-pattern3', p);
    }
    return p && p.startsWith('pattern:') ? p : null;
  })();
  /** ink coverage for pattern fills (CMYK-style tint): 1 = solid ink, lower lets paper through so overlaps mix */
  inkDensity = (() => { const v = Number(readPref('infinizine-fill-opacity')); return v >= 0.3 && v <= 1 ? v : 1; })();
  /** pattern brush: with a pattern selected, the pens paint it — the stroke's outline
   * becomes a pattern fill (pixel patterns edge in whole grid cells; tones keep whole dots) */
  patternInk(): boolean { return !!this.fillPattern && BRUSH_TOOLS.has(this.tool); }
  /** tone angle for the stroke being drawn (chosen at pen-down so the preview matches the commit) */
  liveToneAngle = 0;
  /** every new tone fill gets its own random angle (off: all fills share angle 0) */
  toneRandom = readPref('infinizine-tone-random') !== '0';
  /** two-finger tap = undo, three = redo (off: fingers only pan/zoom) */
  fingerUndo = readPref('infinizine-finger-undo') !== '0';
  /** how pattern fills composite with what's below */
  fillBlend: FillBlend = (() => {
    const v = readPref('infinizine-fill-blend');
    return v && ['multiply', 'source-over', 'darken', 'screen', 'difference'].includes(v) ? (v as FillBlend) : 'multiply';
  })();
  baseWidth = 1.6; // world units at 100% (2 per mm)
  adaptiveSize = readPref('infinizine-adaptive-size') === '1'; // keep on-screen size across zoom
  /** brush width in world units for a stroke started at this zoom */
  effectiveWidth(zoom: number): number {
    return this.adaptiveSize ? this.baseWidth * (baseZoom() / zoom) : this.baseWidth;
  }
  paintBehind: boolean = this.toolMem[this._tool]?.behind ?? this._tool === 'marker'; // 'back' layer toggle for new strokes/fills
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
  /** textboxes whose dice is rolling → pip face shown (1–6), flipped while the new typeface loads */
  rolling = new Map<string, number>();
  /** text style clipboard handles on the rect (wired by the UI) */
  onCopyStyle: (el: TextBox, clientX: number, clientY: number) => void = () => {};
  onPasteStyle: (el: TextBox, clientX: number, clientY: number) => void = () => {};
  stylePasteFor: (el: TextBox) => boolean = () => false;
  hoverArea: string | null = null; // anim area under the mouse (shows its handles)
  hoverPage: string | null = null; // page under the mouse (shows its grabbers)
  hoverImage: string | null = null; // image under the mouse (shows its handles)
  selectedPageId: string | null = null; // page picked by a tap on its label: shows its grabbers until a tap elsewhere
  /** where the eraser is on the canvas (world), for the size ring drawn under a pen or finger */
  eraserAt: { x: number; y: number } | null = null;
  lastDrawTool: Tool = this._tool; // remembered so e.g. area creation can bounce back to it
  onAnimClose: () => void = () => {};
  toolCursor = 'crosshair'; // css cursor for the current tool (set by the UI)
  updateCursor: () => void = () => {};
  marquee: { x: number; y: number; w: number; h: number } | null = null; // cursor-tool rect select
  // animation mode
  areaRect: { x: number; y: number; w: number; h: number } | null = null; // area being drawn
  activeAreaId: string | null = null; // timeline open for this area
  activeFrameId: string | null = null;
  /** position in the edited area, in ticks from its start (null = the active frame's start).
   * Flipping moves this across the whole animation; the active frame is whichever frame of
   * the active layer covers it, so a held frame can be viewed at each tick it spans. */
  editTick: number | null = null;
  activeLayerId: string | null = null;
  onionSkin = true; // on by default; 3 frames back (red) and 3 forward (green)
  liveInkLife = 6; // ticks a stroke drawn during playback stays visible
  liveInkTaper = true; // its tail eats away over its lifetime
  showLiveInk = false; // show live-ink strokes while editing (they always show in playback)
  blinkLayerId: string | null = null; // layer briefly opacity-blinking (selection feedback)
  blinkStart = 0;
  playingAreas = false;
  onionMuted = false; // onion skin hidden while flipping through frames with the jog
  recording = false; // record button: plays the area and captures live lines as you draw
  /** event timestamp of the newest live-stroke sample (input→paint latency readout) */
  lastSampleAt = 0;
  /** performance readout in the corner (settings) */
  perfHud = readPref('infinizine-perf') === '1';
  perfLine = ''; // the renderer's latest numbers
  playEpoch = 0; // performance.now()/1000 when playback started
  onAnimOpen: (area: AnimArea) => void = () => {};
  onTextEdit: (
    target: TextBox | null,
    rect: { x: number; y: number; w: number; h: number },
    auto?: boolean, // tap-created: width follows the content
  ) => void = () => {};
}
