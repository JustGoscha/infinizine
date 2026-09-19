// Pressure playground: a modal with its own scratch canvas for tuning the
// brush curves and settings (pressure.ts) with live feedback.

import { Store } from './store';
import { Camera, baseZoom } from './camera';
import { Renderer } from './render';
import { attachInput, setModalOpen } from './input';
import { InputState, type Tool } from './state';
import { svg, ICONS, SIZES, cursorFor } from './icons';
import { toast } from './feedback';
import { pressure, savePressure, resetPressure, loadPressure, exportPressure, importPressure, easeP, curveAt, type Curve, type CurveNode } from './pressure';

export function buildPlayground(root: HTMLElement, state: InputState, store: Store) {
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
  type NumKey = 'smooth' | 'pSmooth' | 'min' | 'max' | 'tilt' | 'nib';
  const SLIDERS: { k: NumKey; label: string; min: number; max: number; step: number; fmt: (v: number) => string; markerToo?: boolean; pencilOnly?: boolean; markerOnly?: boolean }[] = [
    { k: 'smooth', label: 'smoothing', min: 0, max: 6, step: 0.1, fmt: (v) => `${v.toFixed(1)}px`, markerToo: true },
    { k: 'pSmooth', label: 'pressure lp', min: 0.05, max: 1, step: 0.05, fmt: (v) => v.toFixed(2) },
    { k: 'min', label: 'min width', min: 0, max: 1, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%` },
    { k: 'max', label: 'max width', min: 0.5, max: 3, step: 0.05, fmt: (v) => `${v.toFixed(2)}×`, markerToo: true },
    { k: 'tilt', label: 'tilt width', min: 1, max: 40, step: 0.5, fmt: (v) => (v <= 1 ? 'off' : `${v.toFixed(1)}×`), pencilOnly: true },
    { k: 'nib', label: 'nib offset', min: -90, max: 90, step: 1, fmt: (v) => `${Math.round(v)}°`, markerToo: true, markerOnly: true },
  ];
  pg.innerHTML = `
    <button class="pg-close-big" id="pg-close-big" title="Close (Esc)">${svg('<path d="M6 6 L18 18 M18 6 L6 18"/>')}<span>Close</span></button>
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
        <div class="pg-actions" id="pg-nib-row"><button id="pg-nib-mode"></button></div>
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
  rigStore.onChange = (info) => rigRenderer.docChanged(info);
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
        else c.arc(ax, ay, 6, 0, Math.PI * 2);
        c.fill(); c.stroke();
      });
      c.fillStyle = 'rgba(42,36,26,0.7)';
      c.font = '11px Libre Franklin Variable, sans-serif';
      c.fillText(labels.x, bx0, by1 + 14);
      c.save(); c.translate(bx0 - 6, by1); c.rotate(-Math.PI / 2); c.fillText(labels.y, 0, 0); c.restore();
      const ro = labels.readout(fx);
      c.font = '12px Libre Franklin Variable, sans-serif';
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
        const n = curve[k];
        if (k === 0 || k === curve.length - 1) {
          // endpoints stay on their edge (x = 0 / 1) but slide freely in y
          n.y = clamp01(y);
        } else {
          n.x = Math.max(curve[k - 1].x + 0.01, Math.min(curve[k + 1].x - 0.01, x));
          n.y = clamp01(y);
        }
      } else {
        const n = curve[drag.k];
        // handles roam the whole visible domain (the curve may fold back; curveAt copes)
        const hx = Math.max(LO, Math.min(LO + SPAN, x)) - n.x;
        const hy = Math.max(LO, Math.min(LO + SPAN, y)) - n.y;
        n[drag.h] = [hx, hy];
        if (n.s && drag.k > 0 && drag.k < curve.length - 1) {
          // smooth: mirror direction onto the other handle, keep its own length
          const other = drag.h === 'i' ? 'o' : 'i';
          const len = Math.hypot(n[other][0], n[other][1]) || Math.hypot(hx, hy);
          const l = Math.hypot(hx, hy) || 1;
          n[other] = [(-hx / l) * len, (-hy / l) * len];
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
      row.hidden = (pgTool === 'marker' && !sl.markerToo) || (!!sl.pencilOnly && pgTool !== 'pencil') || (!!sl.markerOnly && pgTool !== 'marker');
      (row.querySelector('input') as HTMLInputElement).value = String(k[sl.k]);
      (row.querySelector('b') as HTMLElement).textContent = sl.fmt(k[sl.k]);
    }
    (pg.querySelector('#pg-nib-row') as HTMLElement).hidden = pgTool !== 'marker';
    (pg.querySelector('#pg-nib-mode') as HTMLButtonElement).textContent =
      pressure.marker.nibMode === 'azimuth' ? 'Nib follows pen lean · tap for stroke direction' : 'Nib follows stroke direction · tap for pen lean';
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
  (pg.querySelector('#pg-nib-mode') as HTMLButtonElement).addEventListener('click', () => {
    pressure.marker.nibMode = pressure.marker.nibMode === 'azimuth' ? 'travel' : 'azimuth';
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
      rigCamera.zoom = baseZoom();
      rigCamera.x = 0; rigCamera.y = 0;
      rigState.updateCursor();
      rigRenderer.clearCache();
      requestAnimationFrame(() => rigRenderer.invalidate());
      syncPg();
    }
  };

  return { el: pg, button: pgBtn, toggle: togglePg };
}
