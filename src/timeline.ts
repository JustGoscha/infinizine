// The animation timeline: a floating / dockable panel with keyframe tracks,
// live-line bars, the playhead, transport and frame operations. Opened through
// state.onAnimOpen (set here), closed through state.onAnimClose.

import { Store } from './store';
import { InputState } from './state';
import { svg } from './icons';
import { pressDrag } from './pointer-ui';
import { animClock } from './clock';
import type { AnimArea, AnimFrame } from './types';

export function buildTimeline(state: InputState, store: Store, invalidate: () => void) {
  // ---------- animation timeline (floating, draggable window) ----------
  const tl = document.createElement('div');
  tl.className = 'timeline hidden';
  document.body.appendChild(tl);
  let tlAreaId: string | null = null;
  let tlStep: (d: number) => void = () => {}; // frame stepper of the current render (arrow keys, jog)
  type Frames = { id: string; duration: number }[];
  const layerTotal = (frames: Frames) => frames.reduce((a, f) => a + f.duration, 0);
  /** frame of a layer showing at `tick` (holds the last frame past the layer's end) */
  const frameAtTick = (frames: Frames, tick: number): string | null => {
    if (!frames.length) return null;
    let t = Math.max(0, Math.min(tick, layerTotal(frames) - 1));
    for (const f of frames) { t -= f.duration; if (t < 0) return f.id; }
    return frames[frames.length - 1].id;
  };
  const frameSpan = (frames: Frames, fid: string): { start: number; end: number } | null => {
    let acc = 0;
    for (const f of frames) { if (f.id === fid) return { start: acc, end: acc + f.duration }; acc += f.duration; }
    return null;
  };
  /** the whole animation's length in ticks: longest keyframe track, extended by non-looping live lines (as playback) */
  const areaTotalTicks = (area: AnimArea): number => {
    let total = Math.max(1, ...area.layers.filter((l) => l.kind !== 'live').map((l) => layerTotal(l.frames)));
    for (const l of area.layers) {
      if (l.kind !== 'live' || l.loop !== false) continue;
      for (const el of store.doc.elements) {
        if (el.kind !== 'stroke' || el.alayer !== l.id) continue;
        const drawn = (el.points[el.points.length - 1]?.t ?? 0) * area.fps;
        total = Math.max(total, Math.ceil((el.animStart ?? 0) + drawn + Math.max(1, el.animLife ?? 6)));
      }
    }
    return total;
  };
  let lastTlFid: string | null = null; // active frame at the last render (detects an explicit frame pick)
  window.addEventListener('keydown', (e) => {
    if (!tlAreaId || tl.classList.contains('hidden') || state.presenting) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); tlStep(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); tlStep(1); }
    else if (e.key === ' ') { e.preventDefault(); (tl.querySelector('#tl-play') as HTMLElement | null)?.click(); }
  });
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
    state.editTick = null;
    state.activeLayerId = null;
    state.playingAreas = false;
    tl.classList.add('hidden');
    syncTlInsets();
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
    state.editTick = 0;
    tl.classList.remove('hidden');
    renderTimeline();
    invalidate();
    syncTlInsets();
  };

  // A docked timeline must not bury the floating menus (undo/redo, selection) in its corner:
  // publish its extent per screen edge so they slide out of the way (style.css reads the vars).
  function syncTlInsets() {
    const st = document.body.style;
    const shown = !tl.classList.contains('hidden') && tlDock !== 'float';
    const r = shown ? tl.getBoundingClientRect() : null;
    st.setProperty('--tl-bottom', r && tlDock === 'bottom' ? `${r.height}px` : '0px');
    st.setProperty('--tl-top', r && tlDock === 'top' ? `${r.height}px` : '0px');
    st.setProperty('--tl-left', r && tlDock === 'left' ? `${r.width}px` : '0px');
    st.setProperty('--tl-right', r && tlDock === 'right' ? `${r.width}px` : '0px');
  }
  new ResizeObserver(() => syncTlInsets()).observe(tl);
  window.addEventListener('resize', syncTlInsets);

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
    syncTlInsets();
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
    const elapsed = animClock.now() - state.playEpoch;
    let tick = Math.floor(elapsed * area.fps);
    tick = area.loop ? ((tick % total) + total) % total : Math.min(tick, total - 1);
    // the playhead line glides (fractional ticks); the live view runs on the raw clock
    const fine = elapsed * area.fps;
    tlPlayhead(tlView === 'live' ? fine : area.loop ? ((fine % total) + total) % total : Math.min(fine, total - 1));
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

  // hold a frame tile (without dragging it): a small ring of frame actions around the finger
  const radial = document.createElement('div');
  radial.className = 'tl-radial hidden';
  radial.innerHTML = `
    <button data-a="copy-before" class="rd-nw" title="Copy this frame before it">${svg('<path d="M11 8 L5 12 L11 16"/><rect x="12" y="8.5" width="8" height="8" rx="1"/><path d="M9.5 13.5V6.5a1 1 0 0 1 1-1H17"/>')}</button>
    <button data-a="copy-after" class="rd-ne" title="Copy this frame after it">${svg('<rect x="4" y="8.5" width="8" height="8" rx="1"/><path d="M1.5 13.5V6.5a1 1 0 0 1 1-1H9"/><path d="M13 8 L19 12 L13 16"/>')}</button>
    <button data-a="empty-before" class="rd-w" title="Insert an empty frame before">${svg('<path d="M10 8 L4 12 L10 16"/><rect x="12" y="6" width="8" height="12" rx="1"/><path d="M16 9.5v5M13.5 12h5"/>')}</button>
    <button data-a="empty-after" class="rd-e" title="Insert an empty frame after">${svg('<rect x="4" y="6" width="8" height="12" rx="1"/><path d="M8 9.5v5M5.5 12h5"/><path d="M14 8 L20 12 L14 16"/>')}</button>
    <span class="rd-center"></span>
  `;
  document.body.appendChild(radial);
  let radialTarget: { areaId: string; layerId: string; frameId: string } | null = null;
  function openFrameRadial(e: { clientX: number; clientY: number }, areaId: string, layerId: string, frameId: string) {
    radialTarget = { areaId, layerId, frameId };
    radial.classList.remove('hidden');
    const R = 74; // keep the whole ring on screen
    radial.style.left = `${Math.max(R, Math.min(window.innerWidth - R, e.clientX))}px`;
    radial.style.top = `${Math.max(R, Math.min(window.innerHeight - R, e.clientY))}px`;
  }
  radial.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest('button')?.dataset.a;
    const t = radialTarget;
    radial.classList.add('hidden');
    radialTarget = null;
    if (!a || !t) return;
    const l = store.animLayer(t.areaId, t.layerId);
    const idx = l ? l.frames.findIndex((f) => f.id === t.frameId) : -1;
    if (!l || idx < 0) return;
    let nf: AnimFrame | null = null;
    if (a === 'copy-before') nf = store.duplicateFrame(t.areaId, t.layerId, t.frameId, 'before');
    else if (a === 'copy-after') nf = store.duplicateFrame(t.areaId, t.layerId, t.frameId, 'after');
    else if (a === 'empty-before') nf = store.addFrame(t.areaId, t.layerId, idx, l.frames[idx].duration);
    else if (a === 'empty-after') nf = store.addFrame(t.areaId, t.layerId, idx + 1, l.frames[idx].duration);
    if (nf) {
      state.activeLayerId = t.layerId;
      state.activeFrameId = nf.id;
      state.editTick = null; // land on the new frame
    }
    renderTimeline();
    invalidate();
  });
  document.addEventListener('pointerdown', (e) => {
    if (!(e.target as HTMLElement).closest?.('.tl-radial')) radial.classList.add('hidden');
  });

  /** moves the playhead line across the tracks (set by each render; null hides it) */
  let tlPlayhead: (tick: number | null) => void = () => {};

  function renderTimeline() {
    const area = tlAreaId ? store.area(tlAreaId) : undefined;
    if (!area) { closeTimeline(); return; }
    const prevTracks = tl.querySelector('.tl-tracks') as HTMLElement | null;
    const prevScroll = prevTracks?.scrollTop ?? 0;
    const prevScrollLeft = prevTracks?.scrollLeft ?? 0;
    const prevActive = prevTracks?.querySelector('.tl-frame.active')?.getAttribute('data-fid') ?? null;
    if (!area.layers.some((l) => l.id === state.activeLayerId)) {
      state.activeLayerId = area.layers[area.layers.length - 1]?.id ?? null;
    }
    // an undo can leave the area without layers or the active frame gone: never crash, just show what's there
    const activeLayer = area.layers.find((l) => l.id === state.activeLayerId);
    const total = areaTotalTicks(area);
    if (state.editTick !== null) state.editTick = Math.max(0, Math.min(total - 1, state.editTick));
    if (activeLayer && activeLayer.frames.length) {
      const frames = activeLayer.frames;
      if (!frames.some((f) => f.id === state.activeFrameId)) {
        // the frame is gone (deleted / undone) or another layer was picked: stay at the position
        state.activeFrameId = frameAtTick(frames, state.editTick ?? 0);
      } else if (state.activeFrameId !== lastTlFid) {
        // a frame was picked outright: land on its start unless the position already lies inside it
        const span = frameSpan(frames, state.activeFrameId!)!;
        const end = state.activeFrameId === frames[frames.length - 1].id ? Math.max(span.end, total) : span.end; // the last frame holds to the end
        if (state.editTick === null || state.editTick < span.start || state.editTick >= end) state.editTick = span.start;
      } else if (state.editTick !== null) {
        state.activeFrameId = frameAtTick(frames, state.editTick);
      }
      if (state.editTick === null) state.editTick = frameSpan(frames, state.activeFrameId!)?.start ?? 0;
    } else if (activeLayer) {
      state.activeFrameId = null;
    }
    if (!activeLayer) state.activeFrameId = null;
    lastTlFid = state.activeFrameId;
    const fid = state.activeFrameId ?? '';
    const lid = state.activeLayerId ?? '';
    const frameIdx = activeLayer ? activeLayer.frames.findIndex((f) => f.id === fid) : -1;
    const posLabel = () => `${(state.editTick ?? 0) + 1} / ${total}`;
    const nFrameLayers = area.layers.filter((l) => l.kind !== 'live').length;
    const nLiveLayers = area.layers.filter((l) => l.kind === 'live').length;
    tl.innerHTML = `
      <div class="tl-head">
        <span class="tl-grip" title="Drag to move">⠿</span>
        <span class="tl-name" title="Double-click to rename">${area.name}</span>
        <input id="tl-fps" type="number" min="1" max="60" value="${area.fps}" title="fps"><span class="tl-fpslabel">fps</span>
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
      </div>
      <button id="tl-close" class="tl-close" title="Close the timeline">${svg('<path d="M6 6 L18 18 M18 6 L6 18"/>')}</button>
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
        <button id="tl-del" class="tl-trash" title="Delete the current frame">${svg('<path d="M4 7 H20 M9 7 V5 A1 1 0 0 1 10 4 H14 A1 1 0 0 1 15 5 V7 M6.5 7 L7.5 20 H16.5 L17.5 7"/>')}</button>
        <button id="tl-add" title="Add frame after the current one">${svg('<path d="M12 6v12M6 12h12"/>')}</button>
        <button id="tl-dup" title="Duplicate frame">${svg('<rect x="8" y="8" width="11" height="11" rx="1"/><path d="M5 15V6a1 1 0 0 1 1-1h9"/>')}</button>
        <span class="tl-sep"></span>
        <button id="tl-shorter" title="Shorter">${svg('<path d="M5 6v12M19 12H8M12 8l-4 4 4 4"/>')}</button>
        <button id="tl-longer" title="Longer">${svg('<path d="M19 6v12M5 12h11M12 8l4 4-4 4"/>')}</button>
        <span class="tl-sep"></span>
        <span class="tl-layers-label">layers</span>
        <button id="tl-addlayer" title="Add layer">${svg('<path d="M12 6v12M6 12h12"/>')}</button>
        <span class="tl-sep tl-push"></span>
        <button id="tl-zoom-out" class="tl-zoom" title="Zoom timeline out">${svg('<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5M7.5 10.5h6"/>')}</button>
        <button id="tl-zoom-in" class="tl-zoom" title="Zoom timeline in">${svg('<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5M7.5 10.5h6M10.5 7.5v6"/>')}</button>
      </div>`
        : `<div class="tl-ops">
        <span class="tl-layers-label" title="How long a stroke drawn while playing stays visible">live ink duration</span>
        <button id="tl-life-minus" title="Shorter">${svg('<path d="M6 12h12"/>')}</button>
        <span class="tl-life" id="tl-life">${state.liveInkLife} frames</span>
        <button id="tl-life-plus" title="Longer">${svg('<path d="M12 6v12M6 12h12"/>')}</button>
        <button id="tl-taper" class="tl-toggle ${state.liveInkTaper ? 'on' : ''}" title="Tail eats away over its life">taper</button>
        <button id="tl-showink" class="tl-toggle ${state.showLiveInk ? 'on' : ''}" title="Show live ink while editing (it always shows in playback)">show</button>
        <span class="tl-sep tl-push"></span>
        <button id="tl-zoom-out" class="tl-zoom" title="Zoom timeline out">${svg('<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5M7.5 10.5h6"/>')}</button>
        <button id="tl-zoom-in" class="tl-zoom" title="Zoom timeline in">${svg('<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5M7.5 10.5h6M10.5 7.5v6"/>')}</button>
      </div>`}
      <div class="tl-nav">
        <button id="tl-play" class="tl-nav-play" title="Play / pause (space)">${state.playingAreas ? svg('<path d="M8 5v14M16 5v14"/>') : svg('<path d="M7 5 L19 12 L7 19 Z"/>')}</button>
        <button id="tl-rec" class="tl-nav-rec${state.recording ? ' on' : ''}" title="Record: plays the area and keeps every line you draw as a live line">${svg('<circle cx="12" cy="12" r="6" fill="currentColor" stroke="none"/>')}</button>
        ${activeLayer && activeLayer.kind !== 'live'
          ? `<button id="tl-prev" title="Previous frame (←)">${svg('<path d="M14.5 6 L8.5 12 L14.5 18"/>')}</button>
        <div class="tl-jog" id="tl-jog" title="Swipe or scroll to flip through the animation"><span class="tl-jog-ticks"></span><span class="tl-pos" id="tl-pos" title="Position in the animation · frame ${frameIdx + 1} of this layer">${posLabel()}</span><span class="tl-time" id="tl-time"></span></div>
        <button id="tl-next" title="Next frame (→)">${svg('<path d="M9.5 6 L15.5 12 L9.5 18"/>')}</button>
        <button id="tl-addnext" title="New frame after this one">${svg('<path d="M12 6v12M6 12h12"/>')}</button>`
          : `<div class="tl-jog tl-jog-off"><span class="tl-pos">live lines</span><span class="tl-time" id="tl-time"></span></div>`}
      </div>
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
          : `<button data-a="del" class="tl-trash" title="Delete layer">${svg('<path d="M4 7 H20 M9 7 V5 A1 1 0 0 1 10 4 H14 A1 1 0 0 1 15 5 V7 M6.5 7 L7.5 20 H16.5 L17.5 7"/>')}</button>`}`;
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
          state.activeFrameId = topFrames ? frameAtTick(topFrames.frames, state.editTick ?? 0) : null;
        } else {
          state.activeLayerId = l.id;
          state.activeFrameId = frameAtTick(l.frames, state.editTick ?? 0); // stay at the position
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
        let barStartX = 0;
        bar.addEventListener('pointerdown', (e) => { barStartX = e.clientX; });
        pressDrag(bar, {
          onMove: (_ev, dx) => {
            bar.style.transform = `translateX(${Math.round(dx / liveScale) * liveScale}px)`;
          },
          onEnd: (ev) => {
            bar.style.transform = '';
            state.activeLayerId = l.id;
            state.activeFrameId = null;
            store.shiftLiveLayer(l.id, Math.round((ev.clientX - barStartX) / liveScale));
            renderTimeline();
            invalidate();
          },
          onTap: () => {
            bar.style.transform = '';
            const wasActive = state.activeLayerId === l.id;
            state.activeLayerId = l.id;
            state.activeFrameId = null;
            if (wasActive) {
              // tapping the active line again deselects it
              state.selection.clear();
              state.blinkLayerId = null;
              const topFrames = [...area.layers].reverse().find((x) => x.kind !== 'live');
              state.activeLayerId = topFrames?.id ?? l.id;
              state.activeFrameId = topFrames ? frameAtTick(topFrames.frames, state.editTick ?? 0) : null;
            } else {
              // select the layer's strokes and blink them so it's obvious which ink this is
              state.selection = new Set(strokes.map((st) => st.id));
              state.blinkLayerId = l.id;
              state.blinkStart = performance.now() / 1000;
            }
            renderTimeline();
            invalidate();
          },
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
        b.title = `${l.name} · frame ${i + 1} · ${f.duration}f (drag to reorder, drag the edge to lengthen)`;
        // right-edge grip: drag to lengthen/shorten the frame (in ticks)
        const grip = document.createElement('span');
        grip.className = 'tl-frame-grip';
        grip.title = 'Drag to change duration';
        // hold (touch/pen) then drag to change the duration; a plain swipe over the edge just scrolls
        grip.addEventListener('pointerdown', (e) => e.stopPropagation()); // not a reorder / tap of the tile
        {
          const perTick = 30 * tlZoom;
          let dur = f.duration;
          pressDrag(grip, {
            onLift: () => b.classList.add('resizing'),
            onMove: (_ev, dx) => {
              dur = Math.max(1, Math.round(f.duration + dx / perTick));
              b.style.width = `${Math.max(14, perTick * dur)}px`;
              b.classList.add('resizing');
            },
            onEnd: () => {
              b.classList.remove('resizing');
              if (dur !== f.duration) store.setFrameDuration(area.id, l.id, f.id, dur);
              renderTimeline();
              invalidate();
            },
            onTap: () => { b.classList.remove('resizing'); },
          });
        }
        b.appendChild(grip);
        // tap selects; horizontal drag reorders within the layer
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
        pressDrag(b, {
          onMove: (ev, dx) => {
            if (!marker) {
              b.classList.add('dragging');
              marker = document.createElement('div');
              marker.className = 'tl-insert';
              strip.appendChild(marker);
            }
            // ghost follows the pointer
            b.style.transform = `translate(${dx}px, -3px)`;
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
          },
          onEnd: (ev) => {
            b.classList.remove('dragging');
            b.style.transform = '';
            marker?.remove();
            marker = null;
            state.activeLayerId = l.id;
            state.activeFrameId = f.id;
            state.editTick = null; // settle on the moved frame's new start
            store.moveFrame(area.id, l.id, i, insertIndex(ev.clientX).to);
            renderTimeline();
            invalidate();
          },
          onTap: () => {
            b.classList.remove('dragging');
            b.style.transform = '';
            marker?.remove();
            marker = null;
            state.activeLayerId = l.id;
            state.activeFrameId = f.id;
            state.editTick = frameSpan(l.frames, f.id)?.start ?? 0;
            renderTimeline();
            invalidate();
          },
          onHold: (ev) => {
            // held still and let go: pick the frame and offer copies / empties around it
            b.classList.remove('dragging');
            b.style.transform = '';
            marker?.remove();
            marker = null;
            state.activeLayerId = l.id;
            state.activeFrameId = f.id;
            state.editTick = frameSpan(l.frames, f.id)?.start ?? 0;
            renderTimeline();
            invalidate();
            openFrameRadial(ev, area.id, l.id, f.id);
          },
        });
        strip.appendChild(b);
      });
      // always a "+" after the last frame: the next frame is one tap away
      const addTile = document.createElement('button');
      addTile.className = 'tl-frame tl-frame-add';
      addTile.textContent = '+';
      addTile.title = 'Add a frame at the end of this layer';
      addTile.addEventListener('click', () => {
        const last = l.frames[l.frames.length - 1];
        const nf = store.addFrame(area.id, l.id, l.frames.length, last?.duration ?? 1);
        state.activeLayerId = l.id;
        state.activeFrameId = nf.id;
        renderTimeline();
        invalidate();
      });
      strip.appendChild(addTile);

      row.append(head, strip);
      tracksEl.appendChild(row);
    });
    if (tlView === 'frames') {
      // "+ layer" row under the last layer
      const addRow = document.createElement('div');
      addRow.className = 'tl-track tl-track-add';
      const addBtn = document.createElement('button');
      addBtn.className = 'tl-addlayer-row';
      addBtn.innerHTML = `${svg('<path d="M12 5v14M5 12h14"/>')}<span>layer</span>`;
      addBtn.title = 'Add a layer';
      addBtn.addEventListener('click', () => {
        const nl = store.addAnimLayer(area.id);
        if (nl) {
          state.activeLayerId = nl.id;
          state.activeFrameId = frameAtTick(nl.frames, state.editTick ?? 0);
        }
        renderTimeline();
        invalidate();
      });
      addRow.appendChild(addBtn);
      tracksEl.appendChild(addRow);
    }

    // playhead: a line down every track at the position (editing) or the play clock (playback)
    const playheadEl = document.createElement('div');
    playheadEl.className = 'tl-playhead';
    tracksEl.appendChild(playheadEl);
    const playheadX = (tick: number): number | null => {
      if (tlView === 'live') return 158 + tick * liveScale; // the shared live time scale
      const layer = area.layers.find((x) => x.id === lid && x.kind !== 'live') ?? [...area.layers].reverse().find((x) => x.kind !== 'live');
      if (!layer || !layer.frames.length) return null;
      const perTick = 30 * tlZoom;
      const total = layerTotal(layer.frames);
      const fid = frameAtTick(layer.frames, Math.min(tick, total - 1));
      const span = fid ? frameSpan(layer.frames, fid) : null;
      const tile = fid ? tracksEl.querySelector<HTMLElement>(`.tl-frame[data-fid="${fid}"]`) : null;
      if (!span || !tile) return null;
      const strip = tile.parentElement as HTMLElement;
      if (tick >= total) return strip.offsetLeft + tile.offsetLeft + tile.offsetWidth + (tick - total) * perTick; // past the track's end
      const frac = Math.max(0, Math.min(1, (tick - span.start) / (span.end - span.start)));
      return strip.offsetLeft + tile.offsetLeft + frac * tile.offsetWidth;
    };
    tlPlayhead = (tick) => {
      const x = tick === null ? null : playheadX(tick);
      playheadEl.hidden = x === null;
      if (x === null) return;
      playheadEl.style.left = `${x}px`;
      playheadEl.style.height = `${(tracksEl as HTMLElement).scrollHeight}px`;
    };
    tlPlayhead(tlView === 'frames' && !state.playingAreas ? state.editTick : null);

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
      if (!state.playingAreas) state.recording = false;
      state.playEpoch = animClock.now();
      renderTimeline();
      invalidate();
    });
    q('#tl-rec').addEventListener('click', () => {
      // record = play with intent: lines drawn while it runs become live lines on the loop clock
      state.recording = !state.recording;
      state.playingAreas = state.recording;
      if (state.recording) tlView = 'live'; // what you record lands in the live lines
      state.playEpoch = animClock.now();
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
    q('#tl-close').addEventListener('click', closeTimeline);
    const framesOps = !!activeLayer && activeLayer.kind !== 'live';
    on('#tl-add', () => {
      if (!framesOps) return;
      const idx = activeLayer!.frames.findIndex((f) => f.id === fid);
      const cur = activeLayer!.frames[idx];
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
      const f = activeLayer!.frames.find((x) => x.id === fid);
      if (f) store.setFrameDuration(area.id, lid, fid, f.duration + d);
      renderTimeline();
      invalidate();
    };
    on('#tl-shorter', () => dur(-1));
    on('#tl-longer', () => dur(1));
    const tracksDiv = tl.querySelector('.tl-tracks') as HTMLElement;
    tracksDiv.scrollTop = prevScroll;
    tracksDiv.scrollLeft = prevScrollLeft;
    // the strip keeps its place; when the active frame changed, bring it into view
    if (fid && fid !== prevActive) {
      const tile = tracksDiv.querySelector<HTMLElement>(`.tl-frame[data-fid="${fid}"]`);
      if (tile) {
        const tr = tracksDiv.getBoundingClientRect(), fr = tile.getBoundingClientRect();
        const headW = (tracksDiv.querySelector('.tl-track-head') as HTMLElement | null)?.offsetWidth ?? 130;
        if (fr.left < tr.left + headW) tracksDiv.scrollLeft -= tr.left + headW - fr.left + 24;
        else if (fr.right > tr.right) tracksDiv.scrollLeft += fr.right - tr.right + 24;
      }
    }
    // frame navigation: buttons, the jog strip (drag / wheel), arrow keys
    // `light`: while jogging, only the tile highlight and counter update — the panel isn't rebuilt under the finger
    const stepFrame = (d: number, light = false) => {
      if (!activeLayer || activeLayer.kind === 'live' || !activeLayer.frames.length) return;
      // the position walks the whole animation tick by tick (every layer moves underneath);
      // a looping area flips round like a flipbook: past the end comes the start
      const cur = state.editTick ?? frameSpan(activeLayer.frames, fid)?.start ?? 0;
      const t = area.loop ? (((cur + d) % total) + total) % total : Math.max(0, Math.min(total - 1, cur + d));
      if (t === cur) return;
      state.editTick = t;
      state.activeFrameId = frameAtTick(activeLayer.frames, t);
      lastTlFid = state.activeFrameId;
      if (light) {
        tracksDiv.querySelectorAll('.tl-frame.active').forEach((t) => t.classList.remove('active'));
        const tile = tracksDiv.querySelector<HTMLElement>(`.tl-frame[data-fid="${state.activeFrameId}"]`);
        tile?.classList.add('active');
        if (tile) {
          const tr = tracksDiv.getBoundingClientRect(), fr = tile.getBoundingClientRect();
          const headW = (tracksDiv.querySelector('.tl-track-head') as HTMLElement | null)?.offsetWidth ?? 130;
          if (fr.left < tr.left + headW) tracksDiv.scrollLeft -= tr.left + headW - fr.left + 24;
          else if (fr.right > tr.right) tracksDiv.scrollLeft += fr.right - tr.right + 24;
        }
        const pos = tl.querySelector('#tl-pos');
        if (pos) pos.textContent = posLabel();
        tlPlayhead(state.editTick);
        invalidate();
        return;
      }
      renderTimeline();
      invalidate();
    };
    tlStep = stepFrame;
    on('#tl-prev', () => stepFrame(-1));
    on('#tl-next', () => stepFrame(1));
    on('#tl-addnext', () => {
      if (!activeLayer || activeLayer.kind === 'live') return;
      const cur = activeLayer.frames[frameIdx];
      const nf = store.addFrame(area.id, lid, frameIdx + 1, cur?.duration ?? 1);
      state.activeFrameId = nf.id;
      renderTimeline();
      invalidate();
    });
    const jog = tl.querySelector('#tl-jog') as HTMLElement | null;
    if (jog) {
      const STEP_PX = 22;
      jog.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        jog.setPointerCapture(e.pointerId);
        state.onionMuted = true; // flipping reads better without the onion ghosts
        invalidate();
        let lastX = e.clientX;
        let acc = 0;
        let shift = 0;
        const onMove = (ev: PointerEvent) => {
          acc += ev.clientX - lastX;
          shift += ev.clientX - lastX;
          lastX = ev.clientX;
          jog.style.setProperty('--jog', `${shift}px`);
          const steps = Math.trunc(acc / STEP_PX);
          if (steps) {
            acc -= steps * STEP_PX;
            stepFrame(steps, true);
          }
        };
        const onUp = () => {
          jog.removeEventListener('pointermove', onMove);
          jog.removeEventListener('pointerup', onUp);
          jog.removeEventListener('pointercancel', onUp);
          state.onionMuted = false;
          renderTimeline(); // settle: full rebuild with the new active frame
          invalidate();
        };
        jog.addEventListener('pointermove', onMove);
        jog.addEventListener('pointerup', onUp);
        jog.addEventListener('pointercancel', onUp);
      });
      jog.addEventListener('wheel', (e) => {
        e.preventDefault();
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        if (Math.abs(d) >= 4) stepFrame(d > 0 ? 1 : -1);
      }, { passive: false });
    }
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
        state.activeFrameId = frameAtTick(nl.frames, state.editTick ?? 0);
      }
      renderTimeline();
      invalidate();
    });
  }


  return {
    /** re-render after undo/redo or external changes, if the panel is open */
    renderIfOpen: () => { if (tlAreaId && !tl.classList.contains('hidden')) renderTimeline(); },
  };
}
