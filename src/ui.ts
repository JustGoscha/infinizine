// Toolbar, palette, page menu, settings, zine library, presenting, export.
// Plain DOM, stationery-shop styling in style.css. Around this file: icons.ts
// (icons, tool catalogue, cursors), pointer-ui.ts (press-drag, pen taps,
// sliders), toolsample.ts (draw flyout previews), timeline.ts (animation
// panel), playground.ts (brush settings modal), feedback.ts (toasts, tips).

import { InputState, Tool, FINGER_KEY, writePref, readPref } from './state';
import { svg, ICONS, FINGER_ICON, cursorFor, TOOL_INFO, TOOL_GROUPS, SIZES } from './icons';
import { toast, tip, tipAt } from './feedback';
import { pressDrag, installPenTaps, installPointerSliders } from './pointer-ui';
import { paintToolSample } from './toolsample';
import { buildTimeline } from './timeline';
import { buildPlayground } from './playground';
import { CLIP_PENDING_KEY } from './clipboard';
import { Store } from './store';
import { Camera, baseZoom, pxPerMm, setPxPerMm } from './camera';
import { PALETTES, PALETTE_GROUPS, getPalette, shades, sortByLightness } from './palettes';
import { isPattern, patternPreviewCSS, patternLabel, patternLevels, patternVariants, PATTERN_CATEGORIES, PIXEL_FILL } from './patterns';
import type { ExportOptions } from './export';
import { UNITS_PER_MM, uid, FORMAT_VERSION, FILL_BLENDS } from './types';
import { type Fmt, PRIMARY_FORMATS, FORMAT_GROUPS, fitPage, customFormats, saveCustomFormat, mm } from './formats';
import { fitBox, FONTS, FACES, chosenFaces, appFaces, setFace, setDocFaces, weightRange, cssOf, ROLE_IDS, boxFamily, type FontRole } from './text';
import { markdownToHtml, htmlToMarkdown, autoTransform, caretToEnd, applyInlineStyle, selectionToClipboard, clipboardToMarkdown, markdownToPasteHtml } from './richedit';


const ADAPTIVE_KEY = 'infinizine-adaptive-size';


export function buildUI(
  root: HTMLElement,
  state: InputState,
  store: Store,
  camera: Camera,
  invalidate: () => void,
  actions: {
    copy: () => void; cut: () => void; paste: () => void;
    exportZine: (opts: ExportOptions) => Promise<void>;
    pageThumb: (page: import('./types').Page, width: number) => HTMLCanvasElement;
  },
) {
  root.innerHTML = `
    <header class="topbar">
      <div class="wordmark">INFINI<span class="zine"><i>Z</i><i>I</i><i>N</i><i>E</i></span></div>
      <div class="top-actions">
        <button class="chip" id="docs" title="My zines">${svg('<path d="M4 7 V19 A1.5 1.5 0 0 0 5.5 20.5 H18.5 A1.5 1.5 0 0 0 20 19 V9.5 A1.5 1.5 0 0 0 18.5 8 H12 L10 5.5 H5.5 A1.5 1.5 0 0 0 4 7 Z"/>')}</button>
        <button class="chip" id="finger-toggle" title="Finger mode"></button>
        <button class="chip" id="eagle" title="Eagle view: fit everything, tap again to return">${svg('<path d="M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5"/><rect x="9.5" y="9.5" width="5" height="5"/>')}</button>
        <button class="chip" id="zoom-lock" title="Zoom lock"></button>
        <button class="chip chip-text" id="zoom-100" title="Back to 100% (⌘0)">1:1</button>
        <button class="chip" id="playground" title="Pressure playground">${svg('<path d="M21.42 10.13 L21.42 13.87 L19.26 13.44 L18.15 16.11 L19.98 17.33 L17.33 19.98 L16.11 18.15 L13.44 19.26 L13.87 21.42 L10.13 21.42 L10.56 19.26 L7.89 18.15 L6.67 19.98 L4.02 17.33 L5.85 16.11 L4.74 13.44 L2.58 13.87 L2.58 10.13 L4.74 10.56 L5.85 7.89 L4.02 6.67 L6.67 4.02 L7.89 5.85 L10.56 4.74 L10.13 2.58 L13.87 2.58 L13.44 4.74 L16.11 5.85 L17.33 4.02 L19.98 6.67 L18.15 7.89 L19.26 10.56 Z"/><circle cx="12" cy="12" r="3.2"/>')}</button>
        <button class="chip" id="fullscreen" title="Full screen (hide the browser)">${svg('<path d="M4 9V5h4 M20 9V5h-4 M4 15v4h4 M20 15v4h-4"/>')}</button>
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
        <button id="present-pages" title="All pages: reorder for presenting and export">${svg('<rect x="3" y="6" width="5" height="12"/><rect x="9.5" y="6" width="5" height="12"/><rect x="16" y="6" width="5" height="12"/>')}</button>
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
      <span class="tb-sep"></span>
      <div class="pal-wrap pat-wrap" id="pat-wrap">
        <div class="shade-flyout pat-fly" id="pat-fly"></div>
        <button class="pat-btn" id="pat-btn" title="Fill pattern (fill tool): screentones, hatching, dithers…"></button>
      </div>
      <div class="popover hidden" id="pattern-popover"></div>
      <div class="divider"></div>
      <button class="add-page" id="add-page" title="New page">${svg('<path d="M7 3.5 H13.5 L18 8 V20.5 H7 Z"/><path d="M13.5 3.5 V8 H18"/><path d="M12.5 11.5 v5 M10 14 h5"/>')}</button>
    </div>
    <div class="popover top-pop hidden" id="export-popover">
      <div class="set-title">Export</div>
      <div class="set-row"><span>What</span>
        <div class="seg" id="ex-scope"><button data-v="pages">Pages</button><button data-v="canvas">Whole canvas</button></div></div>
      <div class="set-row"><span>Format</span>
        <div class="seg" id="ex-format"><button data-v="png">PNG</button><button data-v="pdf">PDF</button><button data-v="gif">GIF</button><button data-v="html">HTML</button><button data-v="zine">.zine</button></div></div>
      <div class="set-row"><span>Resolution</span>
        <div class="seg" id="ex-dpi"><button data-v="150">150 dpi</button><button data-v="300">300 dpi</button></div></div>
      <div class="set-row"><span>Paper pattern</span>
        <div class="seg" id="ex-paper"><button data-v="1">Include</button><button data-v="0">Exclude</button></div></div>
      <div class="set-note" id="ex-note"></div>
      <button class="set-action" id="ex-go">Export</button>
    </div>
    <div class="pages-panel hidden" id="pages-panel">
      <div class="pages-head"><span>Pages · reading order</span><span class="pages-hint">drag to reorder (hold on touch)</span><button id="pages-bypos" title="Left to right, top to bottom">By position</button><button id="pages-close">✕</button></div>
      <div class="pages-strip" id="pages-strip"></div>
    </div>
    <div class="popover top-pop hidden" id="docs-popover"></div>
    <div class="popover top-pop hidden" id="settings-popover">
      <div class="set-title">Settings</div>
      <div class="set-row"><span>Handedness</span>
        <div class="seg" id="set-hand"><button data-v="right">Right</button><button data-v="left">Left</button></div></div>
      <div class="set-row"><span>Brush size</span>
        <div class="seg" id="set-adaptive"><button data-v="0">Physical</button><button data-v="1">Adaptive</button></div></div>
      <div class="set-row"><span>Zoom</span>
        <div class="seg" id="set-lock"><button data-v="1">Locked</button><button data-v="0">Free</button></div></div>
      <div class="set-row"><span>Two-finger tap</span>
        <div class="seg" id="set-fundo"><button data-v="1">Undo · redo</button><button data-v="0">Off</button></div></div>
      <div class="set-row"><span>Performance readout</span>
        <div class="seg" id="set-perf"><button data-v="1">On</button><button data-v="0">Off</button></div></div>
      <div class="set-row set-sub"><span class="set-title">Typefaces</span>
        <div class="seg" id="set-faces-scope"><button data-v="zine">This zine</button><button data-v="app">App-wide</button></div></div>
      <div class="set-fonts" id="set-fonts"></div>
      <button class="set-action set-ghost" id="set-faces-reset">Zine follows app-wide typefaces</button>
      <div class="set-note">These faces are bundled with the app (SIL Open Font Licence / Apache). The dice on a text box rolls one of ~600 more, fetched on demand from jsDelivr's Fontsource CDN — the only network request the app makes.</div>
      <button class="set-action" id="set-brushes">Brush settings…</button>
      <div class="set-note">InfiniZine v${__APP_VERSION__} · zine format ${FORMAT_VERSION}</div>
    </div>
    <div class="popover hidden" id="palette-popover"></div>
    <div class="popover hidden" id="page-popover"></div>
    <div class="page-menu hidden" id="page-menu">
      <button id="pm-move" title="Move page">${svg('<path d="M12 3 V21 M3 12 H21"/><path d="M12 3 L9.6 5.4 M12 3 L14.4 5.4 M12 21 L9.6 18.6 M12 21 L14.4 18.6 M3 12 L5.4 9.6 M3 12 L5.4 14.4 M21 12 L18.6 9.6 M21 12 L18.6 14.4"/>')}</button>
      <button id="pm-add" title="Add page (same size)">${svg('<path d="M12 5 V19 M5 12 H19"/>')}</button>
      <button id="pm-order" title="Page order (presenting & export)">${svg('<rect x="3" y="6" width="5" height="12"/><rect x="9.5" y="6" width="5" height="12"/><rect x="16" y="6" width="5" height="12"/>')}</button>
      <button id="pm-delete" title="Delete page">${svg('<path d="M4 7 H20 M9 7 V5 A1 1 0 0 1 10 4 H14 A1 1 0 0 1 15 5 V7 M6.5 7 L7.5 20 H16.5 L17.5 7"/>')}</button>
      <span class="pm-sep"></span>
      <div class="pm-formats">
        ${PRIMARY_FORMATS.map((f, i) => `<button class="pm-format" data-i="${i}">${f.label}</button>`).join('')}
        <button class="pm-format" id="pm-more-formats" title="More formats">···</button>
      </div>
    </div>
  `;

  installPenTaps();
  installPointerSliders();

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
      // the draw tools preview what each would draw: colour/pattern swatch + a sample line
      b.innerHTML = g.id === 'draw'
        ? `<span class="tool-icon">${ICONS[t]}</span><i class="tool-swatch"></i><canvas class="tool-sample" width="96" height="30"></canvas>`
        : `<span class="tool-icon">${ICONS[t]}</span>`;
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
    if (g.id === 'draw') wrap.classList.add('draw-wrap');
    toolsEl.appendChild(wrap);
  }
  /** refresh the draw flyout's swatches and sample lines from each tool's remembered style */
  function refreshToolSamples() {
    toolsEl.querySelectorAll<HTMLElement>('.draw-wrap .tool-flyout .tool').forEach((b) => {
      const t = b.dataset.tool as Tool;
      const st = state.toolStyle(t);
      const sw = b.querySelector<HTMLElement>('.tool-swatch');
      if (sw) sw.style.background = st.pattern ? patternPreviewCSS(st.pattern, st.color, 2.5) : st.color;
      const cv = b.querySelector<HTMLCanvasElement>('.tool-sample');
      if (cv) paintToolSample(cv, t, st);
    });
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
      state.rememberTool();
      closeToolFlyouts();
      refresh();
    }),
  );
  const sizeFader = sizesEl.querySelector('#size-fader') as HTMLInputElement;
  sizeFader.addEventListener('input', () => {
    state.baseWidth = Number(sizeFader.value);
    state.rememberTool();
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
    root.querySelectorAll('.pal-wrap.open').forEach((w) => w.classList.remove('open'));
  }

  /** Picking a color while textboxes are selected recolors them. */
  function applyColor(c: string) {
    state.color = c;
    state.onEditColor?.(c); // text being edited follows the palette
    writePref(`infinizine-color-${store.docId}`, c);
    writePref('infinizine-last-color', c);
    state.rememberTool();
    // a colour pick recolours whatever is selected: strokes, fills and text alike
    const ids = store.doc.elements
      .filter((el) => el.kind !== 'image' && state.selection.has(el.id))
      .map((el) => el.id);
    if (ids.length) store.recolorElements(ids, c);
    syncPatBtn();
    refresh();
    invalidate();
  }

  // Inline palette: 5–6 dots; shades appear on hover (desktop) or long-press (touch)
  function buildPalRow() {
    palRow.innerHTML = '';
    const preset = getPalette(store.doc.palette);
    // never more than six top-level swatches — everything else lives in the shade flyouts
    for (const hue of preset.hues.slice(0, 6)) {
      const wrap = document.createElement('div');
      wrap.className = 'pal-wrap';
      const fly = document.createElement('div');
      fly.className = 'shade-flyout';
      // hardware palettes are exact: no derived shades, so no flyout
      const hueList = preset.strict ? sortByLightness(preset.ramps?.[hue] ?? []) : shades(hue, preset.drama);
      for (const c of hueList) {
        const s = document.createElement('button');
        s.className = 'pal-shade';
        s.style.background = isPattern(c) ? patternPreviewCSS(c, undefined, 3.3) : c;
        if (isPattern(c)) s.title = `${patternLabel(c)} — fill tool only`;
        s.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the text editor focused
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
      dot.style.background = isPattern(hue) ? patternPreviewCSS(hue, undefined, 4.5) : hue;
      if (isPattern(hue)) dot.title = `${patternLabel(hue)} — paints with the fill tool; strokes get ink`;
      dot.addEventListener('pointerdown', (e) => { if (state.onEditColor) e.preventDefault(); }); // keep the text editor focused
      let lp = 0;
      let longPressed = false;
      const tops = preset.hues.slice(0, 6).map((h) => h.toLowerCase());
      const hueShades = hueList.map((c) => c.toLowerCase()).filter((c) => c === hue.toLowerCase() || !tops.includes(c));
      dot.addEventListener('click', () => {
        if (longPressed) { longPressed = false; return; }
        // tapping the hue that's already active opens/closes its shades (touch has no hover)
        const cur = state.color.toLowerCase();
        if (hueList.length && (cur === hue.toLowerCase() || hueShades.includes(cur))) {
          const wasOpen = wrap.classList.contains('open');
          closeFlyouts();
          wrap.classList.toggle('open', !wasOpen);
          return;
        }
        closeFlyouts();
        applyColor(hue);
      });
      dot.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse') return;
        if (!hueList.length) return; // nothing to open
        lp = window.setTimeout(() => {
          longPressed = true;
          closeFlyouts();
          wrap.classList.add('open');
        }, 320);
      });
      const cancelLp = () => clearTimeout(lp);
      dot.addEventListener('pointerup', cancelLp);
      dot.addEventListener('pointerleave', cancelLp);
      if (hueList.length) wrap.append(fly, dot); else wrap.append(dot); // strict palettes: no (empty) shade popover
      palRow.appendChild(wrap);
    }
    refresh();
  }

  function buildPalettePopover() {
    const preset = getPalette(store.doc.palette);
    palettePop.innerHTML = `
      <div class="pal-presets">${(() => {
        const listed = new Set(PALETTE_GROUPS.flatMap((g) => g.ids));
        const groups = [...PALETTE_GROUPS, { label: 'More', ids: PALETTES.filter((p) => !listed.has(p.id)).map((p) => p.id) }]
          .filter((g) => g.ids.length);
        const card = (p: (typeof PALETTES)[number]) => `<button class="pal-preset ${p.id === preset.id ? 'active' : ''}" data-id="${p.id}">
          <span class="pal-preset-name">${p.name}</span>
          <span class="pal-preview">${p.hues
            .map((c: string) => `<i style="background:${isPattern(c) ? patternPreviewCSS(c, undefined, 2) : c}"></i>`)
            .join('')}</span>
        </button>`;
        return groups.map((g) => `<div class="pal-group-label">${g.label}</div>${g.ids
          .map((id) => PALETTES.find((p) => p.id === id)).filter((p): p is (typeof PALETTES)[number] => !!p).map(card).join('')}`).join('');
      })()}</div>
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
        const id = (b as HTMLElement).dataset.id!;
        store.setPalette(id);
        writePref('infinizine-last-palette', id); // new zines start with it
        buildPalRow();
        buildPalettePopover();
        palettePop.classList.add('hidden');
      }),
    );
    (palettePop.querySelector('#custom-color') as HTMLInputElement).addEventListener('input', (e) => {
      applyColor((e.target as HTMLInputElement).value);
    });
  }

  palMore.addEventListener('click', () => {
    pagePop.classList.add('hidden');
    patternPop.classList.add('hidden');
    buildPalettePopover();
    palettePop.classList.toggle('hidden');
  });

  // ---- fill pattern selector: square swatch next to the colours; categories × densities ----
  const patBtn = root.querySelector('#pat-btn') as HTMLButtonElement;
  const patternPop = root.querySelector('#pattern-popover') as HTMLElement;
  const syncPatBtn = () => {
    const pat = state.fillPattern;
    patBtn.style.background = pat ? patternPreviewCSS(pat, state.color, 3) : '';
    patBtn.classList.toggle('none', !pat);
    patBtn.classList.toggle('on', !!pat);
    patBtn.title = pat ? `${patternLabel(pat)} — fills use it (tap to change)` : 'Fill pattern: solid (tap to pick a screentone / dither)';
    patBtn.innerHTML = pat ? '' : svg('<rect x="4.5" y="4.5" width="15" height="15"/><path d="M6 18 L18 6"/>');
  };
  const pickPattern = (pat: string | null) => {
    state.fillPattern = pat;
    writePref('infinizine-fill-pattern3', pat ?? '');
    // selected fills take the pattern right away
    const ids = store.doc.elements.filter((el) => el.kind === 'fill' && state.selection.has(el.id)).map((el) => el.id);
    if (ids.length) store.setPatterns(ids, pat);
    // the pens paint patterns too, so only a non-drawing tool jumps to the fill tool
    if (pat && !['pen', 'pencil', 'sketch', 'fineliner', 'marker', 'lasso-fill', 'lasso-blob'].includes(state.tool)) { state.tool = 'lasso-fill'; state.onToolChange(); }
    state.rememberTool(); // like the colour, the pattern belongs to the tool
    syncPatBtn();
    refreshToolSamples();
    buildPatternPopover();
    invalidate();
  };
  function buildPatternPopover() {
    patternPop.innerHTML = `
      <div class="pat-sticky">
        <div class="pat-head"><span>Fill pattern</span>
          <div class="seg pat-blend" id="pat-blend">${FILL_BLENDS.map((b) => `<button data-v="${b.id}" class="${state.fillBlend === b.id ? 'active' : ''}" title="${b.hint}">${b.label}</button>`).join('')}</div></div>
        <label class="pg-row pat-ink"><span>opacity</span><input type="range" id="pat-ink" min="0.3" max="1" step="0.05" value="${state.inkDensity}"><b>${Math.round(state.inkDensity * 100)}%</b></label>
        <div class="set-row pat-row"><span>Tone angle</span>
          <div class="seg" id="pat-rand"><button data-v="1" class="${state.toneRandom ? 'active' : ''}">Random per fill</button><button data-v="0" class="${state.toneRandom ? '' : 'active'}">Fixed</button></div></div>
      </div>
      <div class="pat-fam"><span class="pat-fam-name">Solid</span>
        <div class="pat-swatches"><button class="pat-sw pat-solid${state.fillPattern ? '' : ' active'}" id="pat-clear" title="Solid fill" style="background:${state.color}"></button></div></div>
      ${PATTERN_CATEGORIES.map((cat) => `
        <div class="pat-cat">${cat.label}</div>
        ${cat.families.map((f) => `
          <div class="pat-fam"><span class="pat-fam-name">${f.label}</span>
            <div class="pat-swatches">${Array.from({ length: patternLevels(f.fam) }, (_, i) => i + 1).map((k) => {
              const id = `pattern:${f.fam}-${k}`;
              return `<button class="pat-sw${state.fillPattern === id ? ' active' : ''}" data-id="${id}" title="${patternLevels(f.fam) === 1 ? f.label : `${f.label} ${k}`}" style="background:${patternPreviewCSS(id, state.color, 3)}"></button>`;
            }).join('')}</div>
          </div>`).join('')}`).join('')}
      <div class="set-note">Fills — solid or patterned — paint in the current colour. With Subtract they overprint like process ink: below 100% opacity the paper shows through, so overlapping tones mix and darken (red over yellow → orange-red). Manga tones can be rotated on a selected fill; dithers stay on one fixed pixel grid at every zoom.</div>`;
    patternPop.querySelector('#pat-rand')!.addEventListener('click', (e) => {
      const v = (e.target as HTMLElement).closest('button')?.dataset.v;
      if (!v) return;
      state.toneRandom = v === '1';
      writePref('infinizine-tone-random', v);
      patternPop.querySelectorAll<HTMLElement>('#pat-rand button').forEach((b) => b.classList.toggle('active', b.dataset.v === v));
    });
    patternPop.querySelector('#pat-blend')!.addEventListener('click', (e) => {
      const v = (e.target as HTMLElement).closest('button')?.dataset.v as import('./types').FillBlend | undefined;
      if (!v) return;
      state.fillBlend = v;
      writePref('infinizine-fill-blend', v);
      patternPop.querySelectorAll<HTMLElement>('#pat-blend button').forEach((b) => b.classList.toggle('active', b.dataset.v === v));
      const ids = store.doc.elements.filter((el) => el.kind === 'fill' && state.selection.has(el.id)).map((el) => el.id);
      if (ids.length) store.setBlend(ids, v);
      invalidate();
    });
    const inkSlider = patternPop.querySelector('#pat-ink') as HTMLInputElement;
    inkSlider.addEventListener('input', () => {
      state.inkDensity = Number(inkSlider.value);
      (inkSlider.nextElementSibling as HTMLElement).textContent = `${Math.round(state.inkDensity * 100)}%`;
      writePref('infinizine-fill-opacity', String(state.inkDensity));
      const ids = store.doc.elements.filter((el) => el.kind === 'fill' && state.selection.has(el.id)).map((el) => el.id);
      if (ids.length) store.setInk(ids, state.inkDensity);
      invalidate();
    });
    patternPop.querySelectorAll<HTMLElement>('.pat-sw').forEach((b) => b.addEventListener('click', () => pickPattern(b.dataset.id!)));
    (patternPop.querySelector('#pat-clear') as HTMLButtonElement).addEventListener('click', () => pickPattern(null));
  }
  const openPatternPopover = () => {
    pagePop.classList.add('hidden');
    palettePop.classList.add('hidden');
    closeFlyouts();
    buildPatternPopover();
    patternPop.classList.toggle('hidden');
  };
  // the pattern swatch behaves like a colour: with a pattern active, hover
  // (desktop) or a tap (touch) shows the family's other levels; "···" opens everything
  const patWrap = root.querySelector('#pat-wrap') as HTMLElement;
  const patFly = root.querySelector('#pat-fly') as HTMLElement;
  const buildPatFly = () => {
    patFly.innerHTML = '';
    const pat = state.fillPattern;
    if (!pat) return;
    for (const v of patternVariants(pat)) {
      const b = document.createElement('button');
      b.className = `pal-shade pat-shade${v === pat ? ' active' : ''}`;
      b.title = patternLabel(v);
      b.style.background = patternPreviewCSS(v, state.color, 3);
      b.addEventListener('pointerdown', (e) => e.preventDefault());
      b.addEventListener('click', (e) => { e.stopPropagation(); closeFlyouts(); pickPattern(v); });
      patFly.appendChild(b);
    }
    // always at hand: the solid pixel fill and plain (unpatterned) ink
    const sep = document.createElement('i');
    sep.className = 'pat-fly-sep';
    patFly.appendChild(sep);
    if (!pat.startsWith(PIXEL_FILL)) {
      const px = document.createElement('button');
      px.className = 'pal-shade pat-shade';
      px.title = 'Pixel fill (solid, grid-edged)';
      px.style.background = patternPreviewCSS(PIXEL_FILL, state.color, 3);
      px.addEventListener('pointerdown', (e) => e.preventDefault());
      px.addEventListener('click', (e) => { e.stopPropagation(); closeFlyouts(); pickPattern(PIXEL_FILL); });
      patFly.appendChild(px);
    }
    const solid = document.createElement('button');
    solid.className = 'pal-shade pat-shade pat-solid';
    solid.title = 'Solid ink — no pattern';
    solid.style.background = state.color;
    solid.addEventListener('pointerdown', (e) => e.preventDefault());
    solid.addEventListener('click', (e) => { e.stopPropagation(); closeFlyouts(); pickPattern(null); });
    patFly.appendChild(solid);
    const more = document.createElement('button');
    more.className = 'pal-shade pat-shade pat-more';
    more.textContent = '···';
    more.title = 'All patterns';
    more.addEventListener('click', (e) => { e.stopPropagation(); openPatternPopover(); });
    patFly.appendChild(more);
  };
  let patLongPressed = false;
  let patLp = 0;
  patBtn.addEventListener('click', () => {
    if (patLongPressed) { patLongPressed = false; return; }
    if (state.fillPattern && patternVariants(state.fillPattern).length > 1) {
      const wasOpen = patWrap.classList.contains('open');
      closeFlyouts();
      if (!wasOpen) { buildPatFly(); patWrap.classList.add('open'); }
      return;
    }
    openPatternPopover();
  });
  patBtn.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || !state.fillPattern) return;
    patLp = window.setTimeout(() => { patLongPressed = true; closeFlyouts(); buildPatFly(); patWrap.classList.add('open'); }, 320);
  });
  patBtn.addEventListener('pointerup', () => clearTimeout(patLp));
  patBtn.addEventListener('pointerleave', () => clearTimeout(patLp));
  patWrap.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') buildPatFly(); });
  document.addEventListener('pointerdown', (e) => {
    const t = e.target as HTMLElement;
    if (!t.closest?.('#pattern-popover') && !t.closest?.('#pat-btn')) patternPop.classList.add('hidden');
  });
  syncPatBtn();

  // tap anywhere else closes touch flyouts
  document.addEventListener('pointerdown', (e) => {
    if (!(e.target as HTMLElement).closest?.('.pal-wrap')) closeFlyouts();
  });

  const addPageBtn = root.querySelector('#add-page') as HTMLButtonElement;

  // Format panel (shared by first-page picker and the page menu's "more"):
  // primary + extended presets + saved custom formats + a custom W×H creator.
  let onPickFormat: (f: Fmt) => void = () => {};
  function buildFormatPanel() {
    const groups = [...FORMAT_GROUPS, { label: 'Custom', items: customFormats() }].filter((g) => g.items.length);
    const all = groups.flatMap((g) => g.items);
    let idx = 0;
    const ratio = (f: Fmt) => {
      const g = (a: number, b: number): number => (b ? g(b, a % b) : a);
      const wmm = Math.round(f.w / UNITS_PER_MM), hmm = Math.round(f.h / UNITS_PER_MM);
      return f.screen ? `${wmm / g(wmm, hmm)}:${hmm / g(wmm, hmm)}` : `${wmm}×${hmm}mm`;
    };
    pagePop.innerHTML = `
      <div class="fmt-scroll">${groups
        .map(
          (grp) => `<div class="fmt-group-label">${grp.label}</div>
          <div class="fmt-grid">${grp.items
            .map(
              (f) => `<button class="fmt" data-i="${idx++}">
                <i class="fmt-thumb" style="aspect-ratio:${f.w}/${f.h}"></i>
                <span class="fmt-label">${f.label}</span>
                <span class="fmt-dims">${ratio(f)}</span>
              </button>`,
            )
            .join('')}</div>`,
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

  // a fresh page comes into view with its top edge a little below the top bar
  const showNewPage = (page: import('./types').Page) => {
    const vh = (document.getElementById('canvas') as HTMLCanvasElement).clientHeight || window.innerHeight;
    camera.x = page.x + page.w / 2;
    camera.y = page.y - 76 / camera.zoom + vh / camera.zoom / 2;
    invalidate();
  };
  const createFirstPage = (f: Fmt) => {
    const page = store.addPage({ w: f.w, h: f.h }, { x: camera.x, y: camera.y }, f.label);
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
      showNewPage(store.addPageAfter(last));
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

  // text style clipboard: typeface, size and colour of one box, ready to apply to another
  type TextStyle = { font: string; face?: string; fontSize: number; color: string }; // role, rolled face, size, colour
  const readStyleClip = (): TextStyle | null => { try { return JSON.parse(readPref('infinizine-text-style') ?? 'null'); } catch { return null; } };
  const writeStyleClip = (s: TextStyle) => writePref('infinizine-text-style', JSON.stringify(s));
  const styleOf = (el: import('./types').TextBox): TextStyle => ({ font: el.font ?? 'franklin', face: el.face, fontSize: el.fontSize, color: el.color });
  const sameStyle = (a: TextStyle, b: TextStyle) => a.font === b.font && (a.face ?? '') === (b.face ?? '') && Math.abs(a.fontSize - b.fontSize) < 0.01 && a.color.toLowerCase() === b.color.toLowerCase();
  const restyleText = (el: import('./types').TextBox, s: TextStyle) => {
    const { w, h } = fitBox(el.text, boxFamily({ font: s.font, face: s.face }), s.fontSize, el);
    store.updateText(
      el.id,
      { text: el.text, w: el.w, h: el.h, font: el.font ?? 'franklin', fontSize: el.fontSize, face: el.face ?? null },
      { text: el.text, w, h, font: s.font, fontSize: s.fontSize, face: s.face ?? null },
    );
    if (s.color !== el.color) store.recolorElements([el.id], s.color);
  };
  // handles on the text rect (under the dice): copy this box's style; paste the copied one
  state.onCopyStyle = (el, cx, cy) => { writeStyleClip(styleOf(el)); tip(cx, cy - 18, 'Style copied'); };
  state.onPasteStyle = (el, cx, cy) => { const s = readStyleClip(); if (s && FONTS[s.font]) { restyleText(el, s); tip(cx, cy - 18, 'Style applied'); invalidate(); } };
  state.stylePasteFor = (el) => { const s = readStyleClip(); return !!s && !!FONTS[s.font] && !sameStyle(s, styleOf(el)); };

  state.onTextEdit = (target, rect, autoFlag) => {
    // new boxes hug their text: a tap never wraps, a drawn rectangle wraps at its width;
    // both stay auto until resized by hand
    const auto = target ? !!target.auto : true;
    const wrapW = target ? target.wrapW : autoFlag ? undefined : rect.w;
    const box = () => ({ auto, wrapW, w: rect.w, h: rect.h });
    let fontSize = target ? target.fontSize : state.textSize;
    let color = target ? target.color : state.color;
    let family = target?.font ?? state.font;
    let face = target?.face; // a rolled face stays until another role is picked
    const fam = () => (face ? `${family}@${face}` : family);
    state.onEditColor = (c) => { color = c; place(); ta.focus(); };
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
    for (const key of ROLE_IDS) {
      const f = FONTS[key];
      const b = document.createElement('button');
      b.textContent = f.name;
      b.style.fontFamily = f.css;
      b.classList.toggle('active', key === family);
      // keep the textarea focused — no blur/commit on picking a font
      b.addEventListener('pointerdown', (e) => e.preventDefault());
      b.addEventListener('click', () => {
        // with a selection: typeface for just those words; otherwise the whole box
        if (applyInlineStyle(ta, { font: key, css: f.css })) { place(); ta.focus(); return; }
        family = key;
        face = undefined;
        state.font = key;
        bar.querySelectorAll('.fb-font').forEach((o) => o.classList.toggle('active', o === b));
        place();
        ta.focus();
      });
      b.classList.add('fb-font');
      bar.appendChild(b);
    }
    // B / I / U — applied as real styling, serialised to **, *, __ on commit
    const markSep = document.createElement('span');
    markSep.className = 'font-bar-sep';
    bar.appendChild(markSep);
    const marks: { cmd: string; label: string; cls: string; key: string }[] = [
      { cmd: 'bold', label: 'B', cls: 'fb-b', key: 'b' },
      { cmd: 'italic', label: 'I', cls: 'fb-i', key: 'i' },
      { cmd: 'underline', label: 'U', cls: 'fb-u', key: 'u' },
    ];
    const markBtns: HTMLButtonElement[] = [];
    for (const m of marks) {
      const b = document.createElement('button');
      b.textContent = m.label;
      b.className = `fb-mark ${m.cls}`;
      b.title = `${m.cmd[0].toUpperCase()}${m.cmd.slice(1)} (⌘${m.key.toUpperCase()})`;
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (m.cmd !== 'bold') return;
        // long-press B → weight picker (100–900 where the face is variable)
        holdTimer = window.setTimeout(() => { holdFired = true; openWeights(); }, 450);
      });
      b.addEventListener('pointerup', () => clearTimeout(holdTimer));
      b.addEventListener('pointerleave', () => clearTimeout(holdTimer));
      b.addEventListener('click', () => {
        if (holdFired) { holdFired = false; return; }
        document.execCommand(m.cmd); place(); ta.focus(); syncMarks();
      });
      markBtns.push(b);
      bar.appendChild(b);
    }
    let holdTimer = 0;
    let holdFired = false;
    const weightPop = document.createElement('div');
    weightPop.className = 'weight-pop hidden';
    document.body.appendChild(weightPop);
    const openWeights = () => {
      const range = weightRange(fam());
      weightPop.innerHTML = '';
      if (!range) {
        weightPop.innerHTML = `<span class="weight-note">${FONTS[family].name} has only regular & bold</span>`;
      } else {
        for (let w = 100; w <= 900; w += 100) {
          if (w < range[0] || w > range[1]) continue;
          const wb = document.createElement('button');
          wb.textContent = String(w);
          wb.style.fontWeight = String(w);
          wb.style.fontFamily = cssOf(fam());
          wb.addEventListener('pointerdown', (e) => e.preventDefault());
          wb.addEventListener('click', () => {
            applyInlineStyle(ta, { weight: w });
            weightPop.classList.add('hidden');
            place();
            ta.focus();
          });
          weightPop.appendChild(wb);
        }
      }
      const br = bar.getBoundingClientRect();
      weightPop.style.left = `${br.left}px`;
      weightPop.style.top = `${br.bottom + 6}px`;
      weightPop.classList.remove('hidden');
    };
    document.addEventListener('pointerdown', (e) => {
      if (!(e.target as HTMLElement).closest('.weight-pop, .fb-b')) weightPop.classList.add('hidden');
    });
    const syncMarks = () => {
      marks.forEach((m, i) => markBtns[i].classList.toggle('active', document.queryCommandState(m.cmd)));
    };
    document.addEventListener('selectionchange', syncMarks);
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
    // copy / paste style (typeface, size, colour)
    const styleSep = document.createElement('span');
    styleSep.className = 'font-bar-sep';
    bar.appendChild(styleSep);
    const copyStyle = document.createElement('button');
    copyStyle.className = 'fb-style';
    copyStyle.title = 'Pick up this style (typeface, size, colour)';
    copyStyle.innerHTML = svg('<path d="M2 22l1-1h3l9-9 M3 21v-3l9-9 M15 6l3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/>');
    copyStyle.addEventListener('pointerdown', (e) => e.preventDefault());
    copyStyle.addEventListener('click', () => { writeStyleClip({ font: family, face, fontSize, color }); pasteStyle.hidden = false; pasteStyle.classList.add('badged'); tipAt(copyStyle, 'Style copied'); ta.focus(); });
    const pasteStyle = document.createElement('button');
    pasteStyle.className = 'fb-style';
    pasteStyle.title = 'Apply the picked-up style';
    pasteStyle.innerHTML = svg('<path d="M4 2h12a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z M10 16v-2a2 2 0 0 1 2-2h8a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2 M9 16h2a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1Z"/>');
    pasteStyle.hidden = !readStyleClip();
    pasteStyle.classList.toggle('badged', !!readStyleClip());
    pasteStyle.addEventListener('pointerdown', (e) => e.preventDefault());
    pasteStyle.addEventListener('click', () => {
      const s = readStyleClip();
      if (!s || !FONTS[s.font]) return;
      family = s.font; face = s.face; state.font = s.font;
      fontSize = s.fontSize; state.textSize = s.fontSize;
      color = s.color;
      bar.querySelectorAll<HTMLElement>('.fb-font').forEach((o) => o.classList.toggle('active', o.textContent === FONTS[s.font].name));
      bar.querySelectorAll<HTMLElement>('button').forEach((o) => { const ts = TEXT_SIZES.find((x) => x.label === o.textContent); if (ts) o.classList.toggle('active', Math.abs(ts.size - fontSize) < 0.01); });
      place();
      tipAt(pasteStyle, 'Style applied');
      ta.focus();
    });
    bar.append(copyStyle, pasteStyle);
    document.body.appendChild(bar);
    // auto boxes: width = widest line (+ a hair so greedy wrapping never kicks in)
    // the field is as wide as lines may get (drawn/fixed width); a tap box grows with its text
    const curW = () => (auto && wrapW === undefined ? fitBox(value(), fam(), fontSize, box()).w : wrapW ?? rect.w);
    const contentH = () => fitBox(value(), fam(), fontSize, box()).h;
    if (auto && wrapW === undefined) ta.style.whiteSpace = 'pre'; // never wrap while auto-sizing
    const place = () => {
      const r = (document.getElementById('canvas') as HTMLCanvasElement).getBoundingClientRect();
      const s = camera.worldToScreen(rect.x, rect.y, r.width, r.height);
      const z = camera.zoom;
      ta.style.left = `${r.left + s.x}px`;
      ta.style.top = `${r.top + s.y}px`;
      ta.style.font = `400 ${fontSize * z}px ${cssOf(fam())}`;
      ta.style.lineHeight = `${fontSize * 1.3 * z}px`;
      ta.style.color = color;
      ta.style.width = `${curW() * z}px`; // drawn rectangle's width, or the content's when auto
      ta.style.minHeight = `${contentH() * z}px`; // grows downward with content
      // the bar sits above the text rect (measured, since it may wrap to two rows);
      // if there's no room above, it goes below instead — never over the text
      bar.style.left = `${Math.max(8, Math.min(r.left + s.x, window.innerWidth - bar.offsetWidth - 8))}px`;
      const above = r.top + s.y - bar.offsetHeight - 8;
      bar.style.top = `${above >= 60 ? above : r.top + s.y + contentH() * z + 8}px`;
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
      state.onEditColor = null;
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('selectionchange', syncMarks);
      weightPop.remove();
      ta.remove();
      bar.remove();
      if (target) state.hidden.delete(target.id);
      const text = value().replace(/\s+$/, '');
      const { w, h } = fitBox(text, fam(), fontSize, box());
      if (target) {
        if (color !== target.color) store.recolorElements([target.id], color);
        if (text === target.text && family === (target.font ?? 'franklin') && face === target.face && fontSize === target.fontSize && w === target.w) {
          invalidate();
          return;
        }
        if (text) {
          store.updateText(
            target.id,
            { text: target.text, w: target.w, h: target.h, font: target.font ?? 'franklin', fontSize: target.fontSize, face: target.face ?? null },
            { text, w, h, font: family, fontSize, face: face ?? null },
          );
        } else {
          store.deleteElements([target]);
        }
      } else if (text) {
        store.addElement({
          id: uid('tx'),
          kind: 'text', x: rect.x, y: rect.y, w, h,
          color, fontSize, font: family, text, auto: auto || undefined, wrapW,
          layer: state.paintBehind ? 'back' : 'front',
          frame: state.activeFrameId ?? undefined,
          alayer: state.activeLayerId ?? undefined,
        });
      }
      invalidate();
    };
    ta.addEventListener('blur', commit);
    // copied text carries its look (typeface, rolled face, size, colour, marks) so a
    // paste into another box keeps it; foreign clipboard content pastes as the browser does
    const toClipboard = (e: ClipboardEvent) => {
      const clip = selectionToClipboard(ta, { font: family, face, fontSize, color });
      if (!clip || !e.clipboardData) return false;
      e.clipboardData.setData('text/html', clip.html);
      e.clipboardData.setData('text/plain', clip.text);
      e.preventDefault();
      return true;
    };
    ta.addEventListener('copy', toClipboard);
    ta.addEventListener('cut', (e) => { if (toClipboard(e)) { document.execCommand('delete'); place(); } });
    ta.addEventListener('paste', (e) => {
      const html = e.clipboardData?.getData('text/html') ?? '';
      const got = clipboardToMarkdown(html, { font: family, face });
      if (!got) return;
      e.preventDefault();
      document.execCommand('insertHTML', false, markdownToPasteHtml(got.md));
      place();
    });
    // the canvas swallows pointer events (no blur on touch): a tap anywhere that
    // isn't the editor or its controls finishes editing
    const outside = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || t === ta || ta.contains(t) || t.closest?.('.font-bar, .weight-pop, .toolbar, .shade-flyout, .popover')) return;
      commit();
    };
    document.addEventListener('pointerdown', outside, true);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); commit(); return; }
      // classic shortcuts, applied as real styling (serialized back to markdown on commit)
      if ((e.metaKey || e.ctrlKey) && (e.key === 'b' || e.key === 'i' || e.key === 'u')) {
        e.preventDefault();
        if (e.repeat) {
          // ⌘B held down → the weight picker instead of toggling bold again
          if (e.key === 'b' && weightPop.classList.contains('hidden')) { openWeights(); document.execCommand('bold'); }
          return;
        }
        document.execCommand(e.key === 'b' ? 'bold' : e.key === 'i' ? 'italic' : 'underline');
        place();
        syncMarks();
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
    if (menuPage) showNewPage(store.addPageAfter(menuPage));
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

  const timeline = buildTimeline(state, store, invalidate);

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
            <button class="doc-del" data-id="${m.id}" title="Delete zine">${svg('<path d="M4 7 H20 M9 7 V5 A1 1 0 0 1 10 4 H14 A1 1 0 0 1 15 5 V7 M6.5 7 L7.5 20 H16.5 L17.5 7"/>')}</button>
          </div>`,
        )
        .join('')}</div>
      <div class="docs-actions">
        <button id="doc-new">＋ New zine</button>
        <button id="doc-export">Export…</button>
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
      docsPop.classList.add('hidden');
      openExport();
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

  /** Pages in reading order (the zine's page order; by position until reordered). */
  const sortedPages = () => store.orderedPages();

  // ---------- export dialog ----------
  const exportPop = root.querySelector('#export-popover') as HTMLElement;
  const exOpts: ExportOptions = (() => {
    const d: ExportOptions = { scope: 'pages', format: 'png', dpi: 300, paperPattern: true };
    try { return { ...d, ...JSON.parse(readPref('infinizine-export') ?? '{}') }; } catch { return d; }
  })();
  const EX_NOTES: Record<ExportOptions['format'], string> = {
    png: 'One PNG per page (zipped when there are several).',
    pdf: 'All pages in one PDF, in reading order, at the page size.',
    gif: 'Animated pages only, as looping GIFs (up to 10 s, ≤1200 px).',
    html: 'A single .html file that shows the zine in any browser — nothing to install. Animated pages play as GIFs.',
    zine: 'The editable zine file (re-import it here).',
  };
  const syncExport = () => {
    const set = (id: string, v: string) => exportPop.querySelectorAll<HTMLElement>(`#${id} button`).forEach((b) => b.classList.toggle('active', b.dataset.v === v));
    set('ex-scope', exOpts.scope); set('ex-format', exOpts.format); set('ex-dpi', String(exOpts.dpi)); set('ex-paper', exOpts.paperPattern ? '1' : '0');
    (exportPop.querySelector('#ex-note') as HTMLElement).textContent = EX_NOTES[exOpts.format];
    const zine = exOpts.format === 'zine';
    for (const id of ['ex-scope', 'ex-dpi', 'ex-paper']) (exportPop.querySelector(`#${id}`)!.parentElement as HTMLElement).hidden = zine;
    writePref('infinizine-export', JSON.stringify(exOpts));
  };
  const openExport = () => { syncExport(); exportPop.classList.remove('hidden'); };
  for (const [id, apply] of [
    ['ex-scope', (v: string) => { exOpts.scope = v as ExportOptions['scope']; }],
    ['ex-format', (v: string) => { exOpts.format = v as ExportOptions['format']; }],
    ['ex-dpi', (v: string) => { exOpts.dpi = Number(v); }],
    ['ex-paper', (v: string) => { exOpts.paperPattern = v === '1'; }],
  ] as [string, (v: string) => void][]) {
    exportPop.querySelector(`#${id}`)!.addEventListener('click', (e) => {
      const v = (e.target as HTMLElement).closest('button')?.dataset.v;
      if (v === undefined) return;
      apply(v);
      syncExport();
    });
  }
  (exportPop.querySelector('#ex-go') as HTMLButtonElement).addEventListener('click', () => {
    exportPop.classList.add('hidden');
    void actions.exportZine({ ...exOpts });
  });
  document.addEventListener('pointerdown', (e) => {
    const t = e.target as HTMLElement;
    if (!t.closest?.('#export-popover') && !t.closest?.('#doc-export')) exportPop.classList.add('hidden');
  });

  // ---------- page order panel: thumbnails in reading order, drag to reorder ----------
  const pagesPanel = root.querySelector('#pages-panel') as HTMLElement;
  const pagesStrip = root.querySelector('#pages-strip') as HTMLElement;
  function buildPagesPanel() {
    pagesStrip.innerHTML = '';
    const pages = store.orderedPages();
    pages.forEach((p, i) => {
      const item = document.createElement('div');
      item.className = 'page-thumb';
      item.dataset.id = p.id;
      const c = actions.pageThumb(p, 96);
      c.className = 'page-thumb-img';
      const cap = document.createElement('span');
      cap.textContent = `${i + 1}`;
      item.append(c, cap);
      pressDrag(item, {
        onLift: () => item.classList.add('lifted'),
        onMove: (ev) => {
          // slide the thumb to where the pointer is among its siblings
          const sibs = [...pagesStrip.children] as HTMLElement[];
          const over = sibs.find((s) => s !== item && ev.clientX >= s.getBoundingClientRect().left && ev.clientX <= s.getBoundingClientRect().right);
          if (!over) return;
          const before = ev.clientX < over.getBoundingClientRect().left + over.offsetWidth / 2;
          if (before) pagesStrip.insertBefore(item, over); else over.after(item);
        },
        onEnd: () => {
          item.classList.remove('lifted');
          store.reorderPages(([...pagesStrip.children] as HTMLElement[]).map((s) => s.dataset.id!));
          buildPagesPanel();
          if (state.presenting) showPage(presentIndex);
        },
        onTap: () => {
          if (state.presenting) showPage(store.orderedPages().findIndex((x) => x.id === p.id));
          else { camera.x = p.x + p.w / 2; camera.y = p.y + p.h / 2; invalidate(); }
        },
      });
      pagesStrip.appendChild(item);
    });
  }
  const openPagesPanel = () => { buildPagesPanel(); pagesPanel.classList.remove('hidden'); };
  (root.querySelector('#pages-close') as HTMLButtonElement).addEventListener('click', () => pagesPanel.classList.add('hidden'));
  (root.querySelector('#pages-bypos') as HTMLButtonElement).addEventListener('click', () => { store.sortPagesByPosition(); buildPagesPanel(); if (state.presenting) showPage(presentIndex); });
  (root.querySelector('#present-pages') as HTMLButtonElement).addEventListener('click', openPagesPanel);
  (root.querySelector('#pm-order') as HTMLButtonElement).addEventListener('click', () => { hidePageMenu(); openPagesPanel(); });

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

  // floating history bar on the drawing-hand side (thumb reach), with the
  // selection menu; handedness is a setting (playground → interface)
  const hist = document.createElement('div');
  hist.className = 'hist-bar';
  hist.innerHTML = `
    <button id="undo" title="Undo (⌘Z)">${svg('<path d="M9 7 L4.5 11.5 L9 16"/><path d="M4.5 11.5 H14.5 a5 5 0 0 1 0 10 H11"/>')}</button>
    <button id="redo" title="Redo (⇧⌘Z)">${svg('<path d="M15 7 L19.5 11.5 L15 16"/><path d="M19.5 11.5 H9.5 a5 5 0 0 0 0 10 H13"/>')}</button>`;
  document.body.appendChild(hist);
  (hist.querySelector('#undo') as HTMLButtonElement).addEventListener('click', () => store.undo());
  (hist.querySelector('#redo') as HTMLButtonElement).addEventListener('click', () => store.redo());
  const HAND_KEY = 'infinizine-hand';
  const applyHand = () => {
    let hand = 'right';
    try { hand = localStorage.getItem(HAND_KEY) ?? 'right'; } catch { /* ignore */ }
    document.body.classList.toggle('left-hand', hand === 'left');
  };
  applyHand();
  setInterval(() => { hist.hidden = state.presenting; }, 300);

  const layerToggle = root.querySelector('#layer-toggle') as HTMLButtonElement;
  layerToggle.addEventListener('click', () => {
    state.paintBehind = !state.paintBehind;
    state.rememberTool(); // per tool: the marker can stay behind while the pen paints in front
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

  const DRAW_TOOLS: Tool[] = ['pen', 'pencil', 'fineliner', 'marker', 'lasso-fill', 'lasso-blob'];
  function refresh() {
    if (DRAW_TOOLS.includes(state.tool)) state.lastDrawTool = state.tool;
    state.updateCursor();
    syncPatBtn(); // the pattern is per tool, like the colour
    refreshToolSamples();
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
    const pr = getPalette(store.doc.palette);
    const tops = pr.hues.slice(0, 6).map((h) => h.toLowerCase());
    const cur = state.color.toLowerCase();
    palRow.querySelectorAll<HTMLElement>('.pal-main').forEach((d) => {
      const hue = d.dataset.hue!;
      const sh = (pr.strict ? (pr.ramps?.[hue] ?? []) : shades(hue, drama)).map((c) => c.toLowerCase());
      // a swatch lights up for its own colour or one of its shades — but a colour that is
      // itself a top-level swatch belongs to that swatch alone (hardware ramps share greys)
      const viaShade = hue.toLowerCase() !== cur && sh.includes(cur) && !tops.includes(cur);
      d.classList.toggle('active', hue.toLowerCase() === cur || viaShade);
      d.style.background = viaShade ? (isPattern(state.color) ? patternPreviewCSS(state.color, undefined, 4.5) : state.color) : hue;
    });
    // Layer symbol: current-color stroke over / behind a white square
    const sq = '<rect x="8" y="8" width="10" height="10" fill="#fdfcf8" stroke="rgba(90,75,50,0.5)" stroke-width="1"/>';
    const st = `<path d="M4 20 C6 13 10 18 12 12 C14 6 18 11 20 4" fill="none" stroke="${state.color}" stroke-width="2.6" stroke-linecap="round"/>`;
    layerToggle.innerHTML = `<svg viewBox="0 0 24 24">${state.paintBehind ? st + sq : sq + st}</svg>`;
    layerToggle.title = state.paintBehind
      ? 'Painting behind existing ink (tap for in front)'
      : 'Painting in front (tap to paint behind)';
    fingerToggle.innerHTML =
      state.fingerMode === 'draw'
        ? svg(FINGER_ICON + '<path d="M15 20.5 l4.5-4.5 M17 15 l3 3"/>') // finger + pencil stroke
        : state.fingerMode === 'pan'
          ? svg(FINGER_ICON + '<path d="M14.5 17.5 h6 M18 15 l2.5 2.5 -2.5 2.5"/>') // finger + move arrow
          : svg(FINGER_ICON + '<rect x="14" y="14" width="6.5" height="6.5" stroke-dasharray="2 1.5"/>'); // finger + marquee
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
    <button id="sm-rot" title="Rotate pattern 15° (shift-click: 45°)">${svg('<path d="M19 12 a7 7 0 1 1 -2.05 -4.95"/><path d="M19 4 v4 h-4"/><circle cx="12" cy="12" r="2"/>')}</button>
    <button id="sm-cstyle" title="Pick up this text's style">${svg('<path d="M2 22l1-1h3l9-9 M3 21v-3l9-9 M15 6l3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/>')}</button>
    <button id="sm-pstyle" title="Apply the picked-up style to the selected text">${svg('<path d="M4 2h12a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z M10 16v-2a2 2 0 0 1 2-2h8a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2 M9 16h2a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1Z"/>')}</button>
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
  (selMenu.querySelector('#sm-rot') as HTMLButtonElement).addEventListener('click', (e) => {
    store.rotatePatterns([...state.selection], (e as MouseEvent).shiftKey ? 45 : 15);
    invalidate();
  });
  (selMenu.querySelector('#sm-front') as HTMLButtonElement).addEventListener('click', () => {
    store.reorder([...state.selection], 'front');
    invalidate();
  });
  (selMenu.querySelector('#sm-cstyle') as HTMLButtonElement).addEventListener('click', () => {
    const t = store.doc.elements.find((el) => el.kind === 'text' && state.selection.has(el.id));
    if (t && t.kind === 'text') { writeStyleClip(styleOf(t)); tipAt(selMenu.querySelector('#sm-cstyle')!, 'Style copied'); }
  });
  (selMenu.querySelector('#sm-pstyle') as HTMLButtonElement).addEventListener('click', () => {
    const s = readStyleClip();
    if (!s || !FONTS[s.font]) return;
    for (const el of store.doc.elements) if (el.kind === 'text' && state.selection.has(el.id)) restyleText(el, s);
    tipAt(selMenu.querySelector('#sm-pstyle')!, 'Style applied');
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
    const hasPatternFill = hasSel && store.doc.elements.some((el) => el.kind === 'fill' && el.pattern && state.selection.has(el.id));
    (selMenu.querySelector('#sm-rot') as HTMLButtonElement).hidden = !hasPatternFill;
    (selMenu.querySelector('#sm-front') as HTMLButtonElement).hidden = !hasSel;
    const selTexts = hasSel ? store.doc.elements.filter((el) => el.kind === 'text' && state.selection.has(el.id)).length : 0;
    (selMenu.querySelector('#sm-cstyle') as HTMLButtonElement).hidden = selTexts !== 1;
    const pstyle = selMenu.querySelector('#sm-pstyle') as HTMLButtonElement;
    pstyle.hidden = !(selTexts > 0 && readStyleClip());
    pstyle.classList.toggle('badged', !!readStyleClip());
    const pasteBtn = selMenu.querySelector('#sm-paste') as HTMLButtonElement;
    // touch devices can't peek at the system clipboard (a screenshot, say): with a
    // selection tool active the paste button is always offered; tapping it asks iOS
    const offerPaste = hasClip || (navigator.maxTouchPoints > 0 && (state.tool === 'cursor' || state.tool === 'lasso-select'));
    pasteBtn.hidden = !offerPaste;
    pasteBtn.classList.toggle('badged', hasClip);
    selMenu.classList.toggle('hidden', !(hasSel || hasArea || offerPaste));
  }, 300);

  const { el: pg, button: pgBtn, toggle: togglePg } = buildPlayground(root, state, store);
  const settingsPop = root.querySelector('#settings-popover') as HTMLElement;
  // typeface pickers: one <select> per role, options rendered in their own face
  const fontsBox = settingsPop.querySelector('#set-fonts') as HTMLElement;
  const ROLE_LABEL: Record<FontRole, string> = { franklin: 'Sans', serif: 'Serif', mono: 'Mono', comic: 'Comic', shout: 'Shout' };
  const SAMPLE: Record<FontRole, string> = {
    franklin: 'The quick brown fox jumps over 13 lazy dogs.',
    serif: 'Once upon a midnight dreary, while I pondered…',
    mono: 'const zine = await fold(pages, 8);',
    comic: 'Whoa!! Did you see that?! Let\'s go!',
    shout: 'BAM! KAPOW! EXTRA! EXTRA!',
  };
  // Typefaces have two layers: app-wide picks (this device) and per-zine
  // overrides saved in the document. The scope toggle says which one you edit.
  let facesScope: 'zine' | 'app' = 'zine';
  let openPicker: HTMLElement | null = null;
  const closePicker = () => { openPicker?.remove(); openPicker = null; };
  const faceBtns: Partial<Record<FontRole, HTMLButtonElement>> = {};
  const currentPick = (role: FontRole) => (facesScope === 'zine' ? chosenFaces[role] : appFaces[role]);
  const syncFaceBtns = () => {
    for (const role of Object.keys(FACES) as FontRole[]) {
      const btn = faceBtns[role]!;
      const f = FACES[role].find((x) => x.id === currentPick(role)) ?? FACES[role][0];
      const overridden = !!store.doc.faces?.[role];
      btn.textContent = f.name + (facesScope === 'zine' && overridden ? ' ·' : '');
      btn.title = facesScope === 'zine'
        ? overridden ? 'Set for this zine (dot = overrides the app-wide pick)' : 'Following the app-wide pick'
        : 'App-wide default for zines without their own pick';
      btn.style.fontFamily = f.css;
    }
    settingsPop.querySelectorAll<HTMLElement>('#set-faces-scope button').forEach((b) => b.classList.toggle('active', b.dataset.v === facesScope));
    (settingsPop.querySelector('#set-faces-reset') as HTMLElement).hidden = facesScope !== 'zine' || !store.doc.faces;
  };
  const restyleFaces = () => {
    setDocFaces(store.doc.faces);
    const css = (Object.keys(FACES) as FontRole[]).map((r) => FONTS[r].css);
    Promise.all(css.map((c) => document.fonts.load(`16px ${c}`).catch(() => []))).finally(() => window.dispatchEvent(new Event('izine-restyle')));
    refresh();
    syncFaceBtns();
  };
  for (const role of Object.keys(FACES) as FontRole[]) {
    const row = document.createElement('div');
    row.className = 'set-row';
    const btn = document.createElement('button');
    btn.className = 'face-btn';
    faceBtns[role] = btn;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (openPicker?.dataset.role === role) { closePicker(); return; }
      closePicker();
      // a real preview list: every face shows its name and a sentence in itself
      const pick = document.createElement('div');
      pick.className = 'face-pick';
      pick.dataset.role = role;
      for (const f of FACES[role]) {
        const o = document.createElement('button');
        o.className = `face-opt${f.id === currentPick(role) ? ' active' : ''}`;
        o.style.fontFamily = f.css;
        o.innerHTML = `<span class="face-name">${f.name}</span><span class="face-sample">${SAMPLE[role]}</span>`;
        o.addEventListener('click', () => {
          if (facesScope === 'zine') store.setFaces({ ...(store.doc.faces ?? {}), [role]: f.id }); // saved in the zine, undoable
          else setFace(role, f.id); // device default
          closePicker();
          restyleFaces();
        });
        pick.appendChild(o);
      }
      const r = btn.getBoundingClientRect();
      pick.style.top = `${r.bottom + 6}px`;
      pick.style.right = `${window.innerWidth - r.right}px`;
      document.body.appendChild(pick);
      openPicker = pick;
    });
    row.append(Object.assign(document.createElement('span'), { textContent: ROLE_LABEL[role] }), btn);
    fontsBox.appendChild(row);
  }
  settingsPop.querySelector('#set-faces-scope')!.addEventListener('click', (e) => {
    const v = (e.target as HTMLElement).closest('button')?.dataset.v as 'zine' | 'app' | undefined;
    if (!v) return;
    facesScope = v;
    closePicker();
    syncFaceBtns();
  });
  (settingsPop.querySelector('#set-faces-reset') as HTMLButtonElement).addEventListener('click', () => {
    store.setFaces(undefined);
    restyleFaces();
  });
  syncFaceBtns();
  document.addEventListener('pointerdown', (e) => {
    if (!(e.target as HTMLElement).closest('.face-pick, .face-btn')) closePicker();
  });
  const syncSettings = () => {
    syncFaceBtns();
    const left = document.body.classList.contains('left-hand');
    settingsPop.querySelectorAll<HTMLElement>('#set-hand button').forEach((b) => b.classList.toggle('active', b.dataset.v === (left ? 'left' : 'right')));
    settingsPop.querySelectorAll<HTMLElement>('#set-adaptive button').forEach((b) => b.classList.toggle('active', b.dataset.v === (state.adaptiveSize ? '1' : '0')));
    settingsPop.querySelectorAll<HTMLElement>('#set-lock button').forEach((b) => b.classList.toggle('active', b.dataset.v === (state.zoomLocked ? '1' : '0')));
    settingsPop.querySelectorAll<HTMLElement>('#set-fundo button').forEach((b) => b.classList.toggle('active', b.dataset.v === (state.fingerUndo ? '1' : '0')));
    settingsPop.querySelectorAll<HTMLElement>('#set-perf button').forEach((b) => b.classList.toggle('active', b.dataset.v === (state.perfHud ? '1' : '0')));
  };
  // performance readout: a legible pill under the top bar (the canvas badge is too small and sits under the toolbar)
  const perfHud = document.createElement('div');
  perfHud.className = 'perf-hud';
  perfHud.hidden = true;
  document.body.appendChild(perfHud);
  setInterval(() => {
    perfHud.hidden = !state.perfHud;
    if (state.perfHud) perfHud.textContent = state.perfLine || 'draw something…';
  }, 250);
  settingsPop.querySelector('#set-perf')!.addEventListener('click', (e) => {
    const v = (e.target as HTMLElement).closest('button')?.dataset.v;
    if (!v) return;
    state.perfHud = v === '1';
    writePref('infinizine-perf', v);
    syncSettings();
    invalidate();
  });
  settingsPop.querySelector('#set-fundo')!.addEventListener('click', (e) => {
    const v = (e.target as HTMLElement).closest('button')?.dataset.v;
    if (!v) return;
    state.fingerUndo = v === '1';
    writePref('infinizine-finger-undo', v);
    syncSettings();
  });
  // full screen: the browser chrome goes away (not offered where the API is missing, e.g. iPhone or an installed web app)
  const fsBtn = root.querySelector('#fullscreen') as HTMLButtonElement;
  type FsDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void };
  type FsEl = HTMLElement & { webkitRequestFullscreen?: () => void };
  const fsDoc = document as FsDoc, fsRoot = document.documentElement as FsEl;
  const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if ((!fsRoot.requestFullscreen && !fsRoot.webkitRequestFullscreen) || standalone) fsBtn.hidden = true;
  const syncFs = () => fsBtn.classList.toggle('on', !!(document.fullscreenElement || fsDoc.webkitFullscreenElement));
  fsBtn.addEventListener('click', () => {
    if (document.fullscreenElement || fsDoc.webkitFullscreenElement) (document.exitFullscreen?.bind(document) ?? fsDoc.webkitExitFullscreen?.bind(document))?.();
    else (fsRoot.requestFullscreen?.bind(fsRoot) ?? fsRoot.webkitRequestFullscreen?.bind(fsRoot))?.();
  });
  document.addEventListener('fullscreenchange', syncFs);
  document.addEventListener('webkitfullscreenchange', syncFs);
  settingsPop.querySelector('#set-hand')!.addEventListener('click', (e) => {
    const v = (e.target as HTMLElement).closest('button')?.dataset.v;
    if (!v) return;
    writePref('infinizine-hand', v);
    document.body.classList.toggle('left-hand', v === 'left');
    syncSettings();
  });
  settingsPop.querySelector('#set-adaptive')!.addEventListener('click', (e) => {
    const v = (e.target as HTMLElement).closest('button')?.dataset.v;
    if (!v) return;
    state.adaptiveSize = v === '1';
    writePref(ADAPTIVE_KEY, v);
    state.updateCursor();
    refresh();
    syncSettings();
  });
  settingsPop.querySelector('#set-lock')!.addEventListener('click', (e) => {
    const v = (e.target as HTMLElement).closest('button')?.dataset.v;
    if (!v) return;
    state.zoomLocked = v === '1';
    writePref('infinizine-zoom-lock', v);
    refresh();
    invalidate();
    syncSettings();
  });
  (settingsPop.querySelector('#set-brushes') as HTMLButtonElement).addEventListener('click', () => {
    settingsPop.classList.add('hidden');
    togglePg(true);
  });
  pgBtn.addEventListener('click', () => {
    const open = settingsPop.classList.contains('hidden');
    docsPop.classList.add('hidden');
    settingsPop.classList.toggle('hidden', !open);
    pgBtn.classList.toggle('on', open);
    if (open) syncSettings();
  });
  document.addEventListener('pointerdown', (e) => {
    const t = e.target as HTMLElement;
    if (!t.closest?.('#settings-popover') && !t.closest?.('#playground')) {
      settingsPop.classList.add('hidden');
      if (pg.classList.contains('hidden')) pgBtn.classList.remove('on');
    }
  });
  (pg.querySelector('#pg-close') as HTMLButtonElement).addEventListener('click', () => togglePg(false));
  (pg.querySelector('#pg-close-big') as HTMLButtonElement).addEventListener('click', () => togglePg(false));
  // tapping the dimmed backdrop closes too
  pg.addEventListener('pointerdown', (e) => { if (e.target === pg) togglePg(false); });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pg.classList.contains('hidden')) togglePg(false);
  });

  state.onToolChange = refresh;
  buildPalRow();

  // keeps the timeline in sync after undo/redo or external changes
  // per-zine last colour: restore when a (different) document becomes current
  let colorDocId = '';
  const restoreColor = () => {
    if (store.docId === colorDocId) return;
    colorDocId = store.docId;
    let c: string | null = null;
    try { c = localStorage.getItem(`infinizine-color-${store.docId}`) ?? localStorage.getItem('infinizine-last-color'); } catch { /* ignore */ }
    if (c) { state.color = c; refresh(); state.updateCursor(); }
  };
  restoreColor();

  // the document arrives asynchronously (IndexedDB) and can switch (library):
  // rebuild the palette row whenever the active palette differs from what's shown
  let shownPalette = store.doc.palette;
  let shownFaces = '';
  const syncDocFaces = () => {
    const key = JSON.stringify(store.doc.faces ?? null);
    if (key === shownFaces) return;
    shownFaces = key;
    restyleFaces();
  };
  syncDocFaces();
  return {
    docChanged() {
      syncDocFaces();
      if (store.doc.palette !== shownPalette) {
        shownPalette = store.doc.palette;
        buildPalRow();
        if (!palettePop.classList.contains('hidden')) buildPalettePopover();
      }
      restoreColor();
      timeline.renderIfOpen();
    },
  };
}
