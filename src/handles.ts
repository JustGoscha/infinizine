// The chrome drawn on the canvas around boxes, areas and pages: grabbers,
// bins, dice, style handles. World-space rects sized in screen pixels (÷ zoom).

import type { TextBox } from './types';

/** Move-handle box at a box's top-left corner (world coords). */
export function moveHandleRect(x: number, y: number, zoom: number) {
  const s = 22 / zoom;
  return { x: x - s - 4 / zoom, y: y - s - 4 / zoom, s };
}

/** Second grabber on anim areas: moves the frame WITH its content. Below the move handle. */
export function moveAllHandleRect(x: number, y: number, zoom: number) {
  const s = 22 / zoom;
  return { x: x - s - 4 / zoom, y: y + 2 / zoom, s };
}

/** Page preview eye: below the two grabbers. */
export function eyeHandleRect(x: number, y: number, zoom: number) {
  const s = 22 / zoom;
  return { x: x - s - 4 / zoom, y: y + s + 8 / zoom, s };
}

/** Delete-handle box at a box's top-right corner, away from the move handle. */
export function deleteHandleRect(x: number, y: number, w: number, zoom: number) {
  const s = 22 / zoom;
  return { x: x + w + 4 / zoom, y: y - s - 4 / zoom, s };
}

/** Copy grabber on text/image boxes: under the move handle. Dragging it drags a duplicate
 * (the touch equivalent of alt-drag). */
export function copyHandleRect(x: number, y: number, zoom: number) {
  return moveAllHandleRect(x, y, zoom);
}

/** Dice (re-roll the typeface) on a textbox: right side, under the bin. */
export function diceHandleRect(x: number, y: number, w: number, zoom: number) {
  const s = 22 / zoom;
  return { x: x + w + 4 / zoom, y: y + 2 / zoom, s };
}
/** Copy-style handle under the dice; paste-style handle under that (shown when a style is copied). */
export function copyStyleHandleRect(x: number, y: number, w: number, zoom: number) {
  const s = 22 / zoom;
  return { x: x + w + 4 / zoom, y: y + 28 / zoom, s };
}
export function pasteStyleHandleRect(x: number, y: number, w: number, zoom: number) {
  const s = 22 / zoom;
  return { x: x + w + 4 / zoom, y: y + 54 / zoom, s };
}

export function inRect(w: { x: number; y: number }, r: { x: number; y: number; s: number }): boolean {
  return w.x >= r.x && w.x <= r.x + r.s && w.y >= r.y && w.y <= r.y + r.s;
}

/** Move-handle box at a textbox's top-left corner (world coords). */
export function textHandleRect(el: TextBox, zoom: number) {
  return moveHandleRect(el.x, el.y, zoom);
}
