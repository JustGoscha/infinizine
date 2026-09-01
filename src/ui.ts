// Toolbar, palette popover, page menu. Plain DOM, stationery-shop styling in style.css.

import { InputState, Tool } from './input';
import { Store } from './store';
import { Camera } from './camera';
import { PALETTES, getPalette, shades } from './palettes';
import { PageFormat, uid } from './types';
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

const FORMATS: { format: PageFormat; label: string }[] = [
  { format: 'A4', label: 'A4' },
  { format: 'A4-landscape', label: 'A4 wide' },
  { format: 'A5', label: 'A5' },
  { format: 'square', label: 'Square' },
];

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
      <button class="add-page" id="add-page" title="New page">＋</button>
    </div>
    <div class="popover hidden" id="palette-popover"></div>
    <div class="popover hidden" id="page-popover"></div>
    <div class="page-menu hidden" id="page-menu">
      <button id="pm-move" title="Move page">${svg('<path d="M12 3 V21 M3 12 H21"/><path d="M12 3 L9.6 5.4 M12 3 L14.4 5.4 M12 21 L9.6 18.6 M12 21 L14.4 18.6 M3 12 L5.4 9.6 M3 12 L5.4 14.4 M21 12 L18.6 9.6 M21 12 L18.6 14.4"/>')}</button>
      <button id="pm-add" title="Add page (same size)">${svg('<path d="M12 5 V19 M5 12 H19"/>')}</button>
      <button id="pm-delete" title="Delete page">${svg('<path d="M4 7 H20 M9 7 V5 A1 1 0 0 1 10 4 H14 A1 1 0 0 1 15 5 V7 M6.5 7 L7.5 20 H16.5 L17.5 7"/>')}</button>
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
    slot.addEventListener('click', () => {
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

  // Inline palette: 5–6 dots; shades appear on hover (desktop) or long-press (touch)
  function buildPalRow() {
    palRow.innerHTML = '';
    for (const hue of getPalette(store.doc.palette).hues) {
      const wrap = document.createElement('div');
      wrap.className = 'pal-wrap';
      const fly = document.createElement('div');
      fly.className = 'shade-flyout';
      for (const c of shades(hue)) {
        const s = document.createElement('button');
        s.className = 'pal-shade';
        s.style.background = c;
        s.addEventListener('click', (e) => {
          e.stopPropagation();
          state.color = c;
          closeFlyouts();
          refresh();
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
        state.color = hue;
        closeFlyouts();
        refresh();
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
        <span class="paper-label">paper</span>
        ${['#FFFFFF', '#F7F4EC', '#F3ECDD', '#ECECEA', '#1E1C1A']
          .map((c) => `<button class="paper-dot ${((store.doc.paper ?? '#F7F4EC') === c) ? 'active' : ''}" data-c="${c}" style="background:${c}"></button>`)
          .join('')}
        <input type="color" id="paper-color" value="${store.doc.paper ?? '#F7F4EC'}">
      </div>
    `;
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
      state.color = (e.target as HTMLInputElement).value;
      refresh();
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
  pagePop.innerHTML = FORMATS.map(
    (f) => `<button class="page-format" data-f="${f.format}">${f.label}</button>`,
  ).join('');
  pagePop.querySelectorAll('.page-format').forEach((b) =>
    b.addEventListener('click', () => {
      const format = (b as HTMLElement).dataset.f as PageFormat;
      const page = store.addPage(format, { x: camera.x, y: camera.y });
      camera.x = page.x + page.w / 2;
      camera.y = page.y + page.h / 2;
      pagePop.classList.add('hidden');
      invalidate();
    }),
  );
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
    pagePop.classList.toggle('hidden');
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
  document.addEventListener('pointerdown', (e) => {
    if (!(e.target as HTMLElement).closest?.('#page-menu')) hidePageMenu();
  });

  // ---------- animation timeline (floating, draggable window) ----------
  const tl = document.createElement('div');
  tl.className = 'timeline hidden';
  document.body.appendChild(tl);
  let tlAreaId: string | null = null;

  function closeTimeline() {
    tlAreaId = null;
    state.activeAreaId = null;
    state.activeFrameId = null;
    state.activeLayerId = null;
    state.playingAreas = false;
    tl.classList.add('hidden');
    invalidate();
  }

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

  function renderTimeline() {
    const area = tlAreaId ? store.area(tlAreaId) : undefined;
    if (!area) { closeTimeline(); return; }
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
        <input id="tl-fps" type="number" min="1" max="60" value="${area.fps}" title="fps"><span class="tl-fpslabel">fps</span>
        <button id="tl-loop" class="tl-toggle ${area.loop ? 'on' : ''}">loop</button>
        <button id="tl-clip" class="tl-toggle ${area.clip ? 'on' : ''}" title="Cut off ink outside the area">clip</button>
        <button id="tl-onion" class="tl-toggle ${state.onionSkin ? 'on' : ''}">onion</button>
        <button id="tl-delarea" title="Delete area">🗑</button>
        <button id="tl-close" title="Close">✕</button>
      </div>
      <div class="tl-tracks" id="tl-tracks"></div>
      <div class="tl-ops">
        <button id="tl-add" title="Add frame">＋</button>
        <button id="tl-dup" title="Duplicate frame">⧉</button>
        <button id="tl-del" title="Delete frame">−</button>
        <span class="tl-sep"></span>
        <button id="tl-shorter" title="Shorter">⇤</button>
        <button id="tl-longer" title="Longer">⇥</button>

        <span class="tl-sep"></span>
        <span class="tl-layers-label">layers</span>
        <button id="tl-addlayer" title="Add layer">＋</button>
      </div>
    `;

    // one track per layer (top layer first), each with its own frame strip
    const tracksEl = tl.querySelector('#tl-tracks')!;
    const filledFrames = new Set(store.doc.elements.map((e) => e.frame).filter(Boolean));
    [...area.layers].reverse().forEach((l) => {
      const idx = area.layers.indexOf(l);
      const row = document.createElement('div');
      row.className = `tl-track${l.id === lid ? ' active' : ''}`;

      const head = document.createElement('div');
      head.className = 'tl-track-head';
      head.innerHTML = `<span class="tl-lname">${l.name}</span>
        <button data-a="up" title="Layer up">↑</button>
        <button data-a="down" title="Layer down">↓</button>
        <button data-a="del" title="Delete layer">✕</button>`;
      head.querySelector('.tl-lname')!.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        inlineRename(e.target as HTMLElement, l.name, (v) => store.renameAnimLayer(area.id, l.id, v));
      });
      head.addEventListener('click', (e) => {
        const a = (e.target as HTMLElement).dataset?.a;
        if (a === 'up') store.moveAnimLayer(area.id, idx, idx + 1);
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
      l.frames.forEach((f, i) => {
        const b = document.createElement('button');
        b.className = `tl-frame${f.id === state.activeFrameId ? ' active' : ''}${filledFrames.has(f.id) ? ' filled' : ''}`;
        b.style.width = `${30 + (f.duration - 1) * 30}px`;
        b.textContent = String(i + 1);
        b.title = `${l.name} · frame ${i + 1} · ${f.duration}f`;
        b.addEventListener('click', () => {
          state.activeLayerId = l.id;
          state.activeFrameId = f.id;
          renderTimeline();
          invalidate();
        });
        strip.appendChild(b);
      });

      row.append(head, strip);
      tracksEl.appendChild(row);
    });

    const q = (sel: string) => tl.querySelector(sel) as HTMLElement;
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
    q('#tl-add').addEventListener('click', () => {
      const idx = activeLayer.frames.findIndex((f) => f.id === fid);
      const nf = store.addFrame(area.id, lid, idx + 1);
      state.activeFrameId = nf.id;
      renderTimeline();
      invalidate();
    });
    q('#tl-dup').addEventListener('click', () => {
      const nf = store.duplicateFrame(area.id, lid, fid);
      if (nf) state.activeFrameId = nf.id;
      renderTimeline();
      invalidate();
    });
    q('#tl-del').addEventListener('click', () => {
      store.deleteFrame(area.id, lid, fid);
      renderTimeline();
      invalidate();
    });
    const dur = (d: number) => {
      const f = activeLayer.frames.find((x) => x.id === fid);
      if (f) store.setFrameDuration(area.id, lid, fid, f.duration + d);
      renderTimeline();
      invalidate();
    };
    q('#tl-shorter').addEventListener('click', () => dur(-1));
    q('#tl-longer').addEventListener('click', () => dur(1));
    q('#tl-addlayer').addEventListener('click', () => {
      const nl = store.addAnimLayer(area.id);
      if (nl) {
        state.activeLayerId = nl.id;
        state.activeFrameId = nl.frames[0]?.id ?? null;
      }
      renderTimeline();
      invalidate();
    });
  }

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

  function refresh() {
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
    palRow.querySelectorAll<HTMLElement>('.pal-main').forEach((d) => {
      const hue = d.dataset.hue!;
      d.classList.toggle(
        'active',
        hue === state.color || shades(hue).includes(state.color),
      );
      if (shades(hue).includes(state.color) && hue !== state.color) d.style.background = state.color;
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
