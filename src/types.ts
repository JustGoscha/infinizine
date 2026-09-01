// InfiniCanvas document model (see SPEC.md).
// Strokes store raw input samples; outlines are generated at render/export time.
// Every element has a stable id + transform-ready fields so keyframe timelines
// can reference them later without a migration.

export interface StrokePoint {
  x: number; // world coords
  y: number;
  p: number; // pressure 0..1 (0.5 if the device reported none)
  t: number; // seconds since stroke start
}

export type ToolKind = 'pen' | 'fineliner' | 'marker';

export type Layer = 'back' | 'front';

// Frame-by-frame animation area (RoughAnimator-style)
export interface AnimFrame {
  id: string;
  duration: number; // in frame-ticks (1 = one 1/fps step)
}

export interface AnimLayer {
  id: string;
  name: string;
  frames: AnimFrame[]; // each layer has its own independent timeline
}

export interface AnimArea {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  name: string;
  fps: number;
  loop: boolean;
  clip?: boolean; // cut off frame ink outside the area rect
  layers: AnimLayer[]; // index 0 = bottom
}

export interface Stroke {
  id: string;
  kind: 'stroke';
  tool: ToolKind;
  color: string;
  baseWidth: number; // world units at zoom 1
  opacity: number;
  layer?: Layer; // paint behind / in front toggle; undefined = front
  frame?: string; // animation frame id (element only shows on that frame)
  alayer?: string; // animation layer id within its area
  points: StrokePoint[];
  startTime: number; // epoch seconds, for future replay/timelines
}

export interface FillShape {
  id: string;
  kind: 'fill';
  color: string;
  opacity: number;
  layer?: Layer;
  frame?: string;
  alayer?: string;
  points: { x: number; y: number }[]; // closed polygon, world coords
}

export interface TextBox {
  id: string;
  kind: 'text';
  x: number; // world coords of top-left
  y: number;
  w: number; // measured extents (kept up to date on edit)
  h: number;
  color: string;
  fontSize: number; // world units
  font?: string; // typeface key (see text.ts FONTS); default 'franklin'
  text: string; // markdown: # headings, - bullets, **bold**, *italic*
  layer?: Layer;
  frame?: string;
  alayer?: string;
}

export type Element = Stroke | FillShape | TextBox;

export interface Page {
  id: string;
  x: number; // world coords of top-left
  y: number;
  w: number;
  h: number;
  name: string;
  order: number; // manual order; seeded spatially
}

export interface Doc {
  version: 1;
  name: string;
  palette: string; // active palette preset id
  paper?: string; // canvas/paper background color (default warm cream)
  elements: Element[];
  pages: Page[];
  areas: AnimArea[];
}

// World units are ~2 per mm (A4 → 420×594)
export const UNITS_PER_MM = 2;

let counter = 0;
export function uid(prefix: string): string {
  counter = (counter + 1) % 46656;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}`;
}

export function emptyDoc(): Doc {
  return { version: 1, name: 'Untitled', palette: 'ink', elements: [], pages: [], areas: [] };
}
