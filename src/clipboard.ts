// Copy / cut / paste: elements and whole animation areas, across zines via
// localStorage (with an in-memory copy for big selections), plus smart paste
// of images and text from the system clipboard.

import { Camera } from './camera';
import { Store } from './store';
import { AnimArea, Element, ImageBox, uid } from './types';
import { translateElement } from './geometry';
import { fitBox, boxFamily } from './text';
import { clipboardToMarkdown } from './richedit';
import { InputState } from './state';

const CLIP_KEY = 'infinizine-clipboard';
export const CLIP_PENDING_KEY = 'infinizine-clip-pending'; // '1' while the clip hasn't been pasted yet
// Big selections blow the ~5MB localStorage quota; the in-memory clipboard
// always holds the last copy so same-tab (and cross-zine) paste never fails.
let memClip: string | null = null;

function toast(msg: string) {
  window.dispatchEvent(new CustomEvent('izine-toast', { detail: msg }));
}

export function createClipboard(store: Store, state: InputState, camera: Camera, invalidate: () => void) {
  // ---- copy / cut / paste (works across zines via localStorage) ----
  function copySelection(): boolean {
    let payload: unknown = null;
    if (state.selection.size) {
      const els = store.doc.elements.filter((el) => state.selection.has(el.id));
      if (els.length) payload = { app: 'infinizine-clip', kind: 'elements', elements: els };
    } else if (state.activeAreaId) {
      const area = store.doc.areas.find((a) => a.id === state.activeAreaId);
      if (area) {
        const ids = new Set(store.areaContentIds(area.id));
        payload = {
          app: 'infinizine-clip',
          kind: 'area',
          area,
          elements: store.doc.elements.filter((el) => ids.has(el.id)),
        };
      }
    }
    if (!payload) {
      toast('Nothing selected to copy');
      return false;
    }
    const json = JSON.stringify(payload);
    memClip = json;
    try {
      localStorage.setItem(CLIP_KEY, json);
    } catch {
      // too big for localStorage — drop the stale entry so other tabs don't paste old content
      try { localStorage.removeItem(CLIP_KEY); } catch { /* ignore */ }
    }
    try { localStorage.setItem(CLIP_PENDING_KEY, '1'); } catch { /* ignore */ }
    navigator.clipboard?.writeText(json).catch(() => {});
    const p = payload as { kind: string; elements: Element[] };
    toast(p.kind === 'area' ? 'Copied animation area' : `Copied ${p.elements.length} element${p.elements.length === 1 ? '' : 's'}`);
    return true;
  }

  function cutSelection() {
    if (!copySelection()) return;
    const els = store.doc.elements.filter((el) => state.selection.has(el.id));
    if (els.length) {
      state.selection.clear();
      store.deleteElements(els);
      toast(`Cut ${els.length} element${els.length === 1 ? '' : 's'}`);
    } else if (state.activeAreaId) {
      const area = store.doc.areas.find((a) => a.id === state.activeAreaId);
      if (area) {
        store.deleteArea(area);
        state.onAnimClose();
        toast('Cut animation area');
      }
    }
    invalidate();
  }

  function addImageFromDataURL(dataURL: string) {
    const img = new Image();
    img.onload = () => {
      const MAX = 260; // world units
      const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(10, img.naturalWidth * scale);
      const h = Math.max(10, img.naturalHeight * scale);
      const el: ImageBox = {
        id: uid('img'),
        kind: 'image',
        x: camera.x - w / 2,
        y: camera.y - h / 2,
        w,
        h,
        src: dataURL,
        frame: state.activeFrameId ?? undefined,
        alayer: state.activeFrameId ? state.activeLayerId ?? undefined : undefined,
      };
      store.addElement(el);
      state.selection = new Set([el.id]);
      state.tool = 'cursor';
      state.onToolChange();
      toast('Pasted image');
      invalidate();
    };
    img.src = dataURL;
  }

  function addTextFromString(text: string, style?: { font: string; face?: string; fontSize?: number; color?: string }) {
    const wBox = 220;
    const font = style?.font ?? state.font, face = style?.face;
    const fontSize = style?.fontSize ?? state.textSize;
    const { w, h } = fitBox(text, boxFamily({ font, face }), fontSize, { auto: true, wrapW: wBox, w: wBox, h: 0 });
    const el: Element = {
      id: uid('tx'),
      kind: 'text',
      x: camera.x - w / 2,
      y: camera.y - h / 2,
      w,
      h,
      auto: true,
      wrapW: wBox,
      color: style?.color ?? state.color,
      fontSize,
      font,
      face,
      text,
      frame: state.activeFrameId ?? undefined,
      alayer: state.activeFrameId ? state.activeLayerId ?? undefined : undefined,
    };
    store.addElement(el);
    state.selection = new Set([el.id]);
    state.tool = 'cursor';
    state.onToolChange();
    toast('Pasted text');
    invalidate();
  }

  /** Smart paste: image from system clipboard → image element; plain text →
   * textbox; zine content (ours) → elements/area. Falls back to the internal
   * clipboard when the system one is unreadable. */
  async function pasteSmart() {
    try {
      if (navigator.clipboard?.read) {
        const items = await navigator.clipboard.read();
        for (const it of items) {
          const imgType = it.types.find((t) => t.startsWith('image/'));
          if (imgType) {
            const blob = await it.getType(imgType);
            const fr = new FileReader();
            fr.onload = () => addImageFromDataURL(fr.result as string);
            fr.readAsDataURL(blob);
            return;
          }
          if (it.types.includes('text/html')) {
            // text copied out of a text editor: a new box in the source's style
            const got = clipboardToMarkdown(await (await it.getType('text/html')).text());
            if (got && got.md.trim()) { addTextFromString(got.md, got.style); return; }
          }
        }
      }
      const txt = await navigator.clipboard?.readText?.();
      if (txt && txt.trim()) {
        try {
          const p = JSON.parse(txt);
          if (p && p.app === 'infinizine-clip') {
            memClip = txt;
            try { localStorage.setItem(CLIP_KEY, txt); } catch { /* ignore */ }
            pasteClipboard();
            toast('Pasted');
            return;
          }
        } catch { /* not ours — plain text */ }
        addTextFromString(txt);
        return;
      }
    } catch { /* clipboard unreadable (permissions) — fall back */ }
    const had = memClip !== null ||
      (() => { try { return !!localStorage.getItem(CLIP_KEY); } catch { return false; } })();
    if (had) {
      pasteClipboard();
      toast('Pasted');
    } else {
      toast('Clipboard is empty');
    }
  }

  function pasteClipboard() {
    let raw: string | null = memClip;
    if (!raw) {
      try {
        raw = localStorage.getItem(CLIP_KEY);
      } catch { /* ignore */ }
    }
    if (!raw) return;
    let payload: {
      app?: string;
      kind?: string;
      elements?: Element[];
      area?: AnimArea;
    };
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    if (payload.app !== 'infinizine-clip' || !payload.elements) return;

    // paste centered on the current view, slightly offset
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const grow = (x: number, y: number) => {
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    };
    for (const el of payload.elements) {
      if (el.kind === 'text' || el.kind === 'image') {
        grow(el.x, el.y);
        grow(el.x + el.w, el.y + el.h);
      } else {
        for (const pt of el.points) grow(pt.x, pt.y);
      }
    }
    if (payload.kind === 'area' && payload.area) {
      grow(payload.area.x, payload.area.y);
      grow(payload.area.x + payload.area.w, payload.area.y + payload.area.h);
    }
    if (minX === Infinity) { minX = 0; minY = 0; maxX = 0; maxY = 0; }
    const dx = camera.x - (minX + maxX) / 2 + 20;
    const dy = camera.y - (minY + maxY) / 2 + 20;

    if (payload.kind === 'area' && payload.area) {
      // remap every id so the pasted area is fully independent
      const area = structuredClone(payload.area) as AnimArea;
      const idMap = new Map<string, string>();
      const remap = (old: string) => {
        let n = idMap.get(old);
        if (!n) { n = uid('cp'); idMap.set(old, n); }
        return n;
      };
      area.id = remap(area.id);
      area.x += dx; area.y += dy;
      for (const l of area.layers) {
        l.id = remap(l.id);
        l.frames = l.frames.map((f) => ({ ...f, id: remap(f.id) }));
      }
      const els = payload.elements.map((el) => {
        const c = structuredClone(el) as Element;
        c.id = uid('cp');
        translateElement(c, dx, dy);
        if (c.frame) c.frame = remap(c.frame);
        if (c.alayer) c.alayer = remap(c.alayer);
        if (c.kind === 'stroke' && c.area) c.area = remap(c.area);
        return c;
      });
      store.addAreaWithContent(area, els);
      state.selection.clear();
      state.onAnimOpen(area); // activate the pasted area so it can be moved right away
    } else {
      const els = payload.elements.map((el) => {
        const c = structuredClone(el) as Element;
        c.id = uid('cp');
        translateElement(c, dx, dy);
        // plain-element pastes drop animation ties; retag to the open frame if any
        c.frame = state.activeFrameId ?? undefined;
        c.alayer = state.activeFrameId ? state.activeLayerId ?? undefined : undefined;
        if (c.kind === 'stroke') {
          c.area = undefined;
          c.animStart = undefined;
          c.animLife = undefined;
          c.animTaper = undefined;
        }
        return c;
      });
      store.addElements(els);
      state.selection = new Set(els.map((el) => el.id));
      // land in the cursor tool so the pasted elements can be moved immediately
      state.tool = 'cursor';
      state.onToolChange();
    }
    try { localStorage.setItem(CLIP_PENDING_KEY, '0'); } catch { /* ignore */ }
    invalidate();
  }

  return { copySelection, cutSelection, pasteSmart, pasteClipboard };
}
