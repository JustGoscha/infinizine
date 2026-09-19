// Mouse hover over the canvas: which box / image / area / page is under the
// pointer (their handles show) and which cursor to use.

import { Store } from './store';
import { hitElement } from './geometry';
import { InputState, frameEditable } from './state';
import { inRect, moveHandleRect, moveAllHandleRect, deleteHandleRect, eyeHandleRect, diceHandleRect, copyHandleRect, copyStyleHandleRect, pasteStyleHandleRect, textHandleRect } from './handles';

export interface Hover { text: string | null; image: string | null; area: string | null; page: string | null; cursor: string }

/** What a mouse at world point `w` (zoom `z`) is over. Text boxes win, then images, areas, pages. */
export function hoverAt(w: { x: number; y: number }, z: number, store: Store, state: InputState): Hover {
  let hover: string | null = null;
  let cursor = '';
  for (const el of [...store.doc.elements].reverse()) {
    if (el.kind !== 'text' || !frameEditable(el, state)) continue;
    const hr = textHandleRect(el, z);
    const inHandle = w.x >= hr.x && w.x <= hr.x + hr.s && w.y >= hr.y && w.y <= hr.y + hr.s;
    const inDel = inRect(w, deleteHandleRect(el.x, el.y, el.w, z));
    const inDice = inRect(w, diceHandleRect(el.x, el.y, el.w, z)) || inRect(w, copyStyleHandleRect(el.x, el.y, el.w, z)) || (state.stylePasteFor(el) && inRect(w, pasteStyleHandleRect(el.x, el.y, el.w, z)));
    const inCopy = inRect(w, copyHandleRect(el.x, el.y, z));
    const inBox = w.x >= el.x && w.x <= el.x + el.w && w.y >= el.y && w.y <= el.y + el.h;
    // resize handles straddle the border: their outer half must keep the box hovered
    const r = 12 / z;
    const nearResize =
      Math.hypot(w.x - (el.x + el.w), w.y - (el.y + el.h)) < r ||
      (Math.abs(w.y - (el.y + el.h)) < r && Math.abs(w.x - (el.x + el.w / 2)) < r) ||
      (Math.abs(w.y - (el.y + el.h / 2)) < r && (Math.abs(w.x - el.x) < r || Math.abs(w.x - (el.x + el.w)) < r));
    if (inHandle || inBox || inDel || inDice || inCopy || nearResize) {
      hover = el.id;
      if (inHandle) cursor = 'grab';
      if (inCopy) cursor = 'copy';
      if (inDel || inDice) cursor = 'pointer';
      if (Math.hypot(w.x - (el.x + el.w), w.y - (el.y + el.h)) < r) cursor = 'nwse-resize';
      else if (Math.abs(w.y - (el.y + el.h)) < r && Math.abs(w.x - (el.x + el.w / 2)) < r) cursor = 'ns-resize';
      else if (Math.abs(w.y - (el.y + el.h / 2)) < r &&
        (Math.abs(w.x - el.x) < r || Math.abs(w.x - (el.x + el.w)) < r)) cursor = 'ew-resize';
      break;
    }
  }
  // image hover + handle cursors
  let hoverImage: string | null = null;
  if (!cursor) {
    for (const el of [...store.doc.elements].reverse()) {
      if (el.kind !== 'image' || !frameEditable(el, state)) continue;
      const r = 12 / z;
      const inBox = w.x >= el.x && w.x <= el.x + el.w && w.y >= el.y && w.y <= el.y + el.h;
      const inMove = inRect(w, moveHandleRect(el.x, el.y, z));
      const inCopy = inRect(w, copyHandleRect(el.x, el.y, z));
      const inDel = inRect(w, deleteHandleRect(el.x, el.y, el.w, z));
      const nearResize =
        Math.hypot(w.x - (el.x + el.w), w.y - (el.y + el.h)) < r ||
        (Math.abs(w.y - (el.y + el.h)) < r && Math.abs(w.x - (el.x + el.w / 2)) < r) ||
        (Math.abs(w.y - (el.y + el.h / 2)) < r && (Math.abs(w.x - el.x) < r || Math.abs(w.x - (el.x + el.w)) < r));
      if (inBox || inMove || inCopy || inDel || nearResize) {
        hoverImage = el.id;
        if (inMove) cursor = 'grab';
        else if (inCopy) cursor = 'copy';
        else if (inDel) cursor = 'pointer';
        else if (Math.hypot(w.x - (el.x + el.w), w.y - (el.y + el.h)) < r) cursor = 'nwse-resize';
        else if (Math.abs(w.y - (el.y + el.h)) < r && Math.abs(w.x - (el.x + el.w / 2)) < r) cursor = 'ns-resize';
        else if (Math.abs(w.y - (el.y + el.h / 2)) < r &&
          (Math.abs(w.x - el.x) < r || Math.abs(w.x - (el.x + el.w)) < r)) cursor = 'ew-resize';
        break;
      }
    }
  }
  // area handles hover
  let hoverArea: string | null = null;
  if (!cursor) {
    for (const a of [...store.doc.areas].reverse()) {
      const r = 12 / z;
      const mh = moveHandleRect(a.x, a.y, z);
      const nearLabel = w.x >= a.x && w.x <= a.x + 160 / z && w.y >= a.y - 26 / z && w.y <= a.y;
      const inMove = w.x >= mh.x && w.x <= mh.x + mh.s && w.y >= mh.y && w.y <= mh.y + mh.s;
      const inMoveAll = inRect(w, moveAllHandleRect(a.x, a.y, z));
      const inDel = inRect(w, deleteHandleRect(a.x, a.y, a.w, z));
      const nearEdge =
        (Math.abs(w.x - a.x) < r || Math.abs(w.x - (a.x + a.w)) < r) &&
          w.y > a.y - r && w.y < a.y + a.h + r ||
        (Math.abs(w.y - a.y) < r || Math.abs(w.y - (a.y + a.h)) < r) &&
          w.x > a.x - r && w.x < a.x + a.w + r;
      if (nearLabel || inMove || inMoveAll || inDel || nearEdge || state.activeAreaId === a.id) {
        if (nearLabel || inMove || inMoveAll || inDel || nearEdge) hoverArea = a.id;
        if (hoverArea || state.activeAreaId === a.id) {
          if (inMove || inMoveAll) cursor = 'grab';
          else if (inDel) cursor = 'pointer';
          else if (Math.hypot(w.x - (a.x + a.w), w.y - (a.y + a.h)) < r) cursor = 'nwse-resize';
          else if (Math.abs(w.y - (a.y + a.h)) < r && Math.abs(w.x - (a.x + a.w / 2)) < r) cursor = 'ns-resize';
          else if (Math.abs(w.y - (a.y + a.h / 2)) < r &&
            (Math.abs(w.x - a.x) < r || Math.abs(w.x - (a.x + a.w)) < r)) cursor = 'ew-resize';
          else if (nearLabel) cursor = 'pointer'; // tap opens the timeline
        }
        if (hoverArea) break;
      }
    }
  }
  // page hover: near the label, the grabbers, or the border
  let hoverPage: string | null = null;
  if (!cursor && !hoverArea) {
    for (const p of [...store.doc.pages].reverse()) {
      const r = 10 / z;
      const mh = moveHandleRect(p.x, p.y, z);
      const mha = moveAllHandleRect(p.x, p.y, z);
      const nearLabel = w.x >= p.x && w.x <= p.x + 140 / z && w.y >= p.y - 26 / z && w.y <= p.y;
      const inGrab = inRect(w, mh) || inRect(w, mha);
      const inEye = inRect(w, eyeHandleRect(p.x, p.y, z));
      const nearEdge =
        ((Math.abs(w.x - p.x) < r || Math.abs(w.x - (p.x + p.w)) < r) &&
          w.y > p.y - r && w.y < p.y + p.h + r) ||
        ((Math.abs(w.y - p.y) < r || Math.abs(w.y - (p.y + p.h)) < r) &&
          w.x > p.x - r && w.x < p.x + p.w + r);
      if (nearLabel || inGrab || inEye || nearEdge) {
        hoverPage = p.id;
        if (inGrab) cursor = 'grab';
        else if (inEye || nearLabel) cursor = 'pointer';
        break;
      }
    }
  }
  // anything selected under the cursor is grabbable
  if (!cursor && state.selection.size && store.doc.elements.some((el) => state.selection.has(el.id) && hitElement(el, w.x, w.y, 10 / z))) cursor = 'grab';
  return { text: hover, image: hoverImage, area: hoverArea, page: hoverPage, cursor };
}
