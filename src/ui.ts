// Toolbar, palette popover, page menu. Plain DOM, stationery-shop styling in style.css.

import { InputState, Tool, CLIP_PENDING_KEY, FINGER_KEY, writePref, attachInput, setModalOpen } from './input';
import { Renderer } from './render';
import { baseZoom as baseZoomFn } from './camera';
import { Store } from './store';
import { Camera, baseZoom, pxPerMm, setPxPerMm } from './camera';
import { PALETTES, getPalette, shades } from './palettes';
import { UNITS_PER_MM, uid } from './types';
import { layoutText, layoutHeight, FONTS } from './text';
import { pressure, savePressure, resetPressure, loadPressure, exportPressure, importPressure, easeP, curveAt, type Curve, type CurveNode } from './geometry';
import { markdownToHtml, htmlToMarkdown, autoTransform, caretToEnd } from './richedit';

function toast(msg: string) {
  window.dispatchEvent(new CustomEvent('izine-toast', { detail: msg }));
}

const svg = (inner: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

const ICON_PATHS: Record<string, string> = {
  // Phosphor icon set (regular weight): one consistent family for the draw tools
  pen: '<g transform="scale(0.09375)" fill="currentColor" stroke="none"><path d="M248,92.68a15.86,15.86,0,0,0-4.69-11.31L174.63,12.68a16,16,0,0,0-22.63,0L123.57,41.11l-58,21.77A16.06,16.06,0,0,0,55.35,75.23L32.11,214.68A8,8,0,0,0,40,224a8.4,8.4,0,0,0,1.32-.11l139.44-23.24a16,16,0,0,0,12.35-10.17l21.77-58L243.31,104A15.87,15.87,0,0,0,248,92.68Zm-69.87,92.19L63.32,204l47.37-47.37a28,28,0,1,0-11.32-11.32L52,192.7,71.13,77.86,126,57.29,198.7,130ZM112,132a12,12,0,1,1,12,12A12,12,0,0,1,112,132Zm96-15.32L139.31,48l24-24L232,92.68Z"/></g>',
  pencil: '<g transform="scale(0.09375)" fill="currentColor" stroke="none"><path d="M227.31,73.37,182.63,28.68a16,16,0,0,0-22.63,0L36.69,152A15.86,15.86,0,0,0,32,163.31V208a16,16,0,0,0,16,16H92.69A15.86,15.86,0,0,0,104,219.31L227.31,96a16,16,0,0,0,0-22.63ZM51.31,160,136,75.31,152.69,92,68,176.68ZM48,179.31,76.69,208H48Zm48,25.38L79.31,188,164,103.31,180.69,120Zm96-96L147.31,64l24-24L216,84.68Z"/></g>',
  fineliner: '<g transform="scale(0.09375)" fill="currentColor" stroke="none"><path d="M227.32,73.37,182.63,28.69a16,16,0,0,0-22.63,0L36.69,152A15.86,15.86,0,0,0,32,163.31V208a16,16,0,0,0,16,16H92.69A15.86,15.86,0,0,0,104,219.31l83.67-83.66,3.48,13.9-36.8,36.79a8,8,0,0,0,11.31,11.32l40-40a8,8,0,0,0,2.11-7.6l-6.9-27.61L227.32,96A16,16,0,0,0,227.32,73.37ZM48,179.31,76.69,208H48Zm48,25.38L51.31,160,136,75.31,180.69,120Zm96-96L147.32,64l24-24L216,84.69Z"/></g>',
  marker: '<g transform="scale(0.09375)" fill="currentColor" stroke="none"><path d="M253.66,106.34a8,8,0,0,0-11.32,0L192,156.69,107.31,72l50.35-50.34a8,8,0,1,0-11.32-11.32L96,60.69A16,16,0,0,0,93.18,79.5L72,100.69a16,16,0,0,0,0,22.62L76.69,128,18.34,186.34a8,8,0,0,0,3.13,13.25l72,24A7.88,7.88,0,0,0,96,224a8,8,0,0,0,5.66-2.34L136,187.31l4.69,4.69a16,16,0,0,0,22.62,0l21.19-21.18A16,16,0,0,0,203.31,168l50.35-50.34A8,8,0,0,0,253.66,106.34ZM93.84,206.85l-55-18.35L88,139.31,124.69,176ZM152,180.69,83.31,112,104,91.31,172.69,160Z"/></g>',
  'lasso-fill': '<g transform="scale(0.09375)" fill="currentColor" stroke="none"><path d="M234.53,139.07a8,8,0,0,0,3.13-13.24L122.17,10.34a8,8,0,0,0-11.31,0L70.25,51,45.65,26.34A8,8,0,0,0,34.34,37.66l24.6,24.6L15,106.17a24,24,0,0,0,0,33.94L99.89,225a24,24,0,0,0,33.94,0l78.49-78.49Zm-32.19-5.24-79.83,79.83a8,8,0,0,1-11.31,0L26.34,128.8a8,8,0,0,1,0-11.31L70.25,73.57l29.12,29.12a28,28,0,1,0,11.31-11.32L81.57,62.26l35-34.95L217.19,128l-11.72,3.9A8.09,8.09,0,0,0,202.34,133.83Zm-86.83-26.31,0,0a13.26,13.26,0,1,1-.05.06S115.51,107.53,115.51,107.52Zm123.15,56a8,8,0,0,0-13.32,0C223.57,166.23,208,190.09,208,208a24,24,0,0,0,48,0C256,190.09,240.43,166.23,238.66,163.56ZM232,216a8,8,0,0,1-8-8c0-6.8,4-16.32,8-24.08,4,7.76,8,17.34,8,24.08A8,8,0,0,1,232,216Z"/></g>',
  eraser: '<path d="M9.5 18.5 L4.5 13.5 L13 5 L18.5 10.5 L10.5 18.5 Z"/><path d="M8 20 H20"/>',
  'lasso-select': '<ellipse cx="12" cy="10.5" rx="7.5" ry="5.5" stroke-dasharray="3.4 2.6"/><path d="M8.5 15.5 C6.5 17.5 10 19 8 21"/>',
  cursor: '<path d="M6.5 3.5 L18 13 L12.8 13.8 L15.6 19.6 L13 20.8 L10.3 14.9 L6.5 17.8 Z"/>',
  text: '<path d="M5 7 V4.5 H19 V7 M12 4.5 V19.5 M9 19.5 H15"/>',
  anim: '<rect x="3.5" y="6" width="17" height="12" rx="2"/><path d="M7.5 6v12 M16.5 6v12 M3.5 12h4 M16.5 12h4"/>',
  hand: '<path d="M12 3 V21 M3 12 H21"/><path d="M12 3 L9.6 5.4 M12 3 L14.4 5.4 M12 21 L9.6 18.6 M12 21 L14.4 18.6 M3 12 L5.4 9.6 M3 12 L5.4 14.4 M21 12 L18.6 9.6 M21 12 L18.6 14.4"/>',
};
const ICONS: Record<string, string> = Object.fromEntries(
  Object.entries(ICON_PATHS).map(([k, inner]) => [k, svg(inner)]),
);

/** Custom canvas cursors: brush tools get a circle at brush size; the rest get a
 * precise crosshair with the tool icon beside it. */
function cursorFor(tool: Tool, zoom: number, baseWidth: number): string {
  const enc = (v: string) => `url("data:image/svg+xml,${encodeURIComponent(v)}")`;
  if (tool === 'pen' || tool === 'pencil' || tool === 'fineliner' || tool === 'marker' || tool === 'eraser') {
    let d: number;
    if (tool === 'eraser') {
      const rWorld = 6 / Math.min(1, zoom) + 6;
      d = rWorld * 2 * zoom;
    } else {
      d = baseWidth * (tool === 'marker' ? 2.4 : 1) * zoom;
    }
    d = Math.max(4, Math.min(80, d));
    const s = Math.ceil(d + 6);
    const c = s / 2;
    const img = `<svg xmlns='http://www.w3.org/2000/svg' width='${s}' height='${s}'>` +
      `<circle cx='${c}' cy='${c}' r='${d / 2}' fill='none' stroke='#fff' stroke-width='2.6' opacity='0.85'/>` +
      `<circle cx='${c}' cy='${c}' r='${d / 2}' fill='none' stroke='#2A241A' stroke-width='1.2' opacity='0.9'/>` +
      `</svg>`;
    return `${enc(img)} ${c} ${c}, crosshair`;
  }
  if (tool === 'cursor') return 'default';
  if (tool === 'hand') return 'grab';
  // precise crosshair + tool icon beside it
  const inner = ICON_PATHS[tool] ?? '';
  const img = `<svg xmlns='http://www.w3.org/2000/svg' width='38' height='38'>` +
    `<path d='M8 1v14M1 8h14' stroke='#fff' stroke-width='3.4' stroke-linecap='round'/>` +
    `<path d='M8 1v14M1 8h14' stroke='#2A241A' stroke-width='1.4' stroke-linecap='round'/>` +
    `<g transform='translate(16,16) scale(0.9)' fill='none' stroke='#2A241A' stroke-width='1.9' stroke-linecap='round' stroke-linejoin='round'>${inner}</g>` +
    `</svg>`;
  return `${enc(img)} 8 8, crosshair`;
}

const TOOL_INFO: Record<Tool, { label: string; key: string }> = {
  pen: { label: 'Pen', key: 'P' },
  pencil: { label: 'Pencil', key: 'B' },
  sketch: { label: 'Sketch', key: 'K' },
  fineliner: { label: 'Fineliner', key: 'F' },
  marker: { label: 'Marker', key: 'M' },
  'lasso-fill': { label: 'Lasso fill', key: 'G' },
  eraser: { label: 'Eraser', key: 'E' },
  cursor: { label: 'Cursor', key: 'V' },
  'lasso-select': { label: 'Lasso select', key: 'S' },
  text: { label: 'Text', key: 'T' },
  anim: { label: 'Animation', key: 'A' },
  hand: { label: 'Move', key: 'H' },
};

// Tools are grouped: the toolbar shows one slot per group; tapping an active
// group expands a flyout with the group's tools.
const TOOL_GROUPS: { id: string; tools: Tool[] }[] = [
  { id: 'draw', tools: ['pen', 'pencil', 'fineliner', 'marker', 'lasso-fill'] },
  { id: 'eraser', tools: ['eraser'] },
  { id: 'select', tools: ['cursor', 'lasso-select', 'hand'] },
  { id: 'text', tools: ['text'] },
  { id: 'anim', tools: ['anim'] },
];

const SIZES = [
  { w: 0.8, label: 'XS' },
  { w: 1.2, label: 'S' },
  { w: 1.6, label: 'M' },
  { w: 2.4, label: 'L' },
  { w: 4, label: 'XL' },
];
const ADAPTIVE_KEY = 'infinizine-adaptive-size';

interface Fmt { label: string; w: number; h: number; screen?: boolean } // w/h in world units (2/mm); screen = fit to viewport on pick
const mm = (w: number, h: number) => ({ w: w * UNITS_PER_MM, h: h * UNITS_PER_MM });

const PRIMARY_FORMATS: Fmt[] = [
  { label: 'A4', ...mm(210, 297) },
  { label: 'A4 wide', ...mm(297, 210) },
  { label: 'A5', ...mm(148, 210) },
  { label: 'Square', ...mm(240, 240) },
];

const MORE_FORMATS: Fmt[] = [
  { label: 'A3', ...mm(297, 420) },
  { label: 'A6', ...mm(105, 148) },
  { label: 'B5', ...mm(176, 250) },
  { label: 'Letter', ...mm(216, 279) },
  { label: 'Legal', ...mm(216, 356) },
  { label: 'Tabloid', ...mm(279, 432) },
  { label: 'Half letter', ...mm(140, 216) },
  { label: 'US comic', ...mm(168, 260) },
  { label: 'Manga B6', ...mm(128, 182) },
  { label: 'Zine pocket', ...mm(110, 178) },
  { label: 'Postcard', ...mm(148, 105) },
  { label: 'Bookmark', ...mm(50, 175) },
  { label: 'IG portrait 4:5', ...mm(216, 270) },
  { label: 'Story 9:16', ...mm(135, 240) },
  { label: 'Screen 16:9', ...mm(240, 135), screen: true },
  { label: 'Screen 9:16', ...mm(135, 240), screen: true },
  { label: 'Screen 4:3', ...mm(240, 180), screen: true },
  { label: 'Screen 3:4', ...mm(180, 240), screen: true },
];

/** Screen formats aren't about millimetres: zoom so the page nearly fills the
 * viewport, whatever the device. */
function fitPage(camera: Camera, page: { x: number; y: number; w: number; h: number }) {
  const margin = 1.08;
  camera.zoom = Math.min(window.innerWidth / (page.w * margin), window.innerHeight / (page.h * margin));
  camera.x = page.x + page.w / 2;
  camera.y = page.y + page.h / 2;
}

const CUSTOM_FORMATS_KEY = 'infinizine-custom-formats';
function customFormats(): Fmt[] {
  try {
    return JSON.parse(localStorage.getItem(CUSTOM_FORMATS_KEY) ?? '[]');
  } catch {
    return [];
  }
}
function saveCustomFormat(f: Fmt) {
  try {
    localStorage.setItem(CUSTOM_FORMATS_KEY, JSON.stringify([...customFormats(), f]));
  } catch { /* ignore */ }
}

export function buildUI(
  root: HTMLElement,
  state: InputState,
  store: Store,
  camera: Camera,
  invalidate: () => void,
  actions: { copy: () => void; cut: () => void; paste: () => void },
) {
  root.innerHTML = `
    <header class="topbar">
      <div class="wordmark">INFINI<span class="zine"><i>Z</i><i>I</i><i>N</i><i>E</i></span></div>
      <div class="top-actions">
        <button class="chip" id="docs" title="My zines">${svg('<path d="M4 7 V19 A1.5 1.5 0 0 0 5.5 20.5 H18.5 A1.5 1.5 0 0 0 20 19 V9.5 A1.5 1.5 0 0 0 18.5 8 H12 L10 5.5 H5.5 A1.5 1.5 0 0 0 4 7 Z"/>')}</button>
        <button class="chip" id="undo" title="Undo (⌘Z)">↩</button>
        <button class="chip" id="redo" title="Redo (⇧⌘Z)">↪</button>
        <button class="chip" id="finger-toggle" title="Finger mode"></button>
        <button class="chip" id="eagle" title="Eagle view: fit everything, tap again to return">${svg('<path d="M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5"/><rect x="9.5" y="9.5" width="5" height="5"/>')}</button>
        <button class="chip" id="zoom-lock" title="Zoom lock"></button>
        <button class="chip chip-text" id="zoom-100" title="Back to 100% (⌘0)">1:1</button>
        <button class="chip" id="playground" title="Pressure playground">${svg('<path d="M21.42 10.13 L21.42 13.87 L19.26 13.44 L18.15 16.11 L19.98 17.33 L17.33 19.98 L16.11 18.15 L13.44 19.26 L13.87 21.42 L10.13 21.42 L10.56 19.26 L7.89 18.15 L6.67 19.98 L4.02 17.33 L5.85 16.11 L4.74 13.44 L2.58 13.87 L2.58 10.13 L4.74 10.56 L5.85 7.89 L4.02 6.67 L6.67 4.02 L7.89 5.85 L10.56 4.74 L10.13 2.58 L13.87 2.58 L13.44 4.74 L16.11 5.85 L17.33 4.02 L19.98 6.67 L18.15 7.89 L19.26 10.56 Z"/><circle cx="12" cy="12" r="3.2"/>')}</button>
        <button class="chip" id="present" title="Present">${svg('<path d="M8 5.5 L18 12 L8 18.5 Z"/>')}</button>
      </div>
    </header>
    <div class="present-ui hidden" id="present-ui">
      <div class="present-tap" id="present-prev"></div>
      <div class="present-tap" id="present-next"></div>
      <div class="present-bar">
        <button id="present-back">‹</button>
        <span id="present-counter"></span>
        <button id="present-fwd">›</button>
        <button id="present-exit">✕</button>
      </div>
    </div>
    <div class="toolbar" id="toolbar">
      <div class="tools" id="tools"></div>
      <div class="divider"></div>
      <div class="sizes" id="sizes"></div>
      <div class="divider"></div>
      <button class="chip layer-toggle" id="layer-toggle"></button>
      <div class="divider"></div>
      <div class="pal-row" id="pal-row"></div>
      <button class="pal-more" id="pal-more" title="Palettes">···</button>
      <div class="divider"></div>
      <button class="add-page" id="add-page" title="New page">${svg('<path d="M7 3.5 H13.5 L18 8 V20.5 H7 Z"/><path d="M13.5 3.5 V8 H18"/><path d="M12.5 11.5 v5 M10 14 h5"/>')}</button>
    </div>
    <div class="popover top-pop hidden" id="docs-popover"></div>
    <div class="popover hidden" id="palette-popover"></div>
    <div class="popover hidden" id="page-popover"></div>
    <div class="page-menu hidden" id="page-menu">
      <button id="pm-move" title="Move page">${svg('<path d="M12 3 V21 M3 12 H21"/><path d="M12 3 L9.6 5.4 M12 3 L14.4 5.4 M12 21 L9.6 18.6 M12 21 L14.4 18.6 M3 12 L5.4 9.6 M3 12 L5.4 14.4 M21 12 L18.6 9.6 M21 12 L18.6 14.4"/>')}</button>
      <button id="pm-add" title="Add page (same size)">${svg('<path d="M12 5 V19 M5 12 H19"/>')}</button>
      <button id="pm-delete" title="Delete page">${svg('<path d="M4 7 H20 M9 7 V5 A1 1 0 0 1 10 4 H14 A1 1 0 0 1 15 5 V7 M6.5 7 L7.5 20 H16.5 L17.5 7"/>')}</button>
      <span class="pm-sep"></span>
      <div class="pm-formats">
        ${PRIMARY_FORMATS.map((f, i) => `<button class="pm-format" data-i="${i}">${f.label}</button>`).join('')}
        <button class="pm-format" id="pm-more-formats" title="More formats">···</button>
      </div>
    </div>
  `;

  const toolsEl = root.querySelector('#tools')!;
  const lastUsed: Record<string, Tool> = {};
  for (const g of TOOL_GROUPS) lastUsed[g.id] = g.tools[0];

  const closeToolFlyouts = () =>
    root.querySelectorAll('.tool-wrap.open').forEach((w) => w.classList.remove('open'));

  for (const g of TOOL_GROUPS) {
    const wrap = document.createElement('div');
    wrap.className = `tool-wrap${g.tools.length > 1 ? ' multi' : ''}`;
    wrap.dataset.group = g.id;

    const fly = document.createElement('div');
    fly.className = 'tool-flyout';
    for (const t of g.tools) {
      const b = document.createElement('button');
      b.className = 'tool';
      b.dataset.tool = t;
      b.title = `${TOOL_INFO[t].label} (${TOOL_INFO[t].key})`;
      b.innerHTML = `<span class="tool-icon">${ICONS[t]}</span>`;
      b.addEventListener('click', () => {
        state.tool = t;
        lastUsed[g.id] = t;
        state.selection.clear();
        closeToolFlyouts();
        refresh();
        invalidate();
      });
      fly.appendChild(b);
    }

    const slot = document.createElement('button');
    slot.className = 'tool tool-slot';
    slot.dataset.group = g.id;
    // touch: long-press opens the flyout; tap activates (or toggles when already active)
    let slotLp = 0;
    let slotLongPressed = false;
    slot.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' || g.tools.length < 2) return;
      slotLp = window.setTimeout(() => {
        slotLongPressed = true;
        closeToolFlyouts();
        wrap.classList.add('open');
      }, 300);
    });
    const cancelSlotLp = () => clearTimeout(slotLp);
    slot.addEventListener('pointerup', cancelSlotLp);
    slot.addEventListener('pointerleave', cancelSlotLp);
    slot.addEventListener('click', () => {
      if (slotLongPressed) { slotLongPressed = false; return; }
      const activeInGroup = g.tools.includes(state.tool);
      if (activeInGroup && g.tools.length > 1) {
        const wasOpen = wrap.classList.contains('open');
        closeToolFlyouts();
        wrap.classList.toggle('open', !wasOpen);
        return;
      }
      closeToolFlyouts();
      state.tool = lastUsed[g.id];
      state.selection.clear();
      refresh();
      invalidate();
    });

    wrap.append(fly, slot);
    toolsEl.appendChild(wrap);
  }
  document.addEventListener('pointerdown', (e) => {
    if (!(e.target as HTMLElement).closest?.('.tool-wrap')) closeToolFlyouts();
  });

  const sizesEl = root.querySelector('#sizes')!;
  sizesEl.innerHTML = `
    <div class="tool-wrap multi size-wrap" id="size-wrap">
      <div class="tool-flyout size-flyout">
        <div class="size-presets">${SIZES.map(
          (sz) => `<button class="size" data-w="${sz.w}" title="${sz.label}">
            <i style="width:${3 + sz.w * 3}px;height:${3 + sz.w * 3}px"></i>
          </button>`,
        ).join('')}</div>
        <input type="range" id="size-fader" min="0.3" max="12" step="0.1" title="Exact size">
        <button class="size-adaptive" id="size-adaptive" title="Adaptive: the brush keeps its on-screen size at every zoom level">${svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 L21 21"/><path d="M8 10.5h5 M10.5 8v5"/>')}<span>adaptive</span></button>
      </div>
      <button class="tool tool-slot" id="size-slot" title="Stroke size"><i id="size-dot"></i></button>
    </div>
  `;
  const sizeWrap = sizesEl.querySelector('#size-wrap') as HTMLElement;
  sizesEl.querySelectorAll('.size').forEach((b) =>
    b.addEventListener('click', () => {
      state.baseWidth = Number((b as HTMLElement).dataset.w);
      closeToolFlyouts();
      refresh();
    }),
  );
  const sizeFader = sizesEl.querySelector('#size-fader') as HTMLInputElement;
  sizeFader.addEventListener('input', () => {
    state.baseWidth = Number(sizeFader.value);
    refresh();
  });
  const adaptiveBtn = sizesEl.querySelector('#size-adaptive') as HTMLButtonElement;
  adaptiveBtn.addEventListener('click', () => {
    state.adaptiveSize = !state.adaptiveSize;
    writePref(ADAPTIVE_KEY, state.adaptiveSize ? '1' : '0');
    refresh();
  });
  (sizesEl.querySelector('#size-slot') as HTMLButtonElement).addEventListener('click', () => {
    const wasOpen = sizeWrap.classList.contains('open');
    closeToolFlyouts();
    sizeWrap.classList.toggle('open', !wasOpen);
  });

  const palRow = root.querySelector('#pal-row') as HTMLElement;
  const palMore = root.querySelector('#pal-more') as HTMLButtonElement;
  const palettePop = root.querySelector('#palette-popover') as HTMLElement;
  const pagePop = root.querySelector('#page-popover') as HTMLElement;
  // credit-card outline (85.60 × 53.98 mm) for screen calibration
  const calCard = document.createElement('div');
  calCard.className = 'cal-card hidden';
  calCard.innerHTML = '<span>credit card · 85.6 × 54 mm</span>';
  document.body.appendChild(calCard);
  let calTimer = 0;
  function showCalCard() {
    calCard.style.width = `${85.6 * pxPerMm()}px`;
    calCard.style.height = `${53.98 * pxPerMm()}px`;
    calCard.classList.remove('hidden');
    window.clearTimeout(calTimer);
    calTimer = window.setTimeout(() => calCard.classList.add('hidden'), 2500);
  }

  function closeFlyouts() {
    palRow.querySelectorAll('.pal-wrap.open').forEach((w) => w.classList.remove('open'));
  }

  /** Picking a color while textboxes are selected recolors them. */
  function applyColor(c: string) {
    state.color = c;
    const textIds = store.doc.elements
      .filter((el) => el.kind === 'text' && state.selection.has(el.id))
      .map((el) => el.id);
    if (textIds.length) store.recolorElements(textIds, c);
    refresh();
    invalidate();
  }

  // Inline palette: 5–6 dots; shades appear on hover (desktop) or long-press (touch)
  function buildPalRow() {
    palRow.innerHTML = '';
    const preset = getPalette(store.doc.palette);
    for (const hue of preset.hues) {
      const wrap = document.createElement('div');
      wrap.className = 'pal-wrap';
      const fly = document.createElement('div');
      fly.className = 'shade-flyout';
      for (const c of shades(hue, preset.drama)) {
        const s = document.createElement('button');
        s.className = 'pal-shade';
        s.style.background = c;
        s.addEventListener('click', (e) => {
          e.stopPropagation();
          closeFlyouts();
          applyColor(c);
        });
        fly.appendChild(s);
      }
      const dot = document.createElement('button');
      dot.className = 'pal-main';
      dot.dataset.hue = hue;
      dot.style.background = hue;
      let lp = 0;
      let longPressed = false;
      dot.addEventListener('click', () => {
        if (longPressed) { longPressed = false; return; }
        closeFlyouts();
        applyColor(hue);
      });
      dot.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse') return;
        lp = window.setTimeout(() => {
          longPressed = true;
          closeFlyouts();
          wrap.classList.add('open');
        }, 320);
      });
      const cancelLp = () => clearTimeout(lp);
      dot.addEventListener('pointerup', cancelLp);
      dot.addEventListener('pointerleave', cancelLp);
      wrap.append(fly, dot);
      palRow.appendChild(wrap);
    }
    refresh();
  }

  function buildPalettePopover() {
    const preset = getPalette(store.doc.palette);
    palettePop.innerHTML = `
      <div class="pal-presets">${PALETTES.map(
        (p) => `<button class="pal-preset ${p.id === preset.id ? 'active' : ''}" data-id="${p.id}">
          <span class="pal-preset-name">${p.name}</span>
          <span class="pal-preview">${p.hues
            .map((c) => `<i style="background:${c}"></i>`)
            .join('')}</span>
        </button>`,
      ).join('')}</div>
      <label class="pal-custom">custom <input type="color" id="custom-color" value="${state.color}"></label>
      <div class="paper-row">
        <span class="paper-label">pattern</span>
        ${['blank', 'dots', 'grid', 'lines']
          .map((pt) => `<button class="pattern-dot ${((store.doc.pattern ?? 'dots') === pt) ? 'active' : ''}" data-p="${pt}" title="${pt}">${
            pt === 'dots'
              ? svg('<circle cx="7" cy="7" r="1.2" fill="currentColor"/><circle cx="17" cy="7" r="1.2" fill="currentColor"/><circle cx="7" cy="17" r="1.2" fill="currentColor"/><circle cx="17" cy="17" r="1.2" fill="currentColor"/>')
              : pt === 'grid'
                ? svg('<path d="M9 4v16 M15 4v16 M4 9h16 M4 15h16"/>')
                : pt === 'lines'
                  ? svg('<path d="M4 8h16 M4 13h16 M4 18h16"/>')
                  : svg('<rect x="5" y="5" width="14" height="14" rx="2"/>')
          }</button>`)
          .join('')}
      </div>
      <div class="paper-row">
        <span class="paper-label">paper</span>
        ${['#FFFFFF', '#F7F4EC', '#F3ECDD', '#ECECEA', '#1E1C1A']
          .map((c) => `<button class="paper-dot ${((store.doc.paper ?? '#F7F4EC') === c) ? 'active' : ''}" data-c="${c}" style="background:${c}"></button>`)
          .join('')}
        <input type="color" id="paper-color" value="${store.doc.paper ?? '#F7F4EC'}">
      </div>
    `;
    palettePop.querySelectorAll('.pattern-dot').forEach((b) =>
      b.addEventListener('click', () => {
        store.setPattern((b as HTMLElement).dataset.p as 'blank' | 'dots' | 'grid' | 'lines');
        buildPalettePopover();
      }),
    );
    palettePop.querySelectorAll('.paper-dot').forEach((b) =>
      b.addEventListener('click', () => {
        store.setPaper((b as HTMLElement).dataset.c!);
        buildPalettePopover();
      }),
    );
    (palettePop.querySelector('#paper-color') as HTMLInputElement).addEventListener('input', (e) => {
      store.setPaper((e.target as HTMLInputElement).value);
    });
    palettePop.querySelectorAll('.pal-preset').forEach((b) =>
      b.addEventListener('click', () => {
        store.setPalette((b as HTMLElement).dataset.id!);
        buildPalRow();
        buildPalettePopover();
      }),
    );
    (palettePop.querySelector('#custom-color') as HTMLInputElement).addEventListener('input', (e) => {
      applyColor((e.target as HTMLInputElement).value);
    });
  }

  palMore.addEventListener('click', () => {
    pagePop.classList.add('hidden');
    buildPalettePopover();
    palettePop.classList.toggle('hidden');
  });

  // tap anywhere else closes touch flyouts
  document.addEventListener('pointerdown', (e) => {
    if (!(e.target as HTMLElement).closest?.('.pal-wrap')) closeFlyouts();
  });

  const addPageBtn = root.querySelector('#add-page') as HTMLButtonElement;

  // Format panel (shared by first-page picker and the page menu's "more"):
  // primary + extended presets + saved custom formats + a custom W×H creator.
  let onPickFormat: (f: Fmt) => void = () => {};
  function buildFormatPanel() {
    const all = [...PRIMARY_FORMATS, ...MORE_FORMATS, ...customFormats()];
    pagePop.innerHTML = `
      <div class="fmt-grid">${all
        .map(
          (f, i) => `<button class="fmt" data-i="${i}">
            <span class="fmt-label">${f.label}</span>
            <span class="fmt-dims">${Math.round(f.w / UNITS_PER_MM)}×${Math.round(f.h / UNITS_PER_MM)}mm</span>
          </button>`,
        )
        .join('')}</div>
      <div class="fmt-custom">
        <span class="fmt-custom-label">custom</span>
        <input id="fmt-name" type="text" placeholder="name" maxlength="16">
        <input id="fmt-w" type="number" min="10" max="2000" placeholder="W"> ×
        <input id="fmt-h" type="number" min="10" max="2000" placeholder="H"> mm
        <button id="fmt-add">Add</button>
      </div>
      <div class="fmt-cal">
        <span class="fmt-custom-label">real size</span>
        <span class="fmt-cal-hint">hold a credit card on the outline, slide until it fits</span>
        <input id="cal-slider" type="range" min="2.4" max="8" step="0.01">
        <button id="cal-auto" title="Back to the device guess">Auto</button>
      </div>
    `;
    const slider = pagePop.querySelector('#cal-slider') as HTMLInputElement;
    slider.value = String(pxPerMm());
    const applyCal = (v: number | null) => {
      const before = baseZoom();
      setPxPerMm(v);
      camera.zoom *= baseZoom() / before; // keep the zoom percentage, not the pixels
      slider.value = String(pxPerMm());
      showCalCard();
      state.updateCursor();
      invalidate();
    };
    slider.addEventListener('input', () => applyCal(Number(slider.value)));
    slider.addEventListener('pointerdown', showCalCard);
    (pagePop.querySelector('#cal-auto') as HTMLButtonElement).addEventListener('click', () => applyCal(null));
    pagePop.querySelectorAll('.fmt').forEach((b) =>
      b.addEventListener('click', () => {
        const f = all[Number((b as HTMLElement).dataset.i)];
        pagePop.classList.add('hidden');
        onPickFormat(f);
        invalidate();
      }),
    );
    (pagePop.querySelector('#fmt-add') as HTMLButtonElement).addEventListener('click', () => {
      const wMm = Number((pagePop.querySelector('#fmt-w') as HTMLInputElement).value);
      const hMm = Number((pagePop.querySelector('#fmt-h') as HTMLInputElement).value);
      if (!wMm || !hMm) return;
      const name = (pagePop.querySelector('#fmt-name') as HTMLInputElement).value.trim() || `${wMm}×${hMm}`;
      const f: Fmt = { label: name, ...mm(wMm, hMm) };
      saveCustomFormat(f);
      pagePop.classList.add('hidden');
      onPickFormat(f);
      invalidate();
    });
  }

  function openFormatPanel(pick: (f: Fmt) => void) {
    onPickFormat = pick;
    palettePop.classList.add('hidden');
    buildFormatPanel();
    pagePop.classList.remove('hidden');
  }

  const createFirstPage = (f: Fmt) => {
    const page = store.addPage({ w: f.w, h: f.h }, { x: camera.x, y: camera.y });
    camera.x = page.x + page.w / 2;
    camera.y = page.y + page.h / 2;
    if (f.screen) { fitPage(camera, page); state.updateCursor(); }
  };
  addPageBtn.addEventListener('click', () => {
    palettePop.classList.add('hidden');
    const pages = store.doc.pages;
    if (pages.length) {
      // All pages share one size: new pages copy it, no format picker
      const last = pages.reduce((a, b) => (b.order > a.order ? b : a));
      const page = store.addPageAfter(last);
      camera.x = page.x + page.w / 2;
      camera.y = page.y + page.h / 2;
      invalidate();
      return;
    }
    openFormatPanel(createFirstPage);
  });

  // ---------- text tool: draw a rectangle, text wraps inside it ----------
  const TEXT_SIZES = [
    { label: 'Title', size: 26 },
    { label: 'Heading', size: 15 },
    { label: 'Body', size: 8 },
    { label: 'Sub', size: 5.5 },
  ];

  state.onTextEdit = (target, rect) => {
    let fontSize = target ? target.fontSize : state.textSize;
    const color = target ? target.color : state.color;
    let family = target?.font ?? state.font;
    if (target) state.hidden.add(target.id);
    invalidate();

    // WYSIWYG contenteditable: markdown converts live as you type
    const ta = document.createElement('div');
    ta.className = 'text-editor rich';
    ta.contentEditable = 'true';
    ta.innerHTML = markdownToHtml(target ? target.text : '');
    const value = () => htmlToMarkdown(ta);

    // typeface bar floating over the text field
    const bar = document.createElement('div');
    bar.className = 'font-bar';
    for (const [key, f] of Object.entries(FONTS)) {
      const b = document.createElement('button');
      b.textContent = f.name;
      b.style.fontFamily = f.css;
      b.classList.toggle('active', key === family);
      // keep the textarea focused — no blur/commit on picking a font
      b.addEventListener('pointerdown', (e) => e.preventDefault());
      b.addEventListener('click', () => {
        family = key;
        state.font = key;
        bar.querySelectorAll('button').forEach((o) => o.classList.toggle('active', o === b));
        place();
        ta.focus();
      });
      bar.appendChild(b);
    }
    const sizeSep = document.createElement('span');
    sizeSep.className = 'font-bar-sep';
    bar.appendChild(sizeSep);
    for (const s of TEXT_SIZES) {
      const b = document.createElement('button');
      b.textContent = s.label;
      b.classList.toggle('active', Math.abs(s.size - fontSize) < 0.01);
      b.addEventListener('pointerdown', (e) => e.preventDefault());
      b.addEventListener('click', () => {
        fontSize = s.size;
        state.textSize = s.size;
        bar.querySelectorAll('button').forEach((o) => {
          if (TEXT_SIZES.some((ts) => ts.label === o.textContent)) {
            o.classList.toggle('active', o === b);
          }
        });
        place();
        ta.focus();
      });
      bar.appendChild(b);
    }
    document.body.appendChild(bar);
    const contentH = () =>
      Math.max(rect.h, layoutHeight(layoutText(value() || ' ', family, fontSize, rect.w)));
    const place = () => {
      const r = (document.getElementById('canvas') as HTMLCanvasElement).getBoundingClientRect();
      const s = camera.worldToScreen(rect.x, rect.y, r.width, r.height);
      const z = camera.zoom;
      ta.style.left = `${r.left + s.x}px`;
      ta.style.top = `${r.top + s.y}px`;
      ta.style.font = `400 ${fontSize * z}px ${FONTS[family].css}`;
      ta.style.lineHeight = `${fontSize * 1.3 * z}px`;
      ta.style.color = color;
      ta.style.width = `${rect.w * z}px`; // fixed: the drawn rectangle's width
      ta.style.minHeight = `${contentH() * z}px`; // grows downward with content
      bar.style.left = `${r.left + s.x}px`;
      bar.style.top = `${r.top + s.y - 46}px`;
    };
    place();
    ta.addEventListener('input', () => {
      autoTransform(ta); // '# ', '- ', **bold**, *italic* convert as soon as typed
      place();
    });
    document.body.appendChild(ta);
    ta.focus();
    caretToEnd(ta);

    let done = false;

    // Track the camera while editing so the overlay pans/zooms with the canvas
    let camState = '';
    const track = () => {
      if (done) return;
      const s = `${camera.x},${camera.y},${camera.zoom}`;
      if (s !== camState) {
        camState = s;
        place();
      }
      requestAnimationFrame(track);
    };
    requestAnimationFrame(track);
    const commit = () => {
      if (done) return;
      done = true;
      ta.remove();
      bar.remove();
      if (target) state.hidden.delete(target.id);
      const text = value().replace(/\s+$/, '');
      const h = Math.max(rect.h, layoutHeight(layoutText(text || ' ', family, fontSize, rect.w)));
      if (target) {
        if (text === target.text && family === (target.font ?? 'franklin') && fontSize === target.fontSize) {
          invalidate();
          return;
        }
        if (text) {
          store.updateText(
            target.id,
            { text: target.text, w: target.w, h: target.h, font: target.font ?? 'franklin', fontSize: target.fontSize },
            { text, w: rect.w, h, font: family, fontSize },
          );
        } else {
          store.deleteElements([target]);
        }
      } else if (text) {
        store.addElement({
          id: uid('tx'),
          kind: 'text', x: rect.x, y: rect.y, w: rect.w, h,
          color, fontSize, font: family, text,
          layer: state.paintBehind ? 'back' : 'front',
          frame: state.activeFrameId ?? undefined,
          alayer: state.activeLayerId ?? undefined,
        });
      }
      invalidate();
    };
    ta.addEventListener('blur', commit);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); commit(); return; }
      // classic shortcuts, applied as real styling (serialized back to markdown on commit)
      if ((e.metaKey || e.ctrlKey) && (e.key === 'b' || e.key === 'i')) {
        e.preventDefault();
        document.execCommand(e.key === 'b' ? 'bold' : 'italic');
        place();
      }
    });
  };

  // Page menu: opens on a tap (not drag) of a page label
  const pageMenu = root.querySelector('#page-menu') as HTMLElement;
  let menuPage: import('./types').Page | null = null;
  state.onPageMenu = (page, clientX, clientY) => {
    menuPage = page;
    pageMenu.classList.remove('hidden');
    const mw = pageMenu.offsetWidth, mh = pageMenu.offsetHeight;
    pageMenu.style.left = `${Math.min(Math.max(8, clientX - mw / 2), window.innerWidth - mw - 8)}px`;
    pageMenu.style.top = `${Math.max(8, clientY - mh - 14)}px`;
  };
  const hidePageMenu = () => pageMenu.classList.add('hidden');
  (root.querySelector('#pm-move') as HTMLButtonElement).addEventListener('click', () => {
    state.armedPageDrag = menuPage; // next drag anywhere moves this page
    hidePageMenu();
  });
  (root.querySelector('#pm-add') as HTMLButtonElement).addEventListener('click', () => {
    if (menuPage) store.addPageAfter(menuPage);
    hidePageMenu();
    invalidate();
  });
  (root.querySelector('#pm-delete') as HTMLButtonElement).addEventListener('click', () => {
    if (menuPage) store.deletePage(menuPage);
    hidePageMenu();
    invalidate();
  });
  root.querySelectorAll('#page-menu .pm-format[data-i]').forEach((b) =>
    b.addEventListener('click', () => {
      store.setPagesFormat(PRIMARY_FORMATS[Number((b as HTMLElement).dataset.i)]);
      hidePageMenu();
      invalidate();
    }),
  );
  (root.querySelector('#pm-more-formats') as HTMLButtonElement).addEventListener('click', () => {
    const target = menuPage;
    hidePageMenu();
    openFormatPanel((f) => {
      store.setPagesFormat(f);
      const pg = (target && store.doc.pages.find((p) => p.id === target.id)) ?? store.doc.pages[0];
      if (f.screen && pg) { fitPage(camera, pg); state.updateCursor(); }
    });
  });
  document.addEventListener('pointerdown', (e) => {
    if (!(e.target as HTMLElement).closest?.('#page-menu')) hidePageMenu();
  });

  // ---------- animation timeline (floating, draggable window) ----------
  const tl = document.createElement('div');
  tl.className = 'timeline hidden';
  document.body.appendChild(tl);
  let tlAreaId: string | null = null;
  let tlView: 'frames' | 'live' = 'frames';
  let tlZoom = 1; // horizontal duration-resolution zoom
  let tlDock: 'float' | 'bottom' | 'top' | 'left' | 'right' = 'float';
  let tlHeight: number | null = null; // user-resized tracks height
  let tlWidth: number | null = null; // user-resized width for side docks

  function closeTimeline() {
    tlAreaId = null;
    // hidden but the dock choice is remembered for the next open
    document.body.classList.remove('tl-docked-bottom', 'tl-docked-top', 'tl-docked-side');
    state.activeAreaId = null;
    state.activeFrameId = null;
    state.activeLayerId = null;
    state.playingAreas = false;
    tl.classList.add('hidden');
    invalidate();
  }

  state.onAnimClose = closeTimeline;
  state.onAnimOpen = (area) => {
    tlAreaId = area.id;
    // restore the remembered dock position (and its body classes)
    document.body.classList.toggle('tl-docked-bottom', tlDock === 'bottom');
    document.body.classList.toggle('tl-docked-top', tlDock === 'top');
    document.body.classList.toggle('tl-docked-side', tlDock === 'left' || tlDock === 'right');
    state.activeAreaId = area.id;
    const top = area.layers[area.layers.length - 1];
    state.activeLayerId = top?.id ?? null;
    state.activeFrameId = top?.frames[0]?.id ?? null;
    tl.classList.remove('hidden');
    renderTimeline();
    invalidate();
  };

  function setDock(mode: 'float' | 'bottom' | 'top' | 'left' | 'right') {
    tlDock = mode;
    tl.classList.toggle('dock-bottom', mode === 'bottom');
    tl.classList.toggle('dock-top', mode === 'top');
    tl.classList.toggle('dock-left', mode === 'left');
    tl.classList.toggle('dock-right', mode === 'right');
    tl.style.width = '';
    // keep the tool panel / topbar reachable above a docked timeline
    document.body.classList.toggle('tl-docked-bottom', mode === 'bottom');
    document.body.classList.toggle('tl-docked-top', mode === 'top');
    document.body.classList.toggle('tl-docked-side', mode === 'left' || mode === 'right');
    // docked position is class-driven; clear any drag inline coords
    tl.style.left = '';
    tl.style.top = '';
    tl.style.right = '';
    tl.style.bottom = '';
    renderTimeline();
  }

  // dock preview: an expanding zone shows where the timeline will snap
  const dockPreview = document.createElement('div');
  dockPreview.className = 'dock-preview';
  document.body.appendChild(dockPreview);
  function showDockPreview(edge: 'top' | 'bottom' | 'left' | 'right' | null) {
    dockPreview.classList.toggle('show', edge !== null);
    if (edge) {
      for (const c of ['at-top', 'at-bottom', 'at-left', 'at-right']) dockPreview.classList.remove(c);
      dockPreview.classList.add(`at-${edge}`);
    }
  }

  // dragging the window (docked: dragging the grip away undocks it)
  let tlDrag: { x: number; y: number } | null = null;
  let undockStart: { x: number; y: number } | null = null;
  tl.addEventListener('pointerdown', (e) => {
    const head = (e.target as HTMLElement).closest('.tl-grip');
    if (!head) return;
    tl.setPointerCapture(e.pointerId);
    if (tlDock === 'float') {
      tlDrag = { x: e.clientX - tl.offsetLeft, y: e.clientY - tl.offsetTop };
    } else {
      undockStart = { x: e.clientX, y: e.clientY };
    }
  });
  tl.addEventListener('pointermove', (e) => {
    if (undockStart) {
      if (Math.hypot(e.clientX - undockStart.x, e.clientY - undockStart.y) > 24) {
        setDock('float');
        undockStart = null;
        tlDrag = { x: 140, y: 16 };
        tl.style.left = `${e.clientX - 140}px`;
        tl.style.top = `${e.clientY - 16}px`;
        tl.style.bottom = 'auto';
        tl.style.right = 'auto';
      }
      return;
    }
    if (!tlDrag) return;
    tl.style.left = `${e.clientX - tlDrag.x}px`;
    tl.style.top = `${e.clientY - tlDrag.y}px`;
    tl.style.bottom = 'auto';
    tl.style.right = 'auto';
    const r = tl.getBoundingClientRect();
    showDockPreview(
      r.top < 56
        ? 'top'
        : window.innerHeight - r.bottom < 56
          ? 'bottom'
          : r.left < 40
            ? 'left'
            : window.innerWidth - r.right < 40
              ? 'right'
              : null,
    );
  });
  tl.addEventListener('pointerup', () => {
    undockStart = null;
    showDockPreview(null);
    if (tlDrag) {
      const r = tl.getBoundingClientRect();
      if (r.top < 56) setDock('top');
      else if (window.innerHeight - r.bottom < 56) setDock('bottom');
      else if (r.left < 40) setDock('left');
      else if (window.innerWidth - r.right < 40) setDock('right');
    }
    tlDrag = null;
  });

  function inlineRename(el: HTMLElement, current: string, commitName: (v: string) => void) {
    const input = document.createElement('input');
    input.className = 'tl-rename';
    input.value = current;
    el.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      if (save) commitName(input.value);
      renderTimeline();
    };
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
      e.stopPropagation();
    });
  }

  // playhead: lights up the playing frame per track and shows the loop clock
  let playheadRaf = 0;
  function playheadLoop() {
    cancelAnimationFrame(playheadRaf);
    const area = tlAreaId ? store.area(tlAreaId) : undefined;
    const timeEl = tl.querySelector('#tl-time') as HTMLElement | null;
    if (!area || !timeEl) return;
    // pipeline length: longest keyframe track + every non-looping live line's end;
    // the live-view clock also covers self-looping lines' full cycles
    const framesTotal = Math.max(1, ...area.layers.map((l) => l.frames.reduce((a, f) => a + f.duration, 0)));
    let total = framesTotal;
    let liveMax = 1;
    for (const l of area.layers) {
      if (l.kind !== 'live') continue;
      for (const st of store.doc.elements) {
        if (st.kind !== 'stroke' || st.alayer !== l.id) continue;
        const drawn = (st.points[st.points.length - 1]?.t ?? 0) * area.fps;
        const end = Math.ceil((st.animStart ?? 0) + drawn + Math.max(1, st.animLife ?? 6));
        liveMax = Math.max(liveMax, end);
        if (l.loop === false) total = Math.max(total, end);
      }
    }
    const clockTicks = tlView === 'live' ? Math.max(total, liveMax) : total;
    const loopSec = clockTicks / area.fps;
    if (!state.playingAreas) {
      timeEl.textContent = `${loopSec.toFixed(1)}s`;
      tl.querySelectorAll('.tl-frame.playing').forEach((c) => c.classList.remove('playing'));
      tl.querySelectorAll<HTMLElement>('.tl-liveprog').forEach((pr) => (pr.style.display = 'none'));
      return;
    }
    const elapsed = performance.now() / 1000 - state.playEpoch;
    let tick = Math.floor(elapsed * area.fps);
    tick = area.loop ? ((tick % total) + total) % total : Math.min(tick, total - 1);
    const sec = area.loop ? elapsed % loopSec : Math.min(elapsed, loopSec);
    timeEl.textContent = `${sec.toFixed(1)}s / ${loopSec.toFixed(1)}s`;
    for (const l of area.layers) {
      let acc = 0;
      let visId: string | null = l.frames[l.frames.length - 1]?.id ?? null;
      for (const f of l.frames) {
        acc += f.duration;
        if (tick < acc) { visId = f.id; break; }
      }
      for (const f of l.frames) {
        const cell = tl.querySelector(`.tl-frame[data-fid="${f.id}"]`);
        cell?.classList.toggle('playing', f.id === visId);
      }
    }
    // live-layer progress sweeps
    const rawTick = elapsed * area.fps;
    for (const l of area.layers) {
      if (l.kind !== 'live') continue;
      const bar = tl.querySelector<HTMLElement>(`.tl-livebar[data-lid="${l.id}"]`);
      const prog = bar?.querySelector<HTMLElement>('.tl-liveprog');
      if (!bar || !prog) continue;
      const scale = Number(bar.dataset.scale) || 30;
      const barStart = Number(bar.dataset.start) || 0;
      const strokes = store.doc.elements.filter((e) => e.kind === 'stroke' && e.alayer === l.id);
      let ticks = 0;
      const st = strokes[0];
      if (st && st.kind === 'stroke') {
        const drawn = (st.points[st.points.length - 1]?.t ?? 0) * area.fps;
        const cycle = Math.max(1, Math.ceil(barStart + drawn + (st.animLife ?? 6)));
        ticks = l.loop !== false
          ? ((rawTick % cycle) + cycle) % cycle - barStart // loops on its own cycle
          : tick - barStart; // rides the area pipeline once per loop
      }
      if (ticks < 0) {
        prog.style.display = 'none'; // in the lead-in silence
      } else {
        prog.style.display = 'block';
        prog.style.left = `${Math.max(0, Math.min(bar.clientWidth - 3, ticks * scale))}px`;
      }
    }
    playheadRaf = requestAnimationFrame(playheadLoop);
  }

  // kebab menu for a live layer: convert to keyframes / delete
  const kebab = document.createElement('div');
  kebab.className = 'tl-kebab hidden';
  document.body.appendChild(kebab);
  function openLayerKebab(e: { clientX: number; clientY: number }, layerId: string) {
    kebab.innerHTML = `
      <button id="kb-convert">Convert to keyframes</button>
      <button id="kb-delete">Delete line</button>
    `;
    kebab.classList.remove('hidden');
    kebab.style.left = `${Math.min(e.clientX, window.innerWidth - 190)}px`;
    kebab.style.top = `${e.clientY + 8}px`;
    (kebab.querySelector('#kb-convert') as HTMLButtonElement).addEventListener('click', () => {
      if (tlAreaId) {
        store.convertLiveLayer(tlAreaId, layerId);
        tlView = 'frames';
      }
      kebab.classList.add('hidden');
      renderTimeline();
      invalidate();
    });
    (kebab.querySelector('#kb-delete') as HTMLButtonElement).addEventListener('click', () => {
      if (tlAreaId) store.deleteAnimLayer(tlAreaId, layerId);
      kebab.classList.add('hidden');
      renderTimeline();
      invalidate();
    });
  }
  document.addEventListener('pointerdown', (e) => {
    if (!(e.target as HTMLElement).closest?.('.tl-kebab')) kebab.classList.add('hidden');
  });

  function renderTimeline() {
    const area = tlAreaId ? store.area(tlAreaId) : undefined;
    if (!area) { closeTimeline(); return; }
    const prevScroll = (tl.querySelector('.tl-tracks') as HTMLElement | null)?.scrollTop ?? 0;
    if (!area.layers.some((l) => l.id === state.activeLayerId)) {
      state.activeLayerId = area.layers[area.layers.length - 1]?.id ?? null;
    }
    const activeLayer = area.layers.find((l) => l.id === state.activeLayerId)!;
    if (!activeLayer.frames.some((f) => f.id === state.activeFrameId)) {
      state.activeFrameId = activeLayer.frames[0]?.id ?? null;
    }
    const fid = state.activeFrameId!;
    const lid = state.activeLayerId!;
    const nFrameLayers = area.layers.filter((l) => l.kind !== 'live').length;
    const nLiveLayers = area.layers.filter((l) => l.kind === 'live').length;
    tl.innerHTML = `
      <div class="tl-head">
        <span class="tl-grip" title="Drag to move">⠿</span>
        <span class="tl-name" title="Double-click to rename">${area.name}</span>
        <button id="tl-play" title="Play/pause">${state.playingAreas ? '⏸' : '▶'}</button>
        <span class="tl-time" id="tl-time"></span>
        <input id="tl-fps" type="number" min="1" max="60" value="${area.fps}" title="fps"><span class="tl-fpslabel">fps</span>
        <button id="tl-zoom-out" class="tl-zoom" title="Zoom timeline out">−</button>
        <button id="tl-zoom-in" class="tl-zoom" title="Zoom timeline in">＋</button>
        <button id="tl-loop" class="tl-toggle ${area.loop ? 'on' : ''}">loop</button>
        <button id="tl-clip" class="tl-toggle ${area.clip ? 'on' : ''}" title="Cut off ink outside the area">clip</button>
        <button id="tl-onion" class="tl-toggle ${state.onionSkin ? 'on' : ''}">onion</button>
        <button id="tl-dock" title="Dock (bottom / top / right / left / float)">${
          tlDock === 'bottom'
            ? svg('<rect x="4" y="4" width="16" height="16"/><path d="M4 14 H20 V20 H4 Z" fill="currentColor"/>')
            : tlDock === 'top'
              ? svg('<rect x="4" y="4" width="16" height="16"/><path d="M4 4 H20 V10 H4 Z" fill="currentColor"/>')
              : tlDock === 'left'
                ? svg('<rect x="4" y="4" width="16" height="16"/><path d="M4 4 H10 V20 H4 Z" fill="currentColor"/>')
                : tlDock === 'right'
                  ? svg('<rect x="4" y="4" width="16" height="16"/><path d="M14 4 H20 V20 H14 Z" fill="currentColor"/>')
                  : svg('<rect x="4" y="4" width="16" height="16"/><path d="M4 14 H20"/>')
        }</button>
        <button id="tl-delarea" title="Delete area">🗑</button>
        <button id="tl-close" title="Close">✕</button>
      </div>
      <div class="tl-tabs">
        <button id="tl-tab-frames" class="${tlView === 'frames' ? 'on' : ''}">keyframes<span class="tl-tab-count">${nFrameLayers}</span>
          <span id="tl-eye-frames" class="tl-tab-eye${area.hideFrames ? ' off' : ''}" title="Show/hide all keyframe layers">${area.hideFrames ? svg('<path d="M4 5 L20 19"/><path d="M3 12 C6 7 9 5.5 12 5.5 C15 5.5 18 7 21 12 C19.5 14.5 17.8 16.2 16 17.2 M9.5 17.9 C7.2 17.1 5 15.2 3 12"/>') : svg('<path d="M3 12 C6 6.8 9 5 12 5 C15 5 18 6.8 21 12 C18 17.2 15 19 12 19 C9 19 6 17.2 3 12 Z"/><circle cx="12" cy="12" r="3"/>')}</span>
        </button>
        <button id="tl-tab-live" class="${tlView === 'live' ? 'on' : ''}">live lines<span class="tl-tab-count">${nLiveLayers}</span>
          <span id="tl-eye-live" class="tl-tab-eye${area.hideLive ? ' off' : ''}" title="Show/hide all live lines">${area.hideLive ? svg('<path d="M4 5 L20 19"/><path d="M3 12 C6 7 9 5.5 12 5.5 C15 5.5 18 7 21 12 C19.5 14.5 17.8 16.2 16 17.2 M9.5 17.9 C7.2 17.1 5 15.2 3 12"/>') : svg('<path d="M3 12 C6 6.8 9 5 12 5 C15 5 18 6.8 21 12 C18 17.2 15 19 12 19 C9 19 6 17.2 3 12 Z"/><circle cx="12" cy="12" r="3"/>')}</span>
        </button>
      </div>
      <div class="tl-tracks" id="tl-tracks"></div>
      ${tlView === 'frames'
        ? `<div class="tl-ops">
        <button id="tl-add" title="Add frame">＋</button>
        <button id="tl-dup" title="Duplicate frame">⧉</button>
        <button id="tl-del" title="Delete frame">−</button>
        <span class="tl-sep"></span>
        <button id="tl-shorter" title="Shorter">⇤</button>
        <button id="tl-longer" title="Longer">⇥</button>
        <span class="tl-sep"></span>
        <span class="tl-layers-label">layers</span>
        <button id="tl-addlayer" title="Add layer">＋</button>
      </div>`
        : `<div class="tl-ops">
        <span class="tl-layers-label" title="How long a stroke drawn while playing stays visible">live ink duration</span>
        <button id="tl-life-minus" title="Shorter">−</button>
        <span class="tl-life" id="tl-life">${state.liveInkLife} frames</span>
        <button id="tl-life-plus" title="Longer">＋</button>
        <button id="tl-taper" class="tl-toggle ${state.liveInkTaper ? 'on' : ''}" title="Tail eats away over its life">taper</button>
        <button id="tl-showink" class="tl-toggle ${state.showLiveInk ? 'on' : ''}" title="Show live ink while editing (it always shows in playback)">show</button>
      </div>`}
    `;

    (tl.querySelector('#tl-tab-frames') as HTMLElement).addEventListener('click', () => {
      tlView = 'frames';
      renderTimeline();
    });
    (tl.querySelector('#tl-tab-live') as HTMLElement).addEventListener('click', () => {
      tlView = 'live';
      renderTimeline();
    });
    (tl.querySelector('#tl-eye-frames') as HTMLElement).addEventListener('click', (e) => {
      e.stopPropagation();
      store.setAreaGroupHidden(area.id, 'frames', !area.hideFrames);
      renderTimeline();
      invalidate();
    });
    (tl.querySelector('#tl-eye-live') as HTMLElement).addEventListener('click', (e) => {
      e.stopPropagation();
      store.setAreaGroupHidden(area.id, 'live', !area.hideLive);
      renderTimeline();
      invalidate();
    });

    // one track per layer (top layer first), each with its own frame strip
    const tracksEl = tl.querySelector('#tl-tracks')!;
    const filledFrames = new Set(store.doc.elements.map((e) => e.frame).filter(Boolean));
    // live view: one shared time scale so every playhead moves at the same speed
    const areaTotalAll = Math.max(
      1,
      ...area.layers.filter((x) => x.kind !== 'live').map((x) => x.frames.reduce((acc, f) => acc + f.duration, 0)),
    );
    const layerCycle = (l: (typeof area.layers)[number]): number => {
      let cycle = 1;
      for (const st of store.doc.elements) {
        if (st.kind !== 'stroke' || st.alayer !== l.id) continue;
        const drawn = (st.points[st.points.length - 1]?.t ?? 0) * area.fps;
        cycle = Math.max(cycle, Math.ceil((st.animStart ?? 0) + drawn + (st.animLife ?? 6)));
      }
      return cycle;
    };
    const maxCycle = Math.max(areaTotalAll, ...area.layers.filter((l) => l.kind === 'live').map(layerCycle));
    const liveScale = Math.max(
      0.75,
      Math.min(80, Math.max(2, Math.min(30, 340 / Math.max(1, maxCycle))) * tlZoom),
    );
    {
      // time ruler (both views): second marks labeled, half-second ticks between
      const pxPerTick = tlView === 'live' ? liveScale : 30 * tlZoom;
      const axisTicks = tlView === 'live' ? maxCycle : areaTotalAll;
      const ruler = document.createElement('div');
      ruler.className = 'tl-ruler';
      const rhead = document.createElement('div');
      rhead.className = 'tl-ruler-head';
      rhead.style.width = tlView === 'live' ? '158px' : '130px';
      const scaleEl = document.createElement('div');
      scaleEl.className = 'tl-ruler-scale';
      scaleEl.style.width = `${axisTicks * pxPerTick}px`;
      const totalSec = axisTicks / area.fps;
      // avoid label soup when zoomed far out
      const step = pxPerTick * area.fps < 26 ? 1 : 0.5;
      for (let t = 0; t <= totalSec + 0.001; t += step) {
        const isSec = Math.abs(t - Math.round(t)) < 0.001;
        const tick = document.createElement('i');
        tick.className = `tl-tick${isSec ? ' sec' : ''}`;
        tick.style.left = `${t * area.fps * pxPerTick}px`;
        scaleEl.appendChild(tick);
        if (isSec) {
          const lab = document.createElement('em');
          lab.className = 'tl-tick-label';
          lab.style.left = `${t * area.fps * pxPerTick + 3}px`;
          lab.textContent = `${Math.round(t)}s`;
          scaleEl.appendChild(lab);
        }
      }
      ruler.append(rhead, scaleEl);
      tracksEl.appendChild(ruler);
    }
    [...area.layers].reverse()
      .filter((l) => (tlView === 'live') === (l.kind === 'live'))
      .forEach((l) => {
      const idx = area.layers.indexOf(l);
      const row = document.createElement('div');
      row.className = `tl-track${l.id === lid ? ' active' : ''}${l.kind === 'live' ? ' live' : ''}`;

      const head = document.createElement('div');
      head.className = `tl-track-head${l.hidden ? ' layer-hidden' : ''}`;
      const liveColor =
        l.kind === 'live'
          ? ((store.doc.elements.find((e) => e.kind === 'stroke' && e.alayer === l.id) as { color?: string } | undefined)?.color ?? '#7048e8')
          : '';
      const loopOn = l.loop !== false;
      head.innerHTML = `${
        l.kind === 'live'
          ? `<span class="tl-ldot" style="background:${liveColor}"></span>`
          : `<span class="tl-lname">${l.name}</span>`
      }
        ${l.kind === 'live' ? `<button data-a="loop" class="tl-looptgl${loopOn ? ' on' : ''}" title="${loopOn ? 'Loops immediately on its own cycle' : 'Plays once at its place in the pipeline'}">${svg('<path d="M7 6 H15 A4.5 4.5 0 0 1 15 15 H9 A4.5 4.5 0 0 1 9 6"/><path d="M9 3.5 L6.5 6 L9 8.5"/>')}</button>` : ''}
        <button data-a="eye" title="${l.hidden ? 'Show layer' : 'Hide layer'}">${
          l.hidden
            ? svg('<path d="M4 5 L20 19"/><path d="M3 12 C6 7 9 5.5 12 5.5 C15 5.5 18 7 21 12 C19.5 14.5 17.8 16.2 16 17.2 M9.5 17.9 C7.2 17.1 5 15.2 3 12"/>')
            : svg('<path d="M3 12 C6 6.8 9 5 12 5 C15 5 18 6.8 21 12 C18 17.2 15 19 12 19 C9 19 6 17.2 3 12 Z"/><circle cx="12" cy="12" r="3"/>')
        }</button>
        <button data-a="up" title="Layer up">↑</button>
        <button data-a="down" title="Layer down">↓</button>
        ${l.kind === 'live'
          ? `<button data-a="menu" title="More">⋮</button>`
          : `<button data-a="del" title="Delete layer">✕</button>`}`;
      head.querySelector('.tl-lname')?.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        inlineRename(e.target as HTMLElement, l.name, (v) => store.renameAnimLayer(area.id, l.id, v));
      });
      head.addEventListener('click', (e) => {
        const a = (e.target as HTMLElement).closest('button')?.dataset?.a;
        if (a === 'menu') {
          openLayerKebab(e as PointerEvent | MouseEvent, l.id);
          return;
        } else if (a === 'loop') store.setLayerLoop(area.id, l.id, l.loop === false);
        else if (a === 'eye') store.setLayerHidden(area.id, l.id, !l.hidden);
        else if (a === 'up') store.moveAnimLayer(area.id, idx, idx + 1);
        else if (a === 'down') store.moveAnimLayer(area.id, idx, idx - 1);
        else if (a === 'del') store.deleteAnimLayer(area.id, l.id);
        else if (l.kind === 'live' && state.activeLayerId === l.id) {
          // clicking the selected live layer deselects it
          state.selection.clear();
          state.blinkLayerId = null;
          const topFrames = [...area.layers].reverse().find((x) => x.kind !== 'live');
          state.activeLayerId = topFrames?.id ?? null;
          state.activeFrameId = topFrames?.frames[0]?.id ?? null;
        } else {
          state.activeLayerId = l.id;
          state.activeFrameId = l.frames[0]?.id ?? null;
        }
        renderTimeline();
        invalidate();
      });

      const strip = document.createElement('div');
      strip.className = 'tl-frames';
      if (l.kind === 'live') {
        // live-ink layer: one bar on the shared time scale
        const strokes = store.doc.elements.filter(
          (e) => e.kind === 'stroke' && e.alayer === l.id,
        );
        const cycle = layerCycle(l);
        const firstStroke = strokes[0];
        const start = firstStroke?.kind === 'stroke' ? (firstStroke.animStart ?? 0) : 0;
        const bar = document.createElement('div');
        bar.className = 'tl-livebar';
        bar.dataset.lid = l.id;
        bar.dataset.scale = String(liveScale);
        bar.dataset.start = String(start);
        // bar spans [delay .. delay+length]; dragging right adds lead-in silence
        const barLen = Math.max(1, cycle - start);
        bar.style.width = `${Math.max(24, barLen * liveScale)}px`;
        const startTicks = start;
        // lead-in spacer carries the start time, right-aligned against the bar
        const spacer = document.createElement('span');
        spacer.className = 'tl-start';
        spacer.style.width = `${Math.max(0, startTicks * liveScale)}px`;
        if (startTicks * liveScale > 30) {
          spacer.textContent = `${(startTicks / area.fps).toFixed(1)}s`;
        }
        strip.appendChild(spacer);
        const first = strokes[0];
        const inkColor = first && first.kind === 'stroke' ? first.color : '#7048e8';
        bar.style.background = inkColor;
        const n = parseInt(inkColor.slice(1), 16) || 0;
        const lum = ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114;
        bar.style.color = lum < 140 ? '#fff' : '#2a241a';
        bar.textContent = `${strokes.length > 1 ? `✒${strokes.length} · ` : ''}${(barLen / area.fps).toFixed(1)}s`;
        const prog = document.createElement('div');
        prog.className = 'tl-liveprog';
        bar.appendChild(prog); // after textContent — that assignment clears children
        bar.title = 'Live line — drag to move it in time';
        // tap selects; horizontal drag shifts the layer's timing on the loop clock
        bar.addEventListener('pointerdown', (e) => {
          bar.setPointerCapture(e.pointerId);
          const startX = e.clientX;
          let dragging = false;
          const onMove = (ev: PointerEvent) => {
            const dx = ev.clientX - startX;
            if (!dragging && Math.abs(dx) > 6) dragging = true;
            if (dragging) bar.style.transform = `translateX(${Math.round(dx / liveScale) * liveScale}px)`;
          };
          const onUp = (ev: PointerEvent) => {
            bar.removeEventListener('pointermove', onMove);
            bar.removeEventListener('pointerup', onUp);
            bar.style.transform = '';
            state.activeLayerId = l.id;
            state.activeFrameId = null;
            if (dragging) {
              store.shiftLiveLayer(l.id, Math.round((ev.clientX - startX) / liveScale));
            } else if (state.activeLayerId === l.id) {
              // tapping the active line again deselects it
              state.selection.clear();
              state.blinkLayerId = null;
              const topFrames = [...area.layers].reverse().find((x) => x.kind !== 'live');
              state.activeLayerId = topFrames?.id ?? l.id;
              state.activeFrameId = topFrames?.frames[0]?.id ?? null;
            } else {
              // select the layer's strokes and blink them so it's obvious which ink this is
              state.selection = new Set(strokes.map((st) => st.id));
              state.blinkLayerId = l.id;
              state.blinkStart = performance.now() / 1000;
            }
            renderTimeline();
            invalidate();
          };
          bar.addEventListener('pointermove', onMove);
          bar.addEventListener('pointerup', onUp);
        });
        strip.appendChild(bar);
        row.append(head, strip);
        tracksEl.appendChild(row);
        return;
      }
      l.frames.forEach((f, i) => {
        const b = document.createElement('button');
        b.className = `tl-frame${f.id === state.activeFrameId ? ' active' : ''}${filledFrames.has(f.id) ? ' filled' : ''}`;
        b.dataset.fid = f.id;
        b.style.width = `${Math.max(14, 30 * f.duration * tlZoom)}px`;
        b.textContent = String(i + 1);
        b.title = `${l.name} · frame ${i + 1} · ${f.duration}f (drag to reorder)`;
        // tap selects; horizontal drag reorders within the layer
        b.addEventListener('pointerdown', (e) => {
          b.setPointerCapture(e.pointerId);
          const startX = e.clientX;
          let dragging = false;
          let marker: HTMLElement | null = null;
          const insertIndex = (px: number) => {
            const others = [...strip.querySelectorAll('.tl-frame')].filter((c) => c !== b);
            return {
              others,
              to: others.filter((c) => {
                const r = (c as HTMLElement).getBoundingClientRect();
                return r.left + r.width / 2 < px;
              }).length,
            };
          };
          const onMove = (ev: PointerEvent) => {
            if (!dragging && Math.abs(ev.clientX - startX) > 8) {
              dragging = true;
              b.classList.add('dragging');
              marker = document.createElement('div');
              marker.className = 'tl-insert';
              strip.appendChild(marker);
            }
            if (!dragging) return;
            // ghost follows the pointer
            b.style.transform = `translate(${ev.clientX - startX}px, -3px)`;
            // insertion marker shows the drop slot
            const { others, to } = insertIndex(ev.clientX);
            const sr = strip.getBoundingClientRect();
            const x =
              to < others.length
                ? (others[to] as HTMLElement).getBoundingClientRect().left
                : others.length
                  ? (others[others.length - 1] as HTMLElement).getBoundingClientRect().right
                  : sr.left;
            if (marker) marker.style.left = `${x - sr.left + strip.scrollLeft - 2}px`;
          };
          const onUp = (ev: PointerEvent) => {
            b.removeEventListener('pointermove', onMove);
            b.removeEventListener('pointerup', onUp);
            b.classList.remove('dragging');
            b.style.transform = '';
            marker?.remove();
            state.activeLayerId = l.id;
            state.activeFrameId = f.id;
            if (dragging) {
              store.moveFrame(area.id, l.id, i, insertIndex(ev.clientX).to);
            }
            renderTimeline();
            invalidate();
          };
          b.addEventListener('pointermove', onMove);
          b.addEventListener('pointerup', onUp);
        });
        strip.appendChild(b);
      });

      row.append(head, strip);
      tracksEl.appendChild(row);
    });

    const q = (sel: string) => tl.querySelector(sel) as HTMLElement;
    const on = (sel: string, fn: (e: Event) => void) =>
      (tl.querySelector(sel) as HTMLElement | null)?.addEventListener('click', fn);
    q('.tl-name').addEventListener('dblclick', (e) => {
      inlineRename(e.target as HTMLElement, area.name, (v) => store.renameArea(area.id, v));
    });
    const setTlZoom = (v: number) => {
      tlZoom = Math.max(0.25, Math.min(8, v));
      renderTimeline();
    };
    q('#tl-dock').addEventListener('click', () => {
      const order: (typeof tlDock)[] = ['float', 'bottom', 'top', 'right', 'left'];
      setDock(order[(order.indexOf(tlDock) + 1) % order.length]);
    });
    q('#tl-zoom-in').addEventListener('click', () => setTlZoom(tlZoom * 1.4));
    q('#tl-zoom-out').addEventListener('click', () => setTlZoom(tlZoom / 1.4));
    (tl.querySelector('#tl-tracks') as HTMLElement).addEventListener(
      'wheel',
      (e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        e.stopPropagation();
        setTlZoom(tlZoom * Math.exp(-e.deltaY * 0.01));
      },
      { passive: false },
    );
    q('#tl-play').addEventListener('click', () => {
      state.playingAreas = !state.playingAreas;
      state.playEpoch = performance.now() / 1000;
      renderTimeline();
      invalidate();
    });
    (q('#tl-fps') as HTMLInputElement).addEventListener('change', (e) => {
      const fps = Math.max(1, Math.min(60, Number((e.target as HTMLInputElement).value) || 12));
      store.setAreaSettings(area.id, { fps, loop: area.loop, clip: area.clip ?? false });
      renderTimeline();
    });
    q('#tl-loop').addEventListener('click', () => {
      store.setAreaSettings(area.id, { fps: area.fps, loop: !area.loop, clip: area.clip ?? false });
      renderTimeline();
    });
    q('#tl-clip').addEventListener('click', () => {
      store.setAreaSettings(area.id, { fps: area.fps, loop: area.loop, clip: !(area.clip ?? false) });
      renderTimeline();
      invalidate();
    });
    q('#tl-onion').addEventListener('click', () => {
      state.onionSkin = !state.onionSkin;
      renderTimeline();
      invalidate();
    });
    q('#tl-delarea').addEventListener('click', () => {
      store.deleteArea(area);
      closeTimeline();
    });
    q('#tl-close').addEventListener('click', closeTimeline);
    const framesOps = activeLayer.kind !== 'live';
    on('#tl-add', () => {
      if (!framesOps) return;
      const idx = activeLayer.frames.findIndex((f) => f.id === fid);
      const cur = activeLayer.frames[idx];
      const nf = store.addFrame(area.id, lid, idx + 1, cur?.duration ?? 1);
      state.activeFrameId = nf.id;
      renderTimeline();
      invalidate();
    });
    on('#tl-dup', () => {
      if (!framesOps) return;
      const nf = store.duplicateFrame(area.id, lid, fid);
      if (nf) state.activeFrameId = nf.id;
      renderTimeline();
      invalidate();
    });
    on('#tl-del', () => {
      if (!framesOps) return;
      store.deleteFrame(area.id, lid, fid);
      renderTimeline();
      invalidate();
    });
    const dur = (d: number) => {
      if (!framesOps) return;
      const f = activeLayer.frames.find((x) => x.id === fid);
      if (f) store.setFrameDuration(area.id, lid, fid, f.duration + d);
      renderTimeline();
      invalidate();
    };
    on('#tl-shorter', () => dur(-1));
    on('#tl-longer', () => dur(1));
    const tracksDiv = tl.querySelector('.tl-tracks') as HTMLElement;
    tracksDiv.scrollTop = prevScroll;
    if (tlHeight) tracksDiv.style.maxHeight = `${tlHeight}px`;
    // docked: a grab edge resizes the tracks up/down
    if (tlDock !== 'float') {
      const side = tlDock === 'left' || tlDock === 'right';
      if (side && tlWidth) tl.style.width = `${tlWidth}px`;
      const rz = document.createElement('div');
      rz.className = `tl-resize ${
        tlDock === 'bottom' ? 'edge-top' : tlDock === 'top' ? 'edge-bottom' : tlDock === 'left' ? 'edge-right' : 'edge-left'
      }`;
      rz.title = 'Drag to resize';
      rz.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        rz.setPointerCapture(e.pointerId);
        const startY = e.clientY;
        const startX = e.clientX;
        const startH = tracksDiv.clientHeight;
        const startW = tl.clientWidth;
        const onMove = (ev: PointerEvent) => {
          if (side) {
            const d = tlDock === 'left' ? ev.clientX - startX : startX - ev.clientX;
            tlWidth = Math.max(240, Math.min(window.innerWidth * 0.85, startW + d));
            tl.style.width = `${tlWidth}px`;
          } else {
            const d = tlDock === 'bottom' ? startY - ev.clientY : ev.clientY - startY;
            tlHeight = Math.max(60, Math.min(window.innerHeight * 0.8, startH + d));
            tracksDiv.style.maxHeight = `${tlHeight}px`;
          }
        };
        const onUp = () => {
          rz.removeEventListener('pointermove', onMove);
          rz.removeEventListener('pointerup', onUp);
        };
        rz.addEventListener('pointermove', onMove);
        rz.addEventListener('pointerup', onUp);
      });
      tl.appendChild(rz);
    }
    playheadLoop();
    on('#tl-life-minus', () => {
      state.liveInkLife = Math.max(1, state.liveInkLife - 1);
      renderTimeline();
    });
    on('#tl-life-plus', () => {
      state.liveInkLife = Math.min(99, state.liveInkLife + 1);
      renderTimeline();
    });
    on('#tl-taper', () => {
      state.liveInkTaper = !state.liveInkTaper;
      renderTimeline();
    });
    on('#tl-showink', () => {
      state.showLiveInk = !state.showLiveInk;
      renderTimeline();
      invalidate();
    });
    on('#tl-addlayer', () => {
      const nl = store.addAnimLayer(area.id);
      if (nl) {
        state.activeLayerId = nl.id;
        state.activeFrameId = nl.frames[0]?.id ?? null;
      }
      renderTimeline();
      invalidate();
    });
  }

  // ---------- zine library (save / open / export / import) ----------
  const docsBtn = root.querySelector('#docs') as HTMLButtonElement;
  const docsPop = root.querySelector('#docs-popover') as HTMLElement;

  function buildDocsPopover() {
    const docs = store.listDocs();
    docsPop.innerHTML = `
      <div class="docs-current">
        <input id="doc-name" type="text" value="${store.doc.name.replace(/"/g, '&quot;')}" maxlength="40" title="Zine name">
      </div>
      <div class="docs-list">${docs
        .map(
          (m) => `<div class="doc-row ${m.id === store.docId ? 'active' : ''}" data-id="${m.id}">
            <span class="doc-row-name">${m.name}</span>
            <span class="doc-row-date">${new Date(m.updated).toLocaleDateString()}</span>
            <button class="doc-del" data-id="${m.id}" title="Delete">✕</button>
          </div>`,
        )
        .join('')}</div>
      <div class="docs-actions">
        <button id="doc-new">＋ New zine</button>
        <button id="doc-export">Export</button>
        <button id="doc-import">Import</button>
        <input id="doc-file" type="file" accept=".zine,.json,application/json" hidden>
      </div>
    `;
    const nameInput = docsPop.querySelector('#doc-name') as HTMLInputElement;
    nameInput.addEventListener('change', () => store.renameDoc(nameInput.value));
    nameInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') nameInput.blur();
    });
    docsPop.querySelectorAll('.doc-row').forEach((row) =>
      row.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).classList.contains('doc-del')) return;
        store.openDoc((row as HTMLElement).dataset.id!);
        state.selection.clear();
        docsPop.classList.add('hidden');
        invalidate();
      }),
    );
    docsPop.querySelectorAll('.doc-del').forEach((b) =>
      b.addEventListener('click', () => {
        const id = (b as HTMLElement).dataset.id!;
        const meta = store.listDocs().find((m) => m.id === id);
        if (!window.confirm(`Delete "${meta?.name ?? 'zine'}"? This cannot be undone.`)) return;
        store.deleteDoc(id);
        state.selection.clear();
        buildDocsPopover();
        invalidate();
      }),
    );
    (docsPop.querySelector('#doc-new') as HTMLButtonElement).addEventListener('click', () => {
      store.newDoc();
      state.selection.clear();
      docsPop.classList.add('hidden');
      invalidate();
    });
    (docsPop.querySelector('#doc-export') as HTMLButtonElement).addEventListener('click', () => {
      const blob = new Blob([store.exportJSON()], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${store.doc.name || 'zine'}.zine`;
      a.click();
      URL.revokeObjectURL(a.href);
    });
    const fileInput = docsPop.querySelector('#doc-file') as HTMLInputElement;
    (docsPop.querySelector('#doc-import') as HTMLButtonElement).addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files?.[0];
      if (!f) return;
      const ok = store.importJSON(await f.text());
      if (ok) {
        state.selection.clear();
        docsPop.classList.add('hidden');
        invalidate();
      } else {
        fileInput.value = '';
        window.alert('Not a valid .zine file.');
      }
    });
  }

  docsBtn.addEventListener('click', () => {
    palettePop.classList.add('hidden');
    pagePop.classList.add('hidden');
    if (docsPop.classList.contains('hidden')) buildDocsPopover();
    docsPop.classList.toggle('hidden');
  });

  // ---------- presentation mode ----------
  const presentUi = root.querySelector('#present-ui') as HTMLElement;
  const presentCounter = root.querySelector('#present-counter') as HTMLElement;
  let presenting = false;
  let presentIndex = 0;

  /** Pages in spatial order: top-to-bottom rows, left-to-right within a row. */
  function sortedPages() {
    return [...store.doc.pages].sort((a, b) => {
      if (Math.abs(a.y - b.y) < Math.min(a.h, b.h) * 0.5) return a.x - b.x;
      return a.y - b.y;
    });
  }

  let animId = 0;
  function flyTo(cx: number, cy: number, zoom: number) {
    cancelAnimationFrame(animId);
    const from = { x: camera.x, y: camera.y, z: camera.zoom };
    const start = performance.now();
    const DUR = 380;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / DUR);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      camera.x = from.x + (cx - from.x) * e;
      camera.y = from.y + (cy - from.y) * e;
      camera.zoom = from.z + (zoom - from.z) * e;
      invalidate();
      if (t < 1) animId = requestAnimationFrame(step);
    };
    animId = requestAnimationFrame(step);
  }

  function showPage(i: number) {
    const pages = sortedPages();
    if (!pages.length) return;
    presentIndex = Math.max(0, Math.min(pages.length - 1, i));
    const p = pages[presentIndex];
    state.presentPage = p;
    const pad = 1.08;
    const zoom = Math.min(20, Math.min(window.innerWidth / (p.w * pad), window.innerHeight / (p.h * pad)));
    // No animation: page switches are instant cuts
    cancelAnimationFrame(animId);
    camera.x = p.x + p.w / 2;
    camera.y = p.y + p.h / 2;
    camera.zoom = zoom;
    invalidate();
    presentCounter.textContent = `${presentIndex + 1} / ${pages.length}`;
  }

  function setPresenting(on: boolean) {
    if (on && !store.doc.pages.length) return;
    presenting = on;
    state.presenting = on;
    document.body.classList.toggle('presenting', on);
    presentUi.classList.toggle('hidden', !on);
    invalidate();
    if (on) showPage(0);
  }

  (root.querySelector('#present') as HTMLButtonElement).addEventListener('click', () => setPresenting(true));
  state.onPagePreview = (page) => {
    setPresenting(true);
    const idx = sortedPages().findIndex((p) => p.id === page.id);
    if (idx >= 0) showPage(idx);
  };
  (root.querySelector('#present-exit') as HTMLButtonElement).addEventListener('click', () => setPresenting(false));
  (root.querySelector('#present-fwd') as HTMLButtonElement).addEventListener('click', () => showPage(presentIndex + 1));
  (root.querySelector('#present-back') as HTMLButtonElement).addEventListener('click', () => showPage(presentIndex - 1));
  (root.querySelector('#present-next') as HTMLElement).addEventListener('click', () => showPage(presentIndex + 1));
  (root.querySelector('#present-prev') as HTMLElement).addEventListener('click', () => showPage(presentIndex - 1));
  window.addEventListener('keydown', (e) => {
    if (!presenting) return;
    if (e.key === 'Escape') setPresenting(false);
    if (e.key === 'ArrowRight' || e.key === ' ') showPage(presentIndex + 1);
    if (e.key === 'ArrowLeft') showPage(presentIndex - 1);
  });

  (root.querySelector('#undo') as HTMLButtonElement).addEventListener('click', () => store.undo());
  (root.querySelector('#redo') as HTMLButtonElement).addEventListener('click', () => store.redo());

  const layerToggle = root.querySelector('#layer-toggle') as HTMLButtonElement;
  layerToggle.addEventListener('click', () => {
    state.paintBehind = !state.paintBehind;
    refresh();
  });

  const fingerToggle = root.querySelector('#finger-toggle') as HTMLButtonElement;
  // no fingers on a desktop — hide the toggle where there's no touch input
  if (navigator.maxTouchPoints === 0) fingerToggle.hidden = true;
  fingerToggle.addEventListener('click', () => {
    const order: (typeof state.fingerMode)[] = ['draw', 'pan', 'select'];
    state.fingerMode = order[(order.indexOf(state.fingerMode) + 1) % order.length];
    state.fingerDraws = state.fingerMode === 'draw';
    writePref(FINGER_KEY, state.fingerMode);
    refresh();
  });

  const zoomLockBtn = root.querySelector('#zoom-lock') as HTMLButtonElement;
  zoomLockBtn.addEventListener('click', () => {
    state.zoomLocked = !state.zoomLocked;
    writePref('infinizine-zoom-lock', state.zoomLocked ? '1' : '0');
    refresh();
    invalidate();
  });
  (root.querySelector('#zoom-100') as HTMLButtonElement).addEventListener('click', () => {
    camera.zoom = baseZoom();
    state.updateCursor();
    refresh();
    invalidate();
  });

  // Eagle view: fit all content in view; tap again to return where you were
  const eagleBtn = root.querySelector('#eagle') as HTMLButtonElement;
  let eaglePrev: { x: number; y: number; zoom: number } | null = null;
  eagleBtn.addEventListener('click', () => {
    const canvasEl = document.getElementById('canvas') as HTMLCanvasElement;
    if (eaglePrev) {
      camera.x = eaglePrev.x;
      camera.y = eaglePrev.y;
      camera.zoom = eaglePrev.zoom;
      eaglePrev = null;
      eagleBtn.classList.remove('on');
      state.updateCursor();
      invalidate();
      return;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const grow = (x1: number, y1: number, x2: number, y2: number) => {
      minX = Math.min(minX, x1); minY = Math.min(minY, y1);
      maxX = Math.max(maxX, x2); maxY = Math.max(maxY, y2);
    };
    for (const pg of store.doc.pages) grow(pg.x, pg.y, pg.x + pg.w, pg.y + pg.h);
    for (const a of store.doc.areas) grow(a.x, a.y, a.x + a.w, a.y + a.h);
    for (const el of store.doc.elements) {
      if (el.kind === 'text' || el.kind === 'image') grow(el.x, el.y, el.x + el.w, el.y + el.h);
      else for (const pt of el.points) grow(pt.x, pt.y, pt.x, pt.y);
    }
    if (minX === Infinity) return;
    eaglePrev = { x: camera.x, y: camera.y, zoom: camera.zoom };
    eagleBtn.classList.add('on');
    camera.x = (minX + maxX) / 2;
    camera.y = (minY + maxY) / 2;
    camera.zoom = Math.max(
      0.01,
      Math.min(canvasEl.clientWidth / (maxX - minX + 80), canvasEl.clientHeight / (maxY - minY + 80), 20),
    );
    state.updateCursor();
    invalidate();
  });

  const DRAW_TOOLS: Tool[] = ['pen', 'pencil', 'fineliner', 'marker', 'lasso-fill'];
  function refresh() {
    if (DRAW_TOOLS.includes(state.tool)) state.lastDrawTool = state.tool;
    state.updateCursor();
    for (const g of TOOL_GROUPS) {
      const activeInGroup = g.tools.includes(state.tool);
      if (activeInGroup) lastUsed[g.id] = state.tool;
      const shown = activeInGroup ? state.tool : lastUsed[g.id];
      const wrap = toolsEl.querySelector<HTMLElement>(`.tool-wrap[data-group="${g.id}"]`)!;
      const slot = wrap.querySelector<HTMLElement>('.tool-slot')!;
      slot.innerHTML = `<span class="tool-icon">${ICONS[shown]}</span>`;
      slot.title = `${TOOL_INFO[shown].label} (${TOOL_INFO[shown].key})`;
      slot.classList.toggle('active', activeInGroup);
      wrap.querySelectorAll<HTMLElement>('.tool-flyout .tool').forEach((b) =>
        b.classList.toggle('active', b.dataset.tool === state.tool),
      );
    }
    root.querySelectorAll<HTMLElement>('.size').forEach((b) =>
      b.classList.toggle('active', Number(b.dataset.w) === state.baseWidth),
    );
    (root.querySelector('#size-adaptive') as HTMLElement).classList.toggle('on', state.adaptiveSize);
    const sizeDot = root.querySelector('#size-dot') as HTMLElement;
    const d = Math.min(26, 3 + state.baseWidth * 3);
    sizeDot.style.width = `${d}px`;
    sizeDot.style.height = `${d}px`;
    (root.querySelector('#size-fader') as HTMLInputElement).value = String(state.baseWidth);
    const drama = getPalette(store.doc.palette).drama;
    palRow.querySelectorAll<HTMLElement>('.pal-main').forEach((d) => {
      const hue = d.dataset.hue!;
      const sh = shades(hue, drama);
      d.classList.toggle('active', hue === state.color || sh.includes(state.color));
      if (sh.includes(state.color) && hue !== state.color) d.style.background = state.color;
      else d.style.background = hue;
    });
    // Layer symbol: current-color stroke over / behind a white square
    const sq = '<rect x="8" y="8" width="10" height="10" fill="#fdfcf8" stroke="rgba(90,75,50,0.5)" stroke-width="1"/>';
    const st = `<path d="M4 20 C6 13 10 18 12 12 C14 6 18 11 20 4" fill="none" stroke="${state.color}" stroke-width="2.6" stroke-linecap="round"/>`;
    layerToggle.innerHTML = `<svg viewBox="0 0 24 24">${state.paintBehind ? st + sq : sq + st}</svg>`;
    layerToggle.title = state.paintBehind
      ? 'Painting behind existing ink (tap for in front)'
      : 'Painting in front (tap to paint behind)';
    fingerToggle.textContent =
      state.fingerMode === 'draw' ? '👆✏️' : state.fingerMode === 'pan' ? '👆✋' : '👆➰';
    fingerToggle.title =
      state.fingerMode === 'draw'
        ? 'Finger draws (tap: finger pans)'
        : state.fingerMode === 'pan'
          ? 'Finger pans, two fingers zoom (tap: finger selects)'
          : 'Finger selects, two fingers pan (tap: finger draws)';
    const lockBtn = root.querySelector('#zoom-lock') as HTMLButtonElement;
    lockBtn.innerHTML = state.zoomLocked
      ? svg('<rect x="5.5" y="10.5" width="13" height="9" rx="1.5"/><path d="M8.5 10.5 V8 a3.5 3.5 0 0 1 7 0 v2.5"/>')
      : svg('<rect x="5.5" y="10.5" width="13" height="9" rx="1.5"/><path d="M8.5 10.5 V8 a3.5 3.5 0 0 1 7 0"/>');
    lockBtn.title = state.zoomLocked
      ? 'Zoom locked — paint with what you\'ve got (tap to unlock)'
      : 'Zoom unlocked (tap to lock)';
    lockBtn.classList.toggle('on', state.zoomLocked);
  }

  state.updateCursor = () => {
    state.toolCursor = cursorFor(state.tool, camera.zoom, state.effectiveWidth(camera.zoom));
    (document.getElementById('canvas') as HTMLCanvasElement).style.cursor = state.toolCursor;
  };
  // ---------- toast notifications ----------
  const toastEl = document.createElement('div');
  toastEl.className = 'toast hidden';
  document.body.appendChild(toastEl);
  let toastTimer = 0;
  window.addEventListener('izine-toast', (e) => {
    toastEl.textContent = (e as CustomEvent<string>).detail;
    toastEl.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastEl.classList.add('hidden'), 1700);
  });

  // ---------- selection side menu (copy / cut / paste / delete) ----------
  const selMenu = document.createElement('div');
  selMenu.className = 'sel-menu hidden';
  selMenu.innerHTML = `
    <button id="sm-copy" title="Copy (⌘C)">${svg('<rect x="9" y="9" width="12" height="12" rx="1.5"/><path d="M5 15 H4.5 A1.5 1.5 0 0 1 3 13.5 V4.5 A1.5 1.5 0 0 1 4.5 3 H13.5 A1.5 1.5 0 0 1 15 4.5 V5"/>')}</button>
    <button id="sm-cut" title="Cut (⌘X)">${svg('<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M8.1 7.6 L20 19 M8.1 16.4 L20 5 M12 12 l2.5 2.4"/>')}</button>
    <button id="sm-paste" title="Paste (⌘V)">${svg('<rect x="5" y="4" width="14" height="17" rx="1.5"/><path d="M9 4 A3 3 0 0 1 15 4"/><path d="M9 12 h6 M9 16 h6"/>')}</button>
    <button id="sm-back" title="Send to back">${svg('<rect x="8" y="8" width="12" height="12" rx="1"/><path d="M4 12 V5.5 A1.5 1.5 0 0 1 5.5 4 H12"/><path d="M14 11 L14 17 M11.5 14.5 L14 17 L16.5 14.5"/>')}</button>
    <button id="sm-front" title="Bring to front">${svg('<rect x="4" y="4" width="12" height="12" rx="1"/><path d="M20 12 V18.5 A1.5 1.5 0 0 1 18.5 20 H12"/><path d="M10 13 L10 7 M7.5 9.5 L10 7 L12.5 9.5"/>')}</button>
    <button id="sm-del" title="Delete">${svg('<path d="M4 7 H20 M9 7 V5 A1 1 0 0 1 10 4 H14 A1 1 0 0 1 15 5 V7 M6.5 7 L7.5 20 H16.5 L17.5 7"/>')}</button>
  `;
  document.body.appendChild(selMenu);
  (selMenu.querySelector('#sm-copy') as HTMLButtonElement).addEventListener('click', actions.copy);
  (selMenu.querySelector('#sm-cut') as HTMLButtonElement).addEventListener('click', actions.cut);
  (selMenu.querySelector('#sm-paste') as HTMLButtonElement).addEventListener('click', actions.paste);
  (selMenu.querySelector('#sm-back') as HTMLButtonElement).addEventListener('click', () => {
    store.reorder([...state.selection], 'back');
    invalidate();
  });
  (selMenu.querySelector('#sm-front') as HTMLButtonElement).addEventListener('click', () => {
    store.reorder([...state.selection], 'front');
    invalidate();
  });
  (selMenu.querySelector('#sm-del') as HTMLButtonElement).addEventListener('click', () => {
    const els = store.doc.elements.filter((el) => state.selection.has(el.id));
    if (els.length) {
      state.selection.clear();
      store.deleteElements(els);
      invalidate();
    }
  });
  // visibility: selection/area gets copy-cut-delete; paste shows when clipboard holds zine content
  setInterval(() => {
    if (state.presenting) {
      selMenu.classList.add('hidden');
      return;
    }
    const hasSel = state.selection.size > 0;
    const hasArea = !!state.activeAreaId;
    // paste offer only while the clip hasn't been pasted yet — keeps the menu
    // out of the way once the clipboard content has landed somewhere
    let hasClip = false;
    try { hasClip = localStorage.getItem(CLIP_PENDING_KEY) === '1'; } catch { /* ignore */ }
    (selMenu.querySelector('#sm-copy') as HTMLButtonElement).hidden = !(hasSel || hasArea);
    (selMenu.querySelector('#sm-cut') as HTMLButtonElement).hidden = !(hasSel || hasArea);
    (selMenu.querySelector('#sm-del') as HTMLButtonElement).hidden = !hasSel;
    (selMenu.querySelector('#sm-back') as HTMLButtonElement).hidden = !hasSel;
    (selMenu.querySelector('#sm-front') as HTMLButtonElement).hidden = !hasSel;
    const pasteBtn = selMenu.querySelector('#sm-paste') as HTMLButtonElement;
    pasteBtn.hidden = !hasClip;
    pasteBtn.classList.toggle('badged', hasClip);
    selMenu.classList.toggle('hidden', !(hasSel || hasArea || hasClip));
  }, 300);

  // ---------- pressure playground: a modal with its own scratch canvas ----------
  const pg = document.createElement('div');
  pg.className = 'pg-modal hidden';
  type PTool = 'pen' | 'pencil' | 'sketch' | 'fineliner' | 'marker';
  const PG_TOOLS: { t: PTool; label: string }[] = [
    { t: 'pen', label: 'Pen' }, { t: 'pencil', label: 'Pencil' },
    { t: 'fineliner', label: 'Fineliner' }, { t: 'marker', label: 'Marker' },
  ];
  const isPTool = (t: Tool): t is PTool => PG_TOOLS.some((o) => o.t === t);
  let pgTool: PTool = isPTool(state.tool) ? state.tool : 'pen';
  type NumKey = 'smooth' | 'pSmooth' | 'min' | 'max' | 'tilt';
  const SLIDERS: { k: NumKey; label: string; min: number; max: number; step: number; fmt: (v: number) => string; markerToo?: boolean; pencilOnly?: boolean }[] = [
    { k: 'smooth', label: 'smoothing', min: 0, max: 6, step: 0.1, fmt: (v) => `${v.toFixed(1)}px`, markerToo: true },
    { k: 'pSmooth', label: 'pressure lp', min: 0.05, max: 1, step: 0.05, fmt: (v) => v.toFixed(2) },
    { k: 'min', label: 'min width', min: 0, max: 1, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%` },
    { k: 'max', label: 'max width', min: 0.5, max: 3, step: 0.05, fmt: (v) => `${v.toFixed(2)}×`, markerToo: true },
    { k: 'tilt', label: 'tilt width', min: 1, max: 40, step: 0.5, fmt: (v) => (v <= 1 ? 'off' : `${v.toFixed(1)}×`), pencilOnly: true },
  ];
  pg.innerHTML = `
    <div class="pg-top">
      <div class="pg-curve-wrap"><canvas class="pg-curve" id="pg-curve" title="Tap the curve to add a point · drag points and handles"></canvas></div>
      <div class="pg-curve-wrap" id="pg-tilt-wrap"><canvas class="pg-curve" id="pg-tilt" title="Tilt → widening (pencil)"></canvas></div>
    </div>
    <div class="pg-bottom">
      <div class="pg-stage"><canvas id="pg-canvas"></canvas>
        <div class="pg-stage-bar">
          <div class="pg-sizes">${SIZES.map((sz) => `<button class="pg-size" data-w="${sz.w}" title="${sz.label}"><i style="width:${3 + sz.w * 3}px;height:${3 + sz.w * 3}px"></i></button>`).join('')}</div>
          <button id="pg-clear">Clear</button>
        </div>
      </div>
      <div class="pg-side">
        <div class="pg-head"><span>Pressure playground</span><button class="pg-x" id="pg-close">×</button></div>
        <div class="pg-tools">${PG_TOOLS.map((o) => `<button class="pg-tool" data-t="${o.t}">${ICONS[o.t]}<span>${o.label}</span></button>`).join('')}</div>
        ${SLIDERS.map((sl) => `<label class="pg-row" data-k="${sl.k}"><span>${sl.label}</span><input type="range" data-k="${sl.k}" min="${sl.min}" max="${sl.max}" step="${sl.step}"><b></b></label>`).join('')}
        <div class="pg-actions">
          <button id="pg-save" class="pg-primary">Save</button>
          <button id="pg-reset">Reset to default</button>
        </div>
        <div class="pg-actions">
          <button id="pg-export" title="Download + copy all brush settings as JSON">Export brushes</button>
          <button id="pg-import" title="Load a brush settings JSON">Import…</button>
          <input type="file" id="pg-import-file" accept="application/json,.json" hidden>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(pg);

  // the scratch rig: its own store (never persisted), camera, input state, renderer
  const rigCanvas = pg.querySelector('#pg-canvas') as HTMLCanvasElement;
  const rigStore = new Store({ ephemeral: true });
  const rigCamera = new Camera();
  const rigState = new InputState();
  rigState.zoomLocked = true;
  const rigRenderer = new Renderer(rigCanvas, rigStore, rigCamera, rigState);
  const rigInput = attachInput(rigCanvas, rigCamera, rigStore, rigState, () => rigRenderer.invalidate(), 'modal');
  rigInput.setDropCache((id) => rigRenderer.dropFromCache(id));
  rigStore.onChange = () => { rigRenderer.clearCache(); rigRenderer.invalidate(); };
  rigState.updateCursor = () => { rigCanvas.style.cursor = cursorFor(rigState.tool, rigCamera.zoom, rigState.effectiveWidth(rigCamera.zoom)); };
  window.addEventListener('izine-restyle', () => { rigRenderer.clearCache(); rigRenderer.invalidate(); });

  let pgSaved = structuredClone(pressure); // what's on disk; unsaved edits revert to this on close
  const pgDirty = () => JSON.stringify(pgSaved) !== JSON.stringify(pressure);
  const pgCurve = pg.querySelector('#pg-curve') as HTMLCanvasElement;
  // ---- piecewise Bézier curve editor (pressure → effect, tilt → widening) ----
  // tap the curve to add an anchor · tap an anchor to select it (shows its two
  // handles) · drag anchors/handles · bar below: smooth⇄corner, delete
  const PAD = 12;
  function curveEditor(
    cv: HTMLCanvasElement,
    getCurve: () => Curve,
    labels: { x: string; y: string; readout: (fx: (t: number) => number) => string },
    band?: () => ((t: number) => number) | null,
  ) {
    const bar = document.createElement('div');
    bar.className = 'pg-curve-bar';
    bar.innerHTML = `<button data-act="smooth"></button><button data-act="delete">Delete point</button><span class="pg-curve-tip">tap the curve to add a point · handles may leave the box</span>`;
    cv.insertAdjacentElement('afterend', bar);
    let sel: number | null = null; // selected anchor index
    // the unit box sits inside a wider visible domain so handles can overshoot
    const LO = -0.35, SPAN = 1.7;
    let W = 0, H = 0; // CSS px, set on draw
    const toPx = (x: number, y: number): [number, number] => [
      PAD + (W - 2 * PAD) * ((x - LO) / SPAN),
      H - PAD - (H - 2 * PAD) * ((y - LO) / SPAN),
    ];
    const fromPx = (px: number, py: number) => ({
      x: LO + SPAN * ((px - PAD) / (W - 2 * PAD)),
      y: LO + SPAN * ((H - PAD - py) / (H - 2 * PAD)),
    });
    const fx = (t: number) => curveAt(getCurve(), t);
    const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
    function draw() {
      const dpr = window.devicePixelRatio || 1;
      W = cv.clientWidth; H = cv.clientHeight;
      if (!W || !H) return;
      if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
        cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      }
      const c = cv.getContext('2d')!;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      const curve = getCurve();
      if (sel !== null && sel >= curve.length) sel = null;
      c.clearRect(0, 0, W, H);
      // unit box
      const [bx0, by1] = toPx(0, 0), [bx1, by0] = toPx(1, 1);
      c.fillStyle = 'rgba(255,255,255,0.55)';
      c.fillRect(bx0, by0, bx1 - bx0, by1 - by0);
      c.strokeStyle = 'rgba(42,36,26,0.18)';
      c.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const [x] = toPx(i / 4, 0), [, y] = toPx(0, i / 4);
        c.beginPath(); c.moveTo(x, by0); c.lineTo(x, by1); c.stroke();
        c.beginPath(); c.moveTo(bx0, y); c.lineTo(bx1, y); c.stroke();
      }
      c.strokeStyle = 'rgba(42,36,26,0.5)';
      c.strokeRect(bx0, by0, bx1 - bx0, by1 - by0);
      const bandFn = band?.();
      if (bandFn) {
        c.fillStyle = 'rgba(42,36,26,0.08)';
        c.beginPath();
        for (let i = 0; i <= 100; i++) {
          const [x, y] = toPx(i / 100, bandFn(i / 100));
          i ? c.lineTo(x, y) : c.moveTo(x, y);
        }
        c.lineTo(...toPx(1, 0)); c.lineTo(...toPx(0, 0)); c.closePath(); c.fill();
      }
      // curve
      c.strokeStyle = '#2a241a';
      c.lineWidth = 2.5;
      c.beginPath();
      for (let i = 0; i <= 120; i++) {
        const [x, y] = toPx(i / 120, fx(i / 120));
        i ? c.lineTo(x, y) : c.moveTo(x, y);
      }
      c.stroke();
      // handles: endpoints always, plus the selected anchor
      const showHandles = (k: number) => k === 0 || k === curve.length - 1 || k === sel;
      curve.forEach((n, k) => {
        if (!showHandles(n && k)) return;
        const [ax, ay] = toPx(n.x, n.y);
        c.strokeStyle = 'rgba(224,90,40,0.7)';
        c.lineWidth = 1.5;
        for (const h of [k > 0 ? n.i : null, k < curve.length - 1 ? n.o : null]) {
          if (!h) continue;
          const [hx, hy] = toPx(n.x + h[0], n.y + h[1]);
          c.beginPath(); c.moveTo(ax, ay); c.lineTo(hx, hy); c.stroke();
          c.fillStyle = '#E05A28'; c.strokeStyle = '#fff'; c.lineWidth = 2;
          c.beginPath(); c.arc(hx, hy, 6.5, 0, Math.PI * 2); c.fill(); c.stroke();
        }
      });
      // anchors
      curve.forEach((n, k) => {
        const [ax, ay] = toPx(n.x, n.y);
        const inner = k > 0 && k < curve.length - 1;
        c.fillStyle = k === sel ? '#2a241a' : '#fff';
        c.strokeStyle = '#2a241a';
        c.lineWidth = 2;
        c.beginPath();
        if (inner && !n.s) c.rect(ax - 5.5, ay - 5.5, 11, 11); // corner = square
        else c.arc(ax, ay, inner ? 6 : 5, 0, Math.PI * 2);
        c.fill(); c.stroke();
      });
      c.fillStyle = 'rgba(42,36,26,0.7)';
      c.font = '11px Libre Franklin, sans-serif';
      c.fillText(labels.x, bx0, by1 + 14);
      c.save(); c.translate(bx0 - 6, by1); c.rotate(-Math.PI / 2); c.fillText(labels.y, 0, 0); c.restore();
      const ro = labels.readout(fx);
      c.font = '12px Libre Franklin, sans-serif';
      c.fillText(ro, bx1 - c.measureText(ro).width, by0 - 6);
      // bar
      const inner = sel !== null && sel > 0 && sel < curve.length - 1;
      bar.classList.toggle('active', inner);
      if (inner) (bar.querySelector('[data-act="smooth"]') as HTMLButtonElement).textContent = curve[sel!].s ? 'Smooth → corner' : 'Corner → smooth';
    }
    // ---- interaction ----
    type Hit = { kind: 'anchor'; k: number } | { kind: 'handle'; k: number; h: 'i' | 'o' } | { kind: 'curve'; x: number } | null;
    const pos = (e: PointerEvent) => {
      const r = cv.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      return { ...fromPx(px, py), px, py };
    };
    function hitTest(px: number, py: number): Hit {
      const curve = getCurve();
      const d = (x: number, y: number) => { const [a, b] = toPx(x, y); return Math.hypot(px - a, py - b); };
      const R = 16;
      // handles of the visible anchors first (they sit on top)
      for (let k = 0; k < curve.length; k++) {
        if (!(k === 0 || k === curve.length - 1 || k === sel)) continue;
        const n = curve[k];
        if (k > 0 && d(n.x + n.i[0], n.y + n.i[1]) < R) return { kind: 'handle', k, h: 'i' };
        if (k < curve.length - 1 && d(n.x + n.o[0], n.y + n.o[1]) < R) return { kind: 'handle', k, h: 'o' };
      }
      for (let k = 0; k < curve.length; k++) if (d(curve[k].x, curve[k].y) < R) return { kind: 'anchor', k };
      // on the curve?
      const x = clamp01(fromPx(px, py).x);
      if (d(x, fx(x)) < 14) return { kind: 'curve', x };
      return null;
    }
    let drag: Hit = null;
    let downAt = 0;
    let lastTap = { t: 0, k: -1 };
    cv.addEventListener('pointerdown', (e) => {
      const { px, py } = pos(e);
      const hit = hitTest(px, py);
      const curve = getCurve();
      downAt = performance.now();
      if (hit?.kind === 'curve') {
        // insert an anchor on the curve, smooth, tangent along the curve
        const x = hit.x, y = fx(x);
        let k = 0;
        while (k < curve.length - 1 && curve[k + 1].x < x) k++;
        const a = curve[k], b = curve[k + 1];
        const dx = Math.min(x - a.x, b.x - x) * 0.4;
        const slope = (fx(Math.min(1, x + 0.01)) - fx(Math.max(0, x - 0.01))) / 0.02;
        const node: CurveNode = { x, y, i: [-dx, -dx * slope], o: [dx, dx * slope], s: true };
        // shorten neighbours' handles so they don't overshoot the new anchor
        a.o = [Math.min(a.o[0], (x - a.x) * 0.9), a.o[1]];
        b.i = [Math.max(b.i[0], (x - b.x) * 0.9), b.i[1]];
        curve.splice(k + 1, 0, node);
        sel = k + 1;
        drag = { kind: 'anchor', k: sel };
        cv.setPointerCapture(e.pointerId);
        restyle();
        return;
      }
      if (hit?.kind === 'anchor') {
        const now = performance.now();
        if (lastTap.k === hit.k && now - lastTap.t < 350 && hit.k > 0 && hit.k < curve.length - 1) {
          curve.splice(hit.k, 1); sel = null; drag = null; lastTap = { t: 0, k: -1 };
          restyle();
          return;
        }
        lastTap = { t: now, k: hit.k };
        sel = hit.k;
      }
      drag = hit;
      if (drag) { cv.setPointerCapture(e.pointerId); e.preventDefault(); }
      else sel = null;
      draw();
    });
    cv.addEventListener('pointermove', (e) => {
      if (!drag || drag.kind === 'curve') return;
      const curve = getCurve();
      const { x, y } = pos(e);
      if (drag.kind === 'anchor') {
        const k = drag.k;
        if (k === 0 || k === curve.length - 1) return; // endpoints are fixed
        const n = curve[k];
        n.x = Math.max(curve[k - 1].x + 0.01, Math.min(curve[k + 1].x - 0.01, x));
        n.y = clamp01(y);
      } else {
        const n = curve[drag.k];
        // handle x is clamped between its anchor and the neighbour so x(t) stays monotone
        const lo = drag.h === 'i' ? curve[drag.k - 1].x : n.x;
        const hi = drag.h === 'o' ? curve[drag.k + 1].x : n.x;
        const hx = Math.max(lo, Math.min(hi, x)) - n.x;
        const hy = Math.max(LO, Math.min(LO + SPAN, y)) - n.y; // may leave the unit box
        n[drag.h] = [hx, hy];
        if (n.s && drag.k > 0 && drag.k < curve.length - 1) {
          // smooth: mirror direction onto the other handle, keep its own length
          const other = drag.h === 'i' ? 'o' : 'i';
          const len = Math.hypot(n[other][0], n[other][1]) || Math.hypot(hx, hy);
          const l = Math.hypot(hx, hy) || 1;
          let mx = (-hx / l) * len, my = (-hy / l) * len;
          const olo = other === 'i' ? curve[drag.k - 1].x : n.x;
          const ohi = other === 'o' ? curve[drag.k + 1].x : n.x;
          mx = Math.max(olo, Math.min(ohi, n.x + mx)) - n.x;
          n[other] = [mx, my];
        }
      }
      restyle();
    });
    const end = () => { drag = null; };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    bar.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest('button')?.dataset.act;
      const curve = getCurve();
      if (sel === null || sel <= 0 || sel >= curve.length - 1) return;
      const k = sel;
      if (act === 'delete') { curve.splice(k, 1); sel = null; }
      if (act === 'smooth') {
        const n = curve[k];
        n.s = !n.s;
        if (n.s) { const l = Math.hypot(n.o[0], n.o[1]) || 0.05; const li = Math.hypot(n.i[0], n.i[1]) || l; n.i = [(-n.o[0] / l) * li, (-n.o[1] / l) * li]; }
      }
      restyle();
    });
    return { draw, deselect: () => { sel = null; } };
  }
  const pressureEditor = curveEditor(
    pgCurve,
    () => pressure[pgTool].curve,
    { x: 'pressure →', y: 'effect →', readout: (fx) => `${pgTool} · 50% → ${Math.round(fx(0.5) * 100)}%` },
    () => {
      const k = pressure[pgTool];
      return pgTool === 'marker' ? null : (t: number) => k.min + (1 - k.min) * easeP(t, pgTool);
    },
  );
  const pgTiltCv = pg.querySelector('#pg-tilt') as HTMLCanvasElement;
  const tiltEditor = curveEditor(
    pgTiltCv,
    () => pressure[pgTool].tiltCurve,
    { x: 'tilt (upright → flat) →', y: 'widening →', readout: (fx) => `45° → ${Math.round(fx(0.5) * 100)}%` },
  );
  function drawCurve() {
    (pg.querySelector('#pg-tilt-wrap') as HTMLElement).hidden = pgTool !== 'pencil';
    // layout may have changed (tilt panel shown/hidden) → size canvases after reflow
    requestAnimationFrame(() => {
      pressureEditor.draw();
      if (pgTool === 'pencil') tiltEditor.draw();
    });
  }
  window.addEventListener('resize', () => { if (!pg.classList.contains('hidden')) drawCurve(); });

  function syncPg() {
    const k = pressure[pgTool];
    pgCurve.style.opacity = pgTool === 'marker' ? '0.35' : '1';
    for (const sl of SLIDERS) {
      const row = pg.querySelector(`.pg-row[data-k="${sl.k}"]`) as HTMLElement;
      row.hidden = (pgTool === 'marker' && !sl.markerToo) || (!!sl.pencilOnly && pgTool !== 'pencil');
      (row.querySelector('input') as HTMLInputElement).value = String(k[sl.k]);
      (row.querySelector('b') as HTMLElement).textContent = sl.fmt(k[sl.k]);
    }
    pg.querySelectorAll<HTMLElement>('.pg-tool').forEach((b) => b.classList.toggle('active', b.dataset.t === pgTool));
    // mark the preset nearest to the rig's current size
    const nearest = SIZES.reduce((a, b) => (Math.abs(b.w - rigState.baseWidth) < Math.abs(a.w - rigState.baseWidth) ? b : a)).w;
    pg.querySelectorAll<HTMLElement>('.pg-size').forEach((b) => b.classList.toggle('active', Number(b.dataset.w) === nearest));
    const dirty = pgDirty();
    (pg.querySelector('#pg-save') as HTMLButtonElement).disabled = !dirty;
    (pg.querySelector('.pg-head span') as HTMLElement).textContent = dirty ? 'Pressure playground · unsaved' : 'Pressure playground';
    drawCurve();
  }
  const restyle = () => {
    syncPg();
    window.dispatchEvent(new Event('izine-restyle'));
  };
  (pg.querySelector('#pg-save') as HTMLButtonElement).addEventListener('click', () => {
    savePressure();
    pgSaved = structuredClone(pressure);
    syncPg();
    toast('Pressure settings saved');
  });
  pg.querySelectorAll<HTMLInputElement>('.pg-row input').forEach((inp) =>
    inp.addEventListener('input', () => {
      pressure[pgTool][inp.dataset.k as NumKey] = Number(inp.value);
      restyle();
    }),
  );
  pg.querySelectorAll<HTMLElement>('.pg-tool').forEach((b) =>
    b.addEventListener('click', () => {
      pgTool = b.dataset.t as PTool;
      pressureEditor.deselect(); tiltEditor.deselect();
      rigState.tool = pgTool;
      rigState.lastDrawTool = pgTool;
      rigState.updateCursor();
      syncPg();
    }),
  );
  pg.querySelectorAll<HTMLElement>('.pg-size').forEach((b) =>
    b.addEventListener('click', () => {
      rigState.baseWidth = Number(b.dataset.w);
      rigState.updateCursor();
      syncPg();
    }),
  );
  (pg.querySelector('#pg-clear') as HTMLButtonElement).addEventListener('click', () => {
    rigState.selection.clear();
    rigStore.deleteElements([...rigStore.doc.elements]);
  });
  (pg.querySelector('#pg-reset') as HTMLButtonElement).addEventListener('click', () => {
    resetPressure(pgTool);
    restyle();
  });
  (pg.querySelector('#pg-export') as HTMLButtonElement).addEventListener('click', () => {
    const json = exportPressure();
    navigator.clipboard?.writeText(json).catch(() => {});
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'infinizine-brushes.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('Brush settings exported (also copied to clipboard)');
  });
  const importFile = pg.querySelector('#pg-import-file') as HTMLInputElement;
  (pg.querySelector('#pg-import') as HTMLButtonElement).addEventListener('click', () => importFile.click());
  importFile.addEventListener('change', async () => {
    const f = importFile.files?.[0];
    importFile.value = '';
    if (!f) return;
    if (importPressure(await f.text())) {
      restyle();
      toast('Brush settings loaded — Save to keep them');
    } else {
      toast('Not a brush settings file');
    }
  });
  const pgBtn = root.querySelector('#playground') as HTMLButtonElement;
  const togglePg = (open: boolean) => {
    if (!open && pgDirty()) {
      loadPressure(pgSaved); // unsaved edits are dropped
      window.dispatchEvent(new Event('izine-restyle'));
      toast('Unsaved pressure changes reverted');
    }
    pg.classList.toggle('hidden', !open);
    pgBtn.classList.toggle('on', open);
    setModalOpen(open);
    if (open) {
      pgSaved = structuredClone(pressure);
      if (isPTool(state.tool)) pgTool = state.tool;
      rigState.tool = pgTool;
      rigState.lastDrawTool = pgTool;
      rigState.color = state.color;
      rigState.baseWidth = state.baseWidth;
      rigState.adaptiveSize = state.adaptiveSize;
      rigStore.doc.paper = store.doc.paper;
      rigStore.doc.pattern = store.doc.pattern;
      rigStore.doc.palette = store.doc.palette;
      rigCamera.zoom = baseZoomFn();
      rigCamera.x = 0; rigCamera.y = 0;
      rigState.updateCursor();
      rigRenderer.clearCache();
      requestAnimationFrame(() => rigRenderer.invalidate());
      syncPg();
    }
  };
  pgBtn.addEventListener('click', () => togglePg(pg.classList.contains('hidden')));
  (pg.querySelector('#pg-close') as HTMLButtonElement).addEventListener('click', () => togglePg(false));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pg.classList.contains('hidden')) togglePg(false);
  });

  state.onToolChange = refresh;
  buildPalRow();

  // keeps the timeline in sync after undo/redo or external changes
  return {
    docChanged() {
      if (tlAreaId && !tl.classList.contains('hidden')) renderTimeline();
    },
  };
}
