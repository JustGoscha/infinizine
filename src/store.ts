// Document store: state, undo/redo, localStorage persistence, page placement.

import { AnimArea, AnimFrame, AnimLayer, Doc, Element, Page, emptyDoc, uid } from './types';

type TextContent = { text: string; w: number; h: number; font?: string; fontSize?: number };
type TextMetrics = { x: number; w: number; h: number; fontSize: number };

type Op =
  | { type: 'add-elements'; elements: Element[] }
  | { type: 'delete-elements'; elements: Element[] }
  | { type: 'move-elements'; ids: string[]; dx: number; dy: number }
  | { type: 'update-text'; id: string; before: TextContent; after: TextContent }
  | { type: 'resize-text'; id: string; before: TextMetrics; after: TextMetrics }
  | { type: 'add-page'; page: Page }
  | { type: 'delete-page'; page: Page }
  | { type: 'move-page'; id: string; dx: number; dy: number }
  | { type: 'pages-format'; before: { id: string; w: number; h: number }[]; after: { id: string; w: number; h: number }[] }
  | { type: 'add-area'; area: AnimArea; elements: Element[] }
  | { type: 'delete-area'; area: AnimArea; elements: Element[] }
  | { type: 'add-frame'; areaId: string; layerId: string; frame: AnimFrame; index: number; elements: Element[] }
  | { type: 'delete-frame'; areaId: string; layerId: string; frame: AnimFrame; index: number; elements: Element[] }
  | { type: 'add-anim-layer'; areaId: string; alayer: AnimLayer; index: number; elements: Element[] }
  | { type: 'delete-anim-layer'; areaId: string; alayer: AnimLayer; index: number; elements: Element[] }
  | { type: 'move-anim-layer'; areaId: string; from: number; to: number }
  | { type: 'move-area'; id: string; dx: number; dy: number }
  | { type: 'resize-area'; id: string; before: { x: number; y: number; w: number; h: number }; after: { x: number; y: number; w: number; h: number } }
  | { type: 'move-frame'; areaId: string; layerId: string; from: number; to: number }
  | { type: 'recolor-elements'; items: { id: string; before: string; after: string }[] }
  | { type: 'retime-strokes'; items: { id: string; before: number; after: number }[] }
  | { type: 'frame-duration'; areaId: string; layerId: string; frameId: string; before: number; after: number }
  | { type: 'area-settings'; areaId: string; before: { fps: number; loop: boolean; clip: boolean }; after: { fps: number; loop: boolean; clip: boolean } }
  | { type: 'rename-area'; areaId: string; before: string; after: string }
  | { type: 'rename-anim-layer'; areaId: string; layerId: string; before: string; after: string };

// Zine library: an index of saved documents + one localStorage entry per doc.
const LEGACY_KEY = 'infinicanvas-doc-v1';
const INDEX_KEY = 'infinizine-docs';
const DOC_PREFIX = 'infinizine-doc-';
const CURRENT_KEY = 'infinizine-current';

export interface DocMeta { id: string; name: string; updated: number }

function normalizeDoc(doc: Doc): Doc {
  doc.areas ??= []; // older saves predate animation areas
  for (const a of doc.areas) {
    // migrate area-level frames (older builds) into layer 0's own track
    const legacy = (a as unknown as { frames?: AnimFrame[] }).frames;
    for (const l of a.layers ?? []) l.frames ??= legacy ?? [{ id: uid('fr'), duration: 1 }];
    if (a.layers?.length) {
      for (let i = 1; i < a.layers.length; i++) {
        if (a.layers[i].frames === legacy) a.layers[i].frames = [{ id: uid('fr'), duration: 1 }];
      }
    }
    delete (a as unknown as { frames?: AnimFrame[] }).frames;
  }
  return doc;
}

export class Store {
  doc: Doc;
  docId: string;
  private undoStack: Op[] = [];
  private redoStack: Op[] = [];
  private saveTimer: number | undefined;
  onChange: () => void = () => {};

  constructor() {
    this.migrateLegacy();
    const current = localStorage.getItem(CURRENT_KEY) ?? this.listDocs()[0]?.id;
    const loaded = current ? this.loadDoc(current) : null;
    this.docId = loaded && current ? current : uid('doc');
    this.doc = loaded ?? emptyDoc();
    if (!loaded) this.saveNow();
  }

  private migrateLegacy() {
    try {
      const raw = localStorage.getItem(LEGACY_KEY);
      if (!raw || localStorage.getItem(INDEX_KEY)) return;
      const id = uid('doc');
      localStorage.setItem(DOC_PREFIX + id, raw);
      localStorage.setItem(INDEX_KEY, JSON.stringify([{ id, name: 'Untitled', updated: Date.now() }]));
      localStorage.setItem(CURRENT_KEY, id);
      localStorage.removeItem(LEGACY_KEY);
    } catch { /* ignore */ }
  }

  private loadDoc(id: string): Doc | null {
    try {
      const raw = localStorage.getItem(DOC_PREFIX + id);
      if (!raw) return null;
      const doc = JSON.parse(raw) as Doc;
      if (doc.version !== 1) return null;
      return normalizeDoc(doc);
    } catch {
      return null;
    }
  }

  listDocs(): DocMeta[] {
    try {
      const list = JSON.parse(localStorage.getItem(INDEX_KEY) ?? '[]') as DocMeta[];
      return list.sort((a, b) => b.updated - a.updated);
    } catch {
      return [];
    }
  }

  private saveNow() {
    try {
      localStorage.setItem(DOC_PREFIX + this.docId, JSON.stringify(this.doc));
      const rest = this.listDocs().filter((m) => m.id !== this.docId);
      rest.unshift({ id: this.docId, name: this.doc.name, updated: Date.now() });
      localStorage.setItem(INDEX_KEY, JSON.stringify(rest));
      localStorage.setItem(CURRENT_KEY, this.docId);
    } catch { /* storage may be unavailable; drawing still works */ }
  }

  private scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.saveNow(), 400);
  }

  private switchTo(id: string, doc: Doc) {
    this.saveNow(); // flush the outgoing doc
    this.docId = id;
    this.doc = doc;
    this.undoStack = [];
    this.redoStack = [];
    this.saveNow();
    this.onChange();
  }

  openDoc(id: string) {
    if (id === this.docId) return;
    const doc = this.loadDoc(id);
    if (doc) this.switchTo(id, doc);
  }

  newDoc() {
    const doc = emptyDoc();
    doc.name = `Zine ${this.listDocs().length + 1}`;
    this.switchTo(uid('doc'), doc);
  }

  deleteDoc(id: string) {
    try {
      localStorage.removeItem(DOC_PREFIX + id);
      localStorage.setItem(INDEX_KEY, JSON.stringify(this.listDocs().filter((m) => m.id !== id)));
    } catch { /* ignore */ }
    if (id === this.docId) {
      const next = this.listDocs()[0];
      if (next) this.openDoc(next.id);
      else this.newDoc();
    } else {
      this.onChange();
    }
  }

  renameDoc(name: string) {
    const n = name.trim();
    if (!n || n === this.doc.name) return;
    this.doc.name = n;
    this.saveNow();
    this.onChange();
  }

  /** Self-contained export: plain JSON, the whole document. */
  exportJSON(): string {
    return JSON.stringify({ ...this.doc, app: 'infinizine' }, null, 2);
  }

  importJSON(text: string): boolean {
    try {
      const doc = JSON.parse(text) as Doc;
      if (doc.version !== 1 || !Array.isArray(doc.elements)) return false;
      normalizeDoc(doc);
      doc.pages ??= [];
      doc.name ||= 'Imported zine';
      this.switchTo(uid('doc'), doc);
      return true;
    } catch {
      return false;
    }
  }

  private commit(op: Op) {
    this.apply(op);
    this.undoStack.push(op);
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.redoStack = [];
    this.scheduleSave();
    this.onChange();
  }

  private apply(op: Op) {
    const d = this.doc;
    switch (op.type) {
      case 'add-elements':
        // 'back' ink goes behind everything, including earlier back-layer ink
        for (const el of op.elements) {
          if (el.layer === 'back') d.elements.unshift(el);
          else d.elements.push(el);
        }
        break;
      case 'delete-elements': {
        const ids = new Set(op.elements.map((e) => e.id));
        d.elements = d.elements.filter((e) => !ids.has(e.id));
        break;
      }
      case 'move-elements': this.translate(op.ids, op.dx, op.dy); break;
      case 'update-text': {
        const el = d.elements.find((e) => e.id === op.id);
        if (el && el.kind === 'text') {
          el.text = op.after.text;
          el.w = op.after.w;
          el.h = op.after.h;
          if (op.after.font) el.font = op.after.font;
          if (op.after.fontSize) el.fontSize = op.after.fontSize;
        }
        break;
      }
      case 'resize-text': {
        const el = d.elements.find((e) => e.id === op.id);
        if (el && el.kind === 'text') {
          el.x = op.after.x;
          el.w = op.after.w;
          el.h = op.after.h;
          el.fontSize = op.after.fontSize;
        }
        break;
      }
      case 'add-page': d.pages.push(op.page); break;
      case 'delete-page': d.pages = d.pages.filter((p) => p.id !== op.page.id); break;
      case 'move-page': {
        const pg = d.pages.find((p) => p.id === op.id);
        if (pg) { pg.x += op.dx; pg.y += op.dy; }
        break;
      }
      case 'pages-format': {
        for (const size of op.after) {
          const pg = d.pages.find((p) => p.id === size.id);
          if (pg) { pg.w = size.w; pg.h = size.h; }
        }
        break;
      }
      case 'add-area':
        d.areas.push(op.area);
        d.elements.push(...op.elements);
        break;
      case 'delete-area': {
        d.areas = d.areas.filter((a) => a.id !== op.area.id);
        const ids = new Set(op.elements.map((e) => e.id));
        d.elements = d.elements.filter((e) => !ids.has(e.id));
        break;
      }
      case 'add-frame': {
        this.animLayer(op.areaId, op.layerId)?.frames.splice(op.index, 0, op.frame);
        d.elements.push(...op.elements);
        break;
      }
      case 'delete-frame': {
        const l = this.animLayer(op.areaId, op.layerId);
        if (l) l.frames = l.frames.filter((f) => f.id !== op.frame.id);
        const ids = new Set(op.elements.map((e) => e.id));
        d.elements = d.elements.filter((e) => !ids.has(e.id));
        break;
      }
      case 'add-anim-layer': {
        this.area(op.areaId)?.layers.splice(op.index, 0, op.alayer);
        d.elements.push(...op.elements);
        break;
      }
      case 'delete-anim-layer': {
        const a = this.area(op.areaId);
        if (a) a.layers = a.layers.filter((l) => l.id !== op.alayer.id);
        const ids = new Set(op.elements.map((e) => e.id));
        d.elements = d.elements.filter((e) => !ids.has(e.id));
        break;
      }
      case 'move-anim-layer': {
        const a = this.area(op.areaId);
        if (a && op.to >= 0 && op.to < a.layers.length) {
          const [l] = a.layers.splice(op.from, 1);
          a.layers.splice(op.to, 0, l);
        }
        break;
      }
      case 'move-area': {
        const a = this.area(op.id);
        if (a) { a.x += op.dx; a.y += op.dy; }
        break;
      }
      case 'resize-area': {
        const a = this.area(op.id);
        if (a) { a.x = op.after.x; a.y = op.after.y; a.w = op.after.w; a.h = op.after.h; }
        break;
      }
      case 'move-frame': {
        const l = this.animLayer(op.areaId, op.layerId);
        if (l && op.to >= 0 && op.to < l.frames.length) {
          const [f] = l.frames.splice(op.from, 1);
          l.frames.splice(op.to, 0, f);
        }
        break;
      }
      case 'recolor-elements': {
        for (const it of op.items) {
          const el = d.elements.find((e) => e.id === it.id);
          if (el) el.color = it.after;
        }
        break;
      }
      case 'retime-strokes': {
        for (const it of op.items) {
          const el = d.elements.find((e) => e.id === it.id);
          if (el && el.kind === 'stroke') el.animStart = it.after;
        }
        break;
      }
      case 'frame-duration': {
        const f = this.animLayer(op.areaId, op.layerId)?.frames.find((x) => x.id === op.frameId);
        if (f) f.duration = op.after;
        break;
      }
      case 'area-settings': {
        const a = this.area(op.areaId);
        if (a) { a.fps = op.after.fps; a.loop = op.after.loop; a.clip = op.after.clip; }
        break;
      }
      case 'rename-area': {
        const a = this.area(op.areaId);
        if (a) a.name = op.after;
        break;
      }
      case 'rename-anim-layer': {
        const l = this.animLayer(op.areaId, op.layerId);
        if (l) l.name = op.after;
        break;
      }
    }
  }

  area(id: string): AnimArea | undefined {
    return this.doc.areas.find((a) => a.id === id);
  }

  animLayer(areaId: string, layerId: string): AnimLayer | undefined {
    return this.area(areaId)?.layers.find((l) => l.id === layerId);
  }

  private invert(op: Op): Op {
    switch (op.type) {
      case 'add-elements': return { type: 'delete-elements', elements: op.elements };
      case 'delete-elements': return { type: 'add-elements', elements: op.elements };
      case 'move-elements': return { ...op, dx: -op.dx, dy: -op.dy };
      case 'update-text': return { ...op, before: op.after, after: op.before };
      case 'resize-text': return { ...op, before: op.after, after: op.before };
      case 'add-page': return { type: 'delete-page', page: op.page };
      case 'delete-page': return { type: 'add-page', page: op.page };
      case 'move-page': return { ...op, dx: -op.dx, dy: -op.dy };
      case 'pages-format': return { ...op, before: op.after, after: op.before };
      case 'add-area': return { ...op, type: 'delete-area' };
      case 'delete-area': return { ...op, type: 'add-area' };
      case 'add-frame': return { ...op, type: 'delete-frame' };
      case 'delete-frame': return { ...op, type: 'add-frame' };
      case 'add-anim-layer': return { ...op, type: 'delete-anim-layer' };
      case 'delete-anim-layer': return { ...op, type: 'add-anim-layer' };
      case 'move-anim-layer': return { ...op, from: op.to, to: op.from };
      case 'move-area': return { ...op, dx: -op.dx, dy: -op.dy };
      case 'resize-area': return { ...op, before: op.after, after: op.before };
      case 'move-frame': return { ...op, from: op.to, to: op.from };
      case 'recolor-elements':
        return { ...op, items: op.items.map((it) => ({ ...it, before: it.after, after: it.before })) };
      case 'retime-strokes':
        return { ...op, items: op.items.map((it) => ({ ...it, before: it.after, after: it.before })) };
      case 'frame-duration': return { ...op, before: op.after, after: op.before };
      case 'area-settings': return { ...op, before: op.after, after: op.before };
      case 'rename-area': return { ...op, before: op.after, after: op.before };
      case 'rename-anim-layer': return { ...op, before: op.after, after: op.before };
    }
  }

  private translate(ids: string[], dx: number, dy: number) {
    const set = new Set(ids);
    for (const el of this.doc.elements) {
      if (!set.has(el.id)) continue;
      if (el.kind === 'text') {
        el.x += dx;
        el.y += dy;
      } else {
        for (const p of el.points) { p.x += dx; p.y += dy; }
      }
    }
  }

  undo() {
    const op = this.undoStack.pop();
    if (!op) return;
    this.apply(this.invert(op));
    this.redoStack.push(op);
    this.scheduleSave();
    this.onChange();
  }

  redo() {
    const op = this.redoStack.pop();
    if (!op) return;
    this.apply(op);
    this.undoStack.push(op);
    this.scheduleSave();
    this.onChange();
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  addElement(el: Element) { this.commit({ type: 'add-elements', elements: [el] }); }
  deleteElements(els: Element[]) { if (els.length) this.commit({ type: 'delete-elements', elements: els }); }
  updateText(id: string, before: TextContent, after: TextContent) {
    this.commit({ type: 'update-text', id, before, after });
  }
  resizeText(id: string, before: TextMetrics, after: TextMetrics) {
    this.commit({ type: 'resize-text', id, before, after });
  }
  moveElements(ids: string[], dx: number, dy: number) {
    if (ids.length && (dx || dy)) this.commit({ type: 'move-elements', ids, dx, dy });
  }
  movePage(id: string, dx: number, dy: number) {
    if (dx || dy) this.commit({ type: 'move-page', id, dx, dy });
  }
  deletePage(page: Page) { this.commit({ type: 'delete-page', page }); }

  /** All pages share one size: switch every page to the given format. */
  setPagesFormat({ w, h }: { w: number; h: number }) {
    const pages = this.doc.pages;
    if (!pages.length || pages.every((p) => p.w === w && p.h === h)) return;
    this.commit({
      type: 'pages-format',
      before: pages.map((p) => ({ id: p.id, w: p.w, h: p.h })),
      after: pages.map((p) => ({ id: p.id, w, h })),
    });
  }

  /** New page with the same size, placed right of the source with the standard gap. */
  addPageAfter(src: Page): Page {
    const page: Page = {
      id: uid('page'),
      x: src.x + src.w + 60,
      y: src.y,
      w: src.w,
      h: src.h,
      name: `Page ${this.doc.pages.length + 1}`,
      order: src.order + 1,
    };
    this.commit({ type: 'add-page', page });
    return page;
  }

  /** New page placed right of the last page (with padding), or at the given center. */
  addPage(size: { w: number; h: number }, center?: { x: number; y: number }): Page {
    const { w, h } = size;
    const pages = this.doc.pages;
    let x: number, y: number;
    if (pages.length) {
      const last = pages.reduce((a, b) => (b.order > a.order ? b : a));
      x = last.x + last.w + 60; // padding to the next page (SPEC)
      y = last.y;
    } else if (center) {
      x = center.x - w / 2;
      y = center.y - h / 2;
    } else {
      x = -w / 2; y = -h / 2;
    }
    const page: Page = {
      id: uid('page'), x, y, w, h,
      name: `Page ${pages.length + 1}`,
      order: pages.length,
    };
    this.commit({ type: 'add-page', page });
    return page;
  }

  // ---------- animation areas ----------
  addArea(rect: { x: number; y: number; w: number; h: number }): AnimArea {
    const area: AnimArea = {
      id: uid('ar'), ...rect,
      name: `Area ${this.doc.areas.length + 1}`,
      fps: 12, loop: true,
      layers: [{ id: uid('ly'), name: 'Layer 1', frames: [{ id: uid('fr'), duration: 1 }] }],
    };
    this.commit({ type: 'add-area', area, elements: [] });
    return area;
  }

  private areaElements(area: AnimArea): Element[] {
    const fids = new Set(area.layers.flatMap((l) => l.frames.map((f) => f.id)));
    return this.doc.elements.filter((e) => e.frame && fids.has(e.frame));
  }

  deleteArea(area: AnimArea) {
    this.commit({ type: 'delete-area', area, elements: this.areaElements(area) });
  }

  addFrame(areaId: string, layerId: string, index: number, duration = 1): AnimFrame {
    const frame: AnimFrame = { id: uid('fr'), duration };
    this.commit({ type: 'add-frame', areaId, layerId, frame, index, elements: [] });
    return frame;
  }

  /** Duplicate a frame in its layer, cloning the frame's elements. */
  duplicateFrame(areaId: string, layerId: string, frameId: string): AnimFrame | null {
    const l = this.animLayer(areaId, layerId);
    if (!l) return null;
    const idx = l.frames.findIndex((f) => f.id === frameId);
    if (idx < 0) return null;
    const frame: AnimFrame = { id: uid('fr'), duration: l.frames[idx].duration };
    const clones = this.doc.elements
      .filter((e) => e.frame === frameId)
      .map((e) => ({ ...structuredClone(e), id: uid('el'), frame: frame.id }));
    this.commit({ type: 'add-frame', areaId, layerId, frame, index: idx + 1, elements: clones });
    return frame;
  }

  deleteFrame(areaId: string, layerId: string, frameId: string) {
    const l = this.animLayer(areaId, layerId);
    if (!l || l.frames.length <= 1) return;
    const index = l.frames.findIndex((f) => f.id === frameId);
    if (index < 0) return;
    const elements = this.doc.elements.filter((e) => e.frame === frameId);
    this.commit({ type: 'delete-frame', areaId, layerId, frame: l.frames[index], index, elements });
  }

  addAnimLayer(areaId: string): AnimLayer | null {
    const a = this.area(areaId);
    if (!a) return null;
    const alayer: AnimLayer = {
      id: uid('ly'),
      name: `Layer ${a.layers.length + 1}`,
      frames: [{ id: uid('fr'), duration: 1 }],
    };
    this.commit({ type: 'add-anim-layer', areaId, alayer, index: a.layers.length, elements: [] });
    return alayer;
  }

  deleteAnimLayer(areaId: string, layerId: string) {
    const a = this.area(areaId);
    if (!a || a.layers.length <= 1) return;
    const index = a.layers.findIndex((l) => l.id === layerId);
    if (index < 0) return;
    const layer = a.layers[index];
    const fids = new Set(layer.frames.map((f) => f.id));
    const elements = this.doc.elements.filter(
      (e) => (e.frame && fids.has(e.frame)) || e.alayer === layer.id,
    );
    this.commit({ type: 'delete-anim-layer', areaId, alayer: layer, index, elements });
  }

  resizeArea(id: string, before: { x: number; y: number; w: number; h: number }, after: { x: number; y: number; w: number; h: number }) {
    this.commit({ type: 'resize-area', id, before, after });
  }

  moveArea(id: string, dx: number, dy: number) {
    if (dx || dy) this.commit({ type: 'move-area', id, dx, dy });
  }

  /** New live-ink layer holding the given stroke (one undoable op). */
  addLiveLayer(areaId: string, stroke: Element, mode: 'additive' | 'continuous'): AnimLayer | null {
    const a = this.area(areaId);
    if (!a) return null;
    const n = a.layers.filter((l) => l.kind === 'live').length + 1;
    const alayer: AnimLayer = {
      id: uid('ly'),
      name: `Live ${n}`,
      kind: 'live',
      liveMode: mode,
      frames: [],
    };
    stroke.alayer = alayer.id;
    this.commit({ type: 'add-anim-layer', areaId, alayer, index: a.layers.length, elements: [stroke] });
    return alayer;
  }

  /** Bake a live-ink layer into a keyframe layer: one frame per tick of its
   * cycle, each holding the stroke geometry visible at that tick. */
  convertLiveLayer(areaId: string, layerId: string) {
    const a = this.area(areaId);
    if (!a) return;
    const index = a.layers.findIndex((l) => l.id === layerId);
    const l = a.layers[index];
    if (!l || l.kind !== 'live') return;
    const strokes = this.doc.elements.filter(
      (e): e is Extract<Element, { kind: 'stroke' }> => e.kind === 'stroke' && e.alayer === layerId,
    );
    if (!strokes.length) return;
    const areaTotal = Math.max(
      1,
      ...a.layers.filter((x) => x.kind !== 'live').map((x) => x.frames.reduce((acc, f) => acc + f.duration, 0)),
    );
    const additive = l.liveMode === 'additive';
    let cycle = areaTotal;
    if (!additive) {
      cycle = 1;
      for (const st of strokes) {
        const drawn = (st.points[st.points.length - 1]?.t ?? 0) * a.fps;
        cycle = Math.max(cycle, Math.ceil(drawn + (st.animLife ?? 6)));
      }
    }
    cycle = Math.min(cycle, 600); // safety cap
    const frames: AnimFrame[] = Array.from({ length: cycle }, () => ({ id: uid('fr'), duration: 1 }));
    const baked: Element[] = [];
    for (let T = 0; T < cycle; T++) {
      for (const st of strokes) {
        const start = st.animStart ?? 0;
        const life = Math.max(1, st.animLife ?? 6);
        const ageOf = (t: number) =>
          additive
            ? ((((T - start - t * a.fps) % areaTotal) + areaTotal) % areaTotal)
            : T - t * a.fps;
        let pts;
        if (st.animTaper) {
          pts = [];
          for (const pt of st.points) {
            const age = ageOf(pt.t);
            if (age >= 0 && age < life) {
              const k = 1 - age / life;
              pts.push({ ...pt, p: pt.p * (0.08 + 0.92 * k) });
            }
          }
        } else {
          const anyAlive = st.points.some((pt) => {
            const age = ageOf(pt.t);
            return age >= 0 && age < life;
          });
          pts = anyAlive ? st.points.map((pt) => ({ ...pt })) : [];
        }
        if (pts.length < 3) continue;
        baked.push({
          ...st,
          id: uid('el'),
          points: pts,
          frame: frames[T].id,
          area: undefined,
          alayer: undefined,
          animStart: undefined,
          animLife: undefined,
          animTaper: undefined,
        });
      }
    }
    const bakedLayer: AnimLayer = {
      id: uid('ly'),
      name: `Baked ${a.layers.filter((x) => x.kind !== 'live').length + 1}`,
      frames,
    };
    // two undoable steps: remove the live layer, add the baked keyframe layer
    this.commit({ type: 'delete-anim-layer', areaId, alayer: l, index, elements: strokes });
    this.commit({ type: 'add-anim-layer', areaId, alayer: bakedLayer, index, elements: baked });
  }

  /** Shift a live layer's strokes on the loop clock by whole ticks. */
  shiftLiveLayer(layerId: string, deltaTicks: number) {
    if (!deltaTicks) return;
    const items = this.doc.elements
      .filter((e) => e.kind === 'stroke' && e.alayer === layerId)
      .map((e) => {
        const before = (e.kind === 'stroke' ? e.animStart : 0) ?? 0;
        return { id: e.id, before, after: before + deltaTicks };
      });
    if (items.length) this.commit({ type: 'retime-strokes', items });
  }

  /** View/behavior toggle on a live layer, not undoable. */
  setLiveMode(areaId: string, layerId: string, mode: 'additive' | 'continuous') {
    const l = this.animLayer(areaId, layerId);
    if (!l) return;
    l.liveMode = mode;
    this.scheduleSave();
    this.onChange();
  }

  moveFrame(areaId: string, layerId: string, from: number, to: number) {
    const l = this.animLayer(areaId, layerId);
    if (!l || from === to || to < 0 || to >= l.frames.length) return;
    this.commit({ type: 'move-frame', areaId, layerId, from, to });
  }

  /** View-state toggle, not undoable. */
  setLayerHidden(areaId: string, layerId: string, hidden: boolean) {
    const l = this.animLayer(areaId, layerId);
    if (!l) return;
    l.hidden = hidden;
    this.scheduleSave();
    this.onChange();
  }

  recolorElements(ids: string[], after: string) {
    const items = ids
      .map((id) => this.doc.elements.find((e) => e.id === id))
      .filter((e): e is Element => !!e && e.color !== after)
      .map((e) => ({ id: e.id, before: e.color, after }));
    if (items.length) this.commit({ type: 'recolor-elements', items });
  }

  moveAnimLayer(areaId: string, from: number, to: number) {
    const a = this.area(areaId);
    if (!a || to < 0 || to >= a.layers.length || from === to) return;
    this.commit({ type: 'move-anim-layer', areaId, from, to });
  }

  setFrameDuration(areaId: string, layerId: string, frameId: string, after: number) {
    const f = this.animLayer(areaId, layerId)?.frames.find((x) => x.id === frameId);
    if (!f || after < 1 || after === f.duration) return;
    this.commit({ type: 'frame-duration', areaId, layerId, frameId, before: f.duration, after });
  }

  renameArea(areaId: string, after: string) {
    const a = this.area(areaId);
    if (!a || !after.trim() || after === a.name) return;
    this.commit({ type: 'rename-area', areaId, before: a.name, after: after.trim() });
  }

  renameAnimLayer(areaId: string, layerId: string, after: string) {
    const l = this.animLayer(areaId, layerId);
    if (!l || !after.trim() || after === l.name) return;
    this.commit({ type: 'rename-anim-layer', areaId, layerId, before: l.name, after: after.trim() });
  }

  setAreaSettings(areaId: string, after: { fps: number; loop: boolean; clip: boolean }) {
    const a = this.area(areaId);
    if (!a) return;
    this.commit({
      type: 'area-settings', areaId,
      before: { fps: a.fps, loop: a.loop, clip: a.clip ?? false },
      after,
    });
  }

  setPalette(id: string) {
    this.doc.palette = id;
    this.scheduleSave();
    this.onChange();
  }

  setPaper(color: string) {
    this.doc.paper = color;
    this.scheduleSave();
    this.onChange();
  }

  setPattern(pattern: 'blank' | 'dots' | 'grid' | 'lines') {
    this.doc.pattern = pattern;
    this.scheduleSave();
    this.onChange();
  }
}
