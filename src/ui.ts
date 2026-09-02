// Toolbar, palette popover, page menu. Plain DOM, stationery-shop styling in style.css.

import { InputState, Tool } from './input';
import { Store } from './store';
import { Camera } from './camera';
import { PALETTES, getPalette, shades } from './palettes';
import { UNITS_PER_MM, uid } from './types';
import { layoutText, layoutHeight, FONTS } from './text';
import { markdownToHtml, htmlToMarkdown, autoTransform, caretToEnd } from './richedit';

const svg = (inner: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

const ICON_PATHS: Record<string, string> = {
  pen: '<path d="M12 3 L16.5 12.5 C16.5 16.5 14.5 18.8 12 21 C9.5 18.8 7.5 16.5 7.5 12.5 Z"/><path d="M12 12.5 V17"/><circle cx="12" cy="11" r="1.1"/>',
  fineliner: '<path d="M4.5 19.5 L6 15 L16.5 4.5 L19.5 7.5 L9 18 Z"/><path d="M15 6 L18 9"/>',
  marker: '<path d="M9 15 L4.5 19.5"/><path d="M14 4 L20 10 L11 17 L7 13 Z"/><path d="M12.5 5.5 L18.5 11.5"/>',
  'lasso-fill': '<path d="M12 3.5 C12 3.5 6 10.5 6 14.5 A6 6 0 0 0 18 14.5 C18 10.5 12 3.5 12 3.5 Z"/>',
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
  if (tool === 'pen' || tool === 'fineliner' || tool === 'marker' || tool === 'eraser') {
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
  { id: 'draw', tools: ['pen', 'fineliner', 'marker', 'lasso-fill'] },
  { id: 'eraser', tools: ['eraser'] },
  { id: 'select', tools: ['cursor', 'lasso-select', 'hand'] },
  { id: 'text', tools: ['text'] },
  { id: 'anim', tools: ['anim'] },
];

const SIZES = [
  { w: 2, label: 'S' },
  { w: 3.5, label: 'M' },
  { w: 6, label: 'L' },
];

interface Fmt { label: string; w: number; h: number } // w/h in world units (2/mm)
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
  { label: 'Screen 16:9', ...mm(240, 135) },
  { label: 'Screen 4:3', ...mm(240, 180) },
];

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
) {
  root.innerHTML = `
    <header class="topbar">
      <div class="wordmark">INFINI<span class="zine"><i>Z</i><i>I</i><i>N</i><i>E</i></span></div>
      <div class="top-actions">
        <button class="chip" id="docs" title="My zines">${svg('<path d="M4 7 V19 A1.5 1.5 0 0 0 5.5 20.5 H18.5 A1.5 1.5 0 0 0 20 19 V9.5 A1.5 1.5 0 0 0 18.5 8 H12 L10 5.5 H5.5 A1.5 1.5 0 0 0 4 7 Z"/>')}</button>
        <button class="chip" id="undo" title="Undo (⌘Z)">↩</button>
        <button class="chip" id="redo" title="Redo (⇧⌘Z)">↪</button>
        <button class="chip" id="finger-toggle" title="Finger drawing"></button>
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
    toolsEl.querySelectorAll('.tool-wrap.open').forEach((w) => w.classList.remove('open'));

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
  for (const s of SIZES) {
    const b = document.createElement('button');
    b.className = 'size';
    b.dataset.w = String(s.w);
    b.innerHTML = `<i style="width:${4 + s.w * 2}px;height:${4 + s.w * 2}px"></i>`;
    b.title = s.label;
    b.addEventListener('click', () => {
      state.baseWidth = s.w;
      refresh();
    });
    sizesEl.appendChild(b);
  }

  const palRow = root.querySelector('#pal-row') as HTMLElement;
  const palMore = root.querySelector('#pal-more') as HTMLButtonElement;
  const palettePop = root.querySelector('#palette-popover') as HTMLElement;
  const pagePop = root.querySelector('#page-popover') as HTMLElement;

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
    `;
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
    hidePageMenu();
    openFormatPanel((f) => store.setPagesFormat(f));
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

  function closeTimeline() {
    tlAreaId = null;
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
    state.activeAreaId = area.id;
    const top = area.layers[area.layers.length - 1];
    state.activeLayerId = top?.id ?? null;
    state.activeFrameId = top?.frames[0]?.id ?? null;
    tl.classList.remove('hidden');
    renderTimeline();
    invalidate();
  };

  // dragging the window
  let tlDrag: { x: number; y: number } | null = null;
  tl.addEventListener('pointerdown', (e) => {
    const head = (e.target as HTMLElement).closest('.tl-grip');
    if (!head) return;
    tlDrag = { x: e.clientX - tl.offsetLeft, y: e.clientY - tl.offsetTop };
    tl.setPointerCapture(e.pointerId);
  });
  tl.addEventListener('pointermove', (e) => {
    if (!tlDrag) return;
    tl.style.left = `${e.clientX - tlDrag.x}px`;
    tl.style.top = `${e.clientY - tlDrag.y}px`;
    tl.style.bottom = 'auto';
    tl.style.right = 'auto';
  });
  tl.addEventListener('pointerup', () => { tlDrag = null; });

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
    const total = Math.max(1, ...area.layers.map((l) => l.frames.reduce((a, f) => a + f.duration, 0)));
    // the clock depends on the tab: keyframe loop vs longest live line
    let clockTicks = total;
    if (tlView === 'live') {
      let maxCycle = 1;
      for (const l of area.layers) {
        if (l.kind !== 'live') continue;
        if (l.liveMode === 'additive') { maxCycle = Math.max(maxCycle, total); continue; }
        for (const st of store.doc.elements) {
          if (st.kind !== 'stroke' || st.alayer !== l.id) continue;
          const drawn = (st.points[st.points.length - 1]?.t ?? 0) * area.fps;
          maxCycle = Math.max(maxCycle, Math.ceil(drawn + (st.animLife ?? 6)));
        }
      }
      clockTicks = maxCycle;
    }
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
      const strokes = store.doc.elements.filter((e) => e.kind === 'stroke' && e.alayer === l.id);
      let ticks: number;
      if (l.liveMode === 'additive') {
        ticks = tick % total;
      } else {
        const st = strokes[0];
        if (st && st.kind === 'stroke') {
          const drawn = (st.points[st.points.length - 1]?.t ?? 0) * area.fps;
          const cycle = Math.max(1, Math.ceil(drawn + (st.animLife ?? 6)));
          ticks = (((rawTick - (st.animStart ?? 0)) % cycle) + cycle) % cycle;
        } else {
          ticks = 0;
        }
      }
      prog.style.display = 'block';
      prog.style.left = `${Math.max(0, Math.min(bar.clientWidth - 3, ticks * scale))}px`;
    }
    playheadRaf = requestAnimationFrame(playheadLoop);
  }

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
    tl.innerHTML = `
      <div class="tl-head">
        <span class="tl-grip" title="Drag to move">⠿</span>
        <span class="tl-name" title="Double-click to rename">${area.name}</span>
        <button id="tl-play" title="Play/pause">${state.playingAreas ? '⏸' : '▶'}</button>
        <span class="tl-time" id="tl-time"></span>
        <input id="tl-fps" type="number" min="1" max="60" value="${area.fps}" title="fps"><span class="tl-fpslabel">fps</span>
        <button id="tl-loop" class="tl-toggle ${area.loop ? 'on' : ''}">loop</button>
        <button id="tl-clip" class="tl-toggle ${area.clip ? 'on' : ''}" title="Cut off ink outside the area">clip</button>
        <button id="tl-onion" class="tl-toggle ${state.onionSkin ? 'on' : ''}">onion</button>
        <button id="tl-delarea" title="Delete area">🗑</button>
        <button id="tl-close" title="Close">✕</button>
      </div>
      <div class="tl-tabs">
        <button id="tl-tab-frames" class="${tlView === 'frames' ? 'on' : ''}">keyframes</button>
        <button id="tl-tab-live" class="${tlView === 'live' ? 'on' : ''}">live lines</button>
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
        <span class="tl-layers-label" title="Strokes drawn while playing">live ink</span>
        <button id="tl-life-minus" title="Shorter life">−</button>
        <span class="tl-life" id="tl-life">${state.liveInkLife}f</span>
        <button id="tl-life-plus" title="Longer life">＋</button>
        <button id="tl-taper" class="tl-toggle ${state.liveInkTaper ? 'on' : ''}" title="Tail eats away over its life">taper</button>
        <button id="tl-mode" class="tl-toggle on" title="Recording mode: additive overdubs the loop, continuous replays full length">${state.liveInkMode === 'additive' ? 'add' : 'cont'}</button>
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

    // one track per layer (top layer first), each with its own frame strip
    const tracksEl = tl.querySelector('#tl-tracks')!;
    const filledFrames = new Set(store.doc.elements.map((e) => e.frame).filter(Boolean));
    // live view: one shared time scale so every playhead moves at the same speed
    const areaTotalAll = Math.max(
      1,
      ...area.layers.filter((x) => x.kind !== 'live').map((x) => x.frames.reduce((acc, f) => acc + f.duration, 0)),
    );
    const layerCycle = (l: (typeof area.layers)[number]): number => {
      if (l.liveMode === 'additive') return areaTotalAll;
      let cycle = 1;
      for (const st of store.doc.elements) {
        if (st.kind !== 'stroke' || st.alayer !== l.id) continue;
        const drawn = (st.points[st.points.length - 1]?.t ?? 0) * area.fps;
        cycle = Math.max(cycle, Math.ceil(drawn + (st.animLife ?? 6)));
      }
      return cycle;
    };
    const maxCycle = Math.max(areaTotalAll, ...area.layers.filter((l) => l.kind === 'live').map(layerCycle));
    const liveScale = Math.max(2, Math.min(30, 340 / Math.max(1, maxCycle)));
    [...area.layers].reverse()
      .filter((l) => (tlView === 'live') === (l.kind === 'live'))
      .forEach((l) => {
      const idx = area.layers.indexOf(l);
      const row = document.createElement('div');
      row.className = `tl-track${l.id === lid ? ' active' : ''}`;

      const head = document.createElement('div');
      head.className = `tl-track-head${l.hidden ? ' layer-hidden' : ''}`;
      const liveColor =
        l.kind === 'live'
          ? (store.doc.elements.find((e) => e.kind === 'stroke' && e.alayer === l.id)?.color ?? '#7048e8')
          : '';
      head.innerHTML = `${
        l.kind === 'live'
          ? `<span class="tl-ldot" style="background:${liveColor}"></span>`
          : `<span class="tl-lname">${l.name}</span>`
      }
        ${l.kind === 'live' ? `<button data-a="mode" class="tl-mode" title="Toggle additive/continuous">${l.liveMode === 'additive' ? 'add' : 'cont'}</button><button data-a="bake" class="tl-mode" title="Convert to keyframes">bake</button>` : ''}
        <button data-a="eye" title="${l.hidden ? 'Show layer' : 'Hide layer'}">${
          l.hidden
            ? svg('<path d="M4 5 L20 19"/><path d="M3 12 C6 7 9 5.5 12 5.5 C15 5.5 18 7 21 12 C19.5 14.5 17.8 16.2 16 17.2 M9.5 17.9 C7.2 17.1 5 15.2 3 12"/>')
            : svg('<path d="M3 12 C6 6.8 9 5 12 5 C15 5 18 6.8 21 12 C18 17.2 15 19 12 19 C9 19 6 17.2 3 12 Z"/><circle cx="12" cy="12" r="3"/>')
        }</button>
        <button data-a="up" title="Layer up">↑</button>
        <button data-a="down" title="Layer down">↓</button>
        <button data-a="del" title="Delete layer">✕</button>`;
      head.querySelector('.tl-lname')?.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        inlineRename(e.target as HTMLElement, l.name, (v) => store.renameAnimLayer(area.id, l.id, v));
      });
      head.addEventListener('click', (e) => {
        const a = (e.target as HTMLElement).closest('button')?.dataset?.a;
        if (a === 'bake') {
          store.convertLiveLayer(area.id, l.id);
          tlView = 'frames';
        } else if (a === 'mode') store.setLiveMode(area.id, l.id, l.liveMode === 'additive' ? 'continuous' : 'additive');
        else if (a === 'eye') store.setLayerHidden(area.id, l.id, !l.hidden);
        else if (a === 'up') store.moveAnimLayer(area.id, idx, idx + 1);
        else if (a === 'down') store.moveAnimLayer(area.id, idx, idx - 1);
        else if (a === 'del') store.deleteAnimLayer(area.id, l.id);
        else {
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
        const additive = l.liveMode === 'additive';
        const cycle = layerCycle(l);
        const bar = document.createElement('div');
        bar.className = 'tl-livebar';
        bar.dataset.lid = l.id;
        bar.dataset.scale = String(liveScale);
        bar.style.width = `${Math.max(24, cycle * liveScale)}px`;
        // phase offset only matters relative to the area loop (additive layers);
        // continuous lines all start at 0 so widths read as durations
        if (additive) {
          const firstStroke = strokes[0];
          const phase = firstStroke?.kind === 'stroke' ? (firstStroke.animStart ?? 0) : 0;
          bar.style.marginLeft = `${Math.max(0, (((phase % areaTotalAll) + areaTotalAll) % areaTotalAll) * liveScale)}px`;
        }
        const inkColor = (strokes[0]?.color as string) ?? '#7048e8';
        bar.style.background = inkColor;
        const n = parseInt(inkColor.slice(1), 16) || 0;
        const lum = ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114;
        bar.style.color = lum < 140 ? '#fff' : '#2a241a';
        bar.textContent = `${strokes.length > 1 ? `✒${strokes.length} · ` : ''}${(cycle / area.fps).toFixed(1)}s${additive ? ' · loop' : ''}`;
        const prog = document.createElement('div');
        prog.className = 'tl-liveprog';
        bar.appendChild(prog); // after textContent — that assignment clears children
        bar.title = additive
          ? 'Additive live ink: overdubs stack onto the area loop'
          : 'Continuous live ink: replays its full length, then restarts';
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
        b.style.width = `${30 + (f.duration - 1) * 30}px`;
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
    (tl.querySelector('.tl-tracks') as HTMLElement).scrollTop = prevScroll;
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
    on('#tl-mode', () => {
      state.liveInkMode = state.liveInkMode === 'additive' ? 'continuous' : 'additive';
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
  fingerToggle.addEventListener('click', () => {
    state.fingerDraws = !state.fingerDraws;
    refresh();
  });

  const DRAW_TOOLS: Tool[] = ['pen', 'fineliner', 'marker', 'lasso-fill'];
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
    fingerToggle.textContent = state.fingerDraws ? '👆✏️' : '👆🚫';
    fingerToggle.title = state.fingerDraws
      ? 'Finger draws (tap to make fingers pan only)'
      : 'Fingers pan only (tap to let fingers draw)';
  }

  state.updateCursor = () => {
    state.toolCursor = cursorFor(state.tool, camera.zoom, state.baseWidth);
    (document.getElementById('canvas') as HTMLCanvasElement).style.cursor = state.toolCursor;
  };
  state.onToolChange = refresh;
  buildPalRow();

  // keeps the timeline in sync after undo/redo or external changes
  return {
    docChanged() {
      if (tlAreaId && !tl.classList.contains('hidden')) renderTimeline();
    },
  };
}
