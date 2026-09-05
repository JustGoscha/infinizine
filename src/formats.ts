// Page formats: presets (screen & social, paper, print & zine), custom ones,
// viewport fitting for screen formats, and the label a page carries.
import type { Camera } from './camera';
import { UNITS_PER_MM } from './types';

export interface Fmt { label: string; w: number; h: number; screen?: boolean } // w/h in world units (2/mm); screen = fit to viewport on pick
export const mm = (w: number, h: number) => ({ w: w * UNITS_PER_MM, h: h * UNITS_PER_MM });

// Quick picks in the page menu
export const PRIMARY_FORMATS: Fmt[] = [
  { label: '16:9', ...mm(240, 135), screen: true },
  { label: 'Story 9:16', ...mm(135, 240), screen: true },
  { label: 'A4', ...mm(210, 297) },
  { label: 'A5', ...mm(148, 210) },
];

// Full picker, grouped: screens & social first, then paper, then print/zine
export const FORMAT_GROUPS: { label: string; items: Fmt[] }[] = [
  {
    label: 'Screen & social',
    items: [
      { label: 'Screen 16:9', ...mm(240, 135), screen: true },
      { label: 'Story · Phone 9:16', ...mm(135, 240), screen: true },
      { label: 'Post 1:1', ...mm(200, 200), screen: true },
      { label: 'Post 4:5', ...mm(192, 240), screen: true },
      { label: 'Screen 4:3', ...mm(240, 180), screen: true },
      { label: 'Screen 3:4', ...mm(180, 240), screen: true },
      { label: 'Wide 21:9', ...mm(280, 120), screen: true },
    ],
  },
  {
    label: 'Paper',
    items: [
      { label: 'A3', ...mm(297, 420) },
      { label: 'A4', ...mm(210, 297) },
      { label: 'A4 wide', ...mm(297, 210) },
      { label: 'A5', ...mm(148, 210) },
      { label: 'A6', ...mm(105, 148) },
      { label: 'B5', ...mm(176, 250) },
      { label: 'Letter', ...mm(216, 279) },
      { label: 'Legal', ...mm(216, 356) },
      { label: 'Tabloid', ...mm(279, 432) },
      { label: 'Half letter', ...mm(140, 216) },
      { label: 'Square', ...mm(240, 240) },
    ],
  },
  {
    label: 'Print & zine',
    items: [
      { label: 'US comic', ...mm(168, 260) },
      { label: 'Manga B6', ...mm(128, 182) },
      { label: 'Zine pocket', ...mm(110, 178) },
      { label: 'Postcard', ...mm(148, 105) },
      { label: 'Bookmark', ...mm(50, 175) },
    ],
  },
];
export const MORE_FORMATS: Fmt[] = FORMAT_GROUPS.flatMap((g) => g.items);

/** Screen formats aren't about millimetres: zoom so the page nearly fills the
 * viewport, whatever the device. */
export function fitPage(camera: Camera, page: { x: number; y: number; w: number; h: number }) {
  const margin = 1.08;
  camera.zoom = Math.min(window.innerWidth / (page.w * margin), window.innerHeight / (page.h * margin));
  camera.x = page.x + page.w / 2;
  camera.y = page.y + page.h / 2;
}

const CUSTOM_FORMATS_KEY = 'infinizine-custom-formats';
export function customFormats(): Fmt[] {
  try {
    return JSON.parse(localStorage.getItem(CUSTOM_FORMATS_KEY) ?? '[]');
  } catch {
    return [];
  }
}
export function saveCustomFormat(f: Fmt) {
  try {
    localStorage.setItem(CUSTOM_FORMATS_KEY, JSON.stringify([...customFormats(), f]));
  } catch { /* ignore */ }
}

/** Human label for a page size: the matching preset's name (within 1mm), else W×Hmm. */
export function formatLabel(w: number, h: number): string {
  const tol = UNITS_PER_MM; // 1mm
  const hit = [...MORE_FORMATS, ...customFormats()].find((f) => Math.abs(f.w - w) < tol && Math.abs(f.h - h) < tol);
  if (hit) return hit.label;
  return `${Math.round(w / UNITS_PER_MM)}×${Math.round(h / UNITS_PER_MM)}mm`;
}
